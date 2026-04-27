"""Live tests for the 6 typed read verbs.

Strategy: build a fixture comp with known structure (1 solid layer at
position [960,540,0], 1 keyframe on Position, 1 expression on Rotation),
then call each read verb and assert the expected fields.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from ae_mcp import schemas
from ae_mcp.handlers.typed import (
    _run_get_properties, _run_scan_property_tree,
    _run_inspect_property_capabilities, _run_get_expressions,
    _run_get_keyframes, _run_search_project,
)


pytestmark = pytest.mark.live


SETUP_JSX = """
(function(){
    var comp = app.project.items.addComp("Probe", 320, 240, 1, 2.0, 24);
    var solid = comp.layers.addSolid([1,0,0], "RedBox", 100, 100, 1, 2.0);
    var pos = solid.property("ADBE Transform Group").property("ADBE Position");
    pos.setValueAtTime(0, [50, 50, 0]);
    pos.setValueAtTime(1.0, [200, 200, 0]);
    var rot = solid.property("ADBE Transform Group").property("ADBE Rotate Z");
    rot.expression = "wiggle(2,30)";
    return JSON.stringify({ok:true, compId: String(comp.id), layerId: solid.index});
})()
"""


@pytest.fixture
def probe_scene(clean_project):
    out = asyncio.run(clean_project.exec(code=SETUP_JSX, timeout_sec=20.0))
    return json.loads(out)


@pytest.mark.asyncio
async def test_get_properties_finds_position(probe_scene):
    args = schemas.AeGetPropertiesArgs(
        comp_id=probe_scene["compId"],
        layer_ids=[probe_scene["layerId"]],
        query="position",
    )
    result = await _run_get_properties(args, ctx=None)
    assert result["ok"] is True
    assert result["total"] >= 1
    paths = [r.get("matchPath") or r["propPath"] for r in result["results"]]
    assert any("ADBE Position" in p or "Position" in p for p in paths)


@pytest.mark.asyncio
async def test_scan_property_tree_returns_transform(probe_scene):
    args = schemas.AeScanPropertyTreeArgs(
        comp_id=probe_scene["compId"],
        layer_id=probe_scene["layerId"],
        max_depth=3,
    )
    result = await _run_scan_property_tree(args, ctx=None)
    assert result["ok"] is True
    names = [c["name"] for c in result["tree"]["children"]]
    assert any(n in ("Transform", "变换") for n in names)


@pytest.mark.asyncio
async def test_inspect_property_capabilities_position(probe_scene):
    args = schemas.AeInspectPropertyCapabilitiesArgs(
        comp_id=probe_scene["compId"],
        layer_id=probe_scene["layerId"],
        path="Transform/Position",
    )
    result = await _run_inspect_property_capabilities(args, ctx=None)
    assert result["ok"] is True
    assert result["exists"] is True
    assert result["canSetValue"] is True
    assert result["valueDimension"] in (2, 3)


@pytest.mark.asyncio
async def test_get_expressions_finds_wiggle(probe_scene):
    args = schemas.AeGetExpressionsArgs(comp_id=probe_scene["compId"])
    result = await _run_get_expressions(args, ctx=None)
    assert result["ok"] is True
    sources = [e["expression"] for e in result["expressions"]]
    assert any("wiggle" in s for s in sources)


@pytest.mark.asyncio
async def test_get_keyframes_position(probe_scene):
    args = schemas.AeGetKeyframesArgs(
        comp_id=probe_scene["compId"],
        layer_id=probe_scene["layerId"],
        path="Transform/Position",
    )
    result = await _run_get_keyframes(args, ctx=None)
    assert result["ok"] is True
    assert result["numKeyframes"] == 2


@pytest.mark.asyncio
async def test_search_project_finds_redbox(probe_scene):
    args = schemas.AeSearchProjectArgs(query="redbox")
    result = await _run_search_project(args, ctx=None)
    assert result["ok"] is True
    assert any(h.get("name", "").lower() == "redbox" for h in result["hits"])
