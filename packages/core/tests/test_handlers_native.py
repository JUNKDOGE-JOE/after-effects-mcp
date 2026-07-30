"""Public MCP registration for the single native execution route."""

from __future__ import annotations

import pytest

from ae_mcp import schemas
from ae_mcp.backends import native as N
from ae_mcp.backends.mock import MockBackend
from ae_mcp.handlers import HANDLERS, load_all


@pytest.fixture(autouse=True)
def _load_handlers():
    load_all()


def test_native_tool_registration_exposes_only_native_exec():
    assert HANDLERS["ae.nativeExec"][0] is schemas.AeNativeExecArgs
    removed = {
        "ae.projectSummary",
        "ae.getProjectBitDepth",
        "ae.setProjectBitDepth",
        "ae.setLayerPropertyValue",
        "ae.createCompositionLayer",
        "ae.applyLayerEffect",
        "ae.listSelectedLayers",
    }
    assert removed.isdisjoint(HANDLERS)


class _NativeMock(MockBackend, N.NativeInvokeBackend):
    async def negotiate(self, **_kwargs):
        raise AssertionError("filtering must not negotiate")

    async def capabilities(self, **_kwargs) -> N.NativeCapabilities:
        raise AssertionError("filtering must not read capabilities")

    async def invoke(self, *_args, **_kwargs):
        raise AssertionError("filtering must not invoke")


def test_tool_filter_exposes_native_exec_only_for_native_adapter(monkeypatch):
    from ae_mcp import server as server_module
    from ae_mcp.backends import discovery as backend_discovery
    from ae_mcp.snapshot import discovery as snapshot_discovery

    monkeypatch.setattr(snapshot_discovery, "select_snapshotter", lambda: None)
    monkeypatch.setattr(backend_discovery, "select_backend", lambda: MockBackend())
    names = server_module._filtered_tool_names()
    assert "ae.exec" in names
    assert "ae.nativeExec" not in names

    monkeypatch.setattr(backend_discovery, "select_backend", lambda: _NativeMock())
    names = server_module._filtered_tool_names()
    assert "ae.exec" in names
    assert "ae.nativeExec" in names
