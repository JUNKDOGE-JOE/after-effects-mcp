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

    assert _filtered_tool_names() == {"ae.status"}

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
    assert filtered == {"ae.ping", "ae.status"}

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

    assert _filtered_tool_names() == {"ae.ping", "ae.status"}
