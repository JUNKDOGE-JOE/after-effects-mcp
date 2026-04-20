"""Async heartbeat wrapper for MCP tool handlers.

Why: long-running AE ops (`ae.exec` with heavy JSX, 6 typed verbs that build
JSX and round-trip through the file bridge) can take tens of seconds. Without
periodic progress notifications the MCP client sees a silent stall and may
time out the request. `with_heartbeat` pairs the real work with a background
task that emits `ctx.report_progress` every `interval` seconds.

Usage:
    result = await with_heartbeat(ctx, do_work_coro, interval=2.0,
                                  start_msg="Running ae.exec...")
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Awaitable, Optional

log = logging.getLogger("aebm_mcp.progress")


async def _safe_report_progress(
    ctx: Any, progress: float, total: Optional[float], message: Optional[str]
) -> None:
    """Best-effort progress notification. Swallow errors — heartbeat must
    never break the actual work path.

    Accepts ctx=None (useful for tests that drive handlers without FastMCP).
    """
    if ctx is None:
        return
    try:
        # FastMCP Context exposes async report_progress(progress, total, message).
        await ctx.report_progress(progress=progress, total=total, message=message)
    except Exception:  # noqa: BLE001
        log.debug("report_progress failed", exc_info=True)


async def with_heartbeat(
    ctx: Any,
    coro: Awaitable[Any],
    interval: float = 2.0,
    start_msg: str = "Running...",
) -> Any:
    """Await `coro`, emitting progress heartbeats every `interval` seconds.

    The heartbeat task is cancelled as soon as `coro` returns or raises. Any
    exception from `coro` propagates unchanged.

    `ctx` may be None (e.g. in unit tests); reports become no-ops.
    """
    await _safe_report_progress(ctx, 0, None, start_msg)

    async def _beat() -> None:
        n = 0
        while True:
            await asyncio.sleep(interval)
            n += 1
            elapsed = n * interval
            await _safe_report_progress(
                ctx, float(n), None, f"Still running at t+{elapsed:.0f}s..."
            )

    beat_task = asyncio.create_task(_beat())
    try:
        return await coro
    finally:
        beat_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await beat_task


async def run_with_timeout(
    ctx: Any,
    coro: Awaitable[Any],
    timeout_sec: float,
    interval: float = 2.0,
    start_msg: str = "Running...",
) -> Any:
    """Convenience: heartbeat + asyncio.wait_for. On timeout returns a dict
    {"ok": False, "error": "timed out after Xs"} rather than raising, so the
    MCP handler can present a clean structured result."""
    try:
        return await asyncio.wait_for(
            with_heartbeat(ctx, coro, interval=interval, start_msg=start_msg),
            timeout=timeout_sec,
        )
    except asyncio.TimeoutError:
        return {"ok": False, "error": f"timed out after {timeout_sec:.0f}s"}
