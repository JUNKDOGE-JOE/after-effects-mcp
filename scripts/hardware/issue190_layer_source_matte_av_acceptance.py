#!/usr/bin/env python3
"""Run the exact 40-call Issue #190 development-only HDEV scenario."""

from __future__ import annotations

import argparse
import asyncio
import copy
import dataclasses
import json
import os
import secrets
import shutil
import stat
import struct
import sys
import time
import wave
from collections import Counter
from collections.abc import Awaitable, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol


HARDWARE_ROOT = Path(__file__).resolve().parent
if os.fspath(HARDWARE_ROOT) not in sys.path:
    sys.path.insert(0, os.fspath(HARDWARE_ROOT))

import development_smoke as base_hdev
from issue190_layer_source_matte_av_spec import (
    CALL_HARD_LIMIT,
    CALL_PLAN,
    CASE_DEPENDENCIES,
    CROSS_COMPOSITION_LAYER,
    FIXTURE_COMPOSITION,
    FIXTURE_SPEC,
    IMMEDIATE_STOP_REASONS,
    INVALID_SOURCE_TARGET,
    REQUIRED_PUBLIC_TOOLS,
    SCENARIO_ID,
    WAV_SPEC,
)


COMPONENTS = frozenset({"core", "cep", "native"})
SHA256 = base_hdev.SHA256


class Issue190Failure(RuntimeError):
    """The frozen development-smoke contract was not satisfied."""


class ImmediateStop(Issue190Failure):
    """Evidence is no longer safe for a bounded independent-case sweep."""


def require(condition: Any, message: str) -> None:
    if not condition:
        raise Issue190Failure(message)


def mapping(value: Any, message: str) -> dict[str, Any]:
    require(isinstance(value, Mapping), message)
    return dict(value)


def error_code(payload: Mapping[str, Any]) -> str | None:
    error = payload.get("error")
    if not isinstance(error, Mapping):
        return None
    code = error.get("code")
    return code if isinstance(code, str) else None


class PublicSession(Protocol):
    tool_names: frozenset[str]

    async def call(
        self,
        tool: str,
        arguments: Mapping[str, Any],
    ) -> tuple[bool, dict[str, Any]]: ...


@dataclasses.dataclass(frozen=True)
class Issue190Config:
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
        require(self.scenario == SCENARIO_ID, "unsupported Issue #190 HDEV scenario")
        selected = set(self.selected_components)
        reused = set(self.reused_components)
        require(
            len(selected) == len(self.selected_components)
            and len(reused) == len(self.reused_components),
            "component disposition contains duplicates",
        )
        require(selected <= COMPONENTS and reused <= COMPONENTS, "unknown component")
        require(not selected.intersection(reused), "component disposition overlaps")
        require(selected.union(reused) == COMPONENTS, "component disposition is incomplete")
        require(bool(selected), "at least one selected component is required")
        for path in (
            self.checkout,
            self.fixture_path,
            self.recovery_root,
            self.evidence_dir,
            self.formal_ae_app,
        ):
            require(path.is_absolute(), "Issue #190 HDEV paths must be absolute")
        require(self.fixture_path.suffix.lower() == ".aep", "fixture must end in .aep")
        require(
            not self.fixture_path.is_relative_to(self.checkout),
            "fixture must remain outside the checkout",
        )
        require(
            self.plugin_url.startswith("http://127.0.0.1:"),
            "Issue #190 HDEV plugin URL must be loopback",
        )

    @property
    def component_disposition(self) -> dict[str, list[str]]:
        return {
            "selected": list(self.selected_components),
            "reused": list(self.reused_components),
        }


@dataclasses.dataclass(frozen=True)
class Issue190Result:
    exit_code: int
    summary: dict[str, Any]


