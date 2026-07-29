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
FIXTURE_ROOT_PARTS = (
    "Library",
    "Application Support",
    "AfterEffectsMCP",
    "fixtures",
)


class Issue190Failure(RuntimeError):
    """The frozen development-smoke contract was not satisfied."""


class ImmediateStop(Issue190Failure):
    """Evidence is no longer safe for a bounded independent-case sweep."""


class UncertainWrite(Issue190Failure):
    """A dispatched write needs frozen public readback and must not be retried."""

    def __init__(
        self,
        *,
        plan_key: str,
        phase: str,
        tool: str,
        arguments: Mapping[str, Any],
        evidence_ids: Sequence[str],
        payload: Mapping[str, Any] | None,
        failing_layer: str,
    ) -> None:
        super().__init__(f"uncertain write at {plan_key}; no retry is permitted")
        self.plan_key = plan_key
        self.phase = phase
        self.tool = tool
        self.arguments = dict(arguments)
        self.evidence_ids = tuple(evidence_ids)
        self.payload = dict(payload or {})
        self.failing_layer = failing_layer


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
    fixture_home: Path
    evidence_dir: Path
    formal_ae_app: Path
    plugin_url: str
    run_id: str = dataclasses.field(
        default_factory=lambda: (
            f"issue190-hdev-{int(time.time())}-{secrets.token_hex(4)}"
        )
    )

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
            self.fixture_home,
            self.evidence_dir,
            self.formal_ae_app,
        ):
            require(path.is_absolute(), "Issue #190 HDEV paths must be absolute")
        require(
            self.run_id.startswith("issue190-hdev-")
            and "/" not in self.run_id
            and "\\" not in self.run_id
            and self.run_id not in {".", ".."},
            "Issue #190 run ID is invalid",
        )
        require(
            not self.fixture_path.is_relative_to(self.checkout),
            "fixture must remain outside the checkout",
        )
        require(
            self.plugin_url.startswith("http://127.0.0.1:"),
            "Issue #190 HDEV plugin URL must be loopback",
        )
    @property
    def fixture_root(self) -> Path:
        return self.fixture_home.joinpath(*FIXTURE_ROOT_PARTS)

    @property
    def active_root(self) -> Path:
        return self.fixture_root / "active"

    @property
    def recovery_root(self) -> Path:
        return self.fixture_root / "recovery"

    @property
    def fixture_path(self) -> Path:
        return self.active_root / f"{self.run_id}.aep"

    @property
    def ownership_manifest_path(self) -> Path:
        return self.active_root / f"{self.run_id}.ownership.json"

    @property
    def owner_marker(self) -> str:
        return f"__AEMCP_ISSUE190_OWNER__:{self.run_id}"

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

    def __init__(self, root: Path, *, run_id: str | None = None) -> None:
        self.root = root
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, stat.S_IRWXU)
        self.run_id = run_id or (
            f"issue190-hdev-{int(time.time())}-{secrets.token_hex(4)}"
        )
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

    require(
        config.ownership_manifest_path.is_file()
        and not config.ownership_manifest_path.is_symlink(),
        "fixture asset generation requires the runner ownership manifest",
    )
    asset_root = config.fixture_path.parent / "assets"
    asset_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not asset_root.is_symlink(), "fixture asset root cannot be a symlink")
    os.chmod(asset_root, stat.S_IRWXU)
    path = asset_root / f"{config.run_id}.wav"
    require(
        not os.path.lexists(path),
        "Issue #190 WAV target must be fresh and absent",
    )
    frames = bytearray()
    for index in range(WAV_SPEC["frameCount"]):
        # A bounded square wave avoids platform-dependent floating-point output.
        sample = 1200 if index % 18 < 9 else -1200
        frames.extend(struct.pack("<h", sample))
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        stat.S_IRUSR | stat.S_IWUSR,
    )
    with os.fdopen(descriptor, "wb") as raw_stream:
        with wave.open(raw_stream, "wb") as stream:
            stream.setnchannels(WAV_SPEC["channels"])
            stream.setsampwidth(WAV_SPEC["sampleWidthBytes"])
            stream.setframerate(WAV_SPEC["sampleRateHz"])
            stream.writeframes(bytes(frames))
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    return path


def fixture_project_guard(
    *,
    project_file: str | None,
    item_count: int,
    owner_marker: str | None,
    expected_fixture: str,
    expected_owner: str,
    target_exists: bool,
) -> str:
    """Model the fail-closed project guard embedded in the fixture JSX."""

    if (
        project_file == expected_fixture
        and owner_marker == expected_owner
        and target_exists
    ):
        return "reuse-owned-fixture"
    if project_file is not None or item_count != 0:
        return "block-production-project"
    if target_exists:
        return "block-existing-target"
    return "close-empty-and-create"


