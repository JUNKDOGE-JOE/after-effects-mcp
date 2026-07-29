"""Pure construction tests for the Issue #190 non-candidate HDEV runner."""

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import plistlib
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


def _project_items_payload(*, generation: int = 2) -> dict:
    return _native_payload(
        "ae.project.items.list",
        {
            "items": [
                {
                    "name": "ISSUE190_MAIN",
                    "locator": _locator(
                        "composition",
                        COMP,
                        generation=generation,
                    ),
                },
                {
                    "name": "SOURCE_COMP_A",
                    "locator": _locator(
                        "composition",
                        "77777777-7777-4777-8777-777777777777",
                        generation=generation,
                    ),
                },
                {
                    "name": "SOURCE_COMP_B",
                    "locator": _locator(
                        "composition",
                        "88888888-8888-4888-8888-888888888888",
                        generation=generation,
                    ),
                },
            ]
        },
    )


def _source_details_payload(source_name: str, *, generation: int = 2) -> dict:
    return _native_payload(
        "ae.layer.details.get",
        {
            "layerLocator": _locator(generation=generation),
            "sourceName": source_name,
            "sourceItemLocator": _locator(
                "composition",
                (
                    "77777777-7777-4777-8777-777777777777"
                    if source_name == "SOURCE_COMP_A"
                    else "88888888-8888-4888-8888-888888888888"
                ),
                generation=generation,
            ),
        },
    )


def _config(tmp_path: Path) -> object:
    receipt = driver.base_hdev.FormalAEProcessReceipt(
        formal_ae_app=str(tmp_path / "formal-ae.app"),
        executable_path=str(
            tmp_path / "formal-ae.app/Contents/MacOS/AfterFX"
        ),
        pid=4321,
        start_token="Tue Jul 29 10:11:12 2026",
    )
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
        formal_process_receipt=receipt,
    )


