"""Public server exposure boundary for the single native EXEC tool."""

from __future__ import annotations

import json

import pytest

from ae_mcp.backends import native as N
from ae_mcp.backends.mock import MockBackend
from ae_mcp.server import _filtered_tool_names, build_server


class _NativeBackend(MockBackend, N.NativeInvokeBackend):
    async def negotiate(self, **_kwargs):
        raise AssertionError("tool listing must not negotiate")

    async def capabilities(self, **_kwargs):
        raise AssertionError("tool listing must not query capabilities")

    async def invoke(self, *_args, **_kwargs):
        raise AssertionError("tool listing must not invoke")


def test_native_exec_is_filtered_by_backend_type_and_exec_remains_jsx(
    monkeypatch,
):
    from ae_mcp.backends import discovery as backend_discovery
    from ae_mcp.snapshot import discovery as snapshot_discovery

    monkeypatch.setattr(snapshot_discovery, "select_snapshotter", lambda: None)
    monkeypatch.setattr(backend_discovery, "select_backend", lambda: MockBackend())
    jsx_names = _filtered_tool_names()
    assert "ae.exec" in jsx_names
    assert "ae.nativeExec" not in jsx_names

    monkeypatch.setattr(
        backend_discovery, "select_backend", lambda: _NativeBackend()
    )
    monkeypatch.setattr(snapshot_discovery, "select_snapshotter", object)
    native_names = _filtered_tool_names()
    assert native_names == {
        "ae.checkpoint",
        "ae.diagnose",
        "ae.exec",
        "ae.nativeExec",
        "ae.ping",
        "ae.previewFrame",
        "ae.revert",
        "ae.skillList",
        "ae.skillUse",
        "ae.snapshot",
        "ae.status",
        "ae.toolIndex",
        "ae.toolInspect",
        "ae.toolSearch",
        "ae.toolUse",
        "ae.validateExpressions",
    }


@pytest.mark.asyncio
async def test_native_exec_is_exposed_with_public_underscore_name(monkeypatch):
    from ae_mcp import server as server_module

    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: {"ae.exec", "ae.nativeExec"},
    )
    names = {tool.name for tool in await build_server()._ae_list_tools()}
    assert names == {"ae_exec", "ae_nativeExec"}


@pytest.mark.asyncio
async def test_native_exec_invalid_program_returns_structured_not_started_error(
    monkeypatch,
):
    from ae_mcp import server as server_module

    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: {"ae.nativeExec"},
    )
    server = build_server()
    await server._ae_list_tools()
    response = await server._ae_call_tool(
        "ae_nativeExec",
        {"operations": []},
    )
    payload = json.loads(response.content[0].text)
    assert response.isError is True
    assert payload["error"]["code"] == "INVALID_ARGUMENT"
    assert payload["error"]["sideEffect"] == "not-started"
    assert payload["error"]["details"]["capabilityId"] == "ae.native.exec"


@pytest.mark.asyncio
async def test_native_exec_enforces_unadvertised_write_envelope_contract(
    monkeypatch,
):
    from ae_mcp import server as server_module

    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: {"ae.nativeExec"},
    )
    server = build_server()
    tools = await server._ae_list_tools()
    advertised = tools[0].inputSchema
    assert "allOf" not in advertised

    invalid_programs = [
        {
            "operations": [
                {
                    "op": "composition.resolve",
                    "args": {
                        "locator": {
                            "kind": "composition",
                            "hostInstanceId": "22222222-2222-4222-8222-222222222222",
                            "sessionId": "11111111-1111-4111-8111-111111111111",
                            "projectId": "33333333-3333-4333-8333-333333333333",
                            "generation": 1,
                            "objectId": "44444444-4444-4444-8444-444444444444",
                        }
                    },
                    "saveAs": "composition",
                },
                {
                    "op": "composition.time.set",
                    "args": {
                        "composition": {"ref": "composition"},
                        "targetTime": {"value": 5, "scale": 24},
                    },
                    "returnAs": "time",
                },
            ]
        },
        {
            "operationKey": "read-program-must-not-have-write-metadata",
            "operations": [
                {
                    "op": "project.items.list",
                    "args": {"offset": 0, "limit": 1},
                    "returnAs": "items",
                }
            ],
        },
    ]
    for arguments in invalid_programs:
        response = await server._ae_call_tool("ae_nativeExec", arguments)
        payload = json.loads(response.content[0].text)
        assert response.isError is True
        assert payload["error"]["code"] == "INVALID_ARGUMENT"
        assert payload["error"]["sideEffect"] == "not-started"
        assert payload["error"]["details"]["capabilityId"] == "ae.native.exec"
        assert payload["error"]["details"]["field"].startswith("arguments")
