"""Snapshotter discovery via Python entry points."""
from __future__ import annotations

import importlib.metadata
import logging
from typing import Dict, Optional, Type

from ae_mcp.snapshot.base import Snapshotter


ENTRY_POINT_GROUP = "ae_mcp.snapshotters"
log = logging.getLogger("ae_mcp.snapshot.discovery")


class SnapshotSelectionError(RuntimeError):
    pass


def _scan_entry_points() -> Dict[str, Type[Snapshotter]]:
    eps = importlib.metadata.entry_points(group=ENTRY_POINT_GROUP)
    installed: Dict[str, Type[Snapshotter]] = {}
    for ep in eps:
        try:
            installed[ep.name] = ep.load()
        except Exception as e:  # noqa: BLE001
            log.warning("failed to load snapshotter entry point %s: %s", ep.name, e)
    return installed


def list_installed_snapshotters() -> Dict[str, Type[Snapshotter]]:
    return _scan_entry_points()


def select_snapshotter() -> Optional[Snapshotter]:
    """Return the first usable snapshotter whose supports_platform() is True.

    Returns None if no usable snapshotter is installed or every candidate
    fails to initialize/platform-probe; core uses this to hide ae.snapshot
    from tools/list.
    """
    installed = _scan_entry_points()
    for name, cls in sorted(installed.items()):
        try:
            inst = cls()
        except Exception as e:  # noqa: BLE001
            log.warning("failed to initialize snapshotter %s: %s", name, e)
            continue
        try:
            supported = inst.supports_platform()
        except Exception as e:  # noqa: BLE001
            log.warning("snapshotter %s platform probe failed: %s", name, e)
            continue
        if supported:
            return inst
    return None
