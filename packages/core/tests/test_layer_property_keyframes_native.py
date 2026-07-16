"""Typed Core contract for bounded native layer-property keyframe pages."""

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
from ae_mcp.server import build_server


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "33333333-3333-4333-8333-333333333333"
PROPERTY = "99999999-9999-4999-8999-999999999999"
PROPERTY_LOCATOR = {
    "kind": "stream",
    "hostInstanceId": HOST,
    "sessionId": SESSION,
    "projectId": PROJECT,
    "generation": 7,
    "objectId": PROPERTY,
}
PROTOCOL_SCHEMA = (
    Path(__file__).resolve().parents[3]
    / "native"
    / "ae-plugin"
    / "protocol"
    / "aegp-rpc.schema.json"
)


def keyframes_value() -> dict[str, Any]:
    return {
        "propertyLocator": PROPERTY_LOCATOR,
        "valueType": "one-d",
        "total": 3,
        "offset": 0,
        "limit": 2,
        "returned": 2,
        "hasMore": True,
        "nextOffset": 2,
        "keyframes": [
            {
                "keyframeIndex": 1,
                "time": {"value": 0, "scale": 1, "mode": "comp-time"},
                "value": {"kind": "scalar", "value": "10"},
                "inInterpolation": "linear",
                "outInterpolation": "linear",
            },
            {
                "keyframeIndex": 2,
                "time": {"value": 5, "scale": 2, "mode": "comp-time"},
                "value": {"kind": "scalar", "value": "20.5"},
                "inInterpolation": "bezier",
                "outInterpolation": "hold",
            },
        ],
    }


def descriptor() -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=N.LAYER_PROPERTY_KEYFRAMES_LIST_CAPABILITY_ID,
        version=1,
        schema_version=1,
        summary=(
            "List a bounded page of exact keyframes on one After Effects layer "
            "property."
        ),
        risk="read",
        mutability="read-only",
        idempotency="idempotent",
        cancellation="before-dispatch",
        undo="not-applicable",
        side_effect_summary=(
            "Reads native keyframe times, primitive values, and interpolation "
            "without changing After Effects state."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "propertyLocator must come from ae.layer.properties.list@1 in the "
            "current native session.",
            "The property must be a keyframeable primitive scalar, vector, or "
            "color leaf stream.",
        ),
        compatibility={
            "status": "unverified",
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
        },
        input_contract_id=N.LAYER_PROPERTY_KEYFRAMES_LIST_INPUT_CONTRACT_ID,
        result_contract_id=N.LAYER_PROPERTY_KEYFRAMES_LIST_RESULT_CONTRACT_ID,
        contract_digest=N.LAYER_PROPERTY_KEYFRAMES_LIST_CONTRACT_DIGEST,
        input_schema=N._LAYER_PROPERTY_KEYFRAMES_LIST_INPUT_SCHEMA,
        result_schema=N._LAYER_PROPERTY_KEYFRAMES_LIST_RESULT_SCHEMA,
        requirements=({
            "id": "aemcp.requirement.native.layer-property-keyframes-list",
            "contractVersion": 1,
        },),
        examples=({"id": "layer-property-keyframes-list"},),
    )


class KeyframesBackend(N.NativeInvokeBackend):
    name = "keyframes-fixture"

    def __init__(self) -> None:
        self.items = (descriptor(),)
        registry_digest = N._capabilities_registry_digest(self.items)
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.9.2",
            compiled_sdk_version="25.6",
            source_commit="a" * 40,
            host_instance_id=HOST,
            host_platform="macos-arm64",
            session_id=SESSION,
            session_generation=3,
            capabilities_digest=registry_digest,
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
        raw_value = keyframes_value()
        value = N.LayerPropertyKeyframesListValue.model_validate(raw_value)
        digest = N._layer_property_keyframes_list_digest(value)
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
                    kind="layer-property-keyframes-list",
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
            ),
        )


def test_core_schema_and_digest_equal_protocol_descriptor():
    definitions = json.loads(PROTOCOL_SCHEMA.read_text(encoding="utf-8"))["$defs"]
    wire_input = definitions["layerPropertyKeyframesListInputSchemaContract"][
        "const"
    ]
    wire_result = definitions["layerPropertyKeyframesListResultSchemaContract"][
        "const"
    ]
    assert wire_input == N._LAYER_PROPERTY_KEYFRAMES_LIST_INPUT_SCHEMA
    assert wire_result == N._LAYER_PROPERTY_KEYFRAMES_LIST_RESULT_SCHEMA
    assert N._sha256_closed_json(
        {"inputSchema": wire_input, "resultSchema": wire_result}
    ) == N.LAYER_PROPERTY_KEYFRAMES_LIST_CONTRACT_DIGEST


def test_keyframe_page_rejects_broken_order_time_and_value_type():
    assert N.LayerPropertyKeyframesListValue.model_validate(
        keyframes_value()
    ).next_offset == 2

    wrong_index = keyframes_value()
    wrong_index["keyframes"][1]["keyframeIndex"] = 3
    with pytest.raises(ValidationError):
        N.LayerPropertyKeyframesListValue.model_validate(wrong_index)

    wrong_time = keyframes_value()
    wrong_time["keyframes"][1]["time"] = {
        "value": 0,
        "scale": 24,
        "mode": "comp-time",
    }
    with pytest.raises(ValidationError):
        N.LayerPropertyKeyframesListValue.model_validate(wrong_time)

    wrong_type = keyframes_value()
    wrong_type["keyframes"][0]["value"] = {
        "kind": "vector",
        "components": ["1", "2"],
    }
    with pytest.raises(ValidationError):
        N.LayerPropertyKeyframesListValue.model_validate(wrong_type)


