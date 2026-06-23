from __future__ import annotations

import pytest

from ae_mcp.backends.discovery import BackendSelectionError
from ae_mcp.backends.mock import MockBackend
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.server import _filtered_tool_names


def _load_status_handler():
    load_all()
    schema_cls, run_fn = HANDLERS["ae.status"]
    return schema_cls, run_fn


@pytest.mark.asyncio
async def test_status_tool_is_only_exposed_when_backend_selection_fails(monkeypatch):
    def _boom():
        raise BackendSelectionError("no backend configured\nTry: pip install ae-mcp-backend-demo")

    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", _boom)
    monkeypatch.setattr("ae_mcp.backends.discovery.list_installed_backends", lambda: {})
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    assert _filtered_tool_names() == {"ae.status", "ae.diagnose"}

    schema_cls, run_fn = _load_status_handler()
    result = await run_fn(schema_cls(), None)

    assert result["ok"] is False
    assert "pip install" in result["backendError"]
    assert result["backend"] is None


@pytest.mark.asyncio
async def test_status_tool_reports_backend_and_supported_verbs(monkeypatch):
    backend = MockBackend()
    monkeypatch.setattr(backend, "supported_verbs", lambda: {"ae.ping", "ae.snapshot"})
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)
    monkeypatch.setattr("ae_mcp.backends.discovery.list_installed_backends", lambda: {"mock": MockBackend})
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    filtered = _filtered_tool_names()
    assert filtered == {"ae.ping", "ae.status", "ae.diagnose"}

    schema_cls, run_fn = _load_status_handler()
    result = await run_fn(schema_cls(), None)

    assert result["ok"] is True
    assert result["backend"] == "MockBackend"
    assert result["backendError"] is None
    assert result["installedBackends"] == ["mock"]


def test_filtered_tool_names_ignores_snapshotter_selection_exceptions(monkeypatch):
    backend = MockBackend()
    monkeypatch.setattr(backend, "supported_verbs", lambda: {"ae.ping", "ae.snapshot"})
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)

    def _snap_boom():
        raise RuntimeError("snapshotter probe exploded")

    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", _snap_boom)

    assert _filtered_tool_names() == {"ae.ping", "ae.status", "ae.diagnose"}


# ---------------------------------------------------------------------------
# ae.diagnose — end-to-end connection self-check
# ---------------------------------------------------------------------------

def _load_diagnose_handler():
    load_all()
    schema_cls, run_fn = HANDLERS["ae.diagnose"]
    return schema_cls, run_fn


@pytest.mark.asyncio
async def test_diagnose_reports_full_chain_when_backend_healthy(monkeypatch):
    import json

    backend = MockBackend()
    backend.set_health(True)
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)

    # The /exec probe returns pong + project file.
    backend.set_response(
        json.dumps({"ok": True, "pong": "pong", "aeVersion": "26.2", "projectFile": "demo.aep"})
    )

    schema_cls, run_fn = _load_diagnose_handler()
    result = await run_fn(schema_cls(), None)

    # MockBackend has no .url, so host reachability comes from health_check().
    assert result["host"]["reachable"] is True
    assert result["token"]["valid"] is True
    assert result["ae"]["responsive"] is True
    assert result["ae"]["projectFile"] == "demo.aep"
    assert result["ae"]["aeVersion"] == "26.2"
    assert result["ok"] is True
    # The diagnose.jsx was actually sent through the bridge.
    assert "pong" in backend.calls[-1]["code"]


@pytest.mark.asyncio
async def test_diagnose_reports_token_error_without_aborting(monkeypatch):
    from ae_mcp.backends.base import BackendError

    backend = MockBackend()
    backend.set_health(True)
    # Simulate a token read failure on /exec.
    async def _exec_boom(code, **kwargs):
        raise BackendError("HttpBridge: auth token not found at ~/.ae-mcp/auth-token. Start the panel.")
    monkeypatch.setattr(backend, "exec", _exec_boom)
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)

    schema_cls, run_fn = _load_diagnose_handler()
    result = await run_fn(schema_cls(), None)

    # Host is reachable, but the token is the problem — and ok reflects it.
    assert result["host"]["reachable"] is True
    assert result["token"]["valid"] is False
    assert "auth token" in result["token"].get("error", "")
    assert result["ok"] is False


@pytest.mark.asyncio
async def test_diagnose_runs_even_when_backend_selection_fails(monkeypatch):
    def _boom():
        raise BackendSelectionError("no backend configured")

    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", _boom)

    schema_cls, run_fn = _load_diagnose_handler()
    result = await run_fn(schema_cls(), None)

    # No backend -> host/token/ae all unavailable, but the call does not crash.
    assert result["ok"] is False
    assert result["host"]["reachable"] is False
    assert "no backend" in result["host"]["error"]
    assert result["token"]["valid"] is False
    assert result["ae"] is None
