"""Unit tests for AtomClient using respx mock transport."""
import json
import pytest
import respx
from httpx import Response

from ae_mcp_backend_atom.protocol import AtomClient, AtomProtocolError, AtomSessionGoneError


@pytest.mark.asyncio
async def test_initialize_captures_session_id():
    async with respx.mock(base_url="http://127.0.0.1:11487") as mock:
        # initialize call
        mock.post("/mcp").mock(side_effect=[
            Response(200,
                     headers={"Mcp-Session-Id": "abc123"},
                     json={"jsonrpc": "2.0", "id": "x", "result": {"capabilities": {}}}),
            Response(202),  # notifications/initialized
        ])
        c = AtomClient("http://127.0.0.1:11487/mcp")
        try:
            await c.initialize()
            assert c._session_id == "abc123"
        finally:
            await c.aclose()


@pytest.mark.asyncio
async def test_call_tool_returns_result():
    async with respx.mock(base_url="http://127.0.0.1:11487") as mock:
        mock.post("/mcp").mock(side_effect=[
            Response(200,
                     headers={"Mcp-Session-Id": "sid"},
                     json={"jsonrpc": "2.0", "id": "x", "result": {}}),
            Response(202),
            Response(200,
                     json={"jsonrpc": "2.0", "id": "y",
                           "result": {"content": [{"type": "text", "text": "hello"}]}}),
        ])
        c = AtomClient("http://127.0.0.1:11487/mcp")
        try:
            r = await c.call_tool("run_extendscript", {"code": "1+1"})
            assert r == {"content": [{"type": "text", "text": "hello"}]}
        finally:
            await c.aclose()


@pytest.mark.asyncio
async def test_stale_session_triggers_reinit():
    """First call returns 400 'Session ID required'; client reinits and retries."""
    async with respx.mock(base_url="http://127.0.0.1:11487") as mock:
        mock.post("/mcp").mock(side_effect=[
            # first init
            Response(200, headers={"Mcp-Session-Id": "old"}, json={"result": {}}),
            Response(202),
            # call_tool: stale
            Response(400, text='{"error":{"message":"Session ID required"}}'),
            # reinit
            Response(200, headers={"Mcp-Session-Id": "new"}, json={"result": {}}),
            Response(202),
            # retry succeeds
            Response(200, json={"result": {"content": [{"type": "text", "text": "ok"}]}}),
        ])
        c = AtomClient("http://127.0.0.1:11487/mcp")
        try:
            r = await c.call_tool("run_extendscript", {"code": "1"})
            assert r["content"][0]["text"] == "ok"
            assert c._session_id == "new"
        finally:
            await c.aclose()


@pytest.mark.asyncio
async def test_non_200_raises_protocol_error():
    async with respx.mock(base_url="http://127.0.0.1:11487") as mock:
        mock.post("/mcp").mock(return_value=Response(500, text="boom"))
        c = AtomClient("http://127.0.0.1:11487/mcp")
        try:
            with pytest.raises(AtomProtocolError):
                await c.initialize()
        finally:
            await c.aclose()