@pytest.mark.asyncio
async def test_keyframe_read_binds_request_locator_page_and_evidence():
    backend = KeyframesBackend()
    execution = await N.invoke_layer_property_keyframes_list(
        backend,
        request_id="keyframes-1",
        property_locator=PROPERTY_LOCATOR,
        offset=0,
        limit=2,
        deadline_unix_ms=int(time.time() * 1000) + 5_000,
    )
    assert backend.requests[0].arguments == {
        "propertyLocator": PROPERTY_LOCATOR,
        "offset": 0,
        "limit": 2,
    }
    assert execution.value.keyframes[1].time.value == 5
    assert execution.value.keyframes[1].out_interpolation == "hold"
    assert execution.audit_fields()["effect"] == "none"


@pytest.mark.asyncio
async def test_keyframe_read_rejects_stale_locator_and_tampered_evidence():
    stale_backend = KeyframesBackend()
    stale = {
        **PROPERTY_LOCATOR,
        "sessionId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }
    with pytest.raises(N.NativeBackendError) as stale_error:
        await N.invoke_layer_property_keyframes_list(
            stale_backend,
            request_id="keyframes-stale",
            property_locator=stale,
            offset=0,
            limit=2,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert stale_error.value.code == "STALE_LOCATOR"
    assert stale_error.value.recovery.action == "refresh-locator"
    assert stale_error.value.details["field"] == "params.arguments.propertyLocator"

    tampered_backend = KeyframesBackend()
    tampered_backend.tamper_postcondition = True
    with pytest.raises(N.NativeBackendError) as tampered_error:
        await N.invoke_layer_property_keyframes_list(
            tampered_backend,
            request_id="keyframes-tampered",
            property_locator=PROPERTY_LOCATOR,
            offset=0,
            limit=2,
            deadline_unix_ms=int(time.time() * 1000) + 5_000,
        )
    assert tampered_error.value.code == "NATIVE_CONTRACT_MISMATCH"


@pytest.mark.asyncio
async def test_public_handler_forwards_only_property_locator_and_never_uses_jsx(
    monkeypatch,
):
    backend = KeyframesBackend()
    execution = await N.invoke_layer_property_keyframes_list(
        backend,
        request_id="keyframes-handler-fixture",
        property_locator=PROPERTY_LOCATOR,
        offset=0,
        limit=2,
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
        native_handler, "invoke_layer_property_keyframes_list", _invoke
    )
    result = await native_handler._run_list_layer_property_keyframes(
        schemas.AeListLayerPropertyKeyframesArgs(
            property_locator=PROPERTY_LOCATOR,
            limit=2,
        ),
        None,
    )
    assert captured["backend"] is sentinel_backend
    assert captured["property_locator"] == PROPERTY_LOCATOR
    assert captured["offset"] == 0 and captured["limit"] == 2
    assert result["implementation"]["capabilityId"] == (
        N.LAYER_PROPERTY_KEYFRAMES_LIST_CAPABILITY_ID
    )


@pytest.mark.asyncio
async def test_public_handler_never_falls_back_to_legacy_jsx(monkeypatch):
    legacy = MockBackend()
    monkeypatch.setattr(native_handler._discovery, "select_backend", lambda: legacy)
    with pytest.raises(N.NativeBackendError) as unavailable:
        await native_handler._run_list_layer_property_keyframes(
            schemas.AeListLayerPropertyKeyframesArgs(
                property_locator=PROPERTY_LOCATOR
            ),
            None,
        )
    assert unavailable.value.code == "NATIVE_UNAVAILABLE"
    assert legacy.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("arguments", "field"),
    [
        ({}, "arguments.property_locator"),
        (
            {"property_locator": {**PROPERTY_LOCATOR, "kind": "layer"}},
            "arguments.property_locator.kind",
        ),
        ({"property_locator": PROPERTY_LOCATOR, "limit": 26}, "arguments.limit"),
    ],
)
async def test_public_mcp_schema_rejections_are_structured_and_never_dispatch(
    monkeypatch, arguments, field
):
    load_all()
    schema_cls, _ = HANDLERS["ae.listLayerPropertyKeyframes"]

    async def _must_not_dispatch(_validated, _ctx):
        pytest.fail("invalid public MCP arguments reached the native handler")

    monkeypatch.setitem(
        HANDLERS,
        "ae.listLayerPropertyKeyframes",
        (schema_cls, _must_not_dispatch),
    )
    result = await build_server()._ae_call_tool(
        "ae_listLayerPropertyKeyframes", arguments
    )
    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "INVALID_ARGUMENT"
    assert payload["error"]["details"] == {
        "field": field,
        "capabilityId": "ae.layer.property.keyframes.list",
    }


def test_public_tool_registration_is_explicit():
    load_all()
    assert HANDLERS["ae.listLayerPropertyKeyframes"][0] is (
        schemas.AeListLayerPropertyKeyframesArgs
    )
