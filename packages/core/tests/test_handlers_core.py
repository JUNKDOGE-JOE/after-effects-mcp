"""Core handler behaviour (against mock backend)."""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path

import pytest
from pydantic import ValidationError

from ae_mcp import schemas as S
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import core as core_handlers
from ae_mcp.handlers.core import _run_ping


async def _never_written(*_args, **_kwargs):
    """Stand in for a capture whose file never becomes a complete PNG."""
    return None


@pytest.fixture(autouse=True)
def _load():
    load_all()


@pytest.mark.asyncio
async def test_exec_forwards_all_args(mock_backend):
    # With checkpoint_label set, _run_exec first calls backend.exec for the
    # path probe (returns untitled project), then calls backend.exec for
    # the actual user code.
    responses = iter([
        json.dumps({"ok": True, "path": None}),   # path probe -> untitled, skip checkpoint
        json.dumps({"ok": True}),                  # user code
    ])
    mock_backend.set_response(lambda **kw: next(responses))
    _, run_fn = HANDLERS["ae.exec"]
    args = S.AeExecArgs(
        code="JSON.stringify({a:1})",
        undo_group_name="unit",
        checkpoint_label="t1",
        timeout_sec=60,
    )
    result = await run_fn(args, None)
    # Find the call that ran the user code
    user_call = next(
        c for c in mock_backend.calls
        if c["code"] == "JSON.stringify({a:1})"
    )
    assert user_call["code"] == "JSON.stringify({a:1})"
    assert user_call["undo_group"] == "unit"
    # checkpoint_label is None in exec call because backend.manages_checkpoints is False
    assert user_call["checkpoint_label"] is None
    assert user_call["timeout_sec"] == 60.0


@pytest.mark.asyncio
async def test_snapshot_error_on_no_snapshotter(monkeypatch):
    """When no snapshotter is installed, handler returns a clean error."""
    from unittest.mock import patch
    _, run_fn = HANDLERS["ae.snapshot"]
    with patch("ae_mcp.snapshot.discovery._scan_entry_points", return_value={}):
        result = await run_fn(S.AeSnapshotArgs(), None)
    assert result["ok"] is False
    assert "snapshotter" in result["error"]


class _FakeSnapshotter:
    async def capture(self, out_path, *, hwnd=None, main_window=False, method="auto"):
        out_path.write_bytes(b"png-bytes")
        return {
            "ok": True,
            "path": str(out_path),
            "bytes": out_path.stat().st_size,
            "width": 800,
            "height": 600,
            "hwnd": hwnd,
            "method": method,
            "mainWindow": main_window,
        }


@pytest.mark.asyncio
async def test_preview_frame_saves_comp_frame_without_snapshotter(monkeypatch, mock_backend, tmp_path):
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    def _render_response(code, **kwargs):
        import re
        from PIL import Image

        match = re.search(r"new File\((\".*?\")\)", code)
        assert match, code
        path = Path(json.loads(match.group(1)))
        Image.new("RGB", (160, 90), (30, 40, 50)).save(path, "PNG")
        return json.dumps({
            "ok": True,
            "compId": "7",
            "compName": "Preview",
            "time": 0.5,
            "path": str(path),
            "width": 160,
            "height": 90,
            "source": "comp",
            "method": "saveFrameToPng",
        })

    mock_backend.set_response(_render_response)

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(comp_id="7", time=0.5, out_dir=str(tmp_path)),
        None,
    )

    assert result["ok"] is True
    assert result["compId"] == "7"
    assert len(result["captureId"]) == 32
    frame = result["frames"][0]
    assert frame["path"]
    assert frame["width"] == 160
    assert frame["height"] == 90
    assert frame["source"] == "comp"
    assert frame["method"] == "saveFrameToPng"
    assert Path(frame["path"]).exists()
    assert frame["sha256"] == hashlib.sha256(Path(frame["path"]).read_bytes()).hexdigest()
    jsx = mock_backend.calls[-1]["code"]
    assert "saveFrameToPng" in jsx
    assert "openInViewer" in jsx
    assert "AEMCP.compById(7)" in jsx


def test_preview_cleanup_prunes_only_stale_session_dirs(tmp_path):
    import os
    from ae_mcp.handlers import core as core_handlers

    root = tmp_path / "ae_mcp_previews"
    stale = root / "old-session"
    fresh = root / "fresh-session"
    current = root / "current-session"
    loose = root / "loose.png"
    for directory in [stale, fresh, current]:
        directory.mkdir(parents=True)
        (directory / "frame.png").write_bytes(b"png")
    loose.write_bytes(b"png")

    now = time.time()
    old = now - (49 * 60 * 60)
    recent = now - (2 * 60 * 60)
    os.utime(stale / "frame.png", (old, old))
    os.utime(stale, (old, old))
    os.utime(fresh / "frame.png", (recent, recent))
    os.utime(fresh, (recent, recent))
    os.utime(current / "frame.png", (old, old))
    os.utime(current, (old, old))

    removed = core_handlers._cleanup_old_preview_sessions(
        root=root,
        current_session_id="current-session",
        older_than_sec=24 * 60 * 60,
        now=now,
    )

    assert removed == 1
    assert not stale.exists()
    assert fresh.exists()
    assert current.exists()
    assert loose.exists()


