"""Unit tests for HttpBridge using respx."""
import pytest
import respx
from httpx import Response

from ae_mcp_bridge import HttpBridge


def test_from_env_default_url(monkeypatch):
    monkeypatch.delenv("AE_MCP_PLUGIN_URL", raising=False)
    b = HttpBridge.from_env()
    assert b.url == "http://127.0.0.1:11488"


def test_from_env_custom_url(monkeypatch):
    monkeypatch.setenv("AE_MCP_PLUGIN_URL", "http://localhost:9999")
    b = HttpBridge.from_env()
    assert b.url == "http://localhost:9999"


def test_strips_trailing_slash():
    b = HttpBridge(url="http://localhost:11488/")
    assert b.url == "http://localhost:11488"


def test_capability_flags():
    assert HttpBridge.manages_undo is False
    assert HttpBridge.manages_checkpoints is False


def test_name():
    assert HttpBridge.name == "ae-mcp"


@pytest.mark.asyncio
async def test_health_check_ok():
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.get("/health").mock(return_value=Response(200, json={"ok": True}))
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            assert await b.health_check() is True
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_health_check_failure():
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.get("/health").mock(return_value=Response(500))
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            assert await b.health_check() is False
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_health_check_connection_error():
    b = HttpBridge("http://127.0.0.1:1")  # nothing listening
    try:
        assert await b.health_check(timeout_sec=1.0) is False
    finally:
        await b.shutdown()


@pytest.mark.asyncio
async def test_exec_returns_result():
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/exec").mock(
            return_value=Response(200, json={"ok": True, "result": "42"})
        )
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            r = await b.exec("40+2")
            assert r == "42"
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_exec_propagates_plugin_error():
    from ae_mcp.backends.base import BackendError
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/exec").mock(
            return_value=Response(200, json={"ok": False, "error": "syntax err"})
        )
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            with pytest.raises(BackendError) as ei:
                await b.exec("bogus")
            assert "syntax err" in str(ei.value)
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_exec_propagates_http_error():
    from ae_mcp.backends.base import BackendError
    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/exec").mock(return_value=Response(500, text="boom"))
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            with pytest.raises(BackendError):
                await b.exec("1")
        finally:
            await b.shutdown()


@pytest.mark.asyncio
async def test_exec_passes_undo_and_checkpoint_label():
    captured = {}
    async def _resp(request):
        import json
        captured["body"] = json.loads(request.content)
        return Response(200, json={"ok": True, "result": ""})

    async with respx.mock(base_url="http://127.0.0.1:11488") as mock:
        mock.post("/exec").mock(side_effect=_resp)
        b = HttpBridge("http://127.0.0.1:11488")
        try:
            await b.exec("foo", undo_group="g", checkpoint_label="lab", timeout_sec=10.0)
        finally:
            await b.shutdown()

    assert captured["body"]["code"] == "foo"
    assert captured["body"]["undoGroup"] == "g"
    assert captured["body"]["checkpointLabel"] == "lab"
    assert captured["body"]["timeoutMs"] == 10000
