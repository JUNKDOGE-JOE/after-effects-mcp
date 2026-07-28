"""Strict Core contracts for native layer source, Track Matte, and AV state.

The public source setter is deliberately absent: it is a maintained JSX path.
These seven contracts describe only the AEGP-backed reads and writes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Literal, Mapping, TypeVar

from pydantic import Field, StrictBool, StrictStr, ValidationError, model_validator

from ae_mcp.backends.native import (
    NativeCancellationToken,
    NativeInvokeBackend,
    NativeLocator,
    _NativeModel,
    _invoke_native_read_request,
    _structured_error,
)
from ae_mcp.backends.native_layer_timeline import (
    _invoke_layer_write,
    _possibly_side_effecting,
    _write_execution,
)
from ae_mcp.backends.native_project_composition import (
    CAPABILITY_VERSION,
    CapabilityContract,
    IdempotencyKey,
    _IDEMPOTENCY_SCHEMA,
    _ReadExecution,
    _WriteExecution,
    _bounded_unicode,
    _descriptor_validator,
    _locator_schema,
    _value_digest,
)


TrackMatteMode = Literal["none", "alpha", "inverted-alpha", "luma", "inverted-luma"]
SettableTrackMatteMode = Literal["alpha", "inverted-alpha", "luma", "inverted-luma"]
SourceType = Literal["none", "footage", "composition"]

_TRACK_MATTE_MODES = ("none", "alpha", "inverted-alpha", "luma", "inverted-luma")
_SETTABLE_TRACK_MATTE_MODES = ("alpha", "inverted-alpha", "luma", "inverted-luma")
_SOURCE_TYPES = ("none", "footage", "composition")


def _require_layer(locator: NativeLocator) -> None:
    if locator.kind != "layer":
        raise ValueError("layerLocator must identify a layer")


class _LayerReadArguments(_NativeModel):
    layer_locator: NativeLocator

    @model_validator(mode="after")
    def _layer_kind(self) -> "_LayerReadArguments":
        _require_layer(self.layer_locator)
        return self


class _LayerWriteArguments(_LayerReadArguments):
    idempotency_key: IdempotencyKey


class LayerSourceValue(_NativeModel):
    layer_locator: NativeLocator
    source_item_locator: NativeLocator | None
    source_type: SourceType
    source_name: Annotated[StrictStr, Field(max_length=1024)] | None

    @model_validator(mode="after")
    def _coherent_source(self) -> "LayerSourceValue":
        _require_layer(self.layer_locator)
        source = self.source_item_locator
        if self.source_type == "none":
            if source is not None or self.source_name is not None:
                raise ValueError("sourceType none requires null source facts")
            return self
        expected_kind = "composition" if self.source_type == "composition" else "item"
        if source is None or source.kind != expected_kind or source.context() != self.layer_locator.context():
            raise ValueError("source facts are not bound to the layer context and type")
        if self.source_name is None:
            raise ValueError("non-empty source type requires sourceName")
        _bounded_unicode(self.source_name, field="sourceName", allow_empty=True)
        return self


class LayerTrackMatteValue(_NativeModel):
    layer_locator: NativeLocator
    active: StrictBool
    matte_layer_locator: NativeLocator | None
    mode: TrackMatteMode

    @model_validator(mode="after")
    def _coherent_matte(self) -> "LayerTrackMatteValue":
        _require_layer(self.layer_locator)
        matte = self.matte_layer_locator
        if self.active is not (matte is not None):
            raise ValueError("active must equal whether matteLayerLocator is present")
        if matte is not None and (
            matte.kind != "layer"
            or matte.context() != self.layer_locator.context()
            or matte.object_id == self.layer_locator.object_id
        ):
            raise ValueError("matteLayerLocator is not a distinct layer in the same context")
        if self.active and self.mode == "none":
            raise ValueError("an active Track Matte requires a stored non-none mode")
        return self


class LayerTrackMatteSetArguments(_LayerWriteArguments):
    matte_layer_locator: NativeLocator
    mode: SettableTrackMatteMode

    @model_validator(mode="after")
    def _matte_target(self) -> "LayerTrackMatteSetArguments":
        matte = self.matte_layer_locator
        if (
            matte.kind != "layer"
            or matte.context() != self.layer_locator.context()
            or matte.object_id == self.layer_locator.object_id
        ):
            raise ValueError("matteLayerLocator must be a distinct same-context layer")
        return self


class LayerTrackMatteSetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_matte_layer_locator: NativeLocator | None
    before_mode: TrackMatteMode
    after_matte_layer_locator: NativeLocator
    after_mode: SettableTrackMatteMode

    @model_validator(mode="after")
    def _transition(self) -> "LayerTrackMatteSetValue":
        _require_layer(self.layer_locator)
        before = self.before_matte_layer_locator
        after = self.after_matte_layer_locator
        for locator in (before, after):
            if locator is not None and (
                locator.kind != "layer"
                or locator.context() != self.layer_locator.context()
                or locator.object_id == self.layer_locator.object_id
            ):
                raise ValueError("Track Matte locators must be distinct same-context layers")
        if before == after and self.before_mode == self.after_mode:
            raise ValueError("Track Matte did not change")
        return self


class LayerTrackMatteClearValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_matte_layer_locator: NativeLocator
    before_mode: SettableTrackMatteMode
    after_matte_layer_locator: Literal[None]
    after_mode: TrackMatteMode

    @model_validator(mode="after")
    def _transition(self) -> "LayerTrackMatteClearValue":
        _require_layer(self.layer_locator)
        before = self.before_matte_layer_locator
        if (
            before.kind != "layer"
            or before.context() != self.layer_locator.context()
            or before.object_id == self.layer_locator.object_id
        ):
            raise ValueError("beforeMatteLayerLocator is not a distinct same-context layer")
        if self.after_mode != self.before_mode:
            raise ValueError("clearing a Track Matte must preserve its stored mode")
        return self


class LayerAVStateValue(_NativeModel):
    layer_locator: NativeLocator
    has_audio: StrictBool
    audio_enabled: StrictBool
    has_video: StrictBool
    video_enabled: StrictBool

    @model_validator(mode="after")
    def _layer_kind(self) -> "LayerAVStateValue":
        _require_layer(self.layer_locator)
        return self


class LayerAudioEnabledSetArguments(_LayerWriteArguments):
    enabled: StrictBool


class LayerVideoEnabledSetArguments(_LayerWriteArguments):
    enabled: StrictBool


class _LayerAVSwitchSetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before: LayerAVStateValue
    after: LayerAVStateValue

    @model_validator(mode="after")
    def _bound_states(self) -> "_LayerAVSwitchSetValue":
        _require_layer(self.layer_locator)
        if self.before.layer_locator != self.layer_locator or self.after.layer_locator != self.layer_locator:
            raise ValueError("AV before and after state must bind the requested layer")
        return self


class LayerAudioEnabledSetValue(_LayerAVSwitchSetValue):
    @model_validator(mode="after")
    def _audio_transition(self) -> "LayerAudioEnabledSetValue":
        if self.before.audio_enabled == self.after.audio_enabled:
            raise ValueError("audioEnabled did not change")
        if (
            self.before.has_audio != self.after.has_audio
            or self.before.has_video != self.after.has_video
            or self.before.video_enabled != self.after.video_enabled
        ):
            raise ValueError("audio write changed preserved AV facts")
        return self


class LayerVideoEnabledSetValue(_LayerAVSwitchSetValue):
    @model_validator(mode="after")
    def _video_transition(self) -> "LayerVideoEnabledSetValue":
        if self.before.video_enabled == self.after.video_enabled:
            raise ValueError("videoEnabled did not change")
        if (
            self.before.has_audio != self.after.has_audio
            or self.before.audio_enabled != self.after.audio_enabled
            or self.before.has_video != self.after.has_video
        ):
            raise ValueError("video write changed preserved AV facts")
        return self


class LayerSourceReadExecution(_ReadExecution):
    value: LayerSourceValue


class LayerTrackMatteReadExecution(_ReadExecution):
    value: LayerTrackMatteValue


class LayerAVStateReadExecution(_ReadExecution):
    value: LayerAVStateValue


class LayerTrackMatteSetExecution(_WriteExecution):
    value: LayerTrackMatteSetValue


class LayerTrackMatteClearExecution(_WriteExecution):
    value: LayerTrackMatteClearValue


class LayerAudioEnabledSetExecution(_WriteExecution):
    value: LayerAudioEnabledSetValue


class LayerVideoEnabledSetExecution(_WriteExecution):
    value: LayerVideoEnabledSetValue


LAYER_SOURCE_READ_CAPABILITY_ID = "ae.layer.source.read"
LAYER_TRACK_MATTE_READ_CAPABILITY_ID = "ae.layer.track-matte.read"
LAYER_TRACK_MATTE_SET_CAPABILITY_ID = "ae.layer.track-matte.set"
LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID = "ae.layer.track-matte.clear"
LAYER_AV_STATE_READ_CAPABILITY_ID = "ae.layer.av-state.read"
LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID = "ae.layer.audio-enabled.set"
LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID = "ae.layer.video-enabled.set"


def _nullable_locator_schema(*kinds: str) -> dict[str, Any]:
    return {"anyOf": [_locator_schema(*kinds), {"type": "null"}]}


def _layer_read_schema() -> dict[str, Any]:
    return {
        "type": "object", "additionalProperties": False,
        "required": ["layerLocator"],
        "properties": {"layerLocator": _locator_schema("layer")},
    }


def _layer_write_schema(properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object", "additionalProperties": False,
        "required": ["layerLocator", *required, "idempotencyKey"],
        "properties": {
            "layerLocator": _locator_schema("layer"), **properties,
            "idempotencyKey": _IDEMPOTENCY_SCHEMA,
        },
    }


_SOURCE_READ_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["layerLocator", "sourceItemLocator", "sourceType", "sourceName"],
    "properties": {
        "layerLocator": _locator_schema("layer"),
        "sourceItemLocator": _nullable_locator_schema("item", "composition"),
        "sourceType": {"enum": list(_SOURCE_TYPES)},
        "sourceName": {"anyOf": [{"type": "string", "maxLength": 1024}, {"type": "null"}]},
    },
    "x-invariant": "sourceType-none-iff-sourceItemLocator-and-sourceName-are-null",
}
_TRACK_MATTE_READ_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["layerLocator", "active", "matteLayerLocator", "mode"],
    "properties": {
        "layerLocator": _locator_schema("layer"), "active": {"type": "boolean"},
        "matteLayerLocator": _nullable_locator_schema("layer"),
        "mode": {"enum": list(_TRACK_MATTE_MODES)},
    },
    "x-invariant": "active-equals-matteLayerLocator-present;active-requires-non-none-mode",
}
_TRACK_MATTE_SET_INPUT_SCHEMA = _layer_write_schema(
    {"matteLayerLocator": _locator_schema("layer"), "mode": {"enum": list(_SETTABLE_TRACK_MATTE_MODES)}},
    ["matteLayerLocator", "mode"],
)
_TRACK_MATTE_SET_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": [
        "changed", "layerLocator", "beforeMatteLayerLocator", "beforeMode",
        "afterMatteLayerLocator", "afterMode",
    ],
    "properties": {
        "changed": {"const": True}, "layerLocator": _locator_schema("layer"),
        "beforeMatteLayerLocator": _nullable_locator_schema("layer"),
        "beforeMode": {"enum": list(_TRACK_MATTE_MODES)},
        "afterMatteLayerLocator": _locator_schema("layer"),
        "afterMode": {"enum": list(_SETTABLE_TRACK_MATTE_MODES)},
    },
    "x-invariant": "after-matte-and-mode-equal-request;relationship-or-mode-changes",
}
_TRACK_MATTE_CLEAR_INPUT_SCHEMA = _layer_write_schema({}, [])
_TRACK_MATTE_CLEAR_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": [
        "changed", "layerLocator", "beforeMatteLayerLocator", "beforeMode",
        "afterMatteLayerLocator", "afterMode",
    ],
    "properties": {
        "changed": {"const": True}, "layerLocator": _locator_schema("layer"),
        "beforeMatteLayerLocator": _locator_schema("layer"),
        "beforeMode": {"enum": list(_SETTABLE_TRACK_MATTE_MODES)},
        "afterMatteLayerLocator": {"type": "null"},
        "afterMode": {"enum": list(_TRACK_MATTE_MODES)},
    },
    "x-invariant": "afterMatteLayerLocator-null;afterMode-equals-beforeMode",
}
_AV_STATE_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["layerLocator", "hasAudio", "audioEnabled", "hasVideo", "videoEnabled"],
    "properties": {
        "layerLocator": _locator_schema("layer"), "hasAudio": {"type": "boolean"},
        "audioEnabled": {"type": "boolean"}, "hasVideo": {"type": "boolean"},
        "videoEnabled": {"type": "boolean"},
    },
}
_AV_STATE_READ_RESULT_SCHEMA = _AV_STATE_SCHEMA


def _av_switch_result_schema(changed_field: str) -> dict[str, Any]:
    return {
        "type": "object", "additionalProperties": False,
        "required": ["changed", "layerLocator", "before", "after"],
        "properties": {
            "changed": {"const": True}, "layerLocator": _locator_schema("layer"),
            "before": _AV_STATE_SCHEMA, "after": _AV_STATE_SCHEMA,
        },
        "x-invariant": f"after-{changed_field}-equals-request;all-other-av-state-fields-preserved",
    }


@dataclass(frozen=True)
class _ContractSpec:
    capability_id: str
    summary: str
    risk: Literal["read", "write"]
    idempotency: Literal["idempotent", "idempotency-key"]
    side_effect_summary: str
    preconditions: tuple[str, ...]
    requirement_id: str
    input_schema: dict[str, Any]
    result_schema: dict[str, Any]
    postcondition_kind: str

    def contract(self) -> CapabilityContract:
        return CapabilityContract(**self.__dict__)


_CURRENT_LAYER = "layerLocator must identify a current native layer."
_SPECS = (
    _ContractSpec(
        LAYER_SOURCE_READ_CAPABILITY_ID, "Read one layer's current project-item source.",
        "read", "idempotent", "Reads layer source state without changing After Effects state.",
        (_CURRENT_LAYER,), "aemcp.requirement.native.layer-source-read",
        _layer_read_schema(), _SOURCE_READ_RESULT_SCHEMA, "layer-source-read",
    ),
    _ContractSpec(
        LAYER_TRACK_MATTE_READ_CAPABILITY_ID, "Read one layer's modern Track Matte relationship.",
        "read", "idempotent", "Reads Track Matte state without changing After Effects state.",
        (_CURRENT_LAYER,), "aemcp.requirement.native.layer-track-matte-read",
        _layer_read_schema(), _TRACK_MATTE_READ_RESULT_SCHEMA, "layer-track-matte-read",
    ),
    _ContractSpec(
        LAYER_TRACK_MATTE_SET_CAPABILITY_ID, "Set one arbitrary same-composition Track Matte.",
        "write", "idempotency-key", "Changes one Track Matte relationship and creates one After Effects Undo step.",
        (_CURRENT_LAYER, "matteLayerLocator must identify a distinct current layer in the same composition."),
        "aemcp.requirement.native.layer-track-matte-set",
        _TRACK_MATTE_SET_INPUT_SCHEMA, _TRACK_MATTE_SET_RESULT_SCHEMA, "layer-track-matte-set",
    ),
    _ContractSpec(
        LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID, "Clear one layer's Track Matte while preserving its stored mode.",
        "write", "idempotency-key", "Removes one Track Matte relationship and creates one After Effects Undo step.",
        (_CURRENT_LAYER, "The layer must have an active Track Matte relationship."),
        "aemcp.requirement.native.layer-track-matte-clear",
        _TRACK_MATTE_CLEAR_INPUT_SCHEMA, _TRACK_MATTE_CLEAR_RESULT_SCHEMA, "layer-track-matte-clear",
    ),
    _ContractSpec(
        LAYER_AV_STATE_READ_CAPABILITY_ID, "Read source media capabilities and layer AV switches.",
        "read", "idempotent", "Reads AV state without changing After Effects state.",
        (_CURRENT_LAYER,), "aemcp.requirement.native.layer-av-state-read",
        _layer_read_schema(), _AV_STATE_READ_RESULT_SCHEMA, "layer-av-state-read",
    ),
    _ContractSpec(
        LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID, "Set one layer's audio-enabled switch.",
        "write", "idempotency-key", "Changes one layer audio switch and creates one After Effects Undo step.",
        (_CURRENT_LAYER, "The current source must have audio and the requested value must differ."),
        "aemcp.requirement.native.layer-audio-enabled-set",
        _layer_write_schema({"enabled": {"type": "boolean"}}, ["enabled"]),
        _av_switch_result_schema("audioEnabled"), "layer-audio-enabled-set",
    ),
    _ContractSpec(
        LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID, "Set one layer's video-enabled switch.",
        "write", "idempotency-key", "Changes one layer video switch and creates one After Effects Undo step.",
        (_CURRENT_LAYER, "The current source must have video and the requested value must differ."),
        "aemcp.requirement.native.layer-video-enabled-set",
        _layer_write_schema({"enabled": {"type": "boolean"}}, ["enabled"]),
        _av_switch_result_schema("videoEnabled"), "layer-video-enabled-set",
    ),
)

CAPABILITY_CONTRACTS = {spec.capability_id: spec.contract() for spec in _SPECS}


async def _invoke_read(
    backend: NativeInvokeBackend, *, request_id: str, contract: CapabilityContract,
    arguments: _LayerReadArguments, value_model: type[_NativeModel],
    execution_model: type[_ReadExecution], deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
) -> _ReadExecution:
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend, request_id=request_id, capability_id=contract.capability_id,
        capability_version=CAPABILITY_VERSION,
        arguments=arguments.model_dump(mode="json", by_alias=True),
        locator=arguments.layer_locator, locator_field="params.arguments.layerLocator",
        stale_locator_hint="Call ae_listCompositionLayers and copy a fresh layer_locator.",
        descriptor_validator=_descriptor_validator(contract), deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = value_model.model_validate(result.value)
        digest = _value_digest(contract.capability_id, value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native layer state did not match the typed contract.") from exc
    if (
        value.layer_locator != arguments.layer_locator
        or result.evidence.postcondition.kind != contract.postcondition_kind
        or result.evidence.postcondition.digest != digest
    ):
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native layer state was not bound to the request and evidence.")
    return execution_model(implementation=descriptor, negotiation=negotiation, value=value, evidence=result.evidence)


async def invoke_layer_source_read(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerSourceReadExecution:
    arguments = _LayerReadArguments(layer_locator=layer_locator)
    return await _invoke_read(
        backend, request_id=request_id, contract=CAPABILITY_CONTRACTS[LAYER_SOURCE_READ_CAPABILITY_ID],
        arguments=arguments, value_model=LayerSourceValue, execution_model=LayerSourceReadExecution,
        deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )  # type: ignore[return-value]


async def invoke_layer_track_matte_read(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerTrackMatteReadExecution:
    arguments = _LayerReadArguments(layer_locator=layer_locator)
    return await _invoke_read(
        backend, request_id=request_id, contract=CAPABILITY_CONTRACTS[LAYER_TRACK_MATTE_READ_CAPABILITY_ID],
        arguments=arguments, value_model=LayerTrackMatteValue, execution_model=LayerTrackMatteReadExecution,
        deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )  # type: ignore[return-value]


async def invoke_layer_av_state_read(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerAVStateReadExecution:
    arguments = _LayerReadArguments(layer_locator=layer_locator)
    return await _invoke_read(
        backend, request_id=request_id, contract=CAPABILITY_CONTRACTS[LAYER_AV_STATE_READ_CAPABILITY_ID],
        arguments=arguments, value_model=LayerAVStateValue, execution_model=LayerAVStateReadExecution,
        deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )  # type: ignore[return-value]


ValueT = TypeVar("ValueT", bound=_NativeModel)


async def _invoke_write(
    backend: NativeInvokeBackend, *, request_id: str, contract: CapabilityContract,
    arguments: _LayerWriteArguments, value_model: type[ValueT], deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
) -> tuple[Any, Any, str, Any, ValueT]:
    return await _invoke_layer_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=value_model, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )


async def invoke_layer_track_matte_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], matte_layer_locator: NativeLocator | Mapping[str, Any],
    mode: SettableTrackMatteMode, idempotency_key: str, deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerTrackMatteSetExecution:
    arguments = LayerTrackMatteSetArguments(
        layer_locator=layer_locator, matte_layer_locator=matte_layer_locator,
        mode=mode, idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[LAYER_TRACK_MATTE_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerTrackMatteSetValue, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if (
        value.layer_locator != arguments.layer_locator
        or value.after_matte_layer_locator != arguments.matte_layer_locator
        or value.after_mode != arguments.mode
    ):
        raise _possibly_side_effecting("Native Track Matte readback did not match the requested relationship.", contract.capability_id)
    return _write_execution(
        LayerTrackMatteSetExecution, descriptor=descriptor, negotiation=negotiation,
        request_id=transport_id, arguments=arguments, result=result, value=value,
    )  # type: ignore[return-value]


async def invoke_layer_track_matte_clear(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], idempotency_key: str, deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerTrackMatteClearExecution:
    arguments = _LayerWriteArguments(layer_locator=layer_locator, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerTrackMatteClearValue, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if value.layer_locator != arguments.layer_locator or value.after_matte_layer_locator is not None:
        raise _possibly_side_effecting("Native Track Matte clear did not remove the relationship.", contract.capability_id)
    return _write_execution(
        LayerTrackMatteClearExecution, descriptor=descriptor, negotiation=negotiation,
        request_id=transport_id, arguments=arguments, result=result, value=value,
    )  # type: ignore[return-value]


async def _invoke_av_switch_set(
    backend: NativeInvokeBackend, *, request_id: str, contract_id: str,
    arguments: LayerAudioEnabledSetArguments | LayerVideoEnabledSetArguments,
    value_model: type[LayerAudioEnabledSetValue] | type[LayerVideoEnabledSetValue],
    execution_model: type[LayerAudioEnabledSetExecution] | type[LayerVideoEnabledSetExecution],
    changed_field: Literal["audio_enabled", "video_enabled"], deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
) -> LayerAudioEnabledSetExecution | LayerVideoEnabledSetExecution:
    contract = CAPABILITY_CONTRACTS[contract_id]
    negotiation, descriptor, transport_id, result, value = await _invoke_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=value_model, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if value.layer_locator != arguments.layer_locator or getattr(value.after, changed_field) != arguments.enabled:
        raise _possibly_side_effecting("Native AV switch readback did not match the requested value.", contract.capability_id)
    return _write_execution(
        execution_model, descriptor=descriptor, negotiation=negotiation,
        request_id=transport_id, arguments=arguments, result=result, value=value,
    )  # type: ignore[return-value]


async def invoke_layer_audio_enabled_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], enabled: bool, idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> LayerAudioEnabledSetExecution:
    arguments = LayerAudioEnabledSetArguments(
        layer_locator=layer_locator, enabled=enabled, idempotency_key=idempotency_key,
    )
    return await _invoke_av_switch_set(
        backend, request_id=request_id, contract_id=LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID,
        arguments=arguments, value_model=LayerAudioEnabledSetValue,
        execution_model=LayerAudioEnabledSetExecution, changed_field="audio_enabled",
        deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )  # type: ignore[return-value]


async def invoke_layer_video_enabled_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], enabled: bool, idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> LayerVideoEnabledSetExecution:
    arguments = LayerVideoEnabledSetArguments(
        layer_locator=layer_locator, enabled=enabled, idempotency_key=idempotency_key,
    )
    return await _invoke_av_switch_set(
        backend, request_id=request_id, contract_id=LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID,
        arguments=arguments, value_model=LayerVideoEnabledSetValue,
        execution_model=LayerVideoEnabledSetExecution, changed_field="video_enabled",
        deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )  # type: ignore[return-value]


__all__ = [
    "CAPABILITY_CONTRACTS", "LAYER_AUDIO_ENABLED_SET_CAPABILITY_ID", "LAYER_AV_STATE_READ_CAPABILITY_ID",
    "LAYER_SOURCE_READ_CAPABILITY_ID", "LAYER_TRACK_MATTE_CLEAR_CAPABILITY_ID",
    "LAYER_TRACK_MATTE_READ_CAPABILITY_ID", "LAYER_TRACK_MATTE_SET_CAPABILITY_ID",
    "LAYER_VIDEO_ENABLED_SET_CAPABILITY_ID", "LayerAVStateValue", "LayerAudioEnabledSetValue",
    "LayerSourceValue", "LayerTrackMatteClearValue", "LayerTrackMatteSetValue", "LayerTrackMatteValue",
    "LayerVideoEnabledSetValue", "invoke_layer_audio_enabled_set", "invoke_layer_av_state_read",
    "invoke_layer_source_read", "invoke_layer_track_matte_clear", "invoke_layer_track_matte_read",
    "invoke_layer_track_matte_set", "invoke_layer_video_enabled_set",
]