@pytest.mark.asyncio
async def test_preview_frame_waits_for_async_save_frame(monkeypatch, mock_backend, tmp_path):
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    def _render_response(code, **kwargs):
        import re
        import threading
        from PIL import Image

        match = re.search(r"new File\((\".*?\")\)", code)
        path = Path(json.loads(match.group(1)))

        def _write_later():
            Image.new("RGB", (96, 54), (9, 8, 7)).save(path, "PNG")

        threading.Timer(0.05, _write_later).start()
        return json.dumps({
            "ok": True,
            "compId": "7",
            "compName": "Preview",
            "time": 0.5,
            "path": str(path),
            "width": 96,
            "height": 54,
            "source": "comp",
            "method": "saveFrameToPng",
        })

    mock_backend.set_response(_render_response)

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(comp_id="7", time=0.5, out_dir=str(tmp_path)),
        None,
    )

    assert result["ok"] is True
    assert result["frames"][0]["source"] == "comp"
    assert Path(result["frames"][0]["path"]).exists()


@pytest.mark.asyncio
async def test_preview_frame_falls_back_to_viewer_snapshot(monkeypatch, mock_backend, tmp_path):
    monkeypatch.setattr(
        "ae_mcp.snapshot.discovery.select_snapshotter",
        lambda: _FakeSnapshotter(),
    )
    mock_backend.set_response(json.dumps({
        "ok": True,
        "compId": "7",
        "compName": "Preview",
        "time": 0.5,
        "source": "viewer",
        "method": "ViewerCapture",
        "fallbackReason": "saveFrameToPng unavailable",
    }))

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(comp_id="7", time=0.5, out_dir=str(tmp_path)),
        None,
    )

    assert result["ok"] is True
    assert result["compId"] == "7"
    assert result["frames"][0]["sizeBytes"] == len(b"png-bytes")
    assert result["frames"][0]["width"] == 800
    assert result["frames"][0]["source"] == "viewer"
    jsx = mock_backend.calls[-1]["code"]
    assert "saveFrameToPng" in jsx
    assert "openInViewer" in jsx
    assert "AEMCP.compById(7)" in jsx


@pytest.mark.asyncio
async def test_preview_frame_can_attach_base64(monkeypatch, mock_backend, tmp_path):
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    def _render_response(code, **kwargs):
        import re
        from PIL import Image

        match = re.search(r"new File\((\".*?\")\)", code)
        path = Path(json.loads(match.group(1)))
        Image.new("RGB", (32, 18), (1, 2, 3)).save(path, "PNG")
        return json.dumps({
            "ok": True,
            "compId": "active",
            "compName": "Preview",
            "time": 0,
            "path": str(path),
            "width": 32,
            "height": 18,
            "source": "comp",
            "method": "saveFrameToPng",
        })

    mock_backend.set_response(_render_response)

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(out_dir=str(tmp_path), include_base64=True),
        None,
    )

    assert result["frames"][0]["sizeBytes"] > 0
    assert result["frames"][0]["base64"]


@pytest.mark.asyncio
async def test_preview_frame_errors_without_snapshotter(monkeypatch, mock_backend, tmp_path):
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)
    mock_backend.set_response(json.dumps({
        "ok": True,
        "compId": "active",
        "compName": "Preview",
        "time": 0,
        "source": "viewer",
        "method": "ViewerCapture",
        "fallbackReason": "saveFrameToPng unavailable",
    }))
    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(S.AePreviewFrameArgs(out_dir=str(tmp_path)), None)
    assert result["ok"] is False
    assert "snapshotter" in result["error"]


class _RealPngSnapshotter:
    """Writes an actual decodable PNG so the scale/downscale path runs."""

    def __init__(self, w=800, h=600):
        self.w, self.h = w, h

    async def capture(self, out_path, *, hwnd=None, main_window=False, method="auto"):
        from PIL import Image

        Image.new("RGB", (self.w, self.h), (10, 20, 30)).save(out_path, "PNG")
        return {
            "ok": True,
            "path": str(out_path),
            "bytes": out_path.stat().st_size,
            "width": self.w,
            "height": self.h,
            "hwnd": hwnd,
            "method": method,
        }


