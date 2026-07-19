"""Focused Core/native contracts for the #157 keyframe-authoring package."""

from __future__ import annotations

import json
import time
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ae_mcp import schemas
from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.backends import native as N
from ae_mcp.backends import native_keyframe_authoring as K
from ae_mcp.backends.native_project_composition import _validate_descriptor
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handlers


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "44444444-4444-4444-8444-444444444444"
LAYER = "77777777-7777-4777-8777-777777777777"
STREAM = "88888888-8888-4888-8888-888888888888"


def test_checked_in_native_descriptors_match_all_core_contract_fields():
    fixture_path = (
        Path(__file__).resolve().parents[3]
        / "native"
        / "ae-plugin"
        / "protocol"
        / "fixtures"
        / "capabilities.json"
    )
    payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    descriptors = {
        item["id"]: N.NativeCapabilityDescriptor.model_validate(item)
        for item in payload["response"]["result"]["items"]
        if item["id"] in K.CAPABILITY_CONTRACTS
    }

    assert set(descriptors) == set(K.CAPABILITY_CONTRACTS)
    for capability_id, contract in K.CAPABILITY_CONTRACTS.items():
        descriptor = descriptors[capability_id]
        _validate_descriptor(
            descriptor,
            host_platform="macos-arm64",
            contract=contract,
        )
        _validate_descriptor(
            descriptor,
            host_platform="windows-x64",
            contract=contract,
        )


def locator(kind: str, object_id: str, *, session: str = SESSION) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": session,
        "projectId": PROJECT,
        "generation": 3,
        "objectId": object_id,
    }


def exact_time(value: int = 12, scale: int = 24) -> dict[str, Any]:
    return {
        "value": value,
        "scale": scale,
        "secondsRational": str(Fraction(value, scale)),
    }


def ease(speed: str = "0", influence: str = "33.333") -> dict[str, Any]:
    return {"speed": speed, "influence": influence}


def dimension(
    *,
    in_speed: str = "0",
    in_influence: str = "33.333",
    out_speed: str = "0",
    out_influence: str = "33.333",
) -> dict[str, Any]:
    return {
        "dimension": 0,
        "inEase": ease(in_speed, in_influence),
        "outEase": ease(out_speed, out_influence),
    }


def behaviors(**changed: bool) -> dict[str, bool]:
    result = {
        "temporalContinuous": False,
        "temporalAutoBezier": False,
        "spatialContinuous": False,
        "spatialAutoBezier": False,
        "roving": False,
    }
    result.update(changed)
    return result


def details(
    *,
    value: str = "0",
    in_interpolation: str = "linear",
    out_interpolation: str = "linear",
    dimensions: list[dict[str, Any]] | None = None,
    flags: dict[str, bool] | None = None,
) -> dict[str, Any]:
    return {
        "propertyLocator": locator("stream", STREAM),
        "time": exact_time(),
        "temporalDimensionality": 1,
        "valueType": "one-d",
        "value": {"kind": "scalar", "value": value},
        "inInterpolation": in_interpolation,
        "outInterpolation": out_interpolation,
        "temporalEaseDimensions": dimensions or [dimension()],
        "behaviors": flags or behaviors(),
    }


def descriptor(contract: K.CapabilityContract) -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=contract.capability_id,
        version=K.CAPABILITY_VERSION,
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


