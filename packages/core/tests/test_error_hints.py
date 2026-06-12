from __future__ import annotations

import json

import pytest

from ae_mcp.error_hints import append_hint
from ae_mcp.jsx_result import parse_jsx_result
from ae_mcp.server import build_server


def test_append_hint_for_temporal_ease_zh_message():
    error = '由于参数 2，无法调用"setTemporalEaseAtKey"。值数组没有 3 元素。'

    hinted = append_hint(error)

    assert "[hint]" in hinted
    assert "AEMCP.easeKeys(prop)" in hinted


def test_append_hint_for_null_lookup_zh_message():
    hinted = append_hint("TypeError: null 不是对象 (line 4)")

    assert "[hint]" in hinted
    assert "AEMCP.mustFind(value, name)" in hinted


def test_append_hint_for_missing_api_zh_message():
    hinted = append_hint("ReferenceError: 函数 app.project.items.byName 未定义")

    assert "[hint]" in hinted
    assert "verify with a read tool" in hinted


def test_append_hint_leaves_unknown_errors_unchanged():
    error = "plain unrelated error"

    assert append_hint(error) == error


def test_append_hint_is_idempotent():
    error = "TypeError: null is not an object\n[hint] already appended"

    assert append_hint(error) == error


def test_parse_jsx_result_empty_error_has_no_hint():
    result = parse_jsx_result("")

    assert result["ok"] is False
    assert "[hint]" not in result["error"]


@pytest.mark.parametrize(
    ("message", "anchor"),
    [
        ("TypeError: null 不是对象 (line 4)", "AEMCP.mustFind(value, name)"),
        (
            '由于参数 2，无法调用"setTemporalEaseAtKey"。值数组没有 1 元素。',
            "AEMCP.easeKeys(prop)",
        ),
        (
            "ReferenceError: 函数 app.project.items.byName 未定义",
            "verify with a read tool",
        ),
    ],
)
@pytest.mark.asyncio
async def test_handler_exception_payload_appends_hints_for_real_error_samples(
    monkeypatch, message: str, anchor: str
):
    from ae_mcp import server as server_module

    class Args:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        @classmethod
        def model_json_schema(cls):
            return {"type": "object", "properties": {}}

    async def fail(_args, _ctx):
        raise RuntimeError(f"HttpBridge: plugin error: {message}")

    monkeypatch.setattr(server_module, "HANDLERS", {"ae.exec": (Args, fail)})
    server = build_server()

    result = await server._ae_call_tool("ae_exec", {})
    payload = json.loads(result.content[0].text)

    assert result.isError is True
    assert payload["ok"] is False
    assert "[hint]" in payload["error"]
    assert anchor in payload["error"]


@pytest.mark.asyncio
async def test_ok_false_handler_result_payload_appends_hint(monkeypatch):
    from ae_mcp import server as server_module

    class Args:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        @classmethod
        def model_json_schema(cls):
            return {"type": "object", "properties": {}}

    async def fail_result(_args, _ctx):
        return {"ok": False, "error": "TypeError: null 不是对象 (line 4)"}

    monkeypatch.setattr(server_module, "HANDLERS", {"ae.exec": (Args, fail_result)})
    server = build_server()

    result = await server._ae_call_tool("ae_exec", {})
    payload = json.loads(result.content[0].text)

    assert result.isError is True
    assert "[hint]" in payload["error"]
    assert "AEMCP.mustFind(value, name)" in payload["error"]


def test_ok_false_json_result_is_preserved_for_upper_layer_hinting():
    payload = '{"ok":false,"error":"TypeError: null 不是对象 (line 4)"}'

    assert parse_jsx_result(payload) == {
        "ok": False,
        "error": "TypeError: null 不是对象 (line 4)",
    }
