"""Typed Core contract for bounded native layer-property pages."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from mcp.shared.memory import create_connected_server_and_client_session
from pydantic import ValidationError

from ae_mcp import schemas
from ae_mcp.backends import native as N
from ae_mcp.backends.mock import MockBackend
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handler
from ae_mcp.server import build_server


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "33333333-3333-4333-8333-333333333333"
LAYER_ID = "77777777-7777-4777-8777-777777777777"
GROUP_ID = "88888888-8888-4888-8888-888888888888"
POSITION_ID = "99999999-9999-4999-8999-999999999999"
OPACITY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
PROTOCOL_FIXTURES = (
    Path(__file__).resolve().parents[3]
    / "native"
    / "ae-plugin"
    / "protocol"
    / "fixtures"
)
PROTOCOL_SCHEMA = PROTOCOL_FIXTURES.parent / "aegp-rpc.schema.json"


def locator(kind: str, object_id: str, *, generation: int = 7) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": object_id,
    }


LAYER_LOCATOR = locator("layer", LAYER_ID)
GROUP_LOCATOR = locator("stream", GROUP_ID)
POSITION_LOCATOR = locator("stream", POSITION_ID)
OPACITY_LOCATOR = locator("stream", OPACITY_ID)


def layer_properties_value(
    *, parent: dict[str, Any] | None = GROUP_LOCATOR
) -> dict[str, Any]:
    return {
        "layerLocator": LAYER_LOCATOR,
        "parentPropertyLocator": parent,
        "layerName": "Title",
        "sampleTime": {"value": 0, "scale": 24, "mode": "comp-time"},
        "total": 2,
        "offset": 0,
        "limit": 25,
        "returned": 2,
        "hasMore": False,
        "nextOffset": None,
        "properties": [
            {
                "propertyLocator": POSITION_LOCATOR,
                "propertyIndex": 1,
                "name": "Position",
                "matchName": "ADBE Position",
                "groupingType": "leaf",
                "childCount": 0,
                "hidden": False,
                "disabled": False,
                "modified": True,
                "canVaryOverTime": True,
                "timeVarying": False,
                "valueType": "two-d-spatial",
                "valueStatus": "sampled",
                "value": {"kind": "vector", "components": ["10", "20.5"]},
            },
            {
                "propertyLocator": OPACITY_LOCATOR,
                "propertyIndex": 2,
                "name": "Opacity",
                "matchName": "ADBE Opacity",
                "groupingType": "leaf",
                "childCount": 0,
                "hidden": False,
                "disabled": False,
                "modified": False,
                "canVaryOverTime": True,
                "timeVarying": False,
                "valueType": "one-d",
                "valueStatus": "sampled",
                "value": {"kind": "scalar", "value": "73.5"},
            },
        ],
    }


def descriptor() -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=N.LAYER_PROPERTIES_LIST_CAPABILITY_ID,
        version=1,
        schema_version=1,
        summary=(
            "List a bounded page of direct properties on an After Effects layer "
            "or property group."
        ),
        risk="read",
        mutability="read-only",
        idempotency="idempotent",
        cancellation="before-dispatch",
        undo="not-applicable",
        side_effect_summary=(
            "Reads layer properties and safe primitive values without changing "
            "After Effects state."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "layerLocator must come from ae.composition.layers.list@1.",
            "parentPropertyLocator must come from ae.layer.properties.list@1 "
            "for the same layer.",
        ),
        compatibility={
            "status": "unverified",
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
        },
        input_contract_id=N.LAYER_PROPERTIES_LIST_INPUT_CONTRACT_ID,
        result_contract_id=N.LAYER_PROPERTIES_LIST_RESULT_CONTRACT_ID,
        contract_digest=N.LAYER_PROPERTIES_LIST_CONTRACT_DIGEST,
        input_schema=N._LAYER_PROPERTIES_LIST_INPUT_SCHEMA,
        result_schema=N._LAYER_PROPERTIES_LIST_RESULT_SCHEMA,
        requirements=({
            "id": "aemcp.requirement.native.layer-properties-list",
            "contractVersion": 1,
        },),
        examples=({"id": "layer-properties-list"},),
    )


class LayerPropertiesBackend(N.NativeInvokeBackend):
    name = "layer-properties-fixture"

    def __init__(self) -> None:
        self.items = (descriptor(),)
        digest = N._capabilities_registry_digest(self.items)
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.9.2",
            compiled_sdk_version="25.6",
            source_commit="a" * 40,
            host_instance_id=HOST,
            host_platform="macos-arm64",
            session_id=SESSION,
            session_generation=3,
            capabilities_digest=digest,
        )
        self.requests: list[N.NativeInvokeRequest] = []
        self.tamper_postcondition = False

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
                session_id=SESSION, ids=None, detail="full", limit=100
            ),
            capabilities_digest=self.negotiation.capabilities_digest,
        )

    async def invoke(self, request, *, cancellation=None):
        del cancellation
        self.requests.append(request)
        raw_value = layer_properties_value()
        value = N.LayerPropertiesListValue.model_validate(raw_value)
        digest = N._layer_properties_list_digest(value)
        if self.tamper_postcondition:
            digest = "f" * 64
        return N.NativeInvokeResult(
            capability_id=request.capability_id,
            capability_version=1,
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
                capability_version=1,
                started_at_unix_ms=request.deadline_unix_ms - 100,
                completed_at_unix_ms=request.deadline_unix_ms - 1,
                effect="none",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind="layer-properties-list",
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
            ),
        )


def test_core_schema_and_digest_equal_protocol_descriptor():
    definitions = json.loads(PROTOCOL_SCHEMA.read_text(encoding="utf-8"))["$defs"]
    wire_input = definitions["layerPropertiesListInputSchemaContract"]["const"]
    wire_result = definitions["layerPropertiesListResultSchemaContract"]["const"]
    assert wire_input == N._LAYER_PROPERTIES_LIST_INPUT_SCHEMA
    assert wire_result == N._LAYER_PROPERTIES_LIST_RESULT_SCHEMA
    assert N._sha256_closed_json(
        {"inputSchema": wire_input, "resultSchema": wire_result}
    ) == N.LAYER_PROPERTIES_LIST_CONTRACT_DIGEST


@pytest.mark.asyncio
async def test_layer_properties_list_binds_locators_and_verified_page():
    backend = LayerPropertiesBackend()
    execution = await N.invoke_layer_properties_list(
        backend,
        request_id="layer-properties-1",
        layer_locator=LAYER_LOCATOR,
        parent_property_locator=GROUP_LOCATOR,
        offset=0,
        limit=25,
        deadline_unix_ms=int(time.time() * 1000) + 5_000,
    )
    assert execution.engine == "native-aegp"
    assert execution.value.layer_name == "Title"
    assert execution.value.sample_time.scale == 24
    assert execution.value.properties[0].value_type == "two-d-spatial"
    assert execution.value.properties[1].value.value == "73.5"
    assert backend.requests[0].arguments == {
        "layerLocator": LAYER_LOCATOR,
        "parentPropertyLocator": GROUP_LOCATOR,
        "offset": 0,
        "limit": 25,
    }
    assert execution.audit_fields()["effect"] == "none"


def test_layer_property_values_enforce_group_leaf_and_canonical_decimal_shapes():
    group = {
        "propertyLocator": GROUP_LOCATOR,
        "propertyIndex": 1,
        "name": "Transform",
        "matchName": "ADBE Transform Group",
        "groupingType": "named-group",
        "childCount": 2,
        "hidden": False,
        "disabled": False,
        "modified": False,
        "canVaryOverTime": None,
        "timeVarying": None,
        "valueType": "none",
        "valueStatus": "group",
        "value": None,
    }
    assert N.LayerProperty.model_validate(group).value_status == "group"

    sampled_group = {**group, "valueStatus": "sampled"}
    with pytest.raises(ValidationError):
        N.LayerProperty.model_validate(sampled_group)

    wrong_dimension = layer_properties_value()["properties"][0]
    wrong_dimension["value"] = {"kind": "vector", "components": ["1", "2", "3"]}
    with pytest.raises(ValidationError):
        N.LayerProperty.model_validate(wrong_dimension)

    negative_zero = layer_properties_value()["properties"][1]
    negative_zero["value"] = {"kind": "scalar", "value": "-0e10"}
    with pytest.raises(ValidationError):
        N.LayerProperty.model_validate(negative_zero)

    noncanonical = layer_properties_value()["properties"][1]
    noncanonical["value"] = {"kind": "scalar", "value": "01.0"}
    with pytest.raises(ValidationError):
        N.LayerProperty.model_validate(noncanonical)

    precise = layer_properties_value()["properties"][1]
    precise["value"] = {"kind": "scalar", "value": "0.20000000000000001"}
    assert N.LayerProperty.model_validate(precise).value.value == (
        "0.20000000000000001"
    )

    underflow = layer_properties_value()["properties"][1]
    underflow["value"] = {"kind": "scalar", "value": "1e-999999999999999999999999999"}
    with pytest.raises(ValidationError):
        N.LayerProperty.model_validate(underflow)

    overflow = layer_properties_value()["properties"][1]
    overflow["value"] = {"kind": "scalar", "value": "1e9999999999999999999999999999"}
    with pytest.raises(ValidationError):
        N.LayerProperty.model_validate(overflow)


def test_layer_property_page_rejects_broken_counts_order_and_locator_context():
    broken_count = layer_properties_value()
    broken_count["returned"] = 1
    with pytest.raises(ValidationError):
        N.LayerPropertiesListValue.model_validate(broken_count)

    wrong_order = layer_properties_value()
    wrong_order["properties"][0]["propertyIndex"] = 2
    with pytest.raises(ValidationError):
        N.LayerPropertiesListValue.model_validate(wrong_order)

    wrong_context = layer_properties_value()
    wrong_context["properties"][0]["propertyLocator"] = locator(
        "stream", POSITION_ID, generation=8
    )
    with pytest.raises(ValidationError):
        N.LayerPropertiesListValue.model_validate(wrong_context)

    parent_cycle = layer_properties_value()
    parent_cycle["properties"][0]["propertyLocator"] = GROUP_LOCATOR
    with pytest.raises(ValidationError):
        N.LayerPropertiesListValue.model_validate(parent_cycle)

    stalled = layer_properties_value()
    stalled.update(
        total=1,
        returned=0,
        hasMore=True,
        nextOffset=0,
        properties=[],
    )
    with pytest.raises(ValidationError):
        N.LayerPropertiesListValue.model_validate(stalled)


def test_unsampled_leaf_time_flags_remain_nullable():
    base = layer_properties_value()["properties"][1]
    no_data = {
        **base,
        "canVaryOverTime": None,
        "timeVarying": None,
        "valueType": "none",
        "valueStatus": "no-data",
        "value": None,
    }
    assert N.LayerProperty.model_validate(no_data).value_status == "no-data"

    unsupported = {
        **base,
        "canVaryOverTime": None,
        "timeVarying": None,
        "valueType": "marker",
        "valueStatus": "unsupported",
        "value": None,
    }
    assert N.LayerProperty.model_validate(unsupported).value_status == "unsupported"


@pytest.mark.asyncio
async def test_layer_property_read_rejects_unbound_postcondition():
    backend = LayerPropertiesBackend()
    backend.tamper_postcondition = True
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_layer_properties_list(
            backend,
            request_id="layer-properties-tampered",
            layer_locator=LAYER_LOCATOR,
            parent_property_locator=GROUP_LOCATOR,
            offset=0,
            limit=25,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert raised.value.side_effect == "not-started"


@pytest.mark.asyncio
async def test_stale_layer_locator_has_a_model_actionable_recovery_path():
    backend = LayerPropertiesBackend()
    stale = {
        **LAYER_LOCATOR,
        "sessionId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_layer_properties_list(
            backend,
            request_id="layer-properties-stale",
            layer_locator=stale,
            parent_property_locator=None,
            offset=0,
            limit=25,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.side_effect == "not-started"
    assert raised.value.recovery.action == "refresh-locator"
    assert "ae_listCompositionLayers" in raised.value.recovery.hint
    assert raised.value.details == {
        "field": "params.arguments.layerLocator",
        "capabilityId": N.LAYER_PROPERTIES_LIST_CAPABILITY_ID,
    }


@pytest.mark.asyncio
async def test_public_tool_forwards_exact_layer_and_parent_locators(monkeypatch):
    backend = LayerPropertiesBackend()
    execution = await N.invoke_layer_properties_list(
        backend,
        request_id="layer-properties-handler-fixture",
        layer_locator=LAYER_LOCATOR,
        parent_property_locator=GROUP_LOCATOR,
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
    monkeypatch.setattr(native_handler, "invoke_layer_properties_list", _invoke)
    result = await native_handler._run_list_layer_properties(
        schemas.AeListLayerPropertiesArgs(
            layer_locator=LAYER_LOCATOR,
            parent_property_locator=GROUP_LOCATOR,
        ),
        None,
    )

    assert captured["backend"] is sentinel_backend
    assert captured["layer_locator"] == LAYER_LOCATOR
    assert captured["parent_property_locator"] == GROUP_LOCATOR
    assert captured["offset"] == 0
    assert captured["limit"] == 25
    assert result["value"]["properties"][1]["value"] == {
        "kind": "scalar",
        "value": "73.5",
    }
    assert result["implementation"]["capabilityId"] == (
        N.LAYER_PROPERTIES_LIST_CAPABILITY_ID
    )
    assert result["audit"]["effect"] == "none"


@pytest.mark.asyncio
async def test_public_tool_never_falls_back_to_legacy_jsx(monkeypatch):
    legacy = MockBackend()
    monkeypatch.setattr(native_handler._discovery, "select_backend", lambda: legacy)
    with pytest.raises(N.NativeBackendError) as raised:
        await native_handler._run_list_layer_properties(
            schemas.AeListLayerPropertiesArgs(layer_locator=LAYER_LOCATOR),
            None,
        )
    assert raised.value.code == "NATIVE_UNAVAILABLE"
    assert legacy.calls == []


def test_public_tool_registration_is_explicit():
    load_all()
    assert HANDLERS["ae.listLayerProperties"][0] is schemas.AeListLayerPropertiesArgs


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("arguments", "field"),
    [
        ({}, "arguments.layer_locator"),
        (
            {
                "layer_locator": {
                    **LAYER_LOCATOR,
                    "kind": "composition",
                },
            },
            "arguments.layer_locator.kind",
        ),
        ({"layer_locator": LAYER_LOCATOR, "limit": 26}, "arguments.limit"),
    ],
)
async def test_public_mcp_schema_rejections_are_structured_and_never_dispatch(
    monkeypatch, arguments, field
):
    load_all()
    schema_cls, _ = HANDLERS["ae.listLayerProperties"]

    async def _must_not_dispatch(_validated, _ctx):
        pytest.fail("invalid public MCP arguments reached the native handler")

    monkeypatch.setitem(
        HANDLERS,
        "ae.listLayerProperties",
        (schema_cls, _must_not_dispatch),
    )
    result = await build_server()._ae_call_tool(
        "ae_listLayerProperties",
        arguments,
    )

    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload == {
        "ok": False,
        "error": {
            "code": "INVALID_ARGUMENT",
            "message": (
                "ae.listLayerProperties arguments did not match the published schema."
            ),
            "retryable": False,
            "sideEffect": "not-started",
            "recovery": {
                "action": "change-arguments",
                "hint": (
                    "Use a layer locator from ae_listCompositionLayers, an optional "
                    "property locator from this tool, offset >= 0, and limit 1..25."
                ),
            },
            "details": {
                "field": field,
                "capabilityId": "ae.layer.properties.list",
            },
        },
    }


@pytest.mark.asyncio
async def test_public_mcp_transport_preserves_structured_limit_rejection(
    monkeypatch,
):
    """The SDK transport must not replace ae-mcp's structured validation.

    MCP SDK input validation runs before the registered handler by default and
    reduces JSON Schema failures to a plain ``Input validation error`` string.
    Drive a real initialized ClientSession so this regression cannot pass by
    exercising only ``_ae_call_tool`` directly.
    """
    from ae_mcp import server as server_module

    load_all()
    schema_cls, _ = HANDLERS["ae.listLayerProperties"]
    dispatches = 0

    async def _run(validated, _ctx):
        nonlocal dispatches
        dispatches += 1
        return {"ok": True, "limit": validated.limit}

    monkeypatch.setitem(
        HANDLERS,
        "ae.listLayerProperties",
        (schema_cls, _run),
    )
    monkeypatch.setattr(
        server_module,
        "_filtered_tool_names",
        lambda: {"ae.listLayerProperties"},
    )
    server = build_server()

    async with create_connected_server_and_client_session(server) as client:
        listed = await client.list_tools()
        tool = next(
            item for item in listed.tools
            if item.name == "ae_listLayerProperties"
        )
        assert tool.inputSchema["properties"]["limit"]["maximum"] == 25

        rejected = await client.call_tool(
            "ae_listLayerProperties",
            {"layer_locator": LAYER_LOCATOR, "limit": 26},
        )
        assert rejected.isError is True
        assert json.loads(rejected.content[0].text) == {
            "ok": False,
            "error": {
                "code": "INVALID_ARGUMENT",
                "message": (
                    "ae.listLayerProperties arguments did not match the "
                    "published schema."
                ),
                "retryable": False,
                "sideEffect": "not-started",
                "recovery": {
                    "action": "change-arguments",
                    "hint": (
                        "Use a layer locator from ae_listCompositionLayers, an "
                        "optional property locator from this tool, offset >= 0, "
                        "and limit 1..25."
                    ),
                },
                "details": {
                    "field": "arguments.limit",
                    "capabilityId": "ae.layer.properties.list",
                },
            },
        }
        assert dispatches == 0

        accepted = await client.call_tool(
            "ae_listLayerProperties",
            {"layer_locator": LAYER_LOCATOR, "limit": 25},
        )
        assert accepted.isError is False
        assert json.loads(accepted.content[0].text) == {"ok": True, "limit": 25}
        assert dispatches == 1