class PackageBackend(N.NativeInvokeBackend):
    name = "keyframe-authoring-package-fixture"

    def __init__(self) -> None:
        self.items = tuple(
            descriptor(contract) for contract in K.CAPABILITY_CONTRACTS.values()
        )
        self.negotiation = self._negotiation()
        self.requests: list[N.NativeInvokeRequest] = []
        self.tamper_postcondition: str | None = None

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
                session_id=SESSION,
                ids=None,
                detail="full",
                limit=100,
            ),
            capabilities_digest=self.negotiation.capabilities_digest,
        )

    def _mutation(
        self,
        request: N.NativeInvokeRequest,
        *,
        before: dict[str, Any] | None,
        after: dict[str, Any] | None,
        count_before: int = 1,
        count_after: int = 1,
    ) -> dict[str, Any]:
        return {
            "changed": True,
            "layerLocator": request.arguments["layerLocator"],
            "propertyLocator": request.arguments["propertyLocator"],
            "time": exact_time(
                request.arguments["time"]["value"],
                request.arguments["time"]["scale"],
            ),
            "keyframeCountBefore": count_before,
            "keyframeCountAfter": count_after,
            "beforeKeyframe": before,
            "afterKeyframe": after,
        }

    def _value(self, request: N.NativeInvokeRequest) -> dict[str, Any]:
        capability = request.capability_id
        arguments = request.arguments
        if capability == K.KEYFRAME_DETAILS_READ_CAPABILITY_ID:
            return details()
        if capability == K.KEYFRAME_ADD_CAPABILITY_ID:
            after = details(value=arguments["value"]["value"])
            return self._mutation(
                request,
                before=None,
                after=after,
                count_before=0,
                count_after=1,
            )
        if capability == K.KEYFRAME_VALUE_SET_CAPABILITY_ID:
            return self._mutation(
                request,
                before=details(value="0"),
                after=details(value=arguments["value"]["value"]),
            )
        if capability == K.KEYFRAME_INTERPOLATION_SET_CAPABILITY_ID:
            return self._mutation(
                request,
                before=details(),
                after=details(
                    in_interpolation=arguments["inInterpolation"],
                    out_interpolation=arguments["outInterpolation"],
                ),
            )
        if capability == K.KEYFRAME_TEMPORAL_EASE_SET_CAPABILITY_ID:
            return self._mutation(
                request,
                before=details(),
                after=details(dimensions=arguments["dimensions"]),
            )
        if capability == K.KEYFRAME_BEHAVIOR_SET_CAPABILITY_ID:
            flag = arguments["behavior"].replace("-", " ").title().replace(" ", "")
            flag = flag[0].lower() + flag[1:]
            return self._mutation(
                request,
                before=details(),
                after=details(flags=behaviors(**{flag: arguments["enabled"]})),
            )
        if capability == K.KEYFRAME_DELETE_CAPABILITY_ID:
            return self._mutation(
                request,
                before=details(),
                after=None,
                count_before=1,
                count_after=0,
            )
        raise AssertionError(capability)

    async def invoke(self, request, *, cancellation=None):
        del cancellation
        self.requests.append(request)
        raw_value = self._value(request)
        contract = K.CAPABILITY_CONTRACTS[request.capability_id]
        model = (
            K.KeyframeDetails
            if contract.risk == "read"
            else K.KeyframeMutationValue
        )
        value = model.model_validate(raw_value)
        digest = K._value_digest(request.capability_id, value)
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
                undo=(
                    N.NativeUndoEvidence(available=True, verified=False)
                    if is_write
                    else None
                ),
            ),
        )


def deadline() -> int:
    return int(time.time() * 1000) + 5_000


def common() -> dict[str, Any]:
    return {
        "layer_locator": locator("layer", LAYER),
        "property_locator": locator("stream", STREAM),
        "time": {"value": 12, "scale": 24},
        "idempotency_key": "issue157-keyframe-intent-0001",
    }


def test_public_handlers_are_frozen_native_only_and_annotated():
    load_all()
    expected = {
        "ae.getLayerPropertyKeyframeDetails": schemas.AeGetLayerPropertyKeyframeDetailsArgs,
        "ae.addLayerPropertyKeyframe": schemas.AeAddLayerPropertyKeyframeArgs,
        "ae.setLayerPropertyKeyframeValue": schemas.AeSetLayerPropertyKeyframeValueArgs,
        "ae.setLayerPropertyKeyframeInterpolation": schemas.AeSetLayerPropertyKeyframeInterpolationArgs,
        "ae.setLayerPropertyKeyframeTemporalEase": schemas.AeSetLayerPropertyKeyframeTemporalEaseArgs,
        "ae.setLayerPropertyKeyframeBehavior": schemas.AeSetLayerPropertyKeyframeBehaviorArgs,
        "ae.deleteLayerPropertyKeyframe": schemas.AeDeleteLayerPropertyKeyframeArgs,
    }
    for verb, model in expected.items():
        assert HANDLERS[verb][0] is model
        assert VERB_ANNOTATIONS[verb].idempotentHint is True
    assert VERB_ANNOTATIONS["ae.getLayerPropertyKeyframeDetails"].readOnlyHint
    assert VERB_ANNOTATIONS["ae.deleteLayerPropertyKeyframe"].destructiveHint


