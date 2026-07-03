"""Live tests for ae.previewFrame comp-frame capture."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from ae_mcp import schemas
from ae_mcp.handlers.core import _run_preview_frame


pytestmark = pytest.mark.live


SETUP_JSX = """
(function(){
  try {
    var comp = app.project.items.addComp("PreviewProbe", 160, 90, 1, 2.0, 24);
    var solid = comp.layers.addSolid([1,0,0], "RedPatch", 64, 48, 1, 2.0);
    solid.property("ADBE Transform Group").property("ADBE Position").setValue([40, 30, 0]);
    comp.time = 0.25;
    comp.openInViewer();
    return JSON.stringify({ok:true, compId: String(comp.id), layerId: solid.index});
  } catch (e) {
    return JSON.stringify({ok:false, error:String(e), line:e.line});
  }
})()
"""


def _assert_png(path):
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(data) > 100


@pytest.fixture
def preview_scene(clean_project):
    out = asyncio.run(clean_project.exec(code=SETUP_JSX, timeout_sec=20.0))
    parsed = json.loads(out)
    assert parsed["ok"] is True, parsed
    return parsed


@pytest.mark.asyncio
async def test_preview_frame_active_comp_current_time(preview_scene, artifact_dir):
    result = await _run_preview_frame(
        schemas.AePreviewFrameArgs(out_dir=str(artifact_dir)),
        ctx=None,
    )
    assert result["ok"] is True
    frame = result["frames"][0]
    path = artifact_dir / Path(frame["path"]).name
    assert path.exists()
    assert frame["path"] == str(path)
    assert path.stat().st_size > 100
    assert frame["source"] == "comp"
    assert frame["method"] == "saveFrameToPng"
    _assert_png(path)


@pytest.mark.asyncio
async def test_preview_frame_explicit_comp_and_time(preview_scene, artifact_dir):
    result = await _run_preview_frame(
        schemas.AePreviewFrameArgs(
            comp_id=preview_scene["compId"],
            time=0.5,
            out_dir=str(artifact_dir),
        ),
        ctx=None,
    )
    assert result["ok"] is True
    assert result["compId"] == preview_scene["compId"]
    assert result["frames"][0]["time"] == 0.5
    path = artifact_dir / Path(result["frames"][0]["path"]).name
    _assert_png(path)


@pytest.mark.asyncio
async def test_preview_frame_multiple_times_with_base64(preview_scene, artifact_dir):
    result = await _run_preview_frame(
        schemas.AePreviewFrameArgs(
            comp_id=preview_scene["compId"],
            times=[0.0, 1.0],
            out_dir=str(artifact_dir),
            include_base64=True,
        ),
        ctx=None,
    )
    assert result["ok"] is True
    assert len(result["frames"]) == 2
    for frame in result["frames"]:
        assert frame["sizeBytes"] > 100
        assert frame["base64"]


# previewFrame must give different bytes per time when content at those times
# is visibly different. This catches stale viewer fallback captures and failed
# comp-frame time selection.
ANIMATED_SETUP_JSX = """
(function(){
  try {
    var comp = app.project.items.addComp("PreviewAnim", 320, 180, 1, 2.0, 30);
    var s = comp.layers.addSolid([1,1,1], "Mover", 60, 60, 1, 2.0);
    var pos = s.property("ADBE Transform Group").property("ADBE Position");
    pos.setValueAtTime(0.0, [40, 90]);
    pos.setValueAtTime(1.0, [280, 90]);
    comp.openInViewer();
    return JSON.stringify({ok:true, compId: String(comp.id)});
  } catch (e) { return JSON.stringify({ok:false, error:String(e)}); }
})()
"""


@pytest.mark.asyncio
async def test_preview_frame_captures_different_times_distinctly(clean_project, artifact_dir):
    """Frames at distinct times must differ in pixel content."""
    out = asyncio.run(clean_project.exec(code=ANIMATED_SETUP_JSX, timeout_sec=20.0)) \
        if False else await clean_project.exec(code=ANIMATED_SETUP_JSX, timeout_sec=20.0)
    parsed = json.loads(out)
    assert parsed["ok"] is True, parsed
    comp_id = parsed["compId"]

    result = await _run_preview_frame(
        schemas.AePreviewFrameArgs(
            comp_id=comp_id,
            times=[0.0, 1.0],
            out_dir=str(artifact_dir),
            repaint_delay_ms=400,
        ),
        ctx=None,
    )
    assert result["ok"] is True
    assert len(result["frames"]) == 2

    p0 = Path(result["frames"][0]["path"])
    p1 = Path(result["frames"][1]["path"])
    b0 = p0.read_bytes()
    b1 = p1.read_bytes()
    assert b0 != b1, (
        "previewFrame returned byte-identical frames for visibly distinct comp "
        "times — the AE viewer didn't repaint between captures. Likely a "
        "regression of the repaint_delay_ms fix."
    )
