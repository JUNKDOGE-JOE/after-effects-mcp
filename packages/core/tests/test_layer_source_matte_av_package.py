"""Public argument and metadata boundary for the #190 layer capability package."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from ae_mcp.backends import native as N
from ae_mcp.backends import native_layer_source_matte_av as SMA


HOST = "22222222-2222-4222-8222-222222222222"
SESSION = "11111111-1111-4111-8111-111111111111"
PROJECT = "44444444-4444-4444-8444-444444444444"
GENERATION = 3
LAYER = "77777777-7777-4777-8777-777777777777"
MATTE_LAYER = "88888888-8888-4888-8888-888888888888"
ITEM = "99999999-9999-4999-8999-999999999999"


def _layer(
    *,
    object_id: str = LAYER,
    host_instance_id: str = HOST,
    session_id: str = SESSION,
    project_id: str = PROJECT,
    generation: int = GENERATION,
) -> dict[str, Any]:
    return {
        "kind": "layer",
        "hostInstanceId": host_instance_id,
        "sessionId": session_id,
        "projectId": project_id,
        "generation": generation,
        "objectId": object_id,
    }


def _item(
    *,
    kind: str = "item",
    host_instance_id: str = HOST,
    session_id: str = SESSION,
    project_id: str = PROJECT,
    generation: int = GENERATION,
) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": host_instance_id,
        "sessionId": session_id,
        "projectId": project_id,
        "generation": generation,
        "objectId": ITEM,
    }


def _native_descriptor(contract: SMA.CapabilityContract) -> N.NativeCapabilityDescriptor:
    return N.NativeCapabilityDescriptor(
        detail="full",
        id=contract.capability_id,
        version=SMA.CAPABILITY_VERSION,
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
            status="verified", intended_platforms=("macos-arm64",),
            minimum_host_major=25, maximum_host_major=26,
        ),
        input_contract_id=contract.input_contract_id,
        result_contract_id=contract.result_contract_id,
        contract_digest=contract.contract_digest,
        input_schema=contract.input_schema,
        result_schema=contract.result_schema,
        requirements=(N.NativeRequirement(id=contract.requirement_id, contract_version=1),),
        examples=({"arguments": {}},),
    )


def _source_value(layer: dict[str, Any]) -> dict[str, Any]:
    return {
        "layerLocator": layer,
        "sourceItemLocator": _item(),
        "sourceType": "footage",
        "sourceName": "Fixture footage",
    }


def _matte_state(layer: dict[str, Any], *, active: bool = True) -> dict[str, Any]:
    return {
        "layerLocator": layer,
        "active": active,
        "matteLayerLocator": _layer(object_id=MATTE_LAYER) if active else None,
        "mode": "luma",
    }


def _av_state(layer: dict[str, Any], *, audio_enabled: bool = True, video_enabled: bool = True) -> dict[str, Any]:
    return {
        "layerLocator": layer,
        "hasAudio": True,
        "audioEnabled": audio_enabled,
        "hasVideo": True,
        "videoEnabled": video_enabled,
    }


VALUE_MODELS = {
    SMA.LAYER_SOURCE_READ_CAPABILITY_ID: SMA.LayerSourceValue,
    SMA.LAYER_TRACK_MATTE_READ_CAPABILITY_ID: SMA.LayerTrackMatteValue,
    SMA.LAYER_TRACK_MATTE_SET_CAPABILITY_ID: SMA.LayerTrackMatteSetValue,
    SMA.LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID: SMA.LayerTrackMatteClearValue,
    SMA.LAYER_AV_STATE_READ_CAPABILITY_ID: SMA.LayerAVStateValue,
    SMA.LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID: SMA.LayerAudioEnabledSetValue,
    SMA.LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID: SMA.LayerVideoEnabledSetValue,
}


class PackageBackend(N.NativeInvokeBackend):
    name = "layer-source-matte-av-package-fixture"

    def __init__(self) -> None:
        self.items = tuple(_native_descriptor(contract) for contract in SMA.CAPABILITY_CONTRACTS.values())
        self.requests: list[N.NativeInvokeRequest] = []
        self.cancellations: list[N.NativeCancellationToken | None] = []
        self.capability_queries: list[tuple[tuple[str, ...], str, int]] = []
        self.tamper_postcondition: str | None = None
        self.tamper_result_capability: str | None = None
        self.tamper_evidence_session: str | None = None
        self.raw_values: dict[str, dict[str, Any]] = {}
        self.negotiation = N.NativeNegotiation(
            selected_wire_version=1, plugin_version="0.9.2", compiled_sdk_version="25.6.61",
            source_commit="a" * 40, host_instance_id=HOST, host_platform="macos-arm64",
            session_id=SESSION, session_generation=GENERATION,
            capabilities_digest=N._capabilities_registry_digest(self.items),
        )

    async def negotiate(self, **_kwargs):
        return self.negotiation

    async def capabilities(self, *, ids, detail, limit, **_kwargs):
        assert ids is not None and len(ids) == 1
        assert detail == "full" and limit == 1
        self.capability_queries.append((ids, detail, limit))
        items = tuple(item for item in self.items if item.capability_id in ids)
        return N.NativeCapabilities(
            session_id=SESSION, detail="full", items=items, next_cursor=None,
            query_digest=N._capabilities_query_digest(
                session_id=SESSION, ids=ids, detail="full", limit=1,
            ),
            capabilities_digest=self.negotiation.capabilities_digest,
        )

    def _value(self, request: N.NativeInvokeRequest) -> dict[str, Any]:
        layer = request.arguments["layerLocator"]
        capability = request.capability_id
        if capability == SMA.LAYER_SOURCE_READ_CAPABILITY_ID:
            return _source_value(layer)
        if capability == SMA.LAYER_TRACK_MATTE_READ_CAPABILITY_ID:
            return _matte_state(layer)
        if capability == SMA.LAYER_TRACK_MATTE_SET_CAPABILITY_ID:
            return {
                "changed": True, "layerLocator": layer,
                "beforeMatteLayerLocator": None, "beforeMode": "none",
                "afterMatteLayerLocator": request.arguments["matteLayerLocator"],
                "afterMode": request.arguments["mode"],
            }
        if capability == SMA.LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID:
            return {
                "changed": True, "layerLocator": layer,
                "beforeMatteLayerLocator": _layer(object_id=MATTE_LAYER), "beforeMode": "luma",
                "afterMatteLayerLocator": None, "afterMode": "luma",
            }
        if capability == SMA.LAYER_AV_STATE_READ_CAPABILITY_ID:
            return _av_state(layer)
        if capability == SMA.LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID:
            return {
                "changed": True, "layerLocator": layer,
                "before": _av_state(layer, audio_enabled=False),
                "after": _av_state(layer, audio_enabled=request.arguments["enabled"]),
            }
        if capability == SMA.LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID:
            return {
                "changed": True, "layerLocator": layer,
                "before": _av_state(layer, video_enabled=False),
                "after": _av_state(layer, video_enabled=request.arguments["enabled"]),
            }
        raise AssertionError(capability)

    async def invoke(self, request, *, cancellation=None):
        self.requests.append(request)
        self.cancellations.append(cancellation)
        raw_value = self.raw_values.get(request.capability_id)
        if raw_value is None:
            raw_value = self._value(request)
        contract = SMA.CAPABILITY_CONTRACTS[request.capability_id]
        try:
            value = VALUE_MODELS[request.capability_id].model_validate(raw_value)
            digest = SMA._value_digest(request.capability_id, value)
        except ValidationError:
            digest = "f" * 64
        if self.tamper_postcondition == request.capability_id:
            digest = "f" * 64
        is_write = contract.risk == "write"
        result_capability = self.tamper_result_capability or request.capability_id
        return N.NativeInvokeResult(
            capability_id=result_capability,
            capability_version=request.capability_version,
            engine="native-aegp", outcome="succeeded", replayed=False, value=raw_value,
            evidence=N.NativeExecutionEvidence(
                engine="native-aegp", host_instance_id=HOST,
                session_id=self.tamper_evidence_session or SESSION,
                request_id=request.request_id, capability_id=result_capability,
                capability_version=request.capability_version,
                started_at_unix_ms=request.deadline_unix_ms - 100,
                completed_at_unix_ms=request.deadline_unix_ms - 1,
                effect="committed" if is_write else "none",
                request_digest=N._invoke_request_digest(request, self.negotiation),
                postcondition=N.NativePostconditionEvidence(
                    verified=True, kind=contract.postcondition_kind,
                    algorithm="sha256-rfc8785-jcs-v1", digest=digest,
                ),
                undo=N.NativeUndoEvidence(available=True, verified=False) if is_write else None,
            ),
        )


def _deadline() -> int:
    return int(time.time() * 1000) + 5_000


def test_seven_native_contracts_are_closed_and_exclude_maintained_jsx_source_set():
    expected_ids = {
        "ae.layer.source.read", "ae.layer.track-matte.read", "ae.layer.track-matte.set",
        "ae.layer.track-matte.clear", "ae.layer.av-state.read",
        "ae.layer.audio-enabled.set", "ae.layer.video-enabled.set",
    }
    assert set(SMA.CAPABILITY_CONTRACTS) == expected_ids
    for capability_id, contract in SMA.CAPABILITY_CONTRACTS.items():
        assert contract.input_schema["additionalProperties"] is False
        assert contract.result_schema["additionalProperties"] is False
        assert contract.contract_digest == N._sha256_closed_json({
            "inputSchema": contract.input_schema, "resultSchema": contract.result_schema,
        })
        descriptor = _native_descriptor(contract)
        SMA._descriptor_validator(contract)(descriptor, host_platform="macos-arm64")
        if contract.risk == "write":
            assert contract.idempotency == "idempotency-key"
            assert descriptor.undo == "ae-undo-group"
        else:
            assert contract.idempotency == "idempotent"


def test_core_contract_schemas_match_the_protocol_registry_source():
    schema_path = (
        Path(__file__).resolve().parents[3]
        / "native"
        / "ae-plugin"
        / "protocol"
        / "aegp-rpc.schema.json"
    )
    protocol_defs = json.loads(schema_path.read_text(encoding="utf-8"))["$defs"]
    schema_names = {
        SMA.LAYER_SOURCE_READ_CAPABILITY_ID: "layerSourceRead",
        SMA.LAYER_TRACK_MATTE_READ_CAPABILITY_ID: "layerTrackMatteRead",
        SMA.LAYER_TRACK_MATTE_SET_CAPABILITY_ID: "layerTrackMatteSet",
        SMA.LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID: "layerTrackMatteClear",
        SMA.LAYER_AV_STATE_READ_CAPABILITY_ID: "layerAvStateRead",
        SMA.LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID: "layerAudioEnabledSet",
        SMA.LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID: "layerVideoEnabledSet",
    }
    for capability_id, schema_name in schema_names.items():
        contract = SMA.CAPABILITY_CONTRACTS[capability_id]
        assert contract.input_schema == protocol_defs[
            f"{schema_name}InputSchemaContract"
        ]["const"]
        assert contract.result_schema == protocol_defs[
            f"{schema_name}ResultSchemaContract"
        ]["const"]


EXPECTED_SCHEMA_KEYS = {
    SMA.LAYER_SOURCE_READ_CAPABILITY_ID: (
        {"layerLocator"},
        {"layerLocator", "sourceItemLocator", "sourceType", "sourceName"},
    ),
    SMA.LAYER_TRACK_MATTE_READ_CAPABILITY_ID: (
        {"layerLocator"},
        {"layerLocator", "active", "matteLayerLocator", "mode"},
    ),
    SMA.LAYER_TRACK_MATTE_SET_CAPABILITY_ID: (
        {"layerLocator", "matteLayerLocator", "mode", "idempotencyKey"},
        {
            "changed", "layerLocator", "beforeMatteLayerLocator", "beforeMode",
            "afterMatteLayerLocator", "afterMode",
        },
    ),
    SMA.LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID: (
        {"layerLocator", "idempotencyKey"},
        {
            "changed", "layerLocator", "beforeMatteLayerLocator", "beforeMode",
            "afterMatteLayerLocator", "afterMode",
        },
    ),
    SMA.LAYER_AV_STATE_READ_CAPABILITY_ID: (
        {"layerLocator"},
        {"layerLocator", "hasAudio", "audioEnabled", "hasVideo", "videoEnabled"},
    ),
    SMA.LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID: (
        {"layerLocator", "enabled", "idempotencyKey"},
        {"changed", "layerLocator", "before", "after"},
    ),
    SMA.LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID: (
        {"layerLocator", "enabled", "idempotencyKey"},
        {"changed", "layerLocator", "before", "after"},
    ),
}
_EXPECTED_AV_STATE_KEYS = {"layerLocator", "hasAudio", "audioEnabled", "hasVideo", "videoEnabled"}


def test_contract_schemas_have_hand_derived_exact_input_and_result_keys():
    for capability_id, (input_keys, result_keys) in EXPECTED_SCHEMA_KEYS.items():
        contract = SMA.CAPABILITY_CONTRACTS[capability_id]
        assert set(contract.input_schema["required"]) == input_keys
        assert set(contract.input_schema["properties"]) == input_keys
        assert set(contract.result_schema["required"]) == result_keys
        assert set(contract.result_schema["properties"]) == result_keys
        if capability_id in {
            SMA.LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID,
            SMA.LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID,
        }:
            for state_key in ("before", "after"):
                assert contract.result_schema["properties"][state_key] == {
                    "$ref": "#/$defs/avState"
                }
            state_schema = contract.result_schema["$defs"]["avState"]
            assert set(state_schema["required"]) == _EXPECTED_AV_STATE_KEYS
            assert set(state_schema["properties"]) == _EXPECTED_AV_STATE_KEYS


def test_result_models_serialize_to_the_hand_derived_result_keys():
    layer = _layer()
    raw_values = {
        SMA.LAYER_SOURCE_READ_CAPABILITY_ID: _source_value(layer),
        SMA.LAYER_TRACK_MATTE_READ_CAPABILITY_ID: _matte_state(layer),
        SMA.LAYER_TRACK_MATTE_SET_CAPABILITY_ID: {
            "changed": True, "layerLocator": layer,
            "beforeMatteLayerLocator": None, "beforeMode": "none",
            "afterMatteLayerLocator": _layer(object_id=MATTE_LAYER), "afterMode": "alpha",
        },
        SMA.LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID: {
            "changed": True, "layerLocator": layer,
            "beforeMatteLayerLocator": _layer(object_id=MATTE_LAYER), "beforeMode": "luma",
            "afterMatteLayerLocator": None, "afterMode": "luma",
        },
        SMA.LAYER_AV_STATE_READ_CAPABILITY_ID: _av_state(layer),
        SMA.LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID: {
            "changed": True, "layerLocator": layer,
            "before": _av_state(layer, audio_enabled=False), "after": _av_state(layer),
        },
        SMA.LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID: {
            "changed": True, "layerLocator": layer,
            "before": _av_state(layer, video_enabled=False), "after": _av_state(layer),
        },
    }
    for capability_id, raw_value in raw_values.items():
        value = VALUE_MODELS[capability_id].model_validate(raw_value)
        assert set(value.model_dump(mode="json", by_alias=True)) == EXPECTED_SCHEMA_KEYS[capability_id][1]


def test_track_matte_set_value_rejects_an_active_before_target_with_none_mode():
    with pytest.raises(ValidationError, match="active Track Matte requires"):
        SMA.LayerTrackMatteSetValue.model_validate({
            "changed": True,
            "layerLocator": _layer(),
            "beforeMatteLayerLocator": _layer(object_id=MATTE_LAYER),
            "beforeMode": "none",
            "afterMatteLayerLocator": _layer(object_id=MATTE_LAYER),
            "afterMode": "alpha",
        })


@pytest.mark.asyncio
async def test_native_source_matte_and_av_contracts_bind_values_postconditions_and_undo():
    backend = PackageBackend()
    layer = _layer()
    source = await SMA.invoke_layer_source_read(
        backend, request_id="source-read-1", layer_locator=layer, deadline_unix_ms=_deadline(),
    )
    matte = await SMA.invoke_layer_track_matte_read(
        backend, request_id="matte-read-1", layer_locator=layer, deadline_unix_ms=_deadline(),
    )
    set_matte = await SMA.invoke_layer_track_matte_set(
        backend, request_id="matte-set-1", layer_locator=layer,
        matte_layer_locator=_layer(object_id=MATTE_LAYER), mode="alpha",
        idempotency_key="matte-set-intent-0001", deadline_unix_ms=_deadline(),
    )
    clear_matte = await SMA.invoke_layer_track_matte_clear(
        backend, request_id="matte-clear-1", layer_locator=layer,
        idempotency_key="matte-clear-intent-0001", deadline_unix_ms=_deadline(),
    )
    av = await SMA.invoke_layer_av_state_read(
        backend, request_id="av-read-1", layer_locator=layer, deadline_unix_ms=_deadline(),
    )
    audio = await SMA.invoke_layer_audio_enabled_set(
        backend, request_id="audio-set-1", layer_locator=layer, enabled=True,
        idempotency_key="audio-set-intent-0001", deadline_unix_ms=_deadline(),
    )
    video = await SMA.invoke_layer_video_enabled_set(
        backend, request_id="video-set-1", layer_locator=layer, enabled=True,
        idempotency_key="video-set-intent-0001", deadline_unix_ms=_deadline(),
    )
    assert source.value.source_item_locator is not None and source.value.source_type == "footage"
    assert matte.value.active is True and matte.value.mode == "luma"
    assert set_matte.value.after_matte_layer_locator.object_id == MATTE_LAYER
    assert set_matte.value.after_mode == "alpha"
    assert clear_matte.value.after_matte_layer_locator is None
    assert clear_matte.value.before_mode == clear_matte.value.after_mode == "luma"
    assert av.value.has_audio is True and av.value.video_enabled is True
    assert audio.value.before.video_enabled == audio.value.after.video_enabled
    assert video.value.before.audio_enabled == video.value.after.audio_enabled
    for execution in (set_matte, clear_matte, audio, video):
        assert execution.evidence.effect == "committed"
        assert execution.evidence.undo is not None
        assert execution.evidence.undo.available is True
        assert execution.evidence.undo.verified is False
    assert [query[0][0] for query in backend.capability_queries] == [
        SMA.LAYER_SOURCE_READ_CAPABILITY_ID,
        SMA.LAYER_TRACK_MATTE_READ_CAPABILITY_ID,
        SMA.LAYER_TRACK_MATTE_SET_CAPABILITY_ID,
        SMA.LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID,
        SMA.LAYER_AV_STATE_READ_CAPABILITY_ID,
        SMA.LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID,
        SMA.LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID,
    ]


@pytest.mark.asyncio
async def test_tampered_native_write_evidence_remains_possibly_side_effecting():
    backend = PackageBackend()
    backend.tamper_postcondition = SMA.LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID
    with pytest.raises(N.NativeBackendError) as raised:
        await SMA.invoke_layer_audio_enabled_set(
            backend, request_id="tampered-audio-1", layer_locator=_layer(), enabled=True,
            idempotency_key="tampered-audio-intent-0001", deadline_unix_ms=_deadline(),
        )
    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"


@pytest.mark.asyncio
async def test_malformed_native_track_matte_write_value_remains_possibly_side_effecting():
    backend = PackageBackend()
    backend.raw_values[SMA.LAYER_TRACK_MATTE_SET_CAPABILITY_ID] = {
        "changed": True,
        "layerLocator": _layer(),
        "beforeMatteLayerLocator": _layer(object_id=MATTE_LAYER),
        "beforeMode": "none",
        "afterMatteLayerLocator": _layer(object_id=MATTE_LAYER),
        "afterMode": "alpha",
    }
    with pytest.raises(N.NativeBackendError) as raised:
        await SMA.invoke_layer_track_matte_set(
            backend, request_id="malformed-matte-set-1", layer_locator=_layer(),
            matte_layer_locator=_layer(object_id=MATTE_LAYER), mode="alpha",
            idempotency_key="malformed-matte-intent-0001", deadline_unix_ms=_deadline(),
        )
    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"


@pytest.mark.asyncio
async def test_preserved_av_field_mutation_remains_possibly_side_effecting():
    backend = PackageBackend()
    backend.raw_values[SMA.LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID] = {
        "changed": True,
        "layerLocator": _layer(),
        "before": _av_state(_layer(), audio_enabled=False, video_enabled=True),
        "after": _av_state(_layer(), audio_enabled=True, video_enabled=False),
    }
    with pytest.raises(N.NativeBackendError) as raised:
        await SMA.invoke_layer_audio_enabled_set(
            backend, request_id="mutated-av-set-1", layer_locator=_layer(), enabled=True,
            idempotency_key="mutated-av-intent-0001", deadline_unix_ms=_deadline(),
        )
    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"


@pytest.mark.asyncio
async def test_valid_but_request_mismatched_av_projection_remains_possibly_side_effecting():
    backend = PackageBackend()
    backend.raw_values[SMA.LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID] = {
        "changed": True,
        "layerLocator": _layer(),
        "before": _av_state(_layer(), video_enabled=True),
        "after": _av_state(_layer(), video_enabled=False),
    }
    with pytest.raises(N.NativeBackendError) as raised:
        await SMA.invoke_layer_video_enabled_set(
            backend, request_id="mismatched-video-set-1", layer_locator=_layer(), enabled=True,
            idempotency_key="mismatched-video-intent-0001", deadline_unix_ms=_deadline(),
        )
    assert len(backend.requests) == 1
    assert raised.value.code == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert raised.value.side_effect == "may-have-occurred"


@pytest.mark.parametrize(
    "code",
    [
        "TRACK_MATTE_COMPOSITION_MISMATCH",
        "LAYER_HAS_NO_AUDIO",
        "LAYER_HAS_NO_VIDEO",
    ],
)
def test_core_preserves_layer_source_matte_av_domain_errors(code: str):
    error = N.NativeBackendError.from_payload({
        "code": code,
        "message": "synthetic pre-dispatch rejection",
        "retryable": False,
        "sideEffect": "not-started",
        "recovery": {
            "action": "change-arguments",
            "hint": "Choose arguments compatible with the selected layer.",
        },
    })
    assert error.code == code
    assert error.side_effect == "not-started"
    assert error.recovery.action == "change-arguments"


@pytest.mark.asyncio
@pytest.mark.parametrize("tamper", ["capability", "session"])
async def test_native_read_rejects_wrong_capability_or_stale_session_after_dispatch(tamper: str):
    """A successful-looking response from another capability or session is not trusted."""
    backend = PackageBackend()
    if tamper == "capability":
        backend.tamper_result_capability = SMA.LAYER_AV_STATE_READ_CAPABILITY_ID
    else:
        backend.tamper_evidence_session = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    with pytest.raises(N.NativeBackendError) as raised:
        await SMA.invoke_layer_source_read(
            backend, request_id=f"wrong-{tamper}-1", layer_locator=_layer(),
            deadline_unix_ms=_deadline(),
        )
    assert raised.value.code == "NATIVE_CONTRACT_MISMATCH"
    assert len(backend.requests) == 1


@pytest.mark.asyncio
async def test_stale_source_locator_fails_before_dispatch():
    """A stale locator is rejected before a native read can start."""
    backend = PackageBackend()
    with pytest.raises(N.NativeBackendError) as raised:
        await SMA.invoke_layer_source_read(
            backend, request_id="stale-source-1",
            layer_locator=_layer(session_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            deadline_unix_ms=_deadline(),
        )
    assert raised.value.code == "STALE_LOCATOR"
    assert raised.value.side_effect == "not-started"
    assert backend.requests == []