def fixture_create_script(config: Issue190Config, wav_path: Path) -> str:
    """Return fail-closed ES3 that can create only the runner-owned fixture."""

    fixture_literal = json.dumps(os.fspath(config.fixture_path), ensure_ascii=True)
    manifest_literal = json.dumps(
        os.fspath(config.ownership_manifest_path), ensure_ascii=True
    )
    wav_literal = json.dumps(os.fspath(wav_path), ensure_ascii=True)
    run_literal = json.dumps(config.run_id, ensure_ascii=True)
    owner_literal = json.dumps(config.owner_marker, ensure_ascii=True)
    return (
        "(function () {\n"
        "  var fixtureFile = new File(" + fixture_literal + ");\n"
        "  var manifestFile = new File(" + manifest_literal + ");\n"
        "  var wavFile = new File(" + wav_literal + ");\n"
        "  var expectedRunId = " + run_literal + ";\n"
        "  var expectedOwner = " + owner_literal + ";\n"
        "  var manifestText = '';\n"
        "  var manifest;\n"
        "  var currentFile;\n"
        "  var currentOwner = null;\n"
        "  var itemIndex;\n"
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
        "  if (!manifestFile.exists || !manifestFile.open('r')) {\n"
        "    return JSON.stringify({ok:false,error:'ownership-manifest-missing'});\n"
        "  }\n"
        "  manifestText = manifestFile.read(); manifestFile.close();\n"
        "  try { manifest = JSON.parse(manifestText); } catch (manifestError) {\n"
        "    return JSON.stringify({ok:false,error:'ownership-manifest-invalid'});\n"
        "  }\n"
        "  if (manifest.runId !== expectedRunId"
        " || manifest.lifecycle !== 'ephemeral-validation'"
        " || manifest.fixturePath !== fixtureFile.fsName) {\n"
        "    return JSON.stringify({ok:false,error:'ownership-manifest-mismatch'});\n"
        "  }\n"
        "  if (app.project !== null) {\n"
        "    currentFile = app.project.file;\n"
        "    for (itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {\n"
        "      if (app.project.item(itemIndex).name === expectedOwner) {\n"
        "        currentOwner = expectedOwner;\n"
        "      }\n"
        "    }\n"
        "    if (currentFile !== null && currentFile.fsName === fixtureFile.fsName"
        " && currentOwner === expectedOwner && fixtureFile.exists) {\n"
        "      return JSON.stringify({ok:true,reused:true,owner:expectedOwner,"
        "lifecycle:'ephemeral-validation',active:1,saveAsCopies:0});\n"
        "    }\n"
        "    if (currentFile !== null || app.project.numItems !== 0) {\n"
        "      return JSON.stringify({ok:false,error:'block-production-project'});\n"
        "    }\n"
        "  }\n"
        "  if (fixtureFile.exists) {\n"
        "    return JSON.stringify({ok:false,error:'block-existing-target'});\n"
        "  }\n"
        "  if (app.project !== null) {\n"
        "    app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);\n"
        "  }\n"
        "  project = app.newProject();\n"
        "  project.items.addFolder(expectedOwner);\n"
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
        "  return JSON.stringify({ok:true,reused:false,owner:expectedOwner,"
        "lifecycle:'ephemeral-validation',active:1,saveAsCopies:0});\n"
        "}())"
    )


def undo_gui_action(count: int) -> dict[str, Any]:
    require(count in {1, 2}, "harness Undo count is invalid")
    return {
        "application": "Adobe After Effects 2026",
        "key": "Cmd+Z",
        "repeat": count,
    }


def close_fixture_script(config: Issue190Config) -> str:
    fixture_literal = json.dumps(os.fspath(config.fixture_path), ensure_ascii=True)
    owner_literal = json.dumps(config.owner_marker, ensure_ascii=True)
    return (
        "(function () {\n"
        "  var expected = new File(" + fixture_literal + ");\n"
        "  var expectedOwner = " + owner_literal + ";\n"
        "  var ownerFound = false;\n"
        "  var itemIndex;\n"
        "  if (app.project === null || app.project.file === null"
        " || app.project.file.fsName !== expected.fsName) {\n"
        "    return JSON.stringify({ok:false,error:'wrong-fixture'});\n"
        "  }\n"
        "  for (itemIndex = 1; itemIndex <= app.project.numItems; itemIndex += 1) {\n"
        "    if (app.project.item(itemIndex).name === expectedOwner) { ownerFound = true; }\n"
        "  }\n"
        "  if (!ownerFound) { return JSON.stringify({ok:false,error:'wrong-owner'}); }\n"
        "  app.project.save();\n"
        "  app.project.close(CloseOptions.SAVE_CHANGES);\n"
        "  return JSON.stringify({ok:true,owner:expectedOwner,active:0,saveAsCopies:0});\n"
        "}())"
    )


