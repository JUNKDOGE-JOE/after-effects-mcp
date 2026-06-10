"""Core 9 handlers.

Registers: ae.init, ae.overview, ae.layers, ae.readProps, ae.exec,
ae.checkpoint, ae.revert, ae.snapshot, ae.applyEffect.

Each handler:
  1. validates pydantic args (already done by server.py before dispatch),
  2. calls into _backend().exec() or snapshot.capture_ae_viewer,
  3. parses JSON where possible and returns dict/str.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shutil
import tempfile
import uuid
from functools import lru_cache
from pathlib import Path
from string import Template
from typing import Any, Optional

from ae_mcp import checkpoint_store, progress, render_text, schemas
from ae_mcp.backends import discovery as _discovery
from ae_mcp.handlers import register
from ae_mcp.jsx_prelude import with_prelude
from ae_mcp.jsx_result import parse_jsx_result as _try_json

log = logging.getLogger("ae_mcp.handlers.core")


def _backend():
    return _discovery.select_backend()


# ---------------------------------------------------------------------------
# Checkpoint helpers
# ---------------------------------------------------------------------------

_store = checkpoint_store.CheckpointStore()
_TEMPLATES = Path(__file__).resolve().parent.parent / "jsx_templates"
_PREVIEW_SESSION_ID = uuid.uuid4().hex[:10]


def _load_jsx(name: str) -> Template:
    return Template((_TEMPLATES / name).read_text(encoding="utf-8"))


def _ensure_checkpoint_file(project_path: str, dst: Path, parsed: dict[str, Any]) -> int | None:
    size = int(parsed.get("sizeBytes") or 0)
    if dst.exists() and size > 0:
        return max(size, dst.stat().st_size)

    src = Path(project_path)
    if src.exists():
        shutil.copy2(src, dst)

    if not dst.exists():
        return None
    return dst.stat().st_size


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


def _atomic_replace(src_aep: Path, dst_path: str) -> None:
    """Copy `src_aep` onto `dst_path` atomically.

    Copy to a sibling temp file on the SAME directory/volume as the
    destination so os.replace is a true atomic rename (cross-volume
    os.replace raises). This guarantees the destination is never left
    half-written: on success it is the full checkpoint; on any failure it
    is untouched. Raises on failure (caller handles recovery).
    """
    dst = Path(dst_path)
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{dst.stem}.", suffix=".aep.tmp", dir=str(dst.parent)
    )
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        shutil.copyfile(src_aep, tmp)
        os.replace(tmp, dst)
    except BaseException:
        # Clean up the partial temp file; the destination is untouched.
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# ae.init
# ---------------------------------------------------------------------------


async def _run_init(args: schemas.AeInitArgs, ctx: Any) -> Any:
    tmpl = _load_jsx("init.jsx")
    jsx = with_prelude(
        tmpl.substitute(refresh_only="true" if args.refresh_only else "false")
    )

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
    jsx = with_prelude(tmpl.substitute())

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
    jsx = with_prelude(tmpl.substitute(
        comp_expr=_comp_expr(args.comp_id),
        offset=int(args.offset),
        limit=int(args.limit),
    ))

    async def _call() -> Any:
        out = await _backend().exec(jsx, timeout_sec=15.0)
        parsed = _try_json(out)
        return render_text.maybe_render(parsed, args.format, render_text.render_layers)

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
            # Auto-checkpoint is strictly best-effort: a hung path probe, an
            # unwritable store dir, or a failed snapshot must NEVER abort the
            # user's edit. The whole block is guarded so any failure degrades
            # to a `checkpointSkipped` note while the edit still runs. The
            # probe is time-bounded so a dead bridge can't stall indefinitely.
            try:
                project_path = await asyncio.wait_for(
                    _resolve_project_path(ctx), timeout=15.0
                )
                if not project_path:
                    checkpoint_skipped = "untitled-project"
                else:
                    cid = _store.make_id()
                    dst = _store.aep_path(project_path, cid)
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    tmpl = _load_jsx("checkpoint_create.jsx")
                    jsx_cp = with_prelude(
                        tmpl.substitute(dst_path=json.dumps(str(dst), ensure_ascii=False))
                    )
                    cp_out = await backend.exec(code=jsx_cp, timeout_sec=60.0)
                    cp_parsed = _try_json(cp_out)
                    if isinstance(cp_parsed, dict) and cp_parsed.get("ok"):
                        if cp_parsed.get("skipped"):
                            checkpoint_skipped = cp_parsed.get("reason") or "skipped"
                        else:
                            size_bytes = _ensure_checkpoint_file(project_path, dst, cp_parsed)
                            if size_bytes is None:
                                checkpoint_skipped = "checkpoint-file-missing"
                            else:
                                _store.write_meta(
                                    source_project_path=project_path, cid=cid,
                                    label=args.checkpoint_label,
                                    active_comp_id=cp_parsed.get("activeCompId"),
                                    current_time=float(cp_parsed.get("currentTime") or 0.0),
                                    size_bytes=size_bytes,
                                )
                                _store.prune(project_path)
                    else:
                        checkpoint_skipped = "checkpoint-failed: bad-result"
            except asyncio.TimeoutError:
                log.warning("auto-checkpoint timed out")
                checkpoint_skipped = "checkpoint-timeout"
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
        jsx = with_prelude(
            tmpl.substitute(dst_path=json.dumps(str(dst), ensure_ascii=False))
        )
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
        size_bytes = _ensure_checkpoint_file(project_path, dst, parsed)
        if size_bytes is None:
            return {
                "ok": False,
                "error": "checkpoint file missing after AE copy",
                "path": str(dst),
                "backendResult": parsed,
            }
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
        # Preserve the original "checkpoint .aep missing" guard.
        if not aep.exists():
            return {
                "ok": False,
                "reverted": False,
                "error": f"checkpoint .aep missing: {aep}",
            }

        # An untitled project has no on-disk path to restore over. Opening
        # the temp copy in place would make %TEMP% the live project (the
        # exact data-loss bug we are fixing), so refuse instead.
        if not project_path:
            return {
                "ok": False,
                "reverted": False,
                "error": (
                    "cannot revert an unsaved/untitled project; save it "
                    "first so there is a path to restore"
                ),
            }

        branched_from = None
        if args.branch_before_revert:
            branched_from = await _branch_snapshot(project_path, args.checkpoint_id)

        # Step 1: close the current project with NO save (releases file handle).
        close_tmpl = _load_jsx("revert_close.jsx")
        close_out = await _backend().exec(code=close_tmpl.substitute(), timeout_sec=60.0)
        close_parsed = _try_json(close_out)
        if not (isinstance(close_parsed, dict) and close_parsed.get("ok")):
            # Close failed — do NOT touch the original file; nothing was changed.
            err = (close_parsed or {}).get("error") if isinstance(close_parsed, dict) else None
            return {
                "ok": False,
                "reverted": False,
                "error": f"revert aborted: close failed: {err or close_out}",
                "branchedFromId": branched_from,
            }

        # Step 2 (Python): atomically copy the checkpoint .aep over the
        # original project path. os.replace is atomic, so the original is
        # never left half-written.
        try:
            _atomic_replace(aep, project_path)
        except Exception as e:  # noqa: BLE001
            log.warning("revert restore-copy failed: %s", e)
            # The original on disk is intact (we only did close-no-save and
            # the replace is atomic). Reopen it so the user is never left
            # with no project.
            open_tmpl = _load_jsx("revert_open.jsx")
            reopen_jsx = open_tmpl.substitute(
                aep_path=json.dumps(Path(project_path).as_posix(), ensure_ascii=False)
            )
            reopened = _try_json(await _backend().exec(code=reopen_jsx, timeout_sec=60.0))
            recovered = bool(isinstance(reopened, dict) and reopened.get("ok"))
            return {
                "ok": False,
                "reverted": False,
                "error": f"revert failed during restore: {e}",
                "recoveredOriginal": recovered,
                "branchedFromId": branched_from,
            }

        # Step 3: reopen the (now restored) ORIGINAL project and verify path.
        open_tmpl = _load_jsx("revert_open.jsx")
        open_jsx = open_tmpl.substitute(
            aep_path=json.dumps(Path(project_path).as_posix(), ensure_ascii=False)
        )
        open_parsed = _try_json(await _backend().exec(code=open_jsx, timeout_sec=60.0))
        if not (isinstance(open_parsed, dict) and open_parsed.get("ok")):
            err = (open_parsed or {}).get("error") if isinstance(open_parsed, dict) else None
            return {
                "ok": False,
                "reverted": True,  # file WAS restored on disk; only reopen failed
                "error": f"checkpoint restored but reopen failed: {err or open_parsed}",
                "branchedFromId": branched_from,
            }

        return {
            "ok": True,
            "reverted": True,
            "openedPath": open_parsed.get("openedPath"),
            "restoredTo": project_path,
            "branchedFromId": branched_from,
        }

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=200.0, start_msg="ae.revert..."
    )


async def _branch_snapshot(project_path: str, checkpoint_id: str) -> Optional[str]:
    """Best-effort 'before-revert' checkpoint. Never blocks revert on failure."""
    try:
        cid = _store.make_id()
        dst = _store.aep_path(project_path, cid)
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmpl = _load_jsx("checkpoint_create.jsx")
        jsx = with_prelude(
            tmpl.substitute(dst_path=json.dumps(str(dst), ensure_ascii=False))
        )
        out = await _backend().exec(code=jsx, timeout_sec=60.0)
        parsed = _try_json(out)
        if isinstance(parsed, dict) and parsed.get("ok") and not parsed.get("skipped"):
            _store.write_meta(
                source_project_path=project_path, cid=cid,
                label=f"before-revert-{checkpoint_id[:8]}",
                active_comp_id=parsed.get("activeCompId"),
                current_time=float(parsed.get("currentTime") or 0.0),
                size_bytes=_ensure_checkpoint_file(project_path, dst, parsed) or 0,
            )
            return cid
    except Exception as e:  # noqa: BLE001
        log.warning("branch_before_revert failed: %s", e)
    return None


register("ae.revert", schemas.AeRevertArgs, _run_revert)


# ---------------------------------------------------------------------------
# ae.snapshot — direct ctypes, no pwsh subprocess.
# ---------------------------------------------------------------------------


async def _run_snapshot(args: schemas.AeSnapshotArgs, ctx: Any) -> Any:
    from ae_mcp.snapshot import discovery as _snap_discovery
    snapper = _snap_discovery.select_snapshotter()
    if snapper is None:
        return {"ok": False, "error":
                "no snapshotter installed (try `pip install ae-mcp-snapshot-mss`)"}
    try:
        from pathlib import Path
        out_path = Path(args.out_path) if args.out_path else None
        return await snapper.capture(
            out_path,
            hwnd=args.hwnd,
            main_window=args.main_window,
            method=args.method,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("ae.snapshot failed")
        return {"ok": False, "error": str(e)}


register("ae.snapshot", schemas.AeSnapshotArgs, _run_snapshot)


# ---------------------------------------------------------------------------
# ae.previewFrame — fast viewer capture, not a real render.
# ---------------------------------------------------------------------------


def _default_preview_dir() -> Path:
    return Path(tempfile.gettempdir()) / "ae_mcp_previews" / _PREVIEW_SESSION_ID


def _preview_frame_requests(args: schemas.AePreviewFrameArgs, out_dir: Path) -> list[dict[str, Any]]:
    raw_times: list[float | None]
    if args.times is not None:
        raw_times = list(args.times)
    elif args.time is not None:
        raw_times = [args.time]
    else:
        raw_times = [None]

    comp_part = args.comp_id or "active"
    call_id = uuid.uuid4().hex[:8]
    requests: list[dict[str, Any]] = []
    for index, frame_time in enumerate(raw_times):
        if frame_time is None:
            stem = f"{comp_part}_current_{index}_{call_id}"
        else:
            stem = f"{comp_part}_{frame_time:.6f}_{index}_{call_id}".replace(".", "_")
        safe_stem = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in stem)
        requests.append({
            "time": frame_time,
            "path": str(out_dir / f"{safe_stem}.png"),
        })
    return requests


def _attach_preview_file_data(parsed: dict[str, Any], include_base64: bool) -> dict[str, Any]:
    frames = parsed.get("frames")
    if not isinstance(frames, list):
        return parsed

    for frame in frames:
        if not isinstance(frame, dict):
            continue
        path_value = frame.get("path")
        if not isinstance(path_value, str):
            continue
        p = Path(path_value)
        if p.exists():
            frame["sizeBytes"] = p.stat().st_size
            if include_base64:
                frame["base64"] = base64.b64encode(p.read_bytes()).decode("ascii")
    return parsed


def _downscale_png(path: Path, scale: float) -> Optional[tuple[int, int]]:
    """Resample the PNG at `path` in place by `scale` (0<scale, !=1.0).

    Returns the new (width, height), or None if no resize was applied (scale
    ~1.0 or the result would be degenerate). Uses Pillow, a declared core
    dependency. Never raises into the caller — on failure the original file is
    left untouched and None is returned.
    """
    if scale <= 0 or abs(scale - 1.0) < 1e-9:
        return None
    try:
        from PIL import Image

        with Image.open(path) as im:
            new_w = max(1, int(round(im.width * scale)))
            new_h = max(1, int(round(im.height * scale)))
            if (new_w, new_h) == (im.width, im.height):
                return None
            resized = im.resize((new_w, new_h), Image.LANCZOS)
        resized.save(path, "PNG")
        return (new_w, new_h)
    except Exception:  # noqa: BLE001
        log.debug("preview downscale failed for %s", path, exc_info=True)
        return None


async def _run_preview_frame(args: schemas.AePreviewFrameArgs, ctx: Any) -> Any:
    from ae_mcp.handlers.typed import _comp_expr  # type: ignore
    from ae_mcp.snapshot import discovery as _snap_discovery

    snapper = _snap_discovery.select_snapshotter()
    if snapper is None:
        return {"ok": False, "error": "no snapshotter installed (try `pip install ae-mcp-snapshot-mss`)"}

    out_dir = Path(args.out_dir) if args.out_dir else _default_preview_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    frame_requests = _preview_frame_requests(args, out_dir)
    tmpl = _load_jsx("preview_viewer.jsx")

    async def _call() -> Any:
        frames: list[dict[str, Any]] = []
        comp_id: str | None = None
        comp_name: str | None = None

        for frame_request in frame_requests:
            jsx = with_prelude(tmpl.substitute(
                comp_expr=_comp_expr(args.comp_id),
                time=json.dumps(frame_request["time"]),
            ))
            out = await _backend().exec(code=jsx, timeout_sec=15.0)
            prepared = _try_json(out)
            if not isinstance(prepared, dict) or not prepared.get("ok"):
                return prepared

            # Yield to AE's main thread so the viewer can repaint at the new
            # comp.time before we screen-grab. Without this we capture the
            # stale viewer (the JSX returned before AE drew anything new).
            if args.repaint_delay_ms > 0:
                await asyncio.sleep(args.repaint_delay_ms / 1000.0)

            snap = await snapper.capture(
                Path(frame_request["path"]),
                main_window=True,
                method="ViewerCapture",
            )
            if not snap.get("ok"):
                return snap

            comp_id = str(prepared.get("compId"))
            comp_name = prepared.get("compName")
            # Apply the requested output scale to the captured PNG (in place).
            frame_w = snap.get("width")
            frame_h = snap.get("height")
            snap_path = snap.get("path")
            if snap_path:
                new_dims = _downscale_png(Path(str(snap_path)), args.scale)
                if new_dims is not None:
                    frame_w, frame_h = new_dims
            frame = {
                "time": prepared.get("time"),
                "path": snap_path,
                "width": frame_w,
                "height": frame_h,
                "sizeBytes": (
                    Path(str(snap_path)).stat().st_size
                    if snap_path and Path(str(snap_path)).exists()
                    else snap.get("bytes")
                ),
                "source": "viewer",
                "method": snap.get("method"),
                "compId": comp_id,
            }
            if args.include_base64 and frame["path"]:
                p = Path(str(frame["path"]))
                if p.exists():
                    frame["base64"] = base64.b64encode(p.read_bytes()).decode("ascii")
            frames.append(frame)

        return {
            "ok": True,
            "compId": comp_id,
            "compName": comp_name,
            "frames": frames,
        }

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=60.0, start_msg="ae.previewFrame..."
    )


register("ae.previewFrame", schemas.AePreviewFrameArgs, _run_preview_frame)


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
        f"AEMCP.compById({int(comp_id)})"
        if comp_id else
        "AEMCP.activeComp()"
    )
    return with_prelude(
        "(function(){\n"
        f"  var comp = {comp_expr};\n"
        "  if (!comp) return JSON.stringify({ok:false,error:'no comp'});\n"
        f"  var layer = AEMCP.layerById(comp, {int(layer_id)});\n"
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
# ae.ping — handshake smoke test for live diagnostics
# ---------------------------------------------------------------------------

_PING_TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "jsx_templates" / "ping.jsx"


@lru_cache(maxsize=1)
def _ping_template() -> Template:
    return Template(_PING_TEMPLATE_PATH.read_text(encoding="utf-8"))


async def _run_ping(args: schemas.AePingArgs, ctx: Any) -> Any:
    jsx = with_prelude(
        _ping_template().substitute(expect=json.dumps(args.expect, ensure_ascii=False))
    )

    async def _call() -> Any:
        out = await _backend().exec(code=jsx, timeout_sec=10.0)
        return _try_json(out)

    return await progress.run_with_timeout(
        ctx, _call(), timeout_sec=15.0, start_msg="ae.ping..."
    )


register("ae.ping", schemas.AePingArgs, _run_ping)
