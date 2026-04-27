"""Snapshotter discovery via Python entry points."""
from __future__ import annotations

import importlib.metadata
from typing import Dict, Optional, Type

from ae_mcp.snapshot.base import Snapshotter


ENTRY_POINT_GROUP = "ae_mcp.snapshotters"


class SnapshotSelectionError(RuntimeError):
    pass


def _scan_entry_points() -> Dict[str, Type[Snapshotter]]:
    eps = importlib.metadata.entry_points(group=ENTRY_POINT_GROUP)
    return {ep.name: ep.load() for ep in eps}


def list_installed_snapshotters() -> Dict[str, Type[Snapshotter]]:
    return _scan_entry_points()


def select_snapshotter() -> Optional[Snapshotter]:
    """Return the first snapshotter whose supports_platform() is True.

    Returns None if no usable snapshotter is installed; core uses this
    to hide ae.snapshot from tools/list.
    """
    installed = _scan_entry_points()
    for name, cls in sorted(installed.items()):
        inst = cls()
        if inst.supports_platform():
            return inst
    return None