def test_downscale_png_halves_dimensions(tmp_path):
    from PIL import Image

    from ae_mcp.handlers.core import _downscale_png

    p = tmp_path / "f.png"
    Image.new("RGB", (800, 600), (1, 2, 3)).save(p, "PNG")
    dims = _downscale_png(p, 0.5)
    assert dims == (400, 300)
    with Image.open(p) as im:
        assert (im.width, im.height) == (400, 300)


def test_downscale_png_noop_at_unit_scale(tmp_path):
    from PIL import Image

    from ae_mcp.handlers.core import _downscale_png

    p = tmp_path / "f.png"
    Image.new("RGB", (640, 480), (1, 2, 3)).save(p, "PNG")
    assert _downscale_png(p, 1.0) is None
    with Image.open(p) as im:
        assert (im.width, im.height) == (640, 480)


@pytest.mark.asyncio
async def test_preview_frame_honors_scale(monkeypatch, mock_backend, tmp_path):
    """scale=0.5 must return a frame whose reported and on-disk dimensions are
    half the native capture size (Item 3: scale was previously ignored)."""
    monkeypatch.setattr(
        "ae_mcp.snapshot.discovery.select_snapshotter",
        lambda: _RealPngSnapshotter(800, 600),
    )
    mock_backend.set_response(json.dumps({
        "ok": True, "compId": "7", "compName": "Preview", "time": 0.0,
    }))

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(comp_id="7", time=0.0, out_dir=str(tmp_path), scale=0.5),
        None,
    )

    assert result["ok"] is True
    frame = result["frames"][0]
    assert frame["width"] == 400
    assert frame["height"] == 300
    from PIL import Image
    with Image.open(frame["path"]) as im:
        assert (im.width, im.height) == (400, 300)


@pytest.mark.asyncio
async def test_preview_frame_native_size_when_scale_default(monkeypatch, mock_backend, tmp_path):
    monkeypatch.setattr(
        "ae_mcp.snapshot.discovery.select_snapshotter",
        lambda: _RealPngSnapshotter(800, 600),
    )
    mock_backend.set_response(json.dumps({
        "ok": True, "compId": "7", "compName": "Preview", "time": 0.0,
    }))

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(comp_id="7", time=0.0, out_dir=str(tmp_path)),
        None,
    )
    frame = result["frames"][0]
    assert frame["width"] == 800
    assert frame["height"] == 600


@pytest.mark.asyncio
async def test_validate_expressions_builds_jsx_and_reports_invalid(mock_backend):
    mock_backend.set_response(json.dumps({
        "ok": True,
        "valid": False,
        "checked": 1,
        "errors": [{
            "layerId": 1,
            "propPath": "Text/Source Text",
            "expressionError": "bad slider reference",
        }],
    }))
    from ae_mcp.handlers.typed import _run_validate_expressions

    result = await _run_validate_expressions(
        S.AeValidateExpressionsArgs(comp_id="12", layer_ids=[1], sample_times=[0, 1]),
        None,
    )
    assert result["valid"] is False
    assert result["errors"][0]["expressionError"] == "bad slider reference"
    jsx = mock_backend.calls[-1]["code"]
    assert "AEMCP.compById(12)" in jsx
    assert "[0.0, 1.0]" in jsx


@pytest.mark.asyncio
async def test_ae_ping_default(mock_backend):
    mock_backend.set_response(
        json.dumps({"ok": True, "pong": "pong", "aeVersion": "26.0", "latencyMs": 5}),
    )
    args = S.AePingArgs()
    result = await _run_ping(args, ctx=None)
    assert result["ok"] is True
    assert result["pong"] == "pong"


@pytest.mark.asyncio
async def test_ae_ping_custom(mock_backend):
    mock_backend.set_response(
        json.dumps({"ok": True, "pong": "hello", "aeVersion": "26.0", "latencyMs": 4}),
    )
    args = S.AePingArgs(expect="hello")
    result = await _run_ping(args, ctx=None)
    assert result["pong"] == "hello"
    # Verify the JSX sent included the expected token
    sent_kwargs = mock_backend.calls[-1]
    assert "hello" in sent_kwargs["code"]


# ---------------------------------------------------------------------------
# ae.checkpoint — real implementation tests (Task 3.4)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_checkpoint_list_default_returns_disk_entries(mock_backend, tmp_path, monkeypatch):
    # Force checkpoint_store root to tmp_path
    from ae_mcp import checkpoint_store, handlers
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    # Pre-populate one fake checkpoint for "MyProject"
    d = store._dir_for("C:/MyProject.aep")
    d.mkdir(parents=True, exist_ok=True)
    (d / "abc_x.aep").write_bytes(b"\x00" * 1024)
    store.write_meta(
        source_project_path="C:/MyProject.aep",
        cid="abc_x", label="seed", active_comp_id="12",
        current_time=0.0, size_bytes=1024,
    )

    # Mock the backend call that fetches current project path
    mock_backend.set_response(
        json.dumps({"ok": True, "path": "C:/MyProject.aep"}),
    )

    from ae_mcp.handlers.core import _run_checkpoint
    args = S.AeCheckpointArgs(action="list", limit=10)
    result = await _run_checkpoint(args, ctx=None)

    assert result["ok"] is True
    assert len(result["checkpoints"]) == 1
    assert result["checkpoints"][0]["id"] == "abc_x"
    assert result["checkpoints"][0]["label"] == "seed"


