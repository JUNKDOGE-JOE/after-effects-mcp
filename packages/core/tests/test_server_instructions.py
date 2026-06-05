"""The MCP server advertises ae-mcp operating guidance at handshake."""
from __future__ import annotations

from ae_mcp.instructions import SERVER_INSTRUCTIONS
from ae_mcp.server import build_server


def test_instructions_nonempty_and_substantial():
    assert isinstance(SERVER_INSTRUCTIONS, str)
    assert len(SERVER_INSTRUCTIONS) > 400


def test_instructions_cover_key_discipline():
    text = SERVER_INSTRUCTIONS
    # Phased workflow + the verbs an agent must know about.
    assert "ae.init" in text
    assert "ae.validateExpressions" in text
    assert "ae.previewFrame" in text
    # ES3 discipline + the runtime helpers we ship.
    assert "ECMAScript 3" in text
    assert "AEMCP.propByMatchPath" in text
    # Never-throw safety invariant.
    assert "NEVER let JSX throw" in text


def test_build_server_advertises_instructions():
    server = build_server()
    assert server.instructions == SERVER_INSTRUCTIONS
    opts = server.create_initialization_options()
    assert opts.instructions == SERVER_INSTRUCTIONS