@pytest.mark.asyncio
async def test_read_and_six_writes_bind_typed_readback_audit_and_undo():
    backend = PackageBackend()
    layer = locator("layer", LAYER)
    prop = locator("stream", STREAM)
    target_time = {"value": 12, "scale": 24}
    read = await K.invoke_keyframe_details_read(
        backend,
        request_id="keyframe-read-1",
        property_locator=prop,
        time=target_time,
        deadline_unix_ms=deadline(),
    )
    writes = [
        await K.invoke_keyframe_add(
            backend,
            request_id="keyframe-add-1",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            value={"kind": "scalar", "value": "25"},
            idempotency_key="keyframe-add-intent-0001",
            deadline_unix_ms=deadline(),
        ),
        await K.invoke_keyframe_value_set(
            backend,
            request_id="keyframe-value-1",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            value={"kind": "scalar", "value": "75"},
            idempotency_key="keyframe-value-intent-0001",
            deadline_unix_ms=deadline(),
        ),
        await K.invoke_keyframe_interpolation_set(
            backend,
            request_id="keyframe-interpolation-1",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            in_interpolation="bezier",
            out_interpolation="hold",
            idempotency_key="keyframe-interpolation-intent-0001",
            deadline_unix_ms=deadline(),
        ),
        await K.invoke_keyframe_temporal_ease_set(
            backend,
            request_id="keyframe-ease-1",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            dimensions=(
                {
                    "dimension": 0,
                    "inEase": ease("10", "25"),
                    "outEase": ease("20", "75"),
                },
            ),
            idempotency_key="keyframe-ease-intent-0001",
            deadline_unix_ms=deadline(),
        ),
        await K.invoke_keyframe_behavior_set(
            backend,
            request_id="keyframe-behavior-1",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            behavior="temporal-auto-bezier",
            enabled=True,
            idempotency_key="keyframe-behavior-intent-0001",
            deadline_unix_ms=deadline(),
        ),
        await K.invoke_keyframe_delete(
            backend,
            request_id="keyframe-delete-1",
            layer_locator=layer,
            property_locator=prop,
            time=target_time,
            idempotency_key="keyframe-delete-intent-0001",
            deadline_unix_ms=deadline(),
        ),
    ]
    assert read.value.temporal_dimensionality == 1
    assert read.evidence.effect == "none"
    assert len(backend.requests) == 7
    for execution in writes:
        assert execution.evidence.effect == "committed"
        assert execution.evidence.undo is not None
        assert execution.evidence.undo.available is True
        assert execution.audit_fields()["undoVerified"] is False


@pytest.mark.asyncio
async def test_tampered_write_postcondition_preserves_side_effect_uncertainty():
    backend = PackageBackend()
    backend.tamper_postcondition = K.KEYFRAME_VALUE_SET_CAPABILITY_ID
    with pytest.raises(N.NativeBackendError) as raised:
        await K.invoke_keyframe_value_set(
            backend,
            request_id="keyframe-value-tamper-1",
            layer_locator=locator("layer", LAYER),
            property_locator=locator("stream", STREAM),
            time={"value": 12, "scale": 24},
            value={"kind": "scalar", "value": "75"},
            idempotency_key="keyframe-value-tamper-0001",
            deadline_unix_ms=deadline(),
        )
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False


