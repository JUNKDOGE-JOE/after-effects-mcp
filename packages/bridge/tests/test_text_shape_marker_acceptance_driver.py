"""Construction tests for both Text/Shape/Marker acceptance plans."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import stat
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

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
capability_generator = _load(
    "generate_text_shape_marker_capabilities",
    ROOT / "scripts/generate_text_shape_marker_capabilities.py",
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


def test_t5_has_explicit_authorized_44_call_fence_and_restart_path():
    assert [row.ordinal for row in spec.T5_CALL_PLAN] == list(range(1, 45))
    assert spec.SPEC.t5_target_calls == spec.SPEC.t5_hard_limit == 44
    assert spec.CALL_CEILING_AUTHORIZATION == {
        "brief": spec.BRIEF_CALL_BUDGET_SOURCE,
        "tier": "t5",
        "authorizedCalls": 44,
        "normalWorkflowCeiling": 30,
        "reason": (
            "The frozen brief explicitly authorizes T5 to use exactly 44 "
            "public calls and requires abort before call 45; this "
            "authorization must not be re-clamped by downstream runners."
        ),
    }
    assert spec.REOPEN_PROCEDURE["requiredPath"] == "AE File > Open Recent"
    assert set(spec.REOPEN_PROCEDURE["forbiddenPaths"]) == {
        "Finder",
        "file double-click",
        "LaunchServices",
    }
    assert spec.T5_CALL_PLAN[42].key == "post-restart-composition-reacquire"
    assert spec.T5_CALL_PLAN[43].key == "post-restart-empty-baseline"


def test_t4_is_the_exact_four_call_markersuite3_plan():
    assert [row.ordinal for row in spec.T4_CALL_PLAN] == [1, 2, 3, 4]
    assert [row.tool for row in spec.T4_CALL_PLAN] == [
        "ae_listMarkers",
        "ae_createMarker",
        "ae_listMarkers",
        "ae_listMarkers",
    ]
    assert spec.T4_CALL_PLAN[3].undo_of == "t4-marker-create"
    assert spec.SPEC.t4_target_calls == spec.SPEC.t4_hard_limit == 4


def test_t6_is_the_policy_derived_30_call_reduction_with_explained_skips():
    assert [row.ordinal for row in spec.T6_CALL_PLAN] == list(range(1, 31))
    assert spec.SPEC.t6_target_calls == spec.SPEC.t6_hard_limit == 30
    assert spec.T6_CALL_PLAN[28].key == "post-restart-composition-reacquire"
    assert spec.T6_CALL_PLAN[29].key == "post-restart-family-layers"
    replayed = {
        row.tool for row in spec.T6_CALL_PLAN if row.tool in spec.CONTRACTS
    }
    assert set(spec.T6_SKIPS) == set(spec.CONTRACTS) - replayed == {
        "ae_setTextContent",
        "ae_setTextParagraphStyle",
        "ae_setShapeFillStyle",
    }
    required_grounds = {
        "shared primitive",
        "shared Undo model",
        "shared locator scheme",
        "byte-identical to the candidate",
    }
    assert all(
        set(skip["grounds"]) == required_grounds
        and skip["replayedBy"] in replayed
        and skip["sources"] == (
            spec.T6_POLICY_SOURCE,
            spec.T6_BRIEF_SOURCE,
        )
        for skip in spec.T6_SKIPS.values()
    )
    assert set(spec.T6_REPLAY_GROUNDS) == {
        "new-native-primitive-first-clean-build",
        "representative-shared-proven-primitive-family",
        "changed-after-candidate",
        "install-staging-generated-bundle-component-identity",
        "distinct-undo-model",
    }
    assert spec.T6_REPLAY_GROUNDS["changed-after-candidate"] == ()
    assert spec.T6_REPLAY_GROUNDS[
        "install-staging-generated-bundle-component-identity"
    ] == ("ae_projectSummary",)


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


def test_native_protocol_registry_advertises_all_11_frozen_contracts():
    fixture = json.loads(
        (
            ROOT
            / "native/ae-plugin/protocol/fixtures/capabilities.json"
        ).read_text()
    )
    items = {
        item["id"]: item
        for item in fixture["response"]["result"]["items"]
    }
    assert len(items) == 54
    assert set(native_tsm.CAPABILITY_CONTRACTS) <= set(items)
    for capability_id, contract in native_tsm.CAPABILITY_CONTRACTS.items():
        descriptor = items[capability_id]
        assert descriptor["contractDigest"] == contract.contract_digest
        assert descriptor["inputSchema"] == contract.input_schema
        assert descriptor["resultSchema"] == contract.result_schema
        assert descriptor["requirements"] == [
            {"id": contract.requirement_id, "contractVersion": 1}
        ]


def test_native_protocol_registry_generated_projections_are_current():
    for path, expected in capability_generator._outputs().items():
        assert path.read_text() == expected, path.relative_to(ROOT)


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
            "call 3 ae_listCompositionLayers supplies "
            "value.compositionLocator"
        ),
        "ae_getTextDocument": (
            "call 5 ae_createTextLayer supplies value.after.layerLocator"
        ),
        "ae_setTextContent": (
            "call 6 ae_getTextDocument supplies value.layerLocator"
        ),
        "ae_setTextCharacterStyle": (
            "call 8 ae_getTextDocument supplies value.layerLocator"
        ),
        "ae_setTextParagraphStyle": (
            "call 10 ae_getTextDocument supplies value.layerLocator"
        ),
    }


@pytest.mark.asyncio
async def test_uncertain_second_invocation_overrides_an_earlier_passed_status():
    events = []

    class Evidence:
        def record(self, event, payload):
            events.append((event, payload))

    class Session:
        tool_names = frozenset({"ae_createShapeGroup"})

        async def call(self, _tool, _arguments):
            return True, {
                "ok": False,
                "error": {
                    "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
                    "sideEffect": "may-have-occurred",
                },
            }

    runner = runtime_module.AcceptanceRuntime(
        spec=spec.SPEC,
        mode="t5",
        identity=SimpleNamespace(),
        fixture=SimpleNamespace(),
        session_factory=lambda: None,
        checkpoint=lambda _kind, _details: None,
        evidence=Evidence(),
    )
    runner.mark_tool_passed("ae_createShapeGroup")

    with pytest.raises(runtime_module.PossiblySideEffectingStop):
        await runner.call(
            Session(),
            "ae_createShapeGroup",
            {},
            capability_id="ae.shape.group.create",
            write=True,
            phase="t5-curve-create",
        )

    row = runner.matrix["ae_createShapeGroup"]
    assert row["status"] == "failed"
    assert row["invocations"] == 1
    assert [event for event, _payload in events] == [
        "public-tool-request",
        "public-tool-response",
    ]


def test_every_address_in_both_plans_points_backward_to_a_public_response():
    for plan, links in (
        (spec.T5_CALL_PLAN, spec.T5_ADDRESS_LINKS),
        (spec.T6_CALL_PLAN, spec.T6_ADDRESS_LINKS),
    ):
        assert all(link.producer_call < link.consumer_call for link in links)
        assert {link.consumer_call for link in links} == {
            row.ordinal
            for row in plan
            if spec._symbolic_addresses(row.arguments)
        }
        for link in links:
            assert 1 <= link.producer_call < link.consumer_call <= len(plan)
            assert link.producer_path.startswith("value.")


def test_driver_constructs_text_calls_only_from_prior_public_locators():
    counter = 0

    def intent(name: str) -> str:
        nonlocal counter
        counter += 1
        return f"issue170:{name}:session-a-{counter:02d}"

    runtime = SimpleNamespace(intent=intent, mode="t5")
    package = driver.TextShapeMarkerPackage(
        runtime, fixture_name="TSM Acceptance Fixture"
    )
    composition = _locator("composition", COMP)
    baseline_composition = {**composition, "generation": 2}
    text = _locator("layer", TEXT, 2)
    package._capture(
        "composition-create",
        {"value": {"compositionLocator": composition}},
    )
    baseline_args = package._resolve(
        next(
            row.arguments
            for row in spec.T5_CALL_PLAN
            if row.key == "empty-layer-baseline"
        )
    )
    assert baseline_args["composition_locator"] == composition
    package._capture(
        "empty-layer-baseline",
        {
            "value": {
                "compositionLocator": baseline_composition,
            }
        },
    )
    create_args = package._resolve(
        next(row.arguments for row in spec.T5_CALL_PLAN if row.key == "text-create")
    )
    assert create_args["composition_locator"] == baseline_composition
    assert "composition_id" not in create_args
    package._capture(
        "text-create",
        {
            "value": {
                "compositionLocator": {**composition, "generation": 3},
                "after": {"layerLocator": text},
            }
        },
    )
    read_args = package._resolve(
        next(row.arguments for row in spec.T5_CALL_PLAN if row.key == "text-read")
    )
    assert read_args == {"layer_locator": text}
    package._capture("text-read", {"value": {"layerLocator": text}})
    content_args = package._resolve(
        next(
            row.arguments
            for row in spec.T5_CALL_PLAN
            if row.key == "text-content-set"
        )
    )
    assert content_args["layer_locator"] == text
    assert content_args["idempotency_key"].startswith(
        "issue170:text-content-set:session-a-"
    )


def test_driver_converts_shape_group_result_refs_to_frozen_input_refs():
    counter = 0

    def intent(name: str) -> str:
        nonlocal counter
        counter += 1
        return f"issue170:{name}:session-a-{counter:02d}"

    package = driver.TextShapeMarkerPackage(
        SimpleNamespace(intent=intent, mode="t5"),
        fixture_name="TSM Acceptance Fixture",
    )
    layer = _locator("layer", TEXT, 4)

    def result_ref(group_index: int) -> dict:
        return {
            "layerLocator": layer,
            "groupIndex": group_index,
            "streamId": -444037467,
        }

    expected_input = {
        "layer_locator": layer,
        "group_index": 1,
        "stream_id": -444037467,
    }
    rows = {row.key: row for row in spec.T5_CALL_PLAN}
    package._capture(
        "groups-before-restyle",
        {
            "value": {
                "layerLocator": layer,
                "groups": [{"name": "Triangle", "ref": result_ref(1)}],
            }
        },
    )
    assert package._resolve(rows["fill-restyle"].arguments)["group_ref"] == (
        expected_input
    )

    package._capture(
        "fill-restyle",
        {"value": {"groupRef": result_ref(1)}},
    )
    assert package._resolve(rows["stroke-restyle"].arguments)["group_ref"] == (
        expected_input
    )

    package._capture(
        "stroke-restyle",
        {"value": {"groupRef": result_ref(1)}},
    )
    assert package._resolve(rows["group-reorder"].arguments)["group_ref"] == (
        expected_input
    )

    package._capture(
        "group-reorder-undo-read",
        {
            "value": {
                "layerLocator": layer,
                "groups": [{"name": "Triangle", "ref": result_ref(1)}],
            }
        },
    )
    assert package._resolve(rows["shape-path-set"].arguments)["group_ref"] == (
        expected_input
    )


def test_driver_compares_shape_style_results_in_the_public_result_projection():
    package = driver.TextShapeMarkerPackage(
        SimpleNamespace(mode="t5", intent=lambda name: f"t5:{name}"),
        fixture_name="TSM Acceptance Fixture",
    )
    package._assert_state(
        "fill-restyle",
        {
            "value": {
                "afterFill": {
                    "enabled": True,
                    "color": {
                        "red": 40,
                        "green": 80,
                        "blue": 230,
                        "alpha": 255,
                    },
                    "opacityPercent": "75",
                }
            }
        },
    )
    package._assert_state(
        "stroke-restyle",
        {
            "value": {
                "afterStroke": {
                    "enabled": True,
                    "color": {
                        "red": 250,
                        "green": 250,
                        "blue": 250,
                        "alpha": 255,
                    },
                    "opacityPercent": "88",
                    "widthPixels": "19.25",
                    "strokeOverFill": True,
                }
            }
        },
    )


def test_both_hardware_plans_reacquire_composition_after_text_writes():
    for plan, expected_reacquire, expected_shape in (
        (spec.T5_CALL_PLAN, 13, 14),
        (spec.T6_CALL_PLAN, 9, 10),
    ):
        rows = {row.key: row for row in plan}
        assert rows["composition-reacquire"].ordinal == expected_reacquire
        assert rows["shape-layer-create"].ordinal == expected_shape
        assert (
            rows["text-character-undo-read"].ordinal
            < rows["composition-reacquire"].ordinal
            < rows["shape-layer-create"].ordinal
        )
        if plan is spec.T5_CALL_PLAN:
            assert (
                rows["text-paragraph-undo-read"].ordinal
                < rows["composition-reacquire"].ordinal
            )
        link = next(
            item
            for item in (
                spec.T5_ADDRESS_LINKS
                if plan is spec.T5_CALL_PLAN
                else spec.T6_ADDRESS_LINKS
            )
            if item.consumer_call == expected_shape
            and item.consumer_field == "composition_locator"
        )
        assert link.producer_call == expected_reacquire
        assert link.producer_path == (
            "value.items[TSM Acceptance Fixture].locator"
        )


def test_operation_key_is_fresh_per_session_but_reconciliation_reuses_original():
    def make(prefix: str):
        count = 0

        def intent(name: str) -> str:
            nonlocal count
            count += 1
            return f"{prefix}:{name}:{count}"

        return driver.TextShapeMarkerPackage(
            SimpleNamespace(intent=intent, mode="t5"),
            fixture_name="TSM Acceptance Fixture",
        )

    first = make("run-a")
    second = make("run-b")
    original = first.operation_key("fill-restyle")
    assert first.operation_key("fill-restyle") == original
    assert second.operation_key("fill-restyle") != original
    assert first.operation_key("stroke-restyle") != original


def test_one_driver_selects_the_tier_plan_and_keeps_the_fixture_recipe_frozen():
    def runtime(mode: str):
        return SimpleNamespace(mode=mode, intent=lambda name: f"{mode}:{name}")

    assert driver.TextShapeMarkerPackage(
        runtime("preflight"), fixture_name="TSM Acceptance Fixture"
    ).plan is spec.PREFLIGHT_CALL_PLAN
    assert driver.TextShapeMarkerPackage(
        runtime("t4"), fixture_name="TSM Acceptance Fixture"
    ).plan is spec.T4_CALL_PLAN
    assert driver.TextShapeMarkerPackage(
        runtime("t5"), fixture_name="TSM Acceptance Fixture"
    ).plan is spec.T5_CALL_PLAN
    assert driver.TextShapeMarkerPackage(
        runtime("t6"), fixture_name="TSM Acceptance Fixture"
    ).plan is spec.T6_CALL_PLAN
    assert spec.FIXTURE_RECIPE == (
        "Start formal AE with a new empty project and complete a public readiness read.",
        "Save once in place to the one active ephemeral-validation fixture path.",
        (
            "Create TSM Acceptance Fixture at 1920x1080, square pixels, "
            "10 seconds, 24 fps through ae_createComposition."
        ),
        (
            "Record ae_listCompositionLayers as the empty baseline from a fresh "
            "public composition locator."
        ),
        (
            "After maintained text writes, reacquire the composition through "
            "ae_listProjectItems before shape creation."
        ),
        "Create TSM Text with A😀中 é and create TSM Shape through public MCP.",
        "Create Triangle and Curve from the fixed paths and complete styles below.",
        "Use exact marker times 24/24 and 1000/1000 on distinct layer targets.",
        "Save only in place at the explicit restart checkpoint.",
    )


@pytest.mark.asyncio
async def test_runtime_fixture_order_is_public_readiness_then_save_then_build(
    tmp_path,
):
    events = []
    fixture_path = tmp_path / "tsm.aep"

    class Runtime:
        mode = "preflight"
        fixture = SimpleNamespace(path=fixture_path)

        def intent(self, name):
            return f"preflight:{name}"

        async def checkpoint(self, kind, _details):
            events.append(("checkpoint", kind))
            fixture_path.write_bytes(b"fixture")

        def mark_fixture_created(self):
            events.append(("fixture", "marked"))

    package = driver.TextShapeMarkerPackage(
        Runtime(), fixture_name="TSM Acceptance Fixture"
    )

    async def execute(_session, rows):
        events.append(("public", tuple(row.key for row in rows)))

    package._execute_rows = execute
    await package._create_fixture_after_readiness(
        SimpleNamespace(), spec.PREFLIGHT_CALL_PLAN
    )
    assert events == [
        ("public", ("readiness",)),
        ("checkpoint", "save-fixture"),
        ("fixture", "marked"),
        (
            "public",
            (
                "composition-create",
                "composition-reacquire",
                "empty-layer-baseline",
            ),
        ),
    ]


def test_t4_handoff_is_0600_and_bound_to_fixture_host_and_source(tmp_path):
    fixture_path = tmp_path / "tsm.aep"
    fixture_path.write_bytes(b"fixture")
    records = []

    class Runtime:
        mode = "preflight"
        fixture = SimpleNamespace(
            path=fixture_path,
            fixture_id="TSM Acceptance Fixture",
        )
        identity = SimpleNamespace(expected_sha="a" * 40)
        evidence = SimpleNamespace(
            record=lambda event, payload: records.append((event, payload))
        )

        def intent(self, name):
            return f"preflight:{name}"

        def saved_fixture_identity(self):
            return (
                fixture_path.stat().st_size,
                hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
            )

    runtime = Runtime()
    package = driver.TextShapeMarkerPackage(
        runtime, fixture_name="TSM Acceptance Fixture"
    )
    package.context["composition_locator"] = _locator("composition", COMP)
    written = package._write_t4_handoff(HOST)
    assert written["fixtureSha256"]
    assert json.loads(package._t4_handoff_path.read_text()) == written
    assert written["expectedSha"] == "a" * 40
    assert written["hostInstanceId"] == HOST
    assert written["compositionLocator"] == _locator("composition", COMP)

    if os.name == "nt":
        package._delete_t4_handoff()
        assert not package._t4_handoff_path.exists()
    else:
        assert stat.S_IMODE(package._t4_handoff_path.stat().st_mode) == 0o600
        consumer = driver.TextShapeMarkerPackage(
            SimpleNamespace(
                mode="t4",
                fixture=runtime.fixture,
                identity=runtime.identity,
                evidence=runtime.evidence,
                intent=lambda name: f"t4:{name}",
                saved_fixture_identity=runtime.saved_fixture_identity,
            ),
            fixture_name="TSM Acceptance Fixture",
        )
        loaded = consumer._load_t4_handoff(HOST)
        assert loaded == written
        assert consumer.context["t4_marker_target"] == {
            "kind": "composition",
            "composition_locator": _locator("composition", COMP),
        }
        consumer._delete_t4_handoff()
        assert not consumer._t4_handoff_path.exists()


def test_t4_marker_assertion_matches_the_public_camel_case_contract():
    package = driver.TextShapeMarkerPackage(
        SimpleNamespace(mode="t4", intent=lambda name: f"t4:{name}"),
        fixture_name="TSM Acceptance Fixture",
    )
    target = {
        "kind": "composition",
        "composition_locator": _locator("composition", COMP),
    }
    package.context["t4_marker_target"] = target
    package._assert_t4_marker(
        {
            "ref": {
                "target": {
                    "kind": "composition",
                    "compositionLocator": {
                        **_locator("composition", COMP),
                        "generation": 2,
                    },
                },
                "time": {"value": 24, "scale": 24, "secondsRational": "1"},
            },
            "markerIndex": 1,
            "duration": {
                "value": 12,
                "scale": 24,
                "secondsRational": "1/2",
            },
            "comment": spec.MARKER_VALUE["comment"],
            "chapter": spec.MARKER_VALUE["chapter"],
            "url": spec.MARKER_VALUE["url"],
            "frameTarget": spec.MARKER_VALUE["frame_target"],
            "cuePointName": spec.MARKER_VALUE["cue_point_name"],
            "cuePointParameters": spec.MARKER_VALUE["cue_point_parameters"],
            "navigation": spec.MARKER_VALUE["navigation"],
            "protectedRegion": spec.MARKER_VALUE["protected_region"],
            "labelId": spec.MARKER_VALUE["label_id"],
        }
    )


def test_t4_marker_assertion_accepts_ae_normalized_exact_time_scale():
    assert driver._exact_time_matches(
        {"value": 24, "scale": 24, "secondsRational": "1"},
        "1",
    )
    assert driver._exact_time_matches(
        {"value": 24576, "scale": 24576, "secondsRational": "1"},
        "1",
    )
    assert driver._exact_time_matches(
        {"value": 12288, "scale": 24576, "secondsRational": "1/2"},
        "1/2",
    )
    assert not driver._exact_time_matches(
        {"value": 24576, "scale": 24576, "secondsRational": "24/24"},
        "1",
    )
    assert not driver._exact_time_matches(
        {"value": 24576, "scale": 24576, "secondsRational": "1"},
        "1/2",
    )


def test_t6_has_one_real_undo_checkpoint_per_distinct_undo_model():
    undo_rows = {row.undo_of for row in spec.T6_CALL_PLAN if row.undo_of}
    representatives = {
        contract["representative"]
        for contract in spec.T6_UNDO_MODELS.values()
    }
    assert undo_rows == representatives == {
        "text-character-set",
        "group-reorder",
        "shape-path-set",
        "text-marker-set",
    }
    assert set(spec.T6_REPLAY_GROUNDS["distinct-undo-model"]) == set(
        spec.T6_UNDO_MODELS
    )


def test_component_identity_is_once_per_session_with_per_tool_deltas_only():
    events = []

    class Evidence:
        def record(self, event, payload):
            events.append((event, payload))

    runtime = SimpleNamespace(
        mode="t6",
        intent=lambda name: f"t6:{name}",
        evidence=Evidence(),
        component_signals={"core": {"version": "1"}},
        source_revisions={"core": "a" * 40},
        formal_ae_identity={"version": "25.3"},
    )
    package = driver.TextShapeMarkerPackage(
        runtime, fixture_name="TSM Acceptance Fixture"
    )
    package.session_stage = "initial"
    provenance = {
        "selectedWireVersion": "wire-v1",
        "pluginVersion": "1.2.3",
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "sourceCommit": "b" * 40,
    }
    package._record_component_identity(
        "ae_projectSummary", {"provenance": provenance}
    )
    package._record_component_identity(
        "ae_createShapeLayer", {"provenance": provenance}
    )
    package.session_stage = "restart"
    package._record_component_identity(
        "ae_listProjectItems",
        {
            "provenance": {
                **provenance,
                "hostInstanceId": "66666666-6666-4666-8666-666666666666",
            }
        },
    )
    session_events = [
        payload for event, payload in events if event == "component-identity-session"
    ]
    delta_events = [
        payload
        for event, payload in events
        if event == "tool-component-identity-delta"
    ]
    assert [event["stage"] for event in session_events] == [
        "initial",
        "restart",
    ]
    assert len(delta_events) == 3
    assert all(event["delta"] == {} for event in delta_events)
    assert all(set(event) == {"stage", "tool", "delta"} for event in delta_events)


def test_fill_and_stroke_interactions_and_undo_boundaries_are_separate():
    keys = [row.key for row in spec.T5_CALL_PLAN]
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
        for row in spec.T5_CALL_PLAN
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
        for row in spec.T5_CALL_PLAN
        if row.tool in spec.CONTRACTS
        and spec.CONTRACTS[row.tool].kind == "write"
    }
    assert {row.undo_of for row in spec.T5_CALL_PLAN if row.undo_of} == (
        package_write_keys
    )
