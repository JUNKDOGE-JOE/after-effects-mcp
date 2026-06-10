"""HTTP bridge between ae-mcp MCP server and the ae-mcp CEP plugin."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

import httpx

from ae_mcp.backends.base import Backend, BackendError

# Header carrying the shared-secret token on /exec requests. Must match the
# header the Node host (plugin/host/server.js) checks.
_TOKEN_HEADER = "X-AE-MCP-Token"


def _token_path() -> Path:
    """Per-user token file shared with the Node host. Must match the path the
    panel writes (~/.ae-mcp/auth-token)."""
    return Path.home() / ".ae-mcp" / "auth-token"


class HttpBridge(Backend):
    name = "ae-mcp"
    manages_undo = False
    manages_checkpoints = False

    def __init__(self, url: str) -> None:
        self.url = url.rstrip("/")
        # Cache the token after the first successful read so we don't hit the
        # filesystem on every exec.
        self._token: Optional[str] = None

    @classmethod
    def from_env(cls) -> "HttpBridge":
        url = os.environ.get("AE_MCP_PLUGIN_URL", "http://127.0.0.1:11488")
        return cls(url=url)

    def _read_token(self) -> str:
        """Read (and cache) the shared-secret token. Fail closed with a clear
        message if the file is missing — the panel generates it on startup, so a
        missing file means the panel hasn't been started/installed."""
        if self._token is not None:
            return self._token
        path = _token_path()
        try:
            token = path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            raise BackendError(
                "HttpBridge: auth token not found at "
                f"{path}. Start (or reinstall) the ae-mcp panel in After "
                "Effects so it can generate the token, then retry."
            ) from None
        except OSError as e:
            raise BackendError(
                f"HttpBridge: could not read auth token at {path}: {e}"
            ) from e
        if not token:
            raise BackendError(
                f"HttpBridge: auth token at {path} is empty. Restart the "
                "ae-mcp panel to regenerate it."
            )
        self._token = token
        return token

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        # /health is unauthenticated (it executes no code), so no token needed.
        try:
            async with httpx.AsyncClient(timeout=timeout_sec) as http:
                r = await http.get(f"{self.url}/health")
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
        # Fail closed: if the token can't be read, raise before making the call.
        token = self._read_token()
        payload = {
            "code": code,
            "undoGroup": undo_group,
            "checkpointLabel": checkpoint_label,
            "timeoutMs": int(timeout_sec * 1000),
        }
        headers = {_TOKEN_HEADER: token}
        try:
            async with httpx.AsyncClient(timeout=timeout_sec + 5.0) as http:
                r = await http.post(
                    f"{self.url}/exec", json=payload, headers=headers
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
        return None
