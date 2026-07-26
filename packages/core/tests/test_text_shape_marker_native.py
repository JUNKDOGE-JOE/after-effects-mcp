from __future__ import annotations

import time
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp.backends import native as N
from ae_mcp.backends import native_text_shape_marker as TSM


HOST = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
PROJECT = "33333333-3333-4333-8333-333333333333"
LAYER = "44444444-4444-4444-8444-444444444444"
COMP = "55555555-5555-4555-8555-555555555555"
NEW_LAYER = "66666666-6666-4666-8666-666666666666"


def locator(kind: str, object_id: str, generation: int = 1) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": object_id,
    }


def descriptor(contract: TSM.CapabilityContract) -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=contract.capability_id,
        version=1,
        schema_version=1,
        summary=contract.summary,
        risk=contract.risk,
        mutability="read-only" if contract.risk == "read" else "mutating",
        idempotency=contract.idempotency,
        cancellation="before-dispatch",
        undo="not-applicable" if contract.risk == "read" else "ae-undo-group",
        side_effect_summary=contract.side_effect_summary,
        preconditions=contract.preconditions,
        compatibility=N.NativeCompatibility(
            status="verified",
            intended_platforms=("macos-arm64",),
            minimum_host_major=25,
            maximum_host_major=26,
        ),
        input_contract_id=contract.input_contract_id,
        result_contract_id=contract.result_contract_id,
        contract_digest=contract.contract_digest,
        input_schema=contract.input_schema,
        result_schema=contract.result_schema,
        requirements=(
            N.NativeRequirement(id=contract.requirement_id, contract_version=1),
        ),
        examples=({"arguments": {}},),
    )


class Backend(N.NativeInvokeBackend):
    name = "text-shape-marker-fixture"

    def __init__(self):
        self.items = tuple(
            descriptor(contract) for contract in TSM.CAPABILITY_CONTRACTS.values()
        )
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.9.2",
            compiled_sdk_version="25.6.61",
            source_commit="a" * 40,
            host_instance_id=HOST,
            host_platform="macos-arm64",
            session_id=SESSION,
            session_generation=1,
            capabilities_digest=N._capabilities_registry_digest(self.items),
        )
        self.requests: list[N.NativeInvokeRequest] = []
        self.malformed_write = False

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

    def value(self, request: N.NativeInvokeRequest) -> dict[str, Any]:
        if request.capability_id == "ae.marker.list":
            return {
                "target": request.arguments["target"],
                "total": 0,
                "offset": request.arguments["offset"],
                "limit": request.arguments["limit"],
                "returned": 0,
                "hasMore": False,
                "nextOffset": None,
                "markers": [],
            }
        if request.capability_id == "ae.shape.layer.create":
            if self.malformed_write:
                return {"changed": True}
            return {
                "changed": True,
                "compositionLocator": locator("composition", COMP, 2),
                "layerLocator": locator("layer", NEW_LAYER, 2),
                "name": request.arguments["name"],
                "stackIndex": 1,
                "layerCountBefore": 0,
                "layerCountAfter": 1,
            }
        raise AssertionError(request.capability_id)

    async def invoke(self, request, *, cancellation=None):
        del cancellation
        self.requests.append(request)
        raw = self.value(request)
        contract = TSM.CAPABILITY_CONTRACTS[request.capability_id]
        try:
            value = TSM.VALUE_MODELS[request.capability_id].model_validate(raw)
            postcondition_digest = TSM._value_digest(request.capability_id, value)
        except ValidationError:
            postcondition_digest = "f" * 64
        write = contract.risk == "write"
        return N.NativeInvokeResult(
            capability_id=request.capability_id,
            capability_version=1,
            engine="native-aegp",
            outcome="succeeded",
            replayed=False,
            value=raw,
            evidence=N.NativeExecutionEvidence(
                engine="native-aegp",
                host_instance_id=HOST,
                session_id=SESSION,
                request_id=request.request_id,
                capability_id=request.capability_id,
                capability_version=1,
                started_at_unix_ms=request.deadline_unix_ms - 100,
                completed_at_unix_ms=request.deadline_unix_ms - 1,
                effect="committed" if write else "none",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind=contract.postcondition_kind,
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=postcondition_digest,
                ),
                undo=(
                    N.NativeUndoEvidence(available=True, verified=False)
                    if write
                    else None
                ),
            ),
        )


def deadline() -> int:
    return int(time.time() * 1000) + 5_000


