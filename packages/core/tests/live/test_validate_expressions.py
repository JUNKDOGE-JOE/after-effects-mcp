"""Live tests for expression validation gates."""
from __future__ import annotations

import json

import pytest

from ae_mcp import schemas
from ae_mcp.handlers.typed import _run_validate_expressions


pytestmark = pytest.mark.live


SETUP_BAD_JSX = """
(function(){
  try {
    var comp = app.project.items.addComp("ValidateExpressionProbe", 640, 360, 1, 2.0, 24);
    var textLayer = comp.layers.addText("12.35");
    textLayer.name = "Bound_Number_Text";
    var effects = textLayer.property("ADBE Effect Parade");
    var slider = effects.addProperty("ADBE Slider Control");
    slider.name = "Value";
    slider.property("ADBE Slider Control-0001").setValue(12.345);
    var sourceText = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
    sourceText.expression = 'var v = effect("Value")("Slider");\\n(Math.round(v * 100) / 100).toFixed(2);';
    try { sourceText.valueAtTime(comp.time, false); } catch (_e) {}
    comp.openInViewer();
    return JSON.stringify({ok:true, compId: String(comp.id), layerId: textLayer.index});
  } catch (e) {
    return JSON.stringify({ok:false, error:String(e), line:e.line});
  }
})()
"""


SETUP_GOOD_JSX = """
(function(){
  try {
    var comp = app.project.items.addComp("ValidateExpressionProbeGood", 640, 360, 1, 2.0, 24);
    var textLayer = comp.layers.addText("12.35");
    textLayer.name = "Bound_Number_Text";
    var effects = textLayer.property("ADBE Effect Parade");
    var slider = effects.addProperty("ADBE Slider Control");
    slider.name = "Value";
    slider.property("ADBE Slider Control-0001").setValue(12.345);
    var sourceText = textLayer.property("ADBE Text Properties").property("ADBE Text Document");
    sourceText.expression = 'var v = effect("Value")(1);\\n(Math.round(v * 100) / 100).toFixed(2);';
    sourceText.valueAtTime(comp.time, false);
    comp.openInViewer();
    return JSON.stringify({ok:true, compId: String(comp.id), layerId: textLayer.index});
  } catch (e) {
    return JSON.stringify({ok:false, error:String(e), line:e.line});
  }
})()
"""


async def _setup(clean_project, jsx):
    out = await clean_project.exec(code=jsx, timeout_sec=20.0)
    parsed = json.loads(out)
    assert parsed["ok"] is True, parsed
    return parsed


@pytest.mark.asyncio
async def test_validate_expressions_catches_disabled_bad_slider_expression(clean_project):
    scene = await _setup(clean_project, SETUP_BAD_JSX)
    result = await _run_validate_expressions(
        schemas.AeValidateExpressionsArgs(
            comp_id=scene["compId"],
            layer_ids=[scene["layerId"]],
            sample_times=[0],
        ),
        None,
    )

    assert result["ok"] is True
    assert result["valid"] is False
    assert result["errors"]
    assert "Slider" in result["errors"][0]["expressionError"]


@pytest.mark.asyncio
async def test_validate_expressions_passes_locale_safe_slider_expression(clean_project):
    scene = await _setup(clean_project, SETUP_GOOD_JSX)
    result = await _run_validate_expressions(
        schemas.AeValidateExpressionsArgs(
            comp_id=scene["compId"],
            layer_ids=[scene["layerId"]],
            sample_times=[0],
        ),
        None,
    )

    assert result["ok"] is True
    assert result["valid"] is True
    assert result["errors"] == []
