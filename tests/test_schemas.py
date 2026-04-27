"""Schema validation: every verb rejects bad args and accepts good ones."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from after_effects_mcp import schemas as S


def test_registry_has_17_verbs():
    # v0.6.2: 15 verbs. v0.7-A: +ae.isolateToggle +ae.toastQuery -> 17. v0.7-1: +ae.ping -> 18.
    # Task 4.1: +ae.getProperties -> 19. Task 4.2: +ae.scanPropertyTree -> 20.
    # Task 4.3: +ae.inspectPropertyCapabilities -> 21. Task 4.4: +ae.getExpressions -> 22.
    # Task 4.5: +ae.getKeyframes -> 23. Task 4.6: +ae.searchProject -> 24 (FINAL).
    assert len(S.SCHEMAS) == 24, f"expected 24 verbs, got {len(S.SCHEMAS)}"
    assert set(S.SCHEMAS) == {
        "ae.init", "ae.overview", "ae.layers", "ae.readProps", "ae.exec",
        "ae.checkpoint", "ae.revert", "ae.snapshot", "ae.applyEffect", "ae.ping",
        "ae.createLayer", "ae.setProperty", "ae.moveLayer", "ae.selectLayers",
        "ae.setTime", "ae.getTime",
        "ae.isolateToggle", "ae.toastQuery",
        "ae.getProperties", "ae.scanPropertyTree",
        "ae.inspectPropertyCapabilities", "ae.getExpressions",
        "ae.getKeyframes", "ae.searchProject",
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


def test_isolate_toggle_schema_is_empty():
    # No args required -- it's pure toggle.
    args = S.AeIsolateToggleArgs()
    assert args.model_dump() == {}


def test_toast_query_schema_is_empty():
    args = S.AeToastQueryArgs()
    assert args.model_dump() == {}


def test_isolate_toggle_rejects_extra_fields():
    with pytest.raises(ValidationError):
        S.AeIsolateToggleArgs(foo="bar")


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
