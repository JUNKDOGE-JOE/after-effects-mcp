from __future__ import annotations

import httpx
import pytest

from ae_mcp.backends.discovery import BackendSelectionError
from ae_mcp.backends.mock import MockBackend
from ae_mcp.backends.native import NativeInvokeBackend
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.server import _filtered_tool_names


def _load_status_handler():
    load_all()
    schema_cls, run_fn = HANDLERS["ae.status"]
    return schema_cls, run_fn


class NativeMockBackend(MockBackend, NativeInvokeBackend):
    async def negotiate(self, **_kwargs):
        raise AssertionError("status must not negotiate")

    async def capabilities(self, **_kwargs):
        raise AssertionError("status must not read capabilities")

    async def invoke(self, *_args, **_kwargs):
        raise AssertionError("status must not invoke")


@pytest.mark.asyncio
async def test_status_tool_is_only_exposed_when_backend_selection_fails(monkeypatch):
    def _boom():
        raise BackendSelectionError("no backend configured\nTry: pip install ae-mcp-backend-demo")

    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", _boom)
    monkeypatch.setattr("ae_mcp.backends.discovery.list_installed_backends", lambda: {})
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    assert _filtered_tool_names() == {"ae.status", "ae.diagnose"}

    schema_cls, run_fn = _load_status_handler()
    result = await run_fn(schema_cls(), None)

    assert result["ok"] is False
    assert "pip install" in result["backendError"]
    assert result["backend"] is None
    assert result["selectedAdapter"] is None
    assert result["activeExecutionEngine"] is None
    assert result["nativeExecutionPlane"] == {
        "available": False,
        "adapter": None,
        "engine": None,
    }
    assert result["knownExecutionEngines"] == [
        "native-aegp",
        "maintained-jsx",
        "ephemeral-jsx",
    ]


@pytest.mark.asyncio
async def test_status_tool_reports_backend_and_supported_verbs(monkeypatch):
    backend = MockBackend()
    monkeypatch.setattr(backend, "supported_verbs", lambda: {"ae.ping", "ae.snapshot"})
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)
    monkeypatch.setattr("ae_mcp.backends.discovery.list_installed_backends", lambda: {"mock": MockBackend})
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    filtered = _filtered_tool_names()
    assert filtered == {"ae.ping", "ae.status", "ae.diagnose"}

    schema_cls, run_fn = _load_status_handler()
    result = await run_fn(schema_cls(), None)

    assert result["ok"] is True
    assert result["backend"] == "MockBackend"
    assert result["backendError"] is None
    assert result["installedBackends"] == ["mock"]
    assert result["selectedAdapter"] == "legacy-extendscript"
    assert result["activeExecutionEngine"] is None
    assert result["nativeExecutionPlane"]["available"] is False
    assert result["knownExecutionEngines"] == [
        "native-aegp",
        "maintained-jsx",
        "ephemeral-jsx",
    ]


@pytest.mark.asyncio
async def test_status_reports_native_plane_without_claiming_active_routing(monkeypatch):
    backend = NativeMockBackend()
    monkeypatch.setattr(backend, "supported_verbs", lambda: {"ae.ping"})
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)
    monkeypatch.setattr("ae_mcp.backends.discovery.list_installed_backends", lambda: {"mock": NativeMockBackend})
    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", lambda: None)

    assert "ae.projectSummary" in _filtered_tool_names()
    assert "ae.listProjectItems" in _filtered_tool_names()
    assert "ae.listCompositionLayers" in _filtered_tool_names()
    assert "ae.listSelectedLayers" in _filtered_tool_names()
    assert "ae.getCompositionTime" in _filtered_tool_names()
    assert "ae.listLayerProperties" in _filtered_tool_names()
    assert "ae.setLayerPropertyValue" in _filtered_tool_names()
    schema_cls, run_fn = _load_status_handler()
    result = await run_fn(schema_cls(), None)

    assert result["selectedAdapter"] == "legacy-extendscript"
    assert result["activeExecutionEngine"] is None
    assert result["nativeExecutionPlane"] == {
        "available": True,
        "adapter": "NativeMockBackend",
        "engine": "native-aegp",
    }


def test_filtered_tool_names_ignores_snapshotter_selection_exceptions(monkeypatch):
    backend = MockBackend()
    monkeypatch.setattr(backend, "supported_verbs", lambda: {"ae.ping", "ae.snapshot"})
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)

    def _snap_boom():
        raise RuntimeError("snapshotter probe exploded")

    monkeypatch.setattr("ae_mcp.snapshot.discovery.select_snapshotter", _snap_boom)

    assert _filtered_tool_names() == {"ae.ping", "ae.status", "ae.diagnose"}


# ---------------------------------------------------------------------------
# ae.diagnose — end-to-end connection self-check
# ---------------------------------------------------------------------------

def _load_diagnose_handler():
    load_all()
    schema_cls, run_fn = HANDLERS["ae.diagnose"]
    return schema_cls, run_fn


