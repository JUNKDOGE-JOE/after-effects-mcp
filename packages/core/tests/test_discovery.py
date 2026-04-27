"""Tests for backend discovery and selection."""
import pytest
from unittest.mock import patch

from ae_mcp.backends.base import Backend
from ae_mcp.backends.discovery import (
    select_backend, list_installed_backends, BackendSelectionError,
)


class FakeBackendA(Backend):
    name = "a"
    async def exec(self, code, **kw): return "{}"
    async def health_check(self, timeout_sec=5.0): return True
    @classmethod
    def from_env(cls): return cls()


class FakeBackendB(Backend):
    name = "b"
    async def exec(self, code, **kw): return "{}"
    async def health_check(self, timeout_sec=5.0): return True
    @classmethod
    def from_env(cls): return cls()


def _patch_installed(installed):
    return patch("ae_mcp.backends.discovery._scan_entry_points",
                 return_value=installed)


def test_zero_installed_raises_helpful_error(monkeypatch):
    monkeypatch.delenv("AE_MCP_BACKEND", raising=False)
    with _patch_installed({}):
        with pytest.raises(BackendSelectionError) as ei:
            select_backend()
        assert "no AE backend installed" in str(ei.value)
        assert "pip install" in str(ei.value)


def test_one_installed_no_env_var_uses_it(monkeypatch):
    monkeypatch.delenv("AE_MCP_BACKEND", raising=False)
    with _patch_installed({"a": FakeBackendA}):
        b = select_backend()
        assert isinstance(b, FakeBackendA)


def test_multiple_installed_no_env_var_raises(monkeypatch):
    monkeypatch.delenv("AE_MCP_BACKEND", raising=False)
    with _patch_installed({"a": FakeBackendA, "b": FakeBackendB}):
        with pytest.raises(BackendSelectionError) as ei:
            select_backend()
        assert "set AE_MCP_BACKEND" in str(ei.value).lower() or \
               "AE_MCP_BACKEND" in str(ei.value)


def test_env_var_selects_named_backend(monkeypatch):
    monkeypatch.setenv("AE_MCP_BACKEND", "b")
    with _patch_installed({"a": FakeBackendA, "b": FakeBackendB}):
        sel = select_backend()
        assert isinstance(sel, FakeBackendB)


def test_env_var_unknown_raises_with_install_hint(monkeypatch):
    monkeypatch.setenv("AE_MCP_BACKEND", "ghost")
    with _patch_installed({"a": FakeBackendA}):
        with pytest.raises(BackendSelectionError) as ei:
            select_backend()
        msg = str(ei.value)
        assert "ghost" in msg
        assert "pip install" in msg


def test_list_installed_backends_returns_dict():
    # Real call against installed entry points; safe to call even if empty
    installed = list_installed_backends()
    assert isinstance(installed, dict)
