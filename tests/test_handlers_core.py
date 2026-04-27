"""Core 9 handler behaviour (against mock bridge)."""

from __future__ import annotations

import json

import pytest

from after_effects_mcp import schemas as S
from after_effects_mcp.handlers import HANDLERS, load_all


@pytest.fixture(autouse=True)
def _load():
    load_all()


@pytest.mark.asyncio
async def test_init_calls_bridge_and_returns_dict(mock_bridge):
    mock_bridge.set_response("invoke_ae_init", '{"pluginVersion":"aebm-file"}')
    _, run_fn = HANDLERS["ae.init"]
    result = await run_fn(S.AeInitArgs(refresh_only=True), None)
    assert result == {"pluginVersion": "aebm-file"}
    assert any(c[0] == "invoke_ae_init" for c in mock_bridge.calls)


@pytest.mark.asyncio
async def test_overview_returns_parsed_json(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_overview",
        '{"project":"x.aep","numItems":3,"activeItemId":null}',
    )
    _, run_fn = HANDLERS["ae.overview"]
    result = await run_fn(S.AeOverviewArgs(), None)
    assert result["numItems"] == 3


@pytest.mark.asyncio
async def test_layers_passes_comp_id(mock_bridge):
    mock_bridge.set_response("invoke_ae_layers", '{"compId":42,"layers":[]}')
    _, run_fn = HANDLERS["ae.layers"]
    await run_fn(S.AeLayersArgs(comp_id="42"), None)
    name, args, kwargs = next(c for c in mock_bridge.calls if c[0] == "invoke_ae_layers")
    assert kwargs.get("comp_id") == "42"


@pytest.mark.asyncio
async def test_exec_forwards_all_args(mock_bridge):
    mock_bridge.set_response("invoke_ae_exec", '{"ok":true}')
    _, run_fn = HANDLERS["ae.exec"]
    args = S.AeExecArgs(
        code="JSON.stringify({a:1})",
        undo_group_name="unit",
        checkpoint_label="t1",
        timeout_sec=60,
    )
    await run_fn(args, None)
    name, a, kw = next(c for c in mock_bridge.calls if c[0] == "invoke_ae_exec")
    assert kw["code"] == "JSON.stringify({a:1})"
    assert kw["undo_group_name"] == "unit"
    assert kw["checkpoint_label"] == "t1"
    assert kw["timeout_sec"] == 60.0


@pytest.mark.asyncio
async def test_read_props_routes_through_exec(mock_bridge):
    # ae.readProps uses invoke_ae_exec under the hood (aebm-file requires code)
    mock_bridge.set_response("invoke_ae_exec", '{"value":42}')
    _, run_fn = HANDLERS["ae.readProps"]
    result = await run_fn(S.AeReadPropsArgs(code="JSON.stringify({value:42})"), None)
    assert result == {"value": 42}



@pytest.mark.asyncio
async def test_revert_is_stub(mock_bridge):
    _, run_fn = HANDLERS["ae.revert"]
    result = await run_fn(S.AeRevertArgs(checkpoint_id="abc"), None)
    assert result["reverted"] is False
    assert "NotImplemented" in result["reason"]


@pytest.mark.asyncio
async def test_apply_effect_builds_jsx(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec", '{"ok":true,"effectIndex":1,"effectName":"Gaussian Blur"}'
    )
    _, run_fn = HANDLERS["ae.applyEffect"]
    args = S.AeApplyEffectArgs(layer_id=3, effect_match_name="ADBE Gaussian Blur 2")
    result = await run_fn(args, None)
    assert result["ok"] is True
    # Verify the JSX we send contains the match name and layer index.
    name, a, kw = next(c for c in mock_bridge.calls if c[0] == "invoke_ae_exec")
    jsx = kw["code"]
    assert "ADBE Gaussian Blur 2" in jsx
    assert "comp.layer(3)" in jsx


@pytest.mark.asyncio
async def test_snapshot_error_on_non_windows(monkeypatch):
    """When after_effects_mcp.snapshot import fails, handler returns a clean error.
    Uses monkeypatch to make the import fail."""
    import sys
    _, run_fn = HANDLERS["ae.snapshot"]
    # Force the import to fail by temporarily removing the module and
    # poisoning the module cache entry.
    orig = sys.modules.pop("after_effects_mcp.snapshot", None)
    sys.modules["after_effects_mcp.snapshot"] = None  # type: ignore[assignment]
    try:
        result = await run_fn(S.AeSnapshotArgs(), None)
        assert result["ok"] is False
        assert "unavailable" in result["error"]
    finally:
        if orig is not None:
            sys.modules["after_effects_mcp.snapshot"] = orig
        else:
            sys.modules.pop("after_effects_mcp.snapshot", None)


import pytest
from after_effects_mcp import schemas
from after_effects_mcp.handlers.core import _run_ping  # noqa: F401 — added in this task


