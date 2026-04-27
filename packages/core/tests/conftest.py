"""Shared pytest fixtures for core unit tests."""
from __future__ import annotations

from typing import Optional
import pytest

from ae_mcp.backends.mock import MockBackend


@pytest.fixture
def mock_backend(monkeypatch):
    """Yield a MockBackend that's also installed as the "active" backend.

    Replaces the v0.7 `mock_bridge` fixture. Tests that previously called
    `mock_bridge.set_response(...)` now call `mock_backend.set_response(...)`.
    """
    mb = MockBackend()

    def _select() -> MockBackend:
        return mb

    # Patch every place core might lookup the active backend
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", _select)
    return mb
