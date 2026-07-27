"""Construction tests for Composition Settings plus previewFrame acceptance."""

from __future__ import annotations

import base64
import copy
import hashlib
import importlib.util
import io
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from PIL import Image

from ae_mcp import schemas
from ae_mcp.backends import native_project_composition as project_composition


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
runtime_module = _load(
    "capability_package_runtime", HARDWARE / "capability_package_runtime.py"
)
spec = _load(
    "composition_settings_spec", HARDWARE / "composition_settings_spec.py"
)
driver = _load(
    "composition_settings_acceptance",
    HARDWARE / "composition_settings_acceptance.py",
)


HOST = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
PROJECT = "33333333-3333-4333-8333-333333333333"
COMP = "44444444-4444-4444-8444-444444444444"


def _locator(kind: str, object_id: str = COMP) -> dict:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": 1,
        "objectId": object_id,
    }


def test_comp_settings_runner_call_budget_is_twenty_eight():
    assert [row.ordinal for row in spec.T5_CALL_PLAN] == list(range(1, 29))
    assert [row.ordinal for row in spec.T6_CALL_PLAN] == list(range(1, 18))
    assert spec.T5_CALL_PLAN != spec.T6_CALL_PLAN
    assert spec.SPEC.t5_target_calls == spec.SPEC.t5_hard_limit == 28
    assert spec.SPEC.t6_target_calls == spec.SPEC.t6_hard_limit == 17
    assert spec.T5_CALL_JUSTIFICATION["totalCalls"] == 28
    assert spec.T5_CALL_JUSTIFICATION["toolCount"] == 7
    assert spec.T5_CALL_JUSTIFICATION["normalWorkflowCeiling"] == 30
    assert spec.T5_CALL_JUSTIFICATION["withinDefaultCeiling"] is True
    assert "no extra authorization" in spec.T5_CALL_JUSTIFICATION["reason"]


def test_t6_replays_five_policy_grounds_and_explains_exactly_three_skips():
    replayed = {row.tool for row in spec.T6_CALL_PLAN if row.tool in spec.CONTRACTS}
    assert set(spec.T6_REPLAY_GROUNDS) == {
        "new-native-primitive-first-clean-build",
        "representative-shared-proven-primitive-family",
        "changed-after-candidate",
        "install-staging-generated-bundle-component-identity",
        "distinct-undo-model",
    }
    assert spec.T6_REPLAY_GROUNDS["new-native-primitive-first-clean-build"] == ()
    assert spec.T6_REPLAY_GROUNDS["changed-after-candidate"] == ()
    assert set(spec.T6_SKIPS) == set(spec.CONTRACTS) - replayed == {
        "ae_setCompositionFrameRate",
        "ae_setCompositionDuration",
        "ae_setCompositionPixelAspectRatio",
    }
    required = {
        "shared primitive", "shared Undo model",
        "shared locator scheme", "byte-identical to the candidate",
    }
    assert all(
        set(skip["grounds"]) == required
        and skip["replayedBy"] in replayed
        and skip["sources"]
        for skip in spec.T6_SKIPS.values()
    )


def test_all_six_write_schemas_and_preview_are_source_derived_and_closed():
    expected = {
        "ae_setCompositionDimensions",
        "ae_setCompositionDuration",
        "ae_setCompositionFrameRate",
        "ae_setCompositionPixelAspectRatio",
        "ae_setCompositionBackgroundColor",
        "ae_setCompositionDisplayStartTime",
        "ae_previewFrame",
    }
    assert set(spec.CONTRACTS) == expected
    for public_tool, expectation in spec.CONTRACTS.items():
        model = spec._published_schema(expectation.registry_name)
        schema = model.model_json_schema()
        assert schema["additionalProperties"] is False
        assert expectation.input_schema_sha256 == runtime_module.json_hash(schema)
        assert expectation.sources
        if public_tool == "ae_previewFrame":
            assert expectation.contract_digest == spec._preview_contract_digest()
            assert expectation.engine == "preview-mcp-content"
        else:
            native = project_composition.CAPABILITY_CONTRACTS[
                expectation.capability_id
            ]
            assert expectation.contract_digest == native.contract_digest
            assert expectation.engine == "native-aegp"


def test_support_call_expectations_are_also_bound_to_published_schemas():
    assert set(spec.SUPPORT_SCHEMAS) == {
        "ae_listProjectItems",
        "ae_getCompositionSettings",
        "ae_listCompositionLayers",
        "ae_listLayerProperties",
        "ae_listLayerPropertyKeyframes",
    }
    for item in spec.SUPPORT_SCHEMAS.values():
        model = spec._published_schema(item["registryName"])
        assert item["inputSchemaSha256"] == runtime_module.json_hash(
            model.model_json_schema()
        )
        assert item["source"] == spec.SCHEMA_SOURCE


