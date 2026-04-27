"""Live smoke tests — 3-verb handshake. Run with:
    AEBM_LIVE_TESTS=1 python -m uv run pytest -m live_smoke

Acts as a "is the bridge wired up at all" canary.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from ae_mcp import bridge, schemas
from ae_mcp.handlers.core import _run_ping


pytestmark = [pytest.mark.live, pytest.mark.live_smoke]


@pytest.mark.asyncio
async def test_ping_returns_pong(live_bridge):
    args = schemas.AePingArgs()
    result = await _run_ping(args, ctx=None)
    assert result["ok"] is True
    assert result["pong"] == "pong"
    assert "aeVersion" in result


@pytest.mark.asyncio
async def test_exec_arithmetic(live_bridge):
    out = await bridge.invoke_ae_exec(
        code='JSON.stringify({ok:true,answer:1+1})', timeout_sec=10.0
    )
    parsed = json.loads(out)
    assert parsed == {"ok": True, "answer": 2}


@pytest.mark.asyncio
async def test_snapshot_writes_png(live_bridge, artifact_dir, tmp_path):
    from ae_mcp import snapshot
    out_path = tmp_path / "ae_smoke.png"
    result = snapshot.capture_ae_viewer(out_path=str(out_path))
    assert result["ok"] is True
    assert out_path.exists() and out_path.stat().st_size > 1000
    # Save a copy to artifacts for inspection
    import shutil
    shutil.copy(out_path, artifact_dir / "ae_smoke.png")
