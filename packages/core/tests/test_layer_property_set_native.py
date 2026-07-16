"""Typed Core contract for one native undoable primitive property write."""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp.backends import native as N
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.server import build_server


DEADLINE = 1_900_000_005_000
HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "33333333-3333-4333-8333-333333333333"


def locator(kind: str, object_id: str, *, session: str = SESSION) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": session,
        "projectId": PROJECT,
        "generation": 7,
        "objectId": object_id,
    }


LAYER = locator("layer", "44444444-4444-4444-8444-444444444444")
STREAM = locator("stream", "55555555-5555-4555-8555-555555555555")


def descriptor() -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=N.LAYER_PROPERTY_SET_CAPABILITY_ID,
        version=1,
        schema_version=1,
        summary="Set one non-keyframed primitive After Effects layer property value.",
        risk="write",
        mutability="mutating",
        idempotency="idempotency-key",
        cancellation="before-dispatch",
        undo="ae-undo-group",
        side_effect_summary=(
            "Changes one primitive layer property and creates one After Effects Undo step."
        ),
        preconditions=(
            "An After Effects project must be open.",
            "Both locators must come from ae.layer.properties.list@1 for the same layer.",
            "The property must be a non-keyframed scalar, vector, or color leaf stream.",
            "value must differ from the property's current sampled value.",
        ),
        compatibility={
            "status": "unverified",
            "intendedPlatforms": ["macos-arm64", "windows-x64"],
        },
        input_contract_id=N.LAYER_PROPERTY_SET_INPUT_CONTRACT_ID,
        result_contract_id=N.LAYER_PROPERTY_SET_RESULT_CONTRACT_ID,
        contract_digest=N.LAYER_PROPERTY_SET_CONTRACT_DIGEST,
        input_schema=N._LAYER_PROPERTY_SET_INPUT_SCHEMA,
        result_schema=N._LAYER_PROPERTY_SET_RESULT_SCHEMA,
        requirements=({
            "id": "aemcp.requirement.native.layer-property-set",
            "contractVersion": 1,
        },),
        examples=({"id": "layer-property-set", "kind": "positive"},),
    )


class PropertySetBackend(N.NativeInvokeBackend):
    name = "property-set-fixture"

    def __init__(self) -> None:
        self.items = (descriptor(),)
        registry_digest = N._capabilities_registry_digest(self.items)
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.9.2",
            compiled_sdk_version="25.6.61",
            source_commit="a" * 40,
            host_instance_id=HOST,
            host_platform="macos-arm64",
            session_id=SESSION,
            session_generation=3,
            capabilities_digest=registry_digest,
        )
        self.requests: list[N.NativeInvokeRequest] = []
        self.malformed = False
        self.normalized_after: dict[str, Any] | None = None

    async def negotiate(self, **_kwargs):
        return self.negotiation

    async def capabilities(self, *, ids, detail, limit, **_kwargs):
        return N.NativeCapabilities(
            session_id=SESSION,
            detail="full",
            items=self.items,
            next_cursor=None,
            query_digest=N._capabilities_query_digest(
                session_id=SESSION, ids=ids, detail=detail, limit=limit
            ),
            capabilities_digest=self.negotiation.capabilities_digest,
        )

    async def invoke(self, request, *, cancellation=None):
        del cancellation
        self.requests.append(request)
        after = self.normalized_after or request.arguments["value"]
        before = after if self.malformed else {"kind": "scalar", "value": "25"}
        raw_value = {
            "changed": True,
            "layerLocator": LAYER,
            "propertyLocator": STREAM,
            "valueType": "one-d",
            "beforeValue": before,
            "afterValue": after,
        }
        digest = "0" * 64
        if not self.malformed:
            digest = N._layer_property_set_digest(
                N.LayerPropertySetValue.model_validate(raw_value)
            )
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
                started_at_unix_ms=DEADLINE - 100,
                completed_at_unix_ms=DEADLINE - 1,
                effect="committed",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind="layer-property-set",
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
                undo=N.NativeUndoEvidence(available=True, verified=False),
            ),
        )