def test_both_plans_chain_every_consumed_address_to_an_earlier_public_call():
    for plan, links in (
        (spec.T5_CALL_PLAN, spec.T5_ADDRESS_LINKS),
        (spec.T6_CALL_PLAN, spec.T6_ADDRESS_LINKS),
    ):
        consumers = {
            row.ordinal for row in plan if spec._symbolic_addresses(row.arguments)
        }
        assert {link.consumer_call for link in links} == consumers
        assert all(
            1 <= link.producer_call < link.consumer_call <= len(plan)
            and link.producer_path.startswith("value.")
            for link in links
        )


def test_preview_invalidates_locators_until_project_items_reacquires_them():
    for plan in (spec.T5_CALL_PLAN, spec.T6_CALL_PLAN):
        assert spec._preview_locator_violations(plan) == ()

    mutated = tuple(
        row for row in spec.T5_CALL_PLAN
        if row.key != "baseline-preview-reacquire"
    )
    assert spec._preview_locator_violations(mutated)


def test_fixture_recipe_is_single_slot_reopened_in_formal_ae_and_archived():
    recipe = " ".join(spec.FIXTURE_RECIPE)
    assert "exactly one ephemeral-validation" in recipe
    assert "Comp Settings Fixture" in recipe
    assert "Timing Witness" in recipe
    assert "1/1, 4/1, and 7/1" in recipe
    assert "never use Save As" in recipe
    assert "AE File > Open" in recipe
    assert "open Comp Settings Fixture in the active Composition viewer" in recipe
    assert "created 1" in recipe and "archived 1" in recipe


def test_visual_evidence_is_limited_to_dimensions_and_background():
    visual_writes = {
        tool for tool, evidence in spec.EVIDENCE_BY_TOOL.items()
        if evidence["visual"] and tool != "ae_previewFrame"
    }
    assert visual_writes == {
        "ae_setCompositionDimensions",
        "ae_setCompositionBackgroundColor",
    }
    assert spec.EVIDENCE_BY_TOOL["ae_setCompositionFrameRate"]["visual"] is False
    assert "decimal seconds" in spec.EVIDENCE_BY_TOOL[
        "ae_setCompositionFrameRate"
    ]["reason"]
    for tool in (
        "ae_setCompositionDuration",
        "ae_setCompositionFrameRate",
        "ae_setCompositionPixelAspectRatio",
        "ae_setCompositionDisplayStartTime",
    ):
        assert spec.EVIDENCE_BY_TOOL[tool]["readback"] is True
        assert spec.EVIDENCE_BY_TOOL[tool]["visual"] is False


def test_undo_checkpoints_cover_five_t5_writes_and_one_t6_undo_model():
    assert [row.undo_of for row in spec.T5_CALL_PLAN if row.undo_of] == [
        "background-set", "pixel-aspect-set", "dimensions-set",
        "duration-set", "frame-rate-set",
    ]
    assert [row.undo_of for row in spec.T6_CALL_PLAN if row.undo_of] == [
        "background-set", "dimensions-set",
    ]
    display_rows = [
        row for row in spec.T5_CALL_PLAN
        if row.tool == "ae_setCompositionDisplayStartTime"
    ]
    assert len(display_rows) == 2
    assert all(row.undo_of is None for row in display_rows)
    assert display_rows[1].restore_method == "compensating-public-write"


def test_operation_keys_are_fresh_per_run_and_reconciliation_reuses_original():
    def package(prefix: str):
        counter = 0

        def intent(name: str) -> str:
            nonlocal counter
            counter += 1
            return f"{prefix}:{name}:{counter}"

        return driver.CompositionSettingsPackage(
            SimpleNamespace(mode="t5", intent=intent),
            fixture_name="Comp Settings Fixture",
        )

    first, second = package("run-a"), package("run-b")
    original = first.operation_key("dimensions-set")
    assert first.operation_key("dimensions-set") == original
    assert first.reconciliation_key("dimensions-set") == original
    assert second.operation_key("dimensions-set") != original
    record = first.reconciliation_record("dimensions-set")
    assert record["idempotencyKey"] == original
    assert record["action"] == "read-state-and-audit-without-redispatch"
    assert "DUPLICATE_REQUEST" in record["duplicateContract"]
    assert "replayed=true is not assumed" in record["duplicateContract"]


