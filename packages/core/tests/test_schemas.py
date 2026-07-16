"""Schema validation: every verb rejects bad args and accepts good ones."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from ae_mcp import schemas as S


def test_registry_has_all_verbs():
    assert len(S.SCHEMAS) == 58, f"expected 58 verbs, got {len(S.SCHEMAS)}"
    assert set(S.SCHEMAS) == {
        "ae.init", "ae.overview", "ae.projectSummary",
        "ae.getProjectBitDepth", "ae.setProjectBitDepth",
        "ae.listProjectItems", "ae.listCompositionLayers", "ae.listSelectedLayers",
        "ae.getCompositionTime", "ae.setCompositionTime",
        "ae.createComposition",
        "ae.listLayerProperties",
        "ae.listLayerPropertyKeyframes",
        "ae.setLayerPropertyValue",
        "ae.createCompositionLayer",
        "ae.applyLayerEffect",
        "ae.layers", "ae.readProps", "ae.exec",
        "ae.checkpoint", "ae.revert", "ae.snapshot", "ae.previewFrame",
        "ae.applyEffect", "ae.ping", "ae.status", "ae.diagnose",
        "ae.createLayer", "ae.setProperty", "ae.moveLayer", "ae.selectLayers",
        "ae.setTime", "ae.getTime",
        "ae.getProperties", "ae.scanPropertyTree",
        "ae.inspectPropertyCapabilities", "ae.getExpressions", "ae.validateExpressions",
        "ae.getKeyframes", "ae.searchProject",
        "ae.skillList", "ae.skillCreate", "ae.skillEdit",
        "ae.skillDelete", "ae.skillUse",
        "ae.createRig",
        "ae.toolIndex", "ae.toolSearch", "ae.toolInspect", "ae.toolUse",
        "ae.toolCreate", "ae.toolEdit", "ae.toolDelete", "ae.toolArchive",
        "ae.toolDuplicate", "ae.toolPromoteFromHistory",
        "ae.toolImport", "ae.toolExport",
    }


def test_init_accepts_bool():
    assert S.AeInitArgs(refresh_only=True).refresh_only is True
    assert S.AeInitArgs().refresh_only is False


def test_init_rejects_unknown_field():
    with pytest.raises(ValidationError):
        S.AeInitArgs(foo=1)


def test_overview_is_empty():
    S.AeOverviewArgs()  # no error
    with pytest.raises(ValidationError):
        S.AeOverviewArgs(foo=1)


def test_native_project_summary_is_empty_and_distinct_from_overview():
    assert S.AeProjectSummaryArgs() != S.AeOverviewArgs()
    with pytest.raises(ValidationError):
        S.AeProjectSummaryArgs(foo=1)


def test_native_project_bit_depth_read_is_empty_and_set_is_closed():
    S.AeGetProjectBitDepthArgs()
    with pytest.raises(ValidationError):
        S.AeGetProjectBitDepthArgs(extra=True)

    args = S.AeSetProjectBitDepthArgs(
        target_depth=16,
        idempotency_key="bit-depth-intent-0001",
    )
    assert args.target_depth == 16
    with pytest.raises(ValidationError):
        S.AeSetProjectBitDepthArgs(
            target_depth=24,
            idempotency_key="bit-depth-intent-0001",
        )
    with pytest.raises(ValidationError):
        S.AeSetProjectBitDepthArgs(
            target_depth="16",
            idempotency_key="bit-depth-intent-0001",
        )
    with pytest.raises(ValidationError):
        S.AeSetProjectBitDepthArgs(target_depth=16, idempotency_key="too-short")


def _locator(kind: str = "project") -> dict[str, object]:
    return {
        "kind": kind,
        "hostInstanceId": "22222222-2222-4222-8222-222222222222",
        "sessionId": "11111111-1111-4111-8111-111111111111",
        "projectId": "33333333-3333-4333-8333-333333333333",
        "generation": 7,
        "objectId": "44444444-4444-4444-8444-444444444444",
    }


def test_native_project_item_listing_defaults_are_bounded_and_closed():
    args = S.AeListProjectItemsArgs()
    assert args.project_locator is None
    assert args.offset == 0
    assert args.limit == 25

    with pytest.raises(ValidationError):
        S.AeListProjectItemsArgs(extra=True)
    with pytest.raises(ValidationError):
        S.AeListProjectItemsArgs(limit=0)
    with pytest.raises(ValidationError):
        S.AeListProjectItemsArgs(limit=51)
    with pytest.raises(ValidationError):
        S.AeListProjectItemsArgs(limit="25")
    with pytest.raises(ValidationError):
        S.AeListProjectItemsArgs(offset=1)

    continued = S.AeListProjectItemsArgs(
        project_locator=_locator(), offset=25, limit=25
    )
    assert continued.project_locator is not None
    assert continued.project_locator.host_instance_id.startswith("2222")


def test_native_composition_layer_listing_requires_exact_composition_locator():
    args = S.AeListCompositionLayersArgs(
        composition_locator=_locator("composition")
    )
    assert args.offset == 0
    assert args.limit == 25
    assert args.composition_locator.kind == "composition"

    with pytest.raises(ValidationError):
        S.AeListCompositionLayersArgs()
    with pytest.raises(ValidationError):
        S.AeListCompositionLayersArgs(composition_locator=_locator("item"))
    with pytest.raises(ValidationError):
        S.AeListCompositionLayersArgs(
            composition_locator=_locator("composition"), limit=51
        )
    with pytest.raises(ValidationError):
        S.AeListCompositionLayersArgs(
            composition_locator=_locator("composition"), offset=True
        )


def test_native_selected_layer_listing_is_bounded_locator_only_and_closed():
    args = S.AeListSelectedLayersArgs(
        composition_locator=_locator("composition")
    )
    assert args.offset == 0
    assert args.limit == 25
    assert args.composition_locator.kind == "composition"

    for invalid in (
        {},
        {"composition_locator": _locator("item")},
        {"composition_locator": _locator("composition"), "offset": True},
        {"composition_locator": _locator("composition"), "limit": 0},
        {"composition_locator": _locator("composition"), "limit": 51},
        {"composition_locator": _locator("composition"), "extra": True},
    ):
        with pytest.raises(ValidationError):
            S.AeListSelectedLayersArgs(**invalid)


def test_native_composition_time_requires_only_an_exact_composition_locator():
    args = S.AeGetCompositionTimeArgs(
        composition_locator=_locator("composition")
    )
    assert args.composition_locator.kind == "composition"

    with pytest.raises(ValidationError):
        S.AeGetCompositionTimeArgs()
    with pytest.raises(ValidationError):
        S.AeGetCompositionTimeArgs(composition_locator=_locator("project"))
    with pytest.raises(ValidationError):
        S.AeGetCompositionTimeArgs(
            composition_locator=_locator("composition"),
            comp_id=1,
        )


def test_native_layer_property_listing_is_bounded_and_locator_only():
    args = S.AeListLayerPropertiesArgs(layer_locator=_locator("layer"))
    assert args.parent_property_locator is None
    assert args.offset == 0
    assert args.limit == 25
    assert args.layer_locator.kind == "layer"

    nested = S.AeListLayerPropertiesArgs(
        layer_locator=_locator("layer"),
        parent_property_locator={
            **_locator("stream"),
            "objectId": "55555555-5555-4555-8555-555555555555",
        },
        offset=1,
        limit=1,
    )
    assert nested.parent_property_locator is not None
    assert nested.parent_property_locator.kind == "stream"

    with pytest.raises(ValidationError):
        S.AeListLayerPropertiesArgs()
    with pytest.raises(ValidationError):
        S.AeListLayerPropertiesArgs(layer_locator=_locator("composition"))
    with pytest.raises(ValidationError):
        S.AeListLayerPropertiesArgs(
            layer_locator=_locator("layer"),
            parent_property_locator=_locator("layer"),
        )
    with pytest.raises(ValidationError):
        S.AeListLayerPropertiesArgs(layer_locator=_locator("layer"), limit=26)
    with pytest.raises(ValidationError):
        S.AeListLayerPropertiesArgs(layer_locator=_locator("layer"), offset=True)


def test_native_layer_property_keyframes_require_only_a_bounded_stream_locator():
    args = S.AeListLayerPropertyKeyframesArgs(
        property_locator=_locator("stream")
    )
    assert args.offset == 0
    assert args.limit == 25
    assert args.property_locator.kind == "stream"

    with pytest.raises(ValidationError):
        S.AeListLayerPropertyKeyframesArgs()
    with pytest.raises(ValidationError):
        S.AeListLayerPropertyKeyframesArgs(property_locator=_locator("layer"))
    with pytest.raises(ValidationError):
        S.AeListLayerPropertyKeyframesArgs(
            property_locator=_locator("stream"), limit=26
        )
    with pytest.raises(ValidationError):
        S.AeListLayerPropertyKeyframesArgs(
            property_locator=_locator("stream"), offset=True
        )


def test_native_layer_property_set_is_typed_closed_and_requires_stable_intent():
    stream = {
        **_locator("stream"),
        "objectId": "55555555-5555-4555-8555-555555555555",
    }
    args = S.AeSetLayerPropertyValueArgs(
        layer_locator=_locator("layer"),
        property_locator=stream,
        value={"kind": "vector", "components": ["12.5", "-3"]},
        idempotency_key="property-intent-0001",
    )
    assert args.value.kind == "vector"
    assert args.value.components == ["12.5", "-3"]

    with pytest.raises(ValidationError):
        S.AeSetLayerPropertyValueArgs(
            layer_locator=_locator("layer"),
            property_locator=_locator("layer"),
            value={"kind": "scalar", "value": "10"},
            idempotency_key="property-intent-0001",
        )
    with pytest.raises(ValidationError):
        S.AeSetLayerPropertyValueArgs(
            layer_locator=_locator("layer"),
            property_locator=stream,
            value={"kind": "vector", "components": ["1"]},
            idempotency_key="property-intent-0001",
        )
    with pytest.raises(ValidationError):
        S.AeSetLayerPropertyValueArgs(
            layer_locator=_locator("layer"),
            property_locator=stream,
            value={"kind": "scalar", "value": "NaN"},
            idempotency_key="property-intent-0001",
        )
    with pytest.raises(ValidationError):
        S.AeSetLayerPropertyValueArgs(
            layer_locator=_locator("layer"),
            property_locator=stream,
            value={"kind": "scalar", "value": "10"},
            idempotency_key="short",
        )


def test_layers_optional_comp_id():
    assert S.AeLayersArgs().comp_id is None
    assert S.AeLayersArgs(comp_id="42").comp_id == "42"


def test_read_props_requires_code():
    with pytest.raises(ValidationError):
        S.AeReadPropsArgs()
    assert S.AeReadPropsArgs(code="x").code == "x"


def test_exec_timeout_bounds():
    # Too low
    with pytest.raises(ValidationError):
        S.AeExecArgs(code="x", timeout_sec=0)
    # Too high
    with pytest.raises(ValidationError):
        S.AeExecArgs(code="x", timeout_sec=601)
    # Default
    assert S.AeExecArgs(code="x").timeout_sec == 30


def test_checkpoint_limit_positive():
    with pytest.raises(ValidationError):
        S.AeCheckpointArgs(limit=0)
    assert S.AeCheckpointArgs(limit=5).limit == 5


def test_revert_requires_id():
    with pytest.raises(ValidationError):
        S.AeRevertArgs()
    assert S.AeRevertArgs(checkpoint_id="abc").checkpoint_id == "abc"


def test_snapshot_method_enum():
    assert S.AeSnapshotArgs().method == "DesktopCopy"
    with pytest.raises(ValidationError):
        S.AeSnapshotArgs(method="Bogus")


def test_preview_frame_defaults():
    args = S.AePreviewFrameArgs()
    assert args.comp_id is None
    assert args.time is None
    assert args.times is None
    assert args.out_dir is None
    assert args.include_base64 is False
    assert args.scale == 1.0


def test_preview_frame_accepts_time_modes():
    single = S.AePreviewFrameArgs(time=0.5)
    multi = S.AePreviewFrameArgs(times=[0.0, 1.0])
    assert single.time == 0.5
    assert multi.times == [0.0, 1.0]


def test_preview_frame_rejects_invalid_ranges():
    with pytest.raises(ValidationError):
        S.AePreviewFrameArgs(time=-0.1)
    with pytest.raises(ValidationError):
        S.AePreviewFrameArgs(times=[0.0, -1.0])
    with pytest.raises(ValidationError):
        S.AePreviewFrameArgs(scale=0)


def test_apply_effect_required():
    with pytest.raises(ValidationError):
        S.AeApplyEffectArgs()
    ok = S.AeApplyEffectArgs(layer_id=1, effect_match_name="ADBE Gaussian Blur 2")
    assert ok.layer_id == 1


def test_create_layer_types():
    for t in ["solid", "text", "shape", "null", "adjustment", "camera", "light"]:
        assert S.AeCreateLayerArgs(type=t, name="x").type == t
    with pytest.raises(ValidationError):
        S.AeCreateLayerArgs(type="bogus", name="x")


def test_create_layer_name_non_empty():
    with pytest.raises(ValidationError):
        S.AeCreateLayerArgs(type="solid", name="")


def test_create_layer_color_tuple():
    args = S.AeCreateLayerArgs(type="solid", name="x", color=(1.0, 0.5, 0.0, 1.0))
    assert args.color == (1.0, 0.5, 0.0, 1.0)


def test_set_property_required():
    with pytest.raises(ValidationError):
        S.AeSetPropertyArgs()
    ok = S.AeSetPropertyArgs(layer_id=1, path="Transform/Position", value=[100, 200])
    assert ok.path == "Transform/Position"


def test_set_property_requires_exactly_one_value_or_expression():
    expression = S.AeSetPropertyArgs(
        layer_id=1,
        path="Transform/Opacity",
        expression="time * 10",
    )
    assert expression.expression == "time * 10"
    assert expression.value is None

    with pytest.raises(ValidationError):
        S.AeSetPropertyArgs(layer_id=1, path="Transform/Opacity")
    with pytest.raises(ValidationError):
        S.AeSetPropertyArgs(
            layer_id=1,
            path="Transform/Opacity",
            value=50,
            expression="time * 10",
        )
    with pytest.raises(ValidationError):
        S.AeSetPropertyArgs(
            layer_id=1,
            path="Transform/Opacity",
            expression="time * 10",
            at_time=1.0,
        )


def test_move_layer_positive_indices():
    with pytest.raises(ValidationError):
        S.AeMoveLayerArgs(layer_id=0, to_index=1)
    with pytest.raises(ValidationError):
        S.AeMoveLayerArgs(layer_id=1, to_index=0)


def test_select_layers_allows_list_or_literal():
    assert S.AeSelectLayersArgs(layer_ids="all").layer_ids == "all"
    assert S.AeSelectLayersArgs(layer_ids="none").layer_ids == "none"
    assert S.AeSelectLayersArgs(layer_ids=[1, 2]).layer_ids == [1, 2]
    with pytest.raises(ValidationError):
        S.AeSelectLayersArgs(layer_ids="everything")


def test_set_time_non_negative():
    assert S.AeSetTimeArgs(time=0.0).time == 0.0
    with pytest.raises(ValidationError):
        S.AeSetTimeArgs(time=-0.1)


def test_get_time_optional_comp_id():
    assert S.AeGetTimeArgs().comp_id is None


def test_every_schema_can_generate_json_schema():
    """MCP tools/list will call .model_json_schema() on every verb."""
    for name, cls in S.SCHEMAS.items():
        schema = cls.model_json_schema()
        assert schema["type"] == "object", name
        assert "properties" in schema, name


def test_ae_ping_default():
    a = S.AePingArgs()
    assert a.expect == "pong"


def test_ae_ping_custom_expect():
    a = S.AePingArgs(expect="hello")
    assert a.expect == "hello"


def test_ae_ping_extra_forbidden():
    with pytest.raises(ValidationError):
        S.AePingArgs(expect="x", junk=1)


def test_ae_ping_in_registry():
    assert "ae.ping" in S.SCHEMAS
    assert S.SCHEMAS["ae.ping"] is S.AePingArgs


def test_ae_checkpoint_default_action_is_list():
    a = S.AeCheckpointArgs()
    assert a.action == "list"
    assert a.label == ""
    assert a.limit == 20


def test_ae_checkpoint_create_with_label():
    a = S.AeCheckpointArgs(action="create", label="before risky write")
    assert a.action == "create"
    assert a.label == "before risky write"


def test_ae_checkpoint_invalid_action():
    with pytest.raises(ValidationError):
        S.AeCheckpointArgs(action="delete")


def test_get_properties_required_fields():
    a = S.AeGetPropertiesArgs(layer_ids=[1, 2], query="position")
    assert a.layer_ids == [1, 2]
    assert a.query == "position"
    assert a.offset == 0
    assert a.limit == 50


def test_get_properties_layer_ids_must_be_list():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        S.AeGetPropertiesArgs(layer_ids="all", query="x")


def test_scan_property_tree_defaults():
    a = S.AeScanPropertyTreeArgs(layer_id=1)
    assert a.max_depth == 4
    assert a.include_values is True


def test_scan_property_tree_max_depth_clamped():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        S.AeScanPropertyTreeArgs(layer_id=1, max_depth=99)


def test_inspect_property_capabilities_required():
    a = S.AeInspectPropertyCapabilitiesArgs(layer_id=1, path="Transform/Position")
    assert a.layer_id == 1
    assert a.path == "Transform/Position"


def test_get_expressions_required_comp_id():
    a = S.AeGetExpressionsArgs(comp_id="12")
    assert a.layer_ids is None
    assert a.prop is None
    assert a.max_results == 200


def test_get_expressions_layer_ids_optional():
    a = S.AeGetExpressionsArgs(comp_id="12", layer_ids=[1, 2], prop="ADBE Position")
    assert a.layer_ids == [1, 2]


def test_validate_expressions_defaults():
    a = S.AeValidateExpressionsArgs(comp_id="12")
    assert a.comp_id == "12"
    assert a.layer_ids is None
    assert a.sample_times is None
    assert a.max_results == 500


def test_validate_expressions_sample_times_non_negative():
    with pytest.raises(ValidationError):
        S.AeValidateExpressionsArgs(comp_id="12", sample_times=[0, -1])


def test_get_keyframes_required():
    a = S.AeGetKeyframesArgs(layer_id=1, path="Transform/Position")
    assert a.layer_id == 1


def test_search_project_defaults():
    a = S.AeSearchProjectArgs(query="hero")
    assert a.scope == ["layers", "expressions", "effects", "comps", "items"]
    assert a.limit == 100


def test_search_project_scope_subset():
    a = S.AeSearchProjectArgs(query="x", scope=["layers"])
    assert a.scope == ["layers"]


def test_search_project_invalid_scope():
    import pytest
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        S.AeSearchProjectArgs(query="x", scope=["bogus"])


def test_skill_create_defaults():
    args = S.AeSkillCreateArgs(
        name="wiggle-position",
        description="Add wiggle",
        template="wiggle(${freq}, ${amp})",
    )
    assert args.template_type == "jsx"
    assert args.args_schema == {}
    assert args.overwrite is False


def test_skill_name_validation():
    with pytest.raises(ValidationError):
        S.AeSkillCreateArgs(name="../bad", description="x", template="x")
    with pytest.raises(ValidationError):
        S.AeSkillDeleteArgs(name="")


def test_skill_use_defaults():
    args = S.AeSkillUseArgs(name="wiggle-position")
    assert args.args == {}
    assert args.execute is False


def test_tool_use_enforces_the_staged_protocol():
    assert S.AeToolUseArgs(action="render", artifact_id="user:1").operation == "render"
    S.AeToolUseArgs(
        action="prepare", artifact_id="user:1", operation="execute"
    )
    S.AeToolUseArgs(action="grant", plan_hash="p", grant_scope="once")
    S.AeToolUseArgs(action="execute", plan_hash="p", grant_id="g")

    invalid = [
        {"action": "render"},
        {"action": "prepare", "artifact_id": "user:1"},
        {"action": "grant", "plan_hash": "p"},
        {"action": "execute", "plan_hash": "p"},
        {"action": "execute", "plan_hash": "p", "grant_id": "g", "artifact_id": "user:1"},
    ]
    for value in invalid:
        with pytest.raises(ValidationError):
            S.AeToolUseArgs(**value)


def test_tool_mutations_require_cas_and_import_export_are_bounded():
    with pytest.raises(ValidationError):
        S.AeToolDeleteArgs(artifact_id="user:1")
    with pytest.raises(ValidationError):
        S.AeToolExportArgs(artifact_ids=[], out_path="x")
    assert len(
        S.AeToolExportArgs(
            artifact_ids=[str(i) for i in range(511)], out_path="x"
        ).artifact_ids
    ) == 511
    with pytest.raises(ValidationError):
        S.AeToolExportArgs(artifact_ids=[str(i) for i in range(512)], out_path="x")
    with pytest.raises(ValidationError):
        S.AeToolImportArgs(action="preview")
    with pytest.raises(ValidationError):
        S.AeToolImportArgs(action="commit", path="x")



def test_create_rig_defaults():
    args = S.AeCreateRigArgs(target_layer_id=1)
    assert args.comp_id is None
    assert args.rig_type == "transform_controller"
    assert args.name == "Controller"
    assert args.options == {}


def test_create_rig_rejects_invalid_type():
    with pytest.raises(ValidationError):
        S.AeCreateRigArgs(target_layer_id=1, rig_type="binary_ffx")
