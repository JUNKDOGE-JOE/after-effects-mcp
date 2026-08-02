#!/usr/bin/env python3
"""Run the six-call Windows Native EXEC development-only HDEV."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import copy
import ctypes
import dataclasses
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any, Protocol


HARDWARE_ROOT = Path(__file__).resolve().parent
if os.fspath(HARDWARE_ROOT) not in sys.path:
    sys.path.insert(0, os.fspath(HARDWARE_ROOT))

import development_smoke as base_hdev
from issue86_windows_native_exec_spec import (
    CALL_HARD_LIMIT,
    CALL_PLAN,
    FIXTURE_COMPOSITION_NAME,
    FIXTURE_FRAME_RATE,
    FIXTURE_HEIGHT,
    FIXTURE_LAYER_NAME,
    FIXTURE_WIDTH,
    READ_PRIMITIVES,
    SCENARIO_ID,
    list_arguments,
    read_arguments,
    status_arguments,
)


COMPONENTS = frozenset({"core", "cep", "native"})
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
ENDPOINT_NAME = re.compile(r"^d-([0-9a-f-]{36})\.endpoint$")
PIPE_NAME = re.compile(r"^\\\\\.\\pipe\\aemcp-n1-[0-9a-f]{12}$")
ENDPOINT_FIELDS = frozenset({
    "host", "pid", "startSeconds", "startMicros", "socket", "wire", "source",
})
CASES = (
    "component-bindings",
    "initial-lifecycle",
    "pre-status",
    "pre-list",
    "pre-read",
    "initial-shutdown",
    "restart-freshness",
    "fixture-reopen",
    "post-status",
    "post-list",
    "post-read",
    "final-shutdown",
    "fixture-archive",
)
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_LOG_BYTES = 1024 * 1024


class Issue86Failure(RuntimeError):
    """The bounded Issue #86 HDEV contract was not satisfied."""


class ImmediateStop(Issue86Failure):
    """Further calls would no longer produce trustworthy evidence."""


class LifecycleUncertain(ImmediateStop):
    """The formal AE lifecycle could not be reconciled safely."""


def require(condition: Any, message: str) -> None:
    if not condition:
        raise Issue86Failure(message)


def mapping(value: Any, message: str) -> dict[str, Any]:
    require(isinstance(value, Mapping), message)
    return dict(value)


