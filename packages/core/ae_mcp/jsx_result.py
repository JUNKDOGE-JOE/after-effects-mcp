"""Shared helper for parsing JSX exec output into a uniform result dict.

All handlers route JSX output through `parse_jsx_result`. It enforces a
weak JSON contract:

- JSON-shaped output ("{..."/`[...`) parses to a dict/list and is returned.
- Empty string or the literal "undefined" / "null" — surfaces as
  `{ok:false, error, raw}`. This catches silent failure modes where the
  wrapping bug or a half-broken template produced no value at all.
- A string exactly equal to "EvalScript error." (CSInterface's uncaught-error
  sentinel) — surfaces as `{ok:false, error, raw}`. Backstop for the
  jsx-bridge.js sentinel check (see GitHub issues #8 and #23). A legitimate
  string exactly equal to that in-band sentinel cannot be distinguished from
  CEP's uncaught-error signal; CEP provides only that one in-band value.
- JSON-shaped text that fails `json.loads` — surfaces as `{ok:false, error,
  raw}` rather than falling through to silent success.
- Other non-JSON text — returned as `{ok:true, content:text}` because some
  callers intentionally use ae.exec to fetch a string.

History: the previous helpers (one per handler file: core/typed/rig/skills)
all wrapped *any* non-JSON output — including empty and "undefined" — as
`{ok:true, content:...}`. That hid the multi-statement undo-group wrap bug
(see plugin/host/server.js wrapWithUndoGroup) for a long time: AE did
nothing, MCP reported success. PR #1 fixed the wrap; this module makes the
detection mode permanent.
"""
from __future__ import annotations

import json
from typing import Any


_NO_VALUE_SENTINELS = frozenset({"undefined", "null"})

# Must equal EvalScript_ErrMessage in plugin/client/CSInterface.js:33 (vendored
# Adobe constant) and EVALSCRIPT_ERR_SENTINEL in plugin/host/jsx-bridge.js.
_EVALSCRIPT_ERR_SENTINEL = "EvalScript error."


def _fail(error: str, raw: str) -> dict[str, str | bool]:
    return {"ok": False, "error": error, "raw": raw}


def parse_jsx_result(text: str) -> Any:
    """Parse raw JSX output text into a uniform result dict.

    Returns:
        - dict/list from json.loads when text looks like JSON
        - {ok:false, error, raw} for empty or "undefined"/"null" outputs
        - {ok:false, error, raw} for JSON-shaped text that fails to parse
        - {ok:true, content:text} for other non-JSON strings (back-compat
          for ae.exec users who return raw strings)
    """
    if not text or text.strip() == "":
        return _fail("jsx returned no value (empty output)", text)

    stripped = text.strip()
    if stripped in _NO_VALUE_SENTINELS:
        return _fail(
            f"jsx evaluated to {stripped}; ensure your code returns JSON.stringify(...) or a value",
            text,
        )

    # CSInterface returns the literal "EvalScript error." (the constant
    # EvalScript_ErrMessage in plugin/client/CSInterface.js:33) when ExtendScript
    # threw uncaught. plugin/host/jsx-bridge.js rejects EVALSCRIPT_ERR_SENTINEL,
    # but this is the Python backstop: surface the exact sentinel as a failure
    # rather than wrapping it as ok:true content.
    if stripped == _EVALSCRIPT_ERR_SENTINEL:
        return _fail(stripped, text)

    if stripped[:1] in ("{", "["):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError as e:
            return _fail(f"jsx returned JSON-like text that failed to parse: {e}", text)

    return {"ok": True, "content": text}
