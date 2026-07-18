#!/usr/bin/env python3
"""Continuous real-AE acceptance orchestrator for capability package #155.

The orchestrator is package-specific and calls only the public MCP surface.  It
never calls Core handlers, the CEP HTTP API, or the native socket directly.

T4 exercises only the new duplicate-layer lifecycle primitive.  T5 and T6
create one deterministic ``ephemeral-validation`` fixture, exercise all eight
package tools, execute a real After Effects Undo after every write, verify the
post-Undo state, then restart formal After Effects and reacquire fresh
locators.  A GUI controller performs checkpoints while this process retains
one continuous evidence stream.

The driver stops immediately on ``POSSIBLY_SIDE_EFFECTING_FAILURE`` and never
blindly retries a write with an uncertain outcome.  It does not create an AEP
while imported or exercised by unit tests.
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
import plistlib
import re
import secrets
import shutil
import stat
import sys
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from pathlib import Path
from typing import Any, Protocol


PACKAGE_ISSUE = 155
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
STRETCH_PERCENT = re.compile(r"^-?(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,6})?$")
UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
PRIVATE_PATH = re.compile(
    r"(?:^|[\s\"'])((?:/Users/|/private/|/var/folders/)[^\s\"']+|"
    r"[A-Za-z]:\\Users\\[^\s\"']+)",
)
SENSITIVE_KEY = re.compile(
    r"(?:token|secret|fingerprint|socket|private.?path|fixture.?path|project.?path|home)",
    re.IGNORECASE,
)

PACKAGE_TOOLS = (
    "ae_getLayerDetails",
    "ae_renameLayer",
    "ae_setLayerRange",
    "ae_setLayerStartTime",
    "ae_setLayerStretch",
    "ae_reorderLayer",
    "ae_setLayerParent",
    "ae_duplicateLayer",
)

WRITE_TOOLS = frozenset(PACKAGE_TOOLS[1:])

SUPPORT_TOOLS = (
    "ae_createComposition",
    "ae_createCompositionLayer",
    "ae_listProjectItems",
    "ae_listCompositionLayers",
    "ae_duplicateComposition",
)

SUPPORT_WRITE_TOOLS = frozenset(
    {"ae_createComposition", "ae_createCompositionLayer", "ae_duplicateComposition"}
)

CAPABILITY_BY_TOOL = {
    "ae_getLayerDetails": "ae.layer.details.read",
    "ae_renameLayer": "ae.layer.name.set",
    "ae_setLayerRange": "ae.layer.range.set",
    "ae_setLayerStartTime": "ae.layer.start-time.set",
    "ae_setLayerStretch": "ae.layer.stretch.set",
    "ae_reorderLayer": "ae.layer.order.set",
    "ae_setLayerParent": "ae.layer.parent.set",
    "ae_duplicateLayer": "ae.layer.duplicate",
    "ae_createComposition": "ae.composition.create",
    "ae_createCompositionLayer": "ae.composition.layer.create",
    "ae_listProjectItems": "ae.project.items.list",
    "ae_listCompositionLayers": "ae.composition.layers.list",
    "ae_duplicateComposition": "ae.composition.duplicate",
}

LAYER_DETAILS_FIELDS = frozenset(
    {
        "layerLocator",
        "compositionLocator",
        "stackIndex",
        "name",
        "type",
        "videoEnabled",
        "isThreeD",
        "locked",
        "parentLocator",
        "sourceItemLocator",
        "inPoint",
        "duration",
        "startTime",
        "stretch",
    }
)

FIXTURE_LAYER_NAMES = ("BG", "Subject", "CTRL", "Child")


class AcceptanceFailure(RuntimeError):
    """The package acceptance contract was not satisfied."""


class PossiblySideEffectingStop(AcceptanceFailure):
    """A write may have occurred; the orchestrator stopped without retrying."""


class PublicSession(Protocol):
    tool_names: frozenset[str]

    async def call(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
        """Return ``(is_error, decoded_public_payload)``."""


SessionFactory = Callable[[], contextlib.AbstractAsyncContextManager[PublicSession]]
CheckpointHandler = Callable[[str, Mapping[str, Any]], Awaitable[None]]


def _require(condition: Any, message: str) -> None:
    if not condition:
        raise AcceptanceFailure(message)


def _mapping(value: Any, message: str) -> dict[str, Any]:
    _require(isinstance(value, Mapping), message)
    return dict(value)


def _bounded_unicode(value: Any, *, maximum: int, allow_empty: bool = True) -> bool:
    return (
        isinstance(value, str)
        and (allow_empty or bool(value))
        and len(value) <= maximum
        and "\x00" not in value
        and not any(0xD800 <= ord(character) <= 0xDFFF for character in value)
    )


def _redact(value: Any, *, key: str = "") -> Any:
    if SENSITIVE_KEY.search(key):
        return "<redacted>"
    if isinstance(value, os.PathLike):
        return _redact(os.fspath(value), key=key)
    if isinstance(value, Mapping):
        return {
            str(member): _redact(item, key=str(member))
            for member, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return PRIVATE_PATH.sub(
            lambda match: match.group(0).replace(match.group(1), "<redacted-path>"),
            value,
        )
    return value


def _json_default(value: Any) -> str:
    if isinstance(value, os.PathLike):
        return os.fsdecode(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _json_hash(value: Any) -> str:
    """Hash this package's integer/string closed JSON contract.

    Every contract key is ASCII, so Python lexical key order is identical to
    RFC 8785 UTF-16 ordering for these values.
    """

    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _error_code(payload: Mapping[str, Any]) -> str | None:
    error = payload.get("error")
    if isinstance(error, Mapping):
        code = error.get("code")
        return code if isinstance(code, str) else None
    return error if isinstance(error, str) else None


def _native_value(payload: Mapping[str, Any]) -> dict[str, Any]:
    return _mapping(payload.get("value"), "public native result omitted value")


def _locator(value: Any, *, kind: str | None = None) -> dict[str, Any]:
    locator = _mapping(value, "locator must be an object")
    _require(
        set(locator)
        == {
            "kind",
            "hostInstanceId",
            "sessionId",
            "projectId",
            "generation",
            "objectId",
        },
        "locator shape is not closed",
    )
    if kind is not None:
        _require(locator.get("kind") == kind, f"locator kind must be {kind}")
    else:
        _require(
            locator.get("kind") in {"project", "item", "composition", "layer"},
            "locator kind is invalid",
        )
    for field in ("hostInstanceId", "sessionId", "projectId", "objectId"):
        _require(
            isinstance(locator.get(field), str) and UUID.fullmatch(locator[field]),
            f"locator.{field} is invalid",
        )
    _require(
        isinstance(locator.get("generation"), int)
        and not isinstance(locator.get("generation"), bool)
        and locator["generation"] > 0,
        "locator generation is invalid",
    )
    return locator


def _nullable_locator(value: Any, *, kind: str) -> dict[str, Any] | None:
    return None if value is None else _locator(value, kind=kind)


def _nullable_locator_kinds(
    value: Any, *, kinds: frozenset[str]
) -> dict[str, Any] | None:
    if value is None:
        return None
    locator = _locator(value)
    _require(locator["kind"] in kinds, f"locator kind must be one of {sorted(kinds)}")
    return locator


def _exact_time(value: Any, *, field: str, positive: bool = False) -> dict[str, Any]:
    result = _mapping(value, f"{field} must be an exact-time object")
    _require(set(result) == {"value", "scale", "secondsRational"}, f"{field} shape is not closed")
    _require(
        isinstance(result.get("value"), int)
        and not isinstance(result["value"], bool)
        and -(2**31) <= result["value"] <= 2**31 - 1,
        f"{field}.value is invalid",
    )
    _require(
        isinstance(result.get("scale"), int)
        and not isinstance(result["scale"], bool)
        and 1 <= result["scale"] <= 2**32 - 1,
        f"{field}.scale is invalid",
    )
    if positive:
        _require(result["value"] > 0, f"{field}.value must be positive")
    divisor = math.gcd(abs(result["value"]), result["scale"])
    numerator = result["value"] // divisor
    denominator = result["scale"] // divisor
    expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
    _require(result.get("secondsRational") == expected, f"{field}.secondsRational is not canonical")
    return result


def _exact_ratio(value: Any, *, field: str) -> dict[str, Any]:
    result = _mapping(value, f"{field} must be an exact-ratio object")
    _require(
        set(result) == {"numerator", "denominator", "rational"},
        f"{field} shape is not closed",
    )
    _require(
        isinstance(result.get("numerator"), int)
        and not isinstance(result["numerator"], bool)
        and -(2**31) <= result["numerator"] <= 2**31 - 1
        and result["numerator"] != 0,
        f"{field}.numerator is invalid",
    )
    _require(
        isinstance(result.get("denominator"), int)
        and not isinstance(result["denominator"], bool)
        and 1 <= result["denominator"] <= 2**31 - 1,
        f"{field}.denominator is invalid",
    )
    divisor = math.gcd(abs(result["numerator"]), result["denominator"])
    numerator = result["numerator"] // divisor
    denominator = result["denominator"] // divisor
    expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
    _require(result.get("rational") == expected, f"{field}.rational is not canonical")
    return result


def _same_time(actual: Mapping[str, Any], requested: Mapping[str, int]) -> bool:
    return (
        isinstance(actual.get("value"), int)
        and isinstance(actual.get("scale"), int)
        and actual["value"] * requested["scale"]
        == requested["value"] * actual["scale"]
    )


def _semantic_locator(value: Any) -> dict[str, str] | None:
    if value is None:
        return None
    locator = _locator(value)
    return {"kind": locator["kind"], "objectId": locator["objectId"]}


def _layer_details(value: Any) -> dict[str, Any]:
    details = _mapping(value, "layer details must be an object")
    _require(set(details) == LAYER_DETAILS_FIELDS, "layer details shape is not closed")
    _locator(details["layerLocator"], kind="layer")
    _locator(details["compositionLocator"], kind="composition")
    _nullable_locator(details["parentLocator"], kind="layer")
    _nullable_locator_kinds(
        details["sourceItemLocator"], kinds=frozenset({"item", "composition"})
    )
    _require(
        isinstance(details["stackIndex"], int)
        and not isinstance(details["stackIndex"], bool)
        and details["stackIndex"] >= 1,
        "layer details stackIndex is invalid",
    )
    _require(_bounded_unicode(details["name"], maximum=255, allow_empty=False), "layer details name is invalid")
    _require(isinstance(details["type"], str) and bool(details["type"]), "layer details type is invalid")
    for field in ("videoEnabled", "isThreeD", "locked"):
        _require(isinstance(details[field], bool), f"layer details {field} must be boolean")
    _exact_time(details["inPoint"], field="layer.inPoint")
    _exact_time(details["duration"], field="layer.duration", positive=True)
    _exact_time(details["startTime"], field="layer.startTime")
    _exact_ratio(details["stretch"], field="layer.stretch")
    return details


def _layer_semantic(details: Mapping[str, Any]) -> dict[str, Any]:
    checked = _layer_details(details)
    return {
        "identity": _semantic_locator(checked["layerLocator"]),
        "composition": _semantic_locator(checked["compositionLocator"]),
        "stackIndex": checked["stackIndex"],
        "name": checked["name"],
        "type": checked["type"],
        "videoEnabled": checked["videoEnabled"],
        "isThreeD": checked["isThreeD"],
        "locked": checked["locked"],
        "parent": _semantic_locator(checked["parentLocator"]),
        "source": _semantic_locator(checked["sourceItemLocator"]),
        "inPoint": checked["inPoint"],
        "duration": checked["duration"],
        "startTime": checked["startTime"],
        "stretch": checked["stretch"],
    }


def _copy_stable_semantics(details: Mapping[str, Any]) -> dict[str, Any]:
    """Fields that AE duplicate must preserve from source to copy."""

    checked = _layer_details(details)
    return {
        "type": checked["type"],
        "videoEnabled": checked["videoEnabled"],
        "isThreeD": checked["isThreeD"],
        "locked": checked["locked"],
        "source": _semantic_locator(checked["sourceItemLocator"]),
        "inPoint": checked["inPoint"],
        "duration": checked["duration"],
        "startTime": checked["startTime"],
        "stretch": checked["stretch"],
        "parent": _semantic_locator(checked["parentLocator"]),
    }


def _stretch_ratio(stretch_percent: str) -> dict[str, Any]:
    try:
        ratio = Fraction(Decimal(stretch_percent)) / 100
    except (InvalidOperation, ValueError, ZeroDivisionError) as error:
        raise AcceptanceFailure("configured stretch percentage is not exact") from error
    _require(ratio.numerator != 0, "configured stretch percentage cannot be zero")
    _require(
        -(2**31) <= ratio.numerator <= 2**31 - 1
        and 1 <= ratio.denominator <= 2**31 - 1,
        "configured stretch percentage cannot be represented by the signed int32 ratio contract",
    )
    rational = (
        str(ratio.numerator)
        if ratio.denominator == 1
        else f"{ratio.numerator}/{ratio.denominator}"
    )
    return {
        "numerator": ratio.numerator,
        "denominator": ratio.denominator,
        "rational": rational,
    }


def _matrix_template() -> dict[str, dict[str, Any]]:
    return {
        tool: {
            "tool": tool,
            "capabilityId": CAPABILITY_BY_TOOL[tool],
            "kind": "write" if tool in WRITE_TOOLS else "read",
            "status": "pending",
            "invocations": 0,
            "beforeSha256": None,
            "afterSha256": None,
            "auditRequestIds": [],
            "undo": {
                "required": tool in WRITE_TOOLS,
                "executed": 0,
                "verified": tool not in WRITE_TOOLS,
            },
            "postUndoSha256": None,
        }
        for tool in PACKAGE_TOOLS
    }


@dataclasses.dataclass(frozen=True)
class EfficiencyCounters:
    included_tools: int = len(PACKAGE_TOOLS)
    review_rounds: int = 0
    candidate_builds: int = 0
    full_ci_runs: int = 0
    t4_runs: int = 0
    candidate_hardware_runs: int = 0
    main_hardware_runs: int = 0
    first_hardware_pass: bool | None = None
    gui_pairing_interruptions: int = 0
    scope_frozen_unix_ms: int | None = None

    def public_dict(self, *, completed_unix_ms: int) -> dict[str, Any]:
        elapsed = None
        if self.scope_frozen_unix_ms is not None:
            elapsed = max(0, completed_unix_ms - self.scope_frozen_unix_ms)
        return {
            "includedTools": self.included_tools,
            "reviewRounds": self.review_rounds,
            "candidateBuilds": self.candidate_builds,
            "fullCiRuns": self.full_ci_runs,
            "t4Runs": self.t4_runs,
            "candidateHardwareRuns": self.candidate_hardware_runs,
            "mainHardwareRuns": self.main_hardware_runs,
            "firstHardwarePass": self.first_hardware_pass,
            "guiPairingInterruptions": self.gui_pairing_interruptions,
            "scopeFreezeToCompletionMs": elapsed,
        }


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


class EvidenceLog:
    """Private append-only transcript, machine summary, and pasteable Markdown."""

    def __init__(self, root: Path, *, mode: str, expected_sha: str) -> None:
        self.root = root
        self.mode = mode
        self.expected_sha = expected_sha
        self.run_id = f"issue155-{mode}-{int(time.time())}-{secrets.token_hex(4)}"
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(root, stat.S_IRWXU)
        self.events_path = root / f"{self.run_id}.ndjson"
        self.summary_path = root / f"{self.run_id}.summary.json"
        self.markdown_path = root / f"{self.run_id}.completion.md"
        self._events = 0

    def record(self, event: str, payload: Mapping[str, Any]) -> None:
        entry = {
            "schemaVersion": 1,
            "packageIssue": PACKAGE_ISSUE,
            "runId": self.run_id,
            "mode": self.mode,
            "event": event,
            "sequence": self._events + 1,
            "recordedAtUnixMs": int(time.time() * 1000),
            "payload": _redact(dict(payload)),
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

    @staticmethod
    def _markdown(summary: Mapping[str, Any]) -> str:
        details = _mapping(summary["details"], "summary details are invalid")
        matrix = _mapping(details["perToolMatrix"], "summary matrix is invalid")
        lines = [
            f"## Issue #{PACKAGE_ISSUE} {summary['mode'].upper()} acceptance",
            "",
            f"- exact source commit: `{summary['expectedSourceCommit']}`",
            f"- passed: `{str(summary['passed']).lower()}`",
            f"- continuous evidence events: `{summary['eventCount']}`",
            f"- evidence SHA-256: `{summary['eventsSha256']}`",
            "- fixture lifecycle: `ephemeral-validation`; one active fixture; no Save As copies",
            "",
            "| Public tool | Status | Calls | Audit requests | Undo |",
            "|---|---:|---:|---:|---:|",
        ]
        for tool in PACKAGE_TOOLS:
            row = _mapping(matrix[tool], f"matrix row {tool} is invalid")
            undo = _mapping(row["undo"], f"matrix undo {tool} is invalid")
            lines.append(
                f"| `{tool}` | {row['status']} | {row['invocations']} | "
                f"{len(row['auditRequestIds'])} | "
                f"{undo['executed']}/{str(undo['verified']).lower()} |"
            )
        efficiency = _mapping(details["efficiency"], "summary efficiency is invalid")
        aep = _mapping(details["aepLifecycle"], "summary AEP counters are invalid")
        lines.extend(
            [
                "",
                "### Efficiency counters",
                "",
                f"- tools: {efficiency['includedTools']}",
                f"- review rounds: {efficiency['reviewRounds']}",
                f"- candidate builds / full CI: {efficiency['candidateBuilds']} / {efficiency['fullCiRuns']}",
                f"- T4 / T5 / T6: {efficiency['t4Runs']} / {efficiency['candidateHardwareRuns']} / {efficiency['mainHardwareRuns']}",
                f"- first hardware pass: {efficiency['firstHardwarePass']}",
                f"- GUI/pairing interruptions: {efficiency['guiPairingInterruptions']}",
                f"- scope-freeze to completion ms: {efficiency['scopeFreezeToCompletionMs']}",
                "",
                "### `.aep` lifecycle",
                "",
                f"- created / canonical / snapshots / archived / unclassified: "
                f"{aep['created']} / {aep['canonicalRetained']} / "
                f"{aep['evidenceSnapshotsRetained']} / {aep['archived']} / {aep['unclassified']}",
                f"- logical moved / physical released bytes: "
                f"{aep['logicalBytesMoved']} / {aep['physicalBytesReleased']}",
                "",
            ]
        )
        return "\n".join(lines)

    def finish(
        self,
        *,
        passed: bool,
        details: Mapping[str, Any],
        efficiency: EfficiencyCounters,
        aep_lifecycle: AepLifecycleCounters,
    ) -> None:
        completed = int(time.time() * 1000)
        merged_details = {
            **dict(details),
            "efficiency": efficiency.public_dict(completed_unix_ms=completed),
            "aepLifecycle": aep_lifecycle.public_dict(),
        }
        summary = {
            "schemaVersion": 1,
            "packageIssue": PACKAGE_ISSUE,
            "runId": self.run_id,
            "mode": self.mode,
            "expectedSourceCommit": self.expected_sha,
            "passed": passed,
            "eventCount": self._events,
            "eventsSha256": (
                hashlib.sha256(self.events_path.read_bytes()).hexdigest()
                if self.events_path.exists()
                else None
            ),
            "details": _redact(merged_details),
        }
        for path, text in (
            (self.summary_path, json.dumps(summary, ensure_ascii=False, indent=2) + "\n"),
            (self.markdown_path, self._markdown(summary)),
        ):
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(text)
            os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


@dataclasses.dataclass(frozen=True)
class RunConfig:
    mode: str
    expected_sha: str
    fixture_name: str = "Issue155 Layer Timeline Fixture"
    renamed_name: str = "Subject Renamed"
    duplicate_name: str = "Subject Copy"
    duplicate_interaction_name: str = "Subject Copy Renamed"
    range_in_point: dict[str, int] = dataclasses.field(
        default_factory=lambda: {"value": 24, "scale": 24}
    )
    range_duration: dict[str, int] = dataclasses.field(
        default_factory=lambda: {"value": 72, "scale": 24}
    )
    start_time: dict[str, int] = dataclasses.field(
        default_factory=lambda: {"value": 12, "scale": 24}
    )
    stretch_percent: str = "150"
    fixture_path: Path | None = None
    recovery_archive_root: Path | None = None
    formal_ae_app: Path | None = None
    expected_ae_bundle_id: str = "com.adobe.AfterEffects.application"
    expected_ae_version: str = "26.3.0"
    expected_ae_build: str = "26.3.0.87"
    expected_ae_host_build: str = "87"
    identity_home: Path | None = None
    native_receipt: Path | None = None
    native_manifest: Path | None = None
    contract_fixture: Path | None = None


@dataclasses.dataclass(frozen=True)
class FixtureState:
    composition_locator: dict[str, Any]
    details_by_id: dict[str, dict[str, Any]]
    role_ids: dict[str, str]

    def details(self, role: str) -> dict[str, Any]:
        object_id = self.role_ids[role]
        _require(object_id in self.details_by_id, f"fixture role {role} is missing")
        return self.details_by_id[object_id]

    def semantics(self) -> dict[str, Any]:
        return {
            role: _layer_semantic(self.details(role))
            for role in sorted(self.role_ids)
        }

    def role_semantics(self) -> dict[str, Any]:
        """Describe AE state without treating graph-local object IDs as durable.

        Graph-invalidating operations may rebind every layer object except an
        identity explicitly preserved by their result.  The fixture's unique
        deterministic names are the stable role anchors for Undo comparison.
        """

        roles_by_id = {object_id: role for role, object_id in self.role_ids.items()}
        result: dict[str, Any] = {}
        for role in sorted(self.role_ids):
            checked = _layer_details(self.details(role))
            parent = checked["parentLocator"]
            parent_role = None
            if parent is not None:
                parent_id = _locator(parent, kind="layer")["objectId"]
                _require(
                    parent_id in roles_by_id,
                    f"fixture role {role!r} has a parent outside the active fixture",
                )
                parent_role = roles_by_id[parent_id]
            source = checked["sourceItemLocator"]
            result[role] = {
                "role": role,
                "stackIndex": checked["stackIndex"],
                "name": checked["name"],
                "type": checked["type"],
                "videoEnabled": checked["videoEnabled"],
                "isThreeD": checked["isThreeD"],
                "locked": checked["locked"],
                "parentRole": parent_role,
                "source": (
                    None
                    if source is None
                    else {"kind": _locator(source)["kind"]}
                ),
                "inPoint": checked["inPoint"],
                "duration": checked["duration"],
                "startTime": checked["startTime"],
                "stretch": checked["stretch"],
            }
        return result


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
        self.matrix = _matrix_template()
        self._covered_tools: set[str] = set()
        self._intent_counter = 0
        self._component_hashes: dict[str, str] = {}
        self._contract_digests: dict[str, str] = {}
        self.aep_lifecycle = AepLifecycleCounters()
        self._formal_ae_identity: dict[str, str] = {}
        self._expected_host_instance_id: str | None = None

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

    @staticmethod
    def _sha256_file(path: Path, label: str) -> str:
        _require(path.is_file() and not path.is_symlink(), f"{label} is not a canonical regular file")
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    @classmethod
    def _validate_declared_sha256s(cls, value: Any, label: str) -> None:
        if isinstance(value, Mapping):
            for field, member in value.items():
                if str(field).endswith("Sha256"):
                    _require(
                        isinstance(member, str) and SHA256.fullmatch(member),
                        f"{label}.{field} is not a full lowercase SHA-256",
                    )
                cls._validate_declared_sha256s(member, f"{label}.{field}")
        elif isinstance(value, list):
            for index, member in enumerate(value):
                cls._validate_declared_sha256s(member, f"{label}[{index}]")

    def _validate_formal_ae_identity(self) -> None:
        application = self.config.formal_ae_app
        _require(application is not None, "formal After Effects application path is required")
        _require(
            application.is_absolute()
            and application.is_dir()
            and not application.is_symlink(),
            "formal After Effects application is missing or non-canonical",
        )
        plist_path = application / "Contents/Info.plist"
        _require(plist_path.is_file() and not plist_path.is_symlink(), "formal AE Info.plist is invalid")
        try:
            info = plistlib.loads(plist_path.read_bytes())
        except (OSError, plistlib.InvalidFileException) as error:
            raise AcceptanceFailure("formal AE Info.plist is unreadable") from error
        _require(
            info.get("CFBundleIdentifier") == self.config.expected_ae_bundle_id,
            "formal AE bundle identifier mismatch",
        )
        _require(
            info.get("CFBundleShortVersionString") == self.config.expected_ae_version,
            "formal AE version mismatch",
        )
        _require(
            info.get("CFBundleVersion") == self.config.expected_ae_build,
            "formal AE build mismatch",
        )
        executable_name = info.get("CFBundleExecutable")
        _require(isinstance(executable_name, str) and bool(executable_name), "formal AE executable name is invalid")
        executable = application / "Contents/MacOS" / executable_name
        executable_hash = self._sha256_file(executable, "formal AE executable")
        self._formal_ae_identity = {
            "applicationPath": str(application),
            "bundleId": self.config.expected_ae_bundle_id,
            "version": self.config.expected_ae_version,
            "build": self.config.expected_ae_build,
            "nativeHostBuild": self.config.expected_ae_host_build,
            "infoPlistSha256": hashlib.sha256(plist_path.read_bytes()).hexdigest(),
            "executableSha256": executable_hash,
        }
        self._component_hashes.update(
            {
                "formalAeInfoPlistSha256": self._formal_ae_identity["infoPlistSha256"],
                "formalAeExecutableSha256": executable_hash,
            }
        )

    def _refresh_native_load_identity(
        self, *, stage: str, previous_instance_id: str | None = None
    ) -> str:
        identity_home = self.config.identity_home
        _require(identity_home is not None, "identity home is required")
        log_path = (
            identity_home
            / "Library/Logs/AfterEffectsMCP/native-plugin-v1.jsonl"
        )
        try:
            info = log_path.lstat()
        except FileNotFoundError as error:
            raise AcceptanceFailure("native load log is missing after formal AE launch") from error
        _require(
            stat.S_ISREG(info.st_mode) and not log_path.is_symlink(),
            "native load log must be a regular non-symlink file",
        )
        if os.name == "posix":
            _require(stat.S_IMODE(info.st_mode) == 0o600, "native load log must use mode 0600")
        _require(0 < info.st_size <= 8 * 1024 * 1024, "native load log is empty or unbounded")
        payload = log_path.read_bytes()
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
        _require(latest is not None, "native load log has no valid load event")
        host = _mapping(latest.get("host"), "native load host identity is invalid")
        instance_id = latest.get("instanceId")
        _require(
            latest.get("schemaVersion") == 1
            and latest.get("provenance") == "native-aegp"
            and latest.get("sourceCommit") == self.config.expected_sha
            and isinstance(instance_id, str)
            and UUID.fullmatch(instance_id),
            "native load event identity mismatch",
        )
        _require(host.get("version") == self.config.expected_ae_version, "native load host version mismatch")
        _require(host.get("build") == self.config.expected_ae_host_build, "native load host build mismatch")
        if previous_instance_id is not None:
            _require(instance_id != previous_instance_id, "formal AE restart reused the native load instance")
        self._expected_host_instance_id = instance_id
        log_hash = hashlib.sha256(payload).hexdigest()
        record_hash = _json_hash(latest)
        title = stage[:1].upper() + stage[1:]
        self._component_hashes[f"nativeLoadLog{title}Sha256"] = log_hash
        self._component_hashes[f"nativeLoadRecord{title}Sha256"] = record_hash
        self.evidence.record(
            "native-load-bound",
            {
                "stage": stage,
                "instanceId": instance_id,
                "sourceCommit": self.config.expected_sha,
                "host": dict(host),
                "logSha256": log_hash,
                "recordSha256": record_hash,
            },
        )
        return instance_id

    def _load_contract_digests(self) -> None:
        path = self.config.contract_fixture
        _require(path is not None, "tracked capabilities fixture is required")
        payload, fixture_hash = self._identity_json(path, "capabilities fixture")
        result = _mapping(_mapping(payload.get("response"), "capabilities response is invalid").get("result"), "capabilities result is invalid")
        items = result.get("items")
        _require(isinstance(items, list), "capabilities items are invalid")
        by_id: dict[str, str] = {}
        for raw in items:
            item = _mapping(raw, "capability descriptor is invalid")
            capability_id = item.get("id")
            digest = item.get("contractDigest")
            if isinstance(capability_id, str) and isinstance(digest, str) and SHA256.fullmatch(digest):
                by_id[capability_id] = digest
        missing = sorted(set(CAPABILITY_BY_TOOL.values()) - set(by_id))
        _require(not missing, f"capabilities fixture omitted required IDs: {missing}")
        self._contract_digests = by_id
        self._component_hashes["capabilitiesFixtureSha256"] = fixture_hash

    def _validate_machine_identity(self) -> None:
        receipt_path = self.config.native_receipt
        manifest_path = self.config.native_manifest
        identity_home = self.config.identity_home
        _require(receipt_path is not None, "native build receipt is required")
        _require(manifest_path is not None, "native plugin manifest is required")
        _require(identity_home is not None, "identity home is required")
        receipt, receipt_hash = self._identity_json(receipt_path, "native build receipt")
        manifest, manifest_hash = self._identity_json(manifest_path, "native plugin manifest")
        self._validate_declared_sha256s(receipt, "nativeReceipt")
        self._validate_declared_sha256s(manifest, "nativeManifest")
        _require(
            receipt.get("sourceCommit") == self.config.expected_sha
            and _mapping(receipt.get("source"), "native receipt source is invalid").get("commit")
            == self.config.expected_sha,
            "native build receipt source commit mismatch",
        )
        artifact = _mapping(manifest.get("artifact"), "native manifest artifact is invalid")
        _require(manifest.get("sourceCommitSha") == self.config.expected_sha, "native manifest source commit mismatch")
        _require(artifact.get("receiptSha256") == receipt_hash, "native manifest receipt hash mismatch")
        for field in ("bundleTreeSha256", "executableSha256", "piplSha256"):
            _require(isinstance(artifact.get(field), str) and SHA256.fullmatch(artifact[field]), f"native manifest {field} is invalid")
        cep_path = identity_home / "Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel/bundle-manifest.json"
        cep, cep_hash = self._identity_json(cep_path, "CEP bundle manifest")
        self._validate_declared_sha256s(cep, "cepManifest")
        _require(cep.get("sourceCommitSha") == self.config.expected_sha, "CEP bundle manifest source commit mismatch")
        current_path = identity_home / ".ae-mcp/runtime/current"
        _require(current_path.is_file() and not current_path.is_symlink(), "runtime current pointer is missing")
        relative = current_path.read_text(encoding="utf-8").strip()
        _require(relative == f"0.9.2-{self.config.expected_sha}/macos-arm64", "runtime current pointer source mismatch")
        record_path = identity_home / ".ae-mcp/runtime" / relative.split("/", 1)[0] / "install-record.json"
        record, record_hash = self._identity_json(record_path, "runtime install record")
        self._validate_declared_sha256s(record, "runtimeInstallRecord")
        _require(
            record.get("relative") == relative
            and record.get("sourceCommitSha") == self.config.expected_sha,
            "runtime current/install record source mismatch",
        )
        runtime_manifest_path = identity_home / ".ae-mcp/runtime" / relative / "runtime-manifest.json"
        runtime_manifest, runtime_manifest_hash = self._identity_json(
            runtime_manifest_path, "installed runtime manifest"
        )
        self._validate_declared_sha256s(runtime_manifest, "runtimeManifest")
        _require(
            record.get("runtimeManifestSha256") == runtime_manifest_hash,
            "runtime install record is not bound to the installed runtime manifest",
        )
        self._component_hashes.update(
            {
                "nativeReceiptSha256": receipt_hash,
                "nativeManifestSha256": manifest_hash,
                "cepManifestSha256": cep_hash,
                "runtimeInstallRecordSha256": record_hash,
                "runtimeManifestFileSha256": runtime_manifest_hash,
                "nativeBundleTreeSha256": artifact["bundleTreeSha256"],
                "nativeExecutableSha256": artifact["executableSha256"],
                "nativePiplSha256": artifact["piplSha256"],
                "runtimeManifestSha256": record.get("runtimeManifestSha256"),
            }
        )
        self._load_contract_digests()
        self._validate_formal_ae_identity()

    def _intent(self, operation: str) -> str:
        self._intent_counter += 1
        digest = hashlib.sha256(
            f"{self.evidence.run_id}:{operation}:{self._intent_counter}".encode()
        ).hexdigest()[:24]
        return f"issue155:{operation}:{digest}"

    def _require_fixture_absent(self) -> None:
        fixture = self.config.fixture_path
        _require(fixture is not None, "exact fixture path is required")
        _require(fixture.is_absolute(), "fixture path must be absolute")
        _require(fixture.suffix.lower() == ".aep", "fixture path must end in .aep")
        _require(
            not os.path.lexists(fixture),
            "exact fixture path already exists; refusing to overwrite user or stale fixture data",
        )

    def _saved_fixture_identity(self) -> tuple[int, str]:
        fixture = self.config.fixture_path
        _require(fixture is not None, "exact fixture path is required")
        try:
            info = fixture.lstat()
        except FileNotFoundError as error:
            raise AcceptanceFailure("preflight did not save the active fixture at the exact path") from error
        _require(stat.S_ISREG(info.st_mode) and not fixture.is_symlink(), "fixture is not a regular non-symlink .aep")
        _require(info.st_size > 0, "saved fixture is empty")
        return info.st_size, self._sha256_file(fixture, "saved fixture")

    @staticmethod
    def _inside(path: Path, root: Path) -> bool:
        return path == root or root in path.parents

    async def _archive_fixture(self) -> dict[str, Any]:
        fixture = self.config.fixture_path
        archive_root = self.config.recovery_archive_root
        identity_home = self.config.identity_home
        _require(fixture is not None, "exact fixture path is required")
        _require(archive_root is not None, "explicit recovery archive root is required")
        _require(identity_home is not None, "identity home is required for scan-root safety")
        resolved_root = archive_root.resolve(strict=False)
        _require(archive_root.is_absolute(), "recovery archive root must be absolute")
        scan_roots = (
            identity_home / "Library/Application Support/Adobe/CEP/extensions",
            identity_home / "Library/Application Support/Adobe/Common/Plug-ins",
            Path("/Library/Application Support/Adobe/CEP/extensions"),
            Path("/Library/Application Support/Adobe/Common/Plug-ins"),
        )
        _require(
            not any(self._inside(resolved_root, root.resolve(strict=False)) for root in scan_roots),
            "recovery archive root must be outside every Adobe plugin scan root",
        )
        await self._checkpoint(
            "archive-fixture",
            {
                "instruction": (
                    "Close the one active ephemeral fixture and quit formal After Effects "
                    "normally, then acknowledge. Do not Save As, delete, or move the file; "
                    "the runner will archive the exact declared path after this checkpoint."
                ),
                "fixturePath": fixture,
                "archiveRoot": archive_root,
                "lifecycle": "ephemeral-validation",
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
                "formalAfterEffects": self._formal_ae_identity,
            },
        )
        size, digest = self._saved_fixture_identity()
        archive_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        _require(not archive_root.is_symlink(), "recovery archive root cannot be a symlink")
        run_directory = archive_root / self.evidence.run_id
        _require(not os.path.lexists(run_directory), "run archive directory already exists")
        run_directory.mkdir(mode=0o700, parents=False, exist_ok=False)
        destination = run_directory / fixture.name
        _require(not os.path.lexists(destination), "fixture archive destination already exists")
        shutil.move(str(fixture), str(destination))
        _require(not os.path.lexists(fixture), "fixture source still exists after archive move")
        archived_size, archived_digest = self._saved_fixture_identity_at(destination)
        _require(
            archived_size == size and archived_digest == digest,
            "archived fixture digest or size mismatch",
        )
        self.aep_lifecycle = AepLifecycleCounters(
            created=1,
            archived=1,
            logical_bytes_moved=size,
            physical_bytes_released=0,
        )
        archived = {
            "lifecycle": "ephemeral-validation",
            "sourceAbsent": True,
            "archivePath": destination,
            "sha256": digest,
            "bytes": size,
        }
        self.evidence.record("fixture-archived", archived)
        return archived

    def _saved_fixture_identity_at(self, path: Path) -> tuple[int, str]:
        try:
            info = path.lstat()
        except FileNotFoundError as error:
            raise AcceptanceFailure("archived fixture is missing") from error
        _require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), "archived fixture is not a regular non-symlink file")
        return info.st_size, self._sha256_file(path, "archived fixture")

    async def _checkpoint(self, kind: str, details: Mapping[str, Any]) -> None:
        self.evidence.record("checkpoint-requested", {"kind": kind, "details": details})
        await self.checkpoint(kind, details)
        self.evidence.record("checkpoint-completed", {"kind": kind})

    def _validate_native_success(self, payload: Mapping[str, Any], tool: str) -> None:
        capability = CAPABILITY_BY_TOOL[tool]
        implementation = _mapping(payload.get("implementation"), f"{tool} omitted implementation")
        provenance = _mapping(payload.get("provenance"), f"{tool} omitted provenance")
        audit = _mapping(payload.get("audit"), f"{tool} omitted audit")
        evidence = _mapping(payload.get("evidence"), f"{tool} omitted evidence")
        postcondition = _mapping(evidence.get("postcondition"), f"{tool} omitted postcondition")
        value = _native_value(payload)
        _require(payload.get("ok") is True, f"{tool} did not report ok=true")
        _require(implementation.get("engine") == "native-aegp", f"{tool} implementation was not native-aegp")
        _require(implementation.get("capabilityId") == capability, f"{tool} capability mismatch")
        _require(implementation.get("capabilityVersion") == 1, f"{tool} capability version mismatch")
        expected_contract = self._contract_digests.get(capability)
        _require(expected_contract is not None, f"{tool} contract was not frozen")
        _require(implementation.get("contractDigest") == expected_contract, f"{tool} contract digest mismatch")
        _require(provenance.get("engine") == "native-aegp", f"{tool} provenance was not native-aegp")
        _require(provenance.get("sourceCommit") == self.config.expected_sha, f"{tool} source commit mismatch")
        _require(
            evidence.get("engine") == "native-aegp"
            and evidence.get("capabilityId") == capability
            and evidence.get("capabilityVersion") == 1,
            f"{tool} evidence identity mismatch",
        )
        _require(
            provenance.get("hostInstanceId") == evidence.get("hostInstanceId")
            and provenance.get("sessionId") == evidence.get("sessionId"),
            f"{tool} provenance/evidence session mismatch",
        )
        _require(
            self._expected_host_instance_id is not None
            and provenance.get("hostInstanceId") == self._expected_host_instance_id,
            f"{tool} public response is not bound to the latest formal AE native load",
        )
        _require(
            audit.get("requestId") == evidence.get("requestId")
            and audit.get("capabilityId") == capability
            and audit.get("contractDigest") == expected_contract,
            f"{tool} audit/evidence binding mismatch",
        )
        digest = _json_hash(
            {"capabilityId": capability, "capabilityVersion": 1, "value": value}
        )
        _require(postcondition.get("verified") is True, f"{tool} postcondition was not verified")
        _require(postcondition.get("algorithm") == "sha256-rfc8785-jcs-v1", f"{tool} postcondition algorithm mismatch")
        _require(postcondition.get("digest") == digest, f"{tool} postcondition digest mismatch")
        _require(audit.get("postconditionDigest") == digest, f"{tool} audit postcondition mismatch")
        _require(audit.get("requestDigest") == evidence.get("requestDigest"), f"{tool} request digest mismatch")
        write = tool in WRITE_TOOLS or tool in SUPPORT_WRITE_TOOLS
        expected_effect = "committed" if write else "none"
        _require(audit.get("effect") == expected_effect and evidence.get("effect") == expected_effect, f"{tool} effect mismatch")
        if write:
            undo = _mapping(evidence.get("undo"), f"{tool} omitted undo evidence")
            _require(undo == {"available": True, "verified": False}, f"{tool} undo evidence mismatch")
            _require(isinstance(payload.get("replayed"), bool), f"{tool} omitted replay status")

    async def _call(
        self,
        session: PublicSession,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        expected_error: str | None = None,
        expected_replayed: bool | None = None,
    ) -> dict[str, Any]:
        self.evidence.record("public-tool-request", {"tool": tool, "arguments": arguments})
        is_error, payload = await session.call(tool, dict(arguments))
        self.evidence.record("public-tool-response", {"tool": tool, "isError": is_error, "payload": payload})
        code = _error_code(payload)
        if code == "POSSIBLY_SIDE_EFFECTING_FAILURE":
            raise PossiblySideEffectingStop(f"{tool} may have changed AE; inspect state and audit before retry")
        if expected_error is not None:
            _require(is_error and payload.get("ok") is False, f"{tool} unexpectedly succeeded")
            _require(code == expected_error, f"{tool} returned {code!r}, expected {expected_error!r}")
            return payload
        _require(not is_error and code is None, f"{tool} failed: {code or payload}")
        self._validate_native_success(payload, tool)
        if expected_replayed is not None:
            _require(payload.get("replayed") is expected_replayed, f"{tool} replay status mismatch")
        if tool in PACKAGE_TOOLS:
            self._covered_tools.add(tool)
            row = self.matrix[tool]
            row["invocations"] += 1
            request_id = _mapping(payload["audit"], f"{tool} audit is invalid")["requestId"]
            if request_id not in row["auditRequestIds"]:
                row["auditRequestIds"].append(request_id)
        return payload

    async def _layer_details_call(
        self, session: PublicSession, locator: Mapping[str, Any]
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        payload = await self._call(session, "ae_getLayerDetails", {"layer_locator": dict(locator)})
        return _layer_details(_native_value(payload)), payload

    async def _project_items(self, session: PublicSession) -> list[dict[str, Any]]:
        payload = await self._call(
            session,
            "ae_listProjectItems",
            {"offset": 0, "limit": 50},
        )
        value = _native_value(payload)
        items = value.get("items")
        _require(isinstance(items, list), "project item list omitted items")
        _require(value.get("hasMore") is False, "fixture project exceeds one bounded item page")
        return [_mapping(item, "project item is invalid") for item in items]

    async def _composition_locator(
        self, session: PublicSession, name: str | None = None
    ) -> dict[str, Any]:
        target = name or self.config.fixture_name
        matches = [
            item for item in await self._project_items(session)
            if item.get("name") == target and item.get("type") == "composition"
        ]
        _require(len(matches) == 1, f"fixture composition {target!r} is not unique")
        candidate = matches[0].get("compositionLocator", matches[0].get("itemLocator"))
        return _locator(candidate, kind="composition")

    async def _list_layers(
        self, session: PublicSession, composition_locator: Mapping[str, Any]
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        payload = await self._call(
            session,
            "ae_listCompositionLayers",
            {"composition_locator": dict(composition_locator), "offset": 0, "limit": 25},
        )
        value = _native_value(payload)
        layers = value.get("layers")
        _require(isinstance(layers, list), "composition layer list omitted layers")
        _require(value.get("hasMore") is False, "fixture composition exceeds one layer page")
        return value, [_mapping(layer, "layer list entry is invalid") for layer in layers]

    async def _fixture_state(
        self,
        session: PublicSession,
        *,
        role_ids: Mapping[str, str] | None = None,
        role_names: Mapping[str, str] | None = None,
    ) -> FixtureState:
        _require(
            role_ids is None or role_names is None,
            "fixture roles must be resolved by IDs or names, not both",
        )
        composition = await self._composition_locator(session)
        _value, entries = await self._list_layers(session, composition)
        details: dict[str, dict[str, Any]] = {}
        names: dict[str, list[str]] = {}
        for entry in entries:
            locator = _locator(entry.get("locator", entry.get("layerLocator")), kind="layer")
            checked, _payload = await self._layer_details_call(session, locator)
            object_id = locator["objectId"]
            details[object_id] = checked
            names.setdefault(checked["name"], []).append(object_id)
        if role_ids is not None:
            roles = dict(role_ids)
            missing_ids = sorted(set(roles.values()) - set(details))
            _require(not missing_ids, f"fixture role IDs are stale or missing: {missing_ids}")
        else:
            expected_names = dict(role_names or {name: name for name in FIXTURE_LAYER_NAMES})
            roles = {}
            for role, expected_name in expected_names.items():
                matches = names.get(expected_name, [])
                _require(
                    len(matches) == 1,
                    f"fixture role {role!r} must resolve to one layer named {expected_name!r}",
                )
                roles[role] = matches[0]
        return FixtureState(composition, details, roles)

    async def _create_fixture(self, session: PublicSession) -> FixtureState:
        create_payload = await self._call(
            session,
            "ae_createComposition",
            {
                "name": self.config.fixture_name,
                "width": 640,
                "height": 360,
                "duration": {"value": 10, "scale": 1},
                "frame_rate": {"numerator": 24, "denominator": 1},
                "pixel_aspect_ratio": {"numerator": 1, "denominator": 1},
                "idempotency_key": self._intent("fixture-composition"),
            },
            expected_replayed=False,
        )
        composition = _locator(_native_value(create_payload)["compositionLocator"], kind="composition")
        specs = (
            ("BG", "solid", {"red": 32, "green": 48, "blue": 64, "alpha": 255}),
            ("Subject", "solid", {"red": 200, "green": 120, "blue": 80, "alpha": 255}),
            ("CTRL", "null", None),
            ("Child", "solid", {"red": 80, "green": 180, "blue": 120, "alpha": 255}),
        )
        for name, kind, color in specs:
            arguments: dict[str, Any] = {
                "composition_locator": composition,
                "kind": kind,
                "name": name,
                "idempotency_key": self._intent(f"fixture-layer-{name.lower()}"),
            }
            if color is not None:
                arguments.update(
                    {
                        "color": color,
                        "width": 640,
                        "height": 360,
                        "duration": {"value": 10, "scale": 1},
                    }
                )
            layer_payload = await self._call(
                session,
                "ae_createCompositionLayer",
                arguments,
                expected_replayed=False,
            )
            composition = _locator(
                _native_value(layer_payload)["compositionLocator"], kind="composition"
            )
        fixture = await self._fixture_state(session)
        _require(len(fixture.details_by_id) == 4, "fixture must contain exactly four layers")
        self.evidence.record(
            "fixture-created",
            {
                "fixtureId": self.config.fixture_name,
                "lifecycle": "ephemeral-validation",
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
                "rebuildRecipe": {
                    "composition": {"width": 640, "height": 360, "duration": "10"},
                    "layers": list(FIXTURE_LAYER_NAMES),
                },
                "baselineSha256": _json_hash(fixture.semantics()),
            },
        )
        return fixture

    def _matrix_read(self, payload: Mapping[str, Any], details: Mapping[str, Any]) -> None:
        row = self.matrix["ae_getLayerDetails"]
        row["status"] = "passed"
        digest = _json_hash(_layer_semantic(details))
        row["beforeSha256"] = digest
        row["afterSha256"] = digest
        row["postUndoSha256"] = digest

    def _matrix_write(
        self,
        tool: str,
        payload: Mapping[str, Any],
        *,
        before: Any,
        after: Any,
        post_undo: Any,
    ) -> None:
        row = self.matrix[tool]
        row["status"] = "passed"
        row["beforeSha256"] = _json_hash(before)
        row["afterSha256"] = _json_hash(after)
        row["postUndoSha256"] = _json_hash(post_undo)
        undo = _mapping(row["undo"], f"{tool} matrix undo is invalid")
        undo["executed"] += 1
        undo["verified"] = True
        row["undo"] = undo

    async def _undo(
        self,
        operation: str,
        *,
        before: Any,
        after: Any,
    ) -> None:
        await self._checkpoint(
            f"undo-{operation}",
            {
                "instruction": (
                    "Execute exactly one real After Effects Undo in the active "
                    "ephemeral fixture, then acknowledge without saving another copy."
                ),
                "beforeSha256": _json_hash(before),
                "afterSha256": _json_hash(after),
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
            },
        )

    async def _exercise_details(self, session: PublicSession, fixture: FixtureState) -> None:
        details, payload = await self._layer_details_call(
            session, fixture.details("Subject")["layerLocator"]
        )
        _require(
            details["layerLocator"]["objectId"] == fixture.role_ids["Subject"],
            "layer details returned the wrong identity",
        )
        self._matrix_read(payload, details)

    async def _exercise_rename(
        self,
        session: PublicSession,
        role_ids: Mapping[str, str],
        *,
        role: str,
        new_name: str,
        operation: str,
    ) -> FixtureState:
        before_state = await self._fixture_state(session, role_ids=role_ids)
        before = _layer_semantic(before_state.details(role))
        payload = await self._call(
            session,
            "ae_renameLayer",
            {
                "layer_locator": before_state.details(role)["layerLocator"],
                "name": new_name,
                "idempotency_key": self._intent(operation),
            },
            expected_replayed=False,
        )
        value = _native_value(payload)
        _require(value.get("changed") is True, "rename did not report changed=true")
        _require(value.get("beforeName") == before["name"] and value.get("afterName") == new_name, "rename result mismatch")
        after_state = await self._fixture_state(session, role_ids=role_ids)
        after = _layer_semantic(after_state.details(role))
        _require(after["name"] == new_name, "rename readback mismatch")
        await self._undo(operation, before=before, after=after)
        restored = await self._fixture_state(session, role_ids=role_ids)
        post_undo = _layer_semantic(restored.details(role))
        _require(post_undo == before, "rename Undo did not restore complete layer semantics")
        self._matrix_write("ae_renameLayer", payload, before=before, after=after, post_undo=post_undo)
        return restored

    async def _exercise_range(
        self, session: PublicSession, role_ids: Mapping[str, str]
    ) -> FixtureState:
        before_state = await self._fixture_state(session, role_ids=role_ids)
        before = _layer_semantic(before_state.details("BG"))
        payload = await self._call(
            session,
            "ae_setLayerRange",
            {
                "layer_locator": before_state.details("BG")["layerLocator"],
                "in_point": self.config.range_in_point,
                "duration": self.config.range_duration,
                "idempotency_key": self._intent("range"),
            },
            expected_replayed=False,
        )
        value = _native_value(payload)
        _require(value.get("changed") is True, "range write did not report changed=true")
        after_state = await self._fixture_state(session, role_ids=role_ids)
        after = _layer_semantic(after_state.details("BG"))
        _require(_same_time(after["inPoint"], self.config.range_in_point), "range in-point readback mismatch")
        _require(_same_time(after["duration"], self.config.range_duration), "range duration readback mismatch")
        _require(value.get("beforeInPoint") == before["inPoint"] and value.get("beforeDuration") == before["duration"], "range before result mismatch")
        _require(value.get("afterInPoint") == after["inPoint"] and value.get("afterDuration") == after["duration"], "range after result mismatch")
        await self._undo("range", before=before, after=after)
        restored = await self._fixture_state(session, role_ids=role_ids)
        post_undo = _layer_semantic(restored.details("BG"))
        _require(post_undo == before, "range Undo did not restore complete layer semantics")
        self._matrix_write("ae_setLayerRange", payload, before=before, after=after, post_undo=post_undo)
        return restored

    async def _exercise_start_time(
        self, session: PublicSession, role_ids: Mapping[str, str]
    ) -> FixtureState:
        before_state = await self._fixture_state(session, role_ids=role_ids)
        before = _layer_semantic(before_state.details("Subject"))
        payload = await self._call(
            session,
            "ae_setLayerStartTime",
            {
                "layer_locator": before_state.details("Subject")["layerLocator"],
                "start_time": self.config.start_time,
                "idempotency_key": self._intent("start-time"),
            },
            expected_replayed=False,
        )
        value = _native_value(payload)
        _require(value.get("changed") is True, "start-time write did not report changed=true")
        after_state = await self._fixture_state(session, role_ids=role_ids)
        after = _layer_semantic(after_state.details("Subject"))
        _require(_same_time(after["startTime"], self.config.start_time), "start-time readback mismatch")
        _require(value.get("beforeStartTime") == before["startTime"] and value.get("afterStartTime") == after["startTime"], "start-time result mismatch")
        await self._undo("start-time", before=before, after=after)
        restored = await self._fixture_state(session, role_ids=role_ids)
        post_undo = _layer_semantic(restored.details("Subject"))
        _require(post_undo == before, "start-time Undo did not restore complete layer semantics")
        self._matrix_write("ae_setLayerStartTime", payload, before=before, after=after, post_undo=post_undo)
        return restored

    async def _exercise_stretch(
        self, session: PublicSession, role_ids: Mapping[str, str]
    ) -> FixtureState:
        before_state = await self._fixture_state(session, role_ids=role_ids)
        before = _layer_semantic(before_state.details("Subject"))
        payload = await self._call(
            session,
            "ae_setLayerStretch",
            {
                "layer_locator": before_state.details("Subject")["layerLocator"],
                "stretch_percent": self.config.stretch_percent,
                "idempotency_key": self._intent("stretch"),
            },
            expected_replayed=False,
        )
        value = _native_value(payload)
        _require(value.get("changed") is True, "stretch write did not report changed=true")
        after_state = await self._fixture_state(session, role_ids=role_ids)
        after = _layer_semantic(after_state.details("Subject"))
        expected_stretch = _stretch_ratio(self.config.stretch_percent)
        _require(
            after["stretch"] == expected_stretch,
            "configured exact stretch percentage did not read back as its reduced ratio",
        )
        _require(value.get("beforeStretch") == before["stretch"] and value.get("afterStretch") == after["stretch"], "stretch result mismatch")
        await self._undo("stretch", before=before, after=after)
        restored = await self._fixture_state(session, role_ids=role_ids)
        post_undo = _layer_semantic(restored.details("Subject"))
        _require(post_undo == before, "stretch Undo did not restore complete layer semantics")
        self._matrix_write("ae_setLayerStretch", payload, before=before, after=after, post_undo=post_undo)
        return restored

    async def _exercise_reorder(
        self,
        session: PublicSession,
        role_ids: Mapping[str, str],
        *,
        role: str,
        operation: str,
    ) -> FixtureState:
        before_state = await self._fixture_state(session, role_ids=role_ids)
        before = before_state.semantics()
        current = before_state.details(role)["stackIndex"]
        target = 2 if current != 2 else 3
        payload = await self._call(
            session,
            "ae_reorderLayer",
            {
                "layer_locator": before_state.details(role)["layerLocator"],
                "target_stack_index": target,
                "idempotency_key": self._intent(operation),
            },
            expected_replayed=False,
        )
        value = _native_value(payload)
        _require(value.get("changed") is True, "reorder did not report changed=true")
        _require(value.get("beforeStackIndex") == current and value.get("afterStackIndex") == target, "reorder result mismatch")
        after_state = await self._fixture_state(session, role_ids=role_ids)
        after = after_state.semantics()
        _require(after_state.details(role)["stackIndex"] == target, "reorder readback mismatch")
        await self._undo(operation, before=before, after=after)
        restored = await self._fixture_state(session, role_ids=role_ids)
        post_undo = restored.semantics()
        _require(post_undo == before, "reorder Undo did not restore complete fixture semantics")
        self._matrix_write("ae_reorderLayer", payload, before=before, after=after, post_undo=post_undo)
        return restored

    async def _exercise_parent(
        self, session: PublicSession, role_ids: Mapping[str, str]
    ) -> FixtureState:
        before_state = await self._fixture_state(session, role_ids=role_ids)
        before = before_state.semantics()
        payload = await self._call(
            session,
            "ae_setLayerParent",
            {
                "layer_locator": before_state.details("Child")["layerLocator"],
                "parent_layer_locator": before_state.details("CTRL")["layerLocator"],
                "idempotency_key": self._intent("parent"),
            },
            expected_replayed=False,
        )
        value = _native_value(payload)
        _require(value.get("changed") is True, "parent write did not report changed=true")
        after_state = await self._fixture_state(session, role_ids=role_ids)
        after = after_state.semantics()
        _require(after["Child"]["parent"] == after["CTRL"]["identity"], "parent readback mismatch")
        _require(value.get("beforeParentLocator") is None, "parent baseline was not unparented")
        _require(_semantic_locator(value.get("afterParentLocator")) == after["CTRL"]["identity"], "parent result mismatch")
        await self._undo("parent", before=before, after=after)
        restored = await self._fixture_state(session, role_ids=role_ids)
        post_undo = restored.semantics()
        _require(post_undo == before, "parent Undo did not restore complete fixture semantics")
        self._matrix_write("ae_setLayerParent", payload, before=before, after=after, post_undo=post_undo)
        return restored

    async def _exercise_duplicate(
        self,
        session: PublicSession,
        role_ids: Mapping[str, str],
        *,
        interactions: bool,
    ) -> FixtureState:
        before_state = await self._fixture_state(session, role_ids=role_ids)
        before = before_state.role_semantics()
        source_locator = dict(before_state.details("Subject")["layerLocator"])
        arguments = {
            "layer_locator": source_locator,
            "new_name": self.config.duplicate_name,
            "idempotency_key": self._intent("duplicate"),
        }
        payload = await self._call(
            session,
            "ae_duplicateLayer",
            arguments,
            expected_replayed=False,
        )
        value = _native_value(payload)
        _require(value.get("changed") is True, "duplicate did not report changed=true")
        fresh_source = _locator(value.get("sourceLayerLocator"), kind="layer")
        new_locator = _locator(value.get("newLayerLocator"), kind="layer")
        _locator(value.get("compositionLocator"), kind="composition")
        new_details = _layer_details(value.get("newLayer"))
        _require(new_details["layerLocator"] == new_locator, "duplicate nested layer locator mismatch")
        _require(new_details["name"] == self.config.duplicate_name, "duplicate name mismatch")
        _require(new_locator["objectId"] != fresh_source["objectId"], "duplicate reused source identity")
        _require(
            fresh_source["objectId"] == source_locator["objectId"],
            "duplicate did not preserve its explicitly returned source object identity",
        )
        fresh_source_details, _fresh_source_payload = await self._layer_details_call(
            session, fresh_source
        )
        _require(
            _copy_stable_semantics(new_details)
            == _copy_stable_semantics(fresh_source_details),
            "duplicate copy does not preserve source stable semantics",
        )
        _require(value.get("layerCountAfter") == value.get("layerCountBefore") + 1, "duplicate count mismatch")
        await self._call(
            session,
            "ae_getLayerDetails",
            {"layer_locator": source_locator},
            expected_error="STALE_LOCATOR",
        )
        replay = await self._call(
            session,
            "ae_duplicateLayer",
            arguments,
            expected_replayed=True,
        )
        _require(_native_value(replay).get("newLayerLocator", {}).get("objectId") == new_locator["objectId"], "duplicate replay rebound to the wrong copy")
        after_state = await self._fixture_state(
            session,
            role_names={
                **{name: name for name in FIXTURE_LAYER_NAMES},
                "Copy": self.config.duplicate_name,
            },
        )
        _require(
            after_state.role_ids["Subject"] == fresh_source["objectId"],
            "duplicate source did not resolve to the returned fresh source locator",
        )
        _require(
            after_state.role_ids["Copy"] == new_locator["objectId"],
            "duplicate copy did not resolve to the returned new locator",
        )
        extended_roles = after_state.role_ids
        after = after_state.role_semantics()
        _require(len(after_state.details_by_id) == len(before_state.details_by_id) + 1, "duplicate created the wrong number of layers")
        if interactions:
            after_state = await self._exercise_rename(
                session,
                extended_roles,
                role="Copy",
                new_name=self.config.duplicate_interaction_name,
                operation="duplicate-copy-rename",
            )
            after_state = await self._exercise_reorder(
                session,
                extended_roles,
                role="Copy",
                operation="duplicate-copy-reorder",
            )
            after = after_state.role_semantics()
        await self._undo("duplicate", before=before, after=after)
        restored = await self._fixture_state(session)
        post_undo = restored.role_semantics()
        _require(post_undo == before, "duplicate Undo did not restore complete fixture semantics")
        await self._call(
            session,
            "ae_getLayerDetails",
            {"layer_locator": new_locator},
            expected_error="STALE_LOCATOR",
        )
        self._matrix_write("ae_duplicateLayer", payload, before=before, after=after, post_undo=post_undo)
        return restored

    async def _negative_guards(
        self, session: PublicSession, role_ids: Mapping[str, str]
    ) -> None:
        state = await self._fixture_state(session, role_ids=role_ids)
        baseline = state.semantics()
        child = state.details("Child")["layerLocator"]
        await self._call(
            session,
            "ae_setLayerParent",
            {
                "layer_locator": child,
                "parent_layer_locator": child,
                "idempotency_key": self._intent("self-parent-negative"),
            },
            expected_error="INVALID_ARGUMENT",
        )
        await self._call(
            session,
            "ae_setLayerRange",
            {
                "layer_locator": state.details("BG")["layerLocator"],
                "in_point": {"value": 0, "scale": 1},
                "duration": {"value": 0, "scale": 1},
                "idempotency_key": self._intent("invalid-range-negative"),
            },
            expected_error="INVALID_ARGUMENT",
        )
        await self._call(
            session,
            "ae_setLayerStretch",
            {
                "layer_locator": state.details("Subject")["layerLocator"],
                "stretch_percent": "0",
                "idempotency_key": self._intent("invalid-stretch-negative"),
            },
            expected_error="INVALID_ARGUMENT",
        )
        unchanged = await self._fixture_state(session, role_ids=role_ids)
        _require(unchanged.semantics() == baseline, "negative argument checks changed fixture state")

    async def _cross_composition_parent_guard(
        self, session: PublicSession, role_ids: Mapping[str, str]
    ) -> FixtureState:
        state = await self._fixture_state(session, role_ids=role_ids)
        baseline = state.role_semantics()
        duplicate_name = f"{self.config.fixture_name} Cross Parent Witness"
        witness_payload = await self._call(
            session,
            "ae_duplicateComposition",
            {
                "composition_locator": state.composition_locator,
                "new_name": duplicate_name,
                "idempotency_key": self._intent("cross-parent-witness"),
            },
            expected_replayed=False,
        )
        witness_locator = _locator(
            _native_value(witness_payload)["newCompositionLocator"], kind="composition"
        )
        _witness_value, witness_layers = await self._list_layers(session, witness_locator)
        witness_ctrl = next(
            _locator(entry.get("locator", entry.get("layerLocator")), kind="layer")
            for entry in witness_layers
            if entry.get("name") == "CTRL"
        )
        refreshed = await self._fixture_state(session)
        await self._call(
            session,
            "ae_setLayerParent",
            {
                "layer_locator": refreshed.details("Child")["layerLocator"],
                "parent_layer_locator": witness_ctrl,
                "idempotency_key": self._intent("cross-parent-negative"),
            },
            expected_error="PRECONDITION_FAILED",
        )
        await self._undo("cross-composition-witness", before=baseline, after={"witness": duplicate_name})
        restored = await self._fixture_state(session)
        _require(restored.role_semantics() == baseline, "cross-composition witness Undo did not restore baseline")
        matches = [item for item in await self._project_items(session) if item.get("name") == duplicate_name]
        _require(not matches, "cross-composition witness still exists after Undo")
        return restored

    async def _restart_gate(
        self,
        stale_locator: Mapping[str, Any],
        expected_baseline: Mapping[str, Any],
    ) -> None:
        await self._checkpoint(
            "restart-ae",
            {
                "instruction": (
                    "Save the one active ephemeral fixture in place at its exact declared "
                    "path, quit formal After Effects normally, relaunch only the explicit "
                    "formal application path, reopen that exact fixture, pair once, and "
                    "acknowledge. Do not use Save As or Finder/LaunchServices."
                ),
                "fixturePath": self.config.fixture_path,
                "lifecycle": "ephemeral-validation",
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
                "expectedSourceCommit": self.config.expected_sha,
                "formalAfterEffects": self._formal_ae_identity,
            },
        )
        previous_instance_id = self._expected_host_instance_id
        _require(previous_instance_id is not None, "initial native load identity was not established")
        restarted_instance_id = self._refresh_native_load_identity(
            stage="restart", previous_instance_id=previous_instance_id
        )
        async with self.session_factory() as session:
            self._require_tools(session, full=True)
            await self._call(
                session,
                "ae_getLayerDetails",
                {"layer_locator": dict(stale_locator)},
                expected_error="STALE_LOCATOR",
            )
            fresh = await self._fixture_state(session)
            fresh_locator = fresh.details("Subject")["layerLocator"]
            _require(
                fresh_locator["hostInstanceId"] != stale_locator.get("hostInstanceId"),
                "AE restart did not change the native host instance",
            )
            _require(
                fresh_locator["hostInstanceId"] == restarted_instance_id,
                "restart public response did not match the latest native load instance",
            )
            _require(
                fresh_locator["sessionId"] != stale_locator.get("sessionId"),
                "AE restart did not change the native session",
            )
            _require(
                fresh.role_semantics() == expected_baseline,
                "AE restart changed the verified post-Undo fixture baseline",
            )

    @staticmethod
    def _require_tools(session: PublicSession, *, full: bool) -> None:
        package = set(PACKAGE_TOOLS if full else ("ae_getLayerDetails", "ae_duplicateLayer"))
        required = package | set(SUPPORT_TOOLS)
        missing = sorted(required - set(session.tool_names))
        _require(not missing, f"public MCP tools/list omitted required tools: {missing}")

    async def run(self) -> dict[str, Any]:
        full = self.config.mode in {"t5", "t6"}
        self._require_fixture_absent()
        self._validate_machine_identity()
        await self._checkpoint(
            "preflight-ae",
            {
                "instruction": (
                    "Launch only formal After Effects by its explicit application path, use "
                    "a new empty unsaved disposable project with no user work, prepare "
                    "canonical plugin/CEP pairing, GUI access, and no-sleep, then acknowledge. "
                    "Do not save yet, create or open another fixture, or use Save As."
                ),
                "fixturePath": self.config.fixture_path,
                "lifecycle": "ephemeral-validation",
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
                "expectedSourceCommit": self.config.expected_sha,
                "formalAfterEffects": self._formal_ae_identity,
            },
        )
        self._refresh_native_load_identity(stage="initial")
        async with self.session_factory() as session:
            self._require_tools(session, full=full)
            initial_items = await self._project_items(session)
            _require(
                not initial_items,
                "active project is not empty; refusing to run fixture support writes",
            )
            await self._checkpoint(
                "save-fixture",
                {
                    "instruction": (
                        "The public project inventory is empty. Save this one active project "
                        "for the first time at the exact declared fixture path, then acknowledge. "
                        "Do not use Save As or create another project."
                    ),
                    "fixturePath": self.config.fixture_path,
                    "lifecycle": "ephemeral-validation",
                    "activeFixtureCount": 1,
                    "saveAsCopies": 0,
                    "formalAfterEffects": self._formal_ae_identity,
                },
            )
            fixture_bytes, fixture_digest = self._saved_fixture_identity()
            self.aep_lifecycle = AepLifecycleCounters(created=1)
            self.evidence.record(
                "fixture-saved",
                {
                    "fixturePath": self.config.fixture_path,
                    "lifecycle": "ephemeral-validation",
                    "bytes": fixture_bytes,
                    "sha256": fixture_digest,
                    "activeFixtureCount": 1,
                    "saveAsCopies": 0,
                },
            )
            fixture = await self._create_fixture(session)
            role_ids = fixture.role_ids
            await self._exercise_details(session, fixture)
            if full:
                await self._exercise_rename(
                    session,
                    role_ids,
                    role="Subject",
                    new_name=self.config.renamed_name,
                    operation="rename",
                )
                await self._exercise_range(session, role_ids)
                await self._exercise_start_time(session, role_ids)
                await self._exercise_stretch(session, role_ids)
                await self._exercise_reorder(
                    session,
                    role_ids,
                    role="BG",
                    operation="reorder",
                )
                await self._exercise_parent(session, role_ids)
                await self._negative_guards(session, role_ids)
                role_ids = (
                    await self._cross_composition_parent_guard(session, role_ids)
                ).role_ids
            restored = await self._exercise_duplicate(
                session,
                role_ids,
                interactions=full,
            )
            role_ids = restored.role_ids
            stale_locator = dict(restored.details("Subject")["layerLocator"])
            final_baseline = restored.role_semantics()
        if full:
            await self._restart_gate(stale_locator, final_baseline)
        required = set(PACKAGE_TOOLS if full else ("ae_getLayerDetails", "ae_duplicateLayer"))
        missing = sorted(required - self._covered_tools)
        _require(not missing, f"acceptance run did not exercise tools: {missing}")
        if full:
            incomplete = sorted(
                tool for tool in PACKAGE_TOOLS
                if self.matrix[tool]["status"] != "passed"
                or (tool in WRITE_TOOLS and not self.matrix[tool]["undo"]["verified"])
            )
            _require(not incomplete, f"package matrix is incomplete: {incomplete}")
        archived_fixture = await self._archive_fixture()
        return {
            "mode": self.config.mode,
            "expectedSourceCommit": self.config.expected_sha,
            "coveredTools": sorted(self._covered_tools),
            "writeCount": 1 if self.config.mode == "t4" else len(WRITE_TOOLS),
            "undoVerifiedTools": (
                ["ae_duplicateLayer"]
                if self.config.mode == "t4"
                else sorted(WRITE_TOOLS)
            ),
            "restartChecked": full,
            "finalBaselineSha256": _json_hash(final_baseline),
            "componentHashes": dict(self._component_hashes),
            "perToolMatrix": self.matrix,
            "fixture": {
                "id": self.config.fixture_name,
                "lifecycle": "ephemeral-validation",
                "activeFixtureCount": 0,
                "saveAsCopies": 0,
                "layers": list(FIXTURE_LAYER_NAMES),
                "archived": archived_fixture,
            },
        }


class _LiveSession:
    def __init__(self, session: Any, tool_names: Sequence[str]) -> None:
        self._session = session
        self.tool_names = frozenset(tool_names)

    async def call(
        self, tool: str, arguments: Mapping[str, Any]
    ) -> tuple[bool, dict[str, Any]]:
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
        except ImportError as error:  # pragma: no cover - packaged runtime only
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
                client_info=Implementation(name="issue155-hardware-acceptance", version="1"),
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
    parser.add_argument("--fixture-name", default="Issue155 Layer Timeline Fixture")
    parser.add_argument("--fixture-path", type=Path, required=True)
    parser.add_argument("--recovery-archive-root", type=Path, required=True)
    parser.add_argument(
        "--formal-ae-app",
        type=Path,
        default=Path("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"),
    )
    parser.add_argument("--expected-ae-bundle-id", default="com.adobe.AfterEffects.application")
    parser.add_argument("--expected-ae-version", default="26.3.0")
    parser.add_argument("--expected-ae-build", default="26.3.0.87")
    parser.add_argument("--expected-ae-host-build", default="87")
    parser.add_argument("--renamed-name", default="Subject Renamed")
    parser.add_argument("--duplicate-name", default="Subject Copy")
    parser.add_argument("--duplicate-interaction-name", default="Subject Copy Renamed")
    parser.add_argument("--range-in-point", type=_time_argument, default={"value": 24, "scale": 24})
    parser.add_argument("--range-duration", type=_time_argument, default={"value": 72, "scale": 24})
    parser.add_argument("--start-time", type=_time_argument, default={"value": 12, "scale": 24})
    parser.add_argument("--stretch-percent", default="150")
    parser.add_argument("--launcher", type=Path, default=Path.home() / ".ae-mcp/bin/ae-mcp")
    parser.add_argument("--identity-home", type=Path, default=Path.home())
    parser.add_argument("--native-receipt", type=Path, required=True)
    parser.add_argument("--native-manifest", type=Path, required=True)
    parser.add_argument(
        "--contract-fixture",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "native/ae-plugin/protocol/fixtures/capabilities.json",
    )
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--review-rounds", type=int, default=0)
    parser.add_argument("--candidate-builds", type=int, default=0)
    parser.add_argument("--full-ci-runs", type=int, default=0)
    parser.add_argument("--t4-runs", type=int, default=0)
    parser.add_argument("--candidate-hardware-runs", type=int, default=0)
    parser.add_argument("--main-hardware-runs", type=int, default=0)
    parser.add_argument("--first-hardware-pass", choices=("true", "false", "unknown"), default="unknown")
    parser.add_argument("--gui-pairing-interruptions", type=int, default=0)
    parser.add_argument("--scope-frozen-unix-ms", type=int)
    parsed = parser.parse_args(argv)
    if FULL_SHA.fullmatch(parsed.expected_sha) is None:
        parser.error("--expected-sha must be one full lowercase 40-character Git SHA")
    for name in (
        parsed.fixture_name,
        parsed.renamed_name,
        parsed.duplicate_name,
        parsed.duplicate_interaction_name,
    ):
        if not _bounded_unicode(name, maximum=255, allow_empty=False):
            parser.error("fixture and target names must contain 1..255 Unicode scalar values")
    if len(
        {
            parsed.fixture_name,
            parsed.renamed_name,
            parsed.duplicate_name,
            parsed.duplicate_interaction_name,
        }
    ) != 4:
        parser.error("fixture and target names must be distinct")
    if parsed.range_duration["value"] <= 0:
        parser.error("--range-duration must be positive")
    if not isinstance(parsed.stretch_percent, str) or STRETCH_PERCENT.fullmatch(
        parsed.stretch_percent
    ) is None:
        parser.error(
            "--stretch-percent must be a plain decimal with up to four integer "
            "and six fractional digits"
        )
    try:
        stretch = Decimal(parsed.stretch_percent)
    except InvalidOperation as error:  # kept fail-closed if the regex changes
        parser.error("--stretch-percent must be a finite decimal string")
        raise error  # pragma: no cover
    if not stretch.is_finite() or stretch == 0 or abs(stretch) > Decimal("9900"):
        parser.error("--stretch-percent must be non-zero and within [-9900, 9900]")
    try:
        _stretch_ratio(parsed.stretch_percent)
    except AcceptanceFailure as error:
        parser.error(str(error))
    for field in (
        "review_rounds",
        "candidate_builds",
        "full_ci_runs",
        "t4_runs",
        "candidate_hardware_runs",
        "main_hardware_runs",
        "gui_pairing_interruptions",
    ):
        if getattr(parsed, field) < 0:
            parser.error(f"--{field.replace('_', '-')} cannot be negative")
    return parsed


async def _main(argv: Sequence[str] | None = None) -> int:
    arguments = parse_args(argv)
    config = RunConfig(
        mode=arguments.mode,
        expected_sha=arguments.expected_sha,
        fixture_name=arguments.fixture_name,
        renamed_name=arguments.renamed_name,
        duplicate_name=arguments.duplicate_name,
        duplicate_interaction_name=arguments.duplicate_interaction_name,
        range_in_point=arguments.range_in_point,
        range_duration=arguments.range_duration,
        start_time=arguments.start_time,
        stretch_percent=arguments.stretch_percent,
        fixture_path=arguments.fixture_path,
        recovery_archive_root=arguments.recovery_archive_root,
        formal_ae_app=arguments.formal_ae_app,
        expected_ae_bundle_id=arguments.expected_ae_bundle_id,
        expected_ae_version=arguments.expected_ae_version,
        expected_ae_build=arguments.expected_ae_build,
        expected_ae_host_build=arguments.expected_ae_host_build,
        identity_home=arguments.identity_home,
        native_receipt=arguments.native_receipt,
        native_manifest=arguments.native_manifest,
        contract_fixture=arguments.contract_fixture,
    )
    evidence = EvidenceLog(
        arguments.evidence_dir,
        mode=arguments.mode,
        expected_sha=arguments.expected_sha,
    )
    efficiency = EfficiencyCounters(
        review_rounds=arguments.review_rounds,
        candidate_builds=arguments.candidate_builds,
        full_ci_runs=arguments.full_ci_runs,
        t4_runs=arguments.t4_runs,
        candidate_hardware_runs=arguments.candidate_hardware_runs,
        main_hardware_runs=arguments.main_hardware_runs,
        first_hardware_pass=(
            None
            if arguments.first_hardware_pass == "unknown"
            else arguments.first_hardware_pass == "true"
        ),
        gui_pairing_interruptions=arguments.gui_pairing_interruptions,
        scope_frozen_unix_ms=arguments.scope_frozen_unix_ms,
    )
    acceptance = PackageAcceptance(
        config,
        session_factory=LiveSessionFactory(arguments.launcher),
        checkpoint=stdin_checkpoint,
        evidence=evidence,
    )
    try:
        result = await acceptance.run()
    except Exception as error:
        evidence.record(
            "run-failed",
            {"errorType": type(error).__name__, "message": str(error)},
        )
        evidence.finish(
            passed=False,
            details={"errorType": type(error).__name__, "message": str(error), "perToolMatrix": acceptance.matrix},
            efficiency=efficiency,
            aep_lifecycle=acceptance.aep_lifecycle,
        )
        raise
    evidence.record("run-passed", result)
    evidence.finish(
        passed=True,
        details=result,
        efficiency=efficiency,
        aep_lifecycle=acceptance.aep_lifecycle,
    )
    print(
        json.dumps(
            {
                "event": "PASS",
                "runId": evidence.run_id,
                "summarySha256": hashlib.sha256(evidence.summary_path.read_bytes()).hexdigest(),
                "evidenceSha256": hashlib.sha256(evidence.events_path.read_bytes()).hexdigest(),
                "markdownSha256": hashlib.sha256(evidence.markdown_path.read_bytes()).hexdigest(),
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised by hardware operator
    raise SystemExit(asyncio.run(_main()))
