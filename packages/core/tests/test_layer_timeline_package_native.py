"""Focused Core contracts for the #155 Layer Timeline / Hierarchy package."""

from __future__ import annotations

import json
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp import schemas
from ae_mcp import server as server_module
from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.backends import native as N
from ae_mcp.backends import native_layer_timeline as TL
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handlers


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "44444444-4444-4444-8444-444444444444"
REFRESHED_PROJECT = "88888888-8888-4888-8888-888888888888"
COMP_OBJECT = "66666666-6666-4666-8666-666666666666"
LAYER_OBJECT = "77777777-7777-4777-8777-777777777777"
PARENT_OBJECT = "99999999-9999-4999-8999-999999999999"
NEW_LAYER_OBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
SOURCE_OBJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


PUBLIC_TOOLS = {
    "ae.getLayerDetails": ("layer_locator",),
    "ae.renameLayer": ("layer_locator", "idempotency_key", "name"),
    "ae.setLayerRange": ("layer_locator", "idempotency_key", "in_point", "duration"),
    "ae.setLayerStartTime": ("layer_locator", "idempotency_key", "start_time"),
    "ae.setLayerStretch": ("layer_locator", "idempotency_key", "stretch_percent"),
    "ae.reorderLayer": ("layer_locator", "idempotency_key", "target_stack_index"),
    "ae.setLayerParent": ("layer_locator", "idempotency_key", "parent_layer_locator"),
    "ae.duplicateLayer": ("layer_locator", "idempotency_key", "new_name"),
}


def _locator(
    kind: str,
    object_id: str,
    *,
    generation: int = 3,
    project_id: str = PROJECT,
    session_id: str = SESSION,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": session_id,
        "projectId": project_id,
        "generation": generation,
        "objectId": object_id,
    }


def _time(value: int, scale: int) -> dict[str, Any]:
    return {"value": value, "scale": scale, "secondsRational": str(Fraction(value, scale))}


def _ratio(numerator: int, denominator: int) -> dict[str, Any]:
    return {
        "numerator": numerator,
        "denominator": denominator,
        "rational": str(Fraction(numerator, denominator)),
    }


def _details(
    locator: dict[str, Any],
    composition: dict[str, Any],
    *,
    name: str = "Fixture Layer",
    stack_index: int = 1,
) -> dict[str, Any]:
    return {
        "layerLocator": locator,
        "compositionLocator": composition,
        "stackIndex": stack_index,
        "name": name,
        "type": "av",
        "videoEnabled": True,
        "isThreeD": False,
        "locked": False,
        "parentLocator": None,
        "sourceItemLocator": None,
        "inPoint": _time(0, 1),
        "duration": _time(10, 1),
        "startTime": _time(0, 1),
        "stretch": _ratio(1, 1),
    }


VALUE_MODELS = {
    TL.LAYER_DETAILS_READ_CAPABILITY_ID: TL.LayerDetailsValue,
    TL.LAYER_NAME_SET_CAPABILITY_ID: TL.LayerNameSetValue,
    TL.LAYER_RANGE_SET_CAPABILITY_ID: TL.LayerRangeSetValue,
    TL.LAYER_START_TIME_SET_CAPABILITY_ID: TL.LayerStartTimeSetValue,
    TL.LAYER_STRETCH_SET_CAPABILITY_ID: TL.LayerStretchSetValue,
    TL.LAYER_ORDER_SET_CAPABILITY_ID: TL.LayerOrderSetValue,
    TL.LAYER_PARENT_SET_CAPABILITY_ID: TL.LayerParentSetValue,
    TL.LAYER_DUPLICATE_CAPABILITY_ID: TL.LayerDuplicateValue,
}


def _descriptor(contract: TL.CapabilityContract) -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=contract.capability_id,
        version=TL.CAPABILITY_VERSION,
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
        requirements=(N.NativeRequirement(id=contract.requirement_id, contract_version=1),),
        examples=({"arguments": {}},),
    )


