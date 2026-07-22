"""Strict Core contracts for the Layer Switches / Compositing package.

Seven public boolean tools intentionally share one closed native switch
capability.  The public handlers bind the switch name; models never receive a
generic flag or arbitrary enum escape hatch.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Literal, Mapping, TypeVar

from pydantic import Field, StrictBool, model_validator

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
    _descriptor_validator,
    _locator_schema,
    _value_digest,
)


LayerSwitch = Literal[
    "visibility", "solo", "locked", "shy", "motion-blur", "three-d", "adjustment",
]
LayerQuality = Literal["wireframe", "draft", "best"]
LayerBlendingMode = Literal[
    "normal", "dissolve", "add", "multiply", "screen", "overlay", "soft-light",
    "hard-light", "darken", "lighten", "difference", "hue", "saturation", "color",
    "luminosity", "color-dodge", "color-burn", "exclusion", "linear-dodge",
    "linear-burn", "linear-light", "vivid-light", "pin-light", "hard-mix",
    "lighter-color", "darker-color", "subtract", "divide",
]
LayerTrackMatte = Literal["none", "alpha", "inverted-alpha", "luma", "inverted-luma"]

_SWITCHES = ("visibility", "solo", "locked", "shy", "motion-blur", "three-d", "adjustment")
_QUALITIES = ("wireframe", "draft", "best")
_BLENDING_MODES = (
    "normal", "dissolve", "add", "multiply", "screen", "overlay", "soft-light",
    "hard-light", "darken", "lighten", "difference", "hue", "saturation", "color",
    "luminosity", "color-dodge", "color-burn", "exclusion", "linear-dodge",
    "linear-burn", "linear-light", "vivid-light", "pin-light", "hard-mix",
    "lighter-color", "darker-color", "subtract", "divide",
)
_TRACK_MATTES = ("none", "alpha", "inverted-alpha", "luma", "inverted-luma")


def _require_layer(locator: NativeLocator) -> None:
    if locator.kind != "layer":
        raise ValueError("layerLocator must identify a layer")


class LayerCompositingReadArguments(_NativeModel):
    layer_locator: NativeLocator

    @model_validator(mode="after")
    def _layer_kind(self) -> "LayerCompositingReadArguments":
        _require_layer(self.layer_locator)
        return self


class LayerCompositingState(_NativeModel):
    layer_locator: NativeLocator
    visibility_enabled: StrictBool
    solo: StrictBool
    locked: StrictBool
    shy: StrictBool
    motion_blur: StrictBool
    three_d: StrictBool
    adjustment: StrictBool
    quality: LayerQuality
    blending_mode: LayerBlendingMode
    preserve_alpha: StrictBool
    track_matte: LayerTrackMatte

    @model_validator(mode="after")
    def _valid_layer(self) -> "LayerCompositingState":
        _require_layer(self.layer_locator)
        return self


class _LayerCompositingWriteArguments(_NativeModel):
    layer_locator: NativeLocator
    idempotency_key: IdempotencyKey

    @model_validator(mode="after")
    def _layer_kind(self) -> "_LayerCompositingWriteArguments":
        _require_layer(self.layer_locator)
        return self


class LayerSwitchSetArguments(_LayerCompositingWriteArguments):
    switch: LayerSwitch
    enabled: StrictBool


class LayerQualitySetArguments(_LayerCompositingWriteArguments):
    quality: LayerQuality


class LayerBlendingModeSetArguments(_LayerCompositingWriteArguments):
    mode: LayerBlendingMode


class LayerSwitchChanged(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    switch: LayerSwitch
    before_enabled: StrictBool
    after_enabled: StrictBool

    @model_validator(mode="after")
    def _transition(self) -> "LayerSwitchChanged":
        _require_layer(self.layer_locator)
        if self.before_enabled == self.after_enabled:
            raise ValueError("layer switch did not change")
        return self


class LayerQualityChanged(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_quality: LayerQuality
    after_quality: LayerQuality

    @model_validator(mode="after")
    def _transition(self) -> "LayerQualityChanged":
        _require_layer(self.layer_locator)
        if self.before_quality == self.after_quality:
            raise ValueError("layer quality did not change")
        return self


class LayerBlendingModeChanged(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_mode: LayerBlendingMode
    after_mode: LayerBlendingMode
    preserve_alpha: StrictBool
    track_matte: LayerTrackMatte

    @model_validator(mode="after")
    def _transition(self) -> "LayerBlendingModeChanged":
        _require_layer(self.layer_locator)
        if self.before_mode == self.after_mode:
            raise ValueError("layer blending mode did not change")
        return self


class LayerCompositingReadExecution(_ReadExecution):
    value: LayerCompositingState


class LayerSwitchSetExecution(_WriteExecution):
    value: LayerSwitchChanged


class LayerQualitySetExecution(_WriteExecution):
    value: LayerQualityChanged


class LayerBlendingModeSetExecution(_WriteExecution):
    value: LayerBlendingModeChanged


LAYER_COMPOSITING_READ_CAPABILITY_ID = "ae.layer.compositing.read"
LAYER_SWITCH_SET_CAPABILITY_ID = "ae.layer.switch.set"
LAYER_QUALITY_SET_CAPABILITY_ID = "ae.layer.quality.set"
LAYER_BLENDING_MODE_SET_CAPABILITY_ID = "ae.layer.blending-mode.set"


def _layer_locator_input() -> dict[str, Any]:
    return {
        "type": "object", "additionalProperties": False,
        "required": ["layerLocator"],
        "properties": {"layerLocator": _locator_schema("layer")},
    }


def _write_input(value_properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "object", "additionalProperties": False,
        "required": ["layerLocator", *required, "idempotencyKey"],
        "properties": {
            "layerLocator": _locator_schema("layer"),
            **value_properties,
            "idempotencyKey": _IDEMPOTENCY_SCHEMA,
        },
    }


_READ_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": [
        "layerLocator", "visibilityEnabled", "solo", "locked", "shy", "motionBlur",
        "threeD", "adjustment", "quality", "blendingMode", "preserveAlpha", "trackMatte",
    ],
    "properties": {
        "layerLocator": _locator_schema("layer"),
        "visibilityEnabled": {"type": "boolean"}, "solo": {"type": "boolean"},
        "locked": {"type": "boolean"}, "shy": {"type": "boolean"},
        "motionBlur": {"type": "boolean"}, "threeD": {"type": "boolean"},
        "adjustment": {"type": "boolean"}, "quality": {"enum": list(_QUALITIES)},
        "blendingMode": {"enum": list(_BLENDING_MODES)},
        "preserveAlpha": {"type": "boolean"}, "trackMatte": {"enum": list(_TRACK_MATTES)},
    },
}
_SWITCH_INPUT_SCHEMA = _write_input(
    {"switch": {"enum": list(_SWITCHES)}, "enabled": {"type": "boolean"}},
    ["switch", "enabled"],
)
_SWITCH_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["changed", "layerLocator", "switch", "beforeEnabled", "afterEnabled"],
    "properties": {
        "changed": {"const": True}, "layerLocator": _locator_schema("layer"),
        "switch": {"enum": list(_SWITCHES)}, "beforeEnabled": {"type": "boolean"},
        "afterEnabled": {"type": "boolean"},
    },
    "x-invariant": "switch-equals-request;afterEnabled-equals-request-and-differs-from-beforeEnabled",
}
_QUALITY_INPUT_SCHEMA = _write_input({"quality": {"enum": list(_QUALITIES)}}, ["quality"])
_QUALITY_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["changed", "layerLocator", "beforeQuality", "afterQuality"],
    "properties": {
        "changed": {"const": True}, "layerLocator": _locator_schema("layer"),
        "beforeQuality": {"enum": list(_QUALITIES)}, "afterQuality": {"enum": list(_QUALITIES)},
    },
    "x-invariant": "afterQuality-equals-request-and-differs-from-beforeQuality",
}
_BLENDING_INPUT_SCHEMA = _write_input({"mode": {"enum": list(_BLENDING_MODES)}}, ["mode"])
_BLENDING_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": [
        "changed", "layerLocator", "beforeMode", "afterMode", "preserveAlpha", "trackMatte",
    ],
    "properties": {
        "changed": {"const": True}, "layerLocator": _locator_schema("layer"),
        "beforeMode": {"enum": list(_BLENDING_MODES)}, "afterMode": {"enum": list(_BLENDING_MODES)},
        "preserveAlpha": {"type": "boolean"}, "trackMatte": {"enum": list(_TRACK_MATTES)},
    },
    "x-invariant": "afterMode-equals-request;preserveAlpha-and-trackMatte-are-preserved",
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
        LAYER_COMPOSITING_READ_CAPABILITY_ID,
        "Read one layer's render switches, quality, and compositing mode.",
        "read", "idempotent", "Reads layer state without changing After Effects state.",
        (_CURRENT_LAYER,), "aemcp.requirement.native.layer-compositing-read",
        _layer_locator_input(), _READ_RESULT_SCHEMA, "layer-compositing-read",
    ),
    _ContractSpec(
        LAYER_SWITCH_SET_CAPABILITY_ID,
        "Set one allowlisted layer switch.", "write", "idempotency-key",
        "Changes one layer switch and creates one After Effects Undo step.",
        (_CURRENT_LAYER, "The requested value must differ from current state."),
        "aemcp.requirement.native.layer-switch-set",
        _SWITCH_INPUT_SCHEMA, _SWITCH_RESULT_SCHEMA, "layer-switch-set",
    ),
    _ContractSpec(
        LAYER_QUALITY_SET_CAPABILITY_ID,
        "Set one layer's rendering quality.", "write", "idempotency-key",
        "Changes layer quality and creates one After Effects Undo step.",
        (_CURRENT_LAYER, "The requested quality must differ from current state."),
        "aemcp.requirement.native.layer-quality-set",
        _QUALITY_INPUT_SCHEMA, _QUALITY_RESULT_SCHEMA, "layer-quality-set",
    ),
    _ContractSpec(
        LAYER_BLENDING_MODE_SET_CAPABILITY_ID,
        "Set one layer's allowlisted blending mode while preserving matte and alpha flags.",
        "write", "idempotency-key",
        "Changes layer blending mode and creates one After Effects Undo step.",
        (_CURRENT_LAYER, "The requested mode must differ from current state."),
        "aemcp.requirement.native.layer-blending-mode-set",
        _BLENDING_INPUT_SCHEMA, _BLENDING_RESULT_SCHEMA, "layer-blending-mode-set",
    ),
)

CAPABILITY_CONTRACTS = {spec.capability_id: spec.contract() for spec in _SPECS}


async def invoke_layer_compositing_read(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerCompositingReadExecution:
    arguments = LayerCompositingReadArguments(layer_locator=layer_locator)
    contract = CAPABILITY_CONTRACTS[LAYER_COMPOSITING_READ_CAPABILITY_ID]
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
        value = LayerCompositingState.model_validate(result.value)
        digest = _value_digest(contract.capability_id, value)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native layer compositing state did not match the typed contract.",
        ) from exc
    if (
        value.layer_locator != arguments.layer_locator
        or result.evidence.postcondition.kind != contract.postcondition_kind
        or result.evidence.postcondition.digest != digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native layer compositing state was not bound to the request and evidence.",
        )
    return LayerCompositingReadExecution(
        implementation=descriptor, negotiation=negotiation, value=value, evidence=result.evidence,
    )


ValueT = TypeVar("ValueT", bound=_NativeModel)


async def _invoke_write(
    backend: NativeInvokeBackend, *, request_id: str, contract: CapabilityContract,
    arguments: _LayerCompositingWriteArguments, value_model: type[ValueT],
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None,
) -> tuple[Any, Any, str, Any, ValueT]:
    return await _invoke_layer_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,  # type: ignore[arg-type]
        value_model=value_model, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )


async def invoke_layer_switch_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], switch: LayerSwitch, enabled: bool,
    idempotency_key: str, deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerSwitchSetExecution:
    arguments = LayerSwitchSetArguments(
        layer_locator=layer_locator, switch=switch, enabled=enabled, idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[LAYER_SWITCH_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerSwitchChanged, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if (
        value.layer_locator != arguments.layer_locator or value.switch != arguments.switch
        or value.after_enabled != arguments.enabled
    ):
        raise _possibly_side_effecting(
            "Native layer switch readback did not match the requested value.", contract.capability_id,
        )
    return _write_execution(
        LayerSwitchSetExecution, descriptor=descriptor, negotiation=negotiation,
        request_id=transport_id, arguments=arguments, result=result, value=value,
    )  # type: ignore[return-value]


async def invoke_layer_quality_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], quality: LayerQuality,
    idempotency_key: str, deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerQualitySetExecution:
    arguments = LayerQualitySetArguments(
        layer_locator=layer_locator, quality=quality, idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[LAYER_QUALITY_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerQualityChanged, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if value.layer_locator != arguments.layer_locator or value.after_quality != arguments.quality:
        raise _possibly_side_effecting(
            "Native layer quality readback did not match the requested value.", contract.capability_id,
        )
    return _write_execution(
        LayerQualitySetExecution, descriptor=descriptor, negotiation=negotiation,
        request_id=transport_id, arguments=arguments, result=result, value=value,
    )  # type: ignore[return-value]


async def invoke_layer_blending_mode_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], mode: LayerBlendingMode,
    idempotency_key: str, deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerBlendingModeSetExecution:
    arguments = LayerBlendingModeSetArguments(
        layer_locator=layer_locator, mode=mode, idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[LAYER_BLENDING_MODE_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerBlendingModeChanged, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if value.layer_locator != arguments.layer_locator or value.after_mode != arguments.mode:
        raise _possibly_side_effecting(
            "Native layer blending-mode readback did not match the requested value.", contract.capability_id,
        )
    return _write_execution(
        LayerBlendingModeSetExecution, descriptor=descriptor, negotiation=negotiation,
        request_id=transport_id, arguments=arguments, result=result, value=value,
    )  # type: ignore[return-value]


__all__ = [
    "CAPABILITY_CONTRACTS", "LAYER_BLENDING_MODE_SET_CAPABILITY_ID",
    "LAYER_COMPOSITING_READ_CAPABILITY_ID", "LAYER_QUALITY_SET_CAPABILITY_ID",
    "LAYER_SWITCH_SET_CAPABILITY_ID", "LayerBlendingMode", "LayerBlendingModeChanged",
    "LayerBlendingModeSetExecution", "LayerCompositingReadExecution", "LayerCompositingState",
    "LayerQuality", "LayerQualityChanged", "LayerQualitySetExecution", "LayerSwitch",
    "LayerSwitchChanged", "LayerSwitchSetExecution", "invoke_layer_blending_mode_set",
    "invoke_layer_compositing_read", "invoke_layer_quality_set", "invoke_layer_switch_set",
]
