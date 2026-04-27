"""Live test for the full create→write→revert cycle.

Requires a saved .aep on disk (we save to %TEMP% before the test).
Verifies: checkpoint create writes a real .aep + meta sidecar, revert
opens it, and the property change made between create and revert is
rolled back.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path

import pytest

from ae_mcp import bridge, schemas
from ae_mcp.handlers.core import _run_checkpoint, _run_revert


pytestmark = pytest.mark.live


@pytest.mark.asyncio
async def test_checkpoint_create_revert_roundtrip(clean_project, tmp_path):
    # 1. Save the (empty) project to %TEMP% so it is no longer untitled.
    saved = tmp_path / "probe.aep"
    save_jsx = (
        f'(function(){{ app.project.save(new File({json.dumps(str(saved))})); '
        f'return JSON.stringify({{ok:true,path:app.project.file.fsName}}); }})()'
    )
    out = await bridge.invoke_ae_exec(code=save_jsx, timeout_sec=20.0)
    assert json.loads(out)["ok"] is True

    # 2. Add a comp + layer; save again so the saved state contains them.
    seed_jsx = (
        '(function(){'
        'var c = app.project.items.addComp("CycleProbe", 320, 240, 1, 1.0, 24);'
        'var s = c.layers.addSolid([1,0,0], "Box", 100, 100, 1, 1.0);'
        's.property("ADBE Transform Group").property("ADBE Position").setValue([100,100,0]);'
        'app.project.save();'
        'return JSON.stringify({ok:true, compId:String(c.id), layerId:s.index});'
        '})()'
    )
    seed = json.loads(await bridge.invoke_ae_exec(code=seed_jsx, timeout_sec=20.0))

    # 3. ae.checkpoint create
    cp = await _run_checkpoint(
        schemas.AeCheckpointArgs(action="create", label="seeded"),
        ctx=None,
    )
    assert cp["ok"] is True and cp.get("id"), cp
    cp_id = cp["id"]
    assert Path(cp["path"]).exists()

    # 4. Mutate position to a different value
    mut_jsx = (
        f'(function(){{'
        f'var c = app.project.itemByID({int(seed["compId"])});'
        f'var s = c.layer({int(seed["layerId"])});'
        f's.property("ADBE Transform Group").property("ADBE Position").setValue([777,777,0]);'
        f'return JSON.stringify({{ok:true}});'
        f'}})()'
    )
    await bridge.invoke_ae_exec(code=mut_jsx, timeout_sec=10.0)

    # 5. ae.revert
    rv = await _run_revert(
        schemas.AeRevertArgs(checkpoint_id=cp_id, branch_before_revert=False),
        ctx=None,
    )
    assert rv["ok"] is True and rv.get("reverted") is True, rv

    # 6. Verify position back to [100,100,0]
    check_jsx = (
        '(function(){'
        'var c = app.project.itemByName("CycleProbe");'
        'if (!c) return JSON.stringify({ok:false,error:"comp gone"});'
        'var pos = c.layer(1).property("ADBE Transform Group").property("ADBE Position").value;'
        'return JSON.stringify({ok:true, x:pos[0], y:pos[1]});'
        '})()'
    )
    val = json.loads(await bridge.invoke_ae_exec(code=check_jsx, timeout_sec=10.0))
    assert val["ok"] is True
    assert abs(val["x"] - 100.0) < 0.5
    assert abs(val["y"] - 100.0) < 0.5

    # 7. ae.checkpoint list contains our id
    listed = await _run_checkpoint(
        schemas.AeCheckpointArgs(action="list", limit=10), ctx=None
    )
    assert listed["ok"] is True
    assert any(c["id"] == cp_id for c in listed["checkpoints"])
