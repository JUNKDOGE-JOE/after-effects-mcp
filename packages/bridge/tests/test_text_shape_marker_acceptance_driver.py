"""Construction tests for the frozen 44-call Text/Shape/Marker driver."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

from ae_mcp.backends import maintained_text
from ae_mcp.backends import native_text_shape_marker as native_tsm
from ae_mcp.schemas_tsm import PUBLIC_SCHEMAS


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
spec = _load("text_shape_marker_spec", HARDWARE / "text_shape_marker_spec.py")
driver = _load(
    "text_shape_marker_acceptance",
    HARDWARE / "text_shape_marker_acceptance.py",
)


HOST = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
PROJECT = "33333333-3333-4333-8333-333333333333"
COMP = "44444444-4444-4444-8444-444444444444"
TEXT = "55555555-5555-4555-8555-555555555555"


def _locator(kind: str, object_id: str, generation: int = 1) -> dict:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": object_id,
    }


def test_plan_has_explicit_authorized_44_call_ceiling_and_restart_path():
    assert [row.ordinal for row in spec.CALL_PLAN] == list(range(1, 45))
    assert spec.SPEC.t5_target_calls == spec.SPEC.t5_hard_limit == 44
    assert spec.SPEC.t6_target_calls == spec.SPEC.t6_hard_limit == 44
    assert spec.CALL_CEILING_AUTHORIZATION == {
        "brief": spec.BRIEF_CALL_BUDGET_SOURCE,
        "authorizedCalls": 44,
        "normalWorkflowCeiling": 30,
        "reason": (
            "The frozen brief explicitly authorizes T5 and T6 to use exactly "
            "44 public calls and requires abort before call 45."
        ),
    }
    assert spec.REOPEN_PROCEDURE["requiredPath"] == "AE File > Open Recent"
    assert set(spec.REOPEN_PROCEDURE["forbiddenPaths"]) == {
        "Finder",
        "file double-click",
        "LaunchServices",
    }
    assert spec.CALL_PLAN[42].key == "post-restart-composition-reacquire"
    assert spec.CALL_PLAN[43].key == "post-restart-empty-baseline"


def test_all_17_expectations_are_derived_from_the_published_contracts():
    assert set(spec.CONTRACTS) == {
        name.replace(".", "_") for name in PUBLIC_SCHEMAS
    }
    for public_tool, expectation in spec.CONTRACTS.items():
        model = PUBLIC_SCHEMAS[expectation.registry_name]
        assert expectation.input_schema_sha256 == runtime_module.json_hash(
            model.model_json_schema()
        )
        assert expectation.sources
        if public_tool in {
            name.replace(".", "_") for name in maintained_text.TEXT_TOOLS
        }:
            template_id, operation_file, write = maintained_text.TEXT_TOOLS[
                expectation.registry_name
            ]
            assert expectation.engine == "maintained-jsx"
            assert expectation.native_provenance is False
            assert expectation.contract_id == template_id
            assert expectation.template_digest == spec._template_digest(
                operation_file
            )
            assert expectation.contract_digest == maintained_text.digest(
                {
                    "inputSchema": model.model_json_schema(),
                    "valueSchema": maintained_text.VALUE_MODELS[
                        expectation.registry_name
                    ].model_json_schema(by_alias=True),
                }
            )
            assert expectation.kind == ("write" if write else "read")
        else:
            contract = native_tsm.CAPABILITY_CONTRACTS[
                expectation.contract_id
            ]
            assert expectation.engine == "native-aegp"
            assert expectation.native_provenance is True
            assert expectation.contract_digest == contract.contract_digest


def test_text_schema_and_locator_chain_are_publicly_indistinguishable():
    assert set(PUBLIC_SCHEMAS["ae.createTextLayer"].model_fields) >= {
        "composition_locator",
        "name",
        "text",
    }
    assert "composition_id" not in PUBLIC_SCHEMAS[
        "ae.createTextLayer"
    ].model_fields
    for name in (
        "ae.getTextDocument",
        "ae.setTextContent",
        "ae.setTextCharacterStyle",
        "ae.setTextParagraphStyle",
    ):
        assert "layer_locator" in PUBLIC_SCHEMAS[name].model_fields
        assert "target" not in PUBLIC_SCHEMAS[name].model_fields
    assert spec.TEXT_LOCATOR_CHAIN == {
        "ae_createTextLayer": (
            "call 3 ae_listProjectItems supplies "
            "value.items[TSM Acceptance Fixture].locator"
        ),
        "ae_getTextDocument": (
            "call 6 ae_createTextLayer supplies value.after.layerLocator"
        ),
        "ae_setTextContent": (
            "call 7 ae_getTextDocument supplies value.layerLocator"
        ),
        "ae_setTextCharacterStyle": (
            "call 9 ae_getTextDocument supplies value.layerLocator"
        ),
        "ae_setTextParagraphStyle": (
            "call 11 ae_getTextDocument supplies value.layerLocator"
        ),
    }


def test_every_address_link_points_strictly_backward_to_a_public_response():
    assert all(
        link.producer_call < link.consumer_call for link in spec.ADDRESS_LINKS
    )
    assert {link.consumer_call for link in spec.ADDRESS_LINKS} == {
        row.ordinal
        for row in spec.CALL_PLAN
        if any(
            key in row.arguments
            for key in (
                "composition_locator",
                "layer_locator",
                "group_ref",
                "target",
                "marker_ref",
            )
        )
    }
    for link in spec.ADDRESS_LINKS:
        assert 1 <= link.producer_call < link.consumer_call <= 44
        assert link.producer_path.startswith("value.")


def test_driver_constructs_text_calls_only_from_prior_public_locators():
    counter = 0

    def intent(name: str) -> str:
        nonlocal counter
        counter += 1
        return f"issue170:{name}:session-a-{counter:02d}"

    runtime = SimpleNamespace(intent=intent)
    package = driver.TextShapeMarkerPackage(
        runtime, fixture_name="TSM Acceptance Fixture"
    )
    composition = _locator("composition", COMP)
    text = _locator("layer", TEXT, 2)
    package._capture(
        "composition-reacquire",
        {
            "value": {
                "items": [
                    {
                        "name": "TSM Acceptance Fixture",
                        "type": "composition",
                        "locator": composition,
                    }
                ]
            }
        },
    )
    create_args = package._resolve(spec.CALL_PLAN[5].arguments)
    assert create_args["composition_locator"] == composition
    assert "composition_id" not in create_args
    package._capture(
        "text-create",
        {
            "value": {
                "compositionLocator": {**composition, "generation": 2},
                "after": {"layerLocator": text},
            }
        },
    )
    read_args = package._resolve(spec.CALL_PLAN[6].arguments)
    assert read_args == {"layer_locator": text}
    package._capture("text-read", {"value": {"layerLocator": text}})
    content_args = package._resolve(spec.CALL_PLAN[7].arguments)
    assert content_args["layer_locator"] == text
    assert content_args["idempotency_key"].startswith(
        "issue170:text-content-set:session-a-"
    )


def test_operation_key_is_fresh_per_session_but_reconciliation_reuses_original():
    def make(prefix: str):
        count = 0

        def intent(name: str) -> str:
            nonlocal count
            count += 1
            return f"{prefix}:{name}:{count}"

        return driver.TextShapeMarkerPackage(
            SimpleNamespace(intent=intent),
            fixture_name="TSM Acceptance Fixture",
        )

    first = make("run-a")
    second = make("run-b")
    original = first.operation_key("fill-restyle")
    assert first.operation_key("fill-restyle") == original
    assert second.operation_key("fill-restyle") != original
    assert first.operation_key("stroke-restyle") != original


def test_fill_and_stroke_interactions_and_undo_boundaries_are_separate():
    keys = [row.key for row in spec.CALL_PLAN]
    assert keys.index("triangle-create") < keys.index("fill-restyle")
    assert keys.index("fill-restyle") < keys.index("stroke-restyle")
    assert keys.index("stroke-restyle") < keys.index("group-reorder")
    assert keys.index("group-reorder-undo-read") < keys.index(
        "stroke-restyle-undo-read"
    )
    assert keys.index("stroke-restyle-undo-read") < keys.index(
        "fill-restyle-undo-read"
    )
    assertions = {
        row.key: row.state_assertion
        for row in spec.CALL_PLAN
        if row.key
        in {
            "fill-restyle",
            "stroke-restyle",
            "group-reorder",
            "stroke-restyle-undo-read",
            "fill-restyle-undo-read",
        }
    }
    assert "Create-then-restyle fill" in assertions["fill-restyle"]
    assert "Create-then-restyle stroke" in assertions["stroke-restyle"]
    assert "Restyle-then-reorder" in assertions["group-reorder"]
    assert "Restyle-then-Undo" in assertions["stroke-restyle-undo-read"]
    assert "Restyle-then-Undo" in assertions["fill-restyle-undo-read"]

    package_write_keys = {
        row.key
        for row in spec.CALL_PLAN
        if row.tool in spec.CONTRACTS
        and spec.CONTRACTS[row.tool].kind == "write"
    }
    assert {row.undo_of for row in spec.CALL_PLAN if row.undo_of} == (
        package_write_keys
    )
