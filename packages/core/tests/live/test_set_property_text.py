"""Live regression test for ae.setProperty on text Source Text."""
from __future__ import annotations

import asyncio
import json

import pytest

from ae_mcp import schemas
from ae_mcp.handlers.typed import _run_set_property


pytestmark = pytest.mark.live


SETUP_JSX = """
(function(){
  try {
    var comp = app.project.items.addComp("SetTextProbe", 320, 240, 1, 2.0, 24);
    var textLayer = comp.layers.addText("before");
    comp.openInViewer();
    return JSON.stringify({ok:true, compId: String(comp.id), layerId: textLayer.index});
  } catch (e) {
    return JSON.stringify({ok:false, error:String(e), line:e.line});
  }
})()
"""


@pytest.fixture
def text_scene(clean_project):
    out = asyncio.run(clean_project.exec(code=SETUP_JSX, timeout_sec=20.0))
    parsed = json.loads(out)
    assert parsed["ok"] is True, parsed
    return parsed


@pytest.mark.asyncio
async def test_set_property_source_text_returns_serializable_values(text_scene):
    result = await _run_set_property(
        schemas.AeSetPropertyArgs(
            comp_id=text_scene["compId"],
            layer_id=text_scene["layerId"],
            path="Text/Source Text",
            value="after",
        ),
        None,
    )

    assert result["ok"] is True, result
    assert result["previous"] == "before"
    assert result["current"] == "after"