@dataclasses.dataclass
class PendingWrite:
    key: str
    phase: str
    tool: str
    arguments: dict[str, Any]
    evidence_ids: tuple[str, ...]
    payload: dict[str, Any]
    uncertain: bool = False
    failing_layer: str = "none"


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
    _WRITE_VERIFICATION_GROUPS = {
        "source-replace-a-to-b": (
            "source-reacquire-project",
            "source-reacquire-layers",
            "source-read-b",
        ),
        "source-replace-completed-replay": (
            "source-reacquire-project",
            "source-reacquire-layers",
            "source-read-b",
        ),
        "matte-set-alpha": ("matte-read-alpha",),
        "matte-reorder-source": ("matte-read-after-reorder",),
        "matte-set-luma": ("matte-read-luma",),
        "matte-clear": ("matte-read-cleared-luma",),
        "audio-disable": ("audio-disable-read",),
        "video-disable": ("video-disable-read",),
    }
    _UNCERTAIN_STATE_READS = {
        "source-replace-a-to-b": (
            "source-reacquire-project",
            "source-reacquire-layers",
            "source-read-b",
        ),
        "source-replace-completed-replay": (
            "source-reacquire-project",
            "source-reacquire-layers",
            "source-read-b",
        ),
        "matte-set-alpha": ("matte-read-alpha",),
        "matte-reorder-source": ("matte-read-after-reorder",),
        "matte-set-luma": ("matte-read-luma",),
        "matte-clear": ("matte-read-cleared-luma",),
        "audio-disable": ("audio-disable-read",),
        "video-disable": ("video-disable-read",),
    }
    _UNCERTAIN_STATE_KEY = {
        "source-replace-a-to-b": "source-read-b",
        "source-replace-completed-replay": "source-read-b",
        "matte-set-alpha": "matte-read-alpha",
        "matte-reorder-source": "matte-read-after-reorder",
        "matte-set-luma": "matte-read-luma",
        "matte-clear": "matte-read-cleared-luma",
        "audio-disable": "audio-disable-read",
        "video-disable": "video-disable-read",
    }
    _WRITE_RECOVERY = {
        "source-replace-a-to-b": (
            "undo-source-replace",
            "ae_setLayerSource",
            1,
            (
                "source-undo-reacquire-project",
                "source-undo-reacquire-layers",
                "source-undo-read-a",
            ),
        ),
        "source-replace-completed-replay": (
            "undo-source-replace",
            "ae_setLayerSource",
            1,
            (
                "source-undo-reacquire-project",
                "source-undo-reacquire-layers",
                "source-undo-read-a",
            ),
        ),
        "matte-set-alpha": (
            "undo-matte-alpha-recovery",
            "ae_setLayerTrackMatte",
            1,
            (
                "matte-set-undo-reacquire-project",
                "matte-set-undo-reacquire-layers",
                "matte-set-undo-read-empty",
            ),
        ),
        "matte-reorder-source": (
            "undo-matte-reorder-and-set",
            "ae_setLayerTrackMatte",
            2,
            (
                "matte-set-undo-reacquire-project",
                "matte-set-undo-reacquire-layers",
                "matte-set-undo-read-empty",
            ),
        ),
        "matte-set-luma": (
            "undo-matte-luma-recovery",
            "ae_setLayerTrackMatte",
            1,
            (
                "matte-clear-undo-reacquire-project",
                "matte-clear-undo-reacquire-layers",
                "matte-clear-undo-read-luma",
            ),
        ),
        "matte-clear": (
            "undo-matte-clear",
            "ae_clearLayerTrackMatte",
            1,
            (
                "matte-clear-undo-reacquire-project",
                "matte-clear-undo-reacquire-layers",
                "matte-clear-undo-read-luma",
            ),
        ),
        "audio-disable": (
            "undo-audio-disable",
            "ae_setLayerAudioEnabled",
            1,
            (
                "audio-undo-reacquire-project",
                "audio-undo-reacquire-layers",
                "audio-undo-read",
            ),
        ),
        "video-disable": (
            "undo-video-disable",
            "ae_setLayerVideoEnabled",
            1,
            (
                "video-undo-reacquire-project",
                "video-undo-reacquire-layers",
                "video-undo-read",
            ),
        ),
    }

    def __init__(
        self,
        config: Issue190Config,
        *,
        checkpoint: Callable[[str, Mapping[str, Any]], Awaitable[None]],
        after_effects_running: Callable[[], Awaitable[bool]],
        evidence: DevelopmentEvidence | None = None,
    ) -> None:
        self.config = config
        self.checkpoint = checkpoint
        self.after_effects_running = after_effects_running
        self.evidence = evidence or DevelopmentEvidence(
            config.evidence_dir, run_id=config.run_id
        )
        require(
            self.evidence.run_id == config.run_id,
            "fixture and evidence run ownership must match",
        )
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
        self.pending_writes: list[PendingWrite] = []
        self.consumed_plan_keys: set[str] = set()
        self.unreconciled_write = False
        self.fixture_baseline_restored = True
        self.lifecycle = {
            "created": 0,
            "canonicalRetained": 0,
            "evidenceSnapshotsRetained": 0,
            "archived": 0,
            "recoveryArchived": 0,
            "active": 0,
            "unclassified": 0,
            "saveAsCopies": 0,
            "baselineRestored": True,
            "dispositionReason": None,
            "cleanupCondition": None,
        }
        self.current_wav_path: Path | None = None

    def _ownership_payload(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
            "runId": self.config.run_id,
            "lifecycle": "ephemeral-validation",
            "ownerMarker": self.config.owner_marker,
            "formalAeApp": os.fspath(self.config.formal_ae_app),
            "fixturePath": os.fspath(self.config.fixture_path),
            "activeRoot": os.fspath(self.config.active_root),
            "recoveryRoot": os.fspath(self.config.recovery_root),
            "evidenceRoot": os.fspath(self.config.evidence_dir),
            "cleanupCondition": (
                "move the owned fixture and manifest to short-lived recovery "
                "after structured evidence or any classified failure"
            ),
        }

    def _validate_fixture_roots(self) -> None:
        try:
            home_info = self.config.fixture_home.lstat()
        except FileNotFoundError as error:
            raise Issue190Failure("fixture home does not exist") from error
        require(
            stat.S_ISDIR(home_info.st_mode)
            and not self.config.fixture_home.is_symlink(),
            "fixture home cannot be a symlink or non-directory",
        )
        require(
            not self.config.active_root.is_relative_to(self.config.checkout),
            "active fixture root escaped into the checkout",
        )
        scan_roots = (
            self.config.fixture_home
            / "Library/Application Support/Adobe/CEP/extensions",
            self.config.fixture_home
            / "Library/Application Support/Adobe/Common/Plug-ins",
            Path("/Library/Application Support/Adobe/CEP/extensions"),
            Path("/Library/Application Support/Adobe/Common/Plug-ins"),
        )
        active = self.config.active_root.resolve(strict=False)
        checkout = self.config.checkout.resolve(strict=False)
        require(
            active != checkout and not active.is_relative_to(checkout),
            "resolved active fixture root escaped into the checkout",
        )
        require(
            not any(
                active == root.resolve(strict=False)
                or active.is_relative_to(root.resolve(strict=False))
                for root in scan_roots
            ),
            "active fixture root is inside an Adobe scan root",
        )
        self.config.active_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        current = self.config.fixture_home
        for part in FIXTURE_ROOT_PARTS + ("active",):
            current /= part
            info = current.lstat()
            require(
                stat.S_ISDIR(info.st_mode) and not current.is_symlink(),
                "canonical fixture root contains a symlink or non-directory",
            )
        os.chmod(self.config.active_root, stat.S_IRWXU)

    def claim_fixture(self) -> Path:
        """Exclusively claim a fresh per-run active slot before any AE action."""

        self._validate_fixture_roots()
        require(
            not os.path.lexists(self.config.fixture_path),
            "Issue #190 fixture target must be fresh and absent",
        )
        manifest_path = self.config.ownership_manifest_path
        try:
            descriptor = os.open(
                manifest_path,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                stat.S_IRUSR | stat.S_IWUSR,
            )
        except FileExistsError as error:
            raise Issue190Failure(
                "Issue #190 ownership manifest already exists"
            ) from error
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(
                self._ownership_payload(),
                stream,
                ensure_ascii=False,
                separators=(",", ":"),
            )
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(manifest_path, stat.S_IRUSR | stat.S_IWUSR)
        self.validate_fixture_ownership(fixture_may_be_absent=True)
        return manifest_path

    def validate_fixture_ownership(self, *, fixture_may_be_absent: bool = False) -> None:
        path = self.config.ownership_manifest_path
        try:
            info = path.lstat()
        except FileNotFoundError as error:
            raise Issue190Failure("Issue #190 ownership manifest is missing") from error
        require(
            stat.S_ISREG(info.st_mode)
            and not path.is_symlink()
            and (
                os.name == "nt"
                or stat.S_IMODE(info.st_mode) == 0o600
            )
            and 0 < info.st_size <= 64 * 1024,
            "Issue #190 ownership manifest is invalid",
        )
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError) as error:
            raise Issue190Failure(
                "Issue #190 ownership manifest is unreadable"
            ) from error
        require(
            payload == self._ownership_payload(),
            "Issue #190 ownership manifest mismatch",
        )
        require(
            self.config.fixture_path.parent == self.config.active_root,
            "Issue #190 fixture path escaped the active root",
        )
        if not fixture_may_be_absent:
            try:
                fixture_info = self.config.fixture_path.lstat()
            except FileNotFoundError as error:
                raise Issue190Failure("Issue #190 owned fixture is missing") from error
            require(
                stat.S_ISREG(fixture_info.st_mode)
                and not self.config.fixture_path.is_symlink(),
                "Issue #190 owned fixture is invalid",
            )

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
            if write:
                raise UncertainWrite(
                    plan_key=case,
                    phase=phase,
                    tool=tool,
                    arguments=arguments,
                    evidence_ids=(request_id, failure_id),
                    payload=None,
                    failing_layer="transport-after-dispatch",
                ) from error
            self.defects.record(
                case,
                status="INDETERMINATE",
                failing_layer="transport-or-ae-process",
                side_effect_state="unknown",
                reconciliation="unavailable",
                dependency_impact=(),
                evidence_ids=(request_id, failure_id),
                message="read transport failed after public dispatch",
            )
            raise ImmediateStop(
                "read transport or AE process failed after dispatch"
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
        self.responses[case] = dict(payload)
        code = error_code(payload)
        if code in {
            "NATIVE_CONTRACT_MISMATCH",
            "NATIVE_PROTOCOL_MISMATCH",
            "BUNDLE_NATIVE_PLUGIN_PROTOCOL_MISMATCH",
            "PROTOCOL_MISMATCH",
        }:
            self.defects.record(
                case,
                status="FAIL",
                failing_layer="component-or-protocol-compatibility",
                side_effect_state=(
                    "not-started"
                    if mapping(
                        payload.get("error"), "incompatible response error missing"
                    ).get("sideEffect")
                    == "not-started"
                    else "unknown"
                ),
                reconciliation="not-required",
                dependency_impact=CASE_DEPENDENCIES.get(phase, ()),
                evidence_ids=(request_id, response_id),
                message=f"{tool} returned incompatible response {code}",
            )
            self.defects.block_dependents(
                phase, reason=f"{phase} stopped on incompatible response {code}"
            )
            raise ImmediateStop(
                f"incompatible component or protocol response from {tool}: {code}"
            )
        if code == "POSSIBLY_SIDE_EFFECTING_FAILURE":
            error = mapping(payload.get("error"), "possible-write error missing")
            details = mapping(error.get("details"), "possible-write identity missing")
            operation_key = arguments.get("idempotency_key")
            reported_key = details.get("idempotencyKey")
            require(
                isinstance(operation_key, str)
                and (reported_key is None or reported_key == operation_key),
                "possible-write operation key drifted",
            )
            raise UncertainWrite(
                plan_key=case,
                phase=phase,
                tool=tool,
                arguments=arguments,
                evidence_ids=(request_id, response_id),
                payload={
                    **dict(payload),
                    "originalOperationKey": operation_key,
                    "reportedOperationId": details.get("operationId"),
                },
                failing_layer="possibly-side-effecting-terminal",
            )
        if expected_error is not None:
            if not is_error or payload.get("ok") is not False:
                self.unreconciled_write = True
                self.fixture_baseline_restored = False
                self.defects.record(
                    case,
                    status="INDETERMINATE",
                    failing_layer="negative-pre-dispatch-guard",
                    side_effect_state="possible",
                    reconciliation="unreconciled",
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
        if key in {
            "fixture-project-items",
            "source-reacquire-project",
            "source-undo-reacquire-project",
            "matte-set-undo-reacquire-project",
            "matte-clear-undo-reacquire-project",
            "audio-undo-reacquire-project",
            "video-undo-reacquire-project",
        }:
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
        elif key == "source-undo-read-a":
            require(value.get("sourceName") == "SOURCE_COMP_A", f"{key} source drifted")
        elif key == "source-read-b":
            require(value.get("sourceName") == "SOURCE_COMP_B", "replacement read drifted")
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
        elif key == "matte-set-undo-read-empty":
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
                    f"Send exactly {count} Command-Z keyboard shortcut(s) to the "
                    "formal After Effects window. Do not invoke Undo from JSX and "
                    "do not retry a write."
                ),
                "guiAction": undo_gui_action(count),
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

    @staticmethod
    def _plan(key: str) -> Any:
        matches = [row for row in CALL_PLAN if row.key == key]
        require(len(matches) == 1, f"frozen plan row {key!r} is missing")
        return matches[0]

    def _record_plan_pass(
        self,
        plan: Any,
        *,
        evidence_ids: Sequence[str] | None = None,
        reconciliation: str | None = None,
    ) -> None:
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
                reconciliation
                or (
                    "public-readback"
                    if plan.disposition in {"read", "write"}
                    else "not-required"
                )
            ),
            dependency_impact=(),
            evidence_ids=(
                tuple(evidence_ids)
                if evidence_ids is not None
                else self.call_evidence.get(plan.key, ())
            ),
            message=plan.predicate,
        )

    async def _dispatch_frozen_read(
        self,
        session: PublicSession,
        key: str,
        *,
        assert_expected: bool,
    ) -> dict[str, Any]:
        plan = self._plan(key)
        require(plan.disposition == "read", f"{key} is not a frozen read")
        require(key not in self.consumed_plan_keys, f"{key} was already consumed")
        arguments = self._resolve(plan.arguments)
        payload = await self.public_call(
            session,
            case=plan.key,
            phase=plan.case,
            tool=plan.tool,
            arguments=arguments,
        )
        self.responses[plan.key] = payload
        if assert_expected:
            self._assert_and_capture(plan.key, payload, arguments)
            self._record_plan_pass(plan)
        self.consumed_plan_keys.add(key)
        return payload

    @staticmethod
    def _audit_outcome(payload: Mapping[str, Any]) -> str:
        audit = payload.get("audit")
        error = payload.get("error")
        details = error.get("details") if isinstance(error, Mapping) else None
        candidates = []
        if isinstance(audit, Mapping):
            candidates.extend((audit.get("outcome"), audit.get("effect")))
        if isinstance(details, Mapping):
            candidates.extend(
                (
                    details.get("auditOutcome"),
                    details.get("operationOutcome"),
                    details.get("outcome"),
                )
            )
        for candidate in candidates:
            if candidate in {"completed", "committed", "after"}:
                return "completed"
            if candidate in {"rejected", "not-started", "before"}:
                return "rejected"
        return "unavailable"

    def _classify_uncertain_state(
        self,
        pending: PendingWrite,
        payload: Mapping[str, Any],
    ) -> str:
        value = mapping(payload.get("value"), "uncertain write readback value missing")
        key = pending.key
        if key.startswith("source-replace"):
            observed = value.get("sourceName")
            return (
                "after"
                if observed == "SOURCE_COMP_B"
                else "before"
                if observed == "SOURCE_COMP_A"
                else "unknown"
            )
        if key == "matte-reorder-source":
            outcome = self._audit_outcome(pending.payload)
            if outcome == "completed":
                return "after"
            return "before" if outcome == "rejected" else "unknown"
        if key == "matte-set-alpha":
            if value.get("active") is False and value.get("matteLayerLocator") is None:
                return "before"
            return (
                "after"
                if value.get("active") is True and value.get("mode") == "alpha"
                else "unknown"
            )
        if key == "matte-set-luma":
            if value.get("active") is False and value.get("matteLayerLocator") is None:
                return "before"
            return (
                "after"
                if value.get("active") is True and value.get("mode") == "luma"
                else "unknown"
            )
        if key == "matte-clear":
            if value.get("active") is True and value.get("mode") == "luma":
                return "before"
            return (
                "after"
                if value.get("active") is False
                and value.get("matteLayerLocator") is None
                and value.get("mode") == "luma"
                else "unknown"
            )
        if key == "audio-disable":
            if value.get("hasAudio") is not True:
                return "unknown"
            if value.get("audioEnabled") is False:
                return "after"
            return "before" if value.get("audioEnabled") is True else "unknown"
        if key == "video-disable":
            if value.get("hasVideo") is not True:
                return "unknown"
            if value.get("videoEnabled") is False:
                return "after"
            return "before" if value.get("videoEnabled") is True else "unknown"
        return "unknown"

    async def _recovery_undo_checkpoint(
        self,
        name: str,
        *,
        tool: str,
        count: int,
    ) -> None:
        await self.checkpoint(
            name,
            {
                "instruction": (
                    "Recovery only: send exactly "
                    f"{count} Command-Z keyboard shortcut(s) to the formal After "
                    "Effects window, then use only frozen public reads to verify "
                    "the fixture baseline. Do not invoke Undo from JSX and do not "
                    "retry the write."
                ),
                "guiAction": undo_gui_action(count),
                "undoCount": count,
                "fixtureLifecycle": "ephemeral-validation",
                "activeFixtureCount": 1,
                "saveAsCopies": 0,
                "validationProfile": "development",
                "candidateRun": False,
                "candidateEvidence": False,
            },
        )
        self._tool_row(tool)["undo"]["executed"] += 1

    async def _recover_committed_write(
        self,
        session: PublicSession,
        pending: PendingWrite,
    ) -> tuple[str, ...]:
        name, tool, count, read_keys = self._WRITE_RECOVERY[pending.key]
        self.fixture_baseline_restored = False
        await self._recovery_undo_checkpoint(name, tool=tool, count=count)
        recovery_ids: list[str] = []
        try:
            for key in read_keys:
                if key in self.consumed_plan_keys:
                    continue
                custom_luma_baseline = (
                    pending.key == "matte-set-luma"
                    and key == "matte-clear-undo-read-luma"
                )
                payload = await self._dispatch_frozen_read(
                    session,
                    key,
                    assert_expected=not custom_luma_baseline,
                )
                if custom_luma_baseline:
                    self._assert_matte(
                        mapping(payload.get("value"), "Luma recovery value missing"),
                        active=False,
                    )
                    self._record_plan_pass(
                        self._plan(key),
                        reconciliation="recovery-baseline-readback",
                    )
                recovery_ids.extend(self.call_evidence.get(key, ()))
        except (ImmediateStop, Issue190Failure) as error:
            self.unreconciled_write = True
            raise ImmediateStop(
                f"{pending.key} recovery baseline could not be verified"
            ) from error
        self.fixture_baseline_restored = True
        self.mark_undo_verified(tool)
        recovery_event = self.evidence.record(
            "write-recovery-verified",
            {
                "case": pending.key,
                "tool": pending.tool,
                "originalOperationKey": pending.arguments.get("idempotency_key"),
                "writeEvidenceIds": list(pending.evidence_ids),
                "readbackEvidenceIds": recovery_ids,
                "baselineRestored": True,
                "retryAttempted": False,
            },
        )
        return (*recovery_ids, recovery_event)

    def _pending_for_verification(self, key: str) -> list[PendingWrite]:
        return [
            pending
            for pending in self.pending_writes
            if key in self._WRITE_VERIFICATION_GROUPS.get(pending.key, ())
        ]

    async def _recover_verification_failure(
        self,
        session: PublicSession,
        failed_key: str,
        error: Exception,
    ) -> bool:
        pending_rows = self._pending_for_verification(failed_key)
        if not pending_rows:
            return False
        plan = self._plan(failed_key)
        self.consumed_plan_keys.add(failed_key)
        self.defects.record(
            failed_key,
            status="FAIL",
            failing_layer="post-write-public-readback",
            side_effect_state="none",
            reconciliation="recovery-required",
            dependency_impact=CASE_DEPENDENCIES.get(plan.case, ()),
            evidence_ids=self.call_evidence.get(failed_key, ()),
            message=str(error),
        )
        recovery_ids = await self._recover_committed_write(
            session, pending_rows[0]
        )
        for pending in pending_rows:
            self._record_pending_failure(
                pending,
                status="FAIL",
                side_effect_state="committed-reconciled",
                reconciliation="readback-failed-restored",
                evidence_ids=(
                    *pending.evidence_ids,
                    *self.call_evidence.get(failed_key, ()),
                    *recovery_ids,
                ),
                message=(
                    f"{failed_key} failed within the ordered verification group; "
                    "associated Undo restored and verified the baseline"
                ),
            )
            self.pending_writes.remove(pending)
        return True

    def _record_pending_failure(
        self,
        pending: PendingWrite,
        *,
        status: str,
        side_effect_state: str,
        reconciliation: str,
        evidence_ids: Sequence[str],
        message: str,
    ) -> None:
        self.defects.record(
            pending.key,
            status=status,
            failing_layer=pending.failing_layer,
            side_effect_state=side_effect_state,
            reconciliation=reconciliation,
            dependency_impact=CASE_DEPENDENCIES.get(pending.phase, ()),
            evidence_ids=evidence_ids,
            message=message,
        )
        self.defects.block_dependents(
            pending.phase, reason=f"{pending.phase} failed at {pending.key}"
        )

    def _stop_uncertain_negative(self, error: UncertainWrite) -> None:
        self.unreconciled_write = True
        self.fixture_baseline_restored = False
        self.defects.record(
            error.plan_key,
            status="INDETERMINATE",
            failing_layer=error.failing_layer,
            side_effect_state="possible",
            reconciliation="unreconciled-no-frozen-read",
            dependency_impact=(),
            evidence_ids=error.evidence_ids,
            message=(
                "negative mutating probe became uncertain and has no frozen "
                "state read; no retry attempted"
            ),
        )
        raise ImmediateStop(
            f"uncertain negative write at {error.plan_key}; preserve fixture"
        )

    async def _reconcile_uncertain_write(
        self,
        session: PublicSession,
        pending: PendingWrite,
    ) -> str:
        state_key = self._UNCERTAIN_STATE_KEY[pending.key]
        read_ids: list[str] = []
        state_payload: dict[str, Any] | None = None
        try:
            for key in self._UNCERTAIN_STATE_READS[pending.key]:
                if key in self.consumed_plan_keys:
                    continue
                payload = await self._dispatch_frozen_read(
                    session,
                    key,
                    assert_expected=key != state_key,
                )
                read_ids.extend(self.call_evidence.get(key, ()))
                if key == state_key:
                    state_payload = payload
                    state = self._classify_uncertain_state(pending, payload)
                    if state == "after":
                        self._assert_and_capture(
                            key, payload, self._resolve(self._plan(key).arguments)
                        )
                        self._record_plan_pass(
                            self._plan(key),
                            reconciliation="uncertain-write-state-readback",
                        )
                    elif state == "before":
                        observed_value = mapping(
                            payload.get("value"),
                            "uncertain before-state readback value missing",
                        )
                        self.defects.record(
                            key,
                            status="FAIL",
                            failing_layer="uncertain-write-state-readback",
                            side_effect_state="none",
                            reconciliation="observed-before-not-after",
                            dependency_impact=CASE_DEPENDENCIES.get(
                                self._plan(key).case, ()
                            ),
                            evidence_ids=self.call_evidence.get(key, ()),
                            message=(
                                "frozen after-state predicate was not satisfied; "
                                f"observed before state {observed_value!r}"
                            ),
                        )
                        break
                    else:
                        break
        except (ImmediateStop, Issue190Failure):
            state = "unknown"
        else:
            state = (
                self._classify_uncertain_state(pending, state_payload)
                if state_payload is not None
                else "unknown"
            )
        reconciliation_event = self.evidence.record(
            "uncertain-write-reconciled",
            {
                "case": pending.key,
                "tool": pending.tool,
                "state": state,
                "auditOutcome": self._audit_outcome(pending.payload),
                "originalOperationKey": pending.arguments.get("idempotency_key"),
                "reportedOperationId": pending.payload.get("reportedOperationId"),
                "writeEvidenceIds": list(pending.evidence_ids),
                "readbackEvidenceIds": read_ids,
                "retryAttempted": False,
            },
        )
        evidence_ids = (*pending.evidence_ids, *read_ids, reconciliation_event)
        if state == "before":
            self._record_pending_failure(
                pending,
                status="FAIL",
                side_effect_state="not-started",
                reconciliation="not-occurred-reconciled",
                evidence_ids=evidence_ids,
                message="uncertain write did not occur; original operation was not retried",
            )
            return "not-occurred-reconciled"
        if state == "after":
            recovery_ids = await self._recover_committed_write(session, pending)
            self._record_pending_failure(
                pending,
                status="FAIL",
                side_effect_state="committed-reconciled",
                reconciliation="committed-reconciled-and-restored",
                evidence_ids=(*evidence_ids, *recovery_ids),
                message="uncertain write committed, was not retried, and was undone",
            )
            return "committed-reconciled"
        self.unreconciled_write = True
        self.fixture_baseline_restored = False
        self._record_pending_failure(
            pending,
            status="INDETERMINATE",
            side_effect_state="possible",
            reconciliation="unreconciled",
            evidence_ids=evidence_ids,
            message="write state and audit could not be reconciled; no retry attempted",
        )
        raise ImmediateStop(
            f"unreconciled possible write at {pending.key}; preserve fixture"
        )

    async def execute_plan(self, session: PublicSession) -> None:
        require(
            REQUIRED_PUBLIC_TOOLS <= session.tool_names,
            "Issue #190 HDEV public tool set is incomplete",
        )
        failed_cases: set[str] = set()
        for plan in CALL_PLAN:
            if plan.key in self.consumed_plan_keys:
                continue
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
                if plan.disposition == "write" and plan.expected_error is None:
                    self.pending_writes.append(
                        PendingWrite(
                            key=plan.key,
                            phase=plan.case,
                            tool=plan.tool,
                            arguments=dict(arguments),
                            evidence_ids=self.call_evidence.get(plan.key, ()),
                            payload=dict(payload),
                        )
                    )
                else:
                    self._record_plan_pass(plan)
                verified = [
                    pending
                    for pending in self.pending_writes
                    if self._WRITE_VERIFICATION_GROUPS.get(pending.key, ())[-1:]
                    == (plan.key,)
                ]
                for pending in verified:
                    write_plan = self._plan(pending.key)
                    self._record_plan_pass(
                        write_plan,
                        evidence_ids=(
                            *pending.evidence_ids,
                            *self.call_evidence.get(plan.key, ()),
                        ),
                        reconciliation="public-readback",
                    )
                    self.pending_writes.remove(pending)
                if plan.key in self._UNDO_VERIFY_TOOL and not verified:
                    self.mark_undo_verified(self._UNDO_VERIFY_TOOL[plan.key])
            except UncertainWrite as error:
                if plan.expected_error is not None:
                    self._stop_uncertain_negative(error)
                pending = PendingWrite(
                    key=plan.key,
                    phase=plan.case,
                    tool=plan.tool,
                    arguments=dict(arguments),
                    evidence_ids=error.evidence_ids,
                    payload=error.payload,
                    uncertain=True,
                    failing_layer=error.failing_layer,
                )
                await self._reconcile_uncertain_write(session, pending)
                failed_cases.add(plan.case)
                failed_cases.update(CASE_DEPENDENCIES.get(plan.case, ()))
            except ImmediateStop as error:
                if not await self._recover_verification_failure(
                    session, plan.key, error
                ):
                    raise
                failed_cases.add(plan.case)
                failed_cases.update(CASE_DEPENDENCIES.get(plan.case, ()))
            except Issue190Failure as error:
                if await self._recover_verification_failure(
                    session, plan.key, error
                ):
                    failed_cases.add(plan.case)
                    failed_cases.update(CASE_DEPENDENCIES.get(plan.case, ()))
                    continue
                if plan.expected_error is not None:
                    payload = self.responses.get(plan.key, {})
                    structured_error = payload.get("error")
                    side_effect = (
                        structured_error.get("sideEffect")
                        if isinstance(structured_error, Mapping)
                        else None
                    )
                    if side_effect != "not-started":
                        self.unreconciled_write = True
                        self.fixture_baseline_restored = False
                        raise ImmediateStop(
                            f"negative write contract failed at {plan.key}; "
                            "preserve fixture"
                        ) from error
                    failed_cases.add(plan.case)
                    self.defects.record(
                        plan.key,
                        status="FAIL",
                        failing_layer="negative-write-contract",
                        side_effect_state="not-started",
                        reconciliation="not-required",
                        dependency_impact=(),
                        evidence_ids=self.call_evidence.get(plan.key, ()),
                        message=str(error),
                    )
                    continue
                if plan.disposition == "write":
                    pending = PendingWrite(
                        key=plan.key,
                        phase=plan.case,
                        tool=plan.tool,
                        arguments=dict(arguments),
                        evidence_ids=self.call_evidence.get(plan.key, ()),
                        payload=self.responses.get(plan.key, {}),
                        uncertain=True,
                        failing_layer="write-contract-after-dispatch",
                    )
                    await self._reconcile_uncertain_write(session, pending)
                    failed_cases.add(plan.case)
                    failed_cases.update(CASE_DEPENDENCIES.get(plan.case, ()))
                    continue
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
                if "reacquire" in plan.key or plan.key.startswith("fixture-"):
                    raise ImmediateStop(
                        f"fixture baseline or write evidence became untrustworthy at {plan.key}"
                    ) from error
        require(
            not self.pending_writes,
            "one or more writes ended without their frozen public readback",
        )
        if not failed_cases:
            require(self.ledger.total == CALL_HARD_LIMIT, "Issue #190 call count drifted")
        require(
            all(row["status"] == "PASS" for row in self.defects.public_rows()),
            "bounded Issue #190 defect sweep found failures or blocked cases",
        )

    async def _move_owned_fixture(
        self,
        wav_path: Path | None,
        *,
        reason: str = "structured development evidence complete",
        evidence_snapshot: bool = False,
        baseline_restored: bool = True,
    ) -> Path:
        self.validate_fixture_ownership()
        self.config.recovery_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.config.recovery_root, stat.S_IRWXU)
        require(
            not self.config.recovery_root.is_symlink(),
            "Issue #190 recovery root cannot be a symlink",
        )
        run_directory = self.config.recovery_root / self.config.run_id
        require(
            not os.path.lexists(run_directory),
            "Issue #190 recovery run directory already exists",
        )
        run_directory.mkdir(mode=0o700, parents=False)
        destination = run_directory / self.config.fixture_path.name
        manifest_destination = (
            run_directory / self.config.ownership_manifest_path.name
        )
        shutil.move(os.fspath(self.config.fixture_path), os.fspath(destination))
        shutil.move(
            os.fspath(self.config.ownership_manifest_path),
            os.fspath(manifest_destination),
        )
        if wav_path is not None and wav_path.is_file():
            shutil.move(os.fspath(wav_path), os.fspath(run_directory / wav_path.name))
        cleanup_condition = (
            "retain while the unresolved write is investigated; remove after "
            "structured state/audit evidence resolves the operation"
            if evidence_snapshot
            else "remove after the development failure or evidence has been reviewed"
        )
        disposition = {
            "schemaVersion": 1,
            "validationProfile": "development",
            "candidateRun": False,
            "candidateEvidence": False,
            "runId": self.config.run_id,
            "lifecycle": "ephemeral-validation",
            "reason": reason,
            "baselineRestored": baseline_restored,
            "evidenceSnapshot": evidence_snapshot,
            "fixtureName": destination.name,
            "ownershipManifestName": manifest_destination.name,
            "cleanupCondition": cleanup_condition,
        }
        disposition_path = run_directory / "recovery-disposition.json"
        descriptor = os.open(
            disposition_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            stat.S_IRUSR | stat.S_IWUSR,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(disposition, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        self.lifecycle.update(
            {
                "evidenceSnapshotsRetained": 1 if evidence_snapshot else 0,
                "archived": 1,
                "recoveryArchived": 1,
                "active": 0,
                "unclassified": 0,
                "baselineRestored": baseline_restored,
                "dispositionReason": reason,
                "cleanupCondition": cleanup_condition,
            }
        )
        return destination

    async def _after_effects_is_running(self) -> bool:
        try:
            return await self.after_effects_running()
        except Exception as error:
            raise Issue190Failure(
                "could not confirm whether After Effects exited normally"
            ) from error

    async def _move_manifest_only(self, reason: str) -> dict[str, Any]:
        self.config.recovery_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        run_directory = self.config.recovery_root / self.config.run_id
        require(
            not os.path.lexists(run_directory),
            "Issue #190 manifest recovery directory already exists",
        )
        run_directory.mkdir(mode=0o700, parents=False)
        shutil.move(
            os.fspath(self.config.ownership_manifest_path),
            os.fspath(run_directory / self.config.ownership_manifest_path.name),
        )
        cleanup = "remove after the missing-fixture failure has been reviewed"
        self.lifecycle.update(
            {
                "active": 0,
                "unclassified": 0,
                "recoveryArchived": 1,
                "baselineRestored": self.fixture_baseline_restored,
                "dispositionReason": reason,
                "cleanupCondition": cleanup,
            }
        )
        return {
            "disposition": "manifest-only-recovery",
            "reason": reason,
            "cleanupCondition": cleanup,
        }

    async def finalize_owned_fixture(
        self,
        reason: str,
        *,
        evidence_snapshot: bool | None = None,
        baseline_restored: bool | None = None,
    ) -> dict[str, Any]:
        """Apply the only ownership-aware fixture finalization state machine."""

        manifest_exists = os.path.lexists(self.config.ownership_manifest_path)
        fixture_exists = os.path.lexists(self.config.fixture_path)
        if not manifest_exists and not fixture_exists:
            require(
                self.lifecycle["created"] == 0,
                "recorded Issue #190 fixture disappeared before finalization",
            )
            self.lifecycle.update(
                {
                    "active": 0,
                    "unclassified": 0,
                    "baselineRestored": self.fixture_baseline_restored,
                    "dispositionReason": "failure occurred before fixture ownership",
                    "cleanupCondition": "none",
                }
            )
            return {"disposition": "no-fixture-owned"}
        require(
            manifest_exists,
            "Issue #190 fixture exists without its ownership manifest",
        )
        self.validate_fixture_ownership(
            fixture_may_be_absent=not fixture_exists
        )
        initially_running = await self._after_effects_is_running()
        if not fixture_exists:
            require(
                not initially_running,
                "fixture is missing while After Effects remains running",
            )
            return await self._move_manifest_only(reason)

        if initially_running:
            await self.checkpoint(
                "guarded-close-and-normal-exit-issue190-fixture",
                {
                    "instruction": (
                        "Run the ownership-guarded save-in-place/close script "
                        "through ae_readProps without an extra Undo group, then "
                        "quit After Effects normally. Do not force quit, kill the "
                        "process, reset, delete, Save As, or retry any write."
                    ),
                    "executionTool": "ae_readProps",
                    "undoGroup": False,
                    "script": close_fixture_script(self.config),
                    "fixtureLifecycle": "ephemeral-validation",
                    "preserveUnreconciledWrite": self.unreconciled_write,
                    "validationProfile": "development",
                    "candidateRun": False,
                    "candidateEvidence": False,
                },
            )
            if await self._after_effects_is_running():
                raise Issue190Failure(
                    "After Effects remained running after normal exit; forced "
                    "termination is disabled"
                )
        snapshot = (
            self.unreconciled_write
            if evidence_snapshot is None
            else evidence_snapshot
        )
        restored = (
            self.fixture_baseline_restored
            if baseline_restored is None
            else baseline_restored
        )
        process_gone_without_recovery = (
            not initially_running and snapshot and not restored
        )
        archive = await self._move_owned_fixture(
            self.current_wav_path,
            reason=reason,
            evidence_snapshot=snapshot,
            baseline_restored=restored,
        )
        disposition = "evidence-snapshot" if snapshot else "short-lived-recovery"
        return {
            "disposition": disposition,
            "archiveName": archive.name,
            "reason": reason,
            "baselineRestored": restored,
            "aeProcessGoneWithoutRecovery": process_gone_without_recovery,
            "cleanupCondition": self.lifecycle["cleanupCondition"],
        }

    async def finalize_failure(self, reason: str) -> dict[str, Any]:
        return await self.finalize_owned_fixture(reason)

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
        self.claim_fixture()
        wav_path = generate_fixture_wav(self.config)
        self.current_wav_path = wav_path
        await self.checkpoint(
            "create-or-reset-issue190-fixture",
            {
                "instruction": (
                    "In formal After Effects, run this exact harness-only script "
                    "through ae_readProps without an extra Undo group. It creates or "
                    "resets the one disposable fixture and saves it once."
                ),
                "executionTool": "ae_readProps",
                "undoGroup": False,
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
        fixture_disposition = await self.finalize_owned_fixture(
            reason="structured development evidence complete",
            evidence_snapshot=False,
            baseline_restored=True,
        )
        archive_id = self.evidence.record(
            "fixture-archived",
            {
                "lifecycle": "ephemeral-validation",
                "archiveName": fixture_disposition["archiveName"],
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
            "fixtureDisposition": fixture_disposition,
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
) -> Issue190Result:
    evidence = DevelopmentEvidence(config.evidence_dir, run_id=config.run_id)
    runner = Issue190Runner(
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
    except Exception as error:
        details = {
            "failure": str(error),
            "failureType": type(error).__name__,
        }
        exit_code = 2
    if not passed:
        failure_reason = str(
            details.get("message", details.get("failure", "Issue #190 HDEV failed"))
        )
        details["fixtureDisposition"] = await runner.finalize_failure(
            failure_reason
        )
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
        fixture_home=Path.home(),
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
