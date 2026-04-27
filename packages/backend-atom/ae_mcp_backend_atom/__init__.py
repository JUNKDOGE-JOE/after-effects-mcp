"""AtomBackend — wraps AtomClient for the ae-mcp Backend interface."""
from __future__ import annotations

import json
import os
from typing import Optional

from ae_mcp.backends.base import Backend, BackendError
from ae_mcp_backend_atom.protocol import AtomClient, AtomProtocolError


class AtomBackend(Backend):
    name = "atom"
    manages_undo = True            # Atom auto-wraps undo group around tools/call
    manages_checkpoints = True     # Atom auto-creates checkpoints

    def __init__(self, url: str) -> None:
        self.url = url
        self._client = AtomClient(url)

    @classmethod
    def from_env(cls) -> "AtomBackend":
        url = os.environ.get("ATOM_MCP_URL", "http://127.0.0.1:11487/mcp")
        return cls(url=url)

    async def health_check(self, timeout_sec: float = 5.0) -> bool:
        try:
            out = await self.exec(
                code='JSON.stringify({ok:true,ping:"pong"})',
                timeout_sec=timeout_sec,
            )
            return "pong" in out
        except Exception:  # noqa: BLE001
            return False

    async def exec(self, code, *, undo_group=None, checkpoint_label=None, timeout_sec=30.0):
        try:
            result = await self._client.call_tool(
                "run_extendscript",
                {"code": code},
            )
        except AtomProtocolError as e:
            raise BackendError(f"AtomBackend: {e}") from e

        # Atom returns {"content": [{"type": "text", "text": "..."}], "isError": ...}
        if isinstance(result, dict):
            content = result.get("content", [])
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    return item.get("text", "")
        return json.dumps(result) if result is not None else ""

    async def shutdown(self):
        await self._client.aclose()