@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("HttpBridge: invalid token", True),
        ("HttpBridge: expired token", True),
        ("HttpBridge: auth-token mismatch", True),
        ("HttpBridge: plugin error: Unexpected token ;", False),
    ],
)
def test_token_error_classifier_keeps_auth_and_syntax_errors_separate(message, expected):
    from ae_mcp.handlers.status import _looks_like_token_error

    assert _looks_like_token_error(message) is expected


@pytest.mark.asyncio
async def test_probe_host_sends_python_identity_header(respx_mock):
    from ae_mcp.handlers.status import _probe_host

    captured = {}

    def _resp(request):
        captured["python"] = request.headers.get("x-ae-mcp-python")
        return httpx.Response(
            200,
            json={
                "ok": True,
                "pluginVersion": "0.9.0",
                "port": 11488,
                "pythonVersion": captured["python"],
                "pythonLastSeenAt": 1719000000000,
            },
        )

    respx_mock.get("http://127.0.0.1:11488/health").mock(side_effect=_resp)

    result = await _probe_host("http://127.0.0.1:11488")

    assert result["reachable"] is True
    assert captured["python"]
    assert result["pythonVersion"] == captured["python"]


@pytest.mark.asyncio
async def test_diagnose_reports_full_chain_when_backend_healthy(monkeypatch):
    import json

    backend = MockBackend()
    backend.set_health(True)
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)

    # The /exec probe returns pong + project file.
    backend.set_response(
        json.dumps({"ok": True, "pong": "pong", "aeVersion": "26.2", "projectFile": "demo.aep"})
    )

    schema_cls, run_fn = _load_diagnose_handler()
    result = await run_fn(schema_cls(), None)

    # MockBackend has no .url, so host reachability comes from health_check().
    assert result["host"]["reachable"] is True
    assert result["token"]["valid"] is True
    assert result["ae"]["responsive"] is True
    assert result["ae"]["projectFile"] == "demo.aep"
    assert result["ae"]["aeVersion"] == "26.2"
    assert result["ok"] is True
    # The diagnose.jsx was actually sent through the bridge.
    assert "pong" in backend.calls[-1]["code"]


@pytest.mark.asyncio
async def test_diagnose_reports_token_error_without_aborting(monkeypatch):
    from ae_mcp.backends.base import BackendError

    backend = MockBackend()
    backend.set_health(True)
    # Simulate a token read failure on /exec.
    async def _exec_boom(code, **kwargs):
        raise BackendError("HttpBridge: auth token not found at ~/.ae-mcp/auth-token. Start the panel.")
    monkeypatch.setattr(backend, "exec", _exec_boom)
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)

    schema_cls, run_fn = _load_diagnose_handler()
    result = await run_fn(schema_cls(), None)

    # Host is reachable, but the token is the problem — and ok reflects it.
    assert result["host"]["reachable"] is True
    assert result["token"]["valid"] is False
    assert "auth token" in result["token"].get("error", "")
    assert result["ok"] is False


@pytest.mark.asyncio
async def test_diagnose_reports_stale_token_unauthorized_as_token_invalid(monkeypatch):
    from ae_mcp.backends.base import BackendError

    backend = MockBackend()
    backend.set_health(True)

    async def _exec_unauthorized(code, **kwargs):
        raise BackendError('HttpBridge: /exec HTTP 401: {"ok":false,"error":"unauthorized"}')

    monkeypatch.setattr(backend, "exec", _exec_unauthorized)
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)

    schema_cls, run_fn = _load_diagnose_handler()
    result = await run_fn(schema_cls(), None)

    assert result["host"]["reachable"] is True
    assert result["token"]["valid"] is False
    assert "unauthorized" in result["token"]["error"]
    assert result["ae"]["responsive"] is False
    assert result["ok"] is False


@pytest.mark.asyncio
async def test_diagnose_treats_non_auth_token_text_as_ae_error(monkeypatch):
    from ae_mcp.backends.base import BackendError

    backend = MockBackend()
    backend.set_health(True)

    async def _exec_syntax_error(code, **kwargs):
        raise BackendError("HttpBridge: plugin error: ExtendScript error: Unexpected token ;")

    monkeypatch.setattr(backend, "exec", _exec_syntax_error)
    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", lambda: backend)

    schema_cls, run_fn = _load_diagnose_handler()
    result = await run_fn(schema_cls(), None)

    assert result["host"]["reachable"] is True
    assert result["token"]["valid"] is True
    assert "error" not in result["token"]
    assert result["ae"]["responsive"] is False
    assert "Unexpected token" in result["ae"]["error"]
    assert result["ok"] is False


@pytest.mark.asyncio
async def test_diagnose_runs_even_when_backend_selection_fails(monkeypatch):
    def _boom():
        raise BackendSelectionError("no backend configured")

    monkeypatch.setattr("ae_mcp.backends.discovery.select_backend", _boom)

    schema_cls, run_fn = _load_diagnose_handler()
    result = await run_fn(schema_cls(), None)

    # No backend -> host/token/ae all unavailable, but the call does not crash.
    assert result["ok"] is False
    assert result["host"]["reachable"] is False
    assert "no backend" in result["host"]["error"]
    assert result["token"]["valid"] is False
    assert result["ae"] is None
