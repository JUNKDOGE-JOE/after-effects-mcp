"""Exposed MCP tool names must satisfy the spec's name pattern.

The MCP spec (and strict clients such as Claude Desktop extensions) require
tool names to match ``^[a-zA-Z0-9_-]{1,64}$``. Verbs are dotted internally
("ae.ping"), so the server must expose dot-free names ("ae_ping") and map them
back on call.
"""
from __future__ import annotations

import json
import re

import mcp.types as types
import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.server import (
    build_reverse_map,
    build_server,
    expose_tool_name,
    resolve_tool_name,
)

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


def test_tool_library_exposes_exact_twelve_names():
    load_all()
    exposed = {expose_tool_name(name) for name in HANDLERS if name.startswith("ae.tool")}
    assert exposed == {
        "ae_toolIndex", "ae_toolSearch", "ae_toolInspect", "ae_toolUse",
        "ae_toolCreate", "ae_toolEdit", "ae_toolDelete", "ae_toolArchive",
        "ae_toolDuplicate", "ae_toolPromoteFromHistory",
        "ae_toolImport", "ae_toolExport",
    }


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


# ---------------------------------------------------------------------------
# Reverse-map hot path + collision guard / uniqueness.
# ---------------------------------------------------------------------------


def test_reverse_map_resolves_same_as_linear_scan():
    """The reverse map must give identical results to the linear-scan fallback,
    and still honour the dotted-name back-compat fast path."""
    load_all()
    rmap = build_reverse_map(HANDLERS)
    for verb in HANDLERS:
        exposed = expose_tool_name(verb)
        # O(1) path matches the linear scan.
        assert resolve_tool_name(exposed, HANDLERS, rmap) == verb
        assert resolve_tool_name(exposed, HANDLERS, rmap) == resolve_tool_name(exposed, HANDLERS)
        # Dotted name still resolves with a reverse map present.
        assert resolve_tool_name(verb, HANDLERS, rmap) == verb
    # Unknown names return None on both paths.
    assert resolve_tool_name("nope", HANDLERS, rmap) is None


def test_exposed_names_are_globally_unique():
    """expose_tool_name() is lossy; a future collision would make _list_tools
    emit duplicate Tool names. Assert the mapping is injective today."""
    load_all()
    exposed = [expose_tool_name(v) for v in HANDLERS]
    assert len(exposed) == len(set(exposed)), "exposed tool names collide"
    # The reverse map being the same length as HANDLERS is the guard's check.
    assert len(build_reverse_map(HANDLERS)) == len(HANDLERS)


def test_build_server_raises_on_exposed_name_collision(monkeypatch):
    """The collision guard in build_server() must fail loudly if two verbs ever
    collapse onto the same exposed name."""
    from ae_mcp import server as srv

    load_all()
    # Two distinct dotted verbs that collapse to the same underscore name.
    fake = {"ae.fo_o": ("schema_a", "run_a"), "ae.fo.o": ("schema_b", "run_b")}
    monkeypatch.setattr(srv, "HANDLERS", fake)
    with pytest.raises(RuntimeError, match="collision"):
        build_server()


# ---------------------------------------------------------------------------
# Wire/dispatch-level regression tests.
#
# These exercise integration points helper-only tests miss: _list_tools must
# emit underscore-form names, and _call_tool must reassign to the canonical
# verb before dispatch.
# ---------------------------------------------------------------------------


@pytest.fixture
def _full_tool_listing(monkeypatch):
    """build_server() with _filtered_tool_names stubbed to the full verb set so
    _list_tools actually emits tools (it returns empty without a live backend)."""
    from ae_mcp import server as srv

    load_all()
    monkeypatch.setattr(srv, "_filtered_tool_names", lambda: set(HANDLERS.keys()))
    return build_server()


async def test_list_tools_emits_only_mcp_compliant_names(_full_tool_listing):
    """Drive the registered list_tools handler and assert every emitted
    Tool.name is underscore-form (no dots). Fails if _list_tools reverts to
    emitting dotted names."""
    tools = await _full_tool_listing._ae_list_tools()
    assert tools, "expected tools to be emitted with the full verb set stubbed"
    assert len(tools) == len(HANDLERS)
    for tool in tools:
        assert _MCP_TOOL_NAME.fullmatch(tool.name), f"{tool.name!r} is not MCP-compliant"
        assert "." not in tool.name


async def test_list_tools_descriptions_lead_with_exposed_name(_full_tool_listing):
    """Issue #4 at the wire level: each Tool.description must lead with the
    EXPOSED (underscore) name, not the dotted verb."""
    tools = await _full_tool_listing._ae_list_tools()
    for tool in tools:
        assert tool.description.startswith(tool.name), (
            f"{tool.name!r} description should lead with the exposed name, "
            f"got {tool.description[:40]!r}"
        )
        assert not tool.description.startswith("ae."), (
            f"{tool.name!r} description still leads with a dotted verb"
        )


