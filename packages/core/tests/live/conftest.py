"""Live test fixtures — opt-in only, requires real AE + a backend reachable."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest

from ae_mcp.backends.discovery import select_backend


def _live_enabled() -> bool:
    return os.environ.get("AE_MCP_LIVE_TESTS") == "1"


@pytest.fixture(scope="session", autouse=True)
def _live_gate():
    if not _live_enabled():
        pytest.skip("live tests are opt-in: export AE_MCP_LIVE_TESTS=1")


@pytest.fixture(scope="session")
def live_backend():
    """Backend selected by AE_MCP_BACKEND; verify reachable, fail session early if not."""
    try:
        backend = select_backend()
    except Exception as e:  # noqa: BLE001
        pytest.fail(f"live: backend selection failed: {e}")

    healthy = asyncio.run(backend.health_check(timeout_sec=10.0))
    if not healthy:
        pytest.fail(
            f"live: backend {backend.name!r} health_check failed. "
            f"Is AE running with the matching plugin loaded?"
        )
    yield backend
    asyncio.run(backend.shutdown())


@pytest.fixture
def clean_project(live_backend):
    setup = (
        '(function(){'
        'try{app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);}catch(e){}'
        'app.newProject();'
        'return JSON.stringify({ok:true});'
        '})()'
    )
    asyncio.run(live_backend.exec(code=setup, timeout_sec=15.0))
    yield live_backend
    teardown = (
        '(function(){'
        'try{app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);}catch(e){}'
        'return JSON.stringify({ok:true});'
        '})()'
    )
    try:
        asyncio.run(live_backend.exec(code=teardown, timeout_sec=10.0))
    except Exception:
        pass


@pytest.fixture
def artifact_dir(request):
    name = request.node.name.replace("/", "_").replace("[", "_").replace("]", "_")
    d = Path(__file__).parent / "_artifacts" / name
    d.mkdir(parents=True, exist_ok=True)
    return d