def test_driver_captures_every_preview_reacquired_composition_locator():
    package = driver.CompositionSettingsPackage(
        SimpleNamespace(mode="t5"), fixture_name="Comp Settings Fixture"
    )
    fresh = {
        **_locator("composition"),
        "projectId": "55555555-5555-4555-8555-555555555555",
        "generation": 2,
        "objectId": "66666666-6666-4666-8666-666666666666",
    }
    package._capture(
        "baseline-preview-reacquire",
        {
            "value": {
                "items": [{
                    "name": "Comp Settings Fixture",
                    "locator": fresh,
                }]
            }
        },
    )
    assert package.context["composition_locator"] == fresh


class _Evidence:
    def __init__(self) -> None:
        self.events = []

    def record(self, event, payload):
        self.events.append((event, payload))


def _unit_runtime(mode: str = "t5"):
    evidence = _Evidence()
    runtime = SimpleNamespace(
        mode=mode,
        ledger=runtime_module.CallLedger(mode, spec.SPEC),
        evidence=evidence,
        matrix={
            case.tool: {
                "invocations": 0, "auditRequestIds": [],
                "status": "pending",
                "undo": {
                    "required": case.kind == "write",
                    "executed": 0, "verified": case.kind == "read",
                },
            }
            for case in spec.SPEC.tools
        },
        intent=lambda name: f"{mode}:{name}:fresh-key",
    )

    def mark_tool_passed(tool, *, undo_executed=False, undo_verified=False):
        row = runtime.matrix[tool]
        row["status"] = "passed"
        if undo_executed:
            row["undo"]["executed"] += 1
        if undo_verified:
            row["undo"]["verified"] = True

    runtime.mark_tool_passed = mark_tool_passed
    return runtime


def _display_payload(arguments: dict) -> dict:
    expectation = spec.CONTRACTS["ae_setCompositionDisplayStartTime"]
    request = "mcp-" + "a" * 32
    return {
        "ok": True,
        "replayed": False,
        "value": {
            "changed": True,
            "compositionLocator": _locator("composition"),
            "before": {},
            "after": {},
        },
        "implementation": {
            "engine": "native-aegp",
            "capabilityId": expectation.capability_id,
            "capabilityVersion": 1,
            "contractDigest": expectation.contract_digest,
            "undo": "none",
        },
        "provenance": {
            "engine": "native-aegp", "hostInstanceId": HOST, "sessionId": SESSION,
        },
        "audit": {
            "requestId": request,
            "idempotencyKey": arguments["idempotency_key"],
            "contractDigest": expectation.contract_digest,
            "effect": "committed",
            "postconditionDigest": "f" * 64,
            "undoAvailable": False,
            "undoVerified": False,
        },
        "evidence": {
            "requestId": request, "effect": "committed",
            "hostInstanceId": HOST, "sessionId": SESSION,
            "undo": {"available": False, "verified": False},
            "postcondition": {
                "verified": True,
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": "f" * 64,
            },
        },
    }


@pytest.mark.asyncio
async def test_display_start_asserts_no_undo_group_instead_of_skipping_check():
    runtime = _unit_runtime()
    package = driver.CompositionSettingsPackage(
        runtime, fixture_name="Comp Settings Fixture"
    )
    arguments = {
        "composition_locator": _locator("composition"),
        "display_start_time": {"value": -1, "scale": 1},
        "idempotency_key": "display-start-fresh-key",
    }

    class Session:
        async def call(self, _tool, received):
            return False, _display_payload(received)

    await package._display_call(Session(), arguments, phase="t5-display")
    undo = runtime.matrix["ae_setCompositionDisplayStartTime"]["undo"]
    assert undo == {
        "required": False,
        "executed": 0,
        "verified": False,
        "model": "compensating-public-write",
        "groupOpened": False,
    }
    response = [
        payload for event, payload in runtime.evidence.events
        if event == "public-tool-response"
    ][0]
    assert response["payload"]["evidence"]["undo"] == {
        "available": False, "verified": False,
    }
    assert "groupId" not in response["payload"]["evidence"]["undo"]


