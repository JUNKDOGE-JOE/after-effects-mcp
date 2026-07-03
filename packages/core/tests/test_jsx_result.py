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
    # JSX that returns undefined reaches CSInterface as the literal
    # "undefined", which must be treated as failure rather than content.
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


@pytest.mark.parametrize("payload", ['{"ok":false,"error":"x\x0b"}', '{"a":1'])
def test_json_shaped_but_invalid_text_is_failure(payload: str):
    result = parse_jsx_result(payload)
    assert result["ok"] is False
    assert "failed to parse" in result["error"]
    assert result["raw"] == payload


def test_parsed_ok_false_is_preserved():
    # JSX templates return {ok:false, error:...} as their JSON-encoded error
    # shape. parse_jsx_result must pass that through unchanged.
    payload = '{"ok":false,"error":"no layer"}'
    assert parse_jsx_result(payload) == {"ok": False, "error": "no layer"}


def test_evalscript_error_sentinel_is_failure_not_silent_success():
    # CSInterface surfaces an uncaught ExtendScript error as the literal
    # "EvalScript error." (note the PERIOD). jsx-bridge.js should reject it,
    # but this is the Python backstop: that exact sentinel must flip to
    # ok:false, not be wrapped as content.
    result = parse_jsx_result("EvalScript error.")
    assert result["ok"] is False
    assert result["raw"] == "EvalScript error."
    assert "EvalScript error" in result["error"]


def test_evalscript_error_colon_variant_is_content():
    # Exact matching is intentional: CEP's sentinel has a period, while the
    # colon variant is ordinary diagnostic text that must remain content.
    content = "EvalScript error: ReferenceError foo is undefined"
    assert parse_jsx_result(content) == {"ok": True, "content": content}


def test_evalscript_errors_diagnostic_prefix_is_content():
    content = "EvalScript errors found: 0"
    assert parse_jsx_result(content) == {"ok": True, "content": content}