class PackageBackend(N.NativeInvokeBackend):
    name = "layer-timeline-package-fixture"

    def __init__(self) -> None:
        self.items = tuple(_descriptor(contract) for contract in TL.CAPABILITY_CONTRACTS.values())
        self.negotiation = self._negotiation()
        self.requests: list[N.NativeInvokeRequest] = []
        self.tamper_postcondition: str | None = None
        self.tamper_duplicate_semantics = False

    def _negotiation(self) -> N.NativeNegotiation:
        return N.NativeNegotiation(
            selected_wire_version=1,
            plugin_version="0.9.2",
            compiled_sdk_version="25.6.61",
            source_commit="a" * 40,
            host_instance_id=HOST,
            host_platform="macos-arm64",
            session_id=SESSION,
            session_generation=3,
            capabilities_digest=N._capabilities_registry_digest(self.items),
        )

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
                session_id=SESSION, ids=None, detail="full", limit=100,
            ),
            capabilities_digest=self.negotiation.capabilities_digest,
        )

    def _value(self, request: N.NativeInvokeRequest) -> dict[str, Any]:
        arguments = request.arguments
        capability = request.capability_id
        layer = arguments["layerLocator"]
        composition = _locator("composition", COMP_OBJECT)
        if capability == TL.LAYER_DETAILS_READ_CAPABILITY_ID:
            if layer["generation"] == 4:
                composition = _locator(
                    "composition", COMP_OBJECT, generation=4, project_id=REFRESHED_PROJECT,
                )
                return _details(
                    layer,
                    composition,
                    name=(
                        "Duplicated Layer"
                        if layer["objectId"] == NEW_LAYER_OBJECT
                        else "Fixture Layer"
                    ),
                )
            return _details(layer, composition)
        if capability == TL.LAYER_NAME_SET_CAPABILITY_ID:
            return {
                "changed": True, "layerLocator": layer,
                "beforeName": "Fixture Layer", "afterName": arguments["name"],
            }
        if capability == TL.LAYER_RANGE_SET_CAPABILITY_ID:
            return {
                "changed": True, "layerLocator": layer,
                "beforeInPoint": _time(0, 1), "beforeDuration": _time(10, 1),
                "afterInPoint": _time(arguments["inPoint"]["value"], arguments["inPoint"]["scale"]),
                "afterDuration": _time(arguments["duration"]["value"], arguments["duration"]["scale"]),
            }
        if capability == TL.LAYER_START_TIME_SET_CAPABILITY_ID:
            return {
                "changed": True, "layerLocator": layer,
                "beforeStartTime": _time(0, 1),
                "afterStartTime": _time(arguments["startTime"]["value"], arguments["startTime"]["scale"]),
            }
        if capability == TL.LAYER_STRETCH_SET_CAPABILITY_ID:
            stretch = arguments["stretch"]
            return {
                "changed": True, "layerLocator": layer,
                "beforeStretch": _ratio(1, 1),
                "afterStretch": _ratio(stretch["num"], stretch["den"]),
            }
        if capability == TL.LAYER_ORDER_SET_CAPABILITY_ID:
            return {
                "changed": True, "layerLocator": layer,
                "beforeStackIndex": 1, "afterStackIndex": arguments["targetStackIndex"],
            }
        if capability == TL.LAYER_PARENT_SET_CAPABILITY_ID:
            return {
                "changed": True, "layerLocator": layer,
                "beforeParentLocator": None,
                "afterParentLocator": arguments["parentLayerLocator"],
            }
        if capability == TL.LAYER_DUPLICATE_CAPABILITY_ID:
            source = _locator(
                "layer", layer["objectId"], generation=4, project_id=REFRESHED_PROJECT,
            )
            created = _locator(
                "layer", NEW_LAYER_OBJECT, generation=4, project_id=REFRESHED_PROJECT,
            )
            fresh_composition = _locator(
                "composition", COMP_OBJECT, generation=4, project_id=REFRESHED_PROJECT,
            )
            new_layer = _details(created, fresh_composition, name=arguments["newName"])
            if self.tamper_duplicate_semantics:
                new_layer["duration"] = _time(9, 1)
            return {
                "changed": True,
                "sourceLayerLocator": source,
                "newLayerLocator": created,
                "compositionLocator": fresh_composition,
                "layerCountBefore": 2,
                "layerCountAfter": 3,
                "newLayer": new_layer,
            }
        raise AssertionError(capability)

    async def invoke(self, request, *, cancellation=None):
        del cancellation
        self.requests.append(request)
        raw_value = self._value(request)
        value = VALUE_MODELS[request.capability_id].model_validate(raw_value)
        contract = TL.CAPABILITY_CONTRACTS[request.capability_id]
        digest = TL._value_digest(request.capability_id, value)
        if self.tamper_postcondition == request.capability_id:
            digest = "f" * 64
        is_write = contract.risk == "write"
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
                effect="committed" if is_write else "none",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True,
                    kind=contract.postcondition_kind,
                    algorithm="sha256-rfc8785-jcs-v1",
                    digest=digest,
                ),
                undo=N.NativeUndoEvidence(available=True, verified=False) if is_write else None,
            ),
        )