@pytest.mark.asyncio
async def test_checkpoint_create_writes_meta(mock_backend, tmp_path, monkeypatch):
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    # Prepare the .aep that the JSX claims to have written.
    d = store._dir_for("C:/Foo.aep")
    d.mkdir(parents=True, exist_ok=True)
    # The handler will deterministically produce the id; we patch make_id.
    monkeypatch.setattr(store, "make_id", lambda: "fixed_id")
    (d / "fixed_id.aep").write_bytes(b"\x00" * 4096)

    # Mock the backend: first call resolves current project path; second
    # call runs the checkpoint_create JSX and returns saved metadata.
    responses = iter([
        json.dumps({"ok": True, "path": "C:/Foo.aep"}),
        json.dumps({
            "ok": True, "sourceProjectPath": "C:/Foo.aep",
            "savedTo": str(tmp_path / "Foo" / "fixed_id.aep"),
            "sizeBytes": 4096, "activeCompId": "1",
            "currentTime": 0.0
        }),
    ])
    mock_backend.set_response(lambda **kw: next(responses))

    from ae_mcp.handlers.core import _run_checkpoint
    args = S.AeCheckpointArgs(action="create", label="label-A")
    result = await _run_checkpoint(args, ctx=None)

    assert result["ok"] is True
    assert result["id"] == "fixed_id"
    assert result["label"] == "label-A"
    # Meta sidecar exists
    assert (d / "fixed_id.json").exists()


@pytest.mark.asyncio
async def test_checkpoint_create_untitled_skipped(mock_backend, tmp_path, monkeypatch):
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    responses = iter([
        json.dumps({"ok": True, "path": None}),  # untitled
    ])
    mock_backend.set_response(lambda **kw: next(responses))

    from ae_mcp.handlers.core import _run_checkpoint
    args = S.AeCheckpointArgs(action="create", label="x")
    result = await _run_checkpoint(args, ctx=None)

    assert result["ok"] is True
    assert result.get("skipped") is True
    assert result.get("reason") == "untitled-project"
    assert result.get("id") is None


@pytest.mark.asyncio
async def test_revert_unknown_id_returns_error(mock_backend, tmp_path, monkeypatch):
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    mock_backend.set_response(json.dumps({"ok": True, "path": "C:/Foo.aep"}))

    from ae_mcp.handlers.core import _run_revert
    args = S.AeRevertArgs(checkpoint_id="missing", branch_before_revert=False)
    result = await _run_revert(args, ctx=None)
    assert result["ok"] is False
    assert "not found" in result["error"].lower()


@pytest.mark.asyncio
async def test_exec_with_label_creates_checkpoint(mock_backend, tmp_path, monkeypatch):
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    # Seed a saved project file response
    monkeypatch.setattr(store, "make_id", lambda: "exec_id")
    d = store._dir_for("C:/Foo.aep")
    d.mkdir(parents=True, exist_ok=True)
    (d / "exec_id.aep").write_bytes(b"\x00" * 1024)

    def _resp(code="", **kw):
        if "app.project.file" in code and "path:" in code:
            return json.dumps({"ok": True, "path": "C:/Foo.aep"})
        if "checkpoint_create" in code or "File.copy" in code:
            return json.dumps({
                "ok": True, "sourceProjectPath": "C:/Foo.aep",
                "sizeBytes": 1024, "activeCompId": None, "currentTime": 0.0,
                "savedTo": str(d / "exec_id.aep"),
            })
        return json.dumps({"ok": True, "result": 42})

    mock_backend.set_response(_resp)

    from ae_mcp.handlers.core import _run_exec
    args = S.AeExecArgs(code="42", checkpoint_label="risky")
    result = await _run_exec(args, ctx=None)
    assert result["ok"] is True
    # Meta sidecar should have been written
    assert (d / "exec_id.json").exists()