@pytest.mark.asyncio
async def test_write_rejects_unrelated_keyframe_state_change_after_dispatch():
    backend = PackageBackend()
    original_value = backend._value

    def tampered_value(request: N.NativeInvokeRequest) -> dict[str, Any]:
        value = original_value(request)
        if request.capability_id == K.KEYFRAME_VALUE_SET_CAPABILITY_ID:
            value["afterKeyframe"]["outInterpolation"] = "hold"
        return value

    backend._value = tampered_value  # type: ignore[method-assign]
    with pytest.raises(N.NativeBackendError) as raised:
        await K.invoke_keyframe_value_set(
            backend,
            request_id="keyframe-value-unrelated-tamper-1",
            layer_locator=locator("layer", LAYER),
            property_locator=locator("stream", STREAM),
            time={"value": 12, "scale": 24},
            value={"kind": "scalar", "value": "75"},
            idempotency_key="keyframe-value-unrelated-0001",
            deadline_unix_ms=deadline(),
        )
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"


@pytest.mark.asyncio
async def test_interpolation_accepts_ae_ease_normalization():
    backend = PackageBackend()
    original_value = backend._value

    def normalized_value(request: N.NativeInvokeRequest) -> dict[str, Any]:
        value = original_value(request)
        if request.capability_id == K.KEYFRAME_INTERPOLATION_SET_CAPABILITY_ID:
            value["beforeKeyframe"]["temporalEaseDimensions"] = [
                dimension(
                    in_influence="16.666666666999998",
                    out_influence="16.666666666999998",
                )
            ]
            value["afterKeyframe"]["temporalEaseDimensions"] = [
                dimension(
                    in_influence="0",
                    out_influence="16.666666666999998",
                )
            ]
        return value

    backend._value = normalized_value  # type: ignore[method-assign]
    execution = await K.invoke_keyframe_interpolation_set(
        backend,
        request_id="keyframe-interpolation-normalized-ease-1",
        layer_locator=locator("layer", LAYER),
        property_locator=locator("stream", STREAM),
        time={"value": 12, "scale": 24},
        in_interpolation="bezier",
        out_interpolation="hold",
        idempotency_key="keyframe-interpolation-normalized-ease-0001",
        deadline_unix_ms=deadline(),
    )
    assert execution.value.before_keyframe is not None
    assert execution.value.after_keyframe is not None
    assert (
        execution.value.before_keyframe.temporal_ease_dimensions[0].in_ease.influence
        == "16.666666666999998"
    )
    assert (
        execution.value.after_keyframe.temporal_ease_dimensions[0].in_ease.influence
        == "0"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "drift",
    [
        "value",
        "count",
        "in_speed",
        "out_speed",
        "out_influence",
        "in_influence_nonzero",
        "non_bezier",
        "dimension",
    ],
)
async def test_interpolation_rejects_unrelated_state_drift(drift: str):
    backend = PackageBackend()
    original_value = backend._value

    def tampered_value(request: N.NativeInvokeRequest) -> dict[str, Any]:
        value = original_value(request)
        if request.capability_id == K.KEYFRAME_INTERPOLATION_SET_CAPABILITY_ID:
            value["beforeKeyframe"]["temporalEaseDimensions"] = [
                dimension(
                    in_influence="16.666666666999998",
                    out_influence="16.666666666999998",
                )
            ]
            value["afterKeyframe"]["temporalEaseDimensions"] = [
                dimension(
                    in_influence="0",
                    out_influence="16.666666666999998",
                )
            ]
            if drift == "value":
                value["afterKeyframe"]["value"] = {"kind": "scalar", "value": "2"}
            elif drift == "count":
                value["keyframeCountAfter"] += 1
            elif drift == "in_speed":
                value["afterKeyframe"]["temporalEaseDimensions"][0]["inEase"][
                    "speed"
                ] = "1"
            elif drift == "out_speed":
                value["afterKeyframe"]["temporalEaseDimensions"][0]["outEase"][
                    "speed"
                ] = "1"
            elif drift == "out_influence":
                value["afterKeyframe"]["temporalEaseDimensions"][0]["outEase"][
                    "influence"
                ] = "1"
            elif drift == "in_influence_nonzero":
                value["afterKeyframe"]["temporalEaseDimensions"][0]["inEase"][
                    "influence"
                ] = "1"
            elif drift == "dimension":
                value["afterKeyframe"]["temporalEaseDimensions"][0]["dimension"] = 1
        return value

    backend._value = tampered_value  # type: ignore[method-assign]
    expected_error = ValidationError if drift == "dimension" else N.NativeBackendError
    with pytest.raises(expected_error) as raised:
        await K.invoke_keyframe_interpolation_set(
            backend,
            request_id=f"keyframe-interpolation-{drift}-drift-1",
            layer_locator=locator("layer", LAYER),
            property_locator=locator("stream", STREAM),
            time={"value": 12, "scale": 24},
            in_interpolation="linear" if drift == "non_bezier" else "bezier",
            out_interpolation="hold",
            idempotency_key=f"keyframe-interpolation-{drift}-drift-0001",
            deadline_unix_ms=deadline(),
        )
    if drift != "dimension":
        assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"