def _create_formal_ae_app(path: Path) -> Path:
    executable = path / "Contents/MacOS/AfterFX"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"formal-ae")
    executable.chmod(0o755)
    (path / "Contents/Info.plist").write_bytes(
        plistlib.dumps({"CFBundleExecutable": "AfterFX"})
    )
    return executable.resolve()


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
        "ownerMarker": config.owner_marker,
        "formalAeApp": str(config.formal_ae_app),
        "formalProcessReceipt": {
            "formalAeApp": str(config.formal_ae_app),
            "executablePath": str(
                config.formal_ae_app / "Contents/MacOS/AfterFX"
            ),
            "pid": 4321,
            "startToken": "Tue Jul 29 10:11:12 2026",
        },
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
    negative_rows = [
        row for row in spec.CALL_PLAN if row.expected_error is not None
    ]
    assert len(negative_rows) == 5
    assert {row.disposition for row in negative_rows} == {"write"}
    operation_addresses = [
        row.arguments["idempotency_key"] for row in negative_rows
    ]
    assert all(
        address.startswith("$operation_key:negative-")
        for address in operation_addresses
    )
    assert len(set(operation_addresses)) == 5


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
    read_row = runner.defects.row("audio-disable-read")
    assert read_row["status"] == "FAIL"
    assert read_row["failingLayer"] == "uncertain-write-state-readback"
    assert read_row["reconciliation"] == "observed-before-not-after"
    assert read_row["evidenceIds"] == list(runner.call_evidence["audio-disable-read"])
    summary = {
        call["key"]: call
        for call in runner.call_summary()
    }
    assert summary["audio-disable-read"]["status"] == "FAIL"
    assert summary["audio-disable-read"]["value"]["audioEnabled"] is True
    assert not any(
        call["status"] == "PASS"
        and call["key"] == "audio-disable-read"
        for call in summary.values()
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
@pytest.mark.parametrize(
    "failed_key",
    [
        "source-reacquire-project",
        "source-reacquire-layers",
        "source-read-b",
        "source-transform-after",
    ],
)
async def test_every_source_verification_stage_recovers_before_independent_work(
    tmp_path,
    failed_key,
):
    independent = _native_payload(
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
        [
            (False, _project_items_payload()),
            (False, _main_layers_payload()),
            (False, _source_details_payload("SOURCE_COMP_A")),
            (False, independent),
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
        key="source-replace-a-to-b",
        phase="source",
        tool="ae_setLayerSource",
        arguments={"idempotency_key": "source-key"},
        evidence_ids=("source-write-request", "source-write-response"),
        payload={},
        failing_layer="post-write-public-readback",
    )
    runner.pending_writes.append(pending)
    runner.call_evidence[failed_key] = (
        f"{failed_key}-request",
        f"{failed_key}-response",
    )

    handled = await runner._recover_verification_failure(
        session,
        failed_key,
        driver.Issue190Failure(f"{failed_key} failed"),
    )

    assert handled is True
    assert [tool for tool, _arguments in session.calls] == [
        "ae_listProjectItems",
        "ae_listCompositionLayers",
        "ae_getLayerSource",
    ]
    assert len(session.responses) == 1
    assert runner.pending_writes == []
    assert runner.fixture_baseline_restored is True
    assert runner.defects.row(failed_key)["status"] == "FAIL"
    write_row = runner.defects.row("source-replace-a-to-b")
    assert write_row["status"] == "FAIL"
    assert write_row["reconciliation"] == "readback-failed-restored"
    assert runner._tool_row("ae_setLayerSource")["undo"] == {
        "executed": 1,
        "verified": 1,
    }


@pytest.mark.asyncio
async def test_expected_negative_write_is_safe_only_when_not_started(tmp_path):
    response = {
        "ok": False,
        "error": {
            "code": "INVALID_ARGUMENT",
            "retryable": False,
            "sideEffect": "not-started",
            "details": {"field": "matte_layer_locator"},
        },
    }
    session = FakeSession((True, response))
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    observed = await runner.public_call(
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
        write=True,
        expected_error="INVALID_ARGUMENT",
    )

    assert observed["error"]["sideEffect"] == "not-started"
    assert runner.unreconciled_write is False
    assert runner.fixture_baseline_restored is True
    assert len(session.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_kind", ["possible", "transport"])
async def test_uncertain_negative_write_stops_unreconciled_without_map_lookup(
    tmp_path,
    failure_kind,
):
    if failure_kind == "possible":
        response = (
            True,
            {
                "ok": False,
                "error": {
                    "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
                    "retryable": False,
                    "sideEffect": "possible",
                    "details": {
                        "operationId": "negative-operation",
                        "idempotencyKey": "negative-self-key",
                    },
                },
            },
        )
        session = FakeSession(response)
    else:
        class BrokenNegativeSession(FakeSession):
            async def call(self, tool: str, arguments: dict):
                self.calls.append((tool, arguments))
                raise ConnectionError("negative transport lost")

        session = BrokenNegativeSession((False, {}))
    runner = driver.Issue190Runner(
        _config(tmp_path),
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
    )

    with pytest.raises(driver.UncertainWrite) as caught:
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
            write=True,
            expected_error="INVALID_ARGUMENT",
        )
    with pytest.raises(driver.ImmediateStop, match="uncertain negative write"):
        runner._stop_uncertain_negative(caught.value)

    assert len(session.calls) == 1
    assert runner.unreconciled_write is True
    assert runner.fixture_baseline_restored is False
    row = runner.defects.row("negative-self-matte")
    assert row["status"] == "INDETERMINATE"
    assert row["reconciliation"] == "unreconciled-no-frozen-read"
    assert row["sideEffectState"] == "possible"
    assert row["evidenceIds"] == list(caught.value.evidence_ids)


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
            write=True,
            expected_error="INVALID_ARGUMENT",
        )
    assert len(session.calls) == 1
    assert runner.unreconciled_write is True
    assert runner.fixture_baseline_restored is False
    row = runner.defects.row("negative-self-matte")
    assert row["status"] == "INDETERMINATE"
    assert row["reconciliation"] == "unreconciled"


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
        owned_process_probe=_sequence_owned_process_probe(config, ["absent"]),
    )
    runner.claim_fixture()
    config.fixture_path.write_bytes(b"fixture")
    wav_path = driver.generate_fixture_wav(config)
    runner.current_wav_path = wav_path
    runner.lifecycle.update({"created": 1, "active": 1})
    runner.formal_process_owned = True

    result = await runner.finalize_owned_fixture(
        "structured development evidence complete"
    )
    archived = config.recovery_root / config.run_id / result["archiveName"]

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
        owned_process_probe=_sequence_owned_process_probe(config, ["absent"]),
    )
    runner.claim_fixture()
    config.fixture_path.write_bytes(b"fixture")
    runner.current_wav_path = driver.generate_fixture_wav(config)
    runner.lifecycle.update({"created": 1, "active": 1})
    runner.formal_process_owned = True

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
        # The generic process check is only an informational hint.
        after_effects_running=lambda: driver.completed_process_check(False),
        # Exact owned-process absence is the archive precondition.
        owned_process_probe=_sequence_owned_process_probe(config, ["absent"]),
    )
    runner.claim_fixture()
    config.fixture_path.write_bytes(b"fixture-after-transport-loss")
    runner.current_wav_path = driver.generate_fixture_wav(config)
    runner.lifecycle.update({"created": 1, "active": 1})
    runner.formal_process_owned = True
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