@pytest.mark.asyncio
async def test_exec_checkpoint_probe_failure_does_not_abort_edit(mock_backend, monkeypatch):
    # If the project-path probe blows up (hung/broken bridge or unwritable
    # store), the user's edit must STILL run; the failure degrades to a
    # checkpointSkipped note. This is the non-blocking auto-checkpoint
    # invariant (a thrown error mid-checkpoint can corrupt unrelated state).
    async def _boom(ctx):
        raise RuntimeError("bridge exploded")

    monkeypatch.setattr("ae_mcp.handlers.core._resolve_project_path", _boom)
    mock_backend.set_response(json.dumps({"ok": True, "result": 7}))

    from ae_mcp.handlers.core import _run_exec
    args = S.AeExecArgs(code="7", checkpoint_label="risky")
    result = await _run_exec(args, ctx=None)

    assert result["ok"] is True
    assert "checkpoint-failed" in result["checkpointSkipped"]
    # The user code actually reached the backend despite the checkpoint failure.
    assert any(c["code"] == "7" for c in mock_backend.calls)


@pytest.mark.asyncio
async def test_exec_checkpoint_timeout_degrades(mock_backend, monkeypatch):
    # A hung project-path probe must time out and degrade to a
    # checkpoint-timeout note rather than stalling or aborting the edit.
    import asyncio

    async def _hang(ctx):
        raise asyncio.TimeoutError()

    monkeypatch.setattr("ae_mcp.handlers.core._resolve_project_path", _hang)
    mock_backend.set_response(json.dumps({"ok": True, "result": 7}))

    from ae_mcp.handlers.core import _run_exec
    args = S.AeExecArgs(code="7", checkpoint_label="risky")
    result = await _run_exec(args, ctx=None)

    assert result["ok"] is True
    assert result["checkpointSkipped"] == "checkpoint-timeout"
    assert any(c["code"] == "7" for c in mock_backend.calls)


@pytest.mark.asyncio
async def test_exec_checkpoint_bad_result_degrades(mock_backend, tmp_path, monkeypatch):
    # The snapshot JSX returning a non-ok result must degrade to
    # 'checkpoint-failed: bad-result' while the user code still runs.
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)
    monkeypatch.setattr(store, "make_id", lambda: "bad_id")

    def _resp(code="", **kw):
        if "app.project.file" in code and "path:" in code:
            return json.dumps({"ok": True, "path": "C:/Foo.aep"})
        if "checkpoint_create" in code or "File.copy" in code:
            return json.dumps({"ok": False, "error": "copy failed"})
        return json.dumps({"ok": True, "result": 9})

    mock_backend.set_response(_resp)

    from ae_mcp.handlers.core import _run_exec
    args = S.AeExecArgs(code="9", checkpoint_label="risky")
    result = await _run_exec(args, ctx=None)

    assert result["ok"] is True
    assert result["checkpointSkipped"] == "checkpoint-failed: bad-result"
    assert any(c["code"] == "9" for c in mock_backend.calls)


@pytest.mark.asyncio
async def test_exec_no_label_skips_checkpoint(mock_backend, tmp_path, monkeypatch):
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    mock_backend.set_response(json.dumps({"ok": True, "result": 1}))

    from ae_mcp.handlers.core import _run_exec
    args = S.AeExecArgs(code="1", checkpoint_label=None)
    result = await _run_exec(args, ctx=None)
    assert result["ok"] is True
    # Store should be empty
    d = store._dir_for("C:/Foo.aep")
    assert not d.exists() or list(d.glob("*.aep")) == []


@pytest.mark.asyncio
async def test_revert_restores_over_original_and_reopens(mock_backend, tmp_path, monkeypatch):
    # Revert must restore the checkpoint OVER the original project path and
    # reopen the ORIGINAL — never open the temp copy in place. Verify the
    # close -> copy(atomic) -> open ordering.
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    # A REAL on-disk original project (so the atomic replace targets a file).
    original = tmp_path / "proj" / "Original.aep"
    original.parent.mkdir(parents=True, exist_ok=True)
    original.write_bytes(b"LIVE-EDITS")  # current (dirty) on-disk content

    # Seed a checkpoint with DISTINCT content so we can prove the restore.
    d = store._dir_for(str(original))
    d.mkdir(parents=True, exist_ok=True)
    aep = d / "abc_x.aep"
    aep.write_bytes(b"CHECKPOINT-STATE")
    store.write_meta(source_project_path=str(original), cid="abc_x",
                     label="seed", active_comp_id=None, current_time=0.0,
                     size_bytes=len(b"CHECKPOINT-STATE"))

    calls = []

    def _resp(code="", **kw):
        calls.append(code)
        if "app.project.file" in code and "path:" in code:
            return json.dumps({"ok": True, "path": str(original)})
        if "app.project.close" in code:
            return json.dumps({"ok": True, "closed": True})
        if "app.open" in code:
            return json.dumps({"ok": True, "openedPath": str(original)})
        return json.dumps({"ok": True})

    mock_backend.set_response(_resp)

    from ae_mcp.handlers.core import _run_revert
    args = S.AeRevertArgs(checkpoint_id="abc_x", branch_before_revert=False)
    result = await _run_revert(args, ctx=None)

    assert result["ok"] is True
    assert result["reverted"] is True
    assert result["restoredTo"] == str(original)

    # The on-disk ORIGINAL now holds the checkpoint content (restored in place).
    assert original.read_bytes() == b"CHECKPOINT-STATE"

    # Ordering: a close() call must precede an app.open() call, and the
    # reopen must target the ORIGINAL path (not the temp checkpoint).
    close_idx = next(i for i, c in enumerate(calls) if "app.project.close" in c)
    open_idx = next(i for i, c in enumerate(calls) if "app.open" in c)
    assert close_idx < open_idx
    open_code = calls[open_idx]
    assert original.as_posix() in open_code
    assert aep.as_posix() not in open_code  # never opens the temp copy


