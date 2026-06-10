"""progress.with_heartbeat + run_with_timeout timing and cancel semantics."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

from ae_mcp import progress


class FakeCtx:
    """Records report_progress calls (FastMCP-style ctx)."""

    def __init__(self) -> None:
        self.reports: list = []

    async def report_progress(self, progress: float, total, message):
        self.reports.append((progress, total, message))


class FakeSession:
    """Records low-level send_progress_notification calls."""

    def __init__(self) -> None:
        self.notifications: list = []

    async def send_progress_notification(
        self, progress_token, progress, total=None, message=None
    ):
        self.notifications.append(
            {
                "progress_token": progress_token,
                "progress": progress,
                "total": total,
                "message": message,
            }
        )


def _lowlevel_ctx(token):
    """Build a RequestContext-shaped fake: .session + .meta.progressToken."""
    return SimpleNamespace(
        session=FakeSession(),
        meta=SimpleNamespace(progressToken=token),
    )


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


# --- low-level RequestContext path (mcp.server.Server, not FastMCP) ---------


@pytest.mark.asyncio
async def test_lowlevel_sends_notification_when_token_present():
    """When the request carried a progressToken, a real
    notifications/progress is emitted via session.send_progress_notification."""
    ctx = _lowlevel_ctx(token="tok-123")

    async def work():
        return "done"

    result = await progress.with_heartbeat(ctx, work(), interval=0.05)
    assert result == "done"
    # The initial 0-progress report should have been sent on the session.
    assert len(ctx.session.notifications) >= 1
    first = ctx.session.notifications[0]
    assert first["progress_token"] == "tok-123"
    assert first["progress"] == 0


@pytest.mark.asyncio
async def test_lowlevel_noop_when_token_absent():
    """No progressToken -> nobody asked for progress -> no send, no raise."""
    ctx = _lowlevel_ctx(token=None)

    async def work():
        await asyncio.sleep(0.15)
        return "done"

    result = await progress.with_heartbeat(ctx, work(), interval=0.05)
    assert result == "done"
    # Nothing should have been sent (clean no-op).
    assert ctx.session.notifications == []


@pytest.mark.asyncio
async def test_lowlevel_swallows_send_errors():
    """A raising send_progress_notification must not break the work path."""

    class BoomSession:
        async def send_progress_notification(self, **kw):
            raise RuntimeError("network down")

    ctx = SimpleNamespace(
        session=BoomSession(),
        meta=SimpleNamespace(progressToken="tok"),
    )

    async def work():
        return "ok"

    # Should not raise despite the failing send.
    result = await progress.with_heartbeat(ctx, work(), interval=0.05)
    assert result == "ok"


@pytest.mark.asyncio
async def test_safe_report_progress_no_meta_attr_no_raise():
    """A ctx with a session but no .meta attribute must no-op, not raise."""
    ctx = SimpleNamespace(session=FakeSession())  # no .meta

    await progress._safe_report_progress(ctx, 0.0, None, "x")
    assert ctx.session.notifications == []

