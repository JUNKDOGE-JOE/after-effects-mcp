"""Construction tests for the seven-call non-candidate HDEV driver."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest


ROOT = Path(__file__).resolve().parents[3]
HARDWARE = ROOT / "scripts/hardware"


def _load(name: str, path: Path) -> ModuleType:
    module_spec = importlib.util.spec_from_file_location(name, path)
    assert module_spec is not None and module_spec.loader is not None
    module = importlib.util.module_from_spec(module_spec)
    sys.modules[name] = module
    module_spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(HARDWARE))
spec = _load("development_smoke_spec", HARDWARE / "development_smoke_spec.py")
driver = _load("development_smoke", HARDWARE / "development_smoke.py")

HOST = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
PROJECT = "33333333-3333-4333-8333-333333333333"
COMP = "44444444-4444-4444-8444-444444444444"
DIGEST = "a" * 64


def _locator(*, generation: int = 1) -> dict:
    return {
        "kind": "composition",
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": COMP,
    }


def _time(value: int, scale: int) -> dict:
    from fractions import Fraction

    return {
        "value": value,
        "scale": scale,
        "secondsRational": str(Fraction(value, scale)),
    }


def _ratio(numerator: int, denominator: int) -> dict:
    from fractions import Fraction

    return {
        "numerator": numerator,
        "denominator": denominator,
        "rational": str(Fraction(numerator, denominator)),
    }


def _settings(color: dict, *, generation: int = 1) -> dict:
    return {
        "name": "HDEV Core Native Fixture",
        "width": 640,
        "height": 360,
        "duration": _time(5, 1),
        "frameDuration": _time(1, 24),
        "frameRate": _ratio(24, 1),
        "pixelAspectRatio": _ratio(1, 1),
        "backgroundColor": dict(color),
        "workArea": {"start": _time(0, 1), "duration": _time(5, 1)},
        "displayStartTime": _time(0, 1),
        "layerCount": 0,
        "compositionLocator": _locator(generation=generation),
    }


def _payload(capability: str, value: dict, *, write: bool = False) -> dict:
    request_id = f"mcp-{capability.replace('.', '-')}"
    postcondition = {
        "verified": True,
        "kind": f"{capability}-postcondition",
        "algorithm": "sha256-rfc8785-jcs-v1",
        "digest": DIGEST,
    }
    evidence = {
        "engine": "native-aegp",
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "requestId": request_id,
        "capabilityId": capability,
        "capabilityVersion": 1,
        "startedAtUnixMs": 1,
        "completedAtUnixMs": 2,
        "effect": "committed" if write else "none",
        "requestDigest": "b" * 64,
        "postcondition": postcondition,
    }
    if write:
        evidence["undo"] = {"available": True, "verified": False}
    return {
        "ok": True,
        **({"replayed": False} if write else {}),
        "value": value,
        "implementation": {
            "engine": "native-aegp",
            "capabilityId": capability,
            "capabilityVersion": 1,
            "contractDigest": DIGEST,
            "risk": "write" if write else "read",
            "mutability": "mutating" if write else "read-only",
            "idempotency": "required" if write else "not-applicable",
            **({"undo": "single-group"} if write else {}),
        },
        "provenance": {
            "engine": "native-aegp",
            "selectedWireVersion": 1,
            "pluginVersion": "0.9.2",
            "compiledSdkVersion": "2026",
            "sourceCommit": "c" * 40,
            "hostInstanceId": HOST,
            "sessionId": SESSION,
            "sessionGeneration": 1,
            "capabilitiesDigest": "d" * 64,
        },
        "audit": {
            "requestId": request_id,
            **({"evidenceRequestId": request_id} if write else {}),
            **({"idempotencyKey": "fixture-key", "replayed": False} if write else {}),
            "capabilityId": capability,
            "capabilityVersion": 1,
            "contractDigest": DIGEST,
            "effect": "committed" if write else "none",
            "requestDigest": "b" * 64,
            "postconditionAlgorithm": "sha256-rfc8785-jcs-v1",
            "postconditionDigest": DIGEST,
            **({"undoAvailable": True, "undoVerified": False} if write else {}),
            "startedAtUnixMs": 1,
            "completedAtUnixMs": 2,
        },
        "evidence": evidence,
    }


def _responses() -> list[tuple[bool, dict]]:
    baseline = _settings(spec.BASELINE_COLOR)
    changed = _settings(spec.CHANGED_COLOR)
    restored = _settings(spec.BASELINE_COLOR, generation=2)
    return [
        (False, _payload(
            "ae.project.summary",
            {"projectOpen": True, "projectName": "dev.aep", "itemCount": 0},
        )),
        (False, _payload(
            "ae.composition.create",
            {
                "changed": True,
                "name": "HDEV Core Native Fixture",
                "compositionLocator": _locator(),
                "projectItemCountBefore": 1,
                "projectItemCountAfter": 2,
                "layerCount": 0,
                "width": 640,
                "height": 360,
                "duration": _time(5, 1),
                "frameRate": _ratio(24, 1),
                "pixelAspectRatio": _ratio(1, 1),
            },
            write=True,
        )),
        (False, _payload("ae.composition.settings.read", baseline)),
        (False, _payload(
            "ae.composition.background-color.set",
            {
                "changed": True,
                "compositionLocator": _locator(),
                "before": baseline,
                "after": changed,
            },
            write=True,
        )),
        (False, _payload("ae.composition.settings.read", changed)),
        (False, _payload(
            "ae.project.items.list",
            {
                "projectLocator": {
                    **_locator(generation=2),
                    "kind": "project",
                    "objectId": PROJECT,
                },
                "total": 1,
                "offset": 0,
                "limit": 50,
                "returned": 1,
                "hasMore": False,
                "nextOffset": None,
                "items": [{
                    "locator": _locator(generation=2),
                    "name": "HDEV Core Native Fixture",
                    "type": "composition",
                    "parentLocator": None,
                }],
            },
        )),
        (False, _payload("ae.composition.settings.read", restored)),
    ]


class FakeSession:
    def __init__(self, responses: list[tuple[bool, dict]]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []
        self.tool_names = frozenset(tool for _, tool in spec.CALLS)

    async def call(self, tool: str, arguments: dict):
        self.calls.append((tool, arguments))
        return self.responses.pop(0)


def _config(tmp_path: Path) -> object:
    fixture = tmp_path / "active" / "dev.aep"
    fixture.parent.mkdir()
    fixture.write_bytes(b"fixture")
    return driver.DevelopmentSmokeConfig(
        scenario=spec.SCENARIO_ID,
        selected_components=("core",),
        reused_components=("cep", "native"),
        checkout=ROOT,
        fixture_path=fixture,
        recovery_root=tmp_path / "recovery",
        evidence_dir=tmp_path / "evidence",
        formal_ae_app=Path(
            "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
        ),
        plugin_url="http://127.0.0.1:11488",
    )


@pytest.mark.asyncio
async def test_hdev_runs_exactly_seven_calls_real_undo_and_one_archive(tmp_path):
    session = FakeSession(_responses())
    checkpoints: list[tuple[str, dict]] = []
    config = _config(tmp_path)

    async def checkpoint(kind: str, details: dict) -> None:
        checkpoints.append((kind, details))

    async def ae_running() -> bool:
        return False

    result = await driver.run_development_smoke(
        config,
        session=session,
        checkpoint=checkpoint,
        after_effects_running=ae_running,
    )

    assert result.exit_code == 0
    assert result.summary["passed"] is True
    assert result.summary["publicCalls"]["total"] == 7
    assert [tool for tool, _ in session.calls] == [tool for _, tool in spec.CALLS]
    assert session.calls[1] == ("ae_createComposition", {
        "name": "HDEV Core Native Fixture",
        "width": 640,
        "height": 360,
        "duration": {"value": 5, "scale": 1},
        "frame_rate": {"numerator": 24, "denominator": 1},
        "pixel_aspect_ratio": {"numerator": 1, "denominator": 1},
        "idempotency_key": "hdev-core-native-composition-0001",
    })
    assert session.calls[3][0] == "ae_setCompositionBackgroundColor"
    assert session.calls[3][1]["background_color"] == spec.CHANGED_COLOR
    assert [kind for kind, _ in checkpoints] == [
        "save-empty-project",
        "undo-background-change",
        "close-formal-ae",
    ]
    assert result.summary["aepLifecycle"] == {
        "created": 1,
        "canonicalRetained": 0,
        "evidenceSnapshotsRetained": 0,
        "archived": 1,
        "unclassified": 0,
        "saveAsCopies": 0,
    }
    assert len(list((tmp_path / "recovery").glob("*.aep"))) == 1
    assert not config.fixture_path.exists()


@pytest.mark.asyncio
async def test_uncertain_write_stops_with_exit_three_without_retry(tmp_path):
    responses = _responses()
    responses[3] = (True, {
        "ok": False,
        "error": {
            "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "sideEffect": "may-have-occurred",
        },
    })
    session = FakeSession(responses)

    result = await driver.run_development_smoke(
        _config(tmp_path),
        session=session,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    assert result.exit_code == 3
    assert result.summary["passed"] is False
    assert result.summary["stopReason"] == "possibly-side-effecting"
    assert len(session.calls) == 4
    assert [tool for tool, _ in session.calls].count(
        "ae_setCompositionBackgroundColor"
    ) == 1


@pytest.mark.asyncio
async def test_call_budget_stops_before_call_eight(tmp_path):
    session = FakeSession(_responses())
    runner = driver.DevelopmentSmokeRunner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.ledger.total = spec.CALL_HARD_LIMIT

    with pytest.raises(driver.DevelopmentSmokeFailure, match="budget exhausted"):
        await runner.public_call(session, "overflow", "ae_projectSummary", {})
    assert session.calls == []


def test_candidate_evidence_is_permanently_false_and_files_are_private(tmp_path):
    evidence = driver.DevelopmentEvidence(tmp_path / "evidence")
    evidence.record("probe", {"value": 1})
    summary = evidence.finish(
        passed=True,
        public_calls={
            "target": 7, "hardLimit": 7, "total": 7,
            "byTool": {}, "byPhase": {},
        },
        component_disposition={
            "selected": ["core"], "reused": ["cep", "native"],
        },
        aep_lifecycle={
            "created": 1, "canonicalRetained": 0,
            "evidenceSnapshotsRetained": 0, "archived": 1,
            "unclassified": 0, "saveAsCopies": 0,
        },
    )

    assert summary["validationProfile"] == "development"
    assert summary["candidateRun"] is False
    assert summary["candidateEvidence"] is False
    event = json.loads(evidence.events_path.read_text().splitlines()[0])
    assert event["candidateRun"] is False
    assert event["candidateEvidence"] is False
    assert stat.S_IMODE(evidence.root.stat().st_mode) == 0o700
    assert stat.S_IMODE(evidence.events_path.stat().st_mode) == 0o600
    assert stat.S_IMODE(evidence.summary_path.stat().st_mode) == 0o600


def test_component_disposition_is_closed_disjoint_and_complete(tmp_path):
    with pytest.raises(driver.DevelopmentSmokeFailure):
        driver.DevelopmentSmokeConfig(
            **{
                **_config(tmp_path).__dict__,
                "selected_components": ("core", "cep"),
                "reused_components": ("cep", "native"),
            }
        )


def test_driver_starts_under_the_isolated_interpreter_used_by_the_cli():
    completed = subprocess.run(
        [
            sys.executable,
            "-B",
            "-I",
            str(HARDWARE / "development_smoke.py"),
            "--help",
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert "core-native-write-undo@1" not in completed.stderr
