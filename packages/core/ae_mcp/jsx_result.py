"""Shared helper for parsing JSX exec output into a uniform result dict.

All handlers route JSX output through `parse_jsx_result`. It enforces a
weak JSON contract:

- JSON-shaped output ("{..."/`[...`) parses to a dict/list and is returned.
- Empty string or the literal "undefined" / "null" — surfaces as
  `{ok:false, error, raw}`. This catches silent failure modes where the
  wrapping bug or a half-broken template produced no value at all.
- A string beginning with "EvalScript error" (CSInterface's uncaught-error
  sentinel) — surfaces as `{ok:false, error, raw}`. Backstop for the
  jsx-bridge.js sentinel check (see GitHub issue #8).
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


def parse_jsx_result(text: str) -> Any:
    """Parse raw JSX output text into a uniform result dict.

    Returns:
        - dict/list from json.loads when text looks like JSON
        - {ok:false, error, raw} for empty or "undefined"/"null" outputs
        - {ok:true, content:text} for other non-JSON strings (back-compat
          for ae.exec users who return raw strings)
    """
    if not text or text.strip() == "":
        return {
            "ok": False,
            "error": "jsx returned no value (empty output)",
            "raw": text,
        }

    stripped = text.strip()
    if stripped in _NO_VALUE_SENTINELS:
        return {
            "ok": False,
            "error": f"jsx evaluated to {stripped}; ensure your code "
                     "returns JSON.stringify(...) or a value",
            "raw": text,
        }

    # CSInterface returns the literal "EvalScript error." (the constant
    # EvalScript_ErrMessage) when ExtendScript threw uncaught. jsx-bridge.js
    # rejects it, but this is the Python backstop: surface it as a failure
    # rather than wrapping the error message as ok:true content.
    if stripped.startswith("EvalScript error"):
        return {
            "ok": False,
            "error": stripped,
            "raw": text,
        }

    if stripped[:1] in ("{", "["):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

    return {"ok": True, "content": text}
