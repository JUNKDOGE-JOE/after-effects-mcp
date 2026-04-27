"""Live tests for ae.previewFrame viewer capture."""
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
    assert frame["source"] == "viewer"
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
