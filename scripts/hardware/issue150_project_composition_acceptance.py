#!/usr/bin/env python3
"""Tracked real-AE acceptance driver for capability package #150.

This is deliberately package-specific.  It exercises the eight public MCP
tools frozen in issue #150 and records a redacted, append-only transcript.  It
does not call Core handlers, the CEP HTTP API, or the native socket directly.

T4 runs only the composition-duplicate lifecycle smoke.  T5 and T6 run the
complete package matrix, including one real After Effects Undo checkpoint per
write and a final AE restart/stale-locator checkpoint.  A GUI orchestrator may
perform those operations while this process waits on stdin.

The driver stops immediately on POSSIBLY_SIDE_EFFECTING_FAILURE.  It never
retries a write whose outcome may be ambiguous.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import dataclasses
import hashlib
import json
import math
import os
import re
import secrets
import stat
import sys
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from datetime import timedelta
from pathlib import Path
from typing import Any, Protocol


FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
PRIVATE_PATH = re.compile(
    r"(?:^|[\s\"'])((?:/Users/|/private/|/var/folders/)[^\s\"']+|[A-Za-z]:\\Users\\[^\s\"']+)",
)
SENSITIVE_KEY = re.compile(
    r"(?:token|secret|fingerprint|socket|private.?path|fixture.?path|project.?path|home)",
    re.IGNORECASE,
)

PACKAGE_TOOLS = (
    "ae_getProjectContext",
    "ae_getProjectItemMetadata",
    "ae_getCompositionSettings",
    "ae_setCompositionWorkArea",
    "ae_renameProjectItem",
    "ae_setProjectItemComment",
    "ae_setProjectItemLabel",
    "ae_duplicateComposition",
)

SUPPORT_TOOLS = ("ae_listProjectItems",)

CAPABILITY_BY_TOOL = {
    "ae_getProjectContext": "ae.project.context.read",
    "ae_getProjectItemMetadata": "ae.project.item.metadata.read",
    "ae_getCompositionSettings": "ae.composition.settings.read",
    "ae_setCompositionWorkArea": "ae.composition.work-area.set",
    "ae_renameProjectItem": "ae.project.item.name.set",
    "ae_setProjectItemComment": "ae.project.item.comment.set",
    "ae_setProjectItemLabel": "ae.project.item.label.set",
    "ae_duplicateComposition": "ae.composition.duplicate",
    "ae_listProjectItems": "ae.project.items.list",
}

POSTCONDITION_KIND_BY_TOOL = {
    "ae_getProjectContext": "project-context-read",
    "ae_getProjectItemMetadata": "project-item-metadata-read",
    "ae_getCompositionSettings": "composition-settings-read",
    "ae_setCompositionWorkArea": "composition-work-area-set",
    "ae_renameProjectItem": "project-item-name-set",
    "ae_setProjectItemComment": "project-item-comment-set",
    "ae_setProjectItemLabel": "project-item-label-set",
    "ae_duplicateComposition": "composition-duplicate",
    "ae_listProjectItems": "project-items-list",
}

FROZEN_DESCRIPTOR_BY_TOOL = {
    "ae_getProjectContext": ("ee6df463fe36f13a02a09b833b0f13a01ba1c2a5dc335d689c04ea834ad10dca", "read", "read-only", "idempotent", "not-applicable", "none"),
    "ae_getProjectItemMetadata": ("b13139c0b2e8073f6606bfbead1e59eb7fea63ec10a164b500e19ff8babd0f69", "read", "read-only", "idempotent", "not-applicable", "none"),
    "ae_getCompositionSettings": ("a7ae9383b4a627bf6f3f42cb929eafa724cf7bc30a172b67ddbcaf9e754f5e9b", "read", "read-only", "idempotent", "not-applicable", "none"),
    "ae_setCompositionWorkArea": ("a4ffd90349164e1d7228e5d2374ef55c9f0dc1065db0dac9945a7f8eeb16b997", "write", "mutating", "idempotency-key", "ae-undo-group", "committed"),
    "ae_renameProjectItem": ("b26f017991e74f009b15cb24fcfd4bb7f154d4ac506f65f150b29efcccb9f538", "write", "mutating", "idempotency-key", "ae-undo-group", "committed"),
    "ae_setProjectItemComment": ("957985628474caa9c9cef3de76a2839e59691232b062b776ff800a79dd3cc35c", "write", "mutating", "idempotency-key", "ae-undo-group", "committed"),
    "ae_setProjectItemLabel": ("4463637f6a5298b27afb39cea68c593a93383e4ccc7926bc228d00e0cc3ba94f", "write", "mutating", "idempotency-key", "ae-undo-group", "committed"),
    "ae_duplicateComposition": ("96e7a14f7e2b983fac41a918657b101f54638d5ae6acee6003757bc6458b3be3", "write", "mutating", "idempotency-key", "ae-undo-group", "committed"),
    "ae_listProjectItems": ("64e87abb4beec44bf6ad3223002602222f1efcd6c1dc4f27383c617dfa2d444e", "read", "read-only", "idempotent", "not-applicable", "none"),
}

WRITE_TOOLS = frozenset(
    {
        "ae_setCompositionWorkArea",
        "ae_renameProjectItem",
        "ae_setProjectItemComment",
        "ae_setProjectItemLabel",
        "ae_duplicateComposition",
    }
)


class AcceptanceFailure(RuntimeError):
    """The package acceptance contract was not satisfied."""


class PossiblySideEffectingStop(AcceptanceFailure):
    """A write may have occurred; the driver stopped without retrying."""


class PublicSession(Protocol):
    tool_names: frozenset[str]

    async def call(self, tool: str, arguments: Mapping[str, Any]) -> tuple[bool, dict[str, Any]]:
        """Return ``(is_error, decoded_public_payload)``."""


SessionFactory = Callable[[], contextlib.AbstractAsyncContextManager[PublicSession]]
CheckpointHandler = Callable[[str, Mapping[str, Any]], Awaitable[None]]


def _require(condition: Any, message: str) -> None:
    if not condition:
        raise AcceptanceFailure(message)


def _bounded_unicode(value: Any, *, maximum: int, allow_empty: bool = True) -> bool:
    return (
        isinstance(value, str)
        and (allow_empty or bool(value))
        and len(value) <= maximum
        and "\x00" not in value
        and not any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    )


def _mapping(value: Any, message: str) -> dict[str, Any]:
    _require(isinstance(value, Mapping), message)
    return dict(value)


def _redact(value: Any, *, key: str = "") -> Any:
    if SENSITIVE_KEY.search(key):
        return "<redacted>"
    if isinstance(value, Mapping):
        return {str(member): _redact(item, key=str(member)) for member, item in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, tuple):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return PRIVATE_PATH.sub(lambda match: match.group(0).replace(match.group(1), "<redacted-path>"), value)
    return value


def _json_hash(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class EvidenceLog:
    """Private append-only NDJSON plus one final summary."""

    def __init__(self, root: Path, *, mode: str, expected_sha: str) -> None:
        self.root = root
        self.mode = mode
        self.expected_sha = expected_sha
        self.run_id = f"issue150-{mode}-{int(time.time())}-{secrets.token_hex(4)}"
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(root, stat.S_IRWXU)
        self.events_path = root / f"{self.run_id}.ndjson"
        self.summary_path = root / f"{self.run_id}.summary.json"
        self._events = 0

    def record(self, event: str, payload: Mapping[str, Any]) -> None:
        entry = {
            "schemaVersion": 1,
            "runId": self.run_id,
            "mode": self.mode,
            "event": event,
            "sequence": self._events + 1,
            "recordedAtUnixMs": int(time.time() * 1000),
            "payload": _redact(dict(payload)),
        }
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        descriptor = os.open(self.events_path, flags, 0o600)
        with os.fdopen(descriptor, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.chmod(self.events_path, stat.S_IRUSR | stat.S_IWUSR)
        self._events += 1

    def finish(self, *, passed: bool, details: Mapping[str, Any]) -> None:
        summary = {
            "schemaVersion": 1,
            "packageIssue": 150,
            "runId": self.run_id,
            "mode": self.mode,
            "expectedSourceCommit": self.expected_sha,
            "passed": passed,
            "eventCount": self._events,
            "eventsSha256": hashlib.sha256(self.events_path.read_bytes()).hexdigest()
            if self.events_path.exists()
            else None,
            "details": _redact(dict(details)),
        }
        descriptor = os.open(
            self.summary_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
        os.chmod(self.summary_path, stat.S_IRUSR | stat.S_IWUSR)


def _error_code(payload: Mapping[str, Any]) -> str | None:
    error = payload.get("error")
    if isinstance(error, Mapping):
        code = error.get("code")
        return code if isinstance(code, str) else None
    return error if isinstance(error, str) else None


def _native_value(payload: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(payload.get("value"), "public native result omitted value")


def _locator(entry: Mapping[str, Any]) -> dict[str, Any]:
    candidate = entry.get("itemLocator", entry.get("compositionLocator", entry.get("locator")))
    locator = _mapping(candidate, "project-context entry omitted its locator")
    _require(
        set(locator)
        == {"kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId"},
        "locator shape is not closed",
    )
    _require(locator.get("kind") in {"project", "item", "composition"}, "locator kind is invalid")
    for field in ("hostInstanceId", "sessionId", "projectId", "objectId"):
        _require(isinstance(locator.get(field), str) and UUID.fullmatch(locator[field]), f"locator.{field} is invalid")
    _require(
        isinstance(locator.get("generation"), int)
        and not isinstance(locator.get("generation"), bool)
        and locator["generation"] > 0,
        "locator generation is invalid",
    )
    return locator


def _exact_time(value: Any, *, field: str) -> dict[str, Any]:
    result = _mapping(value, f"{field} must be an exact-time object")
    _require(set(result) == {"value", "scale", "secondsRational"}, f"{field} shape is not closed")
    _require(
        isinstance(result["value"], int)
        and not isinstance(result["value"], bool)
        and -(2**31) <= result["value"] <= 2**31 - 1,
        f"{field}.value must be a signed 32-bit integer",
    )
    _require(
        isinstance(result["scale"], int)
        and not isinstance(result["scale"], bool)
        and 1 <= result["scale"] <= 2**32 - 1,
        f"{field}.scale is invalid",
    )
    divisor = math.gcd(abs(result["value"]), result["scale"])
    numerator = result["value"] // divisor
    denominator = result["scale"] // divisor
    expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
    _require(result["secondsRational"] == expected, f"{field}.secondsRational is not canonical")
    return result


def _exact_ratio(value: Any, *, field: str) -> dict[str, Any]:
    result = _mapping(value, f"{field} must be an exact-ratio object")
    _require(set(result) == {"numerator", "denominator", "rational"}, f"{field} shape is not closed")
    _require(
        isinstance(result["numerator"], int)
        and not isinstance(result["numerator"], bool)
        and result["numerator"] > 0,
        f"{field}.numerator is invalid",
    )
    _require(
        isinstance(result["denominator"], int)
        and not isinstance(result["denominator"], bool)
        and result["denominator"] > 0,
        f"{field}.denominator is invalid",
    )
    divisor = math.gcd(result["numerator"], result["denominator"])
    numerator = result["numerator"] // divisor
    denominator = result["denominator"] // divisor
    expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
    _require(result["rational"] == expected, f"{field}.rational is not canonical")
    return result


def _same_time(actual: Mapping[str, Any], requested: Mapping[str, int]) -> bool:
    value = actual.get("value")
    scale = actual.get("scale")
    return (
        isinstance(value, int)
        and isinstance(scale, int)
        and value * requested["scale"] == requested["value"] * scale
    )


def _work_area(settings: Mapping[str, Any], *, field: str) -> dict[str, dict[str, Any]]:
    work_area = _mapping(settings.get("workArea"), f"{field}.workArea is invalid")
    _require(set(work_area) == {"start", "duration"}, f"{field}.workArea shape is not closed")
    return {
        "start": _exact_time(work_area.get("start"), field=f"{field}.workArea.start"),
        "duration": _exact_time(work_area.get("duration"), field=f"{field}.workArea.duration"),
    }


def _settings_snapshot(settings: Mapping[str, Any]) -> dict[str, Any]:
    """Return a result snapshot while excluding session-bound locator identity."""

    return {
        key: value
        for key, value in settings.items()
        if key != "compositionLocator"
    }


def _clone_settings_semantics(settings: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in _settings_snapshot(settings).items() if key != "name"}


def _same_locator_object(left: Mapping[str, Any], right: Mapping[str, Any]) -> bool:
    """Compare one object across graph generations without weakening host/session binding."""

    identity_fields = ("kind", "hostInstanceId", "sessionId")
    return all(left.get(field) == right.get(field) for field in identity_fields)


def _semantic_locator(value: Any, aliases: Mapping[str, str] | None = None) -> Any:
    if value is None:
        return None
    locator = _locator({"locator": value})
    object_id = locator["objectId"]
    return {
        "kind": locator["kind"],
        "objectId": (aliases or {}).get(object_id, object_id),
    }


def _semantic_item(
    value: Mapping[str, Any], aliases: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    item = dict(value)
    locator = _locator(item)
    for key in ("itemLocator", "compositionLocator", "locator"):
        item.pop(key, None)
    if "parentLocator" in item:
        item["parentLocator"] = _semantic_locator(item["parentLocator"], aliases)
    return {"identity": _semantic_locator(locator, aliases), **item}


def _semantic_snapshot(state: "CompositionState") -> dict[str, Any]:
    project_locator = _locator({"locator": state.context.get("projectLocator")})
    aliases = {
        state.locator["objectId"]: "fixture-source",
        project_locator["objectId"]: "project",
    }
    metadata = dict(state.metadata)
    metadata.pop("itemLocator", None)
    metadata["parentLocator"] = _semantic_locator(metadata.get("parentLocator"), aliases)
    items = {
        aliases.get(_locator(item)["objectId"], _locator(item)["objectId"]): _semantic_item(item, aliases)
        for item in state.project_items.get("items", [])
        if isinstance(item, Mapping)
    }
    selection = _mapping(state.context.get("selection"), "context selection is invalid")
    selection_items = [
        _semantic_item(item, aliases)
        for item in selection.get("items", [])
        if isinstance(item, Mapping)
    ]
    selection_identities = [item["identity"]["objectId"] for item in selection_items]
    context = {
        "projectLocator": _semantic_locator(project_locator, aliases),
        "activeItem": (
            _semantic_item(state.context["activeItem"], aliases)
            if isinstance(state.context.get("activeItem"), Mapping) else None
        ),
        "mostRecentlyUsedComposition": (
            _semantic_item(state.context["mostRecentlyUsedComposition"], aliases)
            if isinstance(state.context.get("mostRecentlyUsedComposition"), Mapping) else None
        ),
        "selection": {
            key: selection.get(key)
            for key in ("total", "offset", "limit", "returned", "hasMore", "nextOffset")
        } | {
            "itemOrder": selection_identities,
            "items": dict(zip(selection_identities, selection_items, strict=True)),
        },
    }
    return {
        "context": context,
        "metadata": metadata,
        "settings": _settings_snapshot(state.settings),
        "projectItems": {"total": state.project_items.get("total"), "items": items},
    }


def _semantic_differences(left: Any, right: Any, prefix: str = "") -> set[str]:
    if isinstance(left, Mapping) and isinstance(right, Mapping):
        differences: set[str] = set()
        keys = set(left) | set(right)
        for key in keys:
            path = f"{prefix}.{key}" if prefix else str(key)
            if key not in left or key not in right:
                differences.add(path)
            else:
                differences.update(_semantic_differences(left[key], right[key], path))
        return differences
    if left != right:
        return {prefix}
    return set()


def _require_only_semantic_delta(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    expected_paths: set[str],
    *,
    operation: str,
) -> None:
    actual = _semantic_differences(before, after)
    unexpected = {
        path for path in actual
        if not any(path == allowed or path.startswith(allowed + ".") for allowed in expected_paths)
    }
    missing = {
        allowed for allowed in expected_paths
        if not any(path == allowed or path.startswith(allowed + ".") for path in actual)
    }
    _require(
        not unexpected and not missing,
        f"{operation} semantic delta mismatch: missing {sorted(missing)}, unexpected {sorted(unexpected)}",
    )


@dataclasses.dataclass(frozen=True)
class RunConfig:
    mode: str
    expected_sha: str
    fixture_composition_name: str
    renamed_name: str
    duplicate_name: str
    comment_value: str
    label_id: int
    work_area_start: dict[str, int]
    work_area_duration: dict[str, int]
    identity_home: Path | None = None
    native_receipt: Path | None = None
    native_manifest: Path | None = None


@dataclasses.dataclass(frozen=True)
class CompositionState:
    name: str
    locator: dict[str, Any]
    context: dict[str, Any]
    metadata: dict[str, Any]
    settings: dict[str, Any]
    project_items: dict[str, Any]


class PackageAcceptance:
    def __init__(
        self,
        config: RunConfig,
        *,
        session_factory: SessionFactory,
        checkpoint: CheckpointHandler,
        evidence: EvidenceLog,
    ) -> None:
        self.config = config
        self.session_factory = session_factory
        self.checkpoint = checkpoint
        self.evidence = evidence
        self._intent_counter = 0
        self._covered_tools: set[str] = set()
        self._component_hashes: dict[str, str] = {}

    @staticmethod
    def _identity_json(path: Path, label: str) -> tuple[dict[str, Any], str]:
        _require(path.is_file() and not path.is_symlink(), f"{label} is not a canonical regular file")
        payload = path.read_bytes()
        _require(0 < len(payload) <= 4 * 1024 * 1024, f"{label} is empty or unbounded")
        try:
            decoded = json.loads(payload)
        except (UnicodeDecodeError, ValueError) as error:
            raise AcceptanceFailure(f"{label} is not valid JSON") from error
        return _mapping(decoded, f"{label} must be a JSON object"), hashlib.sha256(payload).hexdigest()

    def _validate_machine_identity(self) -> None:
        receipt_path = self.config.native_receipt
        _require(receipt_path is not None, "native build receipt is required for hardware acceptance")
        receipt, receipt_hash = self._identity_json(receipt_path, "native build receipt")
        _require(
            receipt.get("sourceCommit") == self.config.expected_sha
            and isinstance(receipt.get("source"), Mapping)
            and receipt["source"].get("commit") == self.config.expected_sha,
            "native build receipt source commit does not match the exact candidate",
        )
        self._component_hashes = {"nativeBuildReceiptSha256": receipt_hash}
        home = self.config.identity_home or Path.home()
        cep_path = home / "Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel/bundle-manifest.json"
        current_path = home / ".ae-mcp/runtime/current"
        cep, cep_hash = self._identity_json(cep_path, "canonical CEP bundle manifest")
        _require(
            cep.get("sourceCommitSha") == self.config.expected_sha,
            "canonical CEP bundle manifest source commit mismatch",
        )
        _require(current_path.is_file() and not current_path.is_symlink(), "RuntimeManager current pointer is invalid")
        current_bytes = current_path.read_bytes()
        relative = current_bytes.decode("utf-8").strip()
        _require(
            relative and not relative.startswith("/") and ".." not in relative.split("/"),
            "RuntimeManager current pointer is invalid",
        )
        generation = relative.split("/", 1)[0]
        install_path = home / ".ae-mcp/runtime" / generation / "install-record.json"
        install, install_hash = self._identity_json(install_path, "RuntimeManager install record")
        _require(
            install.get("relative") == relative
            and install.get("sourceCommitSha") == self.config.expected_sha,
            "RuntimeManager current/install record do not match the exact candidate",
        )
        manifest_path = self.config.native_manifest
        _require(manifest_path is not None, "native plug-in manifest is required for hardware acceptance")
        manifest, manifest_hash = self._identity_json(manifest_path, "native plug-in manifest")
        artifact = _mapping(manifest.get("artifact"), "native plug-in manifest omitted artifact")
        _require(
            manifest.get("sourceCommitSha") == self.config.expected_sha,
            "native plug-in manifest source commit mismatch",
        )
        _require(
            artifact.get("receiptSha256") == receipt_hash,
            "native plug-in manifest does not bind the supplied build receipt",
        )
        for field in ("bundleTreeSha256", "executableSha256", "piplSha256", "receiptSha256"):
            _require(SHA256.fullmatch(str(artifact.get(field, ""))), f"native manifest {field} is invalid")
        self._component_hashes.update({
            "cepBundleManifestSha256": cep_hash,
            "runtimeCurrentSha256": hashlib.sha256(current_bytes).hexdigest(),
            "runtimeInstallRecordSha256": install_hash,
            "runtimeManifestSha256": str(install.get("runtimeManifestSha256")),
            "nativePluginManifestSha256": manifest_hash,
            "nativeBundleTreeSha256": str(artifact["bundleTreeSha256"]),
            "nativeExecutableSha256": str(artifact["executableSha256"]),
            "nativePiplSha256": str(artifact["piplSha256"]),
        })
        _require(
            all(SHA256.fullmatch(value) for value in self._component_hashes.values()),
            "machine component identity contains a non-SHA256 value",
        )
        self.evidence.record("machine-identity", {
            "sourceCommit": self.config.expected_sha,
            "runtimeRelative": relative,
            "components": self._component_hashes,
        })

    async def _checkpoint(self, kind: str, details: Mapping[str, Any]) -> None:
        self.evidence.record("checkpoint-required", {"kind": kind, "details": details})
        await self.checkpoint(kind, details)
        self.evidence.record(
            "checkpoint-completed",
            {"kind": kind, "detailsDigest": _json_hash(_redact(dict(details)))},
        )

    def _intent(self, operation: str) -> str:
        self._intent_counter += 1
        digest = hashlib.sha256(
            f"{self.evidence.run_id}:{operation}:{self._intent_counter}".encode()
        ).hexdigest()[:20]
        return f"issue150:{operation}:{digest}"

    async def _call(
        self,
        session: PublicSession,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        expected_error: str | None = None,
    ) -> dict[str, Any]:
        self.evidence.record("public-mcp-request", {"tool": tool, "arguments": arguments})
        is_error, payload = await session.call(tool, arguments)
        self.evidence.record(
            "public-mcp-response",
            {"tool": tool, "isError": is_error, "payload": payload},
        )
        code = _error_code(payload)
        if code == "POSSIBLY_SIDE_EFFECTING_FAILURE":
            self.evidence.record(
                "stop-possibly-side-effecting",
                {"tool": tool, "argumentsDigest": _json_hash(arguments)},
            )
            raise PossiblySideEffectingStop(
                f"{tool} may have mutated AE; inspect state/audit before any retry"
            )
        if expected_error is not None:
            _require(is_error, f"{tool} returned a non-error MCP result; expected {expected_error}")
            _require(payload.get("ok") is False, f"{tool} expected failure omitted ok=false")
            _require(code == expected_error, f"{tool} returned {code!r}, expected {expected_error!r}")
            return payload
        _require(not is_error, f"{tool} unexpectedly returned MCP isError=true ({code})")
        _require(payload.get("ok") is True, f"{tool} public payload omitted ok=true")
        self._validate_native_success(payload, tool)
        self._covered_tools.add(tool)
        return payload

    def _validate_native_success(self, payload: Mapping[str, Any], tool: str) -> None:
        capability = CAPABILITY_BY_TOOL[tool]
        value = _mapping(payload.get("value"), f"{tool} omitted typed value")
        implementation = _mapping(payload.get("implementation"), f"{tool} omitted implementation")
        provenance = _mapping(payload.get("provenance"), f"{tool} omitted provenance")
        audit = _mapping(payload.get("audit"), f"{tool} omitted audit")
        evidence = _mapping(payload.get("evidence"), f"{tool} omitted evidence")
        postcondition = _mapping(evidence.get("postcondition"), f"{tool} omitted postcondition")
        _require(implementation.get("engine") == "native-aegp", f"{tool} was not native-aegp")
        _require(implementation.get("capabilityId") == capability, f"{tool} capability mismatch")
        _require(implementation.get("capabilityVersion") == 1, f"{tool} capability version mismatch")
        contract_digest = implementation.get("contractDigest")
        frozen_digest, risk, mutability, idempotency, undo_semantics, effect = (
            FROZEN_DESCRIPTOR_BY_TOOL[tool]
        )
        _require(contract_digest == frozen_digest, f"{tool} frozen contract digest mismatch")
        _require(
            implementation.get("risk") == risk
            and implementation.get("mutability") == mutability
            and implementation.get("idempotency") == idempotency
            and implementation.get("undo") == undo_semantics,
            f"{tool} descriptor semantics mismatch",
        )
        _require(provenance.get("engine") == "native-aegp", f"{tool} provenance engine mismatch")
        _require(provenance.get("selectedWireVersion") == 1, f"{tool} wire version mismatch")
        _require(
            isinstance(provenance.get("pluginVersion"), str)
            and isinstance(provenance.get("compiledSdkVersion"), str)
            and isinstance(provenance.get("sessionGeneration"), int)
            and provenance["sessionGeneration"] > 0,
            f"{tool} provenance identity is incomplete",
        )
        _require(
            provenance.get("sourceCommit") == self.config.expected_sha,
            f"{tool} source commit did not match exact candidate",
        )
        _require(audit.get("capabilityId") == capability, f"{tool} audit capability mismatch")
        _require(audit.get("capabilityVersion") == 1, f"{tool} audit capability version mismatch")
        _require(audit.get("contractDigest") == contract_digest, f"{tool} audit contract mismatch")
        for field in ("capabilitiesDigest",):
            _require(SHA256.fullmatch(str(provenance.get(field, ""))), f"{tool} provenance {field} is invalid")
        for field in ("hostInstanceId", "sessionId"):
            _require(
                provenance.get(field) == evidence.get(field)
                and isinstance(evidence.get(field), str)
                and UUID.fullmatch(evidence[field]),
                f"{tool} {field} did not bind provenance to evidence",
            )
        _require(evidence.get("engine") == "native-aegp", f"{tool} evidence engine mismatch")
        _require(evidence.get("capabilityId") == capability, f"{tool} evidence capability mismatch")
        _require(evidence.get("capabilityVersion") == 1, f"{tool} evidence version mismatch")
        request_digest = evidence.get("requestDigest")
        _require(SHA256.fullmatch(str(request_digest or "")), f"{tool} request digest is invalid")
        _require(audit.get("requestDigest") == request_digest, f"{tool} audit request digest mismatch")
        _require(
            isinstance(evidence.get("requestId"), str)
            and (
                audit.get("evidenceRequestId", audit.get("requestId"))
                == evidence.get("requestId")
            ),
            f"{tool} audit request did not bind execution evidence",
        )
        _require(postcondition.get("verified") is True, f"{tool} postcondition was not verified")
        _require(
            postcondition.get("kind") == POSTCONDITION_KIND_BY_TOOL[tool],
            f"{tool} postcondition kind mismatch",
        )
        _require(
            postcondition.get("algorithm") == "sha256-rfc8785-jcs-v1"
            and audit.get("postconditionAlgorithm") == postcondition.get("algorithm"),
            f"{tool} postcondition algorithm mismatch",
        )
        digest = postcondition.get("digest")
        _require(SHA256.fullmatch(str(digest or "")), f"{tool} postcondition digest is invalid")
        expected_digest = _json_hash({
            "capabilityId": capability,
            "capabilityVersion": 1,
            "value": value,
        })
        _require(digest == expected_digest, f"{tool} postcondition digest does not match typed value")
        _require(
            audit.get("postconditionDigest") == digest,
            f"{tool} audit postcondition digest mismatch",
        )
        _require(
            audit.get("startedAtUnixMs") == evidence.get("startedAtUnixMs")
            and audit.get("completedAtUnixMs") == evidence.get("completedAtUnixMs"),
            f"{tool} audit timing did not bind execution evidence",
        )
        _require(
            isinstance(evidence.get("startedAtUnixMs"), int)
            and evidence.get("completedAtUnixMs", 0) >= evidence["startedAtUnixMs"],
            f"{tool} evidence timing is invalid",
        )
        _require(audit.get("effect") == effect, f"{tool} frozen effect semantics mismatch")
        if tool in WRITE_TOOLS:
            undo = _mapping(evidence.get("undo"), f"{tool} omitted native Undo evidence")
            _require(audit.get("effect") == "committed", f"{tool} audit did not commit one mutation")
            _require(evidence.get("effect") == "committed", f"{tool} evidence did not commit one mutation")
            _require(undo.get("available") is True, f"{tool} did not expose AE Undo")
            _require(undo.get("verified") is False, f"{tool} falsely claimed Undo was already verified")
            _require(
                audit.get("undoAvailable") is True
                and audit.get("undoVerified") is False
                and audit.get("replayed") == payload.get("replayed"),
                f"{tool} audit did not bind replay/Undo evidence",
            )
        else:
            _require(audit.get("effect") == "none", f"{tool} read reported a side effect")
            _require(evidence.get("effect") == "none", f"{tool} read evidence reported a side effect")
            _require("undo" not in evidence, f"{tool} read exposed Undo evidence")

    async def _pairing_context(self, session: PublicSession) -> dict[str, Any]:
        arguments = {"selection_offset": 0, "selection_limit": 50}
        self.evidence.record(
            "public-mcp-request",
            {"tool": "ae_getProjectContext", "arguments": arguments},
        )
        is_error, payload = await session.call("ae_getProjectContext", arguments)
        self.evidence.record(
            "public-mcp-response",
            {"tool": "ae_getProjectContext", "isError": is_error, "payload": payload},
        )
        code = _error_code(payload)
        if code == "NATIVE_PAIRING_REQUIRED":
            error = payload.get("error") if isinstance(payload.get("error"), Mapping) else {}
            await self._checkpoint(
                "pair-native",
                {
                    "tool": "ae_getProjectContext",
                    "expiresInMs": error.get("details", {}).get("pairingExpiresInMs")
                    if isinstance(error.get("details"), Mapping)
                    else None,
                    # The live control message may display the short-lived value,
                    # but EvidenceLog redacts this member before persistence.
                    "pairingFingerprint": error.get("details", {}).get("pairingFingerprint")
                    if isinstance(error.get("details"), Mapping)
                    else None,
                },
            )
            return await self._call(session, "ae_getProjectContext", arguments)
        if code == "POSSIBLY_SIDE_EFFECTING_FAILURE":
            raise PossiblySideEffectingStop("context read unexpectedly reported an ambiguous write")
        _require(not is_error and payload.get("ok") is True, f"context preflight failed: {code}")
        self._validate_native_success(payload, "ae_getProjectContext")
        self._covered_tools.add("ae_getProjectContext")
        return payload

    async def _context(self, session: PublicSession) -> dict[str, Any]:
        payload = await self._call(
            session,
            "ae_getProjectContext",
            {"selection_offset": 0, "selection_limit": 50},
        )
        value = _native_value(payload)
        _require(
            set(value)
            == {"projectLocator", "generation", "activeItem", "mostRecentlyUsedComposition", "selection"},
            "project context shape is not closed",
        )
        project_locator = _locator({"itemLocator": value.get("projectLocator")})
        _require(project_locator["kind"] == "project", "project context locator is not a project")
        _require(isinstance(value.get("generation"), int), "project context omitted generation")
        _require(value["generation"] == project_locator["generation"], "project generation mismatch")
        selection = _mapping(value.get("selection"), "project context omitted selection page")
        items = selection.get("items")
        _require(isinstance(items, list), "project context selection items must be a list")
        for field in ("total", "offset", "limit", "returned"):
            _require(isinstance(selection.get(field), int), f"selection.{field} is invalid")
        _require(selection["returned"] == len(items), "selection returned count disagrees with items")
        _require(isinstance(selection.get("hasMore"), bool), "selection.hasMore is invalid")
        consumed = selection["offset"] + selection["returned"]
        _require(selection["hasMore"] == (consumed < selection["total"]), "selection.hasMore mismatch")
        _require(
            selection.get("nextOffset") == (consumed if selection["hasMore"] else None),
            "selection.nextOffset mismatch",
        )
        for key in ("activeItem", "mostRecentlyUsedComposition"):
            entry = value[key]
            _require(entry is None or isinstance(entry, Mapping), f"project context {key} is invalid")
            if isinstance(entry, Mapping):
                _locator(entry)
        for item in items:
            _require(isinstance(item, Mapping), "project context selection entry is invalid")
            _locator(item)
        return value

    @staticmethod
    def _context_candidates(context: Mapping[str, Any]) -> list[dict[str, Any]]:
        candidates: list[dict[str, Any]] = []
        for key in ("activeItem", "mostRecentlyUsedComposition"):
            item = context.get(key)
            if isinstance(item, Mapping):
                candidates.append(dict(item))
        selection = context.get("selection")
        if isinstance(selection, Mapping) and isinstance(selection.get("items"), list):
            candidates.extend(dict(item) for item in selection["items"] if isinstance(item, Mapping))
        return candidates

    def _find_context_item(self, context: Mapping[str, Any], name: str) -> dict[str, Any]:
        matches = [entry for entry in self._context_candidates(context) if entry.get("name") == name]
        unique: dict[tuple[Any, ...], dict[str, Any]] = {}
        for match in matches:
            locator = _locator(match)
            key = tuple(
                locator.get(field)
                for field in ("kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId")
            )
            unique[key] = match
        _require(
            len(unique) == 1,
            f"project context did not identify exactly one item named {name!r}",
        )
        return next(iter(unique.values()))

    async def _metadata(self, session: PublicSession, locator: Mapping[str, Any]) -> dict[str, Any]:
        payload = await self._call(
            session,
            "ae_getProjectItemMetadata",
            {"item_locator": dict(locator)},
        )
        value = _native_value(payload)
        required = {
            "itemLocator", "name", "type", "parentLocator", "comment", "labelId",
        }
        optional = {"width", "height", "duration", "pixelAspectRatio", "layerCount"}
        _require(
            required <= set(value) and set(value) <= required | optional,
            "project-item metadata shape is not closed",
        )
        item_locator = _locator(value)
        _require(item_locator == dict(locator), "metadata locator did not match the requested item")
        _require(_bounded_unicode(value.get("name"), maximum=1024), "metadata.name is invalid")
        _require(_bounded_unicode(value.get("comment"), maximum=1024), "metadata.comment is invalid")
        _require(isinstance(value.get("type"), str), "metadata.type is invalid")
        _require(
            value["type"] in {"folder", "composition", "footage", "unknown"},
            "metadata.type is invalid",
        )
        _require(
            item_locator["kind"] == ("composition" if value["type"] == "composition" else "item"),
            "metadata type and locator kind disagree",
        )
        _require(isinstance(value.get("labelId"), int), "metadata.labelId is invalid")
        _require(value["labelId"] in range(17), "metadata.labelId is outside 0..16")
        _require(value.get("parentLocator") is None or isinstance(value["parentLocator"], Mapping), "metadata.parentLocator is invalid")
        if isinstance(value.get("parentLocator"), Mapping):
            _locator({"locator": value["parentLocator"]})
        if value["type"] == "composition":
            _require(optional <= set(value), "composition metadata omitted required composition facts")
        else:
            _require("layerCount" not in value, "non-composition metadata exposed layerCount")
        for field in ("width", "height"):
            if field in value:
                _require(
                    isinstance(value[field], int)
                    and not isinstance(value[field], bool)
                    and 1 <= value[field] <= 30_000,
                    f"metadata.{field} is invalid",
                )
        if "layerCount" in value:
            _require(
                isinstance(value["layerCount"], int)
                and not isinstance(value["layerCount"], bool)
                and value["layerCount"] >= 0,
                "metadata.layerCount is invalid",
            )
        if "duration" in value:
            _exact_time(value["duration"], field="metadata.duration")
        if "pixelAspectRatio" in value:
            _exact_ratio(value["pixelAspectRatio"], field="metadata.pixelAspectRatio")
        return value

    async def _settings(self, session: PublicSession, locator: Mapping[str, Any]) -> dict[str, Any]:
        payload = await self._call(
            session,
            "ae_getCompositionSettings",
            {"composition_locator": dict(locator)},
        )
        value = _native_value(payload)
        _require(
            set(value)
            == {
                "compositionLocator", "name", "width", "height", "duration",
                "frameDuration", "frameRate", "pixelAspectRatio", "workArea",
                "displayStartTime", "layerCount",
            },
            "composition settings shape is not closed",
        )
        _locator(value)
        _require(_bounded_unicode(value.get("name"), maximum=1024), "settings.name is invalid")
        for field in ("width", "height", "layerCount"):
            _require(isinstance(value.get(field), int), f"settings.{field} is invalid")
        _exact_time(value.get("duration"), field="settings.duration")
        _exact_time(value.get("frameDuration"), field="settings.frameDuration")
        _exact_time(value.get("displayStartTime"), field="settings.displayStartTime")
        _work_area(value, field="settings")
        _exact_ratio(value.get("frameRate"), field="settings.frameRate")
        _exact_ratio(value.get("pixelAspectRatio"), field="settings.pixelAspectRatio")
        return value

    async def _project_items(self, session: PublicSession) -> dict[str, Any]:
        payload = await self._call(
            session,
            "ae_listProjectItems",
            {"offset": 0, "limit": 50},
        )
        value = _native_value(payload)
        _require(isinstance(value.get("items"), list), "project-items page omitted items")
        _require(isinstance(value.get("total"), int), "project-items page omitted total")
        return value

    async def _state(self, session: PublicSession, name: str) -> CompositionState:
        context = await self._context(session)
        entry = self._find_context_item(context, name)
        locator = _locator(entry)
        metadata = await self._metadata(session, locator)
        settings = await self._settings(session, locator)
        project_items = await self._project_items(session)
        _require(metadata["name"] == name, "context and metadata names disagree")
        _require(settings.get("name") == name, "context and settings names disagree")
        return CompositionState(name, locator, context, metadata, settings, project_items)

    async def _undo(self, operation: str, before: Mapping[str, Any], after: Mapping[str, Any]) -> None:
        await self._checkpoint(
            f"undo-{operation}",
            {
                "operation": operation,
                "instruction": "Execute one real After Effects Undo, then acknowledge this checkpoint.",
                "beforeDigest": _json_hash(before),
                "afterDigest": _json_hash(after),
            },
        )

    async def _exercise_work_area(self, session: PublicSession) -> None:
        before = await self._state(session, self.config.fixture_composition_name)
        before_semantic = _semantic_snapshot(before)
        before_work_area = _work_area(before.settings, field="before")
        before_start = before_work_area["start"]
        before_duration = before_work_area["duration"]
        _require(
            not (
                _same_time(before_start, self.config.work_area_start)
                and _same_time(before_duration, self.config.work_area_duration)
            ),
            "requested work area equals the fixture baseline",
        )
        payload = await self._call(
            session,
            "ae_setCompositionWorkArea",
            {
                "composition_locator": before.locator,
                "start": self.config.work_area_start,
                "duration": self.config.work_area_duration,
                "idempotency_key": self._intent("work-area"),
            },
        )
        result = _native_value(payload)
        _require(result.get("changed") is True, "work-area write did not report changed=true")
        _require(_locator(result) == before.locator, "work-area result locator mismatch")
        result_before = _mapping(result.get("beforeWorkArea"), "work-area result omitted beforeWorkArea")
        result_after = _mapping(result.get("afterWorkArea"), "work-area result omitted afterWorkArea")
        _require(
            _exact_time(result_before.get("start"), field="beforeWorkArea.start") == before_start,
            "work-area result did not bind the previous start",
        )
        _require(
            _exact_time(result_before.get("duration"), field="beforeWorkArea.duration")
            == before_duration,
            "work-area result did not bind the previous duration",
        )
        result_after_start = _exact_time(result_after.get("start"), field="afterWorkArea.start")
        result_after_duration = _exact_time(
            result_after.get("duration"),
            field="afterWorkArea.duration",
        )
        _require(
            _same_time(result_after_start, self.config.work_area_start),
            "work-area result after start disagreed with the request",
        )
        _require(
            _same_time(result_after_duration, self.config.work_area_duration),
            "work-area result after duration disagreed with the request",
        )
        after = await self._state(session, self.config.fixture_composition_name)
        after_semantic = _semantic_snapshot(after)
        after_work_area = _work_area(after.settings, field="after")
        _require(
            _same_time(after_work_area["start"], self.config.work_area_start),
            "work-area start did not match public readback",
        )
        _require(
            _same_time(after_work_area["duration"], self.config.work_area_duration),
            "work-area duration did not match public readback",
        )
        _require_only_semantic_delta(
            before_semantic,
            after_semantic,
            {"settings.workArea.start", "settings.workArea.duration"},
            operation="work-area",
        )
        await self._undo("work-area", before.settings, after.settings)
        restored = await self._state(session, self.config.fixture_composition_name)
        restored_work_area = _work_area(restored.settings, field="restored")
        _require(restored_work_area["start"] == before_start, "Undo did not restore work-area start")
        _require(
            restored_work_area["duration"] == before_duration,
            "Undo did not restore work-area duration",
        )
        _require(
            _semantic_snapshot(restored) == before_semantic,
            "work-area Undo did not restore the complete semantic baseline",
        )

    async def _exercise_rename(self, session: PublicSession) -> None:
        before = await self._state(session, self.config.fixture_composition_name)
        before_semantic = _semantic_snapshot(before)
        payload = await self._call(
            session,
            "ae_renameProjectItem",
            {
                "item_locator": before.locator,
                "name": self.config.renamed_name,
                "idempotency_key": self._intent("rename"),
            },
        )
        result = _native_value(payload)
        _require(result.get("changed") is True, "rename did not report changed=true")
        _require(_locator(result) == before.locator, "rename result locator mismatch")
        _require(result.get("beforeName") == before.metadata["name"], "rename beforeName mismatch")
        _require(result.get("afterName") == self.config.renamed_name, "rename afterName mismatch")
        after = await self._state(session, self.config.renamed_name)
        _require(after.metadata["name"] == self.config.renamed_name, "rename readback disagrees")
        _require_only_semantic_delta(
            before_semantic,
            _semantic_snapshot(after),
            {
                "metadata.name",
                "settings.name",
                "context.activeItem.name",
                "context.mostRecentlyUsedComposition.name",
                "context.selection.items.fixture-source.name",
                "projectItems.items.fixture-source.name",
            },
            operation="rename",
        )
        await self._undo("rename", before.metadata, after.metadata)
        restored = await self._state(session, self.config.fixture_composition_name)
        _require(restored.metadata["name"] == before.metadata["name"], "Undo did not restore name")
        _require(
            _semantic_snapshot(restored) == before_semantic,
            "rename Undo did not restore the complete semantic baseline",
        )

    async def _exercise_comment(self, session: PublicSession) -> None:
        before = await self._state(session, self.config.fixture_composition_name)
        before_semantic = _semantic_snapshot(before)
        _require(before.metadata["comment"] != self.config.comment_value, "comment target equals baseline")
        payload = await self._call(
            session,
            "ae_setProjectItemComment",
            {
                "item_locator": before.locator,
                "comment": self.config.comment_value,
                "idempotency_key": self._intent("comment"),
            },
        )
        result = _native_value(payload)
        _require(result.get("changed") is True, "comment write did not change state")
        _require(_locator(result) == before.locator, "comment result locator mismatch")
        _require(
            result.get("beforeComment") == before.metadata["comment"],
            "comment beforeComment mismatch",
        )
        _require(result.get("afterComment") == self.config.comment_value, "comment afterComment mismatch")
        after = await self._state(session, self.config.fixture_composition_name)
        _require(after.metadata["comment"] == self.config.comment_value, "comment readback disagrees")
        _require_only_semantic_delta(
            before_semantic,
            _semantic_snapshot(after),
            {"metadata.comment"},
            operation="comment",
        )
        await self._undo("comment", before.metadata, after.metadata)
        restored = await self._state(session, self.config.fixture_composition_name)
        _require(restored.metadata["comment"] == before.metadata["comment"], "Undo did not restore comment")
        _require(
            _semantic_snapshot(restored) == before_semantic,
            "comment Undo did not restore the complete semantic baseline",
        )

    async def _exercise_label(self, session: PublicSession) -> None:
        before = await self._state(session, self.config.fixture_composition_name)
        before_semantic = _semantic_snapshot(before)
        _require(before.metadata["labelId"] != self.config.label_id, "label target equals baseline")
        payload = await self._call(
            session,
            "ae_setProjectItemLabel",
            {
                "item_locator": before.locator,
                "label_id": self.config.label_id,
                "idempotency_key": self._intent("label"),
            },
        )
        result = _native_value(payload)
        _require(result.get("changed") is True, "label write did not change state")
        _require(_locator(result) == before.locator, "label result locator mismatch")
        _require(result.get("beforeLabelId") == before.metadata["labelId"], "label beforeLabelId mismatch")
        _require(result.get("afterLabelId") == self.config.label_id, "label afterLabelId mismatch")
        after = await self._state(session, self.config.fixture_composition_name)
        _require(after.metadata["labelId"] == self.config.label_id, "label readback disagrees")
        _require_only_semantic_delta(
            before_semantic,
            _semantic_snapshot(after),
            {"metadata.labelId"},
            operation="label",
        )
        await self._undo("label", before.metadata, after.metadata)
        restored = await self._state(session, self.config.fixture_composition_name)
        _require(restored.metadata["labelId"] == before.metadata["labelId"], "Undo did not restore label")
        _require(
            _semantic_snapshot(restored) == before_semantic,
            "label Undo did not restore the complete semantic baseline",
        )

    async def _exercise_duplicate(self, session: PublicSession) -> None:
        before = await self._state(session, self.config.fixture_composition_name)
        before_semantic = _semantic_snapshot(before)
        payload = await self._call(
            session,
            "ae_duplicateComposition",
            {
                "composition_locator": before.locator,
                "new_name": self.config.duplicate_name,
                "idempotency_key": self._intent("duplicate"),
            },
        )
        result = _native_value(payload)
        _require(result.get("changed") is True, "duplicate did not report changed=true")
        source_locator = _locator(
            {"compositionLocator": result.get("sourceCompositionLocator")}
        )
        _require(
            _same_locator_object(source_locator, before.locator),
            "duplicate source locator no longer identified the source composition",
        )
        new_locator = _locator({"compositionLocator": result.get("newCompositionLocator")})
        _require(
            source_locator["projectId"] == new_locator["projectId"]
            and source_locator["generation"] == new_locator["generation"]
            and source_locator["generation"] > before.locator["generation"],
            "duplicate locators did not share one refreshed project graph",
        )
        _require(
            new_locator["objectId"] != source_locator["objectId"],
            "duplicate reused the source object identity",
        )
        source_settings = _mapping(result.get("sourceSettings"), "duplicate omitted sourceSettings")
        new_settings = _mapping(result.get("newSettings"), "duplicate omitted newSettings")
        _require(
            source_settings == _settings_snapshot(before.settings),
            "duplicate sourceSettings disagreed with the public settings read",
        )
        duplicate_metadata = await self._metadata(session, new_locator)
        duplicate_settings = await self._settings(session, new_locator)
        after_source = await self._state(session, self.config.fixture_composition_name)
        after_project_items = after_source.project_items
        _require(
            after_source.locator == source_locator,
            "duplicate source locator did not match the independently resolved source",
        )
        _require(
            after_source.metadata == {
                **before.metadata,
                "itemLocator": after_source.metadata["itemLocator"],
                "parentLocator": after_source.metadata.get("parentLocator"),
            }
            and _settings_snapshot(after_source.settings) == _settings_snapshot(before.settings),
            "duplicate changed source metadata or settings",
        )
        _require(duplicate_metadata["name"] == self.config.duplicate_name, "duplicate name disagrees")
        _require(
            new_settings == _settings_snapshot(duplicate_settings),
            "duplicate newSettings disagreed with public readback",
        )
        _require(
            _clone_settings_semantics(duplicate_settings)
            == _clone_settings_semantics(before.settings),
            "duplicate settings disagreed with the source composition",
        )
        _require(
            result.get("projectItemCountAfter") == result.get("projectItemCountBefore") + 1,
            "duplicate did not report exactly one new project item",
        )
        _require(
            result.get("projectItemCountBefore") == before.project_items.get("total")
            and result.get("projectItemCountAfter") == after_project_items.get("total"),
            "duplicate counts disagreed with independent project-item reads",
        )
        duplicate_entries = [
            item
            for item in after_project_items["items"]
            if isinstance(item, Mapping)
            and item.get("name") == self.config.duplicate_name
            and _locator(item) == new_locator
        ]
        _require(len(duplicate_entries) == 1, "project-item read did not expose the duplicate")
        duplicate_id = new_locator["objectId"]
        _require_only_semantic_delta(
            before_semantic,
            _semantic_snapshot(after_source),
            {"projectItems.total", f"projectItems.items.{duplicate_id}"},
            operation="duplicate",
        )
        await self._undo("duplicate", before.settings, duplicate_settings)
        await self._call(
            session,
            "ae_getProjectItemMetadata",
            {"item_locator": new_locator},
            expected_error="STALE_LOCATOR",
        )
        restored = await self._state(session, self.config.fixture_composition_name)
        _require(
            restored.project_items.get("total") == before.project_items.get("total"),
            "duplicate Undo did not restore the project-item count",
        )
        _require(
            _semantic_snapshot(restored) == before_semantic,
            "duplicate Undo did not restore the complete semantic baseline",
        )

    async def _restart_gate(self, stale_locator: Mapping[str, Any]) -> None:
        await self._checkpoint(
            "restart-ae",
            {
                "instruction": (
                    "Quit formal After Effects normally, relaunch the exact formal app, "
                    "wait for the canonical plugin/CEP host, reopen the disposable fixture "
                    "if needed, make its source composition active and selected in the "
                    "Project panel, and acknowledge."
                ),
                "expectedSourceCommit": self.config.expected_sha,
            },
        )
        async with self.session_factory() as session:
            self._require_tools(session, full=False)
            await self._pairing_context(session)
            await self._call(
                session,
                "ae_getProjectItemMetadata",
                {"item_locator": dict(stale_locator)},
                expected_error="STALE_LOCATOR",
            )
            fresh = await self._state(session, self.config.fixture_composition_name)
            _require(fresh.locator != dict(stale_locator), "restart reused the old locator")

    @staticmethod
    def _require_tools(session: PublicSession, *, full: bool) -> None:
        required = set(PACKAGE_TOOLS if full else (
            "ae_getProjectContext",
            "ae_getProjectItemMetadata",
            "ae_getCompositionSettings",
            "ae_duplicateComposition",
        ))
        required.update(SUPPORT_TOOLS)
        missing = sorted(required - set(session.tool_names))
        _require(not missing, f"public MCP tools/list omitted required tools: {missing}")

    async def run(self) -> dict[str, Any]:
        full = self.config.mode in {"t5", "t6"}
        self._validate_machine_identity()
        await self._checkpoint(
            "preflight-ae",
            {
                "instruction": (
                    "Open only the disposable #150 fixture in formal After Effects, "
                    "make the named source composition active, select it in the Project "
                    "panel, keep the project at 49 items or fewer, confirm canonical "
                    "plugin/CEP pairing access, and keep the Mac awake."
                ),
                "fixtureCompositionName": self.config.fixture_composition_name,
                "expectedSourceCommit": self.config.expected_sha,
            },
        )
        async with self.session_factory() as session:
            self._require_tools(session, full=full)
            await self._pairing_context(session)
            baseline = await self._state(session, self.config.fixture_composition_name)
            if full:
                await self._exercise_work_area(session)
                await self._exercise_rename(session)
                await self._exercise_comment(session)
                await self._exercise_label(session)
            await self._exercise_duplicate(session)
            stale_locator = (
                (await self._state(session, self.config.fixture_composition_name)).locator
                if full
                else baseline.locator
            )
        if full:
            await self._restart_gate(stale_locator)
        required_covered = set(PACKAGE_TOOLS if full else (
            "ae_getProjectContext",
            "ae_getProjectItemMetadata",
            "ae_getCompositionSettings",
            "ae_duplicateComposition",
        ))
        missing = sorted(required_covered - self._covered_tools)
        _require(not missing, f"acceptance run did not exercise tools: {missing}")
        return {
            "mode": self.config.mode,
            "expectedSourceCommit": self.config.expected_sha,
            "coveredTools": sorted(self._covered_tools),
            "writeCount": 1 if self.config.mode == "t4" else 5,
            "undoCheckpoints": 1 if self.config.mode == "t4" else 5,
            "restartChecked": full,
            "componentHashes": dict(self._component_hashes),
        }


class _LiveSession:
    def __init__(self, session: Any, tool_names: Sequence[str]) -> None:
        self._session = session
        self.tool_names = frozenset(tool_names)

    async def call(self, tool: str, arguments: Mapping[str, Any]) -> tuple[bool, dict[str, Any]]:
        result = await self._session.call_tool(tool, dict(arguments))
        texts = [item.text for item in result.content if getattr(item, "type", None) == "text"]
        _require(len(texts) == 1, f"{tool} did not return exactly one public JSON text block")
        try:
            payload = json.loads(texts[0])
        except (TypeError, ValueError) as error:
            raise AcceptanceFailure(f"{tool} returned non-JSON text") from error
        _require(isinstance(payload, dict), f"{tool} public JSON payload was not an object")
        return bool(result.isError), payload


class LiveSessionFactory:
    def __init__(self, launcher: Path) -> None:
        self.launcher = launcher

    @contextlib.asynccontextmanager
    async def __call__(self) -> AsyncIterator[PublicSession]:
        try:
            from mcp import ClientSession, StdioServerParameters
            from mcp.client.stdio import stdio_client
            from mcp.types import Implementation
        except ImportError as error:  # pragma: no cover - requires packaged runtime
            raise AcceptanceFailure("the tracked driver requires the installed mcp Python package") from error
        _require(self.launcher.is_file(), "stable ae-mcp launcher is missing")
        environment = {
            "AE_MCP_BACKEND": "ae-mcp",
            "AE_MCP_PLUGIN_URL": os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488"),
            "HOME": str(Path.home()),
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
                client_info=Implementation(name="issue150-hardware-acceptance", version="1"),
            ) as session:
                await session.initialize()
                listed = await session.list_tools()
                yield _LiveSession(session, [tool.name for tool in listed.tools])


async def stdin_checkpoint(kind: str, details: Mapping[str, Any]) -> None:
    checkpoint_id = f"{kind}-{secrets.token_hex(6)}"
    prompt = {
        "event": "CHECKPOINT_REQUIRED",
        "checkpointId": checkpoint_id,
        "kind": kind,
        "details": dict(details),
    }
    print(json.dumps(prompt, ensure_ascii=False, separators=(",", ":")), flush=True)
    line = await asyncio.to_thread(sys.stdin.readline)
    if not line:
        raise AcceptanceFailure(f"checkpoint {checkpoint_id} reached EOF")
    try:
        acknowledgement = json.loads(line)
    except ValueError as error:
        raise AcceptanceFailure(f"checkpoint {checkpoint_id} received invalid JSON") from error
    _require(
        isinstance(acknowledgement, Mapping)
        and acknowledgement.get("checkpointId") == checkpoint_id
        and acknowledgement.get("status") == "completed",
        f"checkpoint {checkpoint_id} was not explicitly completed",
    )


def _time_argument(value: str) -> dict[str, int]:
    try:
        numerator, denominator = value.split("/", 1)
        parsed = {"value": int(numerator), "scale": int(denominator)}
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("exact time must be VALUE/SCALE") from error
    if parsed["scale"] <= 0:
        raise argparse.ArgumentTypeError("exact-time scale must be positive")
    return parsed


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", required=True, choices=("t4", "t5", "t6"))
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--fixture-composition-name", required=True)
    parser.add_argument("--renamed-name", required=True)
    parser.add_argument("--duplicate-name", required=True)
    parser.add_argument("--comment-value", required=True)
    parser.add_argument("--label-id", type=int, required=True, choices=range(17))
    parser.add_argument("--work-area-start", type=_time_argument, required=True)
    parser.add_argument("--work-area-duration", type=_time_argument, required=True)
    parser.add_argument("--launcher", type=Path, default=Path.home() / ".ae-mcp" / "bin" / "ae-mcp")
    parser.add_argument("--identity-home", type=Path, default=Path.home())
    parser.add_argument("--native-receipt", type=Path, required=True)
    parser.add_argument("--native-manifest", type=Path)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parsed = parser.parse_args(argv)
    if FULL_SHA.fullmatch(parsed.expected_sha) is None:
        parser.error("--expected-sha must be one full lowercase 40-character Git SHA")
    if parsed.native_manifest is None:
        parser.error("--native-manifest is required for exact component identity")
    if not _bounded_unicode(parsed.fixture_composition_name, maximum=1024):
        parser.error("--fixture-composition-name must contain at most 1024 Unicode scalar values")
    for name in (parsed.renamed_name, parsed.duplicate_name):
        if not _bounded_unicode(name, maximum=255, allow_empty=False):
            parser.error("rename and duplicate target names must contain 1..255 Unicode scalar values")
    if len({parsed.fixture_composition_name, parsed.renamed_name, parsed.duplicate_name}) != 3:
        parser.error("fixture, renamed, and duplicate names must be distinct")
    if not _bounded_unicode(parsed.comment_value, maximum=1024):
        parser.error("--comment-value must contain at most 1024 Unicode scalar values")
    return parsed


async def _main(argv: Sequence[str] | None = None) -> int:
    arguments = parse_args(argv)
    config = RunConfig(
        mode=arguments.mode,
        expected_sha=arguments.expected_sha,
        fixture_composition_name=arguments.fixture_composition_name,
        renamed_name=arguments.renamed_name,
        duplicate_name=arguments.duplicate_name,
        comment_value=arguments.comment_value,
        label_id=arguments.label_id,
        work_area_start=arguments.work_area_start,
        work_area_duration=arguments.work_area_duration,
        identity_home=arguments.identity_home,
        native_receipt=arguments.native_receipt,
        native_manifest=arguments.native_manifest,
    )
    evidence = EvidenceLog(arguments.evidence_dir, mode=config.mode, expected_sha=config.expected_sha)
    acceptance = PackageAcceptance(
        config,
        session_factory=LiveSessionFactory(arguments.launcher),
        checkpoint=stdin_checkpoint,
        evidence=evidence,
    )
    try:
        summary = await acceptance.run()
    except PossiblySideEffectingStop as error:
        evidence.finish(passed=False, details={"stopReason": "possibly-side-effecting", "message": str(error)})
        print(json.dumps({"event": "STOP", "reason": "POSSIBLY_SIDE_EFFECTING_FAILURE"}), flush=True)
        return 3
    except Exception as error:  # noqa: BLE001 - evidence must include terminal state
        evidence.finish(passed=False, details={"stopReason": "failed", "message": str(error)})
        print(json.dumps({"event": "FAIL", "message": str(error)}, ensure_ascii=False), flush=True)
        return 1
    evidence.finish(passed=True, details=summary)
    print(
        json.dumps(
            {
                "event": "PASS",
                "mode": config.mode,
                "sourceCommit": config.expected_sha,
                "summary": str(evidence.summary_path),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
