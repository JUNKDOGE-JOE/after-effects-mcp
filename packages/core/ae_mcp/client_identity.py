"""Carries the MCP client's identity from initialize to backend requests."""
from __future__ import annotations

import contextvars

HEADER = "x-ae-mcp-client"
_client: contextvars.ContextVar[str] = contextvars.ContextVar(
    "ae_mcp_client",
    default="unknown",
)


def set_client(name: str | None, version: str | None) -> None:
    label = (name or "unknown").strip() or "unknown"
    if version:
        label = f"{label}/{version}"
    _client.set(label[:120])


def get_client() -> str:
    return _client.get()
