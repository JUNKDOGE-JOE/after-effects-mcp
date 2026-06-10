"""Async heartbeat wrapper for MCP tool handlers.

Why: long-running AE ops (`ae.exec` with heavy JSX, 6 typed verbs that build
JSX and round-trip through the file bridge) can take tens of seconds. Without
periodic progress notifications the MCP client sees a silent stall and may
time out the request. `with_heartbeat` pairs the real work with a background
task that emits a progress notification every `interval` seconds.

The handlers receive the low-level ``mcp.shared.context.RequestContext`` (this
server is built on ``mcp.server.Server``, not FastMCP). That object has NO
``report_progress`` method — only FastMCP's ``Context`` does. The real
out-of-band progress channel is ``ctx.session.send_progress_notification``,
and it only does anything when the inbound request carried a
``_meta.progressToken`` (exposed as ``ctx.meta.progressToken``). When no token
is present there is nobody to notify, so we no-op cleanly.

Usage:
    result = await with_heartbeat(ctx, do_work_coro, interval=2.0,
                                  start_msg="Running ae.exec...")
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Awaitable, Optional

log = logging.getLogger("ae_mcp.progress")


def _progress_token(ctx: Any) -> Any:
    """Extract the inbound request's progressToken, or None if absent."""
    meta = getattr(ctx, "meta", None)
    if meta is None:
        return None
    return getattr(meta, "progressToken", None)


async def _safe_report_progress(
    ctx: Any, progress: float, total: Optional[float], message: Optional[str]
) -> None:
    """Best-effort progress notification. Swallow errors — heartbeat must
    never break the actual work path.

    Resolution order:
      1. Low-level path (the real server): emit a notifications/progress via
         ``ctx.session.send_progress_notification`` when the request carried a
         progressToken. No token -> nothing to notify -> clean no-op.
      2. FastMCP path: if the ctx exposes ``report_progress`` (e.g. tests using
         a FastMCP-style fake), use it.
      3. Otherwise no-op.

    Accepts ctx=None (useful for tests that drive handlers without a ctx).
    Never raises into the caller.
    """
    if ctx is None:
        return
    try:
        session = getattr(ctx, "session", None)
        send = getattr(session, "send_progress_notification", None)
        if send is not None:
            token = _progress_token(ctx)
            if token is None:
                # No progressToken on the request: the client didn't ask for
                # progress, so there's nothing to send. Clean no-op.
                return
            await send(
                progress_token=token,
                progress=progress,
                total=total,
                message=message,
            )
            return
        # FastMCP Context exposes async report_progress(progress, total, message).
        report = getattr(ctx, "report_progress", None)
        if report is not None:
            await report(progress=progress, total=total, message=message)
    except Exception:  # noqa: BLE001
        log.debug("progress notification failed", exc_info=True)


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
