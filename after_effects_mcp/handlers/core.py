"""Core 9 handlers.

Registers: ae.init, ae.overview, ae.layers, ae.readProps, ae.exec,
ae.checkpoint, ae.revert, ae.snapshot, ae.applyEffect.

Each handler:
  1. validates pydantic args (already done by server.py before dispatch),
  2. calls into bridge.run_ps / bridge.invoke_ae_* or snapshot.capture_ae_viewer,
  3. parses JSON where possible and returns dict/str.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from after_effects_mcp import bridge, progress, schemas
from after_effects_mcp.handlers import register

log = logging.getLogger("after_effects_mcp.handlers.core")


# ---------------------------------------------------------------------------
# Utility: parse JSON if it looks like JSON; otherwise return raw text.
# ---------------------------------------------------------------------------


def _try_json(text: str) -> Any:
    if not text:
        return {"ok": True, "content": ""}
    stripped = text.lstrip()
    if stripped[:1] in ("{", "["):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass
    return {"ok": True, "content": text}


# ---------------------------------------------------------------------------
# ae.init
# ---------------------------------------------------------------------------


async def _run_init(args: schemas.AeInitArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        out = await bridge.invoke_ae_init(refresh_only=args.refresh_only)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.init..."
    )


register("ae.init", schemas.AeInitArgs, _run_init)


# ---------------------------------------------------------------------------
# ae.overview
# ---------------------------------------------------------------------------


async def _run_overview(args: schemas.AeOverviewArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        out = await bridge.invoke_ae_overview()
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=20.0, start_msg="ae.overview..."
    )


register("ae.overview", schemas.AeOverviewArgs, _run_overview)


# ---------------------------------------------------------------------------
# ae.layers
# ---------------------------------------------------------------------------


async def _run_layers(args: schemas.AeLayersArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        out = await bridge.invoke_ae_layers(comp_id=args.comp_id)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=20.0, start_msg="ae.layers..."
    )


register("ae.layers", schemas.AeLayersArgs, _run_layers)


# ---------------------------------------------------------------------------
# ae.readProps — always routes through ae.exec so callers can supply any JSX.
# ---------------------------------------------------------------------------


async def _run_read_props(args: schemas.AeReadPropsArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=args.code, timeout_sec=20.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.readProps..."
    )


register("ae.readProps", schemas.AeReadPropsArgs, _run_read_props)


# ---------------------------------------------------------------------------
# ae.exec
# ---------------------------------------------------------------------------


async def _run_exec(args: schemas.AeExecArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(
            code=args.code,
            undo_group_name=args.undo_group_name,
            checkpoint_label=args.checkpoint_label,
            timeout_sec=float(args.timeout_sec),
        )
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx,
        _call(),
        timeout_sec=float(args.timeout_sec) + 10.0,
        start_msg="ae.exec...",
    )


register("ae.exec", schemas.AeExecArgs, _run_exec)


# ---------------------------------------------------------------------------
# ae.checkpoint (stub)
# ---------------------------------------------------------------------------


async def _run_checkpoint(args: schemas.AeCheckpointArgs, ctx: Any) -> Any:
    # aebm-file backend returns {"checkpoints":[]} by design in v0.6.2.
    return {"checkpoints": []}


register("ae.checkpoint", schemas.AeCheckpointArgs, _run_checkpoint)


# ---------------------------------------------------------------------------
# ae.revert (stub)
# ---------------------------------------------------------------------------


async def _run_revert(args: schemas.AeRevertArgs, ctx: Any) -> Any:
    return {
        "reverted": False,
        "reason": "NotImplemented in aebm-file (v0.6.2). See DECISION_LOG.",
    }


register("ae.revert", schemas.AeRevertArgs, _run_revert)


# ---------------------------------------------------------------------------
# ae.snapshot — direct ctypes, no pwsh subprocess.
# ---------------------------------------------------------------------------


async def _run_snapshot(args: schemas.AeSnapshotArgs, ctx: Any) -> Any:
    try:
        from after_effects_mcp import snapshot as snap
    except ImportError as e:  # non-Windows
        return {"ok": False, "error": f"snapshot unavailable: {e}"}

    # ctypes calls are synchronous; run directly. Typical cost ~100-200ms.
    try:
        result = snap.capture_ae_viewer(
            out_path=args.out_path,
            hwnd=args.hwnd,
            main_window=args.main_window,
            method=args.method,
        )
        return result
    except Exception as e:  # noqa: BLE001
        log.exception("ae.snapshot failed")
        return {"ok": False, "error": str(e)}


register("ae.snapshot", schemas.AeSnapshotArgs, _run_snapshot)


# ---------------------------------------------------------------------------
# ae.applyEffect — JSX generated here; sent via ae.exec.
# ---------------------------------------------------------------------------


def _apply_effect_jsx(comp_id: str | None, layer_id: int, match_name: str) -> str:
    """Build JSX that adds an effect by matchName to the given layer.

    Returns JSON { ok, effectIndex, effectName } or { ok:false, error }.
    """
    # JSON-escape the match name so embedded quotes are safe inside JSX.
    escaped_name = json.dumps(match_name)
    comp_expr = (
        f"(function(){{ var it = app.project.itemByID({int(comp_id)}); "
        f"return (it && it instanceof CompItem) ? it : null; }})()"
        if comp_id else
        "(function(){ var it = app.project.activeItem; "
        "return (it && it instanceof CompItem) ? it : null; })()"
    )
    return (
        "(function(){\n"
        f"  var comp = {comp_expr};\n"
        "  if (!comp) return JSON.stringify({ok:false,error:'no comp'});\n"
        f"  var layer = comp.layer({int(layer_id)});\n"
        "  if (!layer) return JSON.stringify({ok:false,error:'no layer'});\n"
        "  var effects = layer.property('ADBE Effect Parade');\n"
        "  if (!effects) return JSON.stringify({ok:false,error:'no effect parade'});\n"
        f"  var fx = effects.addProperty({escaped_name});\n"
        "  if (!fx) return JSON.stringify({ok:false,error:'addProperty returned null'});\n"
        "  return JSON.stringify({ok:true,effectIndex:fx.propertyIndex,effectName:fx.name});\n"
        "})()"
    )


async def _run_apply_effect(args: schemas.AeApplyEffectArgs, ctx: Any) -> Any:
    jsx = _apply_effect_jsx(args.comp_id, args.layer_id, args.effect_match_name)

    async def _call() -> Any:
        out = await bridge.invoke_ae_exec(code=jsx, timeout_sec=30.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.applyEffect..."
    )


register("ae.applyEffect", schemas.AeApplyEffectArgs, _run_apply_effect)


# ---------------------------------------------------------------------------
# v0.7-A: ae.isolateToggle -- forwards to plugin via Invoke-AebmTool default route.
# ---------------------------------------------------------------------------


async def _run_isolate_toggle(args: schemas.AeIsolateToggleArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        # Arguments dict omitted: PS Invoke-AebmTool defaults -Arguments to @{}.
        raw = await bridge.run_ps(
            "Invoke-AebmTool",
            {"Tool": "aebm.isolateToggle"},
            timeout_sec=10.0,
        )
        return _try_json(raw)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=15.0, start_msg="ae.isolateToggle..."
    )


register("ae.isolateToggle", schemas.AeIsolateToggleArgs, _run_isolate_toggle)


# ---------------------------------------------------------------------------
# v0.7-A: ae.toastQuery -- read current toast queue snapshot for assertions.
# ---------------------------------------------------------------------------


async def _run_toast_query(args: schemas.AeToastQueryArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        raw = await bridge.run_ps(
            "Invoke-AebmTool",
            {"Tool": "aebm.toastQuery"},
            timeout_sec=5.0,
        )
        return _try_json(raw)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=8.0, start_msg="ae.toastQuery..."
    )


register("ae.toastQuery", schemas.AeToastQueryArgs, _run_toast_query)
