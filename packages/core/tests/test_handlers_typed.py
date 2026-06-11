"""Typed 6 handler JSX rendering + dispatch."""

from __future__ import annotations

import json

import pytest

from ae_mcp import schemas as S
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import typed as T


@pytest.fixture(autouse=True)
def _load():
    load_all()


def test_render_create_layer_solid_contains_size_and_color():
    args = S.AeCreateLayerArgs(
        type="solid", name="MyLayer", color=(1.0, 0.5, 0.25, 1.0),
        size=(1920, 1080), duration=3.0,
    )
    jsx = T.render_create_layer(args)
    assert '"solid"' in jsx
    assert '"MyLayer"' in jsx
    assert "[1.0, 0.5, 0.25]" in jsx  # JSON-literal of color (dropped alpha)
    assert "1920" in jsx
    assert "1080" in jsx
    assert "3.0" in jsx


def test_render_create_layer_defaults_use_sentinel():
    args = S.AeCreateLayerArgs(type="text", name="T")
    jsx = T.render_create_layer(args)
    # -1 sentinels tell the JSX side to use comp defaults.
    assert "-1.0" in jsx  # duration default
    # Text layer; switch should contain case "text"
    assert '"text"' in jsx


def test_render_set_property_with_keyframe():
    args = S.AeSetPropertyArgs(
        layer_id=2, path="Transform/Position", value=[100, 200], at_time=1.5,
    )
    jsx = T.render_set_property(args)
    # Single-layer resolution must route through AEMCP.layerById so a stale
    # /out-of-range id returns null (caught by the `if (!layer)` guard) instead
    # of throwing (issue #8).
    assert "AEMCP.layerById(comp, 2)" in jsx
    assert '"Transform/Position"' in jsx
    assert "[100, 200]" in jsx
    assert "1.5" in jsx


def test_render_set_property_without_keyframe():
    args = S.AeSetPropertyArgs(layer_id=1, path="Opacity", value=50)
    jsx = T.render_set_property(args)
    assert "var atTime = null;" in jsx


@pytest.mark.parametrize("at_time", [-0.5, -1.0, 0.0, 1.5])
def test_render_set_property_at_time_allows_negative_times(at_time):
    args = S.AeSetPropertyArgs(
        layer_id=1, path="Opacity", value=50, at_time=at_time,
    )
    jsx = T.render_set_property(args)
    assert f"var atTime = {at_time};" in jsx


def test_render_move_layer_clamps_in_js_not_py():
    args = S.AeMoveLayerArgs(layer_id=3, to_index=10)
    jsx = T.render_move_layer(args)
    # The source layer is resolved via AEMCP.layerById (issue #8). The
    # destination `comp.layer(to)` stays as-is — `to` is clamped to a valid
    # 1-based index in JS, so it never throws.
    assert "AEMCP.layerById(comp, 3)" in jsx
    assert "var to = 10;" in jsx


def test_render_select_layers_all():
    args = S.AeSelectLayersArgs(layer_ids="all")
    jsx = T.render_select_layers(args)
    assert '"all"' in jsx


def test_render_select_layers_list():
    args = S.AeSelectLayersArgs(layer_ids=[1, 3, 5])
    jsx = T.render_select_layers(args)
    assert "[1, 3, 5]" in jsx


def test_render_set_time():
    jsx = T.render_set_time(S.AeSetTimeArgs(time=2.5))
    assert "comp.time = 2.5" in jsx


def test_render_get_time_uses_active_comp_by_default():
    jsx = T.render_get_time(S.AeGetTimeArgs())
    assert "AEMCP.activeComp()" in jsx


def test_render_get_time_with_comp_id():
    jsx = T.render_get_time(S.AeGetTimeArgs(comp_id="42"))
    assert "AEMCP.compById(42)" in jsx


# -------- Dispatch round-trips (using mock_backend) --------


@pytest.mark.asyncio
async def test_create_layer_dispatches_exec(mock_backend):
    mock_backend.set_response('{"ok":true,"layerId":2,"name":"x","index":2}')
    _, run_fn = HANDLERS["ae.createLayer"]
    result = await run_fn(S.AeCreateLayerArgs(type="solid", name="x"), None)
    assert result["ok"] is True
    assert result["layerId"] == 2


@pytest.mark.asyncio
async def test_set_property_dispatches(mock_backend):
    mock_backend.set_response('{"ok":true,"previous":[0,0],"current":[100,200]}')
    _, run_fn = HANDLERS["ae.setProperty"]
    result = await run_fn(
        S.AeSetPropertyArgs(layer_id=1, path="Transform/Position", value=[100, 200]),
        None,
    )
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_select_layers_all_dispatches(mock_backend):
    mock_backend.set_response('{"ok":true,"selected":[1,2]}')
    _, run_fn = HANDLERS["ae.selectLayers"]
    result = await run_fn(S.AeSelectLayersArgs(layer_ids="all"), None)
    assert result["selected"] == [1, 2]