def _deadline() -> int:
    return int(time.time() * 1000) + 5_000


def test_public_schema_names_are_frozen_closed_and_annotated():
    load_all()
    for verb, expected_fields in PUBLIC_TOOLS.items():
        schema_cls, _handler = HANDLERS[verb]
        schema = schema_cls.model_json_schema()
        assert schema["additionalProperties"] is False
        assert set(schema["properties"]) == set(expected_fields)
        assert VERB_ANNOTATIONS[verb].destructiveHint is False
        assert VERB_ANNOTATIONS[verb].idempotentHint is True
    assert VERB_ANNOTATIONS["ae.getLayerDetails"].readOnlyHint is True
    assert VERB_ANNOTATIONS["ae.duplicateLayer"].readOnlyHint is False


def test_core_contracts_equal_the_frozen_native_protocol_contracts():
    protocol = json.loads(Path("native/ae-plugin/protocol/aegp-rpc.schema.json").read_text())["$defs"]
    definitions = {
        TL.LAYER_DETAILS_READ_CAPABILITY_ID: ("layerDetailsReadInputSchemaContract", "layerDetailsReadResultSchemaContract"),
        TL.LAYER_NAME_SET_CAPABILITY_ID: ("layerNameSetInputSchemaContract", "layerNameSetResultSchemaContract"),
        TL.LAYER_RANGE_SET_CAPABILITY_ID: ("layerRangeSetInputSchemaContract", "layerRangeSetResultSchemaContract"),
        TL.LAYER_START_TIME_SET_CAPABILITY_ID: ("layerStartTimeSetInputSchemaContract", "layerStartTimeSetResultSchemaContract"),
        TL.LAYER_STRETCH_SET_CAPABILITY_ID: ("layerStretchSetInputSchemaContract", "layerStretchSetResultSchemaContract"),
        TL.LAYER_ORDER_SET_CAPABILITY_ID: ("layerOrderSetInputSchemaContract", "layerOrderSetResultSchemaContract"),
        TL.LAYER_PARENT_SET_CAPABILITY_ID: ("layerParentSetInputSchemaContract", "layerParentSetResultSchemaContract"),
        TL.LAYER_DUPLICATE_CAPABILITY_ID: ("layerDuplicateInputSchemaContract", "layerDuplicateResultSchemaContract"),
    }
    assert len(TL.CAPABILITY_CONTRACTS) == 8
    for capability_id, (input_name, result_name) in definitions.items():
        contract = TL.CAPABILITY_CONTRACTS[capability_id]
        assert contract.input_schema == protocol[input_name]["const"]
        assert contract.result_schema == protocol[result_name]["const"]
        assert contract.contract_digest == N._sha256_closed_json({
            "inputSchema": contract.input_schema,
            "resultSchema": contract.result_schema,
        })


