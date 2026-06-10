"""Backend discovery via Python entry points."""
from __future__ import annotations

import importlib.metadata
import os
from typing import Dict, Optional, Type

from ae_mcp.backends.base import Backend


ENTRY_POINT_GROUP = "ae_mcp.backends"

# Known backend entry-point name -> the PyPI/distribution package that provides
# it. The entry-point name and the package name differ (e.g. the "ae-mcp"
# backend lives in the "ae-mcp-bridge" package), so a naive
# "pip install ae-mcp-backend-<name>" hint points at a package that does not
# exist. Keep this in sync with the entry_points declared by the backend
# packages' pyprojects.
_KNOWN_BACKEND_PACKAGES = {
    "ae-mcp": "ae-mcp-bridge",
}


def _install_hint(requested: str) -> str:
    """Return an accurate `pip install` hint for a requested backend name.

    Uses the known entry-point -> package mapping when available; otherwise
    falls back to advising the user to consult their plugin's docs (we cannot
    guess an arbitrary third-party package name)."""
    pkg = _KNOWN_BACKEND_PACKAGES.get(requested)
    if pkg:
        return f"Try: pip install {pkg}"
    return (
        "Install the backend package that provides this name "
        "(see your AE plugin's docs for the package name)."
    )


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
                f"  {_install_hint(requested)}\n"
                f"  Or fix AE_MCP_BACKEND to one of the installed names."
            )
        return installed[requested].from_env()

    if not installed:
        raise BackendSelectionError(
            "no AE backend installed.\n"
            "  ae-mcp ships no concrete backend; pip install a third-party\n"
            "  one matching your AE plugin (see your plugin's docs for the\n"
            "  package name), or write your own (Backend Author Guide —\n"
            "  deferred to spec 3c)."
        )

    if len(installed) == 1:
        only_cls = next(iter(installed.values()))
        return only_cls.from_env()

    raise BackendSelectionError(
        f"multiple backends installed: {sorted(installed)}.\n"
        f"  Set AE_MCP_BACKEND=<name> to choose one."
    )