@pytest.mark.asyncio
async def test_revert_uses_atomic_replace(mock_backend, tmp_path, monkeypatch):
    # The restore copy must go through os.replace (atomic rename) so the
    # original is never left half-written.
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    original = tmp_path / "Original.aep"
    original.write_bytes(b"OLD")
    d = store._dir_for(str(original))
    d.mkdir(parents=True, exist_ok=True)
    aep = d / "abc_x.aep"
    aep.write_bytes(b"NEW")
    store.write_meta(source_project_path=str(original), cid="abc_x",
                     label="seed", active_comp_id=None, current_time=0.0,
                     size_bytes=3)

    replace_calls = []
    import os as _os
    real_replace = _os.replace

    def _spy_replace(src, dst, *a, **k):
        replace_calls.append((str(src), str(dst)))
        return real_replace(src, dst, *a, **k)

    monkeypatch.setattr("ae_mcp.handlers.core.os.replace", _spy_replace)

    def _resp(code="", **kw):
        if "app.project.file" in code and "path:" in code:
            return json.dumps({"ok": True, "path": str(original)})
        if "app.project.close" in code:
            return json.dumps({"ok": True, "closed": True})
        if "app.open" in code:
            return json.dumps({"ok": True, "openedPath": str(original)})
        return json.dumps({"ok": True})

    mock_backend.set_response(_resp)

    from ae_mcp.handlers.core import _run_revert
    result = await _run_revert(
        S.AeRevertArgs(checkpoint_id="abc_x", branch_before_revert=False), ctx=None
    )
    assert result["ok"] is True
    # os.replace was used and its destination is the original path.
    assert len(replace_calls) == 1
    assert replace_calls[0][1] == str(original)
    # The temp source is a SIBLING of the destination (same volume) so the
    # rename is atomic.
    assert Path(replace_calls[0][0]).parent == original.parent


@pytest.mark.asyncio
async def test_revert_copy_failure_reopens_original(mock_backend, tmp_path, monkeypatch):
    # If the Python copy/replace fails AFTER the close, the handler must
    # reopen the (intact) ORIGINAL and return ok:false/reverted:false so the
    # user is never left with no project.
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    original = tmp_path / "Original.aep"
    original.write_bytes(b"INTACT")
    d = store._dir_for(str(original))
    d.mkdir(parents=True, exist_ok=True)
    aep = d / "abc_x.aep"
    aep.write_bytes(b"NEW")
    store.write_meta(source_project_path=str(original), cid="abc_x",
                     label="seed", active_comp_id=None, current_time=0.0,
                     size_bytes=3)

    # Force the restore copy to blow up.
    def _boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr("ae_mcp.handlers.core.shutil.copyfile", _boom)

    calls = []

    def _resp(code="", **kw):
        calls.append(code)
        if "app.project.file" in code and "path:" in code:
            return json.dumps({"ok": True, "path": str(original)})
        if "app.project.close" in code:
            return json.dumps({"ok": True, "closed": True})
        if "app.open" in code:
            return json.dumps({"ok": True, "openedPath": str(original)})
        return json.dumps({"ok": True})

    mock_backend.set_response(_resp)

    from ae_mcp.handlers.core import _run_revert
    result = await _run_revert(
        S.AeRevertArgs(checkpoint_id="abc_x", branch_before_revert=False), ctx=None
    )
    assert result["ok"] is False
    assert result["reverted"] is False
    assert result["recoveredOriginal"] is True
    # Original on disk is untouched (atomic replace never happened).
    assert original.read_bytes() == b"INTACT"
    # A close happened, then a reopen of the ORIGINAL (recovery).
    assert any("app.project.close" in c for c in calls)
    reopen = next(c for c in calls if "app.open" in c)
    assert original.as_posix() in reopen