@pytest.mark.asyncio
async def test_base_checkpoint_failure_without_process_ownership_stays_active(
    tmp_path,
):
    config = _config(tmp_path)

    async def checkpoint(name: str, _payload: dict) -> None:
        if name == "create-or-reset-issue190-fixture":
            config.fixture_path.write_bytes(b"fixture-created-before-checkpoint-failure")
        raise driver.base_hdev.DevelopmentSmokeFailure("checkpoint transport failed")

    with pytest.raises(driver.Issue190Failure, match="ownership is not proven"):
        await driver.run_issue190_hdev(
            config,
            session=FakeSession((False, {})),
            checkpoint=checkpoint,
            after_effects_running=lambda: driver.completed_process_check(False),
        )

    assert config.fixture_path.is_file()
    assert not (config.recovery_root / config.run_id).exists()
    assert not (
        config.evidence_dir / f"{config.run_id}.summary.json"
    ).exists()


@pytest.mark.asyncio
async def test_generic_process_inspection_failure_cannot_override_exact_absence(
    tmp_path,
):
    config = _config(tmp_path)
    checkpoints: list[str] = []
    shutdowns: list[dict] = []

    async def checkpoint(name: str, _payload: dict) -> None:
        checkpoints.append(name)
        if name == "create-or-reset-issue190-fixture":
            config.fixture_path.write_bytes(b"owned-fixture")

    async def broken_process_check() -> bool:
        raise driver.base_hdev.DevelopmentSmokeFailure(
            "could not inspect formal AE process state"
        )

    async def owned_shutdown(details: dict) -> bool:
        shutdowns.append(details)
        return True

    async def owned_probe(_details: dict) -> dict:
        return _owned_process_observation(config, "absent")

    session = FakeSession((False, {}))
    session.tool_names = frozenset()
    result = await driver.run_issue190_hdev(
        config,
        session=session,
        checkpoint=checkpoint,
        after_effects_running=broken_process_check,
        owned_process_shutdown=owned_shutdown,
        owned_process_probe=owned_probe,
    )

    assert result.exit_code == 2
    assert checkpoints == ["create-or-reset-issue190-fixture"]
    assert shutdowns == []
    assert result.summary["aepLifecycle"]["active"] == 0
    assert result.summary["aepLifecycle"]["unclassified"] == 0


