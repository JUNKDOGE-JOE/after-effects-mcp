"""MockBackend — for use in core unit tests only."""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Union

from ae_mcp.backends.base import Backend


class MockBackend(Backend):
    """Records every call; returns canned response strings.

    Tests inject this via the `mock_backend` pytest fixture.
    Setting a callable response lets a test return different bytes per call.
    """

    name = "mock"

    def __init__(self) -> None:
        self.calls: List[Dict[str, Any]] = []
        self._response: Union[str, Callable[..., str]] = '{"ok":true}'
        self._health: bool = True

    def set_response(self, value: Union[str, Callable[..., str]]) -> None:
        self._response = value

    def set_health(self, ok: bool) -> None:
        self._health = ok

    async def exec(
        self,
        code: str,
        *,
        undo_group: Optional[str] = None,
        checkpoint_label: Optional[str] = None,
        timeout_sec: float = 30.0,
    ) -> str:
        self.calls.append({
            "code": code,
            "undo_group": undo_group,
            "checkpoint_label": checkpoint_label,
            "timeout_sec": timeout_sec,
        })
        if callable(self._response):
            return self._response(code=code, undo_group=undo_group,
                                  checkpoint_label=checkpoint_label,
                                  timeout_sec=timeout_sec)
        return self._response

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        return self._health

    @classmethod
    def from_env(cls) -> "MockBackend":
        return cls()
