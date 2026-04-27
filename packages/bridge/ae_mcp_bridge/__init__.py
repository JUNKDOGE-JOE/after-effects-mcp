"""HTTP bridge between ae-mcp MCP server and the ae-mcp CEP plugin."""
from __future__ import annotations

import os
from typing import Optional

import httpx

from ae_mcp.backends.base import Backend, BackendError


class HttpBridge(Backend):
    name = "ae-mcp"
    manages_undo = False
    manages_checkpoints = False

    def __init__(self, url: str) -> None:
        self.url = url.rstrip("/")
        self._http = httpx.AsyncClient(timeout=30.0)

    @classmethod
    def from_env(cls) -> "HttpBridge":
        url = os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488")
        return cls(url=url)

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        try:
            r = await self._http.get(f"{self.url}/health", timeout=timeout_sec)
            return r.status_code == 200 and r.json().get("ok") is True
        except Exception:  # noqa: BLE001
            return False

    async def exec(
        self,
        code: str,
        *,
        undo_group: Optional[str] = None,
        checkpoint_label: Optional[str] = None,
        timeout_sec: float = 30.0,
    ) -> str:
        payload = {
            "code": code,
            "undoGroup": undo_group,
            "checkpointLabel": checkpoint_label,
            "timeoutMs": int(timeout_sec * 1000),
        }
        try:
            r = await self._http.post(
                f"{self.url}/exec",
                json=payload,
                timeout=timeout_sec + 5.0,
            )
        except httpx.HTTPError as e:
            raise BackendError(f"HttpBridge: HTTP error: {e}") from e

        if r.status_code != 200:
            raise BackendError(
                f"HttpBridge: /exec HTTP {r.status_code}: {r.text[:300]}"
            )
        body = r.json()
        if not body.get("ok"):
            raise BackendError(f"HttpBridge: plugin error: {body.get('error')}")
        return body.get("result", "")

    async def shutdown(self) -> None:
        await self._http.aclose()