@pytest.mark.asyncio
async def test_failed_normal_finalizer_uses_only_proven_owned_process_fallback(
    tmp_path,
):
    config = _config(tmp_path)
    shutdowns: list[dict] = []
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: _raise_checkpoint_failure(),
        after_effects_running=lambda: driver.completed_process_check(True),
        owned_process_shutdown=lambda details: _record_owned_shutdown(
            shutdowns, details
        ),
        owned_process_probe=_sequence_owned_process_probe(
            config,
            ["running", "running", "running", "running", "absent"],
        ),
    )
    runner.claim_fixture()
    config.fixture_path.write_bytes(b"owned-fixture")
    runner.lifecycle.update({"created": 1, "active": 1})
    runner.formal_process_owned = True

    result = await runner.finalize_failure("normal close checkpoint failed")

    assert result["disposition"] == "short-lived-recovery"
    assert len(shutdowns) == 1
    assert shutdowns[0]["ownershipProven"] is True
    assert shutdowns[0]["formalAeApp"] == str(config.formal_ae_app)
    assert runner.lifecycle["active"] == 0
    assert runner.lifecycle["unclassified"] == 0


@pytest.mark.asyncio
async def test_finalizer_refuses_shutdown_without_process_ownership_proof(tmp_path):
    config = _config(tmp_path)
    checkpoints: list[str] = []
    probes: list[dict] = []
    shutdowns: list[dict] = []

    async def checkpoint(name: str, _details: dict) -> None:
        checkpoints.append(name)

    async def probe(details: dict) -> dict:
        probes.append(details)
        return _owned_process_observation(config, "absent")

    runner = driver.Issue190Runner(
        config,
        checkpoint=checkpoint,
        after_effects_running=lambda: driver.completed_process_check(True),
        owned_process_shutdown=lambda details: _record_owned_shutdown(
            shutdowns, details
        ),
        owned_process_probe=probe,
    )
    runner.claim_fixture()
    config.fixture_path.write_bytes(b"unproven-process-fixture")
    runner.lifecycle.update({"created": 1, "active": 1})
    runner.formal_process_owned = False

    with pytest.raises(driver.Issue190Failure, match="ownership is not proven"):
        await runner.finalize_failure("cannot close unproven process")

    assert checkpoints == []
    assert probes == []
    assert shutdowns == []
    assert config.fixture_path.is_file()
    assert runner.lifecycle["active"] == 1


async def _raise_checkpoint_failure() -> None:
    raise driver.base_hdev.DevelopmentSmokeFailure("normal finalizer failed")


async def _record_owned_shutdown(rows: list[dict], details: dict) -> bool:
    rows.append(details)
    return True


def _sequence_owned_process_probe(config, states: list[str]):
    observations = [
        _owned_process_observation(config, state) for state in states
    ]

    async def probe(_details: dict) -> dict:
        assert observations, "unexpected owned-process probe"
        return observations.pop(0)

    return probe


def _owned_process_observation(
    config,
    state: str,
    *,
    run_id: str | None = None,
) -> dict:
    return {
        "state": state,
        "identity": {
            "runId": run_id or config.run_id,
            "fixturePath": str(config.fixture_path),
            "ownerMarker": config.owner_marker,
            "formalAeApp": str(config.formal_ae_app),
            "pid": config.formal_process_receipt.pid,
            "executablePath": (
                config.formal_process_receipt.executable_path
            ),
            "startToken": config.formal_process_receipt.start_token,
        },
    }


async def _run_failed_issue190_with_process_observations(
    config,
    observations: list[dict],
    *,
    normal_close_fails: bool = True,
    generic_running: bool = True,
    action_log: list[str] | None = None,
):
    checkpoints: list[str] = []
    probe_calls: list[dict] = []
    actions = action_log if action_log is not None else []

    async def checkpoint(name: str, _payload: dict) -> None:
        checkpoints.append(name)
        actions.append(f"checkpoint:{name}")
        if name == "create-or-reset-issue190-fixture":
            config.fixture_path.write_bytes(b"owned-fixture")
        if (
            name == "classify-and-close-failed-issue190-fixture"
            and normal_close_fails
        ):
            raise driver.base_hdev.DevelopmentSmokeFailure(
                "normal finalizer failed"
            )

    async def probe(details: dict) -> dict:
        probe_calls.append(details)
        actions.append("probe")
        assert observations, "unexpected owned-process probe"
        return observations.pop(0)

    session = FakeSession((False, {}))
    session.tool_names = frozenset()
    result = await driver.run_issue190_hdev(
        config,
        session=session,
        checkpoint=checkpoint,
        after_effects_running=lambda: driver.completed_process_check(
            generic_running
        ),
        owned_process_probe=probe,
    )
    return result, checkpoints, probe_calls


