"""progress.with_heartbeat + run_with_timeout timing and cancel semantics."""

from __future__ import annotations

import asyncio
import time

import pytest

from aebm_mcp import progress


class FakeCtx:
    """Records report_progress calls."""

    def __init__(self) -> None:
        self.reports: list = []

    async def report_progress(self, progress: float, total, message):
        self.reports.append((progress, total, message))


@pytest.mark.asyncio
async def test_with_heartbeat_fires_initial_and_beats():
    ctx = FakeCtx()

    async def work():
        await asyncio.sleep(0.25)
        return "done"

    result = await progress.with_heartbeat(
        ctx, work(), interval=0.1, start_msg="start"
    )
    assert result == "done"
    # start report + at least 2 beats
    assert len(ctx.reports) >= 3
    assert ctx.reports[0][2] == "start"


@pytest.mark.asyncio
async def test_with_heartbeat_cancels_on_work_complete():
    """Heartbeat should stop firing once work returns."""
    ctx = FakeCtx()

    async def instant():
        return "fast"

    result = await progress.with_heartbeat(ctx, instant(), interval=0.05)
    assert result == "fast"
    # Only the initial report should land.
    assert len(ctx.reports) == 1

    # Ensure no late beats arrive.
    await asyncio.sleep(0.15)
    assert len(ctx.reports) == 1


@pytest.mark.asyncio
async def test_with_heartbeat_propagates_exception():
    ctx = FakeCtx()

    async def fail():
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await progress.with_heartbeat(ctx, fail(), interval=0.1)


@pytest.mark.asyncio
async def test_run_with_timeout_returns_error_on_timeout():
    ctx = FakeCtx()

    async def slow():
        await asyncio.sleep(1.0)
        return "done"

    result = await progress.run_with_timeout(
        ctx, slow(), timeout_sec=0.1, interval=0.05
    )
    assert isinstance(result, dict)
    assert result["ok"] is False
    assert "timed out" in result["error"]


@pytest.mark.asyncio
async def test_run_with_timeout_passes_through():
    ctx = FakeCtx()

    async def quick():
        return {"ok": True, "x": 1}

    result = await progress.run_with_timeout(ctx, quick(), timeout_sec=1.0)
    assert result == {"ok": True, "x": 1}


@pytest.mark.asyncio
async def test_heartbeat_safe_with_none_ctx():
    """Handlers can pass ctx=None in tests; should not raise."""

    async def work():
        return "ok"

    result = await progress.with_heartbeat(None, work(), interval=0.05)
    assert result == "ok"
