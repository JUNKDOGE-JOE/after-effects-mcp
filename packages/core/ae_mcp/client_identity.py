"""Carries the MCP client's identity from initialize to backend requests."""
from __future__ import annotations

import contextvars
from contextvars import Token

HEADER = "x-ae-mcp-client"
_client: contextvars.ContextVar[str] = contextvars.ContextVar(
    "ae_mcp_client",
    default="unknown",
)
_panel_developer: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "ae_mcp_panel_developer",
    default=False,
)


def set_client(name: str | None, version: str | None) -> None:
    label = (name or "unknown").strip() or "unknown"
    if version:
        label = f"{label}/{version}"
    _client.set(label[:120])


def get_client() -> str:
    return _client.get()


def set_panel_developer(enabled: bool) -> Token[bool]:
    """Scope trusted Developer Tools visibility to one MCP request."""

    return _panel_developer.set(bool(enabled))


def reset_panel_developer(token: Token[bool]) -> None:
    _panel_developer.reset(token)


def panel_developer_enabled() -> bool:
    return _panel_developer.get()