@pytest.mark.asyncio
async def test_display_start_records_uncertain_write_before_success_assertions():
    runtime = _unit_runtime()
    package = driver.CompositionSettingsPackage(
        runtime, fixture_name="Comp Settings Fixture"
    )
    arguments = {
        "composition_locator": _locator("composition"),
        "display_start_time": {"value": -1, "scale": 1},
        "idempotency_key": "display-start-uncertain-key",
    }

    class Session:
        async def call(self, _tool, _received):
            return True, {
                "ok": False,
                "error": {
                    "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
                    "sideEffect": "may-have-occurred",
                },
            }

    with pytest.raises(
        runtime_module.PossiblySideEffectingStop,
        match="reconcile state and audit before retry",
    ):
        await package._display_call(Session(), arguments, phase="t5-display")

    row = runtime.matrix["ae_setCompositionDisplayStartTime"]
    assert row["status"] == "failed"
    assert row["invocations"] == 1
    assert runtime.ledger.total == 1
    response = [
        payload for event, payload in runtime.evidence.events
        if event == "public-tool-response"
    ][0]
    assert response["payload"]["error"]["code"] == "POSSIBLY_SIDE_EFFECTING_FAILURE"


@pytest.mark.asyncio
async def test_preview_binds_background_rgb_and_records_expected_alpha_divergence():
    runtime = _unit_runtime()
    package = driver.CompositionSettingsPackage(
        runtime, fixture_name="Comp Settings Fixture"
    )
    package.expected_state = copy.deepcopy(driver.BASELINE_STATE)
    package.expected_state["width"] = 2
    package.expected_state["height"] = 2
    package.responses["baseline-settings"] = {
        "audit": {"requestId": "mcp-settings-read"}
    }
    image = Image.new("RGBA", (2, 2), (16, 32, 48, 0))
    image.putpixel((0, 0), (16, 32, 48, 255))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    png = buffer.getvalue()
    digest = hashlib.sha256(png).hexdigest()
    payload = {
        "ok": True,
        "compId": "7",
        "compName": "Comp Settings Fixture",
        "captureId": "a" * 32,
        "frames": [{
            "time": 0,
            "path": "/private/tmp/frame.png",
            "width": 2,
            "height": 2,
            "sizeBytes": len(png),
            "sha256": digest,
            "source": "comp",
            "method": "saveFrameToPng",
            "compId": "7",
        }],
    }
    content = (
        {"type": "text", "text": json.dumps(payload)},
        {
            "type": "image",
            "data": base64.b64encode(png).decode(),
            "mimeType": "image/png",
        },
    )

    class Session:
        async def call_result(self, _tool, _arguments):
            return driver.PublicResult(False, payload, content, payload)

    await package._preview_call(
        Session(),
        {"time": 0.0, "include_base64": False, "scale": 1.0},
        phase="t5-baseline-preview",
    )
    verified = [
        item for event, item in runtime.evidence.events
        if event == "preview-image-verification"
    ][0]["frames"][0]
    assert verified["dimensions"] == (2, 2)
    assert verified["sha256"] == digest
    assert verified["matchingBackgroundRgbPixels"] == 4
    assert verified["matchingBackgroundRgbAlphaCounts"] == {"0": 3, "255": 1}
    assert verified["alphaDivergence"] == {
        "status": "observed-expected",
        "typedSettingAlpha": 255,
        "uncoveredRenderedAlpha": 0,
        "transparentMatchingRgbPixels": 3,
        "semantic": (
            "AE paints the composition background RGB in its viewport without "
            "compositing it into exported alpha."
        ),
    }
    assert verified["precedingSettingsAuditRequestId"] == "mcp-settings-read"


def test_one_driver_selects_only_t5_or_t6_and_no_t4_plan_exists():
    assert spec.T4_REQUIRED is False
    assert "already-proven AEGP_CompSuite12" in spec.NO_T4_REASON
    assert driver.CompositionSettingsPackage(
        SimpleNamespace(mode="t5"), fixture_name="Comp Settings Fixture"
    ).plan is spec.T5_CALL_PLAN
    assert driver.CompositionSettingsPackage(
        SimpleNamespace(mode="t6"), fixture_name="Comp Settings Fixture"
    ).plan is spec.T6_CALL_PLAN
    with pytest.raises(runtime_module.AcceptanceFailure):
        driver.CompositionSettingsPackage(
            SimpleNamespace(mode="t4"), fixture_name="Comp Settings Fixture"
        )


def test_tools_list_requirements_include_six_schemas_preview_and_support_chain():
    required = {
        case.tool for case in (*spec.SPEC.tools, *spec.SPEC.support_tools)
    }
    assert required == {
        *spec.CONTRACTS,
        "ae_listProjectItems",
        "ae_getCompositionSettings",
        "ae_listCompositionLayers",
        "ae_listLayerProperties",
        "ae_listLayerPropertyKeyframes",
    }
    assert len(spec.SPEC.tools) == 7
