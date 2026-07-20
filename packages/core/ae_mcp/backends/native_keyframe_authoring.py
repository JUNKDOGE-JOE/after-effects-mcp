"""Strict Core contracts for native property-keyframe authoring.

The seven public tools in this package address a keyframe by a stable stream
locator plus exact composition time.  Public keyframe indices are deliberately
absent because insertion and deletion make them unstable.  Every write stays
on the native AEGP plane, uses one idempotency key, and verifies typed readback,
audit binding, postcondition evidence, and After Effects Undo availability.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Annotated, Any, Literal, Mapping, TypeVar

from pydantic import Field, StrictBool, StrictInt, ValidationError, model_validator

from ae_mcp.backends.native import (
    DecimalString,
    LayerPropertyColorValue,
    LayerPropertyPrimitiveValue,
    LayerPropertyScalarValue,
    LayerPropertyVectorValue,
    NativeBackendError,
    NativeCancellationToken,
    NativeCapabilityDescriptor,
    NativeInvokeBackend,
    NativeLocator,
    NativeNegotiation,
    NonNegativeInt,
    RequestId,
    _NativeModel,
    _invoke_native_read_request,
    _layer_property_values_binary_equal,
    _structured_error,
    _validate_decimal_string,
)
from ae_mcp.backends.native_project_composition import (
    CAPABILITY_VERSION,
    CapabilityContract,
    ExactTime,
    ExactTimeInput,
    IdempotencyKey,
    _IDEMPOTENCY_SCHEMA,
    _ReadExecution,
    _WriteExecution,
    _descriptor_validator,
    _exact_time_schema,
    _invoke_package_write_request,
    _locator_schema,
    _time_input_schema,
    _times_equal,
    _validate_write_value,
    _value_digest,
)


_SAFE_MAX = 9_007_199_254_740_991
_DECIMAL_PATTERN = r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"
_INTERPOLATION = ("none", "linear", "bezier", "hold")
_SET_INTERPOLATION = ("linear", "bezier", "hold")
_BEHAVIORS = (
    "temporal-continuous",
    "temporal-auto-bezier",
    "spatial-continuous",
    "spatial-auto-bezier",
    "roving",
)
_VALUE_TYPES = (
    "one-d",
    "two-d",
    "two-d-spatial",
    "three-d",
    "three-d-spatial",
    "color",
)


def _validate_finite_decimal(value: str, *, field: str) -> Decimal:
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError(f"{field} must be a finite decimal") from exc
    if not parsed.is_finite():
        raise ValueError(f"{field} must be a finite decimal")
    return parsed


class KeyframeEase(_NativeModel):
    speed: DecimalString
    influence: DecimalString

    @model_validator(mode="after")
    def _valid_ease(self) -> "KeyframeEase":
        _validate_decimal_string(self.speed)
        _validate_decimal_string(self.influence)
        influence = _validate_finite_decimal(self.influence, field="influence")
        if influence < 0 or influence > 100:
            raise ValueError("influence must be within 0..100")
        return self


class KeyframeEaseDimension(_NativeModel):
    dimension: Annotated[StrictInt, Field(ge=0, le=3)]
    in_ease: KeyframeEase
    out_ease: KeyframeEase


class KeyframeBehaviors(_NativeModel):
    temporal_continuous: StrictBool
    temporal_auto_bezier: StrictBool
    spatial_continuous: StrictBool
    spatial_auto_bezier: StrictBool
    roving: StrictBool


class KeyframeDetails(_NativeModel):
    property_locator: NativeLocator
    time: ExactTime
    temporal_dimensionality: Annotated[StrictInt, Field(ge=1, le=4)]
    value_type: Literal[
        "one-d",
        "two-d",
        "two-d-spatial",
        "three-d",
        "three-d-spatial",
        "color",
    ]
    value: LayerPropertyPrimitiveValue
    in_interpolation: Literal["none", "linear", "bezier", "hold"]
    out_interpolation: Literal["none", "linear", "bezier", "hold"]
    temporal_ease_dimensions: tuple[KeyframeEaseDimension, ...] = Field(
        min_length=1,
        max_length=4,
    )
    behaviors: KeyframeBehaviors

    @model_validator(mode="after")
    def _coherent_details(self) -> "KeyframeDetails":
        if self.property_locator.kind != "stream":
            raise ValueError("propertyLocator must identify a stream")
        if [item.dimension for item in self.temporal_ease_dimensions] != list(
            range(self.temporal_dimensionality)
        ):
            raise ValueError(
                "temporalEaseDimensions must cover every dimension in order"
            )
        if self.value_type == "one-d":
            value_matches = isinstance(self.value, LayerPropertyScalarValue)
        elif self.value_type in {"two-d", "two-d-spatial"}:
            value_matches = (
                isinstance(self.value, LayerPropertyVectorValue)
                and len(self.value.components) == 2
            )
        elif self.value_type in {"three-d", "three-d-spatial"}:
            value_matches = (
                isinstance(self.value, LayerPropertyVectorValue)
                and len(self.value.components) == 3
            )
        else:
            value_matches = isinstance(self.value, LayerPropertyColorValue)
        if not value_matches:
            raise ValueError("keyframe value does not match valueType")
        return self


class KeyframeDetailsArguments(_NativeModel):
    property_locator: NativeLocator
    time: ExactTimeInput

    @model_validator(mode="after")
    def _stream_kind(self) -> "KeyframeDetailsArguments":
        if self.property_locator.kind != "stream":
            raise ValueError("propertyLocator must identify a stream")
        return self


class _KeyframeWriteArguments(KeyframeDetailsArguments):
    layer_locator: NativeLocator
    idempotency_key: IdempotencyKey

    @model_validator(mode="after")
    def _same_context(self) -> "_KeyframeWriteArguments":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must identify a layer")
        if self.layer_locator.context() != self.property_locator.context():
            raise ValueError("layerLocator and propertyLocator must share one context")
        return self


class KeyframeAddArguments(_KeyframeWriteArguments):
    value: LayerPropertyPrimitiveValue


class KeyframeValueSetArguments(_KeyframeWriteArguments):
    value: LayerPropertyPrimitiveValue


class KeyframeInterpolationSetArguments(_KeyframeWriteArguments):
    in_interpolation: Literal["linear", "bezier", "hold"]
    out_interpolation: Literal["linear", "bezier", "hold"]


class KeyframeTemporalEaseSetArguments(_KeyframeWriteArguments):
    dimensions: tuple[KeyframeEaseDimension, ...] = Field(min_length=1, max_length=4)

    @model_validator(mode="after")
    def _contiguous_dimensions(self) -> "KeyframeTemporalEaseSetArguments":
        if [item.dimension for item in self.dimensions] != list(
            range(len(self.dimensions))
        ):
            raise ValueError("dimensions must be contiguous and zero-based")
        return self


class KeyframeBehaviorSetArguments(_KeyframeWriteArguments):
    behavior: Literal[
        "temporal-continuous",
        "temporal-auto-bezier",
        "spatial-continuous",
        "spatial-auto-bezier",
        "roving",
    ]
    enabled: StrictBool


class KeyframeDeleteArguments(_KeyframeWriteArguments):
    pass


class KeyframeMutationValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    property_locator: NativeLocator
    time: ExactTime
    keyframe_count_before: NonNegativeInt
    keyframe_count_after: NonNegativeInt
    before_keyframe: KeyframeDetails | None
    after_keyframe: KeyframeDetails | None

    @model_validator(mode="after")
    def _bound_state(self) -> "KeyframeMutationValue":
        layer = self.layer_locator
        prop = self.property_locator
        if layer.kind != "layer" or prop.kind != "stream":
            raise ValueError("keyframe mutation returned invalid locator kinds")
        if layer.context() != prop.context():
            raise ValueError("keyframe mutation locators escaped one context")
        for detail in (self.before_keyframe, self.after_keyframe):
            if detail is not None and (
                detail.property_locator != prop
                or not _times_equal(detail.time, self.time)
            ):
                raise ValueError("keyframe snapshot is not bound to the target")
        if self.before_keyframe is None and self.after_keyframe is None:
            raise ValueError("keyframe mutation must report before or after state")
        return self


class KeyframeDetailsExecution(_ReadExecution):
    value: KeyframeDetails


class KeyframeWriteExecution(_WriteExecution):
    value: KeyframeMutationValue


KEYFRAME_DETAILS_READ_CAPABILITY_ID = "ae.layer.property.keyframe.details.read"
KEYFRAME_ADD_CAPABILITY_ID = "ae.layer.property.keyframe.add"
KEYFRAME_VALUE_SET_CAPABILITY_ID = "ae.layer.property.keyframe.value.set"
KEYFRAME_INTERPOLATION_SET_CAPABILITY_ID = (
    "ae.layer.property.keyframe.interpolation.set"
)
KEYFRAME_TEMPORAL_EASE_SET_CAPABILITY_ID = (
    "ae.layer.property.keyframe.temporal-ease.set"
)
KEYFRAME_BEHAVIOR_SET_CAPABILITY_ID = "ae.layer.property.keyframe.behavior.set"
KEYFRAME_DELETE_CAPABILITY_ID = "ae.layer.property.keyframe.delete"


def _decimal_schema() -> dict[str, Any]:
    return {
        "type": "string",
        "minLength": 1,
        "maxLength": 32,
        "pattern": _DECIMAL_PATTERN,
    }


def _primitive_value_schema() -> dict[str, Any]:
    decimal = _decimal_schema()
    return {
        "oneOf": [
            {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind", "value"],
                "properties": {"kind": {"const": "scalar"}, "value": decimal},
            },
            {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind", "components"],
                "properties": {
                    "kind": {"const": "vector"},
                    "components": {
                        "type": "array",
                        "minItems": 2,
                        "maxItems": 3,
                        "items": decimal,
                    },
                },
            },
            {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind", "alpha", "red", "green", "blue"],
                "properties": {
                    "kind": {"const": "color"},
                    "alpha": decimal,
                    "red": decimal,
                    "green": decimal,
                    "blue": decimal,
                },
            },
        ]
    }


def _ease_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["speed", "influence"],
        "properties": {
            "speed": _decimal_schema(),
            "influence": _decimal_schema(),
        },
        "x-invariant": "speed-and-influence-are-finite-and-influence-is-within-0-to-100",
    }


def _ease_dimension_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["dimension", "inEase", "outEase"],
        "properties": {
            "dimension": {"type": "integer", "minimum": 0, "maximum": 3},
            "inEase": _ease_schema(),
            "outEase": _ease_schema(),
        },
    }


def _behaviors_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "temporalContinuous",
            "temporalAutoBezier",
            "spatialContinuous",
            "spatialAutoBezier",
            "roving",
        ],
        "properties": {
            "temporalContinuous": {"type": "boolean"},
            "temporalAutoBezier": {"type": "boolean"},
            "spatialContinuous": {"type": "boolean"},
            "spatialAutoBezier": {"type": "boolean"},
            "roving": {"type": "boolean"},
        },
    }


def _keyframe_details_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "propertyLocator",
            "time",
            "temporalDimensionality",
            "valueType",
            "value",
            "inInterpolation",
            "outInterpolation",
            "temporalEaseDimensions",
            "behaviors",
        ],
        "properties": {
            "propertyLocator": _locator_schema("stream"),
            "time": _exact_time_schema(),
            "temporalDimensionality": {
                "type": "integer",
                "minimum": 1,
                "maximum": 4,
            },
            "valueType": {"enum": list(_VALUE_TYPES)},
            "value": _primitive_value_schema(),
            "inInterpolation": {"enum": list(_INTERPOLATION)},
            "outInterpolation": {"enum": list(_INTERPOLATION)},
            "temporalEaseDimensions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 4,
                "items": _ease_dimension_schema(),
            },
            "behaviors": _behaviors_schema(),
        },
        "x-invariant": (
            "value-matches-valueType-and-temporal-ease-dimensions-match-temporalDimensionality"
        ),
    }


def _target_input_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["propertyLocator", "time"],
        "properties": {
            "propertyLocator": _locator_schema("stream"),
            "time": _time_input_schema(),
        },
    }


def _write_input_schema(**extra: dict[str, Any]) -> dict[str, Any]:
    properties: dict[str, Any] = {
        "layerLocator": _locator_schema("layer"),
        "propertyLocator": _locator_schema("stream"),
        "time": _time_input_schema(),
        "idempotencyKey": _IDEMPOTENCY_SCHEMA,
        **extra,
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": list(properties),
        "properties": properties,
        "x-invariant": "layerLocator-and-propertyLocator-share-one-current-context",
    }


def _mutation_result_schema() -> dict[str, Any]:
    details = _keyframe_details_schema()
    nullable_details = {"oneOf": [{"type": "null"}, details]}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "changed",
            "layerLocator",
            "propertyLocator",
            "time",
            "keyframeCountBefore",
            "keyframeCountAfter",
            "beforeKeyframe",
            "afterKeyframe",
        ],
        "properties": {
            "changed": {"const": True},
            "layerLocator": _locator_schema("layer"),
            "propertyLocator": _locator_schema("stream"),
            "time": _exact_time_schema(),
            "keyframeCountBefore": {
                "type": "integer",
                "minimum": 0,
                "maximum": _SAFE_MAX,
            },
            "keyframeCountAfter": {
                "type": "integer",
                "minimum": 0,
                "maximum": _SAFE_MAX,
            },
            "beforeKeyframe": nullable_details,
            "afterKeyframe": nullable_details,
        },
        "x-invariant": "before-and-after-keyframes-are-bound-to-propertyLocator-and-time",
    }


_DETAILS_INPUT_SCHEMA = _target_input_schema()
_DETAILS_RESULT_SCHEMA = _keyframe_details_schema()
_ADD_INPUT_SCHEMA = _write_input_schema(value=_primitive_value_schema())
_VALUE_SET_INPUT_SCHEMA = _write_input_schema(value=_primitive_value_schema())
_INTERPOLATION_SET_INPUT_SCHEMA = _write_input_schema(
    inInterpolation={"enum": list(_SET_INTERPOLATION)},
    outInterpolation={"enum": list(_SET_INTERPOLATION)},
)
_TEMPORAL_EASE_SET_INPUT_SCHEMA = _write_input_schema(
    dimensions={
        "type": "array",
        "minItems": 1,
        "maxItems": 4,
        "items": _ease_dimension_schema(),
        "x-invariant": "dimensions-are-contiguous-and-zero-based",
    }
)
_BEHAVIOR_SET_INPUT_SCHEMA = _write_input_schema(
    behavior={"enum": list(_BEHAVIORS)},
    enabled={"type": "boolean"},
)
_DELETE_INPUT_SCHEMA = _write_input_schema()
_MUTATION_RESULT_SCHEMA = _mutation_result_schema()


CAPABILITY_CONTRACTS: dict[str, CapabilityContract] = {
    KEYFRAME_DETAILS_READ_CAPABILITY_ID: CapabilityContract(
        KEYFRAME_DETAILS_READ_CAPABILITY_ID,
        "Read one After Effects property keyframe by exact composition time.",
        "read",
        "idempotent",
        "Reads one native keyframe without changing After Effects state.",
        (
            "An After Effects project must be open.",
            "propertyLocator must identify a keyframed primitive leaf stream.",
            "A keyframe must exist at the exact requested composition time.",
        ),
        "aemcp.requirement.native.layer-property-keyframe-details-read",
        _DETAILS_INPUT_SCHEMA,
        _DETAILS_RESULT_SCHEMA,
        "layer-property-keyframe-details-read",
    ),
    KEYFRAME_ADD_CAPABILITY_ID: CapabilityContract(
        KEYFRAME_ADD_CAPABILITY_ID,
        "Add one After Effects property keyframe at exact composition time.",
        "write",
        "idempotency-key",
        "Adds one native keyframe and creates one After Effects Undo step.",
        (
            "Both locators must be current and identify one keyframeable primitive leaf stream.",
            "No keyframe may exist at the exact requested composition time.",
            "value must match the property value type.",
        ),
        "aemcp.requirement.native.layer-property-keyframe-add",
        _ADD_INPUT_SCHEMA,
        _MUTATION_RESULT_SCHEMA,
        "layer-property-keyframe-add",
    ),
    KEYFRAME_VALUE_SET_CAPABILITY_ID: CapabilityContract(
        KEYFRAME_VALUE_SET_CAPABILITY_ID,
        "Set one After Effects property keyframe value.",
        "write",
        "idempotency-key",
        "Changes one native keyframe value and creates one After Effects Undo step.",
        (
            "Both locators must be current and identify one keyframed primitive leaf stream.",
            "A keyframe must exist at the exact requested composition time.",
            "value must match the property value type and differ from the current value.",
        ),
        "aemcp.requirement.native.layer-property-keyframe-value-set",
        _VALUE_SET_INPUT_SCHEMA,
        _MUTATION_RESULT_SCHEMA,
        "layer-property-keyframe-value-set",
    ),
    KEYFRAME_INTERPOLATION_SET_CAPABILITY_ID: CapabilityContract(
        KEYFRAME_INTERPOLATION_SET_CAPABILITY_ID,
        "Set incoming and outgoing interpolation for one After Effects property keyframe.",
        "write",
        "idempotency-key",
        "Changes one native keyframe interpolation and creates one After Effects Undo step.",
        (
            "Both locators must be current and identify one keyframed primitive leaf stream.",
            "A keyframe must exist at the exact requested composition time.",
            "The requested interpolation pair must differ from the current pair.",
        ),
        "aemcp.requirement.native.layer-property-keyframe-interpolation-set",
        _INTERPOLATION_SET_INPUT_SCHEMA,
        _MUTATION_RESULT_SCHEMA,
        "layer-property-keyframe-interpolation-set",
    ),
    KEYFRAME_TEMPORAL_EASE_SET_CAPABILITY_ID: CapabilityContract(
        KEYFRAME_TEMPORAL_EASE_SET_CAPABILITY_ID,
        "Set typed temporal ease dimensions for one After Effects property keyframe.",
        "write",
        "idempotency-key",
        "Changes one native keyframe temporal ease and creates one After Effects Undo step.",
        (
            "Both locators must be current and identify one keyframed primitive leaf stream.",
            "A keyframe must exist at the exact requested composition time.",
            "dimensions must cover the property's temporal dimensions in zero-based order and differ from current ease.",
        ),
        "aemcp.requirement.native.layer-property-keyframe-temporal-ease-set",
        _TEMPORAL_EASE_SET_INPUT_SCHEMA,
        _MUTATION_RESULT_SCHEMA,
        "layer-property-keyframe-temporal-ease-set",
    ),
    KEYFRAME_BEHAVIOR_SET_CAPABILITY_ID: CapabilityContract(
        KEYFRAME_BEHAVIOR_SET_CAPABILITY_ID,
        "Set one behavior flag on an After Effects property keyframe.",
        "write",
        "idempotency-key",
        "Changes one native keyframe behavior and creates one After Effects Undo step.",
        (
            "Both locators must be current and identify one keyframed primitive leaf stream.",
            "A keyframe must exist at the exact requested composition time.",
            "The requested behavior state must be supported and differ from current state.",
        ),
        "aemcp.requirement.native.layer-property-keyframe-behavior-set",
        _BEHAVIOR_SET_INPUT_SCHEMA,
        _MUTATION_RESULT_SCHEMA,
        "layer-property-keyframe-behavior-set",
    ),
    KEYFRAME_DELETE_CAPABILITY_ID: CapabilityContract(
        KEYFRAME_DELETE_CAPABILITY_ID,
        "Delete one After Effects property keyframe at exact composition time.",
        "write",
        "idempotency-key",
        "Deletes one native keyframe and creates one After Effects Undo step.",
        (
            "Both locators must be current and identify one keyframed primitive leaf stream.",
            "A keyframe must exist at the exact requested composition time.",
        ),
        "aemcp.requirement.native.layer-property-keyframe-delete",
        _DELETE_INPUT_SCHEMA,
        _MUTATION_RESULT_SCHEMA,
        "layer-property-keyframe-delete",
    ),
}


async def invoke_keyframe_details_read(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    property_locator: NativeLocator | Mapping[str, Any],
    time: ExactTimeInput | Mapping[str, Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> KeyframeDetailsExecution:
    arguments = KeyframeDetailsArguments(
        property_locator=property_locator,
        time=time,
    )
    contract = CAPABILITY_CONTRACTS[KEYFRAME_DETAILS_READ_CAPABILITY_ID]
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=contract.capability_id,
        capability_version=CAPABILITY_VERSION,
        arguments=arguments.model_dump(mode="json", by_alias=True),
        locator=arguments.property_locator,
        locator_field="params.arguments.propertyLocator",
        stale_locator_hint=(
            "Call ae_listLayerProperties and copy a fresh property_locator."
        ),
        descriptor_validator=_descriptor_validator(contract),
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = KeyframeDetails.model_validate(result.value)
        digest = _value_digest(contract.capability_id, value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native keyframe details did not match the typed contract.",
        ) from exc
    if (
        value.property_locator != arguments.property_locator
        or not _times_equal(value.time, arguments.time)
        or result.evidence.postcondition.kind != contract.postcondition_kind
        or result.evidence.postcondition.digest != digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native keyframe details were not bound to the request and evidence.",
        )
    return KeyframeDetailsExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=value,
        evidence=result.evidence,
    )


WriteArgsT = TypeVar("WriteArgsT", bound=_KeyframeWriteArguments)


async def _invoke_keyframe_write(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    contract: CapabilityContract,
    arguments: WriteArgsT,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
) -> tuple[
    NativeNegotiation,
    NativeCapabilityDescriptor,
    RequestId,
    Any,
    KeyframeMutationValue,
]:
    inspect_hint = (
        "Read fresh keyframe details and inspect the After Effects Undo stack "
        "before issuing another keyframe write."
    )
    negotiation, descriptor, request, result = await _invoke_package_write_request(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=arguments,
        locator=arguments.property_locator,
        locator_field="params.arguments.propertyLocator",
        allow_replay=False,
        inspect_hint=inspect_hint,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    value = _validate_write_value(
        contract=contract,
        result=result,
        value_model=KeyframeMutationValue,
        inspect_hint=inspect_hint,
    )
    if (
        value.layer_locator != arguments.layer_locator
        or value.property_locator != arguments.property_locator
        or not _times_equal(value.time, arguments.time)
    ):
        raise _possibly_side_effecting(
            "Native keyframe readback was not bound to the requested target.",
            contract.capability_id,
        )
    return negotiation, descriptor, request.request_id, result, value


def _possibly_side_effecting(message: str, capability_id: str) -> NativeBackendError:
    from ae_mcp.backends.native import NativeRecovery

    return NativeBackendError(
        "POSSIBLY_SIDE_EFFECTING_FAILURE",
        message,
        retryable=False,
        side_effect="may-have-occurred",
        recovery=NativeRecovery(
            action="inspect-state",
            hint=(
                "Read fresh keyframe details and inspect the After Effects Undo "
                "stack before issuing another keyframe write."
            ),
        ),
        details={"capabilityId": capability_id},
    )


def _write_execution(
    *,
    descriptor: NativeCapabilityDescriptor,
    negotiation: NativeNegotiation,
    transport_request_id: str,
    arguments: _KeyframeWriteArguments,
    result: Any,
    value: KeyframeMutationValue,
) -> KeyframeWriteExecution:
    return KeyframeWriteExecution(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=transport_request_id,
        idempotency_key=arguments.idempotency_key,
        replayed=result.replayed,
        value=value,
        evidence=result.evidence,
    )


def _details_equal_except(
    before: KeyframeDetails,
    after: KeyframeDetails,
    *fields: str,
) -> bool:
    excluded = set(fields)
    return before.model_dump(exclude=excluded) == after.model_dump(exclude=excluded)


def _interpolation_ease_normalization_allowed(
    before: KeyframeDetails,
    after: KeyframeDetails,
    requested_in_interpolation: str,
) -> bool:
    before_ease = before.temporal_ease_dimensions
    after_ease = after.temporal_ease_dimensions
    if len(before_ease) != len(after_ease):
        return False
    for before_dimension, after_dimension in zip(before_ease, after_ease):
        in_influence_changed = Decimal(before_dimension.in_ease.influence) != Decimal(
            after_dimension.in_ease.influence
        )
        if (
            before_dimension.dimension != after_dimension.dimension
            or Decimal(before_dimension.in_ease.speed)
            != Decimal(after_dimension.in_ease.speed)
            or Decimal(before_dimension.out_ease.speed)
            != Decimal(after_dimension.out_ease.speed)
            or Decimal(before_dimension.out_ease.influence)
            != Decimal(after_dimension.out_ease.influence)
            or (
                in_influence_changed
                and (
                    requested_in_interpolation != "bezier"
                    or after.in_interpolation != "bezier"
                    or Decimal(after_dimension.in_ease.influence) != 0
                )
            )
        ):
            return False
    return True


def _value_ease_speed_recomputation_allowed(
    before: KeyframeDetails,
    after: KeyframeDetails,
    keyframe_count: int,
) -> bool:
    """Allow the one derived-ease drift an After Effects value write causes.

    After Effects recomputes the temporal ease speed of a linear keyframe as
    the slope to its temporal neighbours whenever the keyframe value changes
    (speed = |value delta| / time delta per side). Neighbour times and values
    are not part of the mutation value, so the exact slope is underdetermined
    here; the check therefore releases only the two AE-derived speed fields,
    and only for the shape After Effects actually recomputes (a multi-key
    property whose before/after interpolations are linear), while influence,
    dimension order, and every other field stay exactly equal.
    """
    before_ease = before.temporal_ease_dimensions
    after_ease = after.temporal_ease_dimensions
    if len(before_ease) != len(after_ease):
        return False
    drift_allowed = (
        keyframe_count >= 2
        and before.in_interpolation == "linear"
        and before.out_interpolation == "linear"
        and after.in_interpolation == "linear"
        and after.out_interpolation == "linear"
    )
    for before_dimension, after_dimension in zip(before_ease, after_ease):
        if (
            before_dimension.dimension != after_dimension.dimension
            or Decimal(before_dimension.in_ease.influence)
            != Decimal(after_dimension.in_ease.influence)
            or Decimal(before_dimension.out_ease.influence)
            != Decimal(after_dimension.out_ease.influence)
        ):
            return False
        if not drift_allowed and (
            Decimal(before_dimension.in_ease.speed)
            != Decimal(after_dimension.in_ease.speed)
            or Decimal(before_dimension.out_ease.speed)
            != Decimal(after_dimension.out_ease.speed)
        ):
            return False
    return True


async def invoke_keyframe_add(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    property_locator: NativeLocator | Mapping[str, Any],
    time: ExactTimeInput | Mapping[str, Any],
    value: LayerPropertyPrimitiveValue | Mapping[str, Any],
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> KeyframeWriteExecution:
    arguments = KeyframeAddArguments(
        layer_locator=layer_locator,
        property_locator=property_locator,
        time=time,
        value=value,
        idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[KEYFRAME_ADD_CAPABILITY_ID]
    facts = await _invoke_keyframe_write(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=arguments,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    negotiation, descriptor, transport_id, result, changed = facts
    if (
        changed.before_keyframe is not None
        or changed.after_keyframe is None
        or changed.keyframe_count_after != changed.keyframe_count_before + 1
        or not _layer_property_values_binary_equal(
            changed.after_keyframe.value,
            arguments.value,
        )
    ):
        raise _possibly_side_effecting(
            "Native keyframe add readback did not prove exactly one requested keyframe.",
            contract.capability_id,
        )
    return _write_execution(
        descriptor=descriptor,
        negotiation=negotiation,
        transport_request_id=transport_id,
        arguments=arguments,
        result=result,
        value=changed,
    )


async def invoke_keyframe_value_set(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    property_locator: NativeLocator | Mapping[str, Any],
    time: ExactTimeInput | Mapping[str, Any],
    value: LayerPropertyPrimitiveValue | Mapping[str, Any],
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> KeyframeWriteExecution:
    arguments = KeyframeValueSetArguments(
        layer_locator=layer_locator,
        property_locator=property_locator,
        time=time,
        value=value,
        idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[KEYFRAME_VALUE_SET_CAPABILITY_ID]
    facts = await _invoke_keyframe_write(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=arguments,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    negotiation, descriptor, transport_id, result, changed = facts
    if (
        changed.before_keyframe is None
        or changed.after_keyframe is None
        or changed.keyframe_count_after != changed.keyframe_count_before
        or _layer_property_values_binary_equal(
            changed.before_keyframe.value,
            changed.after_keyframe.value,
        )
        or not _layer_property_values_binary_equal(
            changed.after_keyframe.value,
            arguments.value,
        )
        or not _details_equal_except(
            changed.before_keyframe,
            changed.after_keyframe,
            "value",
            "temporal_ease_dimensions",
        )
        or not _value_ease_speed_recomputation_allowed(
            changed.before_keyframe,
            changed.after_keyframe,
            changed.keyframe_count_before,
        )
    ):
        raise _possibly_side_effecting(
            "Native keyframe value readback did not match the requested value.",
            contract.capability_id,
        )
    return _write_execution(
        descriptor=descriptor,
        negotiation=negotiation,
        transport_request_id=transport_id,
        arguments=arguments,
        result=result,
        value=changed,
    )


async def invoke_keyframe_interpolation_set(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    property_locator: NativeLocator | Mapping[str, Any],
    time: ExactTimeInput | Mapping[str, Any],
    in_interpolation: str,
    out_interpolation: str,
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> KeyframeWriteExecution:
    arguments = KeyframeInterpolationSetArguments(
        layer_locator=layer_locator,
        property_locator=property_locator,
        time=time,
        in_interpolation=in_interpolation,
        out_interpolation=out_interpolation,
        idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[KEYFRAME_INTERPOLATION_SET_CAPABILITY_ID]
    facts = await _invoke_keyframe_write(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=arguments,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    negotiation, descriptor, transport_id, result, changed = facts
    before = changed.before_keyframe
    after = changed.after_keyframe
    if (
        before is None
        or after is None
        or changed.keyframe_count_after != changed.keyframe_count_before
        or (before.in_interpolation, before.out_interpolation)
        == (after.in_interpolation, after.out_interpolation)
        or after.in_interpolation != arguments.in_interpolation
        or after.out_interpolation != arguments.out_interpolation
        or not _interpolation_ease_normalization_allowed(
            before,
            after,
            arguments.in_interpolation,
        )
        or not _details_equal_except(
            before,
            after,
            "in_interpolation",
            "out_interpolation",
            "temporal_ease_dimensions",
        )
    ):
        raise _possibly_side_effecting(
            "Native keyframe interpolation readback did not match the request.",
            contract.capability_id,
        )
    return _write_execution(
        descriptor=descriptor,
        negotiation=negotiation,
        transport_request_id=transport_id,
        arguments=arguments,
        result=result,
        value=changed,
    )


def _ease_equal(
    left: tuple[KeyframeEaseDimension, ...],
    right: tuple[KeyframeEaseDimension, ...],
) -> bool:
    if len(left) != len(right):
        return False
    for left_item, right_item in zip(left, right):
        if left_item.dimension != right_item.dimension:
            return False
        for left_ease, right_ease in (
            (left_item.in_ease, right_item.in_ease),
            (left_item.out_ease, right_item.out_ease),
        ):
            if (
                Decimal(left_ease.speed) != Decimal(right_ease.speed)
                or Decimal(left_ease.influence) != Decimal(right_ease.influence)
            ):
                return False
    return True


def _temporal_ease_coupling_allowed(
    before: KeyframeDetails,
    after: KeyframeDetails,
) -> bool:
    """Accept only the After Effects bezier promotion beside an ease write.

    After Effects retains per-keyframe temporal ease only when both sides use
    bezier interpolation, so the native write promotes non-bezier sides to
    bezier inside the same Undo group.  Accept exactly that coupling: the
    after state must be bezier on both sides, and nothing except the ease
    dimensions and the two interpolation fields may change.
    """
    return (
        after.in_interpolation == "bezier"
        and after.out_interpolation == "bezier"
        and _details_equal_except(
            before,
            after,
            "temporal_ease_dimensions",
            "in_interpolation",
            "out_interpolation",
        )
    )


async def invoke_keyframe_temporal_ease_set(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    property_locator: NativeLocator | Mapping[str, Any],
    time: ExactTimeInput | Mapping[str, Any],
    dimensions: tuple[KeyframeEaseDimension | Mapping[str, Any], ...],
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> KeyframeWriteExecution:
    arguments = KeyframeTemporalEaseSetArguments(
        layer_locator=layer_locator,
        property_locator=property_locator,
        time=time,
        dimensions=dimensions,
        idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[KEYFRAME_TEMPORAL_EASE_SET_CAPABILITY_ID]
    facts = await _invoke_keyframe_write(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=arguments,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    negotiation, descriptor, transport_id, result, changed = facts
    before = changed.before_keyframe
    after = changed.after_keyframe
    if (
        before is None
        or after is None
        or changed.keyframe_count_after != changed.keyframe_count_before
        or _ease_equal(
            before.temporal_ease_dimensions,
            after.temporal_ease_dimensions,
        )
        or not _ease_equal(after.temporal_ease_dimensions, arguments.dimensions)
        or not _temporal_ease_coupling_allowed(before, after)
    ):
        raise _possibly_side_effecting(
            "Native keyframe temporal-ease readback did not match the request.",
            contract.capability_id,
        )
    return _write_execution(
        descriptor=descriptor,
        negotiation=negotiation,
        transport_request_id=transport_id,
        arguments=arguments,
        result=result,
        value=changed,
    )


def _behavior_value(details: KeyframeDetails, behavior: str) -> bool:
    field = behavior.replace("-", "_")
    return bool(getattr(details.behaviors, field))


async def invoke_keyframe_behavior_set(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    property_locator: NativeLocator | Mapping[str, Any],
    time: ExactTimeInput | Mapping[str, Any],
    behavior: str,
    enabled: bool,
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> KeyframeWriteExecution:
    arguments = KeyframeBehaviorSetArguments(
        layer_locator=layer_locator,
        property_locator=property_locator,
        time=time,
        behavior=behavior,
        enabled=enabled,
        idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[KEYFRAME_BEHAVIOR_SET_CAPABILITY_ID]
    facts = await _invoke_keyframe_write(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=arguments,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    negotiation, descriptor, transport_id, result, changed = facts
    before = changed.before_keyframe
    after = changed.after_keyframe
    if (
        before is None
        or after is None
        or changed.keyframe_count_after != changed.keyframe_count_before
        or _behavior_value(before, arguments.behavior)
        == _behavior_value(after, arguments.behavior)
        or _behavior_value(after, arguments.behavior) is not arguments.enabled
        or not _details_equal_except(before, after, "behaviors")
    ):
        raise _possibly_side_effecting(
            "Native keyframe behavior readback did not match the request.",
            contract.capability_id,
        )
    return _write_execution(
        descriptor=descriptor,
        negotiation=negotiation,
        transport_request_id=transport_id,
        arguments=arguments,
        result=result,
        value=changed,
    )


async def invoke_keyframe_delete(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    property_locator: NativeLocator | Mapping[str, Any],
    time: ExactTimeInput | Mapping[str, Any],
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> KeyframeWriteExecution:
    arguments = KeyframeDeleteArguments(
        layer_locator=layer_locator,
        property_locator=property_locator,
        time=time,
        idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[KEYFRAME_DELETE_CAPABILITY_ID]
    facts = await _invoke_keyframe_write(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=arguments,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    negotiation, descriptor, transport_id, result, changed = facts
    if (
        changed.before_keyframe is None
        or changed.after_keyframe is not None
        or changed.keyframe_count_before != changed.keyframe_count_after + 1
    ):
        raise _possibly_side_effecting(
            "Native keyframe delete readback did not prove exactly one deletion.",
            contract.capability_id,
        )
    return _write_execution(
        descriptor=descriptor,
        negotiation=negotiation,
        transport_request_id=transport_id,
        arguments=arguments,
        result=result,
        value=changed,
    )


__all__ = [
    "CAPABILITY_CONTRACTS",
    "KEYFRAME_ADD_CAPABILITY_ID",
    "KEYFRAME_BEHAVIOR_SET_CAPABILITY_ID",
    "KEYFRAME_DELETE_CAPABILITY_ID",
    "KEYFRAME_DETAILS_READ_CAPABILITY_ID",
    "KEYFRAME_INTERPOLATION_SET_CAPABILITY_ID",
    "KEYFRAME_TEMPORAL_EASE_SET_CAPABILITY_ID",
    "KEYFRAME_VALUE_SET_CAPABILITY_ID",
    "KeyframeBehaviorSetArguments",
    "KeyframeDetails",
    "KeyframeDetailsArguments",
    "KeyframeDetailsExecution",
    "KeyframeEase",
    "KeyframeEaseDimension",
    "KeyframeMutationValue",
    "KeyframeWriteExecution",
    "invoke_keyframe_add",
    "invoke_keyframe_behavior_set",
    "invoke_keyframe_delete",
    "invoke_keyframe_details_read",
    "invoke_keyframe_interpolation_set",
    "invoke_keyframe_temporal_ease_set",
    "invoke_keyframe_value_set",
]
