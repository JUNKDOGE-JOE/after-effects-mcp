"""Shared pytest fixtures.

Mock bridge: intercepts after_effects_mcp.bridge.run_ps / invoke_ae_* so handler tests
never actually spawn pwsh. Each test registers a dict of expected (function,
kwargs) -> response string.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Dict, List, Optional, Tuple
from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture
def mock_bridge(monkeypatch):
    """Replace after_effects_mcp.bridge invoke_ae_* with AsyncMocks that record calls.

    Yields a namespace with:
      - calls: list of (name, args, kwargs) tuples
      - responses: dict mapping function name -> canned response str
      - set_response(name, value): set canned response
    """
    from after_effects_mcp import bridge

    class MockNS:
        def __init__(self) -> None:
            self.calls: List[Tuple[str, tuple, dict]] = []
            self.responses: Dict[str, Any] = {}

        def set_response(self, func_name: str, value: Any) -> None:
            self.responses[func_name] = value

        def make_mock(self, func_name: str):
            async def _mock(*args, **kwargs):
                self.calls.append((func_name, args, kwargs))
                resp = self.responses.get(func_name, '{"ok":true}')
                if callable(resp):
                    return resp(*args, **kwargs)
                return resp

            return _mock

    ns = MockNS()
    for name in [
        "invoke_ae_init",
        "invoke_ae_overview",
        "invoke_ae_layers",
        "invoke_ae_exec",
        "invoke_ae_read_props",
        "invoke_ae_checkpoint",
        "invoke_ae_revert",
        "run_ps",
    ]:
        if hasattr(bridge, name):
            monkeypatch.setattr(bridge, name, ns.make_mock(name))

    return ns
