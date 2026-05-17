"""Core handler behaviour (against mock backend)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ae_mcp import schemas as S
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers.core import _run_ping


@pytest.fixture(autouse=True)
def _load():
    load_all()


@pytest.mark.asyncio
async def test_init_calls_bridge_and_returns_dict(mock_backend):
    mock_backend.set_response('{"pluginVersion":"test-stub"}')
    _, run_fn = HANDLERS["ae.init"]
    result = await run_fn(S.AeInitArgs(refresh_only=True), None)
    assert result == {"pluginVersion": "test-stub"}
    assert len(mock_backend.calls) >= 1


@pytest.mark.asyncio
async def test_overview_returns_parsed_json(mock_backend):
    mock_backend.set_response(
        '{"project":"x.aep","numItems":3,"activeItemId":null}',
    )
    _, run_fn = HANDLERS["ae.overview"]
    result = await run_fn(S.AeOverviewArgs(), None)
    assert result["numItems"] == 3


@pytest.mark.asyncio
async def test_layers_passes_comp_id(mock_backend):
    mock_backend.set_response('{"compId":42,"layers":[]}')
    _, run_fn = HANDLERS["ae.layers"]
    await run_fn(S.AeLayersArgs(comp_id="42"), None)
    # The JSX sent to the backend should reference the comp id
    assert len(mock_backend.calls) >= 1
    jsx = mock_backend.calls[-1]["code"]
    assert "42" in jsx


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
async def test_read_props_routes_through_exec(mock_backend):
    # ae.readProps uses backend.exec under the hood
    mock_backend.set_response('{"value":42}')
    _, run_fn = HANDLERS["ae.readProps"]
    result = await run_fn(S.AeReadPropsArgs(code="JSON.stringify({value:42})"), None)
    assert result == {"value": 42}


@pytest.mark.asyncio
async def test_apply_effect_builds_jsx(mock_backend):
    mock_backend.set_response(
        '{"ok":true,"effectIndex":1,"effectName":"Gaussian Blur"}'
    )
    _, run_fn = HANDLERS["ae.applyEffect"]
    args = S.AeApplyEffectArgs(layer_id=3, effect_match_name="ADBE Gaussian Blur 2")
    result = await run_fn(args, None)
    assert result["ok"] is True
    # Verify the JSX we send contains the match name and layer index.
    assert len(mock_backend.calls) >= 1
    jsx = mock_backend.calls[-1]["code"]
    assert "ADBE Gaussian Blur 2" in jsx
    assert "comp.layer(3)" in jsx


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
async def test_preview_frame_uses_viewer_snapshot_not_render(monkeypatch, mock_backend, tmp_path):
    monkeypatch.setattr(
        "ae_mcp.snapshot.discovery.select_snapshotter",
        lambda: _FakeSnapshotter(),
    )
    mock_backend.set_response(json.dumps({
        "ok": True,
        "compId": "7",
        "compName": "Preview",
        "time": 0.5,
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
    assert "saveFrameToPng" not in jsx
    assert "openInViewer" in jsx
    assert "itemByID(7)" in jsx


@pytest.mark.asyncio
async def test_preview_frame_can_attach_base64(monkeypatch, mock_backend, tmp_path):
    monkeypatch.setattr(
        "ae_mcp.snapshot.discovery.select_snapshotter",
        lambda: _FakeSnapshotter(),
    )
    mock_backend.set_response(json.dumps({
        "ok": True,
        "compId": "active",
        "compName": "Preview",
        "time": 0,
    }))

    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(
        S.AePreviewFrameArgs(out_dir=str(tmp_path), include_base64=True),
        None,
    )

    assert result["frames"][0]["sizeBytes"] == len(b"png-bytes")
    assert result["frames"][0]["base64"] == "cG5nLWJ5dGVz"


@pytest.mark.asyncio
async def test_preview_frame_errors_without_snapshotter(monkeypatch, mock_backend, tmp_path):
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)
    _, run_fn = HANDLERS["ae.previewFrame"]
    result = await run_fn(S.AePreviewFrameArgs(out_dir=str(tmp_path)), None)
    assert result["ok"] is False
    assert "snapshotter" in result["error"]


@pytest.mark.asyncio
async def test_skill_crud_and_render(monkeypatch, tmp_path):
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path))
    from ae_mcp.handlers.skills import (
        _run_skill_create, _run_skill_delete, _run_skill_list, _run_skill_use,
    )

    created = await _run_skill_create(S.AeSkillCreateArgs(
        name="wiggle-position",
        description="Add wiggle expression",
        template_type="jsx",
        template='prop.expression = "wiggle(" + ${freq} + "," + ${amp} + ")";',
        args_schema={
            "freq": {"type": "number", "default": 2},
            "amp": {"type": "number", "default": 30},
        },
    ), None)
    assert created["ok"] is True

    listed = await _run_skill_list(S.AeSkillListArgs(), None)
    assert listed["skills"] == [{
        "name": "wiggle-position",
        "description": "Add wiggle expression",
        "template_type": "jsx",
        "args": ["freq", "amp"],
    }]

    rendered = await _run_skill_use(S.AeSkillUseArgs(name="wiggle-position"), None)
    assert rendered["ok"] is True
    assert "wiggle(" in rendered["rendered"]
    assert "30" in rendered["rendered"]

    deleted = await _run_skill_delete(S.AeSkillDeleteArgs(name="wiggle-position"), None)
    assert deleted["ok"] is True


@pytest.mark.asyncio
async def test_skill_create_requires_overwrite(monkeypatch, tmp_path):
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path))
    from ae_mcp.handlers.skills import _run_skill_create

    args = S.AeSkillCreateArgs(name="same", description="x", template="one")
    assert (await _run_skill_create(args, None))["ok"] is True
    duplicate = await _run_skill_create(args, None)
    assert duplicate["ok"] is False
    assert "exists" in duplicate["error"]


@pytest.mark.asyncio
async def test_skill_use_missing_arg_fails(monkeypatch, tmp_path):
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path))
    from ae_mcp.handlers.skills import _run_skill_create, _run_skill_use

    await _run_skill_create(S.AeSkillCreateArgs(
        name="needs-arg",
        description="x",
        template="${missing}",
        args_schema={"missing": {"type": "number"}},
    ), None)
    result = await _run_skill_use(S.AeSkillUseArgs(name="needs-arg"), None)
    assert result["ok"] is False
    assert "missing" in result["error"]


@pytest.mark.asyncio
async def test_skill_use_execute_runs_jsx(monkeypatch, tmp_path, mock_backend):
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path))
    from ae_mcp.handlers.skills import _run_skill_create, _run_skill_use

    mock_backend.set_response(json.dumps({"ok": True, "mutated": True}))
    await _run_skill_create(S.AeSkillCreateArgs(
        name="exec-jsx",
        description="x",
        template="JSON.stringify({ok:true,value:${value}})",
        args_schema={"value": {"type": "number"}},
    ), None)
    result = await _run_skill_use(
        S.AeSkillUseArgs(name="exec-jsx", args={"value": 42}, execute=True),
        None,
    )
    assert result["ok"] is True
    assert result["mutated"] is True
    assert "42" in mock_backend.calls[-1]["code"]


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
    assert "itemByID(12)" in jsx
    assert "[0.0, 1.0]" in jsx


@pytest.mark.asyncio
async def test_create_rig_builds_transform_controller_jsx(mock_backend):
    mock_backend.set_response(json.dumps({
        "ok": True,
        "rigType": "transform_controller",
        "controllerLayerId": 2,
        "targetLayerId": 1,
        "createdLayers": [2],
        "wiredProperties": ["Transform/Position"],
    }))
    from ae_mcp.handlers.rig import _run_create_rig

    result = await _run_create_rig(
        S.AeCreateRigArgs(
            comp_id="12",
            target_layer_id=1,
            rig_type="transform_controller",
            name="Main CTRL",
            options={"position": True, "rotation": False, "scale": False, "opacity": False},
        ),
        None,
    )
    assert result["ok"] is True
    jsx = mock_backend.calls[-1]["code"]
    assert "Main CTRL" in jsx
    assert "transform_controller" in jsx
    assert "itemByID(12)" in jsx


@pytest.mark.asyncio
async def test_create_rig_missing_preset_path_returns_backend_error(mock_backend):
    mock_backend.set_response(json.dumps({
        "ok": False,
        "error": "preset_path is required for apply_preset",
    }))
    from ae_mcp.handlers.rig import _run_create_rig

    result = await _run_create_rig(
        S.AeCreateRigArgs(target_layer_id=1, rig_type="apply_preset"),
        None,
    )
    assert result["ok"] is False
    assert "preset_path" in result["error"]


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
async def test_revert_known_id_calls_jsx(mock_backend, tmp_path, monkeypatch):
    from ae_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("ae_mcp.handlers.core._store", store)

    # Seed
    d = store._dir_for("C:/Foo.aep")
    d.mkdir(parents=True, exist_ok=True)
    aep = d / "abc_x.aep"
    aep.write_bytes(b"\x00" * 1024)
    store.write_meta(source_project_path="C:/Foo.aep", cid="abc_x",
                     label="seed", active_comp_id=None, current_time=0.0,
                     size_bytes=1024)

    calls = []

    def _resp(code="", **kw):
        calls.append(code)
        # First: project-path probe; second: revert.jsx
        if "app.project.file" in code and len(calls) == 1:
            return json.dumps({"ok": True, "path": "C:/Foo.aep"})
        return json.dumps({"ok": True, "reverted": True,
                           "openedPath": str(aep)})

    mock_backend.set_response(_resp)

    from ae_mcp.handlers.core import _run_revert
    args = S.AeRevertArgs(checkpoint_id="abc_x", branch_before_revert=False)
    result = await _run_revert(args, ctx=None)
    assert result["ok"] is True
    assert result.get("reverted") is True
    # The second call to backend.exec should have rendered revert.jsx
    aep_posix = aep.as_posix()
    assert any(aep_posix in c for c in calls)
