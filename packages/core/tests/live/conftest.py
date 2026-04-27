"""Live test fixtures — opt-in only, requires real AE + aebm plugin.

Set AEBM_LIVE_TESTS=1 to run. Without that env var every test in this
directory skips. Live tests do real pwsh subprocess + AE roundtrips, and
are NOT run in CI (hosted runners cannot drive a GUI Adobe app).
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from ae_mcp import bridge


def _live_enabled() -> bool:
    return os.environ.get("AEBM_LIVE_TESTS") == "1"


@pytest.fixture(scope="session", autouse=True)
def _live_gate():
    if not _live_enabled():
        pytest.skip("live tests are opt-in: export AEBM_LIVE_TESTS=1")


@pytest.fixture(scope="session")
def live_bridge():
    """Verify AE is reachable; if not, fail the whole session early."""
    async def _ping() -> str:
        return await bridge.invoke_ae_exec(
            code='JSON.stringify({ok:true,pong:"pong"})',
            timeout_sec=15.0,
        )

    try:
        out = asyncio.run(_ping())
    except Exception as e:  # noqa: BLE001
        pytest.fail(
            f"live handshake failed: {e}. "
            f"Verify AE is running, the aebm panel is loaded, and "
            f"AE_BRIDGE_ROOT is set."
        )

    if "pong" not in out:
        pytest.fail(f"live handshake returned unexpected output: {out!r}")

    return bridge


@pytest.fixture
def clean_project(live_bridge):
    """New project before each test, close after. Used by mutation tests."""
    setup = (
        "(function(){"
        "try{app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);}catch(e){}"
        "app.newProject();"
        "return JSON.stringify({ok:true});"
        "})()"
    )
    asyncio.run(live_bridge.invoke_ae_exec(code=setup, timeout_sec=15.0))
    yield live_bridge
    teardown = (
        "(function(){"
        "try{app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);}catch(e){}"
        "return JSON.stringify({ok:true});"
        "})()"
    )
    try:
        asyncio.run(live_bridge.invoke_ae_exec(code=teardown, timeout_sec=10.0))
    except Exception:
        pass  # best-effort teardown


@pytest.fixture
def artifact_dir(request, tmp_path_factory):
    """Per-test artifact directory under tests/live/_artifacts/<test_name>/."""
    name = request.node.name.replace("/", "_").replace("[", "_").replace("]", "_")
    d = Path(__file__).parent / "_artifacts" / name
    d.mkdir(parents=True, exist_ok=True)
    return d