def test_all_eleven_native_contracts_are_closed_and_digest_bound():
    assert set(TSM.CAPABILITY_CONTRACTS) == {
        "ae.shape.layer.create",
        "ae.shape.groups.list",
        "ae.shape.group.create",
        "ae.shape.path.set",
        "ae.shape.fill-style.set",
        "ae.shape.stroke-style.set",
        "ae.shape.group.reorder",
        "ae.marker.list",
        "ae.marker.create",
        "ae.marker.set",
        "ae.marker.delete",
    }
    for contract in TSM.CAPABILITY_CONTRACTS.values():
        assert contract.input_schema["additionalProperties"] is False
        assert contract.result_schema["additionalProperties"] is False
        assert contract.contract_digest == N._sha256_closed_json(
            {
                "inputSchema": contract.input_schema,
                "resultSchema": contract.result_schema,
            }
        )


@pytest.mark.asyncio
async def test_marker_read_encodes_camel_wire_and_decodes_closed_page():
    backend = Backend()
    result = await TSM.invoke_tsm_native(
        backend,
        capability_id="ae.marker.list",
        arguments={
            "target": {
                "kind": "layer",
                "layer_locator": locator("layer", LAYER),
            },
            "offset": 0,
            "limit": 25,
        },
        request_id="tsm-marker-list-1",
        deadline_unix_ms=deadline(),
    )
    assert result.value.total == 0
    assert backend.requests[0].arguments == {
        "target": {
            "kind": "layer",
            "layerLocator": locator("layer", LAYER),
        },
        "offset": 0,
        "limit": 25,
    }


@pytest.mark.asyncio
async def test_composition_marker_read_encodes_closed_camel_target():
    backend = Backend()
    result = await TSM.invoke_tsm_native(
        backend,
        capability_id="ae.marker.list",
        arguments={
            "target": {
                "kind": "composition",
                "composition_locator": locator("composition", COMP),
            },
            "offset": 0,
            "limit": 25,
        },
        request_id="tsm-composition-marker-list-1",
        deadline_unix_ms=deadline(),
    )
    assert result.value.total == 0
    assert backend.requests[0].arguments == {
        "target": {
            "kind": "composition",
            "compositionLocator": locator("composition", COMP),
        },
        "offset": 0,
        "limit": 25,
    }


@pytest.mark.asyncio
async def test_shape_write_encodes_key_and_returns_verified_undo_boundary():
    backend = Backend()
    result = await TSM.invoke_tsm_native(
        backend,
        capability_id="ae.shape.layer.create",
        arguments={
            "composition_locator": locator("composition", COMP),
            "name": "TSM Shape",
            "idempotency_key": "shape-layer-key-0001",
        },
        request_id="tsm-shape-create-1",
        deadline_unix_ms=deadline(),
    )
    assert result.value.layer_count_after == 1
    assert result.evidence.undo.available is True
    assert result.evidence.undo.verified is False
    assert backend.requests[0].arguments["idempotencyKey"] == "shape-layer-key-0001"
    assert "compositionLocator" in backend.requests[0].arguments


@pytest.mark.asyncio
async def test_malformed_post_dispatch_write_is_side_effect_uncertain():
    backend = Backend()
    backend.malformed_write = True
    with pytest.raises(N.NativeBackendError) as captured:
        await TSM.invoke_tsm_native(
            backend,
            capability_id="ae.shape.layer.create",
            arguments={
                "composition_locator": locator("composition", COMP),
                "name": "TSM Shape",
                "idempotency_key": "shape-layer-key-0002",
            },
            request_id="tsm-shape-create-2",
            deadline_unix_ms=deadline(),
        )
    assert captured.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert captured.value.side_effect == "may-have-occurred"


def marker_state(value: int, scale: int, rational: str) -> dict[str, Any]:
    target = {"kind": "layer", "layerLocator": locator("layer", LAYER)}
    return {
        "ref": {
            "target": target,
            "time": {
                "value": value,
                "scale": scale,
                "secondsRational": rational,
            },
        },
        "markerIndex": 1,
        "duration": {"value": 0, "scale": 1, "secondsRational": "0"},
        "comment": "😀中",
        "chapter": "",
        "url": "",
        "frameTarget": "",
        "cuePointName": "",
        "cuePointParameters": [{"key": "k", "value": "v"}],
        "navigation": True,
        "protectedRegion": False,
        "labelId": 1,
    }


def test_marker_exact_time_is_canonical_and_duplicate_scaled_times_fail():
    with pytest.raises(ValidationError, match="reduced"):
        TSM.MarkerState.model_validate(marker_state(24, 24, "24/24"))
    target = {"kind": "layer", "layerLocator": locator("layer", LAYER)}
    first = marker_state(24, 24, "1")
    second = marker_state(1000, 1000, "1")
    second["markerIndex"] = 2
    with pytest.raises(ValidationError, match="strictly ordered"):
        TSM.MarkersListValue.model_validate(
            {
                "target": target,
                "total": 2,
                "offset": 0,
                "limit": 25,
                "returned": 2,
                "hasMore": False,
                "nextOffset": None,
                "markers": [first, second],
            }
        )
