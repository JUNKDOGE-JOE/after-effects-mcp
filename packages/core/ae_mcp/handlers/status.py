"""Diagnostic status handler exposed even when no backend can be selected."""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from string import Template
from typing import Any

import httpx

from ae_mcp import progress, schemas
from ae_mcp.backends import discovery as _backend_discovery
from ae_mcp.handlers import register
from ae_mcp.jsx_prelude import with_prelude
from ae_mcp.jsx_result import parse_jsx_result as _try_json
from ae_mcp.snapshot import discovery as _snapshot_discovery

try:
    from importlib.metadata import version as _pkg_version
except Exception:  # noqa: BLE001
    _pkg_version = None

log = logging.getLogger("ae_mcp.handlers.status")

_PY_VERSION_HEADER = "x-ae-mcp-python"

try:
    _PY_VERSION = _pkg_version("ae-mcp") if _pkg_version else "unknown"
except Exception:  # noqa: BLE001
    _PY_VERSION = "unknown"


async def _run_status(args: schemas.AeStatusArgs, ctx: Any) -> dict[str, Any]:
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


register("ae.status", schemas.AeStatusArgs, _run_status)


# ---------------------------------------------------------------------------
# ae.diagnose — end-to-end connection self-check for external MCP clients.
#
# ae.status only inspects the Python install (no network). ae.diagnose proves
# the full chain a remote client cares about: host reachable, Python bridge
# handshake seen via /health, auth token readable, AE
# responsive + a project open. Each step is independent — one failure does not
# abort the rest, so a half-wired install gets a full report in one call.
# Exposed even when backend selection fails (server._filtered_tool_names), so a
# broken install can still self-report.
# ---------------------------------------------------------------------------

_DIAGNOSE_TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "jsx_templates" / "diagnose.jsx"


@lru_cache(maxsize=1)
def _diagnose_template() -> Template:
    return Template(_DIAGNOSE_TEMPLATE_PATH.read_text(encoding="utf-8"))


async def _probe_host(url: str) -> dict[str, Any]:
    """Raw GET /health to capture the echoed python handshake fields."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as http:
            r = await http.get(
                f"{url}/health",
                headers={_PY_VERSION_HEADER: _PY_VERSION},
            )
        if r.status_code != 200:
            return {"reachable": False, "error": f"HTTP {r.status_code}"}
        body = r.json()
        if body.get("ok") is not True:
            return {"reachable": False, "error": "health ok != true"}
        return {
            "reachable": True,
            "pluginVersion": body.get("pluginVersion"),
            "port": body.get("port"),
            "pythonVersion": body.get("pythonVersion"),
            "pythonLastSeenAt": body.get("pythonLastSeenAt"),
        }
    except Exception as e:  # noqa: BLE001
        return {"reachable": False, "error": str(e)}


def _looks_like_token_error(message: str) -> bool:
    msg = message.lower()
    return (
        "auth token" in msg
        or "auth-token" in msg
        or "could not read auth" in msg
        or "invalid token" in msg
        or "expired token" in msg
        or "token not found" in msg
        or "token is empty" in msg
        or "http 401" in msg
        or "unauthorized" in msg
        or "forbidden" in msg
    )


async def _run_diagnose(args: schemas.AeDiagnoseArgs, ctx: Any) -> dict[str, Any]:
    del args

    result: dict[str, Any] = {
        "ok": False,
        "host": None,
        "python": None,
        "token": {"valid": False},
        "ae": None,
    }

    # Resolve a backend (best-effort) — diagnose must run even if selection
    # fails, so we catch and report instead of propagating.
    backend = None
    backend_error: str | None = None
    try:
        backend = _backend_discovery.select_backend()
    except Exception as e:  # noqa: BLE001
        backend_error = str(e)
        result["backendError"] = backend_error

    # Step 1: host reachable + python handshake echo. HttpBridge exposes a
    # `.url` so we can GET /health and read the echoed python fields; other
    # backends (e.g. MockBackend in tests) fall back to health_check() bool.
    url = getattr(backend, "url", None) if backend else None
    if url:
        result["host"] = await _probe_host(url)
        pv = result["host"].get("pythonVersion")
        result["python"] = {
            "handshakeSeen": pv is not None,
            "version": pv,
            "lastSeenAt": result["host"].get("pythonLastSeenAt"),
        }
    elif backend is not None:
        try:
            reachable = await backend.health_check(timeout_sec=5.0)
        except Exception as e:  # noqa: BLE001
            result["host"] = {"reachable": False, "error": str(e)}
        else:
            result["host"] = {"reachable": reachable}
        result["python"] = {"handshakeSeen": None}
    else:
        result["host"] = {"reachable": False, "error": backend_error or "no backend"}
        result["python"] = {"handshakeSeen": None}

    # Steps 2 + 3: a single /exec probe proves the token is valid AND AE is
    # responsive, and returns the open project file. Skip if no backend.
    if backend is not None:
        jsx = with_prelude(_diagnose_template().substitute())

        async def _call() -> Any:
            out = await backend.exec(code=jsx, timeout_sec=10.0)
            return _try_json(out)

        try:
            ae_out = await progress.run_with_timeout(
                ctx, _call(), timeout_sec=15.0, start_msg="ae.diagnose..."
            )
            result["token"]["valid"] = True
            result["ae"] = {
                "responsive": bool(ae_out.get("ok")),
                "aeVersion": ae_out.get("aeVersion"),
                "projectFile": ae_out.get("projectFile"),
            }
        except Exception as e:  # noqa: BLE001
            result["ae"] = {"responsive": False, "error": str(e)}
            # A BackendError from _read_token surfaces here — distinguish it so
            # the caller knows the token is the problem, not AE.
            msg = str(e)
            if _looks_like_token_error(msg):
                result["token"]["error"] = msg
            else:
                result["token"]["valid"] = True  # token read ok; AE/host is the issue

    # ok = host reachable AND token valid AND AE responsive.
    result["ok"] = (
        bool(result["host"].get("reachable"))
        and result["token"].get("valid") is True
        and bool(result["ae"] and result["ae"].get("responsive"))
    )
    return result


register("ae.diagnose", schemas.AeDiagnoseArgs, _run_diagnose)