@pytest.mark.asyncio
async def test_shutdown_ack_does_not_archive_while_owned_process_keeps_running(
    tmp_path,
):
    config = _config(tmp_path)
    observations = [
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
    ]

    with pytest.raises(driver.Issue190Failure, match="remained present"):
        await _run_failed_issue190_with_process_observations(
            config, observations
        )

    assert config.fixture_path.is_file()
    assert not (config.recovery_root / config.run_id).exists()
    assert not (
        config.evidence_dir / f"{config.run_id}.summary.json"
    ).exists()


@pytest.mark.asyncio
async def test_shutdown_ack_archives_only_after_owned_process_becomes_absent(
    tmp_path,
    monkeypatch,
):
    config = _config(tmp_path)
    actions: list[str] = []
    real_move = driver.shutil.move
    real_finish = driver.DevelopmentEvidence.finish

    def move(source: str, destination: str):
        actions.append("move")
        return real_move(source, destination)

    def finish(evidence, **kwargs):
        actions.append("summary")
        return real_finish(evidence, **kwargs)

    monkeypatch.setattr(driver.shutil, "move", move)
    monkeypatch.setattr(driver.DevelopmentEvidence, "finish", finish)
    observations = [
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "running"),
        _owned_process_observation(config, "absent"),
    ]

    result, checkpoints, probe_calls = (
        await _run_failed_issue190_with_process_observations(
            config, observations, action_log=actions
        )
    )

    assert result.summary["aepLifecycle"]["active"] == 0
    assert result.summary["aepLifecycle"]["unclassified"] == 0
    assert not config.fixture_path.exists()
    assert (config.recovery_root / config.run_id).is_dir()
    assert "stop-owned-formal-ae-fallback" in checkpoints
    assert len(probe_calls) == 6
    assert actions[:7] == [
        "checkpoint:create-or-reset-issue190-fixture",
        "probe",
        "checkpoint:guarded-close-owned-issue190-fixture",
        "probe",
        "probe",
        "probe",
        "checkpoint:stop-owned-formal-ae-fallback",
    ]
    assert actions[7:9] == ["probe", "probe"]
    assert actions.index("move") > 8
    assert actions[-1] == "summary"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("observation", "message"),
    (
        ("mismatch", "identity mismatch"),
        ("unavailable", "probe is unavailable"),
    ),
)
async def test_unconfirmed_owned_process_probe_blocks_archive(
    tmp_path,
    observation,
    message,
):
    config = _config(tmp_path)
    process_observation = (
        _owned_process_observation(config, "absent", run_id="another-run")
        if observation == "mismatch"
        else _owned_process_observation(config, "unavailable")
    )

    with pytest.raises(driver.Issue190Failure, match=message):
        await _run_failed_issue190_with_process_observations(
            config, [process_observation]
        )

    assert config.fixture_path.is_file()
    assert not (config.recovery_root / config.run_id).exists()
    assert not (
        config.evidence_dir / f"{config.run_id}.summary.json"
    ).exists()


@pytest.mark.asyncio
async def test_exact_absence_archives_without_close_or_shutdown_fallback(tmp_path):
    config = _config(tmp_path)
    result, checkpoints, probe_calls = (
        await _run_failed_issue190_with_process_observations(
            config,
            [_owned_process_observation(config, "absent")],
            normal_close_fails=False,
        )
    )

    assert result.summary["aepLifecycle"]["active"] == 0
    assert result.summary["aepLifecycle"]["unclassified"] == 0
    assert "classify-and-close-failed-issue190-fixture" not in checkpoints
    assert "stop-owned-formal-ae-fallback" not in checkpoints
    assert len(probe_calls) == 1


