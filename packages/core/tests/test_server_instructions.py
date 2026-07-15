"""The MCP server advertises ae-mcp operating guidance at handshake."""
from __future__ import annotations

import logging
import re

import pytest

from ae_mcp.instructions import SERVER_INSTRUCTIONS, build_server_instructions, _BASE_INSTRUCTIONS
from ae_mcp.server import build_server


def test_instructions_nonempty_and_substantial():
    assert isinstance(SERVER_INSTRUCTIONS, str)
    assert len(SERVER_INSTRUCTIONS) > 400


def test_instructions_cover_key_discipline():
    text = SERVER_INSTRUCTIONS
    # Workflow guidance plus the verbs an agent must know about. The
    # instructions name verbs by their EXPOSED (underscore) form because
    # strict clients can only call advertised names.
    assert "ae_init" in text
    assert "ae_validateExpressions" in text
    assert "ae_previewFrame" in text
    # ES3 discipline + the runtime helpers we ship.
    assert "ECMAScript 3" in text
    assert "AEMCP.propByMatchPath" in text
    # Never-throw safety invariant.
    assert "NEVER let JSX throw" in text


def test_instructions_explain_the_verified_native_graph_route_without_fallback():
    assert "ae_listProjectItems" in SERVER_INSTRUCTIONS
    assert "ae_listCompositionLayers" in SERVER_INSTRUCTIONS
    assert "ae_getCompositionTime" in SERVER_INSTRUCTIONS
    assert "ae_listLayerProperties" in SERVER_INSTRUCTIONS
    assert "composition locator" in SERVER_INSTRUCTIONS
    assert "never fall back to JSX" in SERVER_INSTRUCTIONS


def test_instructions_cover_panel_runtime_and_file_hygiene():
    text = SERVER_INSTRUCTIONS
    assert "Do not switch to OS screenshots" in text
    assert "report the MCP failure" in text
    assert "project workspace" in text
    assert "ae_mcp_previews" in text


def test_instructions_require_progressive_tool_library_discovery():
    text = SERVER_INSTRUCTIONS
    index = text.index("ae_toolIndex")
    search = text.index("ae_toolSearch")
    inspect = text.index("ae_toolInspect")
    use = text.index("ae_toolUse")
    assert index < search < inspect < use
    assert "candidate content is inspect-only" in text.lower()


def test_instructions_use_underscore_verb_names_not_dotted():
    """Model-facing guidance must not feed the model dotted verb names it
    can't call on strict clients. No dotted ``ae.<verb>`` token may appear in
    the instructions (AEMCP.* helper calls are not verbs)."""
    dotted = re.findall(r"\bae\.[a-zA-Z]\w*", SERVER_INSTRUCTIONS)
    assert dotted == [], f"instructions still name dotted verbs: {sorted(set(dotted))}"


def test_build_server_advertises_instructions():
    server = build_server()
    assert server.instructions == build_server_instructions()
    opts = server.create_initialization_options()
    assert opts.instructions == build_server_instructions()


def test_filtered_tool_names_logs_when_backend_selection_fails(monkeypatch, caplog):
    """A failing backend must still expose ae.status + ae.diagnose and log where to look."""
    from ae_mcp.backends import discovery as _discovery
    from ae_mcp import server as _server

    def _boom():
        raise _discovery.BackendSelectionError("no backend configured")

    monkeypatch.setattr(_discovery, "select_backend", _boom)

    with caplog.at_level(logging.WARNING, logger="ae_mcp.server"):
        result = _server._filtered_tool_names()

    assert result == {"ae.status", "ae.diagnose"}
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("backend selection failed" in r.getMessage() for r in warnings), (
        f"expected a backend-selection WARNING, got: {[r.getMessage() for r in warnings]}"
    )
    assert any("ae_status" in r.getMessage() for r in warnings)


# --- Toggle tests ---

def test_expert_guidance_on_by_default(monkeypatch):
    monkeypatch.delenv("AE_MCP_EXPERT_GUIDANCE", raising=False)
    text = build_server_instructions()
    assert "EXTENDSCRIPT EXPERT GUARDRAILS" in text
    assert "PostScript name" in text
    assert text.startswith(_BASE_INSTRUCTIONS)


@pytest.mark.parametrize("val", ["0", "off", "false", "lean", "none", ""])
def test_expert_guidance_disabled_values(monkeypatch, val):
    monkeypatch.setenv("AE_MCP_EXPERT_GUIDANCE", val)
    assert build_server_instructions() == _BASE_INSTRUCTIONS


@pytest.mark.parametrize("val", ["1", "on", "true", "FULL"])
def test_expert_guidance_enabled_values(monkeypatch, val):
    monkeypatch.setenv("AE_MCP_EXPERT_GUIDANCE", val)
    assert "EXTENDSCRIPT EXPERT GUARDRAILS" in build_server_instructions()


def test_addendum_has_no_dotted_verbs():
    from ae_mcp.instructions import _EXPERT_ADDENDUM
    assert re.findall(r"\bae\.[a-zA-Z]\w*", _EXPERT_ADDENDUM) == []
