#!/usr/bin/env python3
"""Shared real-AE capability-package acceptance primitives.

This module deliberately stops short of being a general plan language.  A
package still owns its exact request builders, semantic projections, fixture
recipe, Undo checks, and interaction order.  The stable concerns demonstrated
by packages #150 and #155 live here: exact-build identity, public MCP
transport, native provenance/postcondition validation, bounded call accounting,
private evidence, GUI checkpoints, and one ephemeral ``.aep`` lifecycle.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import hashlib
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
from pathlib import Path
from typing import Any, Protocol

from capability_package_identity import IdentityConfig, IdentityFailure, verify_exact_identity


FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
PRIVATE_PATH = re.compile(
    r"(?:^|[\s\"'])((?:/Users/|/private/|/var/folders/)[^\s\"']+|"
    r"[A-Za-z]:\\Users\\[^\s\"']+)"
)
SENSITIVE_KEY = re.compile(
    r"(?:token|secret|fingerprint|socket|private.?path|fixture.?path|project.?path|home)",
    re.IGNORECASE,
)


class AcceptanceFailure(RuntimeError):
    """The executable package acceptance contract was not satisfied."""
class PossiblySideEffectingStop(AcceptanceFailure):
    """A write may have occurred; state/audit reconciliation is required."""


class PublicSession(Protocol):
    tool_names: frozenset[str]

    async def call(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        """Return ``(is_error, decoded_public_payload)``."""


SessionFactory = Callable[[], contextlib.AbstractAsyncContextManager[PublicSession]]
CheckpointHandler = Callable[[str, Mapping[str, Any]], Awaitable[None]]


def require(condition: Any, message: str) -> None:
    if not condition:
        raise AcceptanceFailure(message)


def mapping(value: Any, message: str) -> dict[str, Any]:
    require(isinstance(value, Mapping), message)
    return dict(value)


def error_code(payload: Mapping[str, Any]) -> str | None:
    error = payload.get("error")
    if isinstance(error, Mapping):
        code = error.get("code")
        return code if isinstance(code, str) else None
    return error if isinstance(error, str) else None


def native_value(payload: Mapping[str, Any]) -> dict[str, Any]:
    return mapping(payload.get("value"), "public native result omitted value")


def json_hash(value: Any) -> str:
    """Hash the closed integer/string JSON contracts used by native tools."""

    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _json_default(value: Any) -> str:
    if isinstance(value, os.PathLike):
        return os.fsdecode(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def redact(value: Any, *, key: str = "") -> Any:
    if SENSITIVE_KEY.search(key):
        return "<redacted>"
    if isinstance(value, os.PathLike):
        return redact(os.fspath(value), key=key)
    if isinstance(value, Mapping):
        return {str(member): redact(item, key=str(member)) for member, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        return PRIVATE_PATH.sub(
            lambda match: match.group(0).replace(match.group(1), "<redacted-path>"),
            value,
        )
    return value


@dataclasses.dataclass(frozen=True)
class ToolCase:
    """One public package row; package code owns its exact semantics."""

    key: str
    tool: str
    capability_id: str
    kind: str
    max_primary_calls: int = 1

    def __post_init__(self) -> None:
        require(self.kind in {"read", "write"}, f"invalid tool kind for {self.tool}")
        require(self.max_primary_calls > 0, f"invalid max calls for {self.tool}")


@dataclasses.dataclass(frozen=True)
class PackageSpec:
    issue: int
    slug: str
    title: str
    tools: tuple[ToolCase, ...]
    native_novelty: bool
    support_tools: tuple[ToolCase, ...] = ()
    t5_target_calls: int = 26
    t6_target_calls: int = 26

    def __post_init__(self) -> None:
        require(self.issue > 0, "package issue must be positive")
        require(bool(self.slug), "package slug is required")
        require(5 <= len(self.tools) <= 15, "capability package must contain 5..15 tools")
        names = [case.tool for case in self.tools]
        keys = [case.key for case in self.tools]
        capabilities = [case.capability_id for case in self.tools]
        all_names = names + [case.tool for case in self.support_tools]
        require(len(set(names)) == len(names), "package tool names must be unique")
        require(len(set(all_names)) == len(all_names), "package/support tool names must be unique")
        require(len(set(keys)) == len(keys), "package case keys must be unique")
        require(
            len(set(capabilities)) == len(capabilities),
            "package capability IDs must be unique",
        )
        require(0 < self.t5_target_calls <= 30, "T5 call target must be 1..30")
        require(0 < self.t6_target_calls <= 30, "T6 call target must be 1..30")

    @property
    def case_by_tool(self) -> dict[str, ToolCase]:
        return {case.tool: case for case in self.tools}

    @property
    def write_tools(self) -> frozenset[str]:
        return frozenset(case.tool for case in self.tools if case.kind == "write")

    @property
    def required_capability_ids(self) -> tuple[str, ...]:
        return tuple(case.capability_id for case in (*self.tools, *self.support_tools))


@dataclasses.dataclass(frozen=True)
class FixturePolicy:
    path: Path
    recovery_root: Path
    fixture_id: str
    retention_days: int = 7
    lifecycle: str = "ephemeral-validation"

    def __post_init__(self) -> None:
        require(self.path.is_absolute(), "fixture path must be absolute")
        require(self.path.suffix.lower() == ".aep", "fixture path must end in .aep")
        require(self.recovery_root.is_absolute(), "recovery root must be absolute")
        require(self.lifecycle == "ephemeral-validation", "hardware fixture must be ephemeral")
        require(self.retention_days > 0, "fixture retention must be positive")


@dataclasses.dataclass(frozen=True)
class AepLifecycleCounters:
    created: int = 0
    canonical_retained: int = 0
    evidence_snapshots_retained: int = 0
    archived: int = 0
    unclassified: int = 0
    logical_bytes_moved: int = 0
    physical_bytes_released: int = 0

    def public_dict(self) -> dict[str, int]:
        return {
            "created": self.created,
            "canonicalRetained": self.canonical_retained,
            "evidenceSnapshotsRetained": self.evidence_snapshots_retained,
            "archived": self.archived,
            "unclassified": self.unclassified,
            "logicalBytesMoved": self.logical_bytes_moved,
            "physicalBytesReleased": self.physical_bytes_released,
        }


class CallLedger:
    """Count every public tool dispatch, including support and error probes."""

    HARD_LIMITS = {"preflight": 7, "t4": 3, "t5": 30, "t6": 30}

    def __init__(self, mode: str, spec: PackageSpec) -> None:
        require(mode in self.HARD_LIMITS, f"unsupported hardware mode {mode}")
        self.mode = mode
        self.hard_limit = self.HARD_LIMITS[mode]
        self.target = {
            "preflight": 7,
            "t4": 3,
            "t5": spec.t5_target_calls,
            "t6": spec.t6_target_calls,
        }[mode]
        self.total = 0
        self.handshake_attempts = 0
        self.by_tool: Counter[str] = Counter()
        self.by_phase: Counter[str] = Counter()

    def ensure_capacity(self, *, tool: str) -> None:
        if self.total >= self.hard_limit:
            raise AcceptanceFailure(
                f"public MCP call budget exhausted before dispatching {tool}: "
                f"{self.total}/{self.hard_limit}"
            )

    def pairing_required(self) -> None:
        self.handshake_attempts += 1

    def reserve(self, *, tool: str, phase: str) -> int:
        require(bool(tool) and bool(phase), "tool and phase are required for call accounting")
        self.ensure_capacity(tool=tool)
        self.total += 1
        self.by_tool[tool] += 1
        self.by_phase[phase] += 1
        return self.total

    def public_dict(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "hardLimit": self.hard_limit,
            "total": self.total,
            "handshakeAttempts": self.handshake_attempts,
            "withinTarget": self.total <= self.target,
            "byTool": dict(sorted(self.by_tool.items())),
            "byPhase": dict(sorted(self.by_phase.items())),
        }


class EvidenceLog:
    """Private append-only transcript and package-neutral machine summary."""

    def __init__(
        self,
        root: Path,
        *,
        spec: PackageSpec,
        mode: str,
        expected_sha: str,
    ) -> None:
        self.root = root
        self.spec = spec
        self.mode = mode
        self.expected_sha = expected_sha
        self.candidate_run = mode in {"t5", "t6"}
        self.candidate_evidence = False
        self.run_id = (
            f"issue{spec.issue}-{mode}-{int(time.time())}-{secrets.token_hex(4)}"
        )
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(root, stat.S_IRWXU)
        self.events_path = root / f"{self.run_id}.ndjson"
        self.summary_path = root / f"{self.run_id}.summary.json"
        self.markdown_path = root / f"{self.run_id}.completion.md"
        self._events = 0

    def record(self, event: str, payload: Mapping[str, Any]) -> None:
        entry = {
            "schemaVersion": 2,
            "packageIssue": self.spec.issue,
            "packageSlug": self.spec.slug,
            "runId": self.run_id,
            "mode": self.mode,
            "candidateRun": self.candidate_run,
            "candidateEvidence": False,
            "event": event,
            "sequence": self._events + 1,
            "recordedAtUnixMs": int(time.time() * 1000),
            "payload": redact(dict(payload)),
        }
        descriptor = os.open(
            self.events_path,
            os.O_WRONLY | os.O_CREAT | os.O_APPEND,
            0o600,
        )
        with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.chmod(self.events_path, stat.S_IRUSR | stat.S_IWUSR)
        self._events += 1

    def finish(
        self,
        *,
        passed: bool,
        details: Mapping[str, Any],
        ledger: CallLedger,
        matrix: Mapping[str, Any],
        aep_lifecycle: AepLifecycleCounters,
    ) -> None:
        self.candidate_evidence = self.candidate_run and passed
        merged = {
            **dict(details),
            "publicCalls": ledger.public_dict(),
            "perToolMatrix": dict(matrix),
            "aepLifecycle": aep_lifecycle.public_dict(),
        }
        summary = {
            "schemaVersion": 2,
            "packageIssue": self.spec.issue,
            "packageSlug": self.spec.slug,
            "runId": self.run_id,
            "mode": self.mode,
            "candidateRun": self.candidate_run,
            "candidateEvidence": self.candidate_evidence,
            "expectedSourceCommit": self.expected_sha,
            "passed": passed,
            "eventCount": self._events,
            "eventsSha256": (
                hashlib.sha256(self.events_path.read_bytes()).hexdigest()
                if self.events_path.exists()
                else None
            ),
            "details": redact(merged),
        }
        markdown = self._markdown(summary)
        for path, text in (
            (self.summary_path, json.dumps(summary, ensure_ascii=False, indent=2) + "\n"),
            (self.markdown_path, markdown),
        ):
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(text)
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)

    def _markdown(self, summary: Mapping[str, Any]) -> str:
        details = mapping(summary["details"], "summary details are invalid")
        calls = mapping(details["publicCalls"], "summary calls are invalid")
        matrix = mapping(details["perToolMatrix"], "summary matrix is invalid")
        lines = [
            f"## Issue #{self.spec.issue} {self.mode.upper()} acceptance",
            "",
            f"- exact source commit: `{summary['expectedSourceCommit']}`",
            f"- candidate run: `{str(summary['candidateRun']).lower()}`",
            f"- candidate evidence: `{str(summary['candidateEvidence']).lower()}`",
            f"- passed: `{str(summary['passed']).lower()}`",
            f"- public calls: `{calls['total']}/{calls['target']}` target, hard `{calls['hardLimit']}`",
            f"- pairing handshake attempts: `{calls['handshakeAttempts']}`",
            "- fixture: `ephemeral-validation`, one active, `saveAsCopies=0`",
            "", "| Public tool | Status | Calls | Undo |", "|---|---:|---:|---:|",
        ]
        for case in self.spec.tools:
            row = mapping(matrix[case.tool], f"matrix row {case.tool} is invalid")
            undo = mapping(row["undo"], f"matrix undo {case.tool} is invalid")
            lines.append(
                f"| `{case.tool}` | {row['status']} | {row['invocations']} | "
                f"{undo['executed']}/{str(undo['verified']).lower()} |"
            )
        return "\n".join(lines)


class _LiveSession:
    def __init__(self, session: Any, tool_names: Sequence[str]) -> None:
        self._session = session
        self.tool_names = frozenset(tool_names)

    async def call(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        result = await self._session.call_tool(tool, dict(arguments))
        texts = [item.text for item in result.content if getattr(item, "type", None) == "text"]
        require(len(texts) == 1, f"{tool} did not return exactly one public JSON text block")
        try:
            payload = json.loads(texts[0])
        except (TypeError, ValueError) as error:
            raise AcceptanceFailure(f"{tool} returned non-JSON text") from error
        require(isinstance(payload, dict), f"{tool} public JSON payload was not an object")
        return bool(result.isError), payload


class LiveSessionFactory:
    def __init__(self, launcher: Path, *, client_name: str, home: Path) -> None:
        self.launcher = launcher
        self.client_name = client_name
        self.home = home

    @contextlib.asynccontextmanager
    async def __call__(self) -> AsyncIterator[PublicSession]:
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
            from mcp.types import Implementation
        except ImportError as error:  # pragma: no cover - packaged runtime only
            raise AcceptanceFailure("hardware runner requires the installed mcp package") from error
        require(self.launcher.is_file(), "stable ae-mcp launcher is missing")
        environment = {
            "AE_MCP_BACKEND": "ae-mcp",
            "AE_MCP_PLUGIN_URL": os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488"),
            "HOME": str(self.home),
            "LANG": os.environ.get("LANG", "en_US.UTF-8"),
            "PATH": "/usr/bin:/bin",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
            "TMPDIR": os.environ.get("TMPDIR", "/private/tmp"),
        }
        params = StdioServerParameters(command=str(self.launcher), args=[], env=environment)
        async with stdio_client(params) as (read, write):
            async with ClientSession(
                read,
                write,
                read_timeout_seconds=timedelta(seconds=45),
                client_info=Implementation(name=self.client_name, version="1"),
            ) as session:
                await session.initialize()
                listed = await session.list_tools()
                yield _LiveSession(session, [tool.name for tool in listed.tools])


async def stdin_checkpoint(kind: str, details: Mapping[str, Any]) -> None:
    checkpoint_id = f"{kind}-{secrets.token_hex(6)}"
    print(
        json.dumps(
            {
                "event": "CHECKPOINT_REQUIRED",
                "checkpointId": checkpoint_id,
                "kind": kind,
                "details": dict(details),
            },
            ensure_ascii=False,
            separators=(",", ":"),
            default=_json_default,
        ),
        flush=True,
    )
    line = await asyncio.to_thread(sys.stdin.readline)
    if not line:
        raise AcceptanceFailure(f"checkpoint {checkpoint_id} reached EOF")
    try:
        acknowledgement = json.loads(line)
    except ValueError as error:
        raise AcceptanceFailure(f"checkpoint {checkpoint_id} received invalid JSON") from error
    require(
        isinstance(acknowledgement, Mapping)
        and acknowledgement.get("checkpointId") == checkpoint_id
        and acknowledgement.get("status") == "completed",
        f"checkpoint {checkpoint_id} was not explicitly completed",
    )


class AcceptanceRuntime:
    """Stable exact-identity/public-MCP shell around package-owned semantics."""

    def __init__(
        self,
        *,
        spec: PackageSpec,
        mode: str,
        identity: IdentityConfig,
        fixture: FixturePolicy,
        session_factory: SessionFactory,
        checkpoint: CheckpointHandler,
        evidence: EvidenceLog,
    ) -> None:
        self.spec = spec
        self.mode = mode
        self.identity = identity
        self.fixture = fixture
        self.session_factory = session_factory
        self.checkpoint_handler = checkpoint
        self.evidence = evidence
        self.ledger = CallLedger(mode, spec)
        self.matrix = {
            case.tool: {
                "tool": case.tool,
                "capabilityId": case.capability_id,
                "kind": case.kind,
                "status": "pending",
                "invocations": 0,
                "auditRequestIds": [],
                "undo": {
                    "required": case.kind == "write",
                    "executed": 0,
                    "verified": case.kind == "read",
                },
            }
            for case in spec.tools
        }
        self.aep_lifecycle = AepLifecycleCounters()
        self.component_hashes: dict[str, str] = {}
        self.contract_digests: dict[str, str] = {}
        self.formal_ae_identity: dict[str, str] = {}
        self.expected_host_instance_id: str | None = None
        self.intent_counter = 0
        self.pairing_checkpoint_used = False
        self.pairing_epoch_start_total = 0

    def validate_machine_identity(
        self, *, required_capability_ids: Sequence[str] | None = None
    ) -> None:
        try:
            proof = verify_exact_identity(
                self.identity,
                required_capability_ids=(
                    required_capability_ids
                    if required_capability_ids is not None
                    else self.spec.required_capability_ids
                ),
            )
        except IdentityFailure as error:
            raise AcceptanceFailure(str(error)) from error
        self.component_hashes.update(proof.component_hashes)
        self.contract_digests.update(proof.contract_digests)
        self.formal_ae_identity.update(proof.formal_ae_identity)

    def bind_latest_native_load(
        self, *, stage: str, previous_instance_id: str | None = None
    ) -> str:
        path = self.identity.identity_home / "Library/Logs/AfterEffectsMCP/native-plugin-v1.jsonl"
        try:
            info = path.lstat()
        except FileNotFoundError as error:
            raise AcceptanceFailure("native load log is missing") from error
        require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), "native log is invalid")
        if os.name == "posix":
            require(stat.S_IMODE(info.st_mode) == 0o600, "native log must use mode 0600")
        require(0 < info.st_size <= 8 * 1024 * 1024, "native log is empty or unbounded")
        payload = path.read_bytes()
        latest: dict[str, Any] | None = None
        for raw_line in payload.splitlines():
            if not raw_line or len(raw_line) > 1024 * 1024:
                continue
            try:
                candidate = json.loads(raw_line)
            except (UnicodeDecodeError, ValueError):
                continue
            if isinstance(candidate, dict) and candidate.get("event") == "load":
                latest = candidate
        require(latest is not None, "native log has no load event")
        host = mapping(latest.get("host"), "native load host is invalid")
        instance_id = latest.get("instanceId")
        require(
            latest.get("schemaVersion") == 1
            and latest.get("provenance") == "native-aegp"
            and latest.get("sourceCommit") == self.identity.expected_sha
            and isinstance(instance_id, str)
            and UUID.fullmatch(instance_id),
            "native load identity mismatch",
        )
        require(host.get("version") == self.identity.expected_ae_version, "native host version mismatch")
        require(host.get("build") == self.identity.expected_ae_host_build, "native host build mismatch")
        if previous_instance_id is not None:
            require(instance_id != previous_instance_id, "AE restart reused native instance")
        self.expected_host_instance_id = instance_id
        self.pairing_checkpoint_used = False
        self.pairing_epoch_start_total = self.ledger.total
        self.evidence.record(
            "native-load-bound",
            {
                "stage": stage,
                "instanceId": instance_id,
                "sourceCommit": self.identity.expected_sha,
                "host": host,
                "logSha256": hashlib.sha256(payload).hexdigest(),
                "recordSha256": json_hash(latest),
            },
        )
        return instance_id

    def intent(self, operation: str) -> str:
        self.intent_counter += 1
        digest = hashlib.sha256(
            f"{self.evidence.run_id}:{operation}:{self.intent_counter}".encode()
        ).hexdigest()[:24]
        return f"issue{self.spec.issue}:{operation}:{digest}"

    async def checkpoint(self, kind: str, details: Mapping[str, Any]) -> None:
        self.evidence.record("checkpoint-requested", {"kind": kind, "details": details})
        await self.checkpoint_handler(kind, details)
        self.evidence.record("checkpoint-completed", {"kind": kind})

    def require_tools(self, session: PublicSession, tools: Sequence[str]) -> None:
        missing = sorted(set(tools) - set(session.tool_names))
        require(not missing, f"public MCP tools/list omitted required tools: {missing}")

    def _validate_native_success(
        self,
        payload: Mapping[str, Any],
        *,
        tool: str,
        capability_id: str,
        write: bool,
    ) -> None:
        implementation = mapping(payload.get("implementation"), f"{tool} omitted implementation")
        provenance = mapping(payload.get("provenance"), f"{tool} omitted provenance")
        audit = mapping(payload.get("audit"), f"{tool} omitted audit")
        evidence = mapping(payload.get("evidence"), f"{tool} omitted evidence")
        postcondition = mapping(evidence.get("postcondition"), f"{tool} omitted postcondition")
        value = native_value(payload)
        require(payload.get("ok") is True, f"{tool} did not report ok=true")
        require(implementation.get("engine") == "native-aegp", f"{tool} was not native-aegp")
        require(implementation.get("capabilityId") == capability_id, f"{tool} capability mismatch")
        require(implementation.get("capabilityVersion") == 1, f"{tool} capability version mismatch")
        expected_contract = self.contract_digests.get(capability_id)
        require(expected_contract is not None, f"{tool} contract was not frozen")
        require(implementation.get("contractDigest") == expected_contract, f"{tool} contract digest mismatch")
        require(provenance.get("sourceCommit") == self.identity.expected_sha, f"{tool} source SHA mismatch")
        require(provenance.get("engine") == "native-aegp", f"{tool} provenance mismatch")
        require(
            provenance.get("hostInstanceId") == evidence.get("hostInstanceId")
            and provenance.get("sessionId") == evidence.get("sessionId"),
            f"{tool} provenance/evidence mismatch",
        )
        require(
            self.expected_host_instance_id is not None
            and provenance.get("hostInstanceId") == self.expected_host_instance_id,
            f"{tool} response is not bound to latest formal AE load",
        )
        require(
            audit.get("requestId") == evidence.get("requestId")
            and audit.get("capabilityId") == capability_id
            and audit.get("contractDigest") == expected_contract,
            f"{tool} audit/evidence mismatch",
        )
        digest = json_hash(
            {"capabilityId": capability_id, "capabilityVersion": 1, "value": value}
        )
        require(postcondition.get("verified") is True, f"{tool} postcondition was not verified")
        require(postcondition.get("algorithm") == "sha256-rfc8785-jcs-v1", f"{tool} digest algorithm mismatch")
        require(postcondition.get("digest") == digest, f"{tool} postcondition digest mismatch")
        require(audit.get("postconditionDigest") == digest, f"{tool} audit digest mismatch")
        require(audit.get("requestDigest") == evidence.get("requestDigest"), f"{tool} request digest mismatch")
        expected_effect = "committed" if write else "none"
        require(
            audit.get("effect") == expected_effect and evidence.get("effect") == expected_effect,
            f"{tool} effect mismatch",
        )
        if write:
            undo = mapping(evidence.get("undo"), f"{tool} omitted Undo evidence")
            require(undo == {"available": True, "verified": False}, f"{tool} Undo evidence mismatch")
            require(isinstance(payload.get("replayed"), bool), f"{tool} omitted replay status")

    async def call(
        self,
        session: PublicSession,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        capability_id: str,
        write: bool,
        phase: str,
        expected_error: str | None = None,
        expected_replayed: bool | None = None,
    ) -> dict[str, Any]:
        self.ledger.ensure_capacity(tool=tool)
        is_error, payload = await session.call(tool, dict(arguments))
        code = error_code(payload)
        if code == "NATIVE_PAIRING_REQUIRED":
            self.ledger.pairing_required()
            error = mapping(payload.get("error"), "pairing error is invalid")
            pairing = mapping(error.get("details"), "pairing details are invalid")
            require(
                is_error
                and payload.get("ok") is False
                and error.get("sideEffect") == "not-started"
                and error.get("retryable") is True,
                "pairing requirement did not prove the tool was not dispatched",
            )
            require(
                isinstance(pairing.get("pairingFingerprint"), str)
                and bool(pairing["pairingFingerprint"])
                and isinstance(pairing.get("pairingExpiresInMs"), int)
                and pairing["pairingExpiresInMs"] > 0
                and pairing.get("hostInstanceId") == self.expected_host_instance_id
                and pairing.get("sourceCommit") == self.identity.expected_sha,
                "pairing request was not bound to the exact formal AE candidate",
            )
            require(
                self.ledger.total == self.pairing_epoch_start_total
                and not self.pairing_checkpoint_used,
                "pairing recovery is allowed only before the first effective tool call in this host epoch",
            )
            self.pairing_checkpoint_used = True
            self.evidence.record(
                "pairing-required",
                {"tool": tool, "attempt": self.ledger.handshake_attempts, "sideEffect": "not-started"},
            )
            await self.checkpoint(
                "pair-native",
                {
                    "instruction": (
                        "Immediately open the formal After Effects AE MCP pairing command, "
                        "authorize the currently displayed request, close the prompt, then acknowledge."
                    ),
                    "tool": tool,
                    "expectedSourceCommit": self.identity.expected_sha,
                    "secretsPersisted": False,
                },
            )
            self.ledger.ensure_capacity(tool=tool)
            is_error, payload = await session.call(tool, dict(arguments))
            code = error_code(payload)
            if code == "NATIVE_PAIRING_REQUIRED":
                self.ledger.pairing_required()
                self.evidence.record(
                    "pairing-retry-failed",
                    {"tool": tool, "attempt": self.ledger.handshake_attempts, "code": code},
                )
                raise AcceptanceFailure("native pairing was still required after one authorization")
            if code == "NATIVE_PAIRING_REJECTED":
                self.ledger.pairing_required()
                self.evidence.record(
                    "pairing-retry-failed",
                    {"tool": tool, "attempt": self.ledger.handshake_attempts, "code": code},
                )
                raise AcceptanceFailure("native pairing was rejected; start a new prepared session")
        sequence = self.ledger.reserve(tool=tool, phase=phase)
        self.evidence.record(
            "public-tool-request",
            {"call": sequence, "phase": phase, "tool": tool, "arguments": arguments},
        )
        self.evidence.record(
            "public-tool-response",
            {"call": sequence, "phase": phase, "tool": tool, "isError": is_error, "payload": payload},
        )
        code = error_code(payload)
        case = self.spec.case_by_tool.get(tool)
        if case is not None:
            row = self.matrix[tool]
            row["invocations"] += 1
            require(
                row["invocations"] <= case.max_primary_calls,
                f"{tool} exceeded its declared primary-call bound",
            )
        if code == "POSSIBLY_SIDE_EFFECTING_FAILURE":
            raise PossiblySideEffectingStop(
                f"{tool} may have changed AE; reconcile state and audit before retry"
            )
        if expected_error is not None:
            require(is_error and payload.get("ok") is False, f"{tool} unexpectedly succeeded")
            require(code == expected_error, f"{tool} returned {code!r}, expected {expected_error!r}")
            return payload
        require(not is_error and code is None, f"{tool} failed: {code or payload}")
        self._validate_native_success(
            payload, tool=tool, capability_id=capability_id, write=write
        )
        if expected_replayed is not None:
            require(payload.get("replayed") is expected_replayed, f"{tool} replay mismatch")
        if case is not None:
            request_id = mapping(payload["audit"], f"{tool} audit is invalid")["requestId"]
            if request_id not in self.matrix[tool]["auditRequestIds"]:
                self.matrix[tool]["auditRequestIds"].append(request_id)
        return payload

    def mark_tool_passed(
        self,
        tool: str,
        *,
        undo_executed: bool = False,
        undo_verified: bool = False,
    ) -> None:
        require(tool in self.matrix, f"unknown package tool {tool}")
        row = self.matrix[tool]
        row["status"] = "passed"
        if undo_executed:
            row["undo"]["executed"] += 1
        if undo_verified:
            row["undo"]["verified"] = True

    def require_fixture_absent(self) -> None:
        require(
            not os.path.lexists(self.fixture.path),
            "fixture path already exists; refusing to overwrite user or stale data",
        )

    @staticmethod
    def _sha256_file(path: Path, label: str) -> str:
        digest = hashlib.sha256()
        try:
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
        except OSError as error:
            raise AcceptanceFailure(f"could not hash {label}") from error
        return digest.hexdigest()

    def saved_fixture_identity(self, path: Path | None = None) -> tuple[int, str]:
        target = path or self.fixture.path
        try:
            info = target.lstat()
        except FileNotFoundError as error:
            raise AcceptanceFailure("fixture is missing") from error
        require(stat.S_ISREG(info.st_mode) and not target.is_symlink(), "fixture is invalid")
        require(info.st_size > 0, "fixture is empty")
        return info.st_size, self._sha256_file(target, "fixture")

    def mark_fixture_created(self) -> dict[str, Any]:
        size, digest = self.saved_fixture_identity()
        self.aep_lifecycle = AepLifecycleCounters(created=1)
        record = {
            "fixtureId": self.fixture.fixture_id,
            "lifecycle": self.fixture.lifecycle,
            "bytes": size,
            "sha256": digest,
            "activeFixtureCount": 1,
            "saveAsCopies": 0,
        }
        self.evidence.record("fixture-saved", record)
        return record

    @staticmethod
    def _inside(path: Path, root: Path) -> bool:
        return path == root or root in path.parents

    async def archive_fixture(self) -> dict[str, Any]:
        home = self.identity.identity_home
        resolved_root = self.fixture.recovery_root.resolve(strict=False)
        scan_roots = (
            home / "Library/Application Support/Adobe/CEP/extensions",
            home / "Library/Application Support/Adobe/Common/Plug-ins",
            Path("/Library/Application Support/Adobe/CEP/extensions"),
            Path("/Library/Application Support/Adobe/Common/Plug-ins"),
        )
        require(
            not any(self._inside(resolved_root, root.resolve(strict=False)) for root in scan_roots),
            "recovery root must be outside Adobe scan roots",
        )
        await self.checkpoint(
            "archive-fixture",
            {
                "instruction": (
                    "Save the active fixture in place, close it, and quit formal AE. "
                    "Do not Save As; the runner will move the exact file to recovery."
                ),
                "fixturePath": self.fixture.path,
                "archiveRoot": self.fixture.recovery_root,
                "lifecycle": self.fixture.lifecycle,
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
            },
        )
        size, digest = self.saved_fixture_identity()
        root = self.fixture.recovery_root
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        require(not root.is_symlink(), "recovery root cannot be a symlink")
        run_directory = root / self.evidence.run_id
        require(not os.path.lexists(run_directory), "run recovery directory already exists")
        run_directory.mkdir(mode=0o700, parents=False, exist_ok=False)
        destination = run_directory / self.fixture.path.name
        shutil.move(str(self.fixture.path), str(destination))
        require(not os.path.lexists(self.fixture.path), "active fixture remained after archive")
        archived_size, archived_digest = self.saved_fixture_identity(destination)
        require((archived_size, archived_digest) == (size, digest), "archive identity mismatch")
        cleanup_after = int(
            (time.time() + (self.fixture.retention_days * 24 * 60 * 60)) * 1000
        )
        self.aep_lifecycle = AepLifecycleCounters(
            created=1,
            archived=1,
            logical_bytes_moved=size,
        )
        record = {
            "fixtureId": self.fixture.fixture_id,
            "lifecycle": self.fixture.lifecycle,
            "sourceAbsent": True,
            "archivePath": destination,
            "sha256": digest,
            "bytes": size,
            "cleanupAfterUnixMs": cleanup_after,
            "cleanupCondition": "package T6 and Issue closure complete; no unresolved defect references this fixture",
        }
        self.evidence.record("fixture-archived", record)
        return record
