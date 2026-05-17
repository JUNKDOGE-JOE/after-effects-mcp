"""Tests for jsx_result.parse_jsx_result — the strict JSX→dict contract.

History: the per-handler `_try_json` predecessors all silently wrapped any
non-JSON output (including empty and the literal "undefined") as
`{ok:true, content:...}`. That masked the multi-statement undo-group wrap
bug (PR #1) — JSX did nothing, MCP reported success. parse_jsx_result
surfaces those silent-failure shapes as `ok:false` so future regressions
are caught at the boundary.
"""
from __future__ import annotations

import pytest

from ae_mcp.jsx_result import parse_jsx_result


def test_parses_object_json():
    assert parse_jsx_result('{"ok":true,"value":42}') == {"ok": True, "value": 42}


def test_parses_array_json():
    assert parse_jsx_result('[1,2,3]') == [1, 2, 3]


def test_parses_json_with_leading_whitespace():
    assert parse_jsx_result('  \n  {"ok":true}') == {"ok": True}


def test_empty_string_is_failure_not_silent_success():
    result = parse_jsx_result("")
    assert result["ok"] is False
    assert "empty" in result["error"].lower()
    assert result["raw"] == ""


def test_whitespace_only_is_failure():
    result = parse_jsx_result("   \n  ")
    assert result["ok"] is False
    assert "empty" in result["error"].lower()


def test_undefined_literal_is_failure_not_silent_success():
    # This is the exact symptom from the pre-PR-#1 wrap bug:
    # JSX returned undefined → CSInterface returned the literal "undefined".
    result = parse_jsx_result("undefined")
    assert result["ok"] is False
    assert "undefined" in result["error"]
    assert result["raw"] == "undefined"


def test_null_literal_is_failure():
    result = parse_jsx_result("null")
    assert result["ok"] is False
    assert "null" in result["error"]


def test_non_json_text_returned_as_content_for_back_compat():
    # ae.exec users may intentionally write JSX that returns a plain string.
    # We don't want to break that — only the obvious silent-failure shapes
    # (empty/undefined/null) flip to ok:false.
    result = parse_jsx_result("hello world")
    assert result == {"ok": True, "content": "hello world"}


def test_invalid_json_falls_back_to_content_wrap():
    # JSX returned something that LOOKS JSON-ish but isn't parseable.
    result = parse_jsx_result('{not really json')
    assert result == {"ok": True, "content": "{not really json"}


def test_parsed_ok_false_is_preserved():
    # JSX templates return {ok:false, error:...} as their JSON-encoded error
    # shape. parse_jsx_result must pass that through unchanged.
    payload = '{"ok":false,"error":"no layer"}'
    assert parse_jsx_result(payload) == {"ok": False, "error": "no layer"}
