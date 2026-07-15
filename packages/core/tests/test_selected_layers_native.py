"""Typed Core and public MCP contract for native selected-layer listing."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp import schemas
from ae_mcp.backends import native as N
from ae_mcp.backends.mock import MockBackend
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handler


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "33333333-3333-4333-8333-333333333333"
COMP_OBJECT = "66666666-6666-4666-8666-666666666666"


def _locator(kind: str, object_id: str, *, generation: int = 7) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": object_id,
    }


COMP_LOCATOR = _locator("composition", COMP_OBJECT)
PROTOCOL_FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "native"
    / "ae-plugin"
    / "protocol"
    / "fixtures"
)


def _layer(stack_index: int, object_id: str, name: str) -> dict[str, Any]:
    return {
        "locator": _locator("layer", object_id),
        "stackIndex": stack_index,
        "name": name,
        "type": "text" if stack_index == 1 else "shape",
        "videoEnabled": True,
        "isThreeD": False,
        "locked": False,
        "parentLocator": None,
        "sourceItemLocator": None,
    }


def _selected_value(*, offset: int = 0, limit: int = 25) -> dict[str, Any]:
    all_layers = [
        _layer(1, "77777777-7777-4777-8777-777777777777", "Title"),
        _layer(3, "88888888-8888-4888-8888-888888888888", "Accent"),
    ]
    layers = all_layers[offset : offset + limit]
    returned = len(layers)
    next_offset = offset + returned
    has_more = next_offset < len(all_layers)
    return {
        "compositionLocator": COMP_LOCATOR,
        "compositionName": "Main",
        "total": len(all_layers),
        "offset": offset,
        "limit": limit,
        "returned": returned,
        "hasMore": has_more,
        "nextOffset": next_offset if has_more else None,
        "layers": layers,
    }


def _descriptor() -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=N.SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
        version=N.SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_VERSION,
        schema_version=1,
        summary=(
            "List a bounded page of selected layers in one After Effects "
            "composition."
        ),
        risk="read",
        mutability="read-only",
        idempotency="idempotent",
        cancellation="before-dispatch",
        undo="not-applicable",
        side_effect_summary=(
            "Reads selected composition layers without changing After Effects state."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.items.list@1.",
        ),
        compatibility={
            "status": "unverified",
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
        },
        input_contract_id=N.SELECTED_COMPOSITION_LAYERS_LIST_INPUT_CONTRACT_ID,
        result_contract_id=N.SELECTED_COMPOSITION_LAYERS_LIST_RESULT_CONTRACT_ID,
        contract_digest=N.SELECTED_COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST,
        input_schema=N._SELECTED_COMPOSITION_LAYERS_LIST_INPUT_SCHEMA,
        result_schema=N._SELECTED_COMPOSITION_LAYERS_LIST_RESULT_SCHEMA,
        requirements=({
            "id": "aemcp.requirement.native.composition-selected-layers-list",
            "contractVersion": 1,
        },),
        examples=({"id": "composition-selected-layers-list"},),
    )


def test_selected_layer_descriptor_uses_the_closed_canonical_contract():
    descriptor = _descriptor()
    assert descriptor.input_contract_id == (
        "aemcp.contract.ae.composition.selected-layers.list.input.v1"
    )
    assert descriptor.result_contract_id == (
        "aemcp.contract.ae.composition.selected-layers.list.result.v1"
    )
    assert descriptor.contract_digest == N._sha256_closed_json({
        "inputSchema": descriptor.input_schema,
        "resultSchema": descriptor.result_schema,
    })
    assert descriptor.contract_digest == (
        "3bd877e708d62ca1003e65498ebd86a8143cf0f11616fc0467a3e2ba68c8db75"
    )


def test_selected_layer_descriptor_and_registry_fixture_match_core():
    fixture = json.loads(
        (PROTOCOL_FIXTURES / "capabilities.json").read_text(encoding="utf-8")
    )
    raw_items = fixture["response"]["result"]["items"]
    items = tuple(N.NativeCapabilityDescriptor.model_validate(item) for item in raw_items)
    selected = next(
        item
        for item in items
        if item.capability_id == N.SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID
    )
    assert selected.input_schema == N._SELECTED_COMPOSITION_LAYERS_LIST_INPUT_SCHEMA
    assert selected.result_schema == N._SELECTED_COMPOSITION_LAYERS_LIST_RESULT_SCHEMA
    assert selected.contract_digest == N.SELECTED_COMPOSITION_LAYERS_LIST_CONTRACT_DIGEST
    N._validate_selected_composition_layers_list_descriptor(
        selected,
        host_platform="macos-arm64",
    )
    assert N._capabilities_registry_digest(items) == (
        fixture["response"]["result"]["capabilitiesDigest"]
    )


def test_selected_layer_golden_fixture_matches_core_value_and_evidence():
    fixture = json.loads(
        (PROTOCOL_FIXTURES / "invoke-composition-selected-layers-list.json")
        .read_text(encoding="utf-8")
    )
    request = fixture["request"]
    result = fixture["response"]["result"]
    value = N.SelectedCompositionLayersListValue.model_validate(result["value"])
    assert request["params"]["capabilityId"] == (
        N.SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID
    )
    assert request["params"]["arguments"] == {
        "compositionLocator": value.composition_locator.model_dump(
            mode="json", by_alias=True
        ),
        "offset": value.offset,
        "limit": value.limit,
    }
    assert [layer.stack_index for layer in value.layers] == [1, 3]
    assert result["evidence"]["postcondition"] == {
        "verified": True,
        "kind": "composition-selected-layers-list",
        "algorithm": "sha256-rfc8785-jcs-v1",
        "digest": N._selected_composition_layers_list_digest(value),
    }


class SelectedLayersBackend(N.NativeInvokeBackend):
    name = "selected-layers-fixture"

    def __init__(self) -> None:
        self.descriptor = _descriptor()
        self.items = (self.descriptor,)
        capabilities_digest = N._capabilities_registry_digest(self.items)
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.9.2",
            compiled_sdk_version="25.6",
            source_commit="a" * 40,
            host_instance_id=HOST,
            host_platform="macos-arm64",
            session_id=SESSION,
            session_generation=3,
            capabilities_digest=capabilities_digest,
        )
        self.requests: list[N.NativeInvokeRequest] = []
        self.postcondition_kind = "composition-selected-layers-list"
        self.tamper_digest = False

    async def negotiate(self, **_kwargs):
        return self.negotiation

    async def capabilities(self, *, ids, detail, limit, **_kwargs):
        assert ids is None and detail == "full" and limit == 100
        return N.NativeCapabilities(
            session_id=SESSION,
            detail="full",
            items=self.items,
            next_cursor=None,
            query_digest=N._capabilities_query_digest(
                session_id=SESSION,
                ids=None,
                detail="full",
                limit=100,
            ),
            capabilities_digest=self.negotiation.capabilities_digest,
        )

    async def invoke(self, request, *, cancellation=None):
        del cancellation
        self.requests.append(request)
        if request.arguments["compositionLocator"] != COMP_LOCATOR:
            raise N.NativeBackendError(
                "STALE_LOCATOR",
                "compositionLocator does not identify the open composition",
                retryable=True,
                side_effect="not-started",
                recovery=N.NativeRecovery(
                    action="refresh-locator",
                    hint=(
                        "Discard the stale composition locator, then call "
                        "ae_listProjectItems and copy a fresh locator."
                    ),
                ),
                details={
                    "field": "params.arguments.compositionLocator",
                    "capabilityId": (
                        N.SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID
                    ),
                },
            )
        raw_value = _selected_value(
            offset=request.arguments["offset"],
            limit=request.arguments["limit"],
        )
        value = N.SelectedCompositionLayersListValue.model_validate(raw_value)
        digest = N._selected_composition_layers_list_digest(value)
        if self.tamper_digest:
            digest = "f" * 64
        return N.NativeInvokeResult(
            capability_id=request.capability_id,
            capability_version=request.capability_version,
            engine="native-aegp",
            outcome="succeeded",
            replayed=False,
            value=raw_value,
            evidence=N.NativeExecutionEvidence(
                engine="native-aegp",
                host_instance_id=HOST,
                session_id=SESSION,
                request_id=request.request_id,
                capability_id=request.capability_id,
                capability_version=request.capability_version,
                started_at_unix_ms=request.deadline_unix_ms - 100,
                completed_at_unix_ms=request.deadline_unix_ms - 1,
                effect="none",
                request_digest=N._invoke_request_digest(
                    request, self.negotiation
                ),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind=self.postcondition_kind,
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
            ),
        )


def test_selected_layer_value_accepts_noncontiguous_strict_stack_order():
    value = N.SelectedCompositionLayersListValue.model_validate(_selected_value())
    assert [layer.stack_index for layer in value.layers] == [1, 3]
    assert value.layers[0].name == "Title"
    assert value.returned == value.total == 2


@pytest.mark.parametrize("mutation", ["reverse", "duplicate", "stale", "page"])
def test_selected_layer_value_rejects_unverifiable_results(mutation):
    raw = _selected_value()
    if mutation == "reverse":
        raw["layers"].reverse()
    elif mutation == "duplicate":
        raw["layers"][1]["locator"] = raw["layers"][0]["locator"]
    elif mutation == "stale":
        raw["layers"][1]["locator"] = {
            **raw["layers"][1]["locator"],
            "generation": 8,
        }
    else:
        raw["returned"] = 1
    with pytest.raises(ValidationError):
        N.SelectedCompositionLayersListValue.model_validate(raw)


@pytest.mark.asyncio
async def test_selected_layers_invoke_binds_request_locator_result_and_audit():
    backend = SelectedLayersBackend()
    execution = await N.invoke_selected_composition_layers_list(
        backend,
        request_id="selected-layers-1",
        composition_locator=COMP_LOCATOR,
        offset=0,
        limit=25,
        deadline_unix_ms=int(time.time() * 1000) + 5_000,
    )
    assert backend.requests[0].arguments == {
        "compositionLocator": COMP_LOCATOR,
        "offset": 0,
        "limit": 25,
    }
    assert [layer.stack_index for layer in execution.value.layers] == [1, 3]
    assert execution.engine == "native-aegp"
    assert execution.audit_fields()["capabilityId"] == (
        N.SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID
    )
    assert execution.audit_fields()["effect"] == "none"


@pytest.mark.asyncio
async def test_selected_layers_invoke_binds_two_sparse_pages_to_each_request():
    backend = SelectedLayersBackend()
    deadline = int(time.time() * 1000) + 5_000
    first = await N.invoke_selected_composition_layers_list(
        backend,
        request_id="selected-layers-page-1",
        composition_locator=COMP_LOCATOR,
        offset=0,
        limit=1,
        deadline_unix_ms=deadline,
    )
    second = await N.invoke_selected_composition_layers_list(
        backend,
        request_id="selected-layers-page-2",
        composition_locator=COMP_LOCATOR,
        offset=1,
        limit=1,
        deadline_unix_ms=deadline,
    )

    assert first.value.model_dump(mode="json", by_alias=True) == _selected_value(
        offset=0,
        limit=1,
    )
    assert first.value.has_more is True
    assert first.value.next_offset == 1
    assert [layer.stack_index for layer in first.value.layers] == [1]
    assert second.value.model_dump(mode="json", by_alias=True) == _selected_value(
        offset=1,
        limit=1,
    )
    assert second.value.has_more is False
    assert second.value.next_offset is None
    assert [layer.stack_index for layer in second.value.layers] == [3]
    assert [request.arguments for request in backend.requests] == [
        {
            "compositionLocator": COMP_LOCATOR,
            "offset": 0,
            "limit": 1,
        },
        {
            "compositionLocator": COMP_LOCATOR,
            "offset": 1,
            "limit": 1,
        },
    ]
    assert first.evidence.request_digest != second.evidence.request_digest
    assert first.evidence.postcondition.digest == (
        N._selected_composition_layers_list_digest(first.value)
    )
    assert second.evidence.postcondition.digest == (
        N._selected_composition_layers_list_digest(second.value)
    )


@pytest.mark.asyncio
async def test_selected_layers_invoke_rejects_tampered_postcondition():
    backend = SelectedLayersBackend()
    backend.tamper_digest = True
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_selected_composition_layers_list(
            backend,
            request_id="selected-layers-tampered",
            composition_locator=COMP_LOCATOR,
            offset=0,
            limit=25,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.side_effect == "not-started"


@pytest.mark.asyncio
async def test_selected_layers_stale_locator_has_refresh_recovery():
    backend = SelectedLayersBackend()
    stale = {**COMP_LOCATOR, "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_selected_composition_layers_list(
            backend,
            request_id="selected-layers-stale",
            composition_locator=stale,
            offset=0,
            limit=25,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.recovery.action == "refresh-locator"
    assert "ae_listProjectItems" in raised.value.recovery.hint
    assert raised.value.details == {
        "field": "params.arguments.compositionLocator",
        "capabilityId": N.SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID,
    }
    assert backend.requests == []


@pytest.mark.asyncio
async def test_selected_layers_public_mcp_preserves_same_session_native_stale_error(
    monkeypatch,
):
    from mcp.shared.memory import create_connected_server_and_client_session

    from ae_mcp import server as server_module

    backend = SelectedLayersBackend()
    monkeypatch.setattr(native_handler._discovery, "select_backend", lambda: backend)
    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: {"ae.listSelectedLayers"},
    )

    async def _approve(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server_module.approval_gate, "enforce", _approve)
    server = server_module.build_server()
    forged_locators = (
        {
            **COMP_LOCATOR,
            "objectId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
        {**COMP_LOCATOR, "generation": COMP_LOCATOR["generation"] + 1},
    )

    async with create_connected_server_and_client_session(server) as client:
        listed = await client.list_tools()
        assert [tool.name for tool in listed.tools] == ["ae_listSelectedLayers"]
        for forged in forged_locators:
            rejected = await client.call_tool(
                "ae_listSelectedLayers",
                {"composition_locator": forged},
            )
            assert rejected.isError is True
            payload = json.loads(rejected.content[0].text)
            assert payload["ok"] is False
            assert payload["error"] == {
                "code": "STALE_LOCATOR",
                "message": (
                    "compositionLocator does not identify the open composition"
                ),
                "retryable": True,
                "sideEffect": "not-started",
                "recovery": {
                    "action": "refresh-locator",
                    "hint": (
                        "Discard the stale composition locator, then call "
                        "ae_listProjectItems and copy a fresh locator."
                    ),
                },
                "details": {
                    "field": "params.arguments.compositionLocator",
                    "capabilityId": (
                        N.SELECTED_COMPOSITION_LAYERS_LIST_CAPABILITY_ID
                    ),
                },
            }

    assert [
        request.arguments["compositionLocator"] for request in backend.requests
    ] == list(forged_locators)


@pytest.mark.asyncio
async def test_selected_layers_public_handler_forwards_exact_bounded_request(
    monkeypatch,
):
    backend = SelectedLayersBackend()
    execution = await N.invoke_selected_composition_layers_list(
        backend,
        request_id="selected-layers-handler-fixture",
        composition_locator=COMP_LOCATOR,
        offset=0,
        limit=25,
        deadline_unix_ms=int(time.time() * 1000) + 5_000,
    )
    captured: dict[str, Any] = {}

    async def _invoke(selected_backend, **kwargs):
        captured["backend"] = selected_backend
        captured.update(kwargs)
        return execution

    sentinel_backend = object()
    monkeypatch.setattr(native_handler, "_backend", lambda: sentinel_backend)
    monkeypatch.setattr(
        native_handler,
        "invoke_selected_composition_layers_list",
        _invoke,
    )
    result = await native_handler._run_list_selected_layers(
        schemas.AeListSelectedLayersArgs(composition_locator=COMP_LOCATOR),
        None,
    )
    assert captured["backend"] is sentinel_backend
    assert captured["composition_locator"] == COMP_LOCATOR
    assert captured["offset"] == 0
    assert captured["limit"] == 25
    assert result["implementation"]["capabilityId"] == (
        "ae.composition.selected-layers.list"
    )
    assert result["provenance"]["sourceCommit"] == "a" * 40
    assert [layer["stackIndex"] for layer in result["value"]["layers"]] == [1, 3]


@pytest.mark.asyncio
async def test_selected_layers_never_falls_back_to_legacy_jsx(monkeypatch):
    legacy = MockBackend()
    monkeypatch.setattr(native_handler._discovery, "select_backend", lambda: legacy)
    with pytest.raises(N.NativeBackendError) as raised:
        await native_handler._run_list_selected_layers(
            schemas.AeListSelectedLayersArgs(composition_locator=COMP_LOCATOR),
            None,
        )
    assert raised.value.code == "NATIVE_UNAVAILABLE"
    assert legacy.calls == []


@pytest.mark.asyncio
async def test_selected_layers_public_mcp_schema_and_errors_are_structured(
    monkeypatch,
):
    from mcp.shared.memory import create_connected_server_and_client_session

    from ae_mcp import server as server_module

    load_all()
    schema_cls, _ = HANDLERS["ae.listSelectedLayers"]
    dispatches: list[schemas.AeListSelectedLayersArgs] = []

    async def _run(validated, _ctx):
        dispatches.append(validated)
        return {"ok": True, "value": _selected_value()}

    async def _approve(*_args, **_kwargs):
        return None

    monkeypatch.setitem(
        HANDLERS,
        "ae.listSelectedLayers",
        (schema_cls, _run),
    )
    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: {"ae.listSelectedLayers"},
    )
    monkeypatch.setattr(server_module.approval_gate, "enforce", _approve)
    server = server_module.build_server()

    async with create_connected_server_and_client_session(server) as client:
        listed = await client.list_tools()
        assert [tool.name for tool in listed.tools] == ["ae_listSelectedLayers"]
        tool = listed.tools[0]
        assert tool.annotations.readOnlyHint is True
        assert tool.annotations.destructiveHint is False
        assert tool.inputSchema["required"] == ["composition_locator"]
        assert set(tool.inputSchema["properties"]) == {
            "composition_locator",
            "offset",
            "limit",
        }
        assert tool.inputSchema["additionalProperties"] is False

        invalid_cases = (
            ({}, "arguments.composition_locator"),
            (
                {"composition_locator": {**COMP_LOCATOR, "kind": "item"}},
                "arguments.composition_locator.kind",
            ),
            (
                {"composition_locator": COMP_LOCATOR, "limit": 51},
                "arguments.limit",
            ),
            (
                {"composition_locator": COMP_LOCATOR, "comp_id": 1},
                "arguments.comp_id",
            ),
        )
        for arguments, expected_field in invalid_cases:
            rejected = await client.call_tool("ae_listSelectedLayers", arguments)
            assert rejected.isError is True
            payload = json.loads(rejected.content[0].text)
            assert payload["ok"] is False
            assert payload["error"]["code"] == "INVALID_ARGUMENT"
            assert payload["error"]["retryable"] is False
            assert payload["error"]["sideEffect"] == "not-started"
            assert payload["error"]["recovery"] == {
                "action": "change-arguments",
                "hint": (
                    "Copy an unmodified composition_locator from "
                    "ae_listProjectItems, use offset >= 0 and limit 1..50, "
                    "then retry."
                ),
            }
            assert payload["error"]["details"] == {
                "field": expected_field,
                "capabilityId": "ae.composition.selected-layers.list",
            }
        assert dispatches == []

        accepted = await client.call_tool(
            "ae_listSelectedLayers",
            {"composition_locator": COMP_LOCATOR},
        )
        assert accepted.isError is False
        assert json.loads(accepted.content[0].text)["value"]["returned"] == 2
        assert len(dispatches) == 1
        assert dispatches[0].offset == 0
        assert dispatches[0].limit == 25


def test_selected_layers_registration_is_explicit():
    load_all()
    assert HANDLERS["ae.listSelectedLayers"] == (
        schemas.AeListSelectedLayersArgs,
        native_handler._run_list_selected_layers,
    )