async def test_call_tool_dispatches_to_canonical_verb(monkeypatch):
    """Drive the registered call_tool handler with the EXPOSED name and assert
    dispatch reaches the canonical (dotted) verb. Fails if _call_tool drops the
    canonical reassignment (which would KeyError on HANDLERS[name])."""
    from ae_mcp import server as srv

    load_all()
    seen = {}

    async def _fake_run(validated, ctx):
        # If dispatch didn't reassign to the canonical verb, the handler keyed
        # by "ae.ping" would never be reached.
        seen["dispatched"] = True
        return {"ok": True, "pong": validated.expect}

    schema_cls, _ = HANDLERS["ae.ping"]
    monkeypatch.setitem(HANDLERS, "ae.ping", (schema_cls, _fake_run))

    server = build_server()
    result = await server._ae_call_tool("ae_ping", {"expect": "hi"})

    assert seen.get("dispatched") is True, "dispatch never reached the canonical ae.ping handler"
    assert result.isError is False
    payload = json.loads(result.content[0].text)
    assert payload == {"ok": True, "pong": "hi"}


async def test_call_tool_accepts_dotted_name_for_backcompat(monkeypatch):
    """Direct/programmatic callers using the dotted name must still dispatch."""
    from ae_mcp import server as srv  # noqa: F401

    load_all()

    async def _fake_run(validated, ctx):
        return {"ok": True, "pong": validated.expect}

    schema_cls, _ = HANDLERS["ae.ping"]
    monkeypatch.setitem(HANDLERS, "ae.ping", (schema_cls, _fake_run))

    server = build_server()
    result = await server._ae_call_tool("ae.ping", {"expect": "yo"})
    assert result.isError is False
    payload = json.loads(result.content[0].text)
    assert payload == {"ok": True, "pong": "yo"}


async def test_call_tool_unknown_returns_structured_error():
    """An unknown tool name must return the {ok:false, 'unknown tool'} payload
    rather than raising."""
    load_all()
    server = build_server()
    result = await server._ae_call_tool("totally_unknown", {})
    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload["ok"] is False
    assert "unknown tool" in payload["error"]


def test_panel_developer_capability_is_secret_bound_and_consumed(monkeypatch):
    from ae_mcp import server as srv

    secret = "ab" * 32
    monkeypatch.setenv("AE_MCP_PANEL_CAPABILITY", secret)
    values, trusted = srv._panel_request(
        "ae.toolIndex",
        {"_ae_panel_capability": secret, "kinds": ["system-command"]},
    )
    assert trusted is True
    assert values == {"kinds": ["system-command"]}

    public_values, public_trusted = srv._panel_request(
        "ae.toolIndex",
        {"_ae_panel_capability": "cd" * 32},
    )
    assert public_trusted is False
    assert public_values == {}


async def test_call_tool_schema_error_sets_iserror_true():
    """The direct dispatch path still marks pydantic validation failures."""
    load_all()
    server = build_server()
    result = await server._ae_call_tool("ae_ping", {"junk": 1})
    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload["ok"] is False
    assert payload["error"].startswith("schema:")


@pytest.mark.parametrize(
    ("verb", "arguments"),
    [
        ("ae.toolUse", {"action": "render", "artifact_id": "user:1"}),
        ("ae.skillUse", {"name": "render-only", "execute": False}),
    ],
)
async def test_dynamic_content_calls_skip_the_static_name_gate(
    monkeypatch, verb, arguments
):
    from ae_mcp import server as srv

    load_all()
    gated = []

    async def _gate(name, ctx):
        gated.append(name)
        return {"ok": False, "error": "static gate reached"}

    async def _run(validated, ctx):
        return {"dynamic": True}

    schema_cls, _ = HANDLERS[verb]
    monkeypatch.setitem(HANDLERS, verb, (schema_cls, _run))
    monkeypatch.setattr(srv.approval_gate, "enforce", _gate)

    result = await build_server()._ae_call_tool(expose_tool_name(verb), arguments)

    assert result.isError is False
    assert gated == []


async def test_call_tool_handler_raise_sets_iserror_true(monkeypatch):
    """Handler exceptions keep the structured JSON payload and set isError."""
    load_all()

    async def _fake_run(validated, ctx):
        raise RuntimeError("boom")

    schema_cls, _ = HANDLERS["ae.ping"]
    monkeypatch.setitem(HANDLERS, "ae.ping", (schema_cls, _fake_run))

    server = build_server()
    result = await server._ae_call_tool("ae_ping", {"expect": "hi"})
    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload == {"ok": False, "error": "boom"}