@pytest.mark.asyncio
async def test_property_set_binds_locators_target_postcondition_and_undo():
    backend = PropertySetBackend()
    backend.normalized_after = {"kind": "scalar", "value": "40"}
    execution = await N.invoke_layer_property_set(
        backend,
        request_id="core-property-set-1",
        layer_locator=LAYER,
        property_locator=STREAM,
        value={"kind": "scalar", "value": "4e1"},
        idempotency_key="property-intent-0001",
        deadline_unix_ms=DEADLINE,
    )

    request = backend.requests[0]
    assert request.arguments == {
        "layerLocator": LAYER,
        "propertyLocator": STREAM,
        "value": {"kind": "scalar", "value": "4e1"},
        "idempotencyKey": "property-intent-0001",
    }
    assert execution.value.before_value.value == "25"
    assert execution.value.after_value.value == "40"
    assert execution.evidence.effect == "committed"
    assert execution.evidence.undo is not None
    assert execution.evidence.undo.available is True
    assert execution.evidence.undo.verified is False


def test_property_set_models_reject_cross_context_and_shape_mismatch():
    with pytest.raises(ValidationError):
        N.LayerPropertySetArguments(
            layer_locator=LAYER,
            property_locator=locator(
                "stream",
                "55555555-5555-4555-8555-555555555555",
                session="66666666-6666-4666-8666-666666666666",
            ),
            value={"kind": "scalar", "value": "40"},
            idempotency_key="property-intent-0002",
        )
    with pytest.raises(ValidationError):
        N.LayerPropertySetValue(
            changed=True,
            layer_locator=LAYER,
            property_locator=STREAM,
            value_type="two-d",
            before_value={"kind": "scalar", "value": "25"},
            after_value={"kind": "scalar", "value": "40"},
        )


@pytest.mark.asyncio
async def test_stale_property_locator_fails_before_dispatch():
    backend = PropertySetBackend()
    stale = locator(
        "stream",
        "55555555-5555-4555-8555-555555555555",
        session="66666666-6666-4666-8666-666666666666",
    )
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_layer_property_set(
            backend,
            request_id="core-property-set-stale",
            layer_locator=LAYER,
            property_locator=stale,
            value={"kind": "scalar", "value": "40"},
            idempotency_key="property-intent-0003",
            deadline_unix_ms=DEADLINE,
        )
    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.recovery.action == "refresh-locator"
    assert raised.value.details is not None
    assert raised.value.details["field"] == "params.arguments.propertyLocator"
    assert backend.requests == []


@pytest.mark.asyncio
async def test_malformed_post_dispatch_result_preserves_side_effect_uncertainty():
    backend = PropertySetBackend()
    backend.malformed = True
    with pytest.raises(N.NativeBackendError) as raised:
        await N.invoke_layer_property_set(
            backend,
            request_id="core-property-set-malformed",
            layer_locator=LAYER,
            property_locator=STREAM,
            value={"kind": "scalar", "value": "40"},
            idempotency_key="property-intent-0004",
            deadline_unix_ms=DEADLINE,
        )
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"


@pytest.mark.asyncio
async def test_public_mcp_schema_rejection_is_structured_and_never_dispatches(
    monkeypatch,
):
    load_all()
    schema_cls, _ = HANDLERS["ae.setLayerPropertyValue"]

    async def _must_not_dispatch(_validated, _ctx):
        pytest.fail("invalid public MCP arguments reached the native handler")

    monkeypatch.setitem(
        HANDLERS,
        "ae.setLayerPropertyValue",
        (schema_cls, _must_not_dispatch),
    )
    result = await build_server()._ae_call_tool(
        "ae_setLayerPropertyValue",
        {
            "layer_locator": LAYER,
            "property_locator": STREAM,
            "value": {"kind": "scalar", "value": "40"},
            "idempotency_key": "short",
        },
    )

    assert result.isError is True
    payload = json.loads(result.content[0].text)
    assert payload["error"]["code"] == "INVALID_ARGUMENT"
    assert payload["error"]["sideEffect"] == "not-started"
    assert payload["error"]["recovery"]["action"] == "change-arguments"
    assert payload["error"]["details"] == {
        "field": "arguments.idempotency_key",
        "capabilityId": "ae.layer.property.set",
    }
