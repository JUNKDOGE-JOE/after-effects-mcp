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


class SequenceSession:
    def __init__(self, responses: list[tuple[bool, dict]]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []
        self.tool_names = frozenset(spec.REQUIRED_PUBLIC_TOOLS)

    async def call(self, tool: str, arguments: dict):
        self.calls.append((tool, arguments))
        assert self.responses, f"unexpected call to {tool}"
        return self.responses.pop(0)


def _main_layers_payload(*, generation: int = 2) -> dict:
    names = (
        "MATTE_FILL",
        "MATTE_SOURCE",
        "MATTE_SPACER",
        "RELINK_TARGET",
        "VIDEO_SWITCH",
        "AUDIO_SWITCH",
        "INVALID_SOURCE_TARGET",
    )
    return _native_payload(
        "ae.layer.list",
        {
            "compositionLocator": _locator(
                "composition", COMP, generation=generation
            ),
            "layers": [
                {
                    "name": name,
                    "stackIndex": index,
                    "locator": _locator(
                        object_id=(
                            f"{index:08d}-{index:04d}-4{index:03d}-"
                            f"8{index:03d}-{index:012d}"
                        ),
                        generation=generation,
                    ),
                }
                for index, name in enumerate(names, start=1)
            ],
        },
    )


def _config(tmp_path: Path) -> object:
    return driver.Issue190Config(
        scenario=spec.SCENARIO_ID,
        selected_components=("core", "native"),
        reused_components=("cep",),
        checkout=ROOT,
        fixture_home=tmp_path,
        evidence_dir=tmp_path / "evidence",
        formal_ae_app=tmp_path / "formal-ae.app",
        plugin_url="http://127.0.0.1:11488",
        run_id="issue190-hdev-test-run",
    )


def test_config_derives_one_fresh_fixture_and_recovery_root_from_home(tmp_path):
    config = _config(tmp_path)

    assert config.fixture_path == (
        tmp_path
        / "Library/Application Support/AfterEffectsMCP/fixtures/active"
        / "issue190-hdev-test-run.aep"
    )
    assert config.ownership_manifest_path == config.fixture_path.with_suffix(
        ".ownership.json"
    )
    assert config.recovery_root == (
        tmp_path
        / "Library/Application Support/AfterEffectsMCP/fixtures/recovery"
    )
    assert not config.fixture_path.is_relative_to(ROOT)


def test_cli_has_no_external_fixture_or_recovery_path_escape(tmp_path, monkeypatch):
    monkeypatch.setattr(driver.Path, "home", classmethod(lambda _cls: tmp_path))
    common = [
        "--scenario",
        spec.SCENARIO_ID,
        "--selected-components",
        "core,native",
        "--reused-components",
        "cep",
        "--checkout",
        str(ROOT),
        "--evidence-dir",
        str(tmp_path / "evidence"),
        "--formal-ae-app",
        str(tmp_path / "formal-ae.app"),
    ]

    config = driver.parse_args(common)
    assert config.fixture_path.parent == (
        tmp_path
        / "Library/Application Support/AfterEffectsMCP/fixtures/active"
    )
    with pytest.raises(SystemExit):
        driver.parse_args(
            [
                *common,
                "--fixture-path",
                str(tmp_path / "production.aep"),
            ]
        )
    with pytest.raises(SystemExit):
        driver.parse_args(
            [
                *common,
                "--recovery-archive-root",
                str(tmp_path / "external-recovery"),
            ]
        )


def test_fixture_claim_is_exclusive_and_manifest_is_closed(tmp_path):
    config = _config(tmp_path)
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    manifest = runner.claim_fixture()
    saved = json.loads(manifest.read_text(encoding="utf-8"))
    assert saved == {
        "schemaVersion": 1,
        "validationProfile": "development",
        "candidateRun": False,
        "candidateEvidence": False,
        "runId": "issue190-hdev-test-run",
        "lifecycle": "ephemeral-validation",
        "fixturePath": str(config.fixture_path),
        "activeRoot": str(config.fixture_path.parent),
        "recoveryRoot": str(config.recovery_root),
        "evidenceRoot": str(config.evidence_dir),
        "cleanupCondition": (
            "move the owned fixture and manifest to short-lived recovery "
            "after structured evidence or any classified failure"
        ),
    }
    assert stat.S_IMODE(manifest.stat().st_mode) == 0o600
    with pytest.raises(driver.Issue190Failure, match="ownership manifest already exists"):
        runner.claim_fixture()


@pytest.mark.parametrize("occupied", ["file", "symlink"])
def test_fixture_claim_refuses_an_existing_or_symlink_target(tmp_path, occupied):
    config = _config(tmp_path)
    config.fixture_path.parent.mkdir(parents=True)
    if occupied == "file":
        config.fixture_path.write_bytes(b"production")
    else:
        target = tmp_path / "outside.aep"
        target.write_bytes(b"production")
        config.fixture_path.symlink_to(target)
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    with pytest.raises(driver.Issue190Failure, match="fresh and absent"):
        runner.claim_fixture()


def test_fixture_ownership_rejects_manifest_mismatch(tmp_path):
    config = _config(tmp_path)
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    manifest = runner.claim_fixture()
    saved = json.loads(manifest.read_text(encoding="utf-8"))
    saved["runId"] = "other-run"
    manifest.write_text(json.dumps(saved), encoding="utf-8")

    with pytest.raises(driver.Issue190Failure, match="ownership manifest mismatch"):
        runner.validate_fixture_ownership()


def test_fixture_claim_refuses_home_symlink_or_run_id_path_escape(tmp_path):
    actual_home = tmp_path / "actual-home"
    actual_home.mkdir()
    linked_home = tmp_path / "linked-home"
    linked_home.symlink_to(actual_home, target_is_directory=True)
    linked_config = driver.Issue190Config(
        scenario=spec.SCENARIO_ID,
        selected_components=("core", "native"),
        reused_components=("cep",),
        checkout=ROOT,
        fixture_home=linked_home,
        evidence_dir=tmp_path / "evidence",
        formal_ae_app=tmp_path / "formal-ae.app",
        plugin_url="http://127.0.0.1:11488",
        run_id="issue190-hdev-linked-home",
    )
    runner = driver.Issue190Runner(
        linked_config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    with pytest.raises(driver.Issue190Failure, match="fixture home cannot be"):
        runner.claim_fixture()

    with pytest.raises(driver.Issue190Failure, match="run ID is invalid"):
        driver.Issue190Config(
            scenario=spec.SCENARIO_ID,
            selected_components=("core", "native"),
            reused_components=("cep",),
            checkout=ROOT,
            fixture_home=tmp_path,
            evidence_dir=tmp_path / "evidence-2",
            formal_ae_app=tmp_path / "formal-ae.app",
            plugin_url="http://127.0.0.1:11488",
            run_id="issue190-hdev-../production",
        )


@pytest.mark.parametrize(
    ("project_file", "item_count", "owner_marker", "target_exists", "expected"),
    [
        (None, 0, None, False, "close-empty-and-create"),
        ("/tmp/production.aep", 3, None, False, "block-production-project"),
        (None, 1, None, False, "block-production-project"),
        (
            "/tmp/owned.aep",
            9,
            "__AEMCP_ISSUE190_OWNER__:run-1",
            True,
            "reuse-owned-fixture",
        ),
        (None, 0, None, True, "block-existing-target"),
    ],
)
def test_fixture_project_guard_never_closes_unowned_state(
    project_file,
    item_count,
    owner_marker,
    target_exists,
    expected,
):
    assert driver.fixture_project_guard(
        project_file=project_file,
        item_count=item_count,
        owner_marker=owner_marker,
        expected_fixture="/tmp/owned.aep",
        expected_owner="__AEMCP_ISSUE190_OWNER__:run-1",
        target_exists=target_exists,
    ) == expected


def test_fixture_jsx_embeds_the_same_owner_guard_before_any_close(tmp_path):
    config = _config(tmp_path)
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.claim_fixture()
    wav_path = driver.generate_fixture_wav(config)

    script = driver.fixture_create_script(config, wav_path)
    first_close = script.index("app.project.close(")
    assert script.index("block-production-project") < first_close
    assert script.index("block-existing-target") < first_close
    assert script.index("__AEMCP_ISSUE190_OWNER__:issue190-hdev-test-run") < first_close
    assert "app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES)" in script


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
    assert spec.FIXTURE_SPEC["freshPerRun"] is True
    assert spec.FIXTURE_SPEC["canonicalActiveRoot"].endswith("/fixtures/active")
    assert spec.FIXTURE_SPEC["ownershipManifest"].startswith("O_EXCL")
    assert "evidence snapshot" in spec.FIXTURE_SPEC["failureDisposition"]
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
    assert "fresh per-run ephemeral-validation" in recipe
    assert "ownership manifest" in recipe
    assert "block every unowned" in recipe
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
async def test_uncertain_write_is_handed_to_frozen_readback_without_retry(tmp_path):
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
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    with pytest.raises(driver.UncertainWrite) as caught:
        await runner.public_call(
            session,
            case="source-replace-a-to-b",
            phase="source",
            tool="ae_setLayerSource",
            arguments={
                "layer_locator": _locator(),
                "source_item_locator": _locator("composition", COMP),
                "idempotency_key": "issue190-uncertain-key",
            },
            write=True,
        )

    assert len(session.calls) == 1
    assert caught.value.arguments["idempotency_key"] == "issue190-uncertain-key"
    assert caught.value.payload["reportedOperationId"] == "operation-uncertain"
    assert len(caught.value.evidence_ids) == 2
    assert runner.defects.public_rows() == []


@pytest.mark.asyncio
async def test_uncertain_audio_write_uses_frozen_read_to_prove_not_occurred(tmp_path):
    readback = _native_payload(
        "ae.layer.av.get",
        {
            "layerLocator": _locator(),
            "hasAudio": True,
            "audioEnabled": True,
            "hasVideo": False,
            "videoEnabled": False,
        },
    )
    session = FakeSession((False, readback))
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.context["audio_switch_locator"] = _locator()
    pending = driver.PendingWrite(
        key="audio-disable",
        phase="audio",
        tool="ae_setLayerAudioEnabled",
        arguments={
            "layer_locator": _locator(),
            "enabled": False,
            "idempotency_key": "issue190-original-operation-key",
        },
        evidence_ids=("write-request", "write-response"),
        payload={
            "error": {
                "details": {
                    "operationId": "operation-uncertain",
                    "idempotencyKey": "issue190-original-operation-key",
                }
            },
            "reportedOperationId": "operation-uncertain",
        },
        uncertain=True,
        failing_layer="possibly-side-effecting-terminal",
    )

    outcome = await runner._reconcile_uncertain_write(session, pending)

    assert outcome == "not-occurred-reconciled"
    assert [tool for tool, _arguments in session.calls] == ["ae_getLayerAVState"]
    assert runner.operation_keys == {}
    row = runner.defects.row("audio-disable")
    assert row["status"] == "FAIL"
    assert row["sideEffectState"] == "not-started"
    assert row["reconciliation"] == "not-occurred-reconciled"
    assert row["evidenceIds"][:2] == ["write-request", "write-response"]
    assert any(
        evidence_id.startswith(runner.evidence.run_id)
        for evidence_id in row["evidenceIds"][2:]
    )


@pytest.mark.asyncio
async def test_committed_audio_reconciliation_undoes_and_verifies_before_return(
    tmp_path,
):
    disabled = _native_payload(
        "ae.layer.av.get",
        {
            "layerLocator": _locator(),
            "hasAudio": True,
            "audioEnabled": False,
            "hasVideo": False,
            "videoEnabled": False,
        },
    )
    restored = _native_payload(
        "ae.layer.av.get",
        {
            "layerLocator": _locator(generation=2),
            "hasAudio": True,
            "audioEnabled": True,
            "hasVideo": False,
            "videoEnabled": False,
        },
    )
    session = SequenceSession(
        [
            (False, disabled),
            (False, _main_layers_payload()),
            (False, restored),
        ]
    )
    checkpoints: list[str] = []

    async def checkpoint(name: str, _payload: dict) -> None:
        checkpoints.append(name)

    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=checkpoint,
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.context.update(
        {
            "audio_switch_locator": _locator(),
            "main_composition_locator": _locator("composition", COMP),
            "baseline_layer_order": (
                "MATTE_FILL",
                "MATTE_SOURCE",
                "MATTE_SPACER",
                "RELINK_TARGET",
                "VIDEO_SWITCH",
                "AUDIO_SWITCH",
                "INVALID_SOURCE_TARGET",
            ),
        }
    )
    pending = driver.PendingWrite(
        key="audio-disable",
        phase="audio",
        tool="ae_setLayerAudioEnabled",
        arguments={
            "layer_locator": _locator(),
            "enabled": False,
            "idempotency_key": "issue190-original-operation-key",
        },
        evidence_ids=("write-request", "write-response"),
        payload={
            "error": {
                "details": {
                    "operationId": "operation-uncertain",
                    "idempotencyKey": "issue190-original-operation-key",
                }
            },
            "reportedOperationId": "operation-uncertain",
        },
        uncertain=True,
        failing_layer="possibly-side-effecting-terminal",
    )

    outcome = await runner._reconcile_uncertain_write(session, pending)

    assert outcome == "committed-reconciled"
    assert [tool for tool, _arguments in session.calls] == [
        "ae_getLayerAVState",
        "ae_listCompositionLayers",
        "ae_getLayerAVState",
    ]
    assert checkpoints == ["undo-audio-disable"]
    assert runner.fixture_baseline_restored is True
    assert runner.unreconciled_write is False
    assert runner._tool_row("ae_setLayerAudioEnabled")["undo"] == {
        "executed": 1,
        "verified": 1,
    }
    row = runner.defects.row("audio-disable")
    assert row["reconciliation"] == "committed-reconciled-and-restored"
    assert row["sideEffectState"] == "committed-reconciled"


@pytest.mark.asyncio
async def test_failed_recovery_blocks_any_independent_case(tmp_path):
    disabled = _native_payload(
        "ae.layer.av.get",
        {
            "layerLocator": _locator(),
            "hasAudio": True,
            "audioEnabled": False,
            "hasVideo": False,
            "videoEnabled": False,
        },
    )
    still_disabled = _native_payload(
        "ae.layer.av.get",
        {
            "layerLocator": _locator(generation=2),
            "hasAudio": True,
            "audioEnabled": False,
            "hasVideo": False,
            "videoEnabled": False,
        },
    )
    session = SequenceSession(
        [
            (False, _main_layers_payload()),
            (False, still_disabled),
            (False, disabled),  # Must remain unused; it represents independent work.
        ]
    )
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.context.update(
        {
            "main_composition_locator": _locator("composition", COMP),
            "audio_switch_locator": _locator(),
            "baseline_layer_order": (
                "MATTE_FILL",
                "MATTE_SOURCE",
                "MATTE_SPACER",
                "RELINK_TARGET",
                "VIDEO_SWITCH",
                "AUDIO_SWITCH",
                "INVALID_SOURCE_TARGET",
            ),
        }
    )
    pending = driver.PendingWrite(
        key="audio-disable",
        phase="audio",
        tool="ae_setLayerAudioEnabled",
        arguments={"idempotency_key": "audio-key"},
        evidence_ids=("write-request", "write-response"),
        payload={},
        failing_layer="post-write-public-readback",
    )

    with pytest.raises(driver.ImmediateStop, match="baseline could not be verified"):
        await runner._recover_committed_write(session, pending)

    assert [tool for tool, _arguments in session.calls] == [
        "ae_listCompositionLayers",
        "ae_getLayerAVState",
    ]
    assert len(session.responses) == 1
    assert runner.fixture_baseline_restored is False
    assert runner.unreconciled_write is True


@pytest.mark.asyncio
async def test_luma_support_write_recovery_verifies_the_empty_prewrite_baseline(
    tmp_path,
):
    empty_matte = _native_payload(
        "ae.layer.track-matte.get",
        {
            "layerLocator": _locator(generation=2),
            "active": False,
            "matteLayerLocator": None,
            "mode": "none",
            "inverted": False,
        },
    )
    session = SequenceSession(
        [(False, _main_layers_payload()), (False, empty_matte)]
    )
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.context.update(
        {
            "main_composition_locator": _locator("composition", COMP),
            "matte_fill_locator": _locator(),
            "baseline_layer_order": (
                "MATTE_FILL",
                "MATTE_SOURCE",
                "MATTE_SPACER",
                "RELINK_TARGET",
                "VIDEO_SWITCH",
                "AUDIO_SWITCH",
                "INVALID_SOURCE_TARGET",
            ),
        }
    )
    pending = driver.PendingWrite(
        key="matte-set-luma",
        phase="matte-clear",
        tool="ae_setLayerTrackMatte",
        arguments={"idempotency_key": "luma-key"},
        evidence_ids=("write-request", "write-response"),
        payload={},
        failing_layer="post-write-public-readback",
    )

    await runner._recover_committed_write(session, pending)

    assert runner.fixture_baseline_restored is True
    assert runner.defects.row("matte-clear-undo-read-luma")["status"] == "PASS"
    assert (
        runner.defects.row("matte-clear-undo-read-luma")["reconciliation"]
        == "recovery-baseline-readback"
    )
    assert runner._tool_row("ae_setLayerTrackMatte")["undo"] == {
        "executed": 1,
        "verified": 1,
    }


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
async def test_transport_failure_becomes_pending_write_not_a_zero_write_claim(tmp_path):
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

    with pytest.raises(driver.UncertainWrite) as caught:
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
    assert caught.value.failing_layer == "transport-after-dispatch"
    assert caught.value.arguments["idempotency_key"] == "audio-transport-key"
    assert runner.defects.public_rows() == []


@pytest.mark.asyncio
async def test_incompatible_trigger_is_fail_with_evidence_before_dependents_block(
    tmp_path,
):
    response = {
        "ok": False,
        "error": {
            "code": "NATIVE_PROTOCOL_MISMATCH",
            "retryable": False,
            "sideEffect": "not-started",
            "details": {
                "expectedProtocolVersion": 3,
                "observedProtocolVersion": 2,
            },
        },
    }
    session = FakeSession((True, response))
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    with pytest.raises(driver.ImmediateStop, match="incompatible component"):
        await runner.public_call(
            session,
            case="matte-set-alpha",
            phase="matte-set",
            tool="ae_setLayerTrackMatte",
            arguments={
                "layer_locator": _locator(),
                "matte_layer_locator": _locator(
                    object_id="66666666-6666-4666-8666-666666666666"
                ),
                "mode": "alpha",
                "idempotency_key": "matte-alpha-key",
            },
            write=True,
        )

    trigger = runner.defects.row("matte-set-alpha")
    assert trigger["status"] == "FAIL"
    assert trigger["failingLayer"] == "component-or-protocol-compatibility"
    assert trigger["sideEffectState"] == "not-started"
    assert trigger["reconciliation"] == "not-required"
    assert trigger["dependencyImpact"] == ["matte-reorder", "matte-clear"]
    assert len(trigger["evidenceIds"]) == 2
    assert trigger["message"].endswith("NATIVE_PROTOCOL_MISMATCH")
    assert runner.defects.row("matte-reorder")["status"] == "BLOCKED"
    assert runner.defects.row("matte-clear")["status"] == "BLOCKED"


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
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.claim_fixture()
    path = driver.generate_fixture_wav(config)

    assert path.is_relative_to(config.fixture_path.parent)
    assert path.name == "issue190-hdev-test-run.wav"
    with wave.open(os.fspath(path), "rb") as stream:
        assert stream.getnchannels() == 1
        assert stream.getsampwidth() == 2
        assert stream.getframerate() == 8000
        assert stream.getnframes() == 2000
    with pytest.raises(driver.Issue190Failure, match="fresh and absent"):
        driver.generate_fixture_wav(config)


@pytest.mark.asyncio
async def test_successful_archive_finishes_with_zero_active_and_unclassified(tmp_path):
    config = _config(tmp_path)
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.claim_fixture()
    config.fixture_path.write_bytes(b"fixture")
    wav_path = driver.generate_fixture_wav(config)
    runner.lifecycle.update({"created": 1, "active": 1})

    archived = await runner.archive_fixture(wav_path)

    assert archived.is_file()
    assert not config.fixture_path.exists()
    assert not config.ownership_manifest_path.exists()
    assert not wav_path.exists()
    assert runner.lifecycle == {
        "created": 1,
        "canonicalRetained": 0,
        "evidenceSnapshotsRetained": 0,
        "archived": 1,
        "recoveryArchived": 1,
        "active": 0,
        "unclassified": 0,
        "saveAsCopies": 0,
        "baselineRestored": True,
        "dispositionReason": "structured development evidence complete",
        "cleanupCondition": (
            "remove after the development failure or evidence has been reviewed"
        ),
    }
    disposition = json.loads(
        (archived.parent / "recovery-disposition.json").read_text(encoding="utf-8")
    )
    assert disposition["evidenceSnapshot"] is False
    assert disposition["baselineRestored"] is True


@pytest.mark.asyncio
async def test_safe_failure_is_classified_into_recovery_with_zero_active(tmp_path):
    config = _config(tmp_path)
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.claim_fixture()
    config.fixture_path.write_bytes(b"fixture")
    runner.current_wav_path = driver.generate_fixture_wav(config)
    runner.lifecycle.update({"created": 1, "active": 1})

    result = await runner.finalize_failure("incompatible protocol before write")

    assert result["disposition"] == "short-lived-recovery"
    assert runner.lifecycle["active"] == 0
    assert runner.lifecycle["unclassified"] == 0
    assert runner.lifecycle["recoveryArchived"] == 1
    assert runner.lifecycle["evidenceSnapshotsRetained"] == 0
    assert runner.lifecycle["baselineRestored"] is True
    assert runner.lifecycle["dispositionReason"] == "incompatible protocol before write"
    assert runner.lifecycle["cleanupCondition"]


@pytest.mark.asyncio
async def test_unreconciled_or_crashed_write_is_preserved_as_classified_snapshot(
    tmp_path,
):
    config = _config(tmp_path)
    checkpoints: list[str] = []

    async def checkpoint(name: str, _payload: dict) -> None:
        checkpoints.append(name)

    runner = driver.Issue190Runner(
        config,
        checkpoint=checkpoint,
        # False models the formal AE process already being gone after transport loss.
        after_effects_running=lambda: driver.completed_process_check(False),
    )
    runner.claim_fixture()
    config.fixture_path.write_bytes(b"fixture-after-transport-loss")
    runner.current_wav_path = driver.generate_fixture_wav(config)
    runner.lifecycle.update({"created": 1, "active": 1})
    runner.unreconciled_write = True
    runner.fixture_baseline_restored = False

    result = await runner.finalize_failure(
        "transport lost after write dispatch; operation remained unreconciled"
    )

    assert result["disposition"] == "evidence-snapshot"
    assert result["aeProcessGoneWithoutRecovery"] is True
    assert checkpoints == []
    assert runner.lifecycle["active"] == 0
    assert runner.lifecycle["unclassified"] == 0
    assert runner.lifecycle["archived"] == 1
    assert runner.lifecycle["evidenceSnapshotsRetained"] == 1
    assert runner.lifecycle["baselineRestored"] is False
    assert "unresolved write" in runner.lifecycle["cleanupCondition"]
    disposition = json.loads(
        (
            config.recovery_root
            / config.run_id
            / "recovery-disposition.json"
        ).read_text(encoding="utf-8")
    )
    assert disposition["reason"].startswith("transport lost")
    assert disposition["evidenceSnapshot"] is True
    assert disposition["baselineRestored"] is False


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