def test_public_stretch_percentage_is_exactly_canonicalized_for_aegp():
    assert TL.stretch_percent_to_ratio("100").model_dump(by_alias=True) == {"num": 1, "den": 1}
    assert TL.stretch_percent_to_ratio("125").model_dump(by_alias=True) == {"num": 5, "den": 4}
    assert TL.stretch_percent_to_ratio("-50").model_dump(by_alias=True) == {"num": -1, "den": 2}
    assert TL.stretch_percent_to_ratio("0.000001").model_dump(by_alias=True) == {
        "num": 1, "den": 100_000_000,
    }


def test_public_validation_error_is_structured_and_actionable():
    with pytest.raises(ValidationError) as raised:
        schemas.AeSetLayerStretchArgs.model_validate({
            "layer_locator": _locator("layer", LAYER_OBJECT),
            "stretch_percent": "0",
            "idempotency_key": "layer-stretch-intent-0001",
        })
    error = server_module._project_composition_validation_error("ae.setLayerStretch", raised.value)
    assert error["code"] == "INVALID_ARGUMENT"
    assert error["sideEffect"] == "not-started"
    assert error["recovery"]["action"] == "change-arguments"
    assert error["details"] == {
        "field": "arguments.stretch_percent",
        "capabilityId": TL.LAYER_STRETCH_SET_CAPABILITY_ID,
    }


@pytest.mark.asyncio
async def test_read_and_seven_writes_bind_wire_readback_audit_and_undo():
    backend = PackageBackend()
    layer = _locator("layer", LAYER_OBJECT)
    parent = _locator("layer", PARENT_OBJECT)
    details = await TL.invoke_layer_details_read(
        backend, request_id="layer-details-1", layer_locator=layer, deadline_unix_ms=_deadline(),
    )
    renamed = await TL.invoke_layer_name_set(
        backend, request_id="layer-name-1", layer_locator=layer, name="Renamed Layer",
        idempotency_key="layer-name-intent-0001", deadline_unix_ms=_deadline(),
    )
    ranged = await TL.invoke_layer_range_set(
        backend, request_id="layer-range-1", layer_locator=layer,
        in_point={"value": 1, "scale": 24}, duration={"value": 120, "scale": 24},
        idempotency_key="layer-range-intent-0001", deadline_unix_ms=_deadline(),
    )
    started = await TL.invoke_layer_start_time_set(
        backend, request_id="layer-start-1", layer_locator=layer,
        start_time={"value": -12, "scale": 24},
        idempotency_key="layer-start-intent-0001", deadline_unix_ms=_deadline(),
    )
    stretched = await TL.invoke_layer_stretch_set(
        backend, request_id="layer-stretch-1", layer_locator=layer,
        stretch={"num": -1, "den": 2},
        idempotency_key="layer-stretch-intent-0002", deadline_unix_ms=_deadline(),
    )
    reordered = await TL.invoke_layer_order_set(
        backend, request_id="layer-order-1", layer_locator=layer, target_stack_index=2,
        idempotency_key="layer-order-intent-0001", deadline_unix_ms=_deadline(),
    )
    parented = await TL.invoke_layer_parent_set(
        backend, request_id="layer-parent-1", layer_locator=layer, parent_layer_locator=parent,
        idempotency_key="layer-parent-intent-0001", deadline_unix_ms=_deadline(),
    )
    duplicated = await TL.invoke_layer_duplicate(
        backend, request_id="layer-duplicate-1", layer_locator=layer, new_name="Duplicated Layer",
        idempotency_key="layer-duplicate-intent-0001", deadline_unix_ms=_deadline(),
    )

    assert details.value.name == "Fixture Layer"
    assert renamed.value.after_name == "Renamed Layer"
    assert ranged.value.after_in_point.seconds_rational == "1/24"
    assert started.value.after_start_time.seconds_rational == "-1/2"
    assert stretched.value.after_stretch.rational == "-1/2"
    assert reordered.value.after_stack_index == 2
    assert parented.value.after_parent_locator == N.NativeLocator.model_validate(parent)
    assert duplicated.value.new_layer.name == "Duplicated Layer"
    assert duplicated.value.source_layer_locator.project_id == REFRESHED_PROJECT
    assert duplicated.value.source_layer_locator.object_id == LAYER_OBJECT
    assert details.evidence.effect == "none"
    for execution in (renamed, ranged, started, stretched, reordered, parented, duplicated):
        assert execution.evidence.effect == "committed"
        assert execution.evidence.undo is not None
        assert execution.evidence.undo.available is True
        assert execution.evidence.undo.verified is False
        assert execution.audit_fields()["undoVerified"] is False


