"""The MCP server advertises ae-mcp operating guidance at handshake."""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import pytest

from ae_mcp.instructions import SERVER_INSTRUCTIONS, build_server_instructions, _BASE_INSTRUCTIONS
from ae_mcp.server import build_server


def test_instructions_nonempty_and_short():
    assert isinstance(SERVER_INSTRUCTIONS, str)
    assert 100 < len(SERVER_INSTRUCTIONS) < 1_200


def test_base_instructions_name_only_the_two_execution_routes_and_default_skill():
    execution_names = set(re.findall(r"\bae_(?:exec|nativeExec)\b", SERVER_INSTRUCTIONS))
    assert execution_names == {"ae_exec", "ae_nativeExec"}
    assert "builtin:skill:ae-execution-guide" in SERVER_INSTRUCTIONS
    assert "every AE execution route choice" in SERVER_INSTRUCTIONS
    assert "including simple edits" in SERVER_INSTRUCTIONS
    assert "maintained AE scripting object model" in SERVER_INSTRUCTIONS
    assert "curated AEGP" in SERVER_INSTRUCTIONS


def test_base_instructions_do_not_teach_removed_operation_specific_tools():
    root = Path(__file__).resolve().parents[3]
    migration = json.loads(
        (
            root / "native/ae-plugin/protocol/native-exec-migration.json"
        ).read_text(encoding="utf-8")
    )
    removed = {
        row["id"].replace(".", "_")
        for row in migration["publicTools"]
        if row["disposition"].startswith("REMOVE_TO_")
    }
    leaked = sorted(name for name in removed if name in SERVER_INSTRUCTIONS)
    assert leaked == []


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