async def test_call_tool_ok_false_payload_sets_iserror_true(monkeypatch):
    """A non-raising handler can still report a semantic failure via ok:false."""
    load_all()
    expected = {"ok": False, "error": "AE rejected operation", "code": "AE_FAIL"}

    async def _fake_run(validated, ctx):
        return expected

    schema_cls, _ = HANDLERS["ae.ping"]
    monkeypatch.setitem(HANDLERS, "ae.ping", (schema_cls, _fake_run))

    server = build_server()
    result = await server._ae_call_tool("ae_ping", {"expect": "hi"})
    assert result.isError is True
    assert json.loads(result.content[0].text) == expected


@pytest.mark.parametrize("handler_result", [{"pong": "hi"}, "plain text"])
async def test_call_tool_without_ok_false_sets_iserror_false(monkeypatch, handler_result):
    """Only a top-level dict with ok:false is treated as a protocol error."""
    load_all()

    async def _fake_run(validated, ctx):
        return handler_result

    schema_cls, _ = HANDLERS["ae.ping"]
    monkeypatch.setitem(HANDLERS, "ae.ping", (schema_cls, _fake_run))

    server = build_server()
    result = await server._ae_call_tool("ae_ping", {"expect": "hi"})
    assert result.isError is False
    assert result.content[0].text == (
        json.dumps(handler_result, ensure_ascii=False)
        if isinstance(handler_result, dict)
        else handler_result
    )


async def test_sdk_call_tool_handler_preserves_call_tool_result_iserror(monkeypatch):
    """Drive the SDK request handler to prove CallToolResult is passed through."""
    from ae_mcp import server as srv

    load_all()
    monkeypatch.setattr(srv, "_filtered_tool_names", lambda: set(HANDLERS.keys()))
    attempts = 0

    async def _fake_run(validated, ctx):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return {"ok": True, "pong": validated.expect}
        return {"ok": False, "error": "semantic failure"}

    schema_cls, _ = HANDLERS["ae.ping"]
    monkeypatch.setitem(HANDLERS, "ae.ping", (schema_cls, _fake_run))

    server = build_server()
    request_handler = server.request_handlers[types.CallToolRequest]

    ok_response = await request_handler(
        types.CallToolRequest(
            params=types.CallToolRequestParams(
                name="ae_ping",
                arguments={"expect": "hi"},
            )
        )
    )
    assert ok_response.root.isError is False
    assert json.loads(ok_response.root.content[0].text) == {"ok": True, "pong": "hi"}

    error_response = await request_handler(
        types.CallToolRequest(
            params=types.CallToolRequestParams(
                name="ae_ping",
                arguments={"expect": "hi"},
            )
        )
    )
    assert error_response.root.isError is True
    assert json.loads(error_response.root.content[0].text) == {
        "ok": False,
        "error": "semantic failure",
    }


async def test_mcp_transport_keeps_json_schema_type_validation(monkeypatch):
    """Disabling SDK pre-validation must not enable Pydantic coercion."""
    from ae_mcp import server as srv

    load_all()
    schema_cls, _ = HANDLERS["ae.init"]
    dispatches = 0

    async def _fake_run(validated, _ctx):
        nonlocal dispatches
        dispatches += 1
        return {"ok": True, "refreshOnly": validated.refresh_only}

    monkeypatch.setitem(HANDLERS, "ae.init", (schema_cls, _fake_run))
    monkeypatch.setattr(srv, "_filtered_tool_names", lambda: {"ae.init"})
    server = build_server()

    async with create_connected_server_and_client_session(server) as client:
        listed = await client.list_tools()
        tool = next(item for item in listed.tools if item.name == "ae_init")
        assert tool.inputSchema["properties"]["refresh_only"]["type"] == "boolean"

        rejected = await client.call_tool(
            "ae_init",
            {"refresh_only": "false"},
        )
        assert rejected.isError is True
        assert rejected.content[0].text.startswith("Input validation error:")
        assert "boolean" in rejected.content[0].text
        assert dispatches == 0

        rejected_dotted = await client.call_tool(
            "ae.init",
            {"refresh_only": "false"},
        )
        assert rejected_dotted.isError is True
        assert rejected_dotted.content[0].text.startswith(
            "Input validation error:"
        )
        assert "boolean" in rejected_dotted.content[0].text
        assert dispatches == 0

        accepted = await client.call_tool(
            "ae_init",
            {"refresh_only": False},
        )
        assert accepted.isError is False
        assert json.loads(accepted.content[0].text) == {
            "ok": True,
            "refreshOnly": False,
        }
        assert dispatches == 1