@pytest.mark.asyncio
async def test_generic_absence_waits_for_exact_absence_after_guarded_close(
    tmp_path,
):
    config = _config(tmp_path)
    actions: list[str] = []

    result, checkpoints, probe_calls = (
        await _run_failed_issue190_with_process_observations(
            config,
            [
                _owned_process_observation(config, "running"),
                _owned_process_observation(config, "absent"),
            ],
            normal_close_fails=False,
            generic_running=False,
            action_log=actions,
        )
    )

    assert result.summary["aepLifecycle"]["active"] == 0
    assert result.summary["aepLifecycle"]["unclassified"] == 0
    assert "guarded-close-owned-issue190-fixture" in checkpoints
    assert "stop-owned-formal-ae-fallback" not in checkpoints
    assert len(probe_calls) == 2
    assert actions == [
        "checkpoint:create-or-reset-issue190-fixture",
        "probe",
        "checkpoint:guarded-close-owned-issue190-fixture",
        "probe",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "observation",
    ("mismatch", "unavailable"),
)
async def test_generic_absence_with_unconfirmed_exact_probe_takes_no_action(
    tmp_path,
    observation,
):
    config = _config(tmp_path)
    actions: list[str] = []
    process_observation = (
        _owned_process_observation(config, "absent", run_id="another-run")
        if observation == "mismatch"
        else _owned_process_observation(config, "unavailable")
    )

    with pytest.raises(driver.Issue190Failure):
        await _run_failed_issue190_with_process_observations(
            config,
            [process_observation],
            normal_close_fails=False,
            generic_running=False,
            action_log=actions,
        )

    assert actions == [
        "checkpoint:create-or-reset-issue190-fixture",
        "probe",
    ]
    assert config.fixture_path.is_file()
    assert not (config.recovery_root / config.run_id).exists()
    assert not (
        config.evidence_dir / f"{config.run_id}.summary.json"
    ).exists()


@pytest.mark.asyncio
async def test_exact_running_then_absent_uses_guarded_close_without_fallback(
    tmp_path,
):
    config = _config(tmp_path)

    result, checkpoints, probe_calls = (
        await _run_failed_issue190_with_process_observations(
            config,
            [
                _owned_process_observation(config, "running"),
                _owned_process_observation(config, "absent"),
            ],
            normal_close_fails=False,
        )
    )

    assert result.summary["aepLifecycle"]["active"] == 0
    assert result.summary["aepLifecycle"]["unclassified"] == 0
    assert "guarded-close-owned-issue190-fixture" in checkpoints
    assert "stop-owned-formal-ae-fallback" not in checkpoints
    assert len(probe_calls) == 2


def _prepared_owned_runner(config, states: list[str], actions: list[str]):
    observations = [
        _owned_process_observation(config, state) for state in states
    ]

    async def checkpoint(name: str, _details: dict) -> None:
        actions.append(f"checkpoint:{name}")

    async def probe(_details: dict) -> dict:
        actions.append("probe")
        assert observations, "unexpected owned-process probe"
        return observations.pop(0)

    async def shutdown(_details: dict) -> bool:
        actions.append("shutdown")
        return True

    runner = driver.Issue190Runner(
        config,
        checkpoint=checkpoint,
        after_effects_running=lambda: driver.completed_process_check(False),
        owned_process_shutdown=shutdown,
        owned_process_probe=probe,
    )
    runner.claim_fixture()
    runner.formal_process_owned = True
    return runner


@pytest.mark.asyncio
async def test_manifest_only_recovery_requires_exact_absence_before_move(
    tmp_path,
    monkeypatch,
):
    config = _config(tmp_path)
    actions: list[str] = []
    runner = _prepared_owned_runner(config, ["absent"], actions)
    runner.lifecycle.update({"created": 1, "active": 1})
    real_move = driver.shutil.move

    def move(source: str, destination: str):
        actions.append("move")
        return real_move(source, destination)

    monkeypatch.setattr(driver.shutil, "move", move)
    result = await runner.finalize_owned_fixture("fixture vanished")

    assert result["disposition"] == "manifest-only-recovery"
    assert actions == ["probe", "move"]
    assert runner.lifecycle["active"] == 0
    assert runner.lifecycle["unclassified"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ("running", "mismatch", "unavailable"))
