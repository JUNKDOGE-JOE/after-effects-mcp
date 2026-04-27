"""Live tests for ae.createRig."""
from __future__ import annotations

import asyncio
import json

import pytest

from ae_mcp import schemas
from ae_mcp.handlers.rig import _run_create_rig


pytestmark = pytest.mark.live


SETUP_JSX = """
(function(){
  try {
    var comp = app.project.items.addComp("RigProbe", 320, 240, 1, 2.0, 24);
    var solid = comp.layers.addSolid([0,0.4,1], "RigTarget", 100, 100, 1, 2.0);
    comp.openInViewer();
    return JSON.stringify({ok:true, compId: String(comp.id), layerId: solid.index});
  } catch (e) {
    return JSON.stringify({ok:false, error:String(e), line:e.line});
  }
})()
"""


@pytest.fixture
def rig_scene(clean_project):
    out = asyncio.run(clean_project.exec(code=SETUP_JSX, timeout_sec=20.0))
    parsed = json.loads(out)
    assert parsed["ok"] is True, parsed
    return parsed


@pytest.mark.asyncio
async def test_create_rig_transform_controller_links_position(rig_scene):
    result = await _run_create_rig(
        schemas.AeCreateRigArgs(
            comp_id=rig_scene["compId"],
            target_layer_id=rig_scene["layerId"],
            rig_type="transform_controller",
            name="Rig CTRL",
            options={"position": True, "rotation": False, "scale": False, "opacity": False},
        ),
        None,
    )
    assert result["ok"] is True
    assert result["controllerLayerId"] > 0
    assert result["wiredProperties"] == ["Transform/Position"]


@pytest.mark.asyncio
async def test_create_rig_effect_control_drives_opacity(rig_scene):
    result = await _run_create_rig(
        schemas.AeCreateRigArgs(
            comp_id=rig_scene["compId"],
            target_layer_id=rig_scene["layerId"],
            rig_type="effect_controls",
            name="Opacity CTRL",
            options={
                "controls": [
                    {"name": "Opacity", "type": "slider", "property": "Transform/Opacity"}
                ]
            },
        ),
        None,
    )
    assert result["ok"] is True
    assert result["wiredProperties"] == ["Transform/Opacity"]


@pytest.mark.asyncio
async def test_create_rig_puppet_pin_nulls_skip_without_puppet(rig_scene):
    result = await _run_create_rig(
        schemas.AeCreateRigArgs(
            comp_id=rig_scene["compId"],
            target_layer_id=rig_scene["layerId"],
            rig_type="puppet_pin_nulls",
            name="Pins",
        ),
        None,
    )
    assert result["ok"] is True
    assert result["skipped"] is True
    assert result["createdLayers"] == []


@pytest.mark.asyncio
async def test_create_rig_apply_preset_missing_path_returns_clear_error(rig_scene, artifact_dir):
    missing = artifact_dir / "missing-preset.ffx"
    result = await _run_create_rig(
        schemas.AeCreateRigArgs(
            comp_id=rig_scene["compId"],
            target_layer_id=rig_scene["layerId"],
            rig_type="apply_preset",
            options={"preset_path": str(missing)},
        ),
        None,
    )
    assert result["ok"] is False
    assert "preset not found" in result["error"]
