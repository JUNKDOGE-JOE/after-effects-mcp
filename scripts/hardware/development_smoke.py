#!/usr/bin/env python3
"""Run one bounded, permanently non-candidate real-AE development smoke."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import dataclasses
import json
import os
import re
import secrets
import shutil
import stat
import sys
import time
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from datetime import timedelta
from fractions import Fraction
from pathlib import Path
from typing import Any, Protocol

from development_smoke_spec import (
    BASELINE_COLOR,
    CALL_HARD_LIMIT,
    CALLS,
    CHANGED_COLOR,
    SCENARIO_ID,
)

COMPONENTS = frozenset({"core", "cep", "native"})
SHA256 = re.compile(r"^[0-9a-f]{64}$")
FIXTURE_NAME = "HDEV Core Native Fixture"
CORE_BOOTSTRAP = (
    "import runpy,sys;"
    "sys.path.insert(0,sys.argv[1]);"
    'runpy.run_module("ae_mcp",run_name="__main__")'
)
CORE_IMPORT_PROBE = (
    "import pathlib,sys;"
    "sys.path.insert(0,sys.argv[1]);"
    "import ae_mcp;"
    "print(pathlib.Path(ae_mcp.__file__).resolve())"
)


class DevelopmentSmokeFailure(RuntimeError):
    """The bounded HDEV contract was not satisfied."""


class PossiblySideEffectingStop(DevelopmentSmokeFailure):
    """A write may have completed and must not be retried."""


def require(condition: Any, message: str) -> None:
    if not condition:
        raise DevelopmentSmokeFailure(message)


def mapping(value: Any, message: str) -> dict[str, Any]:
    require(isinstance(value, Mapping), message)
    return dict(value)


def error_code(payload: Mapping[str, Any]) -> str | None:
    error = payload.get("error")
    if not isinstance(error, Mapping):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None


@dataclasses.dataclass(frozen=True)
class DevelopmentSmokeConfig:
    scenario: str
    selected_components: tuple[str, ...]
    reused_components: tuple[str, ...]
    checkout: Path
    fixture_path: Path
    recovery_root: Path
    evidence_dir: Path
    formal_ae_app: Path
    plugin_url: str

    def __post_init__(self) -> None:
        require(self.scenario == SCENARIO_ID, "unsupported HDEV scenario")
        selected = set(self.selected_components)
        reused = set(self.reused_components)
        require(
            len(selected) == len(self.selected_components)
            and len(reused) == len(self.reused_components),
            "component disposition contains duplicates",
        )
        require(
            selected <= COMPONENTS and reused <= COMPONENTS,
            "component disposition contains an unknown component",
        )
        require(not selected.intersection(reused), "component disposition overlaps")
        require(selected.union(reused) == COMPONENTS, "component disposition is incomplete")
        require(bool(selected), "at least one selected component is required")
        for member in (
            self.checkout,
            self.fixture_path,
            self.recovery_root,
            self.evidence_dir,
            self.formal_ae_app,
        ):
            require(member.is_absolute(), "HDEV paths must be absolute")
        require(self.fixture_path.suffix.lower() == ".aep", "fixture must end in .aep")
        require(
            self.plugin_url.startswith("http://127.0.0.1:"),
            "HDEV plugin URL must be loopback",
        )

    @property
    def component_disposition(self) -> dict[str, list[str]]:
        return {
            "selected": list(self.selected_components),
            "reused": list(self.reused_components),
        }


class PublicSession(Protocol):
    tool_names: frozenset[str]

    async def call(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> tuple[bool, dict[str, Any]]: ...


@dataclasses.dataclass(frozen=True)
class DevelopmentSmokeResult:
    exit_code: int
    summary: dict[str, Any]


class DevelopmentEvidence:
    """Private HDEV evidence whose candidate fields cannot be promoted."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, stat.S_IRWXU)
        self.run_id = f"hdev-{int(time.time())}-{secrets.token_hex(4)}"
        self.events_path = root / f"{self.run_id}.ndjson"
        self.summary_path = root / f"{self.run_id}.summary.json"
        self._events = 0

    def record(self, event: str, payload: Mapping[str, Any]) -> None:
        entry = {
            "schemaVersion": 1,
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
            "runId": self.run_id,
            "sequence": self._events + 1,
            "event": event,
            "recordedAtUnixMs": int(time.time() * 1000),
            "payload": dict(payload),
        }
        descriptor = os.open(
            self.events_path,
            os.O_WRONLY | os.O_CREAT | os.O_APPEND,
            0o600,
        )
        with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")))
            stream.write("\n")
        os.chmod(self.events_path, stat.S_IRUSR | stat.S_IWUSR)
        self._events += 1

    def finish(
        self,
        *,
        passed: bool,
        public_calls: Mapping[str, Any],
        component_disposition: Mapping[str, Any],
        aep_lifecycle: Mapping[str, Any],
        details: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        summary = {
            "schemaVersion": 1,
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
            "runId": self.run_id,
            "passed": passed,
            "publicCalls": dict(public_calls),
            "componentDisposition": dict(component_disposition),
            "aepLifecycle": dict(aep_lifecycle),
            **dict(details or {}),
        }
        descriptor = os.open(
            self.summary_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(summary, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.chmod(self.summary_path, stat.S_IRUSR | stat.S_IWUSR)
        return summary


class DevelopmentCallLedger:
    def __init__(self) -> None:
        self.total = 0
        self.by_tool: Counter[str] = Counter()
        self.by_phase: Counter[str] = Counter()

    def reserve(self, tool: str, phase: str) -> int:
        if self.total >= CALL_HARD_LIMIT:
            raise DevelopmentSmokeFailure(
                f"public MCP call budget exhausted before {tool}: "
                f"{self.total}/{CALL_HARD_LIMIT}"
            )
        self.total += 1
        self.by_tool[tool] += 1
        self.by_phase[phase] += 1
        return self.total

    def public_dict(self) -> dict[str, Any]:
        return {
            "target": CALL_HARD_LIMIT,
            "hardLimit": CALL_HARD_LIMIT,
            "total": self.total,
            "byTool": dict(sorted(self.by_tool.items())),
            "byPhase": dict(sorted(self.by_phase.items())),
        }


def _time(value: Any) -> Fraction:
    exact = mapping(value, "exact time is invalid")
    require(
        set(exact) == {"value", "scale", "secondsRational"}
        and type(exact.get("value")) is int
        and type(exact.get("scale")) is int
        and exact["scale"] > 0,
        "exact time is not closed",
    )
    result = Fraction(exact["value"], exact["scale"])
    require(exact["secondsRational"] == str(result), "exact time rational drifted")
    return result


def _ratio(value: Any) -> Fraction:
    exact = mapping(value, "exact ratio is invalid")
    require(
        set(exact) == {"numerator", "denominator", "rational"}
        and type(exact.get("numerator")) is int
        and type(exact.get("denominator")) is int
        and exact["denominator"] > 0,
        "exact ratio is not closed",
    )
    result = Fraction(exact["numerator"], exact["denominator"])
    require(exact["rational"] == str(result), "exact ratio rational drifted")
    return result


def _snapshot(value: Any) -> dict[str, Any]:
    state = mapping(value, "composition settings snapshot is invalid")
    state.pop("compositionLocator", None)
    require(set(state) == {
        "name", "width", "height", "duration", "frameDuration", "frameRate",
        "pixelAspectRatio", "backgroundColor", "workArea",
        "displayStartTime", "layerCount",
    }, "composition settings snapshot is not closed")
    color = mapping(state["backgroundColor"], "background color is invalid")
    work = mapping(state["workArea"], "work area is invalid")
    require(
        set(color) == {"red", "green", "blue", "alpha"},
        "background color is not closed",
    )
    require(set(work) == {"start", "duration"}, "work area is not closed")
    snapshot = {
        "name": state["name"],
        "width": state["width"],
        "height": state["height"],
        "duration": _time(state["duration"]),
        "frameDuration": _time(state["frameDuration"]),
        "frameRate": _ratio(state["frameRate"]),
        "pixelAspectRatio": _ratio(state["pixelAspectRatio"]),
        "backgroundColor": dict(color),
        "workArea": {
            "start": _time(work["start"]),
            "duration": _time(work["duration"]),
        },
        "displayStartTime": _time(state["displayStartTime"]),
        "layerCount": state["layerCount"],
    }
    require(
        snapshot["frameDuration"] * snapshot["frameRate"] == 1,
        "frame duration and frame rate disagree",
    )
    return snapshot


EXPECTED_BASELINE = {
    "name": FIXTURE_NAME,
    "width": 640,
    "height": 360,
    "duration": Fraction(5),
    "frameDuration": Fraction(1, 24),
    "frameRate": Fraction(24),
    "pixelAspectRatio": Fraction(1),
    "backgroundColor": BASELINE_COLOR,
    "workArea": {"start": Fraction(0), "duration": Fraction(5)},
    "displayStartTime": Fraction(0),
    "layerCount": 0,
}


class DevelopmentSmokeRunner:
    def __init__(
        self,
        config: DevelopmentSmokeConfig,
        *,
        checkpoint: Callable[[str, Mapping[str, Any]], Awaitable[None]],
        after_effects_running: Callable[[], Awaitable[bool]],
        evidence: DevelopmentEvidence | None = None,
    ) -> None:
        self.config = config
        self.checkpoint = checkpoint
        self.after_effects_running = after_effects_running
        self.evidence = evidence or DevelopmentEvidence(config.evidence_dir)
        self.ledger = DevelopmentCallLedger()
        self.host_instance_id: str | None = None
        self.session_id: str | None = None
        self.lifecycle = {
            "created": 0,
            "canonicalRetained": 0,
            "evidenceSnapshotsRetained": 0,
            "archived": 0,
            "unclassified": 0,
            "saveAsCopies": 0,
        }

    def _validate_native(self, payload: Mapping[str, Any], *, write: bool) -> None:
        implementation = mapping(payload.get("implementation"), "implementation missing")
        provenance = mapping(payload.get("provenance"), "provenance missing")
        audit = mapping(payload.get("audit"), "audit missing")
        evidence = mapping(payload.get("evidence"), "evidence missing")
        postcondition = mapping(evidence.get("postcondition"), "postcondition missing")
        require(
            implementation.get("engine") == "native-aegp"
            and provenance.get("engine") == "native-aegp"
            and evidence.get("engine") == "native-aegp",
            "native AEGP provenance drifted",
        )
        contract_digest = implementation.get("contractDigest")
        require(
            isinstance(contract_digest, str)
            and SHA256.fullmatch(contract_digest) is not None
            and audit.get("contractDigest") == contract_digest,
            "capability contract digest drifted",
        )
        require(
            implementation.get("capabilityId") == audit.get("capabilityId")
            == evidence.get("capabilityId")
            and implementation.get("capabilityVersion") == 1
            and audit.get("capabilityVersion") == evidence.get("capabilityVersion") == 1,
            "capability identity drifted",
        )
        host = provenance.get("hostInstanceId")
        session = provenance.get("sessionId")
        require(
            isinstance(host, str) and host == evidence.get("hostInstanceId")
            and isinstance(session, str) and session == evidence.get("sessionId"),
            "formal host/session evidence drifted",
        )
        if self.host_instance_id is None:
            self.host_instance_id = host
            self.session_id = session
        require(
            host == self.host_instance_id and session == self.session_id,
            "formal host/session changed during HDEV",
        )
        require(
            isinstance(provenance.get("capabilitiesDigest"), str)
            and SHA256.fullmatch(provenance["capabilitiesDigest"]) is not None,
            "capabilities digest missing",
        )
        require(
            isinstance(audit.get("requestId"), str)
            and audit["requestId"] == evidence.get("requestId")
            and postcondition.get("verified") is True
            and postcondition.get("algorithm") == "sha256-rfc8785-jcs-v1"
            and postcondition.get("digest") == audit.get("postconditionDigest"),
            "audit/postcondition evidence drifted",
        )
        if write:
            value = mapping(payload.get("value"), "write value missing")
            undo = mapping(evidence.get("undo"), "write Undo evidence missing")
            require(value.get("changed") is True, "write did not report changed=true")
            require(
                set(undo) >= {"available", "verified"}
                and type(undo["available"]) is bool
                and type(undo["verified"]) is bool
                and audit.get("undoAvailable") is undo["available"]
                and audit.get("undoVerified") is undo["verified"],
                "write Undo availability/verification drifted",
            )

    async def public_call(
        self,
        session: PublicSession,
        phase: str,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        write: bool = False,
    ) -> dict[str, Any]:
        sequence = self.ledger.reserve(tool, phase)
        self.evidence.record("public-tool-request", {
            "call": sequence,
            "phase": phase,
            "tool": tool,
            "arguments": dict(arguments),
        })
        is_error, payload = await session.call(tool, dict(arguments))
        self.evidence.record("public-tool-response", {
            "call": sequence,
            "phase": phase,
            "tool": tool,
            "isError": is_error,
            "payload": payload,
        })
        code = error_code(payload)
        if code == "POSSIBLY_SIDE_EFFECTING_FAILURE":
            raise PossiblySideEffectingStop(
                f"{tool} may have changed AE; inspect state and audit before any retry"
            )
        require(not is_error and code is None and payload.get("ok") is True, f"{tool} failed")
        self._validate_native(payload, write=write)
        return dict(payload)

    @staticmethod
    def _composition_locator(value: Any) -> dict[str, Any]:
        locator = mapping(value, "composition locator missing")
        require(
            set(locator) == {
                "kind", "hostInstanceId", "sessionId", "projectId",
                "generation", "objectId",
            } and locator.get("kind") == "composition",
            "composition locator is not closed",
        )
        return locator

    async def _archive_fixture(self) -> Path:
        require(
            not await self.after_effects_running(),
            "formal After Effects still owns the HDEV fixture",
        )
        require(self.config.fixture_path.is_file(), "HDEV fixture is missing before archive")
        self.config.recovery_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.config.recovery_root, stat.S_IRWXU)
        destination = self.config.recovery_root / (
            f"{self.config.fixture_path.stem}-{int(time.time())}-"
            f"{secrets.token_hex(3)}.aep"
        )
        require(not destination.exists(), "HDEV recovery destination already exists")
        shutil.move(os.fspath(self.config.fixture_path), os.fspath(destination))
        self.lifecycle["archived"] = 1
        return destination

    async def run(self, session: PublicSession) -> dict[str, Any]:
        required_tools = {tool for _, tool in CALLS}
        require(required_tools <= session.tool_names, "HDEV public tool set is incomplete")

        await self.checkpoint("save-empty-project", {
            "instruction": (
                "In formal After Effects, create one empty project and save it once "
                "at fixturePath. Do not use Save As again."
            ),
            "fixturePath": os.fspath(self.config.fixture_path),
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
        })
        require(self.config.fixture_path.is_file(), "saved HDEV fixture is missing")
        self.lifecycle["created"] = 1
        readiness = await self.public_call(
            session, "readiness", "ae_projectSummary", {}
        )
        readiness_value = mapping(readiness.get("value"), "readiness value missing")
        require(
            readiness_value.get("projectOpen") is True
            and readiness_value.get("itemCount") == 0,
            "saved HDEV project is not empty and ready",
        )

        created = await self.public_call(
            session,
            "composition-create",
            "ae_createComposition",
            {
                "name": FIXTURE_NAME,
                "width": 640,
                "height": 360,
                "duration": {"value": 5, "scale": 1},
                "frame_rate": {"numerator": 24, "denominator": 1},
                "pixel_aspect_ratio": {"numerator": 1, "denominator": 1},
                "idempotency_key": "hdev-core-native-composition-0001",
            },
            write=True,
        )
        locator = self._composition_locator(
            mapping(created.get("value"), "composition create value missing")
            .get("compositionLocator")
        )
        baseline_payload = await self.public_call(
            session,
            "baseline-settings",
            "ae_getCompositionSettings",
            {"composition_locator": locator},
        )
        baseline_value = mapping(baseline_payload.get("value"), "baseline value missing")
        baseline = _snapshot(baseline_value)
        require(baseline == EXPECTED_BASELINE, "new composition baseline drifted")
        locator = self._composition_locator(baseline_value.get("compositionLocator"))

        changed_payload = await self.public_call(
            session,
            "background-set",
            "ae_setCompositionBackgroundColor",
            {
                "composition_locator": locator,
                "background_color": CHANGED_COLOR,
                "idempotency_key": "hdev-core-native-background-0001",
            },
            write=True,
        )
        changed_value = mapping(changed_payload.get("value"), "background write value missing")
        before = _snapshot(changed_value.get("before"))
        after = _snapshot(changed_value.get("after"))
        require(before == baseline, "write before snapshot drifted")
        require(before["backgroundColor"] == BASELINE_COLOR, "write before colour drifted")
        require(after == {**baseline, "backgroundColor": CHANGED_COLOR}, "write after drifted")
        require(after["backgroundColor"] == CHANGED_COLOR, "write after colour drifted")
        locator = self._composition_locator(changed_value.get("compositionLocator"))

        changed_read_payload = await self.public_call(
            session,
            "changed-settings",
            "ae_getCompositionSettings",
            {"composition_locator": locator},
        )
        require(
            _snapshot(changed_read_payload.get("value")) == after,
            "independent changed settings readback drifted",
        )
        undo = mapping(
            mapping(changed_payload.get("evidence"), "write evidence missing").get("undo"),
            "write Undo evidence missing",
        )
        require(
            undo.get("available") is True and undo.get("verified") is False,
            "background write is not one available, unexecuted Undo",
        )
        await self.checkpoint("undo-background-change", {
            "instruction": (
                "Refresh Edit, execute exactly one real Undo for the background "
                "change, refresh Edit again, and do not retry the write."
            ),
            "fixturePath": os.fspath(self.config.fixture_path),
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
        })

        reacquired_payload = await self.public_call(
            session,
            "undo-reacquire",
            "ae_listProjectItems",
            {"offset": 0, "limit": 50},
        )
        items = mapping(reacquired_payload.get("value"), "project items value missing").get(
            "items"
        )
        require(isinstance(items, list), "project items are invalid")
        matches = [
            mapping(item, "project item invalid")
            for item in items
            if isinstance(item, Mapping)
            and item.get("name") == FIXTURE_NAME
            and item.get("type") == "composition"
        ]
        require(len(matches) == 1, "HDEV composition was not uniquely reacquired")
        locator = self._composition_locator(matches[0].get("locator"))
        restored_payload = await self.public_call(
            session,
            "undo-settings",
            "ae_getCompositionSettings",
            {"composition_locator": locator},
        )
        restored = _snapshot(restored_payload.get("value"))
        require(restored == baseline, "real Undo did not restore the complete baseline")
        require(
            restored["backgroundColor"] == BASELINE_COLOR,
            "real Undo did not restore background colour",
        )
        require(self.ledger.total == CALL_HARD_LIMIT, "HDEV call count drifted")

        await self.checkpoint("close-formal-ae", {
            "instruction": (
                "Save the existing project without Save As, close formal After "
                "Effects, and wait until no After Effects / AfterFX process remains."
            ),
            "fixturePath": os.fspath(self.config.fixture_path),
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
        })
        archived = await self._archive_fixture()
        self.evidence.record("fixture-archived", {
            "lifecycle": "ephemeral-validation",
            "archived": True,
            "archiveName": archived.name,
            "saveAsCopies": 0,
        })
        return {
            "scenario": self.config.scenario,
            "hostInstanceId": self.host_instance_id,
            "sessionId": self.session_id,
            "realUndo": {
                "executed": 1,
                "verified": True,
                "tool": "ae_setCompositionBackgroundColor",
            },
        }


async def run_development_smoke(
    config: DevelopmentSmokeConfig,
    *,
    session: PublicSession,
    checkpoint: Callable[[str, Mapping[str, Any]], Awaitable[None]],
    after_effects_running: Callable[[], Awaitable[bool]],
) -> DevelopmentSmokeResult:
    evidence = DevelopmentEvidence(config.evidence_dir)
    runner = DevelopmentSmokeRunner(
        config,
        checkpoint=checkpoint,
        after_effects_running=after_effects_running,
        evidence=evidence,
    )
    passed = False
    exit_code = 2
    details: dict[str, Any] = {}
    try:
        details = await runner.run(session)
        passed = True
        exit_code = 0
    except PossiblySideEffectingStop as error:
        details = {
            "stopReason": "possibly-side-effecting",
            "message": str(error),
        }
        exit_code = 3
    except DevelopmentSmokeFailure as error:
        details = {"failure": str(error)}
        exit_code = 2
    if not passed and runner.lifecycle["created"] == 1:
        runner.lifecycle["unclassified"] = 1
    summary = evidence.finish(
        passed=passed,
        public_calls=runner.ledger.public_dict(),
        component_disposition=config.component_disposition,
        aep_lifecycle=runner.lifecycle,
        details=details,
    )
    return DevelopmentSmokeResult(exit_code=exit_code, summary=summary)


async def completed_checkpoint() -> None:
    return None


async def completed_process_check(value: bool) -> bool:
    return value


class _LiveSession:
    def __init__(self, session: Any, tool_names: Sequence[str]) -> None:
        self._session = session
        self.tool_names = frozenset(tool_names)

    async def call(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        result = await self._session.call_tool(tool, dict(arguments))
        texts = [
            item.text for item in result.content
            if getattr(item, "type", None) == "text"
        ]
        require(len(texts) == 1, f"{tool} did not return exactly one JSON text block")
        try:
            payload = json.loads(texts[0])
        except (TypeError, ValueError) as error:
            raise DevelopmentSmokeFailure(f"{tool} returned non-JSON text") from error
        require(isinstance(payload, dict), f"{tool} JSON payload is not an object")
        return bool(result.isError), payload


def _verify_checkout_core(checkout: Path) -> tuple[Path, Path]:
    require(checkout.is_dir() and not checkout.is_symlink(), "checkout is invalid")
    canonical = checkout.resolve(strict=True)
    interpreter = canonical / ".venv/bin/python3"
    core_root = canonical / "packages/core"
    require(interpreter.exists() and os.access(interpreter, os.X_OK), "interpreter missing")
    require(
        (core_root / "ae_mcp/__main__.py").is_file(),
        "checkout Core entrypoint missing",
    )
    import subprocess

    result = subprocess.run(
        [
            os.fspath(interpreter),
            "-B",
            "-I",
            "-c",
            CORE_IMPORT_PROBE,
            os.fspath(core_root),
        ],
        cwd=canonical,
        env={
            "HOME": os.fspath(Path.home()),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
            "PATH": "/usr/bin:/bin",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
            "TMPDIR": os.environ.get("TMPDIR", "/private/tmp"),
        },
        check=True,
        capture_output=True,
        text=True,
    )
    imported = Path(result.stdout.strip()).resolve(strict=True)
    require(
        imported.is_relative_to(core_root),
        "isolated Core import did not resolve beneath checkout",
    )
    return interpreter.resolve(strict=True), core_root


@contextlib.asynccontextmanager
async def live_session(config: DevelopmentSmokeConfig) -> AsyncIterator[PublicSession]:
    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
        from mcp.types import Implementation
    except ImportError as error:  # pragma: no cover - hardware environment only
        raise DevelopmentSmokeFailure("HDEV requires the bootstrapped mcp SDK") from error
    interpreter, core_root = _verify_checkout_core(config.checkout)
    environment = {
        "AE_MCP_BACKEND": "ae-mcp",
        "AE_MCP_PLUGIN_URL": config.plugin_url,
        "HOME": os.fspath(Path.home()),
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "TMPDIR": os.environ.get("TMPDIR", "/private/tmp"),
    }
    params = StdioServerParameters(
        command=os.fspath(interpreter),
        args=["-B", "-I", "-c", CORE_BOOTSTRAP, os.fspath(core_root)],
        cwd=os.fspath(config.checkout),
        env=environment,
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(
            read,
            write,
            read_timeout_seconds=timedelta(seconds=75),
            client_info=Implementation(name="ae-mcp-hdev", version="1"),
        ) as session:
            await session.initialize()
            listed = await session.list_tools()
            yield _LiveSession(session, [tool.name for tool in listed.tools])


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
    try:
        acknowledgement = json.loads(line)
    except ValueError as error:
        raise DevelopmentSmokeFailure("checkpoint acknowledgement is invalid") from error
    require(
        isinstance(acknowledgement, Mapping)
        and acknowledgement.get("checkpointId") == checkpoint_id
        and acknowledgement.get("status") == "completed",
        f"checkpoint {checkpoint_id} was not completed",
    )


async def formal_ae_running() -> bool:
    process = await asyncio.create_subprocess_exec(
        "/usr/bin/pgrep",
        "-f",
        "Adobe After Effects|AfterFX",
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    status = await process.wait()
    if status not in {0, 1}:
        raise DevelopmentSmokeFailure("could not inspect formal AE process state")
    return status == 0


def _components(value: str) -> tuple[str, ...]:
    members = tuple(item for item in value.split(",") if item)
    require(bool(members), "component list must not be empty")
    return members


def parse_args(argv: Sequence[str] | None = None) -> DevelopmentSmokeConfig:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", required=True)
    parser.add_argument("--selected-components", required=True)
    parser.add_argument("--reused-components", required=True)
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--fixture-path", type=Path, required=True)
    parser.add_argument("--recovery-archive-root", type=Path, required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--formal-ae-app", type=Path, required=True)
    parser.add_argument(
        "--plugin-url",
        default=os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488"),
    )
    arguments = parser.parse_args(argv)
    return DevelopmentSmokeConfig(
        scenario=arguments.scenario,
        selected_components=_components(arguments.selected_components),
        reused_components=_components(arguments.reused_components),
        checkout=arguments.checkout,
        fixture_path=arguments.fixture_path,
        recovery_root=arguments.recovery_archive_root,
        evidence_dir=arguments.evidence_dir,
        formal_ae_app=arguments.formal_ae_app,
        plugin_url=arguments.plugin_url,
    )


async def _run_cli(config: DevelopmentSmokeConfig) -> int:
    async with live_session(config) as session:
        result = await run_development_smoke(
            config,
            session=session,
            checkpoint=stdin_checkpoint,
            after_effects_running=formal_ae_running,
        )
    print(json.dumps({
        "event": "PASS" if result.exit_code == 0 else "FAIL",
        "validationProfile": "development",
        "candidateRun": False,
        "candidateEvidence": False,
        "publicCalls": result.summary["publicCalls"]["total"],
        "summaryPath": os.fspath(
            next(config.evidence_dir.glob(f"{result.summary['runId']}.summary.json"))
        ),
    }, separators=(",", ":")), flush=True)
    return result.exit_code


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(_run_cli(parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