async def test_manifest_only_unconfirmed_process_never_moves_or_affects_ae(
    tmp_path,
    monkeypatch,
    state,
):
    config = _config(tmp_path)
    actions: list[str] = []
    runner = _prepared_owned_runner(config, [state], actions)
    runner.lifecycle.update({"created": 1, "active": 1})
    moves: list[tuple[str, str]] = []
    monkeypatch.setattr(
        driver.shutil,
        "move",
        lambda source, destination: moves.append((source, destination)),
    )

    with pytest.raises(driver.Issue190Failure):
        await runner.finalize_owned_fixture("fixture vanished")

    assert actions == ["probe"]
    assert moves == []
    assert config.ownership_manifest_path.is_file()
    assert runner.lifecycle["active"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "filesystem_state",
    ("fixture-without-manifest", "recorded-fixture-missing"),
)
async def test_contradictory_owned_fixture_state_never_probes_or_moves(
    tmp_path,
    monkeypatch,
    filesystem_state,
):
    config = _config(tmp_path)
    actions: list[str] = []
    runner = driver.Issue190Runner(
        config,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
        owned_process_probe=lambda _details: _record_probe(actions),
    )
    runner.lifecycle.update({"created": 1, "active": 1})
    runner.formal_process_owned = True
    if filesystem_state == "fixture-without-manifest":
        config.fixture_path.parent.mkdir(parents=True)
        config.fixture_path.write_bytes(b"unowned-fixture")
    moves: list[tuple[str, str]] = []
    monkeypatch.setattr(
        driver.shutil,
        "move",
        lambda source, destination: moves.append((source, destination)),
    )

    with pytest.raises(driver.Issue190Failure):
        await runner.finalize_owned_fixture("contradictory fixture state")

    assert actions == []
    assert moves == []
    assert runner.lifecycle["active"] == 1


async def _record_probe(actions: list[str]) -> dict:
    actions.append("probe")
    return {}


@pytest.mark.asyncio
async def test_normal_run_uses_owned_finalizer_before_close_or_move(
    tmp_path,
    monkeypatch,
):
    config = _config(tmp_path)
    actions: list[str] = []
    real_move = driver.shutil.move
    observations = [_owned_process_observation(config, "absent")]

    async def no_product_calls(_session) -> None:
        return None

    async def checkpoint(name: str, _details: dict) -> None:
        actions.append(f"checkpoint:{name}")
        if name == "create-or-reset-issue190-fixture":
            config.fixture_path.write_bytes(b"owned-fixture")

    async def probe(_details: dict) -> dict:
        actions.append("probe")
        return observations.pop(0)

    def move(source: str, destination: str):
        actions.append("move")
        return real_move(source, destination)

    runner = driver.Issue190Runner(
        config,
        checkpoint=checkpoint,
        after_effects_running=lambda: driver.completed_process_check(False),
        owned_process_probe=probe,
    )
    runner.checkpoint = checkpoint
    runner.execute_plan = no_product_calls
    monkeypatch.setattr(driver.shutil, "move", move)
    details = await runner.run(FakeSession((False, {})))

    assert details["fixtureDisposition"]["disposition"] == (
        "short-lived-recovery"
    )
    assert actions[0] == "checkpoint:create-or-reset-issue190-fixture"
    assert actions[1] == "probe"
    assert not any(
        name == "checkpoint:close-and-archive-issue190-fixture"
        for name in actions
    )
    assert actions.index("probe") < actions.index("move")