@pytest.mark.asyncio
async def test_stale_locator_and_descriptor_drift_fail_before_dispatch():
    backend = PackageBackend()
    with pytest.raises(N.NativeBackendError) as stale:
        await TL.invoke_layer_name_set(
            backend,
            request_id="layer-stale-1",
            layer_locator=_locator(
                "layer", LAYER_OBJECT, session_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            ),
            name="Renamed",
            idempotency_key="layer-stale-intent-0001",
            deadline_unix_ms=_deadline(),
        )
    assert stale.value.code == "STALE_LOCATOR"
    assert backend.requests == []

    first = backend.items[0].model_copy(update={"summary": "drifted"})
    backend.items = (first, *backend.items[1:])
    backend.negotiation = backend._negotiation()
    with pytest.raises(N.NativeBackendError) as drift:
        await TL.invoke_layer_details_read(
            backend,
            request_id="layer-drift-1",
            layer_locator=_locator("layer", LAYER_OBJECT),
            deadline_unix_ms=_deadline(),
        )
    assert drift.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert backend.requests == []


@pytest.mark.asyncio
async def test_tampered_write_postcondition_preserves_side_effect_uncertainty():
    backend = PackageBackend()
    backend.tamper_postcondition = TL.LAYER_NAME_SET_CAPABILITY_ID
    with pytest.raises(N.NativeBackendError) as raised:
        await TL.invoke_layer_name_set(
            backend,
            request_id="layer-tamper-1",
            layer_locator=_locator("layer", LAYER_OBJECT),
            name="Renamed",
            idempotency_key="layer-tamper-intent-0001",
            deadline_unix_ms=_deadline(),
        )
    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False


@pytest.mark.asyncio
async def test_duplicate_rejects_unrelated_layer_semantics_after_commit():
    backend = PackageBackend()
    backend.tamper_duplicate_semantics = True
    with pytest.raises(N.NativeBackendError) as raised:
        await TL.invoke_layer_duplicate(
            backend,
            request_id="layer-duplicate-semantic-mismatch-1",
            layer_locator=_locator("layer", LAYER_OBJECT),
            new_name="Duplicated Layer",
            idempotency_key="layer-duplicate-semantic-mismatch-intent-0001",
            deadline_unix_ms=_deadline(),
        )
    assert [request.capability_id for request in backend.requests] == [
        TL.LAYER_DUPLICATE_CAPABILITY_ID,
        TL.LAYER_DETAILS_READ_CAPABILITY_ID,
    ]
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False


@pytest.mark.asyncio
async def test_public_handlers_map_snake_case_to_closed_native_wire(monkeypatch):
    backend = PackageBackend()
    monkeypatch.setattr(native_handlers._discovery, "select_backend", lambda: backend)
    layer = _locator("layer", LAYER_OBJECT)
    read = await native_handlers._run_get_layer_details(
        schemas.AeGetLayerDetailsArgs(layer_locator=layer), None,
    )
    stretch = await native_handlers._run_set_layer_stretch(
        schemas.AeSetLayerStretchArgs(
            layer_locator=layer,
            stretch_percent="125",
            idempotency_key="public-stretch-intent-0001",
        ),
        None,
    )
    assert read["ok"] is True
    assert read["implementation"]["capabilityId"] == TL.LAYER_DETAILS_READ_CAPABILITY_ID
    assert stretch["ok"] is True
    assert stretch["audit"]["effect"] == "committed"
    assert backend.requests[0].arguments == {"layerLocator": layer}
    assert backend.requests[1].arguments == {
        "layerLocator": layer,
        "stretch": {"num": 5, "den": 4},
        "idempotencyKey": "public-stretch-intent-0001",
    }
