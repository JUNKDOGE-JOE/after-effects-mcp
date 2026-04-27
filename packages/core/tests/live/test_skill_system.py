"""Live tests for ae.skillUse execute=true."""
from __future__ import annotations

import asyncio
import json

import pytest

from ae_mcp import schemas
from ae_mcp.handlers.skills import _run_skill_create, _run_skill_delete, _run_skill_use


pytestmark = pytest.mark.live


SETUP_JSX = """
(function(){
  try {
    var comp = app.project.items.addComp("SkillProbe", 320, 240, 1, 2.0, 24);
    var solid = comp.layers.addSolid([1,0,0], "SkillSolid", 100, 100, 1, 2.0);
    comp.openInViewer();
    return JSON.stringify({ok:true, compId: Number(comp.id), layerId: solid.index});
  } catch (e) {
    return JSON.stringify({ok:false, error:String(e), line:e.line});
  }
})()
"""


@pytest.fixture
def skill_scene(clean_project, monkeypatch, tmp_path):
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path))
    out = asyncio.run(clean_project.exec(code=SETUP_JSX, timeout_sec=20.0))
    parsed = json.loads(out)
    assert parsed["ok"] is True, parsed
    return parsed


@pytest.mark.asyncio
async def test_skill_use_execute_applies_expression(skill_scene):
    skill_name = "live-wiggle-rotation"
    await _run_skill_create(
        schemas.AeSkillCreateArgs(
            name=skill_name,
            description="Apply a wiggle expression to rotation",
            template="""
(function(){
  var comp = app.project.itemByID(${comp_id});
  var layer = comp.layer(${layer_id});
  var prop = layer.property("ADBE Transform Group").property("ADBE Rotate Z");
  prop.expression = "wiggle(" + ${freq} + "," + ${amp} + ")";
  return JSON.stringify({ok:true, expression: prop.expression});
})()
""",
            args_schema={
                "comp_id": {"type": "number"},
                "layer_id": {"type": "number"},
                "freq": {"type": "number", "default": 2},
                "amp": {"type": "number", "default": 30},
            },
            overwrite=True,
        ),
        None,
    )

    result = await _run_skill_use(
        schemas.AeSkillUseArgs(
            name=skill_name,
            args={"comp_id": skill_scene["compId"], "layer_id": skill_scene["layerId"]},
            execute=True,
        ),
        None,
    )
    await _run_skill_delete(schemas.AeSkillDeleteArgs(name=skill_name), None)

    assert result["ok"] is True
    assert result["expression"] == "wiggle(2,30)"