@pytest.mark.asyncio
async def test_cli_wires_real_exact_process_adapter_into_normal_finalization(
    tmp_path,
    monkeypatch,
):
    config = _config(tmp_path)
    executable = _create_formal_ae_app(config.formal_ae_app)
    commands: list[tuple[str, ...]] = []

    async def inspect(command: tuple[str, ...]):
        commands.append(command)
        if command == ("/bin/ps", "-axo", "pid=,lstart=,comm="):
            return driver.base_hdev.ProcessInspectionResult(
                returncode=0,
                stdout=(
                    f" 9876 Tue Jul 29 11:12:13 2026 {executable}\n"
                ),
                stderr="",
            )
        return driver.base_hdev.ProcessInspectionResult(
            returncode=1,
            stdout="",
            stderr="",
        )

    monkeypatch.setattr(
        driver.base_hdev,
        "_run_process_inspection",
        inspect,
    )
    prepared, owned_process_probe = (
        await driver._prepare_cli_process_ownership(config)
    )

    assert owned_process_probe is not None
    assert prepared.formal_process_receipt.to_json() == {
        "formalAeApp": str(config.formal_ae_app.resolve()),
        "executablePath": str(executable),
        "pid": 9876,
        "startToken": "Tue Jul 29 11:12:13 2026",
    }
    runner = driver.Issue190Runner(
        prepared,
        checkpoint=lambda *_: driver.completed_checkpoint(),
        after_effects_running=lambda: driver.completed_process_check(False),
        owned_process_probe=owned_process_probe,
    )
    runner.claim_fixture()
    prepared.fixture_path.write_bytes(b"owned-fixture")
    runner.lifecycle.update({"created": 1, "active": 1})
    runner.formal_process_owned = True

    result = await runner.finalize_owned_fixture("normal CLI finalization")

    assert result["disposition"] == "short-lived-recovery"
    assert commands == [
        ("/bin/ps", "-axo", "pid=,lstart=,comm="),
        ("/bin/ps", "-p", "9876", "-o", "pid=,lstart=,comm="),
    ]
    assert runner.lifecycle["active"] == 0
    assert runner.lifecycle["unclassified"] == 0


@pytest.mark.asyncio
async def test_actual_cli_composition_uses_exact_probe_for_finalization(
    tmp_path,
    monkeypatch,
):
    config = _config(tmp_path)
    executable = _create_formal_ae_app(config.formal_ae_app)
    commands: list[tuple[str, ...]] = []
    checkpoints: list[str] = []

    async def inspect(command: tuple[str, ...]):
        commands.append(command)
        if command == ("/bin/ps", "-axo", "pid=,lstart=,comm="):
            return driver.base_hdev.ProcessInspectionResult(
                returncode=0,
                stdout=(
                    f" 9876 Tue Jul 29 11:12:13 2026 {executable}\n"
                ),
                stderr="",
            )
        return driver.base_hdev.ProcessInspectionResult(
            returncode=1,
            stdout="",
            stderr="",
        )

    @contextlib.asynccontextmanager
    async def live_session(_config):
        session = FakeSession((False, {}))
        session.tool_names = frozenset()
        yield session

    async def checkpoint(name: str, _details: dict) -> None:
        checkpoints.append(name)
        if name == "create-or-reset-issue190-fixture":
            config.fixture_path.write_bytes(b"owned-fixture")

    monkeypatch.setattr(
        driver.base_hdev,
        "_run_process_inspection",
        inspect,
    )
    monkeypatch.setattr(driver.base_hdev, "live_session", live_session)
    monkeypatch.setattr(driver.base_hdev, "stdin_checkpoint", checkpoint)

    exit_code = await driver._run_cli(config)

    assert exit_code == 2
    assert checkpoints == ["create-or-reset-issue190-fixture"]
    assert commands == [
        ("/bin/ps", "-axo", "pid=,lstart=,comm="),
        ("/bin/ps", "-p", "9876", "-o", "pid=,lstart=,comm="),
    ]
    assert not config.fixture_path.exists()
    assert (config.recovery_root / config.run_id).is_dir()
    assert list(config.evidence_dir.glob(f"{config.run_id}.summary.json"))


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
