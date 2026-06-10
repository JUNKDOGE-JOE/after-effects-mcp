"""Diagnostic status handler exposed even when no backend can be selected."""

from __future__ import annotations

import logging
from typing import Any

from ae_mcp.backends import discovery as _backend_discovery
from ae_mcp.handlers import register
from ae_mcp.schemas import AeStatusArgs
from ae_mcp.snapshot import discovery as _snapshot_discovery

log = logging.getLogger("ae_mcp.handlers.status")


async def _run_status(args: AeStatusArgs, ctx: Any) -> dict[str, Any]:
    del args, ctx

    result: dict[str, Any] = {
        "ok": False,
        "backend": None,
        "backendError": None,
        "installedBackends": [],
        "snapshotter": None,
    }

    try:
        installed = _backend_discovery.list_installed_backends()
    except Exception as e:  # noqa: BLE001
        log.warning("backend install scan failed: %s", e)
        result["installScanError"] = str(e)
    else:
        result["installedBackends"] = sorted(installed.keys())

    try:
        backend = _backend_discovery.select_backend()
    except Exception as e:  # noqa: BLE001
        result["backendError"] = str(e)
    else:
        result["ok"] = True
        result["backend"] = backend.__class__.__name__

    try:
        snapshotter = _snapshot_discovery.select_snapshotter()
    except Exception as e:  # noqa: BLE001
        log.warning("snapshotter status probe failed: %s", e)
    else:
        if snapshotter is not None:
            result["snapshotter"] = snapshotter.__class__.__name__

    return result


register("ae.status", AeStatusArgs, _run_status)