class DevelopmentEvidence:
    """Private events and summary that can never become candidate evidence."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, stat.S_IRWXU)
        self.run_id = f"issue190-hdev-{int(time.time())}-{secrets.token_hex(4)}"
        self.events_path = root / f"{self.run_id}.ndjson"
        self.summary_path = root / f"{self.run_id}.summary.json"
        self._events = 0

    def record(self, event: str, payload: Mapping[str, Any]) -> str:
        evidence_id = f"{self.run_id}:event:{self._events + 1}"
        entry = {
            "schemaVersion": 1,
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
            "runId": self.run_id,
            "sequence": self._events + 1,
            "evidenceId": evidence_id,
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
        details: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        summary = {
            "schemaVersion": 1,
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
            "runId": self.run_id,
            "scenario": SCENARIO_ID,
            "passed": passed,
            "publicCalls": dict(public_calls),
            "componentDisposition": dict(component_disposition),
            "aepLifecycle": dict(aep_lifecycle),
            "defectLedger": [dict(row) for row in defect_ledger],
            "toolSummary": copy.deepcopy(dict(tool_summary)),
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


class CallLedger:
    def __init__(self) -> None:
        self.total = 0
        self.by_tool: Counter[str] = Counter()
        self.by_phase: Counter[str] = Counter()

    def reserve(self, phase: str, tool: str) -> int:
        if self.total >= CALL_HARD_LIMIT:
            raise Issue190Failure(
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
            "withinLimit": self.total <= CALL_HARD_LIMIT,
            "byTool": dict(sorted(self.by_tool.items())),
            "byPhase": dict(sorted(self.by_phase.items())),
        }


class DefectLedger:
    """Closed per-case evidence rows for the bounded diagnostic sweep."""

    STATUSES = {"PASS", "FAIL", "BLOCKED", "INDETERMINATE"}
    _SIDE_EFFECTS = {
        "none",
        "not-started",
        "committed-reconciled",
        "possible",
        "unknown",
    }

    def __init__(
        self,
        dependencies: Mapping[str, Sequence[str]] | None = None,
    ) -> None:
        self.dependencies = {
            key: tuple(value)
            for key, value in (dependencies or {}).items()
        }
        self._rows: dict[str, dict[str, Any]] = {}

    def record(
        self,
        case: str,
        *,
        status: str,
        failing_layer: str,
        side_effect_state: str,
        reconciliation: str,
        dependency_impact: Sequence[str],
        evidence_ids: Sequence[str],
        message: str,
    ) -> None:
        require(status in self.STATUSES, "defect status is invalid")
        require(side_effect_state in self._SIDE_EFFECTS, "side-effect state is invalid")
        require(bool(case), "defect case is required")
        self._rows[case] = {
            "case": case,
            "status": status,
            "failingLayer": failing_layer,
            "sideEffectState": side_effect_state,
            "reconciliation": reconciliation,
            "dependencyImpact": list(dependency_impact),
            "evidenceIds": list(evidence_ids),
            "message": message,
        }

    def block_dependents(self, case: str, *, reason: str) -> None:
        for dependent in self.dependencies.get(case, ()):
            if dependent in self._rows:
                continue
            self.record(
                dependent,
                status="BLOCKED",
                failing_layer="dependency",
                side_effect_state="none",
                reconciliation="not-required",
                dependency_impact=(case,),
                evidence_ids=(),
                message=reason,
            )

    def row(self, case: str) -> dict[str, Any]:
        require(case in self._rows, f"defect case {case!r} was not recorded")
        return copy.deepcopy(self._rows[case])

    def public_rows(self) -> list[dict[str, Any]]:
        return [copy.deepcopy(row) for row in self._rows.values()]


def generate_fixture_wav(config: Issue190Config) -> Path:
    """Create one deterministic, anonymous, 250 ms mono PCM fixture asset."""

    asset_root = config.fixture_path.parent / "assets"
    asset_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(asset_root, stat.S_IRWXU)
    path = asset_root / "issue190-hdev-tone.wav"
    frames = bytearray()
    for index in range(WAV_SPEC["frameCount"]):
        # A bounded square wave avoids platform-dependent floating-point output.
        sample = 1200 if index % 18 < 9 else -1200
        frames.extend(struct.pack("<h", sample))
    with wave.open(os.fspath(path), "wb") as stream:
        stream.setnchannels(WAV_SPEC["channels"])
        stream.setsampwidth(WAV_SPEC["sampleWidthBytes"])
        stream.setframerate(WAV_SPEC["sampleRateHz"])
        stream.writeframes(bytes(frames))
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    return path


def fixture_create_script(config: Issue190Config, wav_path: Path) -> str:
    """Return the fixed ES3 fixture create/reset script for a formal AE checkpoint."""

    fixture_literal = json.dumps(os.fspath(config.fixture_path), ensure_ascii=True)
    wav_literal = json.dumps(os.fspath(wav_path), ensure_ascii=True)
    return (
        "(function () {\n"
        "  var fixtureFile = new File(" + fixture_literal + ");\n"
        "  var wavFile = new File(" + wav_literal + ");\n"
        "  var project;\n"
        "  var sourceA;\n"
        "  var sourceB;\n"
        "  var mainComp;\n"
        "  var audioItem;\n"
        "  var relink;\n"
        "  var matteFill;\n"
        "  var matteSpacer;\n"
        "  var matteSource;\n"
        "  var videoSwitch;\n"
        "  var audioSwitch;\n"
        "  var invalidTarget;\n"
        "  if (!wavFile.exists) { return JSON.stringify({ok:false,error:'wav-missing'}); }\n"
        "  if (app.project !== null) { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); }\n"
        "  project = app.newProject();\n"
        "  sourceA = project.items.addComp('SOURCE_COMP_A',320,180,1,2,24);\n"
        "  sourceA.layers.addSolid([1,0,0],'SOURCE_A_PIXEL',320,180,1,2);\n"
        "  sourceB = project.items.addComp('SOURCE_COMP_B',320,180,1,2,24);\n"
        "  sourceB.layers.addSolid([0,1,0],'CROSS_COMP_MATTE',320,180,1,2);\n"
        "  mainComp = project.items.addComp('ISSUE190_MAIN',640,360,1,5,24);\n"
        "  relink = mainComp.layers.add(sourceA); relink.name = 'RELINK_TARGET';\n"
        "  matteFill = mainComp.layers.addSolid([0.2,0.3,0.8],'MATTE_FILL',640,360,1,5);\n"
        "  matteSpacer = mainComp.layers.addSolid([0.1,0.1,0.1],'MATTE_SPACER',640,360,1,5);\n"
        "  matteSource = mainComp.layers.addSolid([1,1,1],'MATTE_SOURCE',640,360,1,5);\n"
        "  videoSwitch = mainComp.layers.addSolid([0.4,0.6,0.2],'VIDEO_SWITCH',640,360,1,5);\n"
        "  audioItem = project.importFile(new ImportOptions(wavFile));\n"
        "  audioSwitch = mainComp.layers.add(audioItem); audioSwitch.name = 'AUDIO_SWITCH';\n"
        "  invalidTarget = mainComp.layers.addText('invalid source target');\n"
        "  invalidTarget.name = 'INVALID_SOURCE_TARGET';\n"
        "  relink.property('ADBE Transform Group').property('ADBE Position').setValueAtTime(0,[160,180]);\n"
        "  relink.property('ADBE Transform Group').property('ADBE Position').setValueAtTime(1,[480,180]);\n"
        "  project.save(fixtureFile);\n"
        "  return JSON.stringify({ok:true,lifecycle:'ephemeral-validation',active:1,saveAsCopies:0});\n"
        "}())"
    )


def undo_script(count: int) -> str:
    require(count in {1, 2}, "harness Undo count is invalid")
    calls = "\n".join(
        "  app.executeCommand(app.findMenuCommandId('Undo'));" for _ in range(count)
    )
    return (
        "(function () {\n"
        + calls
        + "\n  return JSON.stringify({ok:true,undoCount:"
        + str(count)
        + "});\n}())"
    )


def close_fixture_script(config: Issue190Config) -> str:
    fixture_literal = json.dumps(os.fspath(config.fixture_path), ensure_ascii=True)
    return (
        "(function () {\n"
        "  var expected = new File(" + fixture_literal + ");\n"
        "  if (app.project === null || app.project.file === null"
        " || app.project.file.fsName !== expected.fsName) {\n"
        "    return JSON.stringify({ok:false,error:'wrong-fixture'});\n"
        "  }\n"
        "  app.project.save();\n"
        "  app.project.close(CloseOptions.SAVE_CHANGES);\n"
        "  return JSON.stringify({ok:true,active:0,saveAsCopies:0});\n"
        "}())"
    )


async def _default_reconcile(_record: dict[str, Any]) -> dict[str, Any]:
    return {
        "state": "unreconciled",
        "audit": "unreconciled",
        "evidenceIds": (),
    }


class Issue190Runner:
    _UNDO_WRITE_TOOL = {
        "undo-source-replace": "ae_setLayerSource",
        "undo-matte-reorder-and-set": "ae_setLayerTrackMatte",
        "undo-matte-clear": "ae_clearLayerTrackMatte",
        "undo-audio-disable": "ae_setLayerAudioEnabled",
        "undo-video-disable": "ae_setLayerVideoEnabled",
    }
    _UNDO_VERIFY_TOOL = {
        "source-undo-read-a": "ae_setLayerSource",
        "matte-set-undo-read-empty": "ae_setLayerTrackMatte",
        "matte-clear-undo-read-luma": "ae_clearLayerTrackMatte",
        "audio-undo-read": "ae_setLayerAudioEnabled",
        "video-undo-read": "ae_setLayerVideoEnabled",
    }

    def __init__(
        self,
        config: Issue190Config,
        *,
        checkpoint: Callable[[str, Mapping[str, Any]], Awaitable[None]],
        after_effects_running: Callable[[], Awaitable[bool]],
        evidence: DevelopmentEvidence | None = None,
        reconcile_uncertain: Callable[
            [dict[str, Any]], Awaitable[dict[str, Any]]
        ] = _default_reconcile,
    ) -> None:
        self.config = config
        self.checkpoint = checkpoint
        self.after_effects_running = after_effects_running
        self.evidence = evidence or DevelopmentEvidence(config.evidence_dir)
        self.reconcile_uncertain = reconcile_uncertain
        self.ledger = CallLedger()
        self.defects = DefectLedger(CASE_DEPENDENCIES)
        self.context: dict[str, Any] = {}
        self.responses: dict[str, dict[str, Any]] = {}
        self.call_evidence: dict[str, tuple[str, str]] = {}
        self.operation_keys: dict[str, str] = {}
        self.operation_prefix = f"i190-{secrets.token_hex(6)}"
        self.host_instance_id: str | None = None
        self.session_id: str | None = None
        self.tool_summary: dict[str, dict[str, Any]] = {}
        self.lifecycle = {
            "created": 0,
            "canonicalRetained": 0,
            "evidenceSnapshotsRetained": 0,
            "archived": 0,
            "active": 0,
            "unclassified": 0,
            "saveAsCopies": 0,
        }

    def operation_key(self, intent: str) -> str:
        """Mint once per evidence session; replay/reconciliation reuse it."""

        if intent not in self.operation_keys:
            self.operation_keys[intent] = f"{self.operation_prefix}:{intent}"
        return self.operation_keys[intent]

    def reconciliation_key(self, intent: str) -> str:
        return self.operation_key(intent)

    def _tool_row(self, tool: str) -> dict[str, Any]:
        return self.tool_summary.setdefault(
            tool,
            {
                "publicCalls": 0,
                "requestDispositions": Counter(),
                "resultDispositions": Counter(),
                "aeRedispatches": 0,
                "undo": {"executed": 0, "verified": 0},
                "componentVersions": {},
                "hostInstances": [],
                "auditIds": [],
                "postconditionIds": [],
                "fixtureLifecycle": "ephemeral-validation",
            },
        )

    @staticmethod
    def _locator(value: Any, kind: str) -> dict[str, Any]:
        locator = mapping(value, f"{kind} locator missing")
        require(
            set(locator)
            == {
                "kind",
                "hostInstanceId",
                "sessionId",
                "projectId",
                "generation",
                "objectId",
            }
            and locator.get("kind") == kind,
            f"{kind} locator is not closed",
        )
        return locator

    @staticmethod
    def _named(rows: Any, name: str, label: str) -> dict[str, Any]:
        require(isinstance(rows, list), f"{label} rows are invalid")
        matches = [
            mapping(row, f"{label} row is invalid")
            for row in rows
            if isinstance(row, Mapping) and row.get("name") == name
        ]
        require(len(matches) == 1, f"{label} {name!r} is not unique")
        return matches[0]

    def _validate_native(
        self,
        tool: str,
        payload: Mapping[str, Any],
        *,
        write: bool,
    ) -> None:
        implementation = mapping(payload.get("implementation"), "implementation missing")
        provenance = mapping(payload.get("provenance"), "provenance missing")
        audit = mapping(payload.get("audit"), "audit missing")
        evidence = mapping(payload.get("evidence"), "evidence missing")
        postcondition = mapping(evidence.get("postcondition"), "postcondition missing")
        require(
            implementation.get("engine") == "native-aegp"
            and provenance.get("engine") == "native-aegp"
            and evidence.get("engine") == "native-aegp",
            f"{tool} native provenance drifted",
        )
        digest = implementation.get("contractDigest")
        require(
            isinstance(digest, str)
            and SHA256.fullmatch(digest) is not None
            and audit.get("contractDigest") == digest,
            f"{tool} contract digest drifted",
        )
        capability = implementation.get("capabilityId")
        require(
            isinstance(capability, str)
            and capability == audit.get("capabilityId") == evidence.get("capabilityId"),
            f"{tool} capability identity drifted",
        )
        host = provenance.get("hostInstanceId")
        session = provenance.get("sessionId")
        require(
            isinstance(host, str)
            and isinstance(session, str)
            and host == evidence.get("hostInstanceId")
            and session == evidence.get("sessionId"),
            f"{tool} host/session evidence drifted",
        )
        if self.host_instance_id is None:
            self.host_instance_id, self.session_id = host, session
        require(
            host == self.host_instance_id and session == self.session_id,
            "formal host/session changed during Issue #190 HDEV",
        )
        require(
            postcondition.get("verified") is True
            and postcondition.get("algorithm") == "sha256-rfc8785-jcs-v1"
            and postcondition.get("digest") == audit.get("postconditionDigest"),
            f"{tool} audit/postcondition drifted",
        )
        if write:
            value = mapping(payload.get("value"), f"{tool} value missing")
            undo = mapping(evidence.get("undo"), f"{tool} Undo evidence missing")
            require(value.get("changed") is True, f"{tool} did not report changed")
            require(
                undo.get("available") is True
                and undo.get("verified") is False
                and audit.get("undoAvailable") is True
                and audit.get("undoVerified") is False,
                f"{tool} Undo availability drifted",
            )

    def _validate_maintained_source(
        self,
        payload: Mapping[str, Any],
        *,
        write: bool,
    ) -> None:
        require(write, "maintained source path is write-only")
        implementation = mapping(payload.get("implementation"), "implementation missing")
        provenance = mapping(payload.get("provenance"), "provenance missing")
        audit = mapping(payload.get("audit"), "audit missing")
        evidence = mapping(payload.get("evidence"), "evidence missing")
        postcondition = mapping(evidence.get("postcondition"), "postcondition missing")
        undo = mapping(evidence.get("undo"), "source Undo evidence missing")
        require(
            implementation.get("engine") == provenance.get("engine") == "maintained-jsx",
            "source replacement engine drifted",
        )
        require(
            implementation.get("contractId") == "ae.layer.source.set"
            and isinstance(implementation.get("templateId"), str)
            and isinstance(implementation.get("templateDigest"), str)
            and SHA256.fullmatch(implementation["templateDigest"]) is not None
            and implementation.get("callerCodeAccepted") is False,
            "source maintained template identity drifted",
        )
        require(
            postcondition.get("verified") is True
            and postcondition.get("digest") == audit.get("postconditionDigest")
            and undo.get("available") is True
            and undo.get("verified") is False
            and audit.get("undoAvailable") is True
            and audit.get("undoVerified") is False,
            "source postcondition/Undo evidence drifted",
        )
        host = provenance.get("hostInstanceId")
        session = provenance.get("sessionId")
        if self.host_instance_id is None:
            self.host_instance_id, self.session_id = host, session
        require(
            host == self.host_instance_id and session == self.session_id,
            "source replacement host/session drifted",
        )

    async def public_call(
        self,
        session: PublicSession,
        *,
        case: str,
        phase: str,
        tool: str,
        arguments: Mapping[str, Any],
        write: bool = False,
        expected_error: str | None = None,
        expected_replay: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        sequence = self.ledger.reserve(phase, tool)
        request_id = self.evidence.record(
            "public-tool-request",
            {
                "call": sequence,
                "case": case,
                "phase": phase,
                "tool": tool,
                "arguments": dict(arguments),
            },
        )
        row = self._tool_row(tool)
        row["publicCalls"] += 1
        row["requestDispositions"]["negative" if expected_error else "primary"] += 1
        try:
            is_error, payload = await session.call(tool, dict(arguments))
        except Exception as error:
            failure_id = self.evidence.record(
                "public-tool-transport-failure",
                {
                    "call": sequence,
                    "case": case,
                    "phase": phase,
                    "tool": tool,
                    "errorType": type(error).__name__,
                },
            )
            self.defects.record(
                case,
                status="INDETERMINATE",
                failing_layer="transport-or-ae-process",
                side_effect_state="possible" if write else "unknown",
                reconciliation="required" if write else "unavailable",
                dependency_impact=(),
                evidence_ids=(request_id, failure_id),
                message="transport failed after public dispatch; no retry attempted",
            )
            raise ImmediateStop(
                "transport or AE process failed after dispatch; stop without retry"
            ) from error
        response_id = self.evidence.record(
            "public-tool-response",
            {
                "call": sequence,
                "case": case,
                "phase": phase,
                "tool": tool,
                "isError": is_error,
                "payload": payload,
            },
        )
        self.call_evidence[case] = (request_id, response_id)
        code = error_code(payload)
        if code in {
            "NATIVE_CONTRACT_MISMATCH",
            "NATIVE_PROTOCOL_MISMATCH",
            "BUNDLE_NATIVE_PLUGIN_PROTOCOL_MISMATCH",
            "PROTOCOL_MISMATCH",
        }:
            raise ImmediateStop(
                f"incompatible component or protocol response from {tool}: {code}"
            )
        if code == "POSSIBLY_SIDE_EFFECTING_FAILURE":
            error = mapping(payload.get("error"), "possible-write error missing")
            details = mapping(error.get("details"), "possible-write identity missing")
            record = {
                "case": case,
                "tool": tool,
                "operationId": details.get("operationId"),
                "idempotencyKey": details.get("idempotencyKey"),
                "action": "read-state-and-audit-without-redispatch",
            }
            reconciliation = await self.reconcile_uncertain(record)
            evidence_ids = tuple(reconciliation.get("evidenceIds") or ())
            resolved = (
                reconciliation.get("state") in {"before", "after"}
                and reconciliation.get("audit") in {"completed", "rejected", "indeterminate"}
            )
            self.defects.record(
                case,
                status="INDETERMINATE",
                failing_layer="post-dispatch-terminal",
                side_effect_state="possible",
                reconciliation="reconciled" if resolved else "unreconciled",
                dependency_impact=(),
                evidence_ids=(request_id, response_id, *evidence_ids),
                message="possible write was not retried",
            )
            raise ImmediateStop(
                "reconciled possible write requires the HDEV session to stop"
                if resolved
                else "unreconciled possible write requires immediate stop"
            )
        if expected_error is not None:
            if not is_error or payload.get("ok") is not False:
                self.defects.record(
                    case,
                    status="INDETERMINATE",
                    failing_layer="negative-pre-dispatch-guard",
                    side_effect_state="possible",
                    reconciliation="required",
                    dependency_impact=(),
                    evidence_ids=(request_id, response_id),
                    message="negative probe unexpectedly succeeded; fixture must be reconciled",
                )
                raise ImmediateStop(
                    f"{tool} negative probe unexpectedly succeeded and may have written"
                )
            error = mapping(payload.get("error"), f"{tool} structured error missing")
            require(code == expected_error, f"{tool} returned {code}, expected {expected_error}")
            require(
                error.get("sideEffect") == "not-started"
                and error.get("retryable") is False,
                f"{tool} negative was not a zero-write rejection",
            )
            row["resultDispositions"]["expected-negative"] += 1
            row["auditIds"].append(response_id)
            return dict(payload)
        require(not is_error and code is None and payload.get("ok") is True, f"{tool} failed")
        if tool == "ae_setLayerSource":
            self._validate_maintained_source(payload, write=write)
        else:
            self._validate_native(tool, payload, write=write)
        replayed = payload.get("replayed") is True
        if expected_replay is not None:
            audit = mapping(payload.get("audit"), "replay audit missing")
            require(replayed and audit.get("replayed") is True, "completed replay not reported")
            require(
                audit.get("operationId") == expected_replay.get("operationId")
                and audit.get("postconditionDigest")
                == expected_replay.get("postconditionDigest")
                and audit.get("idempotencyKey")
                == expected_replay.get("idempotencyKey"),
                "completed replay identity drifted",
            )
        row["resultDispositions"]["replayed" if replayed else "completed"] += 1
        if write and not replayed:
            row["aeRedispatches"] += 1
        provenance = mapping(payload.get("provenance"), "provenance missing")
        audit = mapping(payload.get("audit"), "audit missing")
        postcondition = mapping(
            mapping(payload.get("evidence"), "evidence missing").get("postcondition"),
            "postcondition missing",
        )
        row["componentVersions"].update(
            {
                key: provenance[key]
                for key in ("pluginVersion", "coreVersion", "selectedWireVersion")
                if key in provenance
            }
        )
        host = provenance.get("hostInstanceId")
        if isinstance(host, str) and host not in row["hostInstances"]:
            row["hostInstances"].append(host)
        for value, target in (
            (audit.get("requestId", audit.get("operationId")), row["auditIds"]),
            (postcondition.get("digest"), row["postconditionIds"]),
        ):
            if isinstance(value, str):
                target.append(value)
        return dict(payload)

    def _resolve(self, value: Any) -> Any:
        if isinstance(value, str) and value.startswith("$operation_key:"):
            return self.operation_key(value.split(":", 1)[1])
        if isinstance(value, str) and value.startswith("$"):
            key = value[1:]
            require(key in self.context, f"plan address {value} was not produced")
            return copy.deepcopy(self.context[key])
        if isinstance(value, Mapping):
            return {key: self._resolve(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [self._resolve(item) for item in value]
        return value

    def _capture_project_items(self, value: Mapping[str, Any]) -> None:
        rows = value.get("items")
        main = self._named(rows, FIXTURE_COMPOSITION, "project item")
        source_a = self._named(rows, "SOURCE_COMP_A", "project item")
        source_b = self._named(rows, "SOURCE_COMP_B", "project item")
        self.context["main_composition_locator"] = self._locator(
            main.get("locator"), "composition"
        )
        self.context["source_comp_a_locator"] = self._locator(
            source_a.get("locator"), "composition"
        )
        self.context["source_comp_b_locator"] = self._locator(
            source_b.get("locator"), "composition"
        )

    def _capture_layers(self, value: Mapping[str, Any], *, cross: bool) -> None:
        rows = value.get("layers")
        if cross:
            layer = self._named(rows, CROSS_COMPOSITION_LAYER, "cross-composition layer")
            self.context["cross_comp_matte_locator"] = self._locator(
                layer.get("locator"), "layer"
            )
            return
        roles = {
            "RELINK_TARGET": "relink_target_locator",
            "MATTE_FILL": "matte_fill_locator",
            "MATTE_SOURCE": "matte_source_locator",
            "MATTE_SPACER": "matte_spacer_locator",
            "VIDEO_SWITCH": "video_switch_locator",
            "AUDIO_SWITCH": "audio_switch_locator",
            INVALID_SOURCE_TARGET: "invalid_source_target_locator",
        }
        order: list[str] = []
        indices: dict[str, int] = {}
        for name, key in roles.items():
            layer = self._named(rows, name, "main layer")
            self.context[key] = self._locator(layer.get("locator"), "layer")
            stack_index = layer.get("stackIndex")
            require(type(stack_index) is int and stack_index > 0, "stack index invalid")
            indices[name] = stack_index
            order.append(name)
        ordered = tuple(name for name, _ in sorted(indices.items(), key=lambda item: item[1]))
        if "baseline_layer_order" not in self.context:
            self.context["baseline_layer_order"] = ordered
            source_index = indices["MATTE_SOURCE"]
            spacer_index = indices["MATTE_SPACER"]
            require(abs(source_index - spacer_index) == 1, "Matte spacer recipe drifted")
            self.context["matte_reorder_target_index"] = spacer_index
        self.context["current_layer_order"] = ordered

    @staticmethod
    def _semantic_transform(value: Mapping[str, Any]) -> dict[str, Any]:
        return {
            key: copy.deepcopy(item)
            for key, item in value.items()
            if key != "layerLocator"
        }

    def _assert_matte(
        self,
        value: Mapping[str, Any],
        *,
        active: bool,
        mode: str | None = None,
    ) -> None:
        require(value.get("active") is active, "Track Matte active state drifted")
        if active:
            expected = self.context["matte_source_locator"]["objectId"]
            observed = self._locator(value.get("matteLayerLocator"), "layer")
            require(observed["objectId"] == expected, "Track Matte source drifted")
        else:
            require(value.get("matteLayerLocator") is None, "cleared Matte retained locator")
        if mode is not None:
            require(value.get("mode") == mode, "Track Matte stored mode drifted")

    def _assert_and_capture(
        self,
        key: str,
        payload: Mapping[str, Any],
        arguments: Mapping[str, Any],
    ) -> None:
        if payload.get("ok") is False:
            return
        value = mapping(payload.get("value"), f"{key} value missing")
        if key in {"fixture-project-items", "source-reacquire-project", "source-undo-reacquire-project"}:
            self._capture_project_items(value)
        elif key in {
            "fixture-main-layers",
            "source-reacquire-layers",
            "source-undo-reacquire-layers",
            "matte-set-undo-reacquire-layers",
            "matte-clear-undo-reacquire-layers",
            "audio-undo-reacquire-layers",
            "video-undo-reacquire-layers",
        }:
            self._capture_layers(value, cross=False)
            if key == "matte-set-undo-reacquire-layers":
                require(
                    self.context["current_layer_order"]
                    == self.context["baseline_layer_order"],
                    "support reorder Undo did not restore baseline stack order",
                )
        elif key == "fixture-cross-composition-layers":
            self._capture_layers(value, cross=True)
        elif key in {"source-read-a", "source-undo-read-a"}:
            require(value.get("sourceName") == "SOURCE_COMP_A", f"{key} source drifted")
        elif key == "source-read-b":
            require(value.get("sourceName") == "SOURCE_COMP_B", "replacement read drifted")
        elif key == "source-transform-before":
            self.context["source_transform_before"] = self._semantic_transform(value)
        elif key == "source-transform-after":
            require(
                self._semantic_transform(value) == self.context["source_transform_before"],
                "keyed transform witness changed during source replacement",
            )
        elif key == "source-replace-a-to-b":
            before = mapping(value.get("beforeSource"), "source before missing")
            after = mapping(value.get("afterSource"), "source after missing")
            require(
                before.get("sourceName") == "SOURCE_COMP_A"
                and after.get("sourceName") == "SOURCE_COMP_B"
                and value.get("beforeInvariant") == value.get("afterInvariant"),
                "source transition or preservation invariant drifted",
            )
            audit = mapping(payload.get("audit"), "source audit missing")
            self.context["source_replay_identity"] = {
                "operationId": audit.get("operationId"),
                "postconditionDigest": audit.get("postconditionDigest"),
                "idempotencyKey": audit.get("idempotencyKey"),
            }
            self.context["source_original_layer_locator"] = copy.deepcopy(
                arguments["layer_locator"]
            )
            self.context["source_original_b_locator"] = copy.deepcopy(
                arguments["source_item_locator"]
            )
        elif key in {"matte-read-empty", "matte-set-undo-read-empty"}:
            self._assert_matte(value, active=False)
        elif key in {"matte-read-alpha", "matte-read-after-reorder"}:
            self._assert_matte(value, active=True, mode="alpha")
            if key == "matte-read-after-reorder":
                require(
                    self.context.get("matte_reorder_changed") is True,
                    "Matte relationship read occurred without a stack-order change",
                )
        elif key in {"matte-read-luma", "matte-clear-undo-read-luma"}:
            self._assert_matte(value, active=True, mode="luma")
        elif key == "matte-read-cleared-luma":
            self._assert_matte(value, active=False, mode="luma")
        elif key == "matte-reorder-source":
            require(value.get("changed") is True, "support reorder did not change order")
            self.context["matte_reorder_changed"] = True
        elif key == "audio-disable":
            before = mapping(value.get("before"), "audio before missing")
            after = mapping(value.get("after"), "audio after missing")
            require(
                before.get("hasAudio") is True
                and before.get("audioEnabled") is True
                and after.get("audioEnabled") is False
                and before.get("videoEnabled") == after.get("videoEnabled"),
                "audio write changed the wrong AV projection",
            )
        elif key == "audio-disable-read":
            require(
                value.get("hasAudio") is True and value.get("audioEnabled") is False,
                "audio disable readback drifted",
            )
        elif key == "audio-undo-read":
            require(
                value.get("hasAudio") is True and value.get("audioEnabled") is True,
                "audio Undo readback drifted",
            )
        elif key == "video-disable":
            before = mapping(value.get("before"), "video before missing")
            after = mapping(value.get("after"), "video after missing")
            require(
                before.get("hasVideo") is True
                and before.get("videoEnabled") is True
                and after.get("videoEnabled") is False
                and before.get("audioEnabled") == after.get("audioEnabled"),
                "video write changed the wrong AV projection",
            )
        elif key == "video-disable-read":
            require(
                value.get("hasVideo") is True and value.get("videoEnabled") is False,
                "video disable readback drifted",
            )
        elif key == "video-undo-read":
            require(
                value.get("hasVideo") is True and value.get("videoEnabled") is True,
                "video Undo readback drifted",
            )

    async def _undo_checkpoint(self, name: str) -> None:
        count = 2 if name == "undo-matte-reorder-and-set" else 1
        await self.checkpoint(
            name,
            {
                "instruction": (
                    "Run the fixed harness-only ExtendScript to execute exactly "
                    f"{count} real After Effects Undo command(s). Do not retry a write."
                ),
                "script": undo_script(count),
                "undoCount": count,
                "fixtureLifecycle": "ephemeral-validation",
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
                "validationProfile": "development",
                "candidateRun": False,
                "candidateEvidence": False,
            },
        )
        self._tool_row(self._UNDO_WRITE_TOOL[name])["undo"]["executed"] += 1

    def mark_undo_verified(self, tool: str) -> None:
        undo = self._tool_row(tool)["undo"]
        require(
            undo["executed"] == undo["verified"] + 1,
            f"{tool} Undo verification did not follow exactly one execution",
        )
        undo["verified"] += 1

    async def execute_plan(self, session: PublicSession) -> None:
        require(
            REQUIRED_PUBLIC_TOOLS <= session.tool_names,
            "Issue #190 HDEV public tool set is incomplete",
        )
        failed_cases: set[str] = set()
        for plan in CALL_PLAN:
            if plan.case in failed_cases:
                self.defects.record(
                    plan.key,
                    status="BLOCKED",
                    failing_layer="dependency",
                    side_effect_state="none",
                    reconciliation="not-required",
                    dependency_impact=(plan.case,),
                    evidence_ids=(),
                    message=f"{plan.case} already failed",
                )
                continue
            try:
                if plan.undo_checkpoint is not None:
                    await self._undo_checkpoint(plan.undo_checkpoint)
                arguments = self._resolve(plan.arguments)
                expected_replay = (
                    self.context.get("source_replay_identity")
                    if plan.key == "source-replace-completed-replay"
                    else None
                )
                payload = await self.public_call(
                    session,
                    case=plan.key,
                    phase=plan.case,
                    tool=plan.tool,
                    arguments=arguments,
                    write=plan.disposition == "write",
                    expected_error=plan.expected_error,
                    expected_replay=expected_replay,
                )
                self.responses[plan.key] = payload
                self._assert_and_capture(plan.key, payload, arguments)
                if plan.key in self._UNDO_VERIFY_TOOL:
                    self.mark_undo_verified(self._UNDO_VERIFY_TOOL[plan.key])
                self.defects.record(
                    plan.key,
                    status="PASS",
                    failing_layer="none",
                    side_effect_state=(
                        "not-started"
                        if plan.expected_error
                        else "committed-reconciled"
                        if plan.disposition == "write"
                        else "none"
                    ),
                    reconciliation=(
                        "public-readback"
                        if plan.disposition in {"read", "write"}
                        else "not-required"
                    ),
                    dependency_impact=(),
                    evidence_ids=self.call_evidence.get(plan.key, ()),
                    message=plan.predicate,
                )
            except ImmediateStop:
                raise
            except Issue190Failure as error:
                failed_cases.add(plan.case)
                failed_cases.update(CASE_DEPENDENCIES.get(plan.case, ()))
                self.defects.record(
                    plan.key,
                    status="FAIL",
                    failing_layer="public-contract-or-readback",
                    side_effect_state=(
                        "unknown" if plan.disposition == "write" else "none"
                    ),
                    reconciliation=(
                        "required" if plan.disposition == "write" else "not-required"
                    ),
                    dependency_impact=CASE_DEPENDENCIES.get(plan.case, ()),
                    evidence_ids=self.call_evidence.get(plan.key, ()),
                    message=str(error),
                )
                self.defects.block_dependents(
                    plan.case,
                    reason=f"{plan.case} failed at {plan.key}",
                )
                if (
                    plan.disposition == "write"
                    or "reacquire" in plan.key
                    or plan.key.startswith("fixture-")
                ):
                    raise ImmediateStop(
                        f"fixture baseline or write evidence became untrustworthy at {plan.key}"
                    ) from error
        require(self.ledger.total == CALL_HARD_LIMIT, "Issue #190 call count drifted")
        require(
            all(row["status"] == "PASS" for row in self.defects.public_rows()),
            "bounded Issue #190 defect sweep found failures or blocked cases",
        )

    async def archive_fixture(self, wav_path: Path) -> Path:
        require(
            not await self.after_effects_running(),
            "formal After Effects still owns the Issue #190 fixture",
        )
        require(self.config.fixture_path.is_file(), "Issue #190 fixture missing")
        require(wav_path.is_file(), "Issue #190 generated WAV missing")
        self.config.recovery_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.config.recovery_root, stat.S_IRWXU)
        suffix = f"{int(time.time())}-{secrets.token_hex(3)}"
        destination = self.config.recovery_root / (
            f"{self.config.fixture_path.stem}-{suffix}.aep"
        )
        asset_destination = self.config.recovery_root / (
            f"{wav_path.stem}-{suffix}.wav"
        )
        require(
            not destination.exists() and not asset_destination.exists(),
            "Issue #190 recovery destination already exists",
        )
        shutil.move(os.fspath(self.config.fixture_path), os.fspath(destination))
        shutil.move(os.fspath(wav_path), os.fspath(asset_destination))
        self.lifecycle.update({"archived": 1, "active": 0, "unclassified": 0})
        return destination

    def call_summary(self) -> list[dict[str, Any]]:
        """Join the frozen plan, defect disposition, and public evidence."""

        defect_rows = {
            row["case"]: row for row in self.defects.public_rows()
        }
        undo_by_read = self._UNDO_VERIFY_TOOL
        result: list[dict[str, Any]] = []
        for plan in CALL_PLAN:
            defect = defect_rows.get(
                plan.key,
                {
                    "status": "BLOCKED",
                    "failingLayer": "run-stop",
                    "sideEffectState": "unknown",
                    "reconciliation": "not-completed",
                    "dependencyImpact": [],
                    "evidenceIds": [],
                    "message": "run stopped before this call",
                },
            )
            response = self.responses.get(plan.key, {})
            audit = (
                dict(response["audit"])
                if isinstance(response.get("audit"), Mapping)
                else {}
            )
            evidence = (
                dict(response["evidence"])
                if isinstance(response.get("evidence"), Mapping)
                else {}
            )
            postcondition = (
                dict(evidence["postcondition"])
                if isinstance(evidence.get("postcondition"), Mapping)
                else {}
            )
            tool_row = self.tool_summary.get(plan.tool, {})
            undo_tool = undo_by_read.get(plan.key)
            result.append(
                {
                    "ordinal": plan.ordinal,
                    "key": plan.key,
                    "case": plan.case,
                    "tool": plan.tool,
                    "requestDisposition": plan.disposition,
                    "status": defect["status"],
                    "failingLayer": defect["failingLayer"],
                    "sideEffectState": defect["sideEffectState"],
                    "reconciliation": defect["reconciliation"],
                    "dependencyImpact": list(defect["dependencyImpact"]),
                    "evidenceIds": list(defect["evidenceIds"]),
                    "value": copy.deepcopy(response.get("value")),
                    "error": copy.deepcopy(response.get("error")),
                    "auditId": audit.get("requestId", audit.get("operationId")),
                    "postconditionId": postcondition.get("digest"),
                    "componentVersions": copy.deepcopy(
                        tool_row.get("componentVersions", {})
                    ),
                    "hostInstances": copy.deepcopy(
                        tool_row.get("hostInstances", [])
                    ),
                    "undoResult": (
                        copy.deepcopy(
                            self._tool_row(undo_tool)["undo"]
                        )
                        if undo_tool is not None
                        else None
                    ),
                    "fixtureLifecycle": "ephemeral-validation",
                }
            )
        return result

    async def run(self, session: PublicSession) -> dict[str, Any]:
        wav_path = generate_fixture_wav(self.config)
        await self.checkpoint(
            "create-or-reset-issue190-fixture",
            {
                "instruction": (
                    "In formal After Effects, run this exact harness-only script. "
                    "It creates or resets the one disposable fixture and saves it once."
                ),
                "script": fixture_create_script(self.config, wav_path),
                "fixtureLifecycle": "ephemeral-validation",
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
                "validationProfile": "development",
                "candidateRun": False,
                "candidateEvidence": False,
            },
        )
        require(self.config.fixture_path.is_file(), "prepared Issue #190 fixture missing")
        self.lifecycle.update({"created": 1, "active": 1})
        await self.execute_plan(session)
        await self.checkpoint(
            "close-and-archive-issue190-fixture",
            {
                "instruction": (
                    "Run the fixed save-in-place/close script, quit the exact formal "
                    "After Effects application, and wait until no AE process remains."
                ),
                "script": close_fixture_script(self.config),
                "fixtureLifecycle": "ephemeral-validation",
                "activeFixtureCountAfterScript": 0,
                "saveAsCopies": 0,
                "validationProfile": "development",
                "candidateRun": False,
                "candidateEvidence": False,
            },
        )
        archived = await self.archive_fixture(wav_path)
        archive_id = self.evidence.record(
            "fixture-archived",
            {
                "lifecycle": "ephemeral-validation",
                "archiveName": archived.name,
                "created": 1,
                "archived": 1,
                "active": 0,
                "unclassified": 0,
                "saveAsCopies": 0,
            },
        )
        return {
            "hostInstanceId": self.host_instance_id,
            "sessionId": self.session_id,
            "realUndo": {
                "checkpoints": 5,
                "executed": 5,
                "verified": 5,
                "supportReorderUndo": 1,
            },
            "fixtureArchiveEvidenceId": archive_id,
            "immediateStopReasons": sorted(IMMEDIATE_STOP_REASONS),
        }


def _plain_tool_summary(value: Mapping[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(dict(value))
    for row in result.values():
        for key in ("requestDispositions", "resultDispositions"):
            if isinstance(row.get(key), Counter):
                row[key] = dict(sorted(row[key].items()))
    return result


async def run_issue190_hdev(
    config: Issue190Config,
    *,
    session: PublicSession,
    checkpoint: Callable[[str, Mapping[str, Any]], Awaitable[None]],
    after_effects_running: Callable[[], Awaitable[bool]],
    reconcile_uncertain: Callable[
        [dict[str, Any]], Awaitable[dict[str, Any]]
    ] = _default_reconcile,
) -> Issue190Result:
    evidence = DevelopmentEvidence(config.evidence_dir)
    runner = Issue190Runner(
        config,
        checkpoint=checkpoint,
        after_effects_running=after_effects_running,
        evidence=evidence,
        reconcile_uncertain=reconcile_uncertain,
    )
    passed = False
    exit_code = 2
    details: dict[str, Any] = {}
    try:
        details = await runner.run(session)
        passed = True
        exit_code = 0
    except ImmediateStop as error:
        details = {
            "stopReason": "immediate-stop",
            "message": str(error),
            "retryAttempted": False,
        }
        exit_code = 3
    except Issue190Failure as error:
        details = {"failure": str(error)}
        exit_code = 2
    if not passed and runner.lifecycle["created"] == 1:
        runner.lifecycle["active"] = 1
        runner.lifecycle["unclassified"] = 1
    summary = evidence.finish(
        passed=passed,
        public_calls=runner.ledger.public_dict(),
        component_disposition=config.component_disposition,
        aep_lifecycle=runner.lifecycle,
        defect_ledger=runner.defects.public_rows(),
        tool_summary=_plain_tool_summary(runner.tool_summary),
        details={**details, "callSummary": runner.call_summary()},
    )
    return Issue190Result(exit_code=exit_code, summary=summary)


async def completed_checkpoint() -> None:
    return None


async def completed_process_check(value: bool) -> bool:
    return value


def _components(value: str) -> tuple[str, ...]:
    members = tuple(member for member in value.split(",") if member)
    require(bool(members), "component list must not be empty")
    return members


def parse_args(argv: Sequence[str] | None = None) -> Issue190Config:
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
    parser.add_argument(
        "--plugin-url",
        default=os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488"),
    )
    arguments = parser.parse_args(argv)
    return Issue190Config(
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


async def _run_cli(config: Issue190Config) -> int:
    # The existing HDEV session verifies this exact checkout and starts its Core
    # directly; it does not use a stable packaged-runtime launcher.
    async with base_hdev.live_session(config) as session:
        result = await run_issue190_hdev(
            config,
            session=session,
            checkpoint=base_hdev.stdin_checkpoint,
            after_effects_running=base_hdev.formal_ae_running,
        )
    print(
        json.dumps(
            {
                "event": "PASS" if result.exit_code == 0 else "FAIL",
                "validationProfile": "development",
                "candidateRun": False,
                "candidateEvidence": False,
                "publicCalls": result.summary["publicCalls"]["total"],
                "summaryPath": os.fspath(
                    next(
                        config.evidence_dir.glob(
                            f"{result.summary['runId']}.summary.json"
                        )
                    )
                ),
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    return result.exit_code


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(_run_cli(parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