@pytest.mark.asyncio
async def test_revert_aborts_if_close_fails(mock_backend, tmp_path, monkeypatch):
    # If the close itself fails, the handler must NOT proceed to copy — the
    # original is never touched and an error is returned.
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    original = tmp_path / "Original.aep"
    original.write_bytes(b"INTACT")
    d = store._dir_for(str(original))
    d.mkdir(parents=True, exist_ok=True)
    aep = d / "abc_x.aep"
    aep.write_bytes(b"NEW")
    store.write_meta(source_project_path=str(original), cid="abc_x",
                     label="seed", active_comp_id=None, current_time=0.0,
                     size_bytes=3)

    replace_spy = []
    monkeypatch.setattr(
        "ae_mcp.handlers.core.os.replace",
        lambda *a, **k: replace_spy.append(a),
    )

    def _resp(code="", **kw):
        if "app.project.file" in code and "path:" in code:
            return json.dumps({"ok": True, "path": str(original)})
        if "app.project.close" in code:
            return json.dumps({"ok": False, "error": "close() failed: locked"})
        if "app.open" in code:
            return json.dumps({"ok": True, "openedPath": str(original)})
        return json.dumps({"ok": True})

    mock_backend.set_response(_resp)

    from ae_mcp.handlers.core import _run_revert
    result = await _run_revert(
        S.AeRevertArgs(checkpoint_id="abc_x", branch_before_revert=False), ctx=None
    )
    assert result["ok"] is False
    assert result["reverted"] is False
    assert "close" in result["error"].lower()
    # No copy/replace was attempted; original untouched.
    assert replace_spy == []
    assert original.read_bytes() == b"INTACT"


@pytest.mark.asyncio
async def test_revert_untitled_project_refuses(mock_backend, tmp_path, monkeypatch):
    # An untitled project has no on-disk path to restore over. Reverting it
    # would make %TEMP% the live project, so the handler refuses.
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    # Seed an _untitled checkpoint so lookup succeeds; the refusal is about
    # there being no live on-disk path, not a missing checkpoint.
    d = store._dir_for(None)
    d.mkdir(parents=True, exist_ok=True)
    (d / "u_1.aep").write_bytes(b"X")
    store.write_meta(source_project_path=None, cid="u_1", label="seed",
                     active_comp_id=None, current_time=0.0, size_bytes=1)

    calls = []

    def _resp(code="", **kw):
        calls.append(code)
        if "app.project.file" in code and "path:" in code:
            return json.dumps({"ok": True, "path": None})  # untitled
        return json.dumps({"ok": True})

    mock_backend.set_response(_resp)

    from ae_mcp.handlers.core import _run_revert
    result = await _run_revert(
        S.AeRevertArgs(checkpoint_id="u_1", branch_before_revert=False), ctx=None
    )
    assert result["ok"] is False
    assert result["reverted"] is False
    assert "untitled" in result["error"].lower()
    # Crucially, the project was NEVER closed (no destructive action taken).
    assert not any("app.project.close" in c for c in calls)
    assert not any("app.open" in c for c in calls)


def test_revert_close_template_renders_no_throw():
    from ae_mcp.handlers.core import _load_jsx
    jsx = _load_jsx("revert_close.jsx").substitute()
    assert "app.project.close" in jsx
    assert "DO_NOT_SAVE_CHANGES" in jsx
    # Never throws: close is wrapped and returns {ok:false,error:...}.
    assert "ok: false" in jsx and "ok: true" in jsx


def test_revert_open_template_substitutes_path_and_no_throw():
    from ae_mcp.handlers.core import _load_jsx
    p = "C:/projects/Original.aep"
    jsx = _load_jsx("revert_open.jsx").substitute(
        aep_path=json.dumps(p, ensure_ascii=False)
    )
    assert json.dumps(p) in jsx
    assert "app.open" in jsx
    # Preserves the missing-file guard and never throws.
    assert "missing" in jsx
    assert "ok: false" in jsx and "ok: true" in jsx


# ---------------------------------------------------------------------------
# ae.previewFrame — real PNG size vs the composition's own size (#242)
# ---------------------------------------------------------------------------


def _chunked_png_writer(path: Path, size: tuple[int, int]):
    """Write a PNG the way saveFrameToPng does: late, and in pieces.

    The signature lands well before the image is complete, which is what makes
    a signature-only wait hand Pillow a truncated file. The gap is deliberate
    and larger than the handler's 50ms poll so the race is not left to luck.
    """
    import io as _io
    import threading
    from PIL import Image

    buffer = _io.BytesIO()
    Image.new("RGB", size, (12, 34, 56)).save(buffer, "PNG")
    payload = buffer.getvalue()
    split = 32

    def _write() -> None:
        with open(path, "wb") as handle:
            handle.write(payload[:split])
            handle.flush()
        time.sleep(0.3)
        with open(path, "ab") as handle:
            handle.write(payload[split:])
            handle.flush()

    threading.Timer(0.05, _write).start()
    return payload