@pytest.mark.asyncio
async def test_ae_ping_default(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "pong": "pong", "aeVersion": "26.0", "latencyMs": 5}),
    )
    args = schemas.AePingArgs()
    result = await _run_ping(args, ctx=None)
    assert result["ok"] is True
    assert result["pong"] == "pong"


@pytest.mark.asyncio
async def test_ae_ping_custom(mock_bridge):
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "pong": "hello", "aeVersion": "26.0", "latencyMs": 4}),
    )
    args = schemas.AePingArgs(expect="hello")
    result = await _run_ping(args, ctx=None)
    assert result["pong"] == "hello"
    # Verify the JSX sent included the expected token
    sent_kwargs = mock_bridge.calls[-1][2]
    assert "hello" in sent_kwargs["code"]


# ---------------------------------------------------------------------------
# ae.checkpoint — real implementation tests (Task 3.4)
# ---------------------------------------------------------------------------

import json
from pathlib import Path
import pytest
from after_effects_mcp import schemas


@pytest.mark.asyncio
async def test_checkpoint_list_default_returns_disk_entries(mock_bridge, tmp_path, monkeypatch):
    # Force checkpoint_store root to tmp_path
    from after_effects_mcp import checkpoint_store, handlers
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    # Pre-populate one fake checkpoint for "MyProject"
    d = store._dir_for("C:/MyProject.aep")
    d.mkdir(parents=True, exist_ok=True)
    (d / "abc_x.aep").write_bytes(b"\x00" * 1024)
    store.write_meta(
        source_project_path="C:/MyProject.aep",
        cid="abc_x", label="seed", active_comp_id="12",
        current_time=0.0, size_bytes=1024,
    )

    # Mock the bridge call that fetches current project path
    mock_bridge.set_response(
        "invoke_ae_exec",
        json.dumps({"ok": True, "path": "C:/MyProject.aep"}),
    )

    from after_effects_mcp.handlers.core import _run_checkpoint
    args = schemas.AeCheckpointArgs(action="list", limit=10)
    result = await _run_checkpoint(args, ctx=None)

    assert result["ok"] is True
    assert len(result["checkpoints"]) == 1
    assert result["checkpoints"][0]["id"] == "abc_x"
    assert result["checkpoints"][0]["label"] == "seed"


@pytest.mark.asyncio
async def test_checkpoint_create_writes_meta(mock_bridge, tmp_path, monkeypatch):
    from after_effects_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    # Mock the bridge: first call resolves current project path; second
    # call runs the checkpoint_create JSX and returns saved metadata.
    responses = iter([
        json.dumps({"ok": True, "path": "C:/Foo.aep"}),
        json.dumps({
            "ok": True, "sourceProjectPath": "C:/Foo.aep",
            "savedTo": str(tmp_path / "Foo" / "<id>.aep"),
            "sizeBytes": 4096, "activeCompId": "1",
            "currentTime": 0.0
        }),
    ])
    async def _resp(*a, **kw):
        return next(responses)
    monkeypatch.setattr("after_effects_mcp.bridge.invoke_ae_exec", _resp)

    # Prepare the .aep that the JSX claims to have written. We have to write
    # the file ourselves — the mocked bridge didn't actually run AE.
    d = store._dir_for("C:/Foo.aep")
    d.mkdir(parents=True, exist_ok=True)
    # The handler will deterministically produce the id; we patch make_id.
    monkeypatch.setattr(store, "make_id", lambda: "fixed_id")
    (d / "fixed_id.aep").write_bytes(b"\x00" * 4096)

    from after_effects_mcp.handlers.core import _run_checkpoint
    args = schemas.AeCheckpointArgs(action="create", label="label-A")
    result = await _run_checkpoint(args, ctx=None)

    assert result["ok"] is True
    assert result["id"] == "fixed_id"
    assert result["label"] == "label-A"
    # Meta sidecar exists
    assert (d / "fixed_id.json").exists()


@pytest.mark.asyncio
async def test_checkpoint_create_untitled_skipped(mock_bridge, tmp_path, monkeypatch):
    from after_effects_mcp import checkpoint_store
    store = checkpoint_store.CheckpointStore(root=tmp_path)
    monkeypatch.setattr("after_effects_mcp.handlers.core._store", store)

    responses = iter([
        json.dumps({"ok": True, "path": None}),  # untitled
    ])
    async def _resp(*a, **kw):
        return next(responses)
    monkeypatch.setattr("after_effects_mcp.bridge.invoke_ae_exec", _resp)

    from after_effects_mcp.handlers.core import _run_checkpoint
    args = schemas.AeCheckpointArgs(action="create", label="x")
    result = await _run_checkpoint(args, ctx=None)

    assert result["ok"] is True
    assert result.get("skipped") is True
    assert result.get("reason") == "untitled-project"
    assert result.get("id") is None