@pytest.mark.asyncio
async def test_set_time_dispatches(mock_backend):
    mock_backend.set_response('{"ok":true,"time":1.5}')
    _, run_fn = HANDLERS["ae.setTime"]
    result = await run_fn(S.AeSetTimeArgs(time=1.5), None)
    assert result["time"] == 1.5


@pytest.mark.asyncio
async def test_get_time_dispatches(mock_backend):
    mock_backend.set_response(
        '{"ok":true,"time":0.0,"duration":10.0,"numLayers":3,"compId":42}',
    )
    _, run_fn = HANDLERS["ae.getTime"]
    result = await run_fn(S.AeGetTimeArgs(), None)
    assert result["numLayers"] == 3


@pytest.mark.asyncio
async def test_move_layer_dispatches(mock_backend):
    mock_backend.set_response('{"ok":true,"fromIndex":3,"toIndex":1}')
    _, run_fn = HANDLERS["ae.moveLayer"]
    result = await run_fn(S.AeMoveLayerArgs(layer_id=3, to_index=1), None)
    assert result["fromIndex"] == 3
    assert result["toIndex"] == 1


import json
import pytest
from ae_mcp import schemas


def test_render_get_properties_substitutes_query():
    from ae_mcp.handlers.typed import render_get_properties
    args = schemas.AeGetPropertiesArgs(layer_ids=[1, 2], query="pos rot|opacity")
    jsx = render_get_properties(args)
    assert '"pos rot|opacity"' in jsx
    assert '[1, 2]' in jsx or '[1,2]' in jsx
    # Per-layer resolution in the loop routes through AEMCP.layerById so a
    # stale id is skipped via `continue` instead of throwing (issue #8).
    assert "AEMCP.layerById(comp, layerIds[li])" in jsx


@pytest.mark.asyncio
async def test_run_get_properties(mock_backend):
    mock_backend.set_response(
        json.dumps({"ok": True, "total": 1, "results": [
            {"layerId": 1, "propPath": "Transform/Position",
             "propType": "ThreeD_SPATIAL", "value": [0,0,0],
             "hasExpression": False, "hasKeyframes": False}
        ]}),
    )
    from ae_mcp.handlers.typed import _run_get_properties
    args = schemas.AeGetPropertiesArgs(layer_ids=[1], query="position")
    result = await _run_get_properties(args, ctx=None)
    assert result["ok"] is True
    assert result["total"] == 1


def test_render_scan_property_tree():
    from ae_mcp.handlers.typed import render_scan_property_tree
    args = schemas.AeScanPropertyTreeArgs(layer_id=3, max_depth=2, include_values=False)
    jsx = render_scan_property_tree(args)
    assert "AEMCP.layerById(comp, 3)" in jsx  # issue #8
    assert "var maxDepth = 2;" in jsx
    assert "var includeValues = false;" in jsx


@pytest.mark.asyncio
async def test_run_scan_property_tree(mock_backend):
    mock_backend.set_response(
        json.dumps({"ok": True, "layerId": 1, "layerName": "L",
                    "tree": {"children": []}, "truncatedAt": None}),
    )
    from ae_mcp.handlers.typed import _run_scan_property_tree
    args = schemas.AeScanPropertyTreeArgs(layer_id=1)
    result = await _run_scan_property_tree(args, ctx=None)
    assert result["ok"] is True


def test_render_inspect_property_capabilities():
    from ae_mcp.handlers.typed import render_inspect_property_capabilities
    args = schemas.AeInspectPropertyCapabilitiesArgs(layer_id=1, path="Transform/Position")
    jsx = render_inspect_property_capabilities(args)
    assert '"Transform/Position"' in jsx
    assert "AEMCP.layerById(comp, 1)" in jsx  # issue #8


@pytest.mark.asyncio
async def test_run_inspect_property_capabilities(mock_backend):
    mock_backend.set_response(
        json.dumps({"ok": True, "exists": True, "canSetValue": True,
                    "canSetExpression": True, "valueDimension": 3}),
    )
    from ae_mcp.handlers.typed import _run_inspect_property_capabilities
    args = schemas.AeInspectPropertyCapabilitiesArgs(layer_id=1, path="Transform/Position")
    result = await _run_inspect_property_capabilities(args, ctx=None)
    assert result["canSetExpression"] is True


