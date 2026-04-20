"""Typed 6 handler JSX rendering + dispatch."""

from __future__ import annotations

import json

import pytest

from aebm_mcp import schemas as S
from aebm_mcp.handlers import HANDLERS, load_all
from aebm_mcp.handlers import typed as T


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
    assert "comp.layer(2)" in jsx
    assert '"Transform/Position"' in jsx
    assert "[100, 200]" in jsx
    assert "1.5" in jsx


def test_render_set_property_without_keyframe():
    args = S.AeSetPropertyArgs(layer_id=1, path="Opacity", value=50)
    jsx = T.render_set_property(args)
    assert "-1.0" in jsx  # at_time sentinel


def test_render_move_layer_clamps_in_js_not_py():
    args = S.AeMoveLayerArgs(layer_id=3, to_index=10)
    jsx = T.render_move_layer(args)
    assert "comp.layer(3)" in jsx
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
    assert "activeItem" in jsx


def test_render_get_time_with_comp_id():
    jsx = T.render_get_time(S.AeGetTimeArgs(comp_id="42"))
    assert "itemByID(42)" in jsx


# -------- Dispatch round-trips (using mock_bridge) --------


@pytest.mark.asyncio
async def test_create_layer_dispatches_exec(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec", '{"ok":true,"layerId":2,"name":"x","index":2}'
    )
    _, run_fn = HANDLERS["ae.createLayer"]
    result = await run_fn(S.AeCreateLayerArgs(type="solid", name="x"), None)
    assert result["ok"] is True
    assert result["layerId"] == 2


@pytest.mark.asyncio
async def test_set_property_dispatches(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec", '{"ok":true,"previous":[0,0],"current":[100,200]}'
    )
    _, run_fn = HANDLERS["ae.setProperty"]
    result = await run_fn(
        S.AeSetPropertyArgs(layer_id=1, path="Transform/Position", value=[100, 200]),
        None,
    )
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_select_layers_all_dispatches(mock_bridge):
    mock_bridge.set_response("invoke_ae_exec", '{"ok":true,"selected":[1,2]}')
    _, run_fn = HANDLERS["ae.selectLayers"]
    result = await run_fn(S.AeSelectLayersArgs(layer_ids="all"), None)
    assert result["selected"] == [1, 2]


@pytest.mark.asyncio
async def test_set_time_dispatches(mock_bridge):
    mock_bridge.set_response("invoke_ae_exec", '{"ok":true,"time":1.5}')
    _, run_fn = HANDLERS["ae.setTime"]
    result = await run_fn(S.AeSetTimeArgs(time=1.5), None)
    assert result["time"] == 1.5


@pytest.mark.asyncio
async def test_get_time_dispatches(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        '{"ok":true,"time":0.0,"duration":10.0,"numLayers":3,"compId":42}',
    )
    _, run_fn = HANDLERS["ae.getTime"]
    result = await run_fn(S.AeGetTimeArgs(), None)
    assert result["numLayers"] == 3


@pytest.mark.asyncio
async def test_move_layer_dispatches(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec", '{"ok":true,"fromIndex":3,"toIndex":1}'
    )
    _, run_fn = HANDLERS["ae.moveLayer"]
    result = await run_fn(S.AeMoveLayerArgs(layer_id=3, to_index=1), None)
    assert result["fromIndex"] == 3
    assert result["toIndex"] == 1
