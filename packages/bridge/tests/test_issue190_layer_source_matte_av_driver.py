"""Pure construction tests for the Issue #190 non-candidate HDEV runner."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import wave
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
spec = _load(
    "issue190_layer_source_matte_av_spec",
    HARDWARE / "issue190_layer_source_matte_av_spec.py",
)
driver = _load(
    "issue190_layer_source_matte_av_acceptance",
    HARDWARE / "issue190_layer_source_matte_av_acceptance.py",
)


HOST = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
PROJECT = "33333333-3333-4333-8333-333333333333"
COMP = "44444444-4444-4444-8444-444444444444"
LAYER = "55555555-5555-4555-8555-555555555555"
DIGEST = "a" * 64


def _locator(kind: str = "layer", object_id: str = LAYER, generation: int = 1) -> dict:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": object_id,
    }


def _native_payload(
    capability: str,
    value: dict,
    *,
    write: bool = False,
    replayed: bool = False,
) -> dict:
    request_id = f"request-{capability}"
    postcondition = {
        "verified": True,
        "kind": "issue190-test",
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
        "effect": "committed" if write else "none",
        "postcondition": postcondition,
    }
    if write:
        evidence["undo"] = {
            "available": True,
            "verified": False,
            "groupId": "undo-group",
        }
    return {
        "ok": True,
        **({"replayed": replayed} if write else {}),
        "value": value,
        "implementation": {
            "engine": "native-aegp",
            "capabilityId": capability,
            "capabilityVersion": 1,
            "contractDigest": DIGEST,
            "risk": "write" if write else "read",
        },
        "provenance": {
            "engine": "native-aegp",
            "hostInstanceId": HOST,
            "sessionId": SESSION,
            "capabilitiesDigest": "b" * 64,
            "pluginVersion": "0.9.2",
            "selectedWireVersion": 1,
        },
        "audit": {
            "requestId": request_id,
            "capabilityId": capability,
            "capabilityVersion": 1,
            "contractDigest": DIGEST,
            "postconditionDigest": DIGEST,
            **(
                {
                    "operationId": "operation-1",
                    "idempotencyKey": "issue190-test-operation-key",
                    "replayed": replayed,
                    "undoAvailable": True,
                    "undoVerified": False,
                }
                if write
                else {}
            ),
        },
        "evidence": evidence,
    }


class FakeSession:
    def __init__(self, response: tuple[bool, dict]) -> None:
        self.response = response
        self.calls: list[tuple[str, dict]] = []
        self.tool_names = frozenset(spec.REQUIRED_PUBLIC_TOOLS)

    async def call(self, tool: str, arguments: dict):
        self.calls.append((tool, arguments))
        return self.response


def _config(tmp_path: Path) -> object:
    active = tmp_path / "active"
    active.mkdir()
    fixture = active / "issue190.aep"
    return driver.Issue190Config(
        scenario=spec.SCENARIO_ID,
        selected_components=("core", "native"),
        reused_components=("cep",),
        checkout=ROOT,
        fixture_path=fixture,
        recovery_root=tmp_path / "recovery",
        evidence_dir=tmp_path / "evidence",
        formal_ae_app=tmp_path / "formal-ae.app",
        plugin_url="http://127.0.0.1:11488",
    )


def test_call_plan_is_exactly_forty_and_covers_the_frozen_matrix():
    assert spec.CALL_HARD_LIMIT == 40
    assert [row.ordinal for row in spec.CALL_PLAN] == list(range(1, 41))
    assert len({row.key for row in spec.CALL_PLAN}) == 40
    keys = {row.key for row in spec.CALL_PLAN}
    assert {
        "source-read-a",
        "source-replace-a-to-b",
        "source-replace-completed-replay",
        "source-read-b",
        "source-undo-read-a",
        "matte-read-empty",
        "matte-set-alpha",
        "matte-read-alpha",
        "matte-reorder-source",
        "matte-read-after-reorder",
        "matte-set-undo-read-empty",
        "matte-set-luma",
        "matte-clear",
        "matte-read-cleared-luma",
        "matte-clear-undo-read-luma",
        "audio-disable",
        "audio-disable-read",
        "audio-undo-read",
        "video-disable",
        "video-disable-read",
        "video-undo-read",
        "negative-cross-composition-matte",
        "negative-self-matte",
        "negative-invalid-source-target",
        "negative-no-audio",
        "negative-no-video",
    } <= keys
    assert tuple(row.key for row in spec.CALL_PLAN if row.undo_checkpoint) == (
        "source-undo-reacquire-project",
        "matte-set-undo-reacquire-layers",
        "matte-clear-undo-reacquire-layers",
        "audio-undo-reacquire-layers",
        "video-undo-reacquire-layers",
    )


def test_fixture_recipe_is_one_ephemeral_slot_with_exact_roles_and_pcm_asset():
    assert spec.FIXTURE_SPEC["lifecycle"] == "ephemeral-validation"
    assert spec.FIXTURE_SPEC["activeSlots"] == 1
    assert spec.FIXTURE_SPEC["saveAsCopies"] == 0
    assert spec.FIXTURE_SPEC["roles"] == (
        "SOURCE_COMP_A",
        "SOURCE_COMP_B",
        "RELINK_TARGET",
        "MATTE_FILL",
        "MATTE_SOURCE",
        "MATTE_SPACER",
        "VIDEO_SWITCH",
        "AUDIO_SWITCH",
    )
    assert spec.WAV_SPEC == {
        "channels": 1,
        "sampleWidthBytes": 2,
        "sampleRateHz": 8000,
        "frameCount": 2000,
        "personalData": False,
    }
    recipe = " ".join(spec.FIXTURE_RECIPE)
    assert "exactly one ephemeral-validation" in recipe
    assert "harness-only" in recipe
    assert "never use Save As" in recipe
    assert "archive" in recipe


def test_every_undo_and_source_replacement_has_a_public_locator_fence():
    assert spec.locator_reacquisition_violations(spec.CALL_PLAN) == ()
    missing_source_fence = tuple(
        row for row in spec.CALL_PLAN
        if row.key != "source-reacquire-project"
    )
    assert spec.locator_reacquisition_violations(missing_source_fence)
    missing_undo_fence = tuple(
        row for row in spec.CALL_PLAN
        if row.key != "audio-undo-reacquire-layers"
    )
    assert spec.locator_reacquisition_violations(missing_undo_fence)


def test_public_readback_predicates_cover_preservation_and_all_five_undos():
    predicates = spec.PUBLIC_READBACK_PREDICATES
    assert predicates["source-read-b"]["sourceName"] == "SOURCE_COMP_B"
    assert predicates["source-transform-after"]["equals"] == "source-transform-before"
    assert predicates["source-replace-a-to-b"]["invariantsEqual"] is True
    assert predicates["matte-read-after-reorder"] == {
        "active": True,
        "matteRole": "MATTE_SOURCE",
        "mode": "alpha",
        "stackOrderChanged": True,
    }
    assert predicates["matte-read-cleared-luma"] == {
        "active": False,
        "matteRole": None,
        "mode": "luma",
    }
    assert {
        "source-undo-read-a",
        "matte-set-undo-read-empty",
        "matte-clear-undo-read-luma",
        "audio-undo-read",
        "video-undo-read",
    } <= predicates.keys()


def test_defect_ledger_rows_are_closed_and_dependency_blocking_is_explicit():
    ledger = driver.DefectLedger(spec.CASE_DEPENDENCIES)
    ledger.record(
        "source",
        status="FAIL",
        failing_layer="public-readback",
        side_effect_state="none",
        reconciliation="not-required",
        dependency_impact=("source-replay",),
        evidence_ids=("event-7", "audit-2"),
        message="source mismatch",
    )
    ledger.block_dependents("source", reason="source baseline unavailable")

    rows = {row["case"]: row for row in ledger.public_rows()}
    assert set(rows["source"]) == {
        "case",
        "status",
        "failingLayer",
        "sideEffectState",
        "reconciliation",
        "dependencyImpact",
        "evidenceIds",
        "message",
    }
    assert rows["source"]["status"] == "FAIL"
    assert rows["source-replay"]["status"] == "BLOCKED"
    assert rows["source-replay"]["dependencyImpact"] == ["source"]
    assert driver.DefectLedger.STATUSES == {
        "PASS",
        "FAIL",
        "BLOCKED",
        "INDETERMINATE",
    }


@pytest.mark.asyncio
async def test_completed_replay_is_verified_without_a_second_ae_change(tmp_path):
    payload = _native_payload(
        "ae.layer.track-matte.set",
        {
            "changed": True,
            "layerLocator": _locator(),
            "beforeMatteLayerLocator": None,
            "beforeMode": "none",
            "afterMatteLayerLocator": _locator(object_id="66666666-6666-4666-8666-666666666666"),
            "afterMode": "alpha",
        },
        write=True,
        replayed=True,
    )
    session = FakeSession((False, payload))
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    original = {
        "operationId": "operation-1",
        "postconditionDigest": DIGEST,
        "idempotencyKey": "issue190-test-operation-key",
    }

    observed = await runner.public_call(
        session,
        case="source-replay",
        phase="source-replay",
        tool="ae_setLayerTrackMatte",
        arguments={
            "layer_locator": _locator(),
            "matte_layer_locator": _locator(
                object_id="66666666-6666-4666-8666-666666666666"
            ),
            "mode": "alpha",
            "idempotency_key": "issue190-test-operation-key",
        },
        write=True,
        expected_replay=original,
    )

    assert observed["replayed"] is True
    assert len(session.calls) == 1
    assert runner.tool_summary["ae_setLayerTrackMatte"]["aeRedispatches"] == 0
    assert len(runner.call_evidence["source-replay"]) == 2
    assert all(
        evidence_id.startswith(runner.evidence.run_id)
        for evidence_id in runner.call_evidence["source-replay"]
    )


@pytest.mark.asyncio
async def test_uncertain_write_reconciles_and_stops_without_retry(tmp_path):
    response = {
        "ok": False,
        "error": {
            "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "retryable": False,
            "sideEffect": "possible",
            "recovery": {"action": "reconcile-state"},
            "details": {
                "operationId": "operation-uncertain",
                "idempotencyKey": "issue190-uncertain-key",
            },
        },
    }
    session = FakeSession((True, response))
    reconciliations: list[dict] = []

    async def reconcile(record: dict) -> dict:
        reconciliations.append(record)
        return {
            "state": "unreconciled",
            "audit": "unreconciled",
            "evidenceIds": ["reconciliation-1"],
        }

    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
        reconcile_uncertain=reconcile,
    )

    with pytest.raises(driver.ImmediateStop, match="unreconciled possible write"):
        await runner.public_call(
            session,
            case="uncertain-source-write",
            phase="uncertain-write",
            tool="ae_setLayerSource",
            arguments={
                "layer_locator": _locator(),
                "source_item_locator": _locator("composition", COMP),
                "idempotency_key": "issue190-uncertain-key",
            },
            write=True,
        )

    assert len(session.calls) == 1
    assert len(reconciliations) == 1
    assert reconciliations[0]["action"] == "read-state-and-audit-without-redispatch"
    row = runner.defects.row("uncertain-source-write")
    assert row["status"] == "INDETERMINATE"
    assert row["reconciliation"] == "unreconciled"


@pytest.mark.asyncio
async def test_negative_probe_that_unexpectedly_writes_stops_the_sweep(tmp_path):
    payload = _native_payload(
        "ae.layer.track-matte.set",
        {
            "changed": True,
            "layerLocator": _locator(),
            "beforeMatteLayerLocator": None,
            "beforeMode": "none",
            "afterMatteLayerLocator": _locator(
                object_id="66666666-6666-4666-8666-666666666666"
            ),
            "afterMode": "alpha",
        },
        write=True,
    )
    session = FakeSession((False, payload))
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    with pytest.raises(driver.ImmediateStop, match="negative probe unexpectedly"):
        await runner.public_call(
            session,
            case="negative-self-matte",
            phase="negative-self-matte",
            tool="ae_setLayerTrackMatte",
            arguments={
                "layer_locator": _locator(),
                "matte_layer_locator": _locator(),
                "mode": "alpha",
                "idempotency_key": "negative-self-key",
            },
            expected_error="INVALID_ARGUMENT",
        )
    assert len(session.calls) == 1


@pytest.mark.asyncio
async def test_transport_failure_is_an_immediate_stop_not_a_zero_write_claim(tmp_path):
    class BrokenSession(FakeSession):
        async def call(self, tool: str, arguments: dict):
            self.calls.append((tool, arguments))
            raise ConnectionError("transport lost")

    session = BrokenSession((False, {}))
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    with pytest.raises(driver.ImmediateStop, match="transport or AE process"):
        await runner.public_call(
            session,
            case="audio-disable",
            phase="audio",
            tool="ae_setLayerAudioEnabled",
            arguments={
                "layer_locator": _locator(),
                "enabled": False,
                "idempotency_key": "audio-transport-key",
            },
            write=True,
        )
    assert len(session.calls) == 1


def test_call_budget_stops_before_dispatch_forty_one(tmp_path):
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.ledger.total = spec.CALL_HARD_LIMIT
    session = FakeSession((False, {}))

    with pytest.raises(driver.Issue190Failure, match="budget exhausted"):
        runner.ledger.reserve("overflow", "ae_getLayerSource")
    assert session.calls == []


def test_operation_keys_are_fresh_per_run_and_stable_for_one_intent(tmp_path):
    first = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    second_root = tmp_path / "second"
    second_root.mkdir()
    second = driver.Issue190Runner(
        _config(second_root),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    original = first.operation_key("source-replace")
    assert first.operation_key("source-replace") == original
    assert first.reconciliation_key("source-replace") == original
    assert second.operation_key("source-replace") != original
    assert all(
        isinstance(row.arguments.get("idempotency_key"), str)
        and row.arguments["idempotency_key"].startswith("$operation_key:")
        for row in spec.CALL_PLAN
        if "idempotency_key" in row.arguments
    )


@pytest.mark.asyncio
async def test_real_undo_execution_and_public_verification_are_separate(tmp_path):
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    await runner._undo_checkpoint("undo-audio-disable")
    undo = runner._tool_row("ae_setLayerAudioEnabled")["undo"]
    assert undo == {"executed": 1, "verified": 0}

    runner.mark_undo_verified("ae_setLayerAudioEnabled")
    assert undo == {"executed": 1, "verified": 1}


def test_generated_wav_is_short_deterministic_pcm_inside_fixture_area(tmp_path):
    config = _config(tmp_path)
    path = driver.generate_fixture_wav(config)

    assert path.is_relative_to(config.fixture_path.parent)
    assert path.name == "issue190-hdev-tone.wav"
    with wave.open(os.fspath(path), "rb") as stream:
        assert stream.getnchannels() == 1
        assert stream.getsampwidth() == 2
        assert stream.getframerate() == 8000
        assert stream.getnframes() == 2000
    first = path.read_bytes()
    assert driver.generate_fixture_wav(config).read_bytes() == first


@pytest.mark.asyncio
async def test_successful_archive_finishes_with_zero_active_and_unclassified(tmp_path):
    config = _config(tmp_path)
    config.fixture_path.write_bytes(b"fixture")
    wav_path = driver.generate_fixture_wav(config)
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.lifecycle.update({"created": 1, "active": 1})

    archived = await runner.archive_fixture(wav_path)

    assert archived.is_file()
    assert not config.fixture_path.exists()
    assert not wav_path.exists()
    assert runner.lifecycle == {
        "created": 1,
        "canonicalRetained": 0,
        "evidenceSnapshotsRetained": 0,
        "archived": 1,
        "active": 0,
        "unclassified": 0,
        "saveAsCopies": 0,
    }


def test_evidence_and_summary_are_permanently_development_only(tmp_path):
    evidence = driver.DevelopmentEvidence(tmp_path / "evidence")
    evidence.record("probe", {"evidenceId": "probe-1"})
    summary = evidence.finish(
        passed=True,
        public_calls={
            "target": 40,
            "hardLimit": 40,
            "total": 40,
            "byTool": {},
            "byPhase": {},
        },
        component_disposition={
            "selected": ["core", "native"],
            "reused": ["cep"],
        },
        aep_lifecycle={
            "created": 1,
            "canonicalRetained": 0,
            "evidenceSnapshotsRetained": 0,
            "archived": 1,
            "active": 0,
            "unclassified": 0,
            "saveAsCopies": 0,
        },
        defect_ledger=[],
        tool_summary={},
    )

    assert summary["validationProfile"] == "development"
    assert summary["candidateRun"] is False
    assert summary["candidateEvidence"] is False
    event = json.loads(evidence.events_path.read_text().splitlines()[0])
    assert event["validationProfile"] == "development"
    assert event["candidateRun"] is False
    assert event["candidateEvidence"] is False
    if os.name != "nt":
        assert stat.S_IMODE(evidence.root.stat().st_mode) == 0o700
        assert stat.S_IMODE(evidence.events_path.stat().st_mode) == 0o600
        assert stat.S_IMODE(evidence.summary_path.stat().st_mode) == 0o600


def test_call_summary_links_plan_state_evidence_and_fixture_lifecycle(tmp_path):
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    first = spec.CALL_PLAN[0]
    runner.responses[first.key] = {
        "ok": True,
        "value": {"items": []},
        "audit": {"requestId": "request-1"},
        "evidence": {
            "postcondition": {"digest": DIGEST},
        },
    }
    runner.defects.record(
        first.key,
        status="PASS",
        failing_layer="none",
        side_effect_state="none",
        reconciliation="public-readback",
        dependency_impact=(),
        evidence_ids=("request-event", "response-event"),
        message=first.predicate,
    )

    row = runner.call_summary()[0]
    assert row["ordinal"] == 1
    assert row["key"] == first.key
    assert row["tool"] == first.tool
    assert row["status"] == "PASS"
    assert row["value"] == {"items": []}
    assert row["auditId"] == "request-1"
    assert row["postconditionId"] == DIGEST
    assert row["evidenceIds"] == ["request-event", "response-event"]
    assert row["fixtureLifecycle"] == "ephemeral-validation"


def test_cli_import_has_no_ae_side_effects_and_help_is_deterministic():
    completed = subprocess.run(
        [
            sys.executable,
            "-B",
            "-I",
            str(HARDWARE / "issue190_layer_source_matte_av_acceptance.py"),
            "--help",
        ],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    assert spec.SCENARIO_ID in completed.stdout
    assert "CHECKPOINT_REQUIRED" not in completed.stdout
