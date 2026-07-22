"""Focused Core contracts for the #162 Layer Switches / Compositing package."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from ae_mcp import schemas
from ae_mcp.annotations import VERB_ANNOTATIONS
from ae_mcp.backends import native as N
from ae_mcp.backends import native_layer_compositing as LC
from ae_mcp.handlers import HANDLERS, load_all
from ae_mcp.handlers import native as native_handlers


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "44444444-4444-4444-8444-444444444444"
LAYER = "77777777-7777-4777-8777-777777777777"

PUBLIC_TOOLS = {
    "ae.getLayerCompositingState": ("layer_locator",),
    "ae.setLayerVisibility": ("layer_locator", "idempotency_key", "enabled"),
    "ae.setLayerSolo": ("layer_locator", "idempotency_key", "enabled"),
    "ae.setLayerLocked": ("layer_locator", "idempotency_key", "enabled"),
    "ae.setLayerShy": ("layer_locator", "idempotency_key", "enabled"),
    "ae.setLayerMotionBlur": ("layer_locator", "idempotency_key", "enabled"),
    "ae.setLayerThreeD": ("layer_locator", "idempotency_key", "enabled"),
    "ae.setLayerAdjustment": ("layer_locator", "idempotency_key", "enabled"),
    "ae.setLayerQuality": ("layer_locator", "idempotency_key", "quality"),
    "ae.setLayerBlendingMode": ("layer_locator", "idempotency_key", "mode"),
}

SWITCH_HANDLERS = {
    native_handlers._run_set_layer_visibility: "visibility",
    native_handlers._run_set_layer_solo: "solo",
    native_handlers._run_set_layer_locked: "locked",
    native_handlers._run_set_layer_shy: "shy",
    native_handlers._run_set_layer_motion_blur: "motion-blur",
    native_handlers._run_set_layer_three_d: "three-d",
    native_handlers._run_set_layer_adjustment: "adjustment",
}


def _locator(*, session_id: str = SESSION) -> dict[str, Any]:
    return {
        "kind": "layer",
        "hostInstanceId": HOST,
        "sessionId": session_id,
        "projectId": PROJECT,
        "generation": 3,
        "objectId": LAYER,
    }


def _state(locator: dict[str, Any]) -> dict[str, Any]:
    return {
        "layerLocator": locator,
        "visibilityEnabled": True,
        "solo": False,
        "locked": False,
        "shy": False,
        "motionBlur": False,
        "threeD": False,
        "adjustment": False,
        "quality": "best",
        "blendingMode": "normal",
        "preserveAlpha": False,
        "trackMatte": "none",
    }


VALUE_MODELS = {
    LC.LAYER_COMPOSITING_READ_CAPABILITY_ID: LC.LayerCompositingState,
    LC.LAYER_SWITCH_SET_CAPABILITY_ID: LC.LayerSwitchChanged,
    LC.LAYER_QUALITY_SET_CAPABILITY_ID: LC.LayerQualityChanged,
    LC.LAYER_BLENDING_MODE_SET_CAPABILITY_ID: LC.LayerBlendingModeChanged,
}


def _descriptor(contract) -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=contract.capability_id,
        version=LC.CAPABILITY_VERSION,
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
    name = "layer-compositing-package-fixture"

    def __init__(self) -> None:
        self.items = tuple(_descriptor(contract) for contract in LC.CAPABILITY_CONTRACTS.values())
        self.requests: list[N.NativeInvokeRequest] = []
        self.tamper_postcondition: str | None = None
        self.negotiation = N.NativeNegotiation(
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
        args = request.arguments
        locator = args["layerLocator"]
        if request.capability_id == LC.LAYER_COMPOSITING_READ_CAPABILITY_ID:
            return _state(locator)
        if request.capability_id == LC.LAYER_SWITCH_SET_CAPABILITY_ID:
            return {
                "changed": True,
                "layerLocator": locator,
                "switch": args["switch"],
                "beforeEnabled": not args["enabled"],
                "afterEnabled": args["enabled"],
            }
        if request.capability_id == LC.LAYER_QUALITY_SET_CAPABILITY_ID:
            return {
                "changed": True,
                "layerLocator": locator,
                "beforeQuality": "best" if args["quality"] != "best" else "draft",
                "afterQuality": args["quality"],
            }
        if request.capability_id == LC.LAYER_BLENDING_MODE_SET_CAPABILITY_ID:
            return {
                "changed": True,
                "layerLocator": locator,
                "beforeMode": "normal" if args["mode"] != "normal" else "multiply",
                "afterMode": args["mode"],
                "preserveAlpha": False,
                "trackMatte": "none",
            }
        raise AssertionError(request.capability_id)

    async def invoke(self, request, *, cancellation=None):
        del cancellation
        self.requests.append(request)
        raw_value = self._value(request)
        value = VALUE_MODELS[request.capability_id].model_validate(raw_value)
        contract = LC.CAPABILITY_CONTRACTS[request.capability_id]
        digest = LC._value_digest(request.capability_id, value)
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


def test_public_schemas_are_closed_annotated_and_hide_the_generic_switch():
    load_all()
    for verb, expected_fields in PUBLIC_TOOLS.items():
        schema_cls, _handler = HANDLERS[verb]
        schema = schema_cls.model_json_schema()
        assert schema["additionalProperties"] is False
        assert set(schema["properties"]) == set(expected_fields)
        assert "switch" not in schema["properties"]
        assert VERB_ANNOTATIONS[verb].destructiveHint is False
        assert VERB_ANNOTATIONS[verb].idempotentHint is True
    assert VERB_ANNOTATIONS["ae.getLayerCompositingState"].readOnlyHint is True
    for verb in tuple(PUBLIC_TOOLS)[1:]:
        assert VERB_ANNOTATIONS[verb].readOnlyHint is False


def test_core_contracts_equal_frozen_native_protocol_contracts():
    protocol = json.loads(Path("native/ae-plugin/protocol/aegp-rpc.schema.json").read_text())["$defs"]
    definitions = {
        LC.LAYER_COMPOSITING_READ_CAPABILITY_ID: (
            "layerCompositingReadInputSchemaContract", "layerCompositingReadResultSchemaContract",
        ),
        LC.LAYER_SWITCH_SET_CAPABILITY_ID: (
            "layerSwitchSetInputSchemaContract", "layerSwitchSetResultSchemaContract",
        ),
        LC.LAYER_QUALITY_SET_CAPABILITY_ID: (
            "layerQualitySetInputSchemaContract", "layerQualitySetResultSchemaContract",
        ),
        LC.LAYER_BLENDING_MODE_SET_CAPABILITY_ID: (
            "layerBlendingModeSetInputSchemaContract", "layerBlendingModeSetResultSchemaContract",
        ),
    }
    assert len(LC.CAPABILITY_CONTRACTS) == 4
    for capability_id, (input_name, result_name) in definitions.items():
        contract = LC.CAPABILITY_CONTRACTS[capability_id]
        assert contract.input_schema == protocol[input_name]["const"]
        assert contract.result_schema == protocol[result_name]["const"]
        assert contract.contract_digest == N._sha256_closed_json({
            "inputSchema": contract.input_schema,
            "resultSchema": contract.result_schema,
        })


@pytest.mark.asyncio
async def test_four_native_capabilities_bind_readback_audit_and_undo():
    backend = PackageBackend()
    locator = _locator()
    read = await LC.invoke_layer_compositing_read(
        backend, request_id="compositing-read-1", layer_locator=locator,
        deadline_unix_ms=_deadline(),
    )
    switched = await LC.invoke_layer_switch_set(
        backend, request_id="switch-set-1", layer_locator=locator, switch="solo", enabled=True,
        idempotency_key="switch-intent-0001", deadline_unix_ms=_deadline(),
    )
    quality = await LC.invoke_layer_quality_set(
        backend, request_id="quality-set-1", layer_locator=locator, quality="draft",
        idempotency_key="quality-intent-0001", deadline_unix_ms=_deadline(),
    )
    blend = await LC.invoke_layer_blending_mode_set(
        backend, request_id="blend-set-1", layer_locator=locator, mode="multiply",
        idempotency_key="blend-intent-0001", deadline_unix_ms=_deadline(),
    )
    assert read.value.visibility_enabled is True
    assert switched.value.switch == "solo" and switched.value.after_enabled is True
    assert quality.value.after_quality == "draft"
    assert blend.value.after_mode == "multiply"
    assert blend.value.preserve_alpha is False and blend.value.track_matte == "none"
    assert read.evidence.effect == "none"
    for execution in (switched, quality, blend):
        assert execution.evidence.effect == "committed"
        assert execution.evidence.undo is not None
        assert execution.evidence.undo.available is True
        assert execution.evidence.undo.verified is False


@pytest.mark.asyncio
async def test_public_handlers_bind_fixed_switch_names_and_closed_wire(monkeypatch):
    backend = PackageBackend()
    monkeypatch.setattr(native_handlers._discovery, "select_backend", lambda: backend)
    locator = _locator()
    read = await native_handlers._run_get_layer_compositing_state(
        schemas.AeGetLayerCompositingStateArgs(layer_locator=locator), None,
    )
    assert read["ok"] is True
    assert backend.requests[-1].arguments == {"layerLocator": locator}

    for index, (handler, switch) in enumerate(SWITCH_HANDLERS.items(), start=1):
        schema_cls = HANDLERS[{value: key for key, value in {
            "ae.setLayerVisibility": "visibility", "ae.setLayerSolo": "solo",
            "ae.setLayerLocked": "locked", "ae.setLayerShy": "shy",
            "ae.setLayerMotionBlur": "motion-blur", "ae.setLayerThreeD": "three-d",
            "ae.setLayerAdjustment": "adjustment",
        }.items()}[switch]][0]
        result = await handler(schema_cls(
            layer_locator=locator, enabled=True,
            idempotency_key=f"switch-handler-intent-{index:04d}",
        ), None)
        assert result["ok"] is True
        assert backend.requests[-1].arguments["switch"] == switch

    quality = await native_handlers._run_set_layer_quality(
        schemas.AeSetLayerQualityArgs(
            layer_locator=locator, quality="draft", idempotency_key="quality-handler-intent-0001",
        ), None,
    )
    blend = await native_handlers._run_set_layer_blending_mode(
        schemas.AeSetLayerBlendingModeArgs(
            layer_locator=locator, mode="multiply", idempotency_key="blend-handler-intent-0001",
        ), None,
    )
    assert quality["implementation"]["capabilityId"] == LC.LAYER_QUALITY_SET_CAPABILITY_ID
    assert blend["implementation"]["capabilityId"] == LC.LAYER_BLENDING_MODE_SET_CAPABILITY_ID


@pytest.mark.asyncio
async def test_stale_locator_fails_before_dispatch():
    backend = PackageBackend()
    with pytest.raises(N.NativeBackendError) as raised:
        await LC.invoke_layer_switch_set(
            backend,
            request_id="stale-switch-1",
            layer_locator=_locator(session_id="cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
            switch="solo",
            enabled=True,
            idempotency_key="stale-switch-intent-0001",
            deadline_unix_ms=_deadline(),
        )
    assert raised.value.code == "STALE_LOCATOR"
    assert backend.requests == []


@pytest.mark.asyncio
async def test_tampered_write_postcondition_preserves_side_effect_uncertainty():
    backend = PackageBackend()
    backend.tamper_postcondition = LC.LAYER_BLENDING_MODE_SET_CAPABILITY_ID
    with pytest.raises(N.NativeBackendError) as raised:
        await LC.invoke_layer_blending_mode_set(
            backend,
            request_id="tampered-blend-1",
            layer_locator=_locator(),
            mode="multiply",
            idempotency_key="tampered-blend-intent-0001",
            deadline_unix_ms=_deadline(),
        )
    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"
    assert raised.value.retryable is False