@pytest.mark.asyncio
async def test_preview_frame_reports_written_pixels_not_comp_settings(
    monkeypatch, mock_backend, tmp_path
):
    """A Half-resolution viewer writes half a frame; report what was written.

    saveFrameToPng honours the viewer's Resolution setting, so a 1920x1080 comp
    at [2,2] produces a 960x540 file. Reporting the composition's size instead
    is what produced "frame 0 dimensions (960, 540) do not match (1920, 1080)".
    """
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    def _render_response(code, **kwargs):
        import re

        match = re.search(r"new File\((\".*?\")\)", code)
        assert match, code
        path = Path(json.loads(match.group(1)))
        _chunked_png_writer(path, (960, 540))
        return json.dumps({
            "ok": True,
            "compId": "7",
            "compName": "Preview",
            "time": 0.5,
            "path": str(path),
            "compWidth": 1920,
            "compHeight": 1080,
            "resolutionFactor": [2, 2],
            "source": "comp",
            "method": "saveFrameToPng",
            "existsImmediately": False,
        })

    mock_backend.set_response(_render_response)

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(comp_id="7", time=0.5, out_dir=str(tmp_path)),
        None,
    )

    assert result["ok"] is True
    frame = result["frames"][0]
    assert (frame["width"], frame["height"]) == (960, 540)
    assert (frame["compWidth"], frame["compHeight"]) == (1920, 1080)
    assert frame["resolutionFactor"] == [2, 2]
    assert frame["downsampled"] is True
    # The caller reads the text result, not the metadata fields.
    assert "downsampled" in result["note"]

    # The packaging step is the thing that used to reject this frame. It has to
    # accept the fixed metadata, or the test proves nothing about the symptom.
    from ae_mcp.server import _preview_frame_content

    assert len(_preview_frame_content(result)) == 1


@pytest.mark.asyncio
async def test_preview_frame_full_resolution_capture_is_not_marked_downsampled(
    monkeypatch, mock_backend, tmp_path
):
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    def _render_response(code, **kwargs):
        import re

        match = re.search(r"new File\((\".*?\")\)", code)
        path = Path(json.loads(match.group(1)))
        _chunked_png_writer(path, (320, 180))
        return json.dumps({
            "ok": True,
            "compId": "7",
            "compName": "Preview",
            "time": 0.0,
            "path": str(path),
            "compWidth": 320,
            "compHeight": 180,
            "resolutionFactor": [1, 1],
            "source": "comp",
            "method": "saveFrameToPng",
        })

    mock_backend.set_response(_render_response)

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(comp_id="7", out_dir=str(tmp_path)), None
    )

    frame = result["frames"][0]
    assert (frame["width"], frame["height"]) == (320, 180)
    assert "downsampled" not in frame
    assert "note" not in result


def test_preview_frame_metadata_from_comp_settings_still_fails_packaging(tmp_path):
    """The negative half: without the fix the same capture is still rejected.

    Guards against the pair of tests above passing vacuously -- if the
    packaging check stopped comparing dimensions at all, they would go green
    while the original defect was untouched.
    """
    from PIL import Image
    from ae_mcp.server import _preview_frame_content

    path = tmp_path / "half.png"
    Image.new("RGB", (960, 540), (12, 34, 56)).save(path, "PNG")
    payload = path.read_bytes()

    stale = {
        "ok": True,
        "frames": [{
            "path": str(path),
            "width": 1920,
            "height": 1080,
            "sha256": hashlib.sha256(payload).hexdigest(),
        }],
    }
    with pytest.raises(ValueError, match=r"do not match"):
        _preview_frame_content(stale)


@pytest.mark.asyncio
async def test_preview_frame_rejects_a_png_that_never_finishes(
    monkeypatch, mock_backend, tmp_path
):
    """A truncated file is a capture that did not finish, not a broken image."""
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)
    monkeypatch.setattr(core_handlers, "_await_written_png", _never_written)

    def _render_response(code, **kwargs):
        import re

        match = re.search(r"new File\((\".*?\")\)", code)
        path = Path(json.loads(match.group(1)))
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        return json.dumps({
            "ok": True,
            "compId": "7",
            "compName": "Preview",
            "time": 0.0,
            "path": str(path),
            "compWidth": 320,
            "compHeight": 180,
            "source": "comp",
            "method": "saveFrameToPng",
        })

    mock_backend.set_response(_render_response)

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(comp_id="7", out_dir=str(tmp_path)), None
    )

    assert result["ok"] is False
    assert "did not finish writing" in result["fallbackReason"]


def test_preview_frame_times_are_bounded():
    """An outer timeout that scales with caller input has no ceiling."""
    with pytest.raises(ValidationError):
        S.AePreviewFrameArgs(times=[float(i) for i in range(9)])
    assert S.AePreviewFrameArgs(times=[float(i) for i in range(8)]).times is not None
