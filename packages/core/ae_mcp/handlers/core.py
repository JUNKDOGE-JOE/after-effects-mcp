"""Core 9 handlers.

Registers: ae.init, ae.overview, ae.layers, ae.readProps, ae.exec,
ae.checkpoint, ae.revert, ae.snapshot, ae.applyEffect.

Each handler:
  1. validates pydantic args (already done by server.py before dispatch),
  2. calls into _backend().exec() or snapshot.capture_ae_viewer,
  3. parses JSON where possible and returns dict/str.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from string import Template
from typing import Any, Optional

from ae_mcp import checkpoint_store, progress, schemas
from ae_mcp.backends import discovery as _discovery
from ae_mcp.handlers import register

log = logging.getLogger("ae_mcp.handlers.core")


def _backend():
    return _discovery.select_backend()


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
# Checkpoint helpers
# ---------------------------------------------------------------------------

_store = checkpoint_store.CheckpointStore()
_TEMPLATES = Path(__file__).resolve().parent.parent / "jsx_templates"


def _load_jsx(name: str) -> Template:
    return Template((_TEMPLATES / name).read_text(encoding="utf-8"))


async def _resolve_project_path(ctx: Any) -> Optional[str]:
    out = await _backend().exec(
        code=(
            'JSON.stringify({ok:true,'
            'path: app.project.file ? app.project.file.fsName : null})'
        ),
        timeout_sec=10.0,
    )
    parsed = _try_json(out)
    if isinstance(parsed, dict) and parsed.get("ok"):
        return parsed.get("path")
    return None


# ---------------------------------------------------------------------------
# ae.init
# ---------------------------------------------------------------------------


async def _run_init(args: schemas.AeInitArgs, ctx: Any) -> Any:
    tmpl = _load_jsx("init.jsx")
    jsx = tmpl.substitute(refresh_only="true" if args.refresh_only else "false")

    async def _call() -> Any:
        out = await _backend().exec(jsx, timeout_sec=20.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.init..."
    )


register("ae.init", schemas.AeInitArgs, _run_init)


# ---------------------------------------------------------------------------
# ae.overview
# ---------------------------------------------------------------------------


async def _run_overview(args: schemas.AeOverviewArgs, ctx: Any) -> Any:
    tmpl = _load_jsx("overview.jsx")
    jsx = tmpl.substitute()

    async def _call() -> Any:
        out = await _backend().exec(jsx, timeout_sec=15.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=20.0, start_msg="ae.overview..."
    )


register("ae.overview", schemas.AeOverviewArgs, _run_overview)


# ---------------------------------------------------------------------------
# ae.layers
# ---------------------------------------------------------------------------


async def _run_layers(args: schemas.AeLayersArgs, ctx: Any) -> Any:
    from ae_mcp.handlers.typed import _comp_expr  # type: ignore
    tmpl = _load_jsx("get_layers.jsx")
    jsx = tmpl.substitute(comp_expr=_comp_expr(args.comp_id))

    async def _call() -> Any:
        out = await _backend().exec(jsx, timeout_sec=15.0)
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
        out = await _backend().exec(args.code, timeout_sec=20.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=30.0, start_msg="ae.readProps..."
    )


register("ae.readProps", schemas.AeReadPropsArgs, _run_read_props)


# ---------------------------------------------------------------------------
# ae.exec
# ---------------------------------------------------------------------------


async def _run_exec(args: schemas.AeExecArgs, ctx: Any) -> Any:
    backend = _backend()

    async def _call() -> Any:
        checkpoint_skipped: Optional[str] = None
        if args.checkpoint_label and not backend.manages_checkpoints:
            project_path = await _resolve_project_path(ctx)
            if not project_path:
                checkpoint_skipped = "untitled-project"
            else:
                cid = _store.make_id()
                dst = _store.aep_path(project_path, cid)
                dst.parent.mkdir(parents=True, exist_ok=True)
                tmpl = _load_jsx("checkpoint_create.jsx")
                jsx_cp = tmpl.substitute(dst_path=json.dumps(str(dst), ensure_ascii=False))
                try:
                    cp_out = await backend.exec(code=jsx_cp, timeout_sec=60.0)
                    cp_parsed = _try_json(cp_out)
                    if isinstance(cp_parsed, dict) and cp_parsed.get("ok"):
                        if cp_parsed.get("skipped"):
                            checkpoint_skipped = cp_parsed.get("reason") or "skipped"
                        else:
                            _store.write_meta(
                                source_project_path=project_path, cid=cid,
                                label=args.checkpoint_label,
                                active_comp_id=cp_parsed.get("activeCompId"),
                                current_time=float(cp_parsed.get("currentTime") or 0.0),
                                size_bytes=int(cp_parsed.get("sizeBytes") or dst.stat().st_size),
                            )
                            _store.prune(project_path)
                except Exception as e:  # noqa: BLE001
                    log.warning("auto-checkpoint failed: %s", e)
                    checkpoint_skipped = f"checkpoint-failed: {e}"
        elif args.checkpoint_label and backend.manages_checkpoints:
            checkpoint_skipped = "delegated-to-backend"

        # Skip undo wrap if backend already does it
        undo = None if backend.manages_undo else args.undo_group_name

        out = await backend.exec(
            code=args.code,
            undo_group=undo,
            checkpoint_label=args.checkpoint_label if backend.manages_checkpoints else None,
            timeout_sec=float(args.timeout_sec),
        )
        parsed = _try_json(out)
        if isinstance(parsed, dict) and checkpoint_skipped:
            parsed.setdefault("checkpointSkipped", checkpoint_skipped)
        return parsed

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=float(args.timeout_sec) + 70.0, start_msg="ae.exec...",
    )


register("ae.exec", schemas.AeExecArgs, _run_exec)


# ---------------------------------------------------------------------------
# ae.checkpoint (stub)
# ---------------------------------------------------------------------------


async def _run_checkpoint(args: schemas.AeCheckpointArgs, ctx: Any) -> Any:
    if args.action == "list":
        async def _call_list() -> Any:
            project_path = await _resolve_project_path(ctx)
            entries = _store.list_checkpoints(project_path, limit=args.limit)
            return {"ok": True, "checkpoints": entries, "total": len(entries)}
        return await progress.run_with_timeout(
            ctx, _call_list(), timeout_sec=15.0, start_msg="ae.checkpoint list..."
        )

    # action == "create"
    async def _call_create() -> Any:
        project_path = await _resolve_project_path(ctx)
        if not project_path:
            return {
                "ok": True, "skipped": True,
                "reason": "untitled-project", "id": None,
            }
        cid = _store.make_id()
        dst = _store.aep_path(project_path, cid)
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmpl = _load_jsx("checkpoint_create.jsx")
        jsx = tmpl.substitute(dst_path=json.dumps(str(dst), ensure_ascii=False))
        out = await _backend().exec(
            code=jsx,
            undo_group=f"MCP checkpoint: {args.label or cid}",
            timeout_sec=60.0,
        )
        parsed = _try_json(out)
        if not (isinstance(parsed, dict) and parsed.get("ok")):
            return parsed
        if parsed.get("skipped"):
            return parsed  # untitled bubbled up from JSX
        size_bytes = int(parsed.get("sizeBytes") or dst.stat().st_size)
        _store.write_meta(
            source_project_path=project_path,
            cid=cid, label=args.label,
            active_comp_id=parsed.get("activeCompId"),
            current_time=float(parsed.get("currentTime") or 0.0),
            size_bytes=size_bytes,
        )
        _store.prune(project_path)
        return {
            "ok": True, "id": cid, "label": args.label,
            "path": str(dst), "sizeBytes": size_bytes,
        }

    return await progress.run_with_timeout(
        ctx, _call_create(), timeout_sec=70.0, start_msg="ae.checkpoint create..."
    )


register("ae.checkpoint", schemas.AeCheckpointArgs, _run_checkpoint)


# ---------------------------------------------------------------------------
# ae.revert (stub)
# ---------------------------------------------------------------------------


async def _run_revert(args: schemas.AeRevertArgs, ctx: Any) -> Any:
    async def _call() -> Any:
        project_path = await _resolve_project_path(ctx)
        aep = _store.lookup_aep(project_path, args.checkpoint_id)
        if aep is None:
            return {
                "ok": False,
                "reverted": False,
                "error": f"checkpoint not found: {args.checkpoint_id}",
            }
        branched_from = None
        if args.branch_before_revert and project_path:
            # best-effort branch; never block revert on its failure
            try:
                cid = _store.make_id()
                dst = _store.aep_path(project_path, cid)
                dst.parent.mkdir(parents=True, exist_ok=True)
                tmpl = _load_jsx("checkpoint_create.jsx")
                jsx = tmpl.substitute(dst_path=json.dumps(str(dst), ensure_ascii=False))
                out = await _backend().exec(code=jsx, timeout_sec=60.0)
                parsed = _try_json(out)
                if isinstance(parsed, dict) and parsed.get("ok") and not parsed.get("skipped"):
                    _store.write_meta(
                        source_project_path=project_path, cid=cid,
                        label=f"before-revert-{args.checkpoint_id[:8]}",
                        active_comp_id=parsed.get("activeCompId"),
                        current_time=float(parsed.get("currentTime") or 0.0),
                        size_bytes=int(parsed.get("sizeBytes") or dst.stat().st_size),
                    )
                    branched_from = cid
            except Exception as e:  # noqa: BLE001
                log.warning("branch_before_revert failed: %s", e)
        tmpl = _load_jsx("revert.jsx")
        jsx = tmpl.substitute(aep_path=json.dumps(aep.as_posix(), ensure_ascii=False))
        out = await _backend().exec(code=jsx, timeout_sec=60.0)
        parsed = _try_json(out)
        if isinstance(parsed, dict) and parsed.get("ok"):
            parsed["branchedFromId"] = branched_from
        return parsed

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=80.0, start_msg="ae.revert..."
    )


register("ae.revert", schemas.AeRevertArgs, _run_revert)


# ---------------------------------------------------------------------------
# ae.snapshot — direct ctypes, no pwsh subprocess.
# ---------------------------------------------------------------------------


async def _run_snapshot(args: schemas.AeSnapshotArgs, ctx: Any) -> Any:
    try:
        from ae_mcp import snapshot as snap
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
        out = await _backend().exec(code=jsx, timeout_sec=30.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=40.0, start_msg="ae.applyEffect..."
    )


register("ae.applyEffect", schemas.AeApplyEffectArgs, _run_apply_effect)


# ---------------------------------------------------------------------------
# v0.7-A: ae.isolateToggle — JSX-based fallback (AEBM backend routes via marker fn)
# ---------------------------------------------------------------------------


async def _run_isolate_toggle(args: schemas.AeIsolateToggleArgs, ctx: Any) -> Any:
    # JSX is a marker the AEBM backend recognizes and routes to its
    # plugin-specific Invoke-AebmTool. Other backends just see normal JSX
    # and either fall back or report unsupported.
    jsx = (
        '(function(){'
        'if (typeof __aebm_isolate_toggle__ === "function") {'
        '  return JSON.stringify(__aebm_isolate_toggle__());'
        '}'
        'return JSON.stringify({ok:false,error:"isolateToggle requires AEBM backend"});'
        '})()'
    )

    async def _call():
        return _try_json(await _backend().exec(jsx, timeout_sec=10.0))

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=15.0, start_msg="ae.isolateToggle..."
    )


register("ae.isolateToggle", schemas.AeIsolateToggleArgs, _run_isolate_toggle)


# ---------------------------------------------------------------------------
# v0.7-A: ae.toastQuery — read current toast queue snapshot for assertions.
# ---------------------------------------------------------------------------


async def _run_toast_query(args: schemas.AeToastQueryArgs, ctx: Any) -> Any:
    jsx = (
        '(function(){'
        'if (typeof __aebm_toast_query__ === "function") {'
        '  return JSON.stringify(__aebm_toast_query__());'
        '}'
        'return JSON.stringify({ok:false,error:"toastQuery requires AEBM backend"});'
        '})()'
    )

    async def _call():
        return _try_json(await _backend().exec(jsx, timeout_sec=5.0))

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=8.0, start_msg="ae.toastQuery..."
    )


register("ae.toastQuery", schemas.AeToastQueryArgs, _run_toast_query)


# ---------------------------------------------------------------------------
# ae.ping — handshake smoke test for live diagnostics
# ---------------------------------------------------------------------------

from functools import lru_cache as _lru_cache
from pathlib import Path as _Path
from string import Template as _Template

_PING_TEMPLATE_PATH = _Path(__file__).resolve().parent.parent / "jsx_templates" / "ping.jsx"


@_lru_cache(maxsize=1)
def _ping_template() -> _Template:
    return _Template(_PING_TEMPLATE_PATH.read_text(encoding="utf-8"))


async def _run_ping(args: schemas.AePingArgs, ctx: Any) -> Any:
    jsx = _ping_template().substitute(expect=json.dumps(args.expect, ensure_ascii=False))

    async def _call() -> Any:
        out = await _backend().exec(code=jsx, timeout_sec=10.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=15.0, start_msg="ae.ping..."
    )


register("ae.ping", schemas.AePingArgs, _run_ping)
