"""Backend discovery via Python entry points."""
from __future__ import annotations

import importlib.metadata
import os
from typing import Dict, Optional, Type

from ae_mcp.backends.base import Backend


ENTRY_POINT_GROUP = "ae_mcp.backends"


class BackendSelectionError(RuntimeError):
    """Raised when no usable backend can be chosen."""


def _scan_entry_points() -> Dict[str, Type[Backend]]:
    """Indirection so tests can monkey-patch this without touching real EP."""
    eps = importlib.metadata.entry_points(group=ENTRY_POINT_GROUP)
    return {ep.name: ep.load() for ep in eps}


def list_installed_backends() -> Dict[str, Type[Backend]]:
    """Return {backend_name: backend_class} for every installed backend."""
    return _scan_entry_points()


def select_backend() -> Backend:
    """Choose and instantiate the active backend per AE_MCP_BACKEND env var."""
    installed = _scan_entry_points()
    requested: Optional[str] = os.environ.get("AE_MCP_BACKEND") or None

    if requested:
        if requested not in installed:
            installed_names = sorted(installed) or ["(none)"]
            raise BackendSelectionError(
                f"AE_MCP_BACKEND={requested!r} but no such backend installed.\n"
                f"  Installed backends: {installed_names}\n"
                f"  Try: pip install ae-mcp-backend-{requested}\n"
                f"  Or fix AE_MCP_BACKEND to one of the installed names."
            )
        return installed[requested].from_env()

    if not installed:
        raise BackendSelectionError(
            "no AE backend installed.\n"
            "  Install one of:\n"
            "    pip install ae-mcp-backend-aebm    (for AEBMethod plugin)\n"
            "    pip install ae-mcp-backend-atom    (for Atom plugin)\n"
            "  Or write your own backend (see Backend Author Guide — "
            "deferred to spec 3c)."
        )

    if len(installed) == 1:
        only_cls = next(iter(installed.values()))
        return only_cls.from_env()

    raise BackendSelectionError(
        f"multiple backends installed: {sorted(installed)}.\n"
        f"  Set AE_MCP_BACKEND=<name> to choose one."
    )
