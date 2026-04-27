"""Live smoke tests — 3-verb handshake."""
from __future__ import annotations

import asyncio
import json

import pytest

from ae_mcp import schemas
from ae_mcp.handlers.core import _run_ping


pytestmark = [pytest.mark.live, pytest.mark.live_smoke]


@pytest.mark.asyncio
async def test_ping_returns_pong(live_backend):
    args = schemas.AePingArgs()
    result = await _run_ping(args, ctx=None)
    assert result["ok"] is True
    assert result["pong"] == "pong"
    assert "aeVersion" in result


@pytest.mark.asyncio
async def test_exec_arithmetic(live_backend):
    out = await live_backend.exec(
        code='JSON.stringify({ok:true,answer:1+1})', timeout_sec=10.0
    )
    parsed = json.loads(out)
    assert parsed == {"ok": True, "answer": 2}


@pytest.mark.asyncio
async def test_snapshot_writes_png(live_backend, artifact_dir, tmp_path):
    from ae_mcp.snapshot import discovery as _snap_discovery
    snapper = _snap_discovery.select_snapshotter()
    if snapper is None:
        pytest.skip("no snapshotter installed")
    out_path = tmp_path / "ae_smoke.png"
    result = await snapper.capture(out_path=out_path)
    assert result["ok"] is True
    assert out_path.exists() and out_path.stat().st_size > 1000
    import shutil
    shutil.copy(out_path, artifact_dir / "ae_smoke.png")