def _under(path: Path, parent: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(parent.resolve(strict=False))
    except ValueError:
        return False
    return True


def _windows_path(value: Any) -> str:
    return os.path.normpath(str(value)).replace("/", "\\").casefold()


@dataclasses.dataclass(frozen=True)
class Issue86Config:
    scenario: str
    selected_components: tuple[str, ...]
    reused_components: tuple[str, ...]
    checkout: Path
    fixture_path: Path
    recovery_root: Path
    evidence_dir: Path
    formal_ae_app: Path
    endpoint_root: Path
    native_log_path: Path
    build_receipt_path: Path
    install_receipt_path: Path
    component_signals_path: Path
    plugin_url: str
    lifecycle_timeout_seconds: float = 90.0
    lifecycle_poll_seconds: float = 0.25
    run_id: str = dataclasses.field(
        default_factory=lambda: f"issue86-hdev-{int(time.time())}-{secrets.token_hex(4)}"
    )

    def __post_init__(self) -> None:
        require(self.scenario == SCENARIO_ID, "unsupported Issue #86 HDEV scenario")
        require(self.selected_components == ("native",), "Issue #86 selected component must be native")
        require(
            set(self.reused_components) == {"core", "cep"} and len(self.reused_components) == 2,
            "Issue #86 reused components must be core and cep",
        )
        paths = (
            self.checkout, self.fixture_path, self.recovery_root, self.evidence_dir,
            self.formal_ae_app, self.endpoint_root, self.native_log_path,
            self.build_receipt_path, self.install_receipt_path, self.component_signals_path,
        )
        require(all(path.is_absolute() for path in paths), "Issue #86 paths must be absolute")
        require(self.fixture_path.suffix.casefold() == ".aep", "fixture must end in .aep")
        require(self.formal_ae_app.name.casefold() == "afterfx.exe", "formal AE app must be AfterFX.exe")
        require(not _under(self.fixture_path, self.checkout), "fixture must remain outside the checkout")
        require(not _under(self.recovery_root, self.checkout), "recovery must remain outside the checkout")
        require(not _under(self.evidence_dir, self.checkout), "evidence must remain outside the checkout")
        require(self.plugin_url.startswith("http://127.0.0.1:"), "plugin URL must be loopback")
        require(
            0 < self.lifecycle_poll_seconds <= self.lifecycle_timeout_seconds,
            "lifecycle timing is invalid",
        )
        require(
            self.run_id.startswith("issue86-hdev-")
            and all(token not in self.run_id for token in ("/", "\\")),
            "Issue #86 run ID is invalid",
        )

    @property
    def component_disposition(self) -> dict[str, list[str]]:
        return {"selected": ["native"], "reused": list(self.reused_components)}


@dataclasses.dataclass(frozen=True)
class ProcessObservation:
    pid: int
    running: bool
    image_path: str | None
    matches_formal_executable: bool

    def __post_init__(self) -> None:
        require(self.pid > 1, "observed process PID is invalid")
        require(self.running == (self.image_path is not None), "observed process state is inconsistent")
        require(
            not self.matches_formal_executable or self.running,
            "a stopped process cannot match the formal executable",
        )

    def public_dict(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "running": self.running,
            "imagePath": self.image_path,
            "matchesFormalExecutable": self.matches_formal_executable,
        }


@dataclasses.dataclass(frozen=True)
class FormalAELaunch:
    requested_executable: str
    argv: tuple[str, ...]
    spawned_pid: int

    def public_dict(self) -> dict[str, Any]:
        return {
            "requestedExecutable": self.requested_executable,
            "argv": list(self.argv),
            "spawnedPid": self.spawned_pid,
        }


@dataclasses.dataclass(frozen=True)
class LifecycleObservation:
    endpoints: tuple[dict[str, Any], ...]
    log_offset: int
    events: tuple[dict[str, Any], ...]
    processes: tuple[ProcessObservation, ...]

    @property
    def process_running(self) -> bool:
        return any(row.running and row.matches_formal_executable for row in self.processes)

    def public_dict(self) -> dict[str, Any]:
        return {
            "processRunning": self.process_running,
            "endpoints": copy.deepcopy(list(self.endpoints)),
            "processes": [row.public_dict() for row in self.processes],
            "logOffset": self.log_offset,
            "events": copy.deepcopy(list(self.events)),
        }


class PublicSession(Protocol):
    tool_names: frozenset[str]

    async def call(self, tool: str, arguments: Mapping[str, Any]) -> tuple[bool, dict[str, Any]]: ...


class LifecycleProbe(Protocol):
    async def snapshot(self) -> LifecycleObservation: ...

    async def wait_for_shutdown(
        self,
        host_instance_id: str,
        pid: int,
        offset: int,
    ) -> LifecycleObservation: ...

    async def wait_for_start(
        self,
        previous_host_instance_id: str,
        previous_pid: int,
        launched_pid: int,
        offset: int,
    ) -> LifecycleObservation: ...


@dataclasses.dataclass(frozen=True)
class Issue86Result:
    exit_code: int
    summary: dict[str, Any]


class DevelopmentEvidence:
    def __init__(self, root: Path, *, run_id: str) -> None:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(root, stat.S_IRWXU)
        self.root = root
        self.run_id = run_id
        self.events_path = root / f"{run_id}.ndjson"
        self.summary_path = root / f"{run_id}.summary.json"
        self.count = 0

    def record(self, event: str, payload: Mapping[str, Any]) -> str:
        evidence_id = f"{self.run_id}:event:{self.count + 1}"
        row = {
            "schemaVersion": 1,
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
            "runId": self.run_id,
            "sequence": self.count + 1,
            "evidenceId": evidence_id,
            "event": event,
            "recordedAtUnixMs": int(time.time() * 1000),
            "payload": copy.deepcopy(dict(payload)),
        }
        descriptor = os.open(self.events_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.chmod(self.events_path, stat.S_IRUSR | stat.S_IWUSR)
        self.count += 1
        return evidence_id

    def finish(
        self,
        *,
        passed: bool,
        public_calls: Mapping[str, Any],
        component_disposition: Mapping[str, Any],
        aep_lifecycle: Mapping[str, Any],
        defect_ledger: Sequence[Mapping[str, Any]],
        tool_summary: Mapping[str, Any],
        details: Mapping[str, Any],
    ) -> dict[str, Any]:
        summary = {
            "schemaVersion": 1,
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
            "runId": self.run_id,
            "scenario": SCENARIO_ID,
            "passed": passed,
            "publicCalls": copy.deepcopy(dict(public_calls)),
            "componentDisposition": copy.deepcopy(dict(component_disposition)),
            "aepLifecycle": copy.deepcopy(dict(aep_lifecycle)),
            "defectLedger": copy.deepcopy(list(defect_ledger)),
            "toolSummary": copy.deepcopy(dict(tool_summary)),
            **copy.deepcopy(dict(details)),
        }
        descriptor = os.open(self.summary_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(summary, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.chmod(self.summary_path, stat.S_IRUSR | stat.S_IWUSR)
        return summary


class CallLedger:
    def __init__(self) -> None:
        self.total = 0
        self.by_tool: Counter[str] = Counter()
        self.by_phase: Counter[str] = Counter()

    def reserve(self, phase: str, tool: str) -> int:
        if self.total >= CALL_HARD_LIMIT:
            raise Issue86Failure(f"public MCP call budget exhausted before {tool}")
        self.total += 1
        self.by_tool[tool] += 1
        self.by_phase[phase] += 1
        return self.total

    def public_dict(self) -> dict[str, Any]:
        return {
            "target": CALL_HARD_LIMIT,
            "hardLimit": CALL_HARD_LIMIT,
            "total": self.total,
            "withinLimit": self.total <= CALL_HARD_LIMIT,
            "byTool": dict(sorted(self.by_tool.items())),
            "byPhase": dict(sorted(self.by_phase.items())),
        }


class DefectLedger:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}

    def record(
        self,
        case: str,
        status: str,
        layer: str,
        reconciliation: str,
        evidence_ids: Sequence[str],
        message: str,
        side_effect: str = "none",
    ) -> None:
        require(case in CASES and case not in self.rows, f"invalid duplicate defect case {case}")
        self.rows[case] = {
            "case": case,
            "status": status,
            "failingLayer": layer,
            "sideEffectState": side_effect,
            "reconciliation": reconciliation,
            "dependencyImpact": [],
            "evidenceIds": list(evidence_ids),
            "message": message,
        }

    def block(self, reason: str) -> None:
        blockers = [key for key, row in self.rows.items() if row["status"] in {"FAIL", "INDETERMINATE"}]
        for case in CASES:
            if case not in self.rows:
                self.rows[case] = {
                    "case": case,
                    "status": "BLOCKED",
                    "failingLayer": "dependency",
                    "sideEffectState": "none",
                    "reconciliation": "not-completed",
                    "dependencyImpact": blockers,
                    "evidenceIds": [],
                    "message": reason,
                }

    def public_rows(self) -> list[dict[str, Any]]:
        return [copy.deepcopy(self.rows[key]) for key in CASES if key in self.rows]


def parse_endpoint_descriptor(text: str, name: str) -> dict[str, Any]:
    lines = text.split("\n")
    require(lines[0] == "AEMCP_NATIVE_ENDPOINT_V1" and lines[-1] == "", "endpoint framing is invalid")
    values: dict[str, str] = {}
    for line in lines[1:-1]:
        require("=" in line, "endpoint field is invalid")
        key, value = line.split("=", 1)
        require(key not in values, "endpoint descriptor contains a duplicate field")
        values[key] = value
    require(set(values) == ENDPOINT_FIELDS, "endpoint descriptor fields are not closed")
    match = ENDPOINT_NAME.fullmatch(name)
    require(match is not None and UUID.fullmatch(match.group(1)), "endpoint name is invalid")
    require(values["host"] == match.group(1), "endpoint host does not match its name")
    try:
        pid = int(values["pid"])
        seconds = int(values["startSeconds"])
        micros = int(values["startMicros"])
        wire = int(values["wire"])
    except ValueError as error:
        raise Issue86Failure("endpoint numeric field is invalid") from error
    require(pid > 1 and seconds > 0 and 0 <= micros < 1_000_000, "endpoint process identity is invalid")
    require(wire == 1 and PIPE_NAME.fullmatch(values["socket"]), "endpoint transport is invalid")
    require(COMMIT.fullmatch(values["source"]), "endpoint source commit is invalid")
    return {
        "descriptorName": name,
        "hostInstanceId": values["host"],
        "pid": pid,
        "processGeneration": {"startSeconds": seconds, "startMicros": micros},
        "pipeName": values["socket"],
        "wireVersion": wire,
        "sourceCommit": values["source"],
    }


def read_endpoints(root: Path) -> tuple[dict[str, Any], ...]:
    directory = root / "aemcp-n1"
    if not directory.exists():
        return ()
    require(directory.is_dir() and not directory.is_symlink(), "endpoint directory is unsafe")
    files = sorted(path for path in directory.iterdir() if ENDPOINT_NAME.fullmatch(path.name))
    require(len(files) <= 128, "endpoint descriptor bound exceeded")
    result = []
    for path in files:
        require(path.is_file() and not path.is_symlink() and path.stat().st_size <= 4096, "endpoint is unsafe")
        result.append(parse_endpoint_descriptor(path.read_text(encoding="utf-8"), path.name))
    return tuple(result)


def read_log(path: Path, offset: int) -> tuple[int, tuple[dict[str, Any], ...]]:
    if not path.exists():
        require(offset == 0, "native log disappeared")
        return 0, ()
    require(path.is_file() and not path.is_symlink(), "native log is unsafe")
    size = path.stat().st_size
    require(offset <= size <= MAX_LOG_BYTES, "native log was truncated or exceeded its bound")
    with path.open("rb") as stream:
        stream.seek(offset)
        chunk = stream.read()
    boundary = chunk.rfind(b"\n")
    if boundary < 0:
        return offset, ()
    rows = []
    allowed = {
        "schemaVersion", "event", "timeUnixMs", "provenance", "instanceId",
        "requestId", "capabilityId", "ok", "decision", "pluginVersion",
        "compiledSdkVersion", "sourceCommit", "driverApi", "host", "result",
    }
    for line in chunk[: boundary + 1].splitlines():
        row = mapping(json.loads(line), "native log row is invalid")
        rows.append({key: copy.deepcopy(row[key]) for key in allowed if key in row})
    return offset + boundary + 1, tuple(rows)


def _load_json(path: Path, label: str) -> tuple[dict[str, Any], str]:
    require(path.is_file() and not path.is_symlink(), f"{label} is missing")
    content = path.read_bytes()
    require(0 < len(content) <= MAX_JSON_BYTES, f"{label} size is invalid")
    return mapping(json.loads(content), f"{label} is invalid"), hashlib.sha256(content).hexdigest()


def load_component_bindings(config: Issue86Config) -> dict[str, Any]:
    build, build_digest = _load_json(config.build_receipt_path, "build receipt")
    install, install_digest = _load_json(config.install_receipt_path, "install receipt")
    signals, signal_digest = _load_json(config.component_signals_path, "component signals")
    artifact = mapping(build.get("artifact"), "build artifact is missing")
    sdk = mapping(build.get("sdk"), "build SDK is missing")
    source = str(build.get("sourceCommit", ""))
    artifact_sha = str(artifact.get("sha256", ""))
    require(build.get("schemaVersion") == 1 and COMMIT.fullmatch(source), "build identity is invalid")
    require(SHA256.fullmatch(artifact_sha), "build artifact hash is invalid")
    require(isinstance(build.get("productVersion"), str), "build version is invalid")
    require(isinstance(sdk.get("name"), str), "build SDK identity is invalid")

    installed = mapping(install.get("installed"), "installed artifact is missing")
    install_artifact = mapping(install.get("artifact"), "install source artifact is missing")
    install_build = mapping(install.get("buildReceipt"), "install build receipt binding is missing")
    topology = mapping(install.get("topology"), "install topology is missing")
    require(
        install.get("schemaVersion") == 2
        and install.get("operation") == "install"
        and topology.get("kind") == "windows-after-effects-per-app-extensions",
        "install receipt topology is invalid",
    )
    require(
        isinstance(topology.get("pluginsRoot"), str)
        and topology.get("artifactName") == "AeMcpNative.aex"
        and _windows_path(installed.get("path"))
        == _windows_path(Path(topology["pluginsRoot"]) / topology["artifactName"]),
        "installed path and receipt topology drifted",
    )
    require(
        install.get("sourceCommit") == source
        and install.get("productVersion") == build.get("productVersion")
        and _windows_path(install_build.get("path")) == _windows_path(config.build_receipt_path)
        and install_build.get("sha256") == build_digest,
        "build and install receipt identities drifted",
    )
    require(
        install_artifact.get("sourceSha256") == artifact_sha
        and installed.get("sha256") == artifact_sha
        and install_artifact.get("bytes") == installed.get("bytes"),
        "build and install artifact identities drifted",
    )

    platform = mapping(signals.get("platform"), "platform signals are missing")
    ae = mapping(signals.get("afterEffects"), "After Effects signals are missing")
    components = mapping(signals.get("components"), "component signals are missing")
    require(signals.get("schemaVersion") == 1 and set(components) == COMPONENTS, "component signals are incomplete")
    require(platform.get("system") == "Windows" and platform.get("architecture") == "x64", "host is not Windows x64")
    require(_windows_path(ae.get("path")) == _windows_path(config.formal_ae_app), "formal AfterFX signal drifted")
    for name in COMPONENTS:
        require(
            {"canonicalPath", "version", "sourceRevision", "bytes", "mtimeMs"}
            <= set(mapping(components[name], f"{name} signal is invalid")),
            f"{name} signal is incomplete",
        )
    native = components["native"]
    require(native["sourceRevision"] == source and native["version"] == build["productVersion"], "native source/version drifted")
    require(_windows_path(native["canonicalPath"]) == _windows_path(installed.get("path")), "native path drifted")
    require(native["bytes"] == installed.get("bytes"), "native byte signal drifted")
    require(native["mtimeMs"] == installed.get("mtimeMs"), "native mtime signal drifted")
    return {
        "artifactBindings": {
            "buildReceipt": {
                "receiptSha256": build_digest,
                "sourceCommit": source,
                "productVersion": build["productVersion"],
                "artifactSha256": artifact_sha,
                "artifactBytes": artifact.get("bytes"),
                "sdk": copy.deepcopy(sdk),
                "toolchain": copy.deepcopy(build.get("toolchain")),
                "verification": copy.deepcopy(build.get("verification")),
            },
            "installReceipt": {
                "receiptSha256": install_digest,
                "sourceCommit": install["sourceCommit"],
                "productVersion": install["productVersion"],
                "buildReceipt": copy.deepcopy(install_build),
                "artifactSha256": installed["sha256"],
                "installed": copy.deepcopy(installed),
                "topology": copy.deepcopy(topology),
            },
            "componentSignalsSha256": signal_digest,
        },
        "componentSignals": {
            "capturedAtUnixMs": signals.get("capturedAtUnixMs"),
            "platform": copy.deepcopy(platform),
            "afterEffects": copy.deepcopy(ae),
            "components": copy.deepcopy(components),
        },
    }


def _has_event(observation: LifecycleObservation, event: str, host: str, request: str | None = None) -> bool:
    return any(
        row.get("event") == event
        and row.get("instanceId") == host
        and (request is None or row.get("requestId") == request)
        for row in observation.events
    )


def _process(observation: LifecycleObservation, pid: int, label: str) -> ProcessObservation:
    matches = [row for row in observation.processes if row.pid == pid]
    require(len(matches) == 1, f"{label} PID was not inspected exactly once")
    return matches[0]


def _target_endpoints(observation: LifecycleObservation) -> list[dict[str, Any]]:
    targets: list[dict[str, Any]] = []
    for candidate in observation.endpoints:
        endpoint = mapping(candidate, "endpoint observation is invalid")
        process = _process(observation, endpoint.get("pid"), "endpoint process")
        if process.running and process.matches_formal_executable:
            targets.append(endpoint)
    return targets


def _endpoint(observation: LifecycleObservation, label: str) -> dict[str, Any]:
    targets = _target_endpoints(observation)
    require(len(targets) == 1, f"{label} formal process/endpoint is not singular")
    return targets[0]


def _native_envelope(
    payload: Mapping[str, Any],
    arguments: Mapping[str, Any],
    bindings: Mapping[str, Any],
) -> tuple[dict[str, Any], str, str]:
    operations = arguments.get("operations")
    require(isinstance(operations, list) and operations, "native read program is empty")
    require("operationKey" not in arguments and "undoGroup" not in arguments, "native read requested write controls")
    require(all(row.get("op") in READ_PRIMITIVES for row in operations), "native program contains a write")
    completed = payload.get("operations")
    require(
        isinstance(completed, list)
        and [row.get("op") for row in completed] == [row["op"] for row in operations]
        and all(row.get("status") == "completed" for row in completed),
        "native operation completion drifted",
    )
    provenance = mapping(payload.get("provenance"), "native provenance is missing")
    audit = mapping(payload.get("audit"), "native audit is missing")
    evidence = mapping(payload.get("evidence"), "native evidence is missing")
    postcondition = mapping(evidence.get("postcondition"), "native postcondition is missing")
    undo = mapping(payload.get("undo"), "native Undo disposition is missing")
    expected = bindings["artifactBindings"]["buildReceipt"]
    native_signal = bindings["componentSignals"]["components"]["native"]
    require(
        payload.get("capabilityId") == "ae.native.exec"
        and payload.get("replayed") is False
        and provenance.get("engine") == "native-aegp"
        and provenance.get("selectedWireVersion") == 1,
        "native provenance drifted",
    )
    require(
        provenance.get("sourceCommit") == expected["sourceCommit"]
        and provenance.get("pluginVersion") == native_signal["version"]
        and UUID.fullmatch(str(provenance.get("hostInstanceId", "")))
        and UUID.fullmatch(str(provenance.get("sessionId", ""))),
        "native build or session identity drifted",
    )
    require(
        audit.get("effect") == "none"
        and audit.get("undoAvailable") is False
        and audit.get("undoVerified") is False
        and audit.get("programDigest") == base_hdev._program_digest(arguments)
        and postcondition.get("verified") is True
        and postcondition.get("digest") == audit.get("postconditionDigest")
        and undo == {"available": False, "verified": False},
        "native read evidence or Undo disposition drifted",
    )
    require(
        evidence.get("hostInstanceId") == provenance["hostInstanceId"]
        and evidence.get("sessionId") == provenance["sessionId"]
        and evidence.get("requestId") == audit.get("requestId"),
        "native evidence identity drifted",
    )
    identity = {
        key: provenance.get(key)
        for key in (
            "hostInstanceId", "sessionId", "sessionGeneration", "pluginVersion",
            "compiledSdkVersion", "sourceCommit", "selectedWireVersion", "capabilitiesDigest",
        )
    }
    return identity, str(audit["requestId"]), str(postcondition["digest"])


def _list_state(payload: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    page = mapping(mapping(payload.get("outputs"), "list outputs are missing").get("items"), "item page is missing")
    rows = page.get("items")
    require(isinstance(rows, list), "project item list is invalid")
    matches = [row for row in rows if row.get("name") == FIXTURE_COMPOSITION_NAME and row.get("type") == "composition"]
    require(len(matches) == 1, "fixture composition was not uniquely observed")
    locator = mapping(matches[0].get("locator"), "fixture locator is missing")
    require(locator.get("kind") == "composition", "fixture locator kind drifted")
    return locator, {
        "compositionName": FIXTURE_COMPOSITION_NAME,
        "compositionType": "composition",
        "returnedItems": page.get("returned"),
        "totalItems": page.get("total"),
    }


def _read_state(payload: Mapping[str, Any]) -> dict[str, Any]:
    outputs = mapping(payload.get("outputs"), "fixture outputs are missing")
    settings = mapping(outputs.get("settings"), "fixture settings are missing")
    page = mapping(outputs.get("layers"), "fixture layers are missing")
    layers = page.get("layers")
    require(isinstance(layers, list), "fixture layer rows are invalid")
    stable_layers = [
        {key: row.get(key) for key in ("stackIndex", "name", "type", "videoEnabled", "isThreeD", "locked")}
        for row in layers
    ]
    require(
        settings.get("name") == FIXTURE_COMPOSITION_NAME
        and settings.get("width") == FIXTURE_WIDTH
        and settings.get("height") == FIXTURE_HEIGHT
        and settings.get("frameRate") == {"numerator": FIXTURE_FRAME_RATE, "denominator": 1}
        and settings.get("pixelAspectRatio") == {"numerator": 1, "denominator": 1}
        and settings.get("layerCount") == 1,
        "fixture composition settings drifted",
    )
    require(
        page.get("compositionName") == FIXTURE_COMPOSITION_NAME
        and page.get("returned") == page.get("total") == 1
        and stable_layers == [{
            "stackIndex": 1,
            "name": FIXTURE_LAYER_NAME,
            "type": "null",
            "videoEnabled": True,
            "isThreeD": False,
            "locked": False,
        }],
        "fixture layer state drifted",
    )
    return {
        "compositionName": settings["name"],
        "width": settings["width"],
        "height": settings["height"],
        "duration": copy.deepcopy(settings.get("duration")),
        "frameRate": copy.deepcopy(settings["frameRate"]),
        "pixelAspectRatio": copy.deepcopy(settings["pixelAspectRatio"]),
        "layerCount": 1,
        "layers": stable_layers,
    }


class Issue86Runner:
    def __init__(
        self,
        config: Issue86Config,
        *,
        checkpoint: Callable[[str, Mapping[str, Any]], Awaitable[None]],
        lifecycle_probe: LifecycleProbe,
        launch_formal_ae: Callable[[Path], Awaitable[FormalAELaunch]],
        evidence: DevelopmentEvidence,
    ) -> None:
        self.config = config
        self.checkpoint = checkpoint
        self.probe = lifecycle_probe
        self.launch = launch_formal_ae
        self.evidence = evidence
        self.ledger = CallLedger()
        self.defects = DefectLedger()
        self.bindings: dict[str, Any] = {}
        self.records: dict[str, dict[str, Any]] = {}
        self.requests = {"before-restart": [], "after-restart": []}
        self.lifecycle = {
            "lifecycle": "ephemeral-validation",
            "created": 0,
            "preparedByPreflight": 1,
            "canonicalRetained": 0,
            "evidenceSnapshotsRetained": 0,
            "archived": 0,
            "active": 0,
            "unclassified": 0,
            "saveAsCopies": 0,
            "logicalBytesMoved": 0,
            "physicalBytesReleased": 0,
        }

    def _record(self, case: str, status: str, layer: str, reconciliation: str, ids: Sequence[str], message: str, side_effect: str = "none") -> None:
        self.defects.record(case, status, layer, reconciliation, ids, message, side_effect)

    async def _call(
        self,
        session: PublicSession,
        key: str,
        arguments: Mapping[str, Any],
        extractor: Callable[[dict[str, Any], dict[str, Any] | None], Any],
    ) -> tuple[dict[str, Any], dict[str, Any] | None, Any]:
        plan = next(row for row in CALL_PLAN if row.key == key)
        self.ledger.reserve(plan.phase, plan.tool)
        request = copy.deepcopy(dict(arguments))
        request_id = self.evidence.record("public-request", {
            "ordinal": plan.ordinal, "key": key, "phase": plan.phase,
            "tool": plan.tool, "requestDisposition": "read-only", "arguments": request,
        })
        payload: dict[str, Any] | None = None
        try:
            require(plan.tool in session.tool_names, f"public tool {plan.tool} is unavailable")
            is_error, payload = await session.call(plan.tool, request)
            payload = mapping(payload, f"{plan.tool} payload is invalid")
            if is_error or payload.get("ok") is not True:
                error = mapping(payload.get("error"), f"{plan.tool} error is missing")
                require(error.get("sideEffect", "not-started") == "not-started", "read failure side effect is uncertain")
                raise Issue86Failure(f"{plan.tool} returned {error.get('code', 'UNKNOWN')}")
            identity = None
            audit_id = postcondition_id = None
            if plan.tool == "ae_status":
                plane = mapping(payload.get("nativeExecutionPlane"), "native status is missing")
                require(plane.get("available") is True and plane.get("engine") == "native-aegp", "native status is unavailable")
            else:
                identity, audit_id, postcondition_id = _native_envelope(payload, request, self.bindings)
                self.requests[plan.phase].append(audit_id)
            state = extractor(payload, identity)
        except Exception as error:
            response_id = self.evidence.record("public-response", {
                "ordinal": plan.ordinal, "key": key, "tool": plan.tool,
                "status": "FAIL", "payload": payload, "message": str(error),
                "sideEffectState": "not-started",
            })
            self.records[key] = {
                "request": request, "response": payload, "status": "FAIL",
                "identity": None, "state": None, "auditId": None,
                "postconditionId": None, "evidenceIds": [request_id, response_id],
            }
            self._record(key, "FAIL", "public-mcp", "read-only-not-started", (request_id, response_id), str(error), "not-started")
            raise ImmediateStop(f"{key} failed; no further public calls are trustworthy") from error
        response_id = self.evidence.record("public-response", {
            "ordinal": plan.ordinal, "key": key, "tool": plan.tool,
            "status": "PASS", "payload": payload,
        })
        self.records[key] = {
            "request": request, "response": copy.deepcopy(payload), "status": "PASS",
            "identity": copy.deepcopy(identity), "state": copy.deepcopy(state),
            "auditId": audit_id, "postconditionId": postcondition_id,
            "evidenceIds": [request_id, response_id],
        }
        self._record(key, "PASS", "none", "typed-public-read", (request_id, response_id), "typed public read passed")
        return payload, identity, state

    async def _lifecycle_case(
        self,
        case: str,
        action: Callable[[], Awaitable[LifecycleObservation]],
        validate: Callable[[LifecycleObservation], None],
    ) -> LifecycleObservation:
        try:
            observation = await action()
            validate(observation)
        except Exception as error:
            evidence_id = self.evidence.record("lifecycle-failure", {
                "case": case, "failureType": type(error).__name__, "message": str(error),
            })
            self._record(case, "INDETERMINATE", "windows-ae-lifecycle", "not-completed", (evidence_id,), str(error), "unknown")
            raise LifecycleUncertain(f"{case} could not be reconciled") from error
        evidence_id = self.evidence.record("lifecycle-observation", {
            "case": case, "observation": observation.public_dict(),
        })
        self._record(case, "PASS", "none", "process-endpoint-log-agreement", (evidence_id,), "lifecycle evidence agreed")
        return observation

    async def _checkpoint(self, kind: str, action: str, last_state: Mapping[str, Any]) -> str:
        target_pid = last_state.get("pid")
        require(isinstance(target_pid, int) and target_pid > 1, "GUI checkpoint target PID is missing")
        payload = {
            "executionOwner": "authorized-agent-orchestrator",
            "userActionRequired": False,
            "expectedApplication": {
                "process": "AfterFX.exe",
                "executable": os.fspath(self.config.formal_ae_app),
                "targetPid": target_pid,
            },
            "action": action,
            "fixturePath": os.fspath(self.config.fixture_path),
            "lastVerifiedState": copy.deepcopy(dict(last_state)),
            "fixtureLifecycle": "ephemeral-validation",
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
            "instruction": (
                "Authorized GUI automation must bind the target PID to the exact executable before "
                "performing this ordinary action. Never touch another AE instance, force quit, or "
                "use file double-click."
            ),
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
        }
        await self.checkpoint(kind, payload)
        return self.evidence.record("gui-checkpoint-completed", {"kind": kind, **payload})

    def _validate_shutdown(
        self,
        observation: LifecycleObservation,
        endpoint: Mapping[str, Any],
        phase: str,
    ) -> None:
        host = str(endpoint["hostInstanceId"])
        pid = int(endpoint["pid"])
        process = _process(observation, pid, f"{phase} target process")
        require(
            not (process.running and process.matches_formal_executable),
            f"{phase} target process remains",
        )
        require(
            not any(row.get("hostInstanceId") == host for row in observation.endpoints),
            f"{phase} target endpoint remains",
        )
        require(_has_event(observation, "death", host), f"{phase} death event is missing")
        for request_id in self.requests[phase]:
            require(_has_event(observation, "invoke.terminal", host, request_id), f"native terminal event {request_id} is missing")

    async def _archive(self) -> dict[str, Any]:
        source = self.config.fixture_path
        require(source.is_file() and not source.is_symlink(), "fixture is missing before archive")
        root = self.config.recovery_root / self.config.run_id
        require(not root.exists(), "fixture recovery slot already exists")
        root.mkdir(mode=0o700, parents=True, exist_ok=False)
        destination = root / source.name
        require(_under(destination, root), "fixture archive escaped recovery")
        size = source.stat().st_size
        shutil.move(os.fspath(source), os.fspath(destination))
        require(destination.is_file() and not source.exists(), "fixture archive move failed")
        self.lifecycle.update({
            "archived": 1, "active": 0, "unclassified": 0,
            "logicalBytesMoved": size, "physicalBytesReleased": 0,
        })
        return {
            "disposition": "recovery-archive",
            "archiveName": destination.name,
            "archiveDirectory": root.name,
            "bytesMoved": size,
            "cleanupCondition": "remove after Issue #86 development evidence is published",
        }

    async def run(self, session: PublicSession) -> dict[str, Any]:
        require(self.config.fixture_path.is_file() and not self.config.fixture_path.is_symlink(), "prepared fixture is missing")
        require(self.config.formal_ae_app.is_file(), "formal AfterFX.exe is missing")
        self.lifecycle["active"] = 1
        self.bindings = load_component_bindings(self.config)
        binding_id = self.evidence.record("component-bindings", self.bindings)
        self._record("component-bindings", "PASS", "none", "receipt-and-cheap-signals-agree", (binding_id,), "component identities agree")

        def initial_validator(observation: LifecycleObservation) -> None:
            endpoint = _endpoint(observation, "initial")
            require(_has_event(observation, "load", endpoint["hostInstanceId"]), "initial load event is missing")
            require(endpoint["sourceCommit"] == self.bindings["artifactBindings"]["buildReceipt"]["sourceCommit"], "initial endpoint source drifted")

        initial = await self._lifecycle_case("initial-lifecycle", self.probe.snapshot, initial_validator)
        old_endpoint = _endpoint(initial, "initial")
        _, _, _ = await self._call(session, "pre-status", status_arguments(), lambda p, _i: p["nativeExecutionPlane"])

        def pre_list_extract(payload: dict[str, Any], identity: dict[str, Any] | None):
            require(identity is not None and identity["hostInstanceId"] == old_endpoint["hostInstanceId"], "pre-list host disagrees with endpoint")
            locator, state = _list_state(payload)
            require(locator.get("hostInstanceId") == identity["hostInstanceId"] and locator.get("sessionId") == identity["sessionId"], "pre-list locator identity drifted")
            return {"locator": locator, "state": state}

        _, old_identity, pre_list = await self._call(session, "pre-list", list_arguments(), pre_list_extract)
        old_locator = pre_list["locator"]

        def pre_read_extract(payload: dict[str, Any], identity: dict[str, Any] | None):
            require(identity is not None and identity["hostInstanceId"] == old_identity["hostInstanceId"] and identity["sessionId"] == old_identity["sessionId"], "pre-read crossed a session")
            return _read_state(payload)

        _, _, state_before = await self._call(session, "pre-read", read_arguments(old_locator), pre_read_extract)
        try:
            await self._checkpoint(
                "quit-before-windows-native-restart",
                "quit-formal-ae-normally",
                {
                    "hostInstanceId": old_identity["hostInstanceId"],
                    "sessionId": old_identity["sessionId"],
                    "pid": old_endpoint["pid"],
                    "fixtureState": state_before,
                },
            )
        except Exception as error:
            self._record("initial-shutdown", "INDETERMINATE", "gui-checkpoint", "not-completed", (), str(error), "unknown")
            raise LifecycleUncertain("normal pre-restart quit was not confirmed") from error
        first_shutdown = await self._lifecycle_case(
            "initial-shutdown",
            lambda: self.probe.wait_for_shutdown(
                old_identity["hostInstanceId"],
                old_endpoint["pid"],
                initial.log_offset,
            ),
            lambda observation: self._validate_shutdown(observation, old_endpoint, "before-restart"),
        )

        try:
            launch = await self.launch(self.config.formal_ae_app)
            require(isinstance(launch, FormalAELaunch), "formal AE launch receipt is missing")
            require(
                _windows_path(launch.requested_executable) == _windows_path(self.config.formal_ae_app)
                and launch.argv == (os.fspath(self.config.formal_ae_app),)
                and launch.spawned_pid > 1,
                "formal AE launch receipt drifted",
            )
            restarted = await self.probe.wait_for_start(
                old_identity["hostInstanceId"],
                old_endpoint["pid"],
                launch.spawned_pid,
                first_shutdown.log_offset,
            )
            new_endpoint = _endpoint(restarted, "restarted")
            require(new_endpoint["hostInstanceId"] != old_endpoint["hostInstanceId"], "restart reused the old host")
            require(new_endpoint["pid"] != old_endpoint["pid"], "restart reused the old target PID")
            require(new_endpoint["pipeName"] != old_endpoint["pipeName"], "restart reused the old pipe")
            require(_has_event(restarted, "load", new_endpoint["hostInstanceId"]), "restart load event is missing")
        except Exception as error:
            evidence_id = self.evidence.record("lifecycle-failure", {"case": "restart-freshness", "message": str(error)})
            self._record("restart-freshness", "INDETERMINATE", "windows-ae-restart", "not-completed", (evidence_id,), str(error), "unknown")
            raise LifecycleUncertain("fresh formal AE restart was not proven") from error
        restart_id = self.evidence.record("lifecycle-observation", {
            "case": "restart-freshness",
            "launch": launch.public_dict(),
            "observation": restarted.public_dict(),
        })
        self._record("restart-freshness", "PASS", "none", "new-process-endpoint-load", (restart_id,), "fresh endpoint registered")
        try:
            reopen_checkpoint_id = await self._checkpoint(
                "open-issue86-fixture-in-restarted-formal-ae",
                "use-file-open-or-open-recent-inside-ae",
                {
                    "hostInstanceId": new_endpoint["hostInstanceId"],
                    "pid": new_endpoint["pid"],
                    "endpointFresh": True,
                    "projectOpen": False,
                },
            )
        except Exception as error:
            self._record("fixture-reopen", "INDETERMINATE", "gui-checkpoint", "not-completed", (), str(error), "unknown")
            raise LifecycleUncertain("fixture was not reopened from inside formal AE") from error

        await self._call(session, "post-status", status_arguments(), lambda p, _i: p["nativeExecutionPlane"])

        def post_list_extract(payload: dict[str, Any], identity: dict[str, Any] | None):
            require(
                identity is not None
                and identity["hostInstanceId"] == new_endpoint["hostInstanceId"]
                and identity["hostInstanceId"] != old_identity["hostInstanceId"]
                and identity["sessionId"] != old_identity["sessionId"],
                "post-list host/session freshness drifted",
            )
            locator, state = _list_state(payload)
            require(locator.get("hostInstanceId") == identity["hostInstanceId"] and locator.get("sessionId") == identity["sessionId"], "post-list locator identity drifted")
            return {"locator": locator, "state": state}

        _, new_identity, post_list = await self._call(session, "post-list", list_arguments(), post_list_extract)

        def post_read_extract(payload: dict[str, Any], identity: dict[str, Any] | None):
            require(identity is not None and identity["hostInstanceId"] == new_identity["hostInstanceId"] and identity["sessionId"] == new_identity["sessionId"], "post-read crossed a session")
            state = _read_state(payload)
            require(state == state_before, "fixture state changed across restart")
            return state

        _, _, state_after = await self._call(session, "post-read", read_arguments(post_list["locator"]), post_read_extract)
        self._record("fixture-reopen", "PASS", "none", "public-list-and-read", (reopen_checkpoint_id,), "public native reads proved the same fixture reopened")
        require(self.ledger.total == CALL_HARD_LIMIT, "public call count drifted")
        try:
            await self._checkpoint(
                "quit-before-issue86-fixture-archive",
                "quit-formal-ae-normally",
                {
                    "hostInstanceId": new_identity["hostInstanceId"],
                    "sessionId": new_identity["sessionId"],
                    "pid": new_endpoint["pid"],
                    "fixtureState": state_after,
                },
            )
        except Exception as error:
            self._record("final-shutdown", "INDETERMINATE", "gui-checkpoint", "not-completed", (), str(error), "unknown")
            raise LifecycleUncertain("normal final quit was not confirmed") from error
        await self._lifecycle_case(
            "final-shutdown",
            lambda: self.probe.wait_for_shutdown(
                new_identity["hostInstanceId"],
                new_endpoint["pid"],
                restarted.log_offset,
            ),
            lambda observation: self._validate_shutdown(observation, new_endpoint, "after-restart"),
        )
        disposition = await self._archive()
        archive_id = self.evidence.record("fixture-archived", {**disposition, **self.lifecycle})
        self._record("fixture-archive", "PASS", "none", "single-recovery-archive", (archive_id,), "fixture archived")
        return {
            "artifactBindings": copy.deepcopy(self.bindings["artifactBindings"]),
            "componentSignals": copy.deepcopy(self.bindings["componentSignals"]),
            "stateBeforeRestart": state_before,
            "stateAfterRestart": state_after,
            "restartFreshness": {
                "oldHostInstanceId": old_identity["hostInstanceId"],
                "oldSessionId": old_identity["sessionId"],
                "newHostInstanceId": new_identity["hostInstanceId"],
                "newSessionId": new_identity["sessionId"],
                "hostChanged": True,
                "sessionChanged": True,
                "endpointChanged": True,
                "pidChanged": True,
                "oldPid": old_endpoint["pid"],
                "newPid": new_endpoint["pid"],
                "launchPid": launch.spawned_pid,
                "launchPidRelation": (
                    "direct" if new_endpoint["pid"] == launch.spawned_pid else "handed-off"
                ),
            },
            "fixtureDisposition": disposition,
            "undo": {"applicable": False, "executed": False, "verified": False},
        }

    def _versions(self, identity: Mapping[str, Any] | None) -> dict[str, Any]:
        components = self.bindings.get("componentSignals", {}).get("components", {})
        result = {name: row.get("version") for name, row in components.items()}
        if identity:
            result["nativeObserved"] = {
                key: identity.get(key)
                for key in ("pluginVersion", "compiledSdkVersion", "sourceCommit", "selectedWireVersion")
            }
        return result

    def call_summary(self) -> list[dict[str, Any]]:
        receipts = self.bindings.get("artifactBindings", {})
        rows = []
        for plan in CALL_PLAN:
            record = self.records.get(plan.key)
            identity = record.get("identity") if record else None
            rows.append({
                "ordinal": plan.ordinal,
                "key": plan.key,
                "phase": plan.phase,
                "tool": plan.tool,
                "requestDisposition": "read-only",
                "resultDisposition": record.get("status", "BLOCKED") if record else "BLOCKED",
                "request": copy.deepcopy(record.get("request")) if record else None,
                "response": copy.deepcopy(record.get("response")) if record else None,
                "aeState": copy.deepcopy(record.get("state")) if record else None,
                "evidenceIds": list(record.get("evidenceIds", [])) if record else [],
                "auditId": record.get("auditId") if record else None,
                "postconditionId": record.get("postconditionId") if record else None,
                "componentVersions": self._versions(identity),
                "componentReceipts": {
                    "build": receipts.get("buildReceipt", {}).get("receiptSha256"),
                    "install": receipts.get("installReceipt", {}).get("receiptSha256"),
                },
                "hostInstances": [identity["hostInstanceId"]] if identity else [],
                "undoResult": {"applicable": False, "executed": False, "verified": False},
                "fixtureLifecycle": "ephemeral-validation",
            })
        return rows

    def tool_summary(self) -> dict[str, Any]:
        result = {}
        rows = self.call_summary()
        for tool in ("ae_status", "ae_nativeExec"):
            selected = [row for row in rows if row["tool"] == tool]
            executed = [row for row in selected if row["resultDisposition"] != "BLOCKED"]
            states = [row["aeState"] for row in executed if row["aeState"] is not None]
            result[tool] = {
                "publicCalls": len(executed),
                "requestDispositions": dict(Counter(row["requestDisposition"] for row in executed)),
                "resultDispositions": dict(Counter(row["resultDisposition"] for row in selected)),
                "stateBefore": copy.deepcopy(states[0]) if states else None,
                "stateAfter": copy.deepcopy(states[-1]) if states else None,
                "undo": {"applicable": False, "executed": False, "verified": False},
                "componentVersions": copy.deepcopy(executed[-1]["componentVersions"] if executed else self._versions(None)),
                "hostInstances": sorted({host for row in executed for host in row["hostInstances"]}),
                "auditIds": [row["auditId"] for row in executed if row["auditId"]],
                "postconditionIds": [row["postconditionId"] for row in executed if row["postconditionId"]],
                "fixtureLifecycle": "ephemeral-validation",
            }
        return result


async def run_issue86_hdev(
    config: Issue86Config,
    *,
    session: PublicSession,
    checkpoint: Callable[[str, Mapping[str, Any]], Awaitable[None]],
    lifecycle_probe: LifecycleProbe,
    launch_formal_ae: Callable[[Path], Awaitable[FormalAELaunch]],
) -> Issue86Result:
    evidence = DevelopmentEvidence(config.evidence_dir, run_id=config.run_id)
    runner = Issue86Runner(
        config,
        checkpoint=checkpoint,
        lifecycle_probe=lifecycle_probe,
        launch_formal_ae=launch_formal_ae,
        evidence=evidence,
    )
    passed = False
    exit_code = 2
    details: dict[str, Any]
    try:
        details = await runner.run(session)
        passed = True
        exit_code = 0
    except ImmediateStop as error:
        details = {
            "stopReason": "lifecycle-indeterminate" if isinstance(error, LifecycleUncertain) else "immediate-read-stop",
            "message": str(error),
            "retryAttempted": False,
        }
        exit_code = 3
    except Exception as error:
        details = {"failure": str(error), "failureType": type(error).__name__}
    if not passed:
        has_failure = any(
            row["status"] in {"FAIL", "INDETERMINATE"}
            for row in runner.defects.rows.values()
        )
        if not has_failure:
            failed_case = next(
                (case for case in CASES if case not in runner.defects.rows),
                "fixture-archive",
            )
            if failed_case in runner.defects.rows:
                runner.defects.rows[failed_case].update({
                    "status": "FAIL",
                    "failingLayer": "hdev-orchestration",
                    "reconciliation": "not-completed",
                    "message": str(details),
                })
            else:
                runner._record(
                    failed_case,
                    "FAIL",
                    "hdev-orchestration",
                    "not-completed",
                    (),
                    str(details),
                    "not-started",
                )
        runner.defects.block(str(details.get("message", details.get("failure", "HDEV stopped"))))
        if config.fixture_path.exists() and runner.lifecycle["archived"] == 0:
            runner.lifecycle.update({"active": 1, "unclassified": 1})
    summary = evidence.finish(
        passed=passed,
        public_calls=runner.ledger.public_dict(),
        component_disposition=config.component_disposition,
        aep_lifecycle=runner.lifecycle,
        defect_ledger=runner.defects.public_rows(),
        tool_summary=runner.tool_summary(),
        details={
            **details,
            "callSummary": runner.call_summary(),
            **({
                "artifactBindings": copy.deepcopy(runner.bindings["artifactBindings"]),
                "componentSignals": copy.deepcopy(runner.bindings["componentSignals"]),
            } if runner.bindings else {}),
        },
    )
    return Issue86Result(exit_code=exit_code, summary=summary)


async def completed_checkpoint() -> None:
    return None


def windows_process_image_path(pid: int) -> str | None:
    """Resolve one PID's image without conflating same-name AE processes."""
    require(os.name == "nt", "Windows lifecycle probing requires Windows")
    require(isinstance(pid, int) and pid > 1, "Windows process PID is invalid")
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    open_process = kernel32.OpenProcess
    open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    open_process.restype = wintypes.HANDLE
    query_image = kernel32.QueryFullProcessImageNameW
    query_image.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        wintypes.LPWSTR,
        ctypes.POINTER(wintypes.DWORD),
    )
    query_image.restype = wintypes.BOOL
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = (wintypes.HANDLE,)
    close_handle.restype = wintypes.BOOL

    handle = open_process(0x1000, False, pid)
    if not handle:
        error = ctypes.get_last_error()
        if error in {5, 87, 1168}:
            return None
        raise Issue86Failure(f"could not open process PID {pid}: Windows error {error}")
    try:
        capacity = 32768
        buffer = ctypes.create_unicode_buffer(capacity)
        length = wintypes.DWORD(capacity)
        if not query_image(handle, 0, buffer, ctypes.byref(length)):
            error = ctypes.get_last_error()
            if error in {5, 6, 87, 1168}:
                return None
            raise Issue86Failure(f"could not query process PID {pid}: Windows error {error}")
        require(0 < length.value < capacity, "Windows process image path is invalid")
        return buffer.value[:length.value]
    finally:
        close_handle(handle)


async def launch_formal_after_effects(formal_ae_app: Path) -> FormalAELaunch:
    require(os.name == "nt", "formal AfterFX.exe launch requires Windows")
    require(formal_ae_app.is_file() and formal_ae_app.name.casefold() == "afterfx.exe", "formal AfterFX.exe is invalid")
    argv = (os.fspath(formal_ae_app),)
    process = await asyncio.create_subprocess_exec(
        os.fspath(formal_ae_app),
        cwd=os.fspath(formal_ae_app.parent),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    require(isinstance(process.pid, int) and process.pid > 1, "formal AE launch PID is invalid")
    return FormalAELaunch(
        requested_executable=os.fspath(formal_ae_app),
        argv=argv,
        spawned_pid=process.pid,
    )


class WindowsLifecycleProbe:
    def __init__(
        self,
        config: Issue86Config,
        *,
        process_image_lookup: Callable[[int], str | None] = windows_process_image_path,
    ) -> None:
        self.config = config
        self.process_image_lookup = process_image_lookup

    async def _observe(
        self,
        offset: int,
        tracked_pids: Sequence[int] = (),
    ) -> LifecycleObservation:
        endpoints, log = await asyncio.gather(
            asyncio.to_thread(read_endpoints, self.config.endpoint_root),
            asyncio.to_thread(read_log, self.config.native_log_path, offset),
        )
        endpoint_pids = []
        for endpoint in endpoints:
            pid = endpoint.get("pid")
            require(isinstance(pid, int) and pid > 1, "endpoint PID is invalid")
            endpoint_pids.append(pid)
        pids = sorted(set(endpoint_pids).union(tracked_pids))
        images = await asyncio.gather(*(
            asyncio.to_thread(self.process_image_lookup, pid)
            for pid in pids
        ))
        processes = tuple(
            ProcessObservation(
                pid=pid,
                running=image is not None,
                image_path=image,
                matches_formal_executable=(
                    image is not None
                    and _windows_path(image) == _windows_path(self.config.formal_ae_app)
                ),
            )
            for pid, image in zip(pids, images, strict=True)
        )
        return LifecycleObservation(endpoints, log[0], log[1], processes)

    async def snapshot(self) -> LifecycleObservation:
        return await self._observe(0)

    async def wait_for_shutdown(self, host: str, pid: int, offset: int) -> LifecycleObservation:
        deadline = time.monotonic() + self.config.lifecycle_timeout_seconds
        while time.monotonic() < deadline:
            observation = await self._observe(offset, (pid,))
            process = _process(observation, pid, "shutdown target process")
            target_running = process.running and process.matches_formal_executable
            endpoint_remains = any(
                row.get("hostInstanceId") == host
                for row in observation.endpoints
            )
            if not target_running and not endpoint_remains and _has_event(observation, "death", host):
                return observation
            await asyncio.sleep(self.config.lifecycle_poll_seconds)
        raise LifecycleUncertain("target formal AfterFX shutdown did not converge")

    async def wait_for_start(
        self,
        old_host: str,
        old_pid: int,
        launched_pid: int,
        offset: int,
    ) -> LifecycleObservation:
        deadline = time.monotonic() + self.config.lifecycle_timeout_seconds
        while time.monotonic() < deadline:
            observation = await self._observe(offset, (old_pid, launched_pid))
            fresh = [
                endpoint
                for endpoint in _target_endpoints(observation)
                if endpoint.get("hostInstanceId") != old_host
                and endpoint.get("pid") != old_pid
                and _has_event(observation, "load", str(endpoint.get("hostInstanceId")))
            ]
            if len(fresh) == 1:
                return observation
            if len(fresh) > 1:
                raise LifecycleUncertain("multiple fresh formal AfterFX endpoints appeared")
            await asyncio.sleep(self.config.lifecycle_poll_seconds)
        raise LifecycleUncertain("formal AfterFX restart did not produce a PID/path-bound endpoint")


def _core_environment(plugin_url: str) -> dict[str, str]:
    allowed = (
        "APPDATA", "COMSPEC", "LOCALAPPDATA", "PATH", "PATHEXT", "SystemDrive",
        "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR",
    )
    environment = {key: os.environ[key] for key in allowed if key in os.environ}
    environment.update({
        "AE_MCP_BACKEND": "ae-mcp",
        "AE_MCP_PLUGIN_URL": plugin_url,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
    })
    return environment


def _checkout_core(config: Issue86Config) -> tuple[Path, Path, Path]:
    checkout = config.checkout.resolve(strict=True)
    interpreter = checkout / ".venv" / "Scripts" / "python.exe"
    core = checkout / "packages" / "core"
    bridge = checkout / "packages" / "bridge"
    require(interpreter.is_file(), "checkout Windows interpreter is missing")
    require((core / "ae_mcp" / "__main__.py").is_file(), "Core entrypoint is missing")
    require((bridge / "ae_mcp_bridge" / "__init__.py").is_file(), "bridge entrypoint is missing")
    completed = subprocess.run(
        [
            os.fspath(interpreter), "-B", "-I", "-c", base_hdev.CORE_IMPORT_PROBE,
            os.fspath(core), os.fspath(bridge),
        ],
        cwd=checkout,
        env=_core_environment(config.plugin_url),
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    imported = completed.stdout.strip().splitlines()
    require(len(imported) == 2, "isolated Core import probe was incomplete")
    require(Path(imported[0]).resolve(strict=True).is_relative_to(core), "Core import escaped checkout")
    require(Path(imported[1]).resolve(strict=True).is_relative_to(bridge), "bridge import escaped checkout")
    return interpreter, core, bridge


@contextlib.asynccontextmanager
async def live_session(config: Issue86Config) -> AsyncIterator[PublicSession]:
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from mcp.types import Implementation
    except ImportError as error:
        raise Issue86Failure("HDEV requires the bootstrapped mcp SDK") from error
    interpreter, core, bridge = _checkout_core(config)
    params = StdioServerParameters(
        command=os.fspath(interpreter),
        args=[
            "-B", "-I", "-c", base_hdev.CORE_BOOTSTRAP,
            os.fspath(core), os.fspath(bridge),
        ],
        cwd=os.fspath(config.checkout),
        env=_core_environment(config.plugin_url),
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(
            read,
            write,
            read_timeout_seconds=timedelta(seconds=75),
            client_info=Implementation(name="ae-mcp-issue86-hdev", version="1"),
        ) as session:
            await session.initialize()
            listed = await session.list_tools()
            yield base_hdev._LiveSession(session, [tool.name for tool in listed.tools])


async def stdin_checkpoint(kind: str, details: Mapping[str, Any]) -> None:
    checkpoint_id = f"{kind}-{secrets.token_hex(6)}"
    print(json.dumps({
        "event": "CHECKPOINT_REQUIRED",
        "checkpointId": checkpoint_id,
        "kind": kind,
        "details": dict(details),
        "validationProfile": "development",
        "candidateRun": False,
        "candidateEvidence": False,
    }, ensure_ascii=False, separators=(",", ":")), flush=True)
    line = await asyncio.to_thread(sys.stdin.readline)
    require(bool(line), f"checkpoint {checkpoint_id} reached EOF")
    acknowledgement = mapping(json.loads(line), "checkpoint acknowledgement is invalid")
    require(
        acknowledgement.get("checkpointId") == checkpoint_id
        and acknowledgement.get("status") == "completed",
        f"checkpoint {checkpoint_id} was not completed",
    )


def _components(value: str) -> tuple[str, ...]:
    result = tuple(member for member in value.split(",") if member)
    require(result, "component list must not be empty")
    return result


def parse_args(argv: Sequence[str] | None = None) -> Issue86Config:
    parser = argparse.ArgumentParser(
        description=__doc__,
        epilog=f"Frozen scenario: {SCENARIO_ID}; hard limit: {CALL_HARD_LIMIT} public calls.",
    )
    parser.add_argument("--scenario", choices=(SCENARIO_ID,), required=True)
    parser.add_argument("--selected-components", required=True)
    parser.add_argument("--reused-components", required=True)
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--fixture-path", type=Path, required=True)
    parser.add_argument("--recovery-archive-root", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--formal-ae-app", type=Path, required=True)
    parser.add_argument("--endpoint-root", type=Path)
    parser.add_argument("--native-log-path", type=Path)
    parser.add_argument("--native-build-receipt", type=Path, required=True)
    parser.add_argument("--native-install-receipt", type=Path, required=True)
    parser.add_argument("--component-signals", type=Path, required=True)
    parser.add_argument("--lifecycle-timeout-seconds", type=float, default=90.0)
    parser.add_argument("--lifecycle-poll-seconds", type=float, default=0.25)
    parser.add_argument("--plugin-url", default=os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488"))
    args = parser.parse_args(argv)
    local = os.environ.get("LOCALAPPDATA")
    endpoint_root = args.endpoint_root or (Path(local) / "AfterEffectsMCP" if local else None)
    require(endpoint_root is not None, "LOCALAPPDATA or --endpoint-root is required")
    log = args.native_log_path or endpoint_root / "Logs" / "native-plugin-v1.jsonl"
    return Issue86Config(
        scenario=args.scenario,
        selected_components=_components(args.selected_components),
        reused_components=_components(args.reused_components),
        checkout=args.checkout,
        fixture_path=args.fixture_path,
        recovery_root=args.recovery_archive_root,
        evidence_dir=args.evidence_dir,
        formal_ae_app=args.formal_ae_app,
        endpoint_root=endpoint_root,
        native_log_path=log,
        build_receipt_path=args.native_build_receipt,
        install_receipt_path=args.native_install_receipt,
        component_signals_path=args.component_signals,
        plugin_url=args.plugin_url,
        lifecycle_timeout_seconds=args.lifecycle_timeout_seconds,
        lifecycle_poll_seconds=args.lifecycle_poll_seconds,
    )


async def _run_cli(config: Issue86Config) -> int:
    require(os.name == "nt", "Issue #86 HDEV must run on Windows")
    async with live_session(config) as session:
        result = await run_issue86_hdev(
            config,
            session=session,
            checkpoint=stdin_checkpoint,
            lifecycle_probe=WindowsLifecycleProbe(config),
            launch_formal_ae=launch_formal_after_effects,
        )
    print(json.dumps({
        "event": "PASS" if result.exit_code == 0 else "FAIL",
        "validationProfile": "development",
        "candidateRun": False,
        "candidateEvidence": False,
        "publicCalls": result.summary["publicCalls"]["total"],
        "summaryPath": os.fspath(config.evidence_dir / f"{result.summary['runId']}.summary.json"),
    }, separators=(",", ":")), flush=True)
    return result.exit_code


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(_run_cli(parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