def test_render_get_expressions():
    from ae_mcp.handlers.typed import render_get_expressions
    args = schemas.AeGetExpressionsArgs(comp_id="12", layer_ids=[1], prop="Position")
    jsx = render_get_expressions(args)
    assert '"Position"' in jsx
    assert '[1]' in jsx


@pytest.mark.asyncio
async def test_run_get_expressions(mock_backend):
    mock_backend.set_response(
        json.dumps({"ok": True, "expressions": [], "grouped": {}, "truncated": False}),
    )
    from ae_mcp.handlers.typed import _run_get_expressions
    args = schemas.AeGetExpressionsArgs(comp_id="12")
    result = await _run_get_expressions(args, ctx=None)
    assert result["ok"] is True


def test_render_get_keyframes():
    from ae_mcp.handlers.typed import render_get_keyframes
    args = schemas.AeGetKeyframesArgs(layer_id=1, path="Transform/Position")
    jsx = render_get_keyframes(args)
    assert '"Transform/Position"' in jsx
    assert "AEMCP.layerById(comp, 1)" in jsx  # issue #8


@pytest.mark.asyncio
async def test_run_get_keyframes(mock_backend):
    mock_backend.set_response(
        json.dumps({"ok": True, "numKeyframes": 0, "keyframes": []}),
    )
    from ae_mcp.handlers.typed import _run_get_keyframes
    args = schemas.AeGetKeyframesArgs(layer_id=1, path="Transform/Position")
    result = await _run_get_keyframes(args, ctx=None)
    assert result["numKeyframes"] == 0


def test_render_search_project():
    from ae_mcp.handlers.typed import render_search_project
    args = schemas.AeSearchProjectArgs(query="hero", scope=["layers"], limit=10)
    jsx = render_search_project(args)
    assert '"hero"' in jsx
    assert '"layers"' in jsx
    assert "var limit = 10;" in jsx


def test_render_create_layer_position_uses_matchname():
    # #12: position must be addressed by matchName, not the localized display
    # names "Transform"/"Position" (null on JP/DE AE -> position silently lost).
    from ae_mcp.handlers.typed import render_create_layer
    args = S.AeCreateLayerArgs(type="solid", name="P", position=(10, 20, 0))
    jsx = render_create_layer(args)
    assert "AEMCP.propByMatchPath(" in jsx
    assert "ADBE Transform Group#1/ADBE Position#1" in jsx
    # The brittle display-name chain is gone.
    assert 'property("Transform").property("Position")' not in jsx


def test_render_search_project_has_time_budget():
    # #12: traversal must be wall-clock bounded so big projects return partial
    # results instead of blowing the 30s timeout with zero output.
    from ae_mcp.handlers.typed import render_search_project, _TRAVERSAL_BUDGET_MS
    jsx = render_search_project(schemas.AeSearchProjectArgs(query="x"))
    assert f"var BUDGET_MS = {_TRAVERSAL_BUDGET_MS};" in jsx
    assert "new Date().getTime()" in jsx
    assert "overBudget()" in jsx
    assert "budgetHit" in jsx
    assert _TRAVERSAL_BUDGET_MS < 30000  # comfortably under the exec timeout


def test_render_scan_property_tree_has_time_budget():
    from ae_mcp.handlers.typed import render_scan_property_tree, _TRAVERSAL_BUDGET_MS
    jsx = render_scan_property_tree(schemas.AeScanPropertyTreeArgs(layer_id=1))
    assert f"var BUDGET_MS = {_TRAVERSAL_BUDGET_MS};" in jsx
    assert "overBudget()" in jsx
    assert "budgetHit" in jsx


def test_render_create_rig_uses_layerById():
    # #12 (carried from PR #14 review): resolve the target via AEMCP.layerById
    # so the `if (!target)` guard is reachable and returns the friendly
    # "target layer not found" message instead of AE's raw exception.
    from ae_mcp.handlers.rig import _load_jsx
    import json as _json
    jsx = _load_jsx("create_rig.jsx").substitute(
        comp_expr="null",
        target_layer_id=_json.dumps(99),
        rig_type=_json.dumps("transform_controller"),
        name=_json.dumps("Ctrl"),
        options=_json.dumps({}),
    )
    assert "AEMCP.layerById(comp, 99)" in jsx
    assert "comp.layer(99)" not in jsx
    assert "target layer not found" in jsx



@pytest.mark.asyncio
async def test_run_search_project(mock_backend):
    mock_backend.set_response(
        json.dumps({"ok": True, "hits": [], "truncated": False}),
    )
    from ae_mcp.handlers.typed import _run_search_project
    args = schemas.AeSearchProjectArgs(query="x")
    result = await _run_search_project(args, ctx=None)
    assert result["ok"] is True
