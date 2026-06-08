"""Exposed MCP tool names must satisfy the spec's name pattern.

The MCP spec (and strict clients such as Claude Desktop extensions) require
tool names to match ``^[a-zA-Z0-9_-]{1,64}$``. Verbs are dotted internally
("ae.ping"), so the server must expose dot-free names ("ae_ping") and map them
back on call.
"""
from __future__ import annotations

import re

from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.server import expose_tool_name, resolve_tool_name

_MCP_TOOL_NAME = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def test_expose_tool_name_strips_dots():
    assert expose_tool_name("ae.ping") == "ae_ping"
    assert expose_tool_name("ae.scanPropertyTree") == "ae_scanPropertyTree"
    # Already dot-free names are unchanged.
    assert expose_tool_name("ae_ping") == "ae_ping"


def test_every_exposed_verb_matches_mcp_pattern():
    load_all()
    assert HANDLERS, "handlers registry should be populated"
    for verb in HANDLERS:
        exposed = expose_tool_name(verb)
        assert _MCP_TOOL_NAME.fullmatch(exposed), f"{verb!r} -> {exposed!r} is not MCP-compliant"


def test_resolve_round_trips_for_every_verb():
    load_all()
    for verb in HANDLERS:
        exposed = expose_tool_name(verb)
        # Exposed (dot-free) name resolves back to the canonical verb...
        assert resolve_tool_name(exposed, HANDLERS) == verb
        # ...and the original dotted name is still accepted (backward compat).
        assert resolve_tool_name(verb, HANDLERS) == verb


def test_resolve_unknown_returns_none():
    load_all()
    assert resolve_tool_name("does_not_exist", HANDLERS) is None
    assert resolve_tool_name("ae.unknownVerb", HANDLERS) is None
