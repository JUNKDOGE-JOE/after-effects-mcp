"""Atom MCP Streamable HTTP protocol — client side.

Spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
Atom-specific quirks documented in (originally)
E:/Code/AEBMethod/docs/development/ATOM_INTEGRATION.md.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Dict, Optional

import httpx


REQUIRED_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}


class AtomProtocolError(RuntimeError):
    pass


class AtomSessionGoneError(AtomProtocolError):
    """Server returned 'Session ID required' or similar; caller should reconnect."""


class AtomClient:
    """Single-connection async client for Atom's HTTP MCP endpoint."""

    def __init__(self, url: str, *, timeout_sec: float = 30.0) -> None:
        self.url = url
        self._timeout = timeout_sec
        self._http = httpx.AsyncClient(timeout=timeout_sec)
        self._session_id: Optional[str] = None
        self._init_lock = asyncio.Lock()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def initialize(self) -> None:
        """Three-step handshake: initialize, notifications/initialized, capture session id."""
        async with self._init_lock:
            req_id = str(uuid.uuid4())
            init_payload = {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": {"name": "ae-mcp-backend-atom", "version": "0.1.0"},
                },
            }
            r = await self._http.post(self.url, headers=REQUIRED_HEADERS,
                                       content=json.dumps(init_payload))
            if r.status_code != 200:
                raise AtomProtocolError(
                    f"initialize failed: HTTP {r.status_code}: {r.text[:300]}"
                )
            # session id can be in any of three header casings
            sid = (r.headers.get("Mcp-Session-Id")
                   or r.headers.get("mcp-session-id")
                   or r.headers.get("MCP-Session-Id"))
            if not sid:
                raise AtomProtocolError("initialize: no Mcp-Session-Id in response headers")
            self._session_id = sid

            notif = {
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {},
            }
            r2 = await self._http.post(
                self.url,
                headers={**REQUIRED_HEADERS, "Mcp-Session-Id": sid},
                content=json.dumps(notif),
            )
            if r2.status_code not in (200, 202):
                raise AtomProtocolError(
                    f"notifications/initialized failed: HTTP {r2.status_code}"
                )

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> Any:
        if self._session_id is None:
            await self.initialize()

        req_id = str(uuid.uuid4())
        payload = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }
        try:
            return await self._post(payload)
        except AtomSessionGoneError:
            # one-shot reinit then retry
            self._session_id = None
            await self.initialize()
            return await self._post(payload)

    async def _post(self, payload: Dict[str, Any]) -> Any:
        headers = {**REQUIRED_HEADERS, "Mcp-Session-Id": self._session_id or ""}
        r = await self._http.post(self.url, headers=headers,
                                   content=json.dumps(payload))
        if r.status_code in (400, 404) and "Session ID" in r.text:
            raise AtomSessionGoneError(r.text)
        if r.status_code != 200:
            raise AtomProtocolError(
                f"tools/call HTTP {r.status_code}: {r.text[:300]}"
            )
        body = r.json()
        if "error" in body:
            raise AtomProtocolError(
                f"tools/call returned JSON-RPC error: {body['error']}"
            )
        return body.get("result")
