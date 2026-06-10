"""The MCP server advertises ae-mcp operating guidance at handshake."""
from __future__ import annotations

import logging

from ae_mcp.instructions import SERVER_INSTRUCTIONS
from ae_mcp.server import build_server


def test_instructions_nonempty_and_substantial():
    assert isinstance(SERVER_INSTRUCTIONS, str)
    assert len(SERVER_INSTRUCTIONS) > 400


def test_instructions_cover_key_discipline():
    text = SERVER_INSTRUCTIONS
    # Phased workflow + the verbs an agent must know about. The instructions
    # name verbs by their EXPOSED (underscore) form — strict clients can only
    # call the advertised names (issue #4).
    assert "ae_init" in text
    assert "ae_validateExpressions" in text
    assert "ae_previewFrame" in text
    # ES3 discipline + the runtime helpers we ship.
    assert "ECMAScript 3" in text
    assert "AEMCP.propByMatchPath" in text
    # Never-throw safety invariant.
    assert "NEVER let JSX throw" in text


def test_instructions_use_underscore_verb_names_not_dotted():
    """Issue #4: model-facing guidance must not feed the model dotted verb
    names it can't call on strict clients. No dotted ``ae.<verb>`` token may
    appear in the instructions (AEMCP.* helper calls are not verbs)."""
    import re

    dotted = re.findall(r"\bae\.[a-zA-Z]\w*", SERVER_INSTRUCTIONS)
    assert dotted == [], f"instructions still name dotted verbs: {sorted(set(dotted))}"


def test_build_server_advertises_instructions():
    server = build_server()
    assert server.instructions == SERVER_INSTRUCTIONS
    opts = server.create_initialization_options()
    assert opts.instructions == SERVER_INSTRUCTIONS


def test_filtered_tool_names_logs_when_backend_selection_fails(monkeypatch, caplog):
    """A failing backend must yield an empty tool list AND a WARNING log —
    not a silent empty set (issue #8). Previously the bare `except` swallowed
    the error with zero diagnostic."""
    from ae_mcp.backends import discovery as _discovery
    from ae_mcp import server as _server

    def _boom():
        raise _discovery.BackendSelectionError("no backend configured")

    monkeypatch.setattr(_discovery, "select_backend", _boom)

    with caplog.at_level(logging.WARNING, logger="ae_mcp.server"):
        result = _server._filtered_tool_names()

    assert result == set()
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("backend selection failed" in r.getMessage() for r in warnings), (
        f"expected a backend-selection WARNING, got: {[r.getMessage() for r in warnings]}"
    )