@pytest.mark.asyncio
async def test_behavior_write_accepts_ae_linked_behavior_flag_changes():
    backend = PackageBackend()
    original_value = backend._value

    def linked_behavior_value(request: N.NativeInvokeRequest) -> dict[str, Any]:
        value = original_value(request)
        if request.capability_id == K.KEYFRAME_BEHAVIOR_SET_CAPABILITY_ID:
            value["afterKeyframe"]["behaviors"]["temporalContinuous"] = True
        return value

    backend._value = linked_behavior_value  # type: ignore[method-assign]
    execution = await K.invoke_keyframe_behavior_set(
        backend,
        request_id="keyframe-behavior-linked-flags-1",
        layer_locator=locator("layer", LAYER),
        property_locator=locator("stream", STREAM),
        time={"value": 12, "scale": 24},
        behavior="temporal-auto-bezier",
        enabled=True,
        idempotency_key="keyframe-behavior-linked-0001",
        deadline_unix_ms=deadline(),
    )
    assert execution.value.after_keyframe is not None
    assert execution.value.after_keyframe.behaviors.temporal_auto_bezier is True
    assert execution.value.after_keyframe.behaviors.temporal_continuous is True


@pytest.mark.asyncio
async def test_stale_locator_fails_before_dispatch():
    backend = PackageBackend()
    with pytest.raises(N.NativeBackendError) as raised:
        await K.invoke_keyframe_delete(
            backend,
            request_id="keyframe-delete-stale-1",
            layer_locator=locator(
                "layer",
                LAYER,
                session="99999999-9999-4999-8999-999999999999",
            ),
            property_locator=locator(
                "stream",
                STREAM,
                session="99999999-9999-4999-8999-999999999999",
            ),
            time={"value": 12, "scale": 24},
            idempotency_key="keyframe-delete-stale-0001",
            deadline_unix_ms=deadline(),
        )
    assert raised.value.code == "STALE_LOCATOR"
    assert backend.requests == []


@pytest.mark.asyncio
async def test_public_handler_maps_snake_case_to_closed_native_wire(monkeypatch):
    backend = PackageBackend()
    monkeypatch.setattr(native_handlers._discovery, "select_backend", lambda: backend)
    response = await native_handlers._run_set_layer_property_keyframe_behavior(
        schemas.AeSetLayerPropertyKeyframeBehaviorArgs(
            **common(), behavior="roving", enabled=True
        ),
        None,
    )
    assert response["ok"] is True
    assert response["implementation"]["engine"] == "native-aegp"
    assert response["audit"]["effect"] == "committed"
    assert backend.requests[0].arguments == {
        "propertyLocator": locator("stream", STREAM),
        "time": {"value": 12, "scale": 24},
        "layerLocator": locator("layer", LAYER),
        "idempotencyKey": "issue157-keyframe-intent-0001",
        "behavior": "roving",
        "enabled": True,
    }
