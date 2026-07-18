"""Strict Core contracts for the Layer Timeline / Hierarchy native package.

The public handlers select these eight AEGP capabilities explicitly.  This
module does not choose between native and JSX implementations and never accepts
raw source.  Every write verifies a typed readback and remains bound to the
existing native audit / Undo contract.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from typing import Annotated, Any, Literal, Mapping, TypeVar

from pydantic import Field, StrictBool, StrictInt, StrictStr, ValidationError, model_validator

from ae_mcp.backends.native import (
    NativeBackendError,
    NativeCancellationToken,
    NativeCapabilityDescriptor,
    NativeInvokeBackend,
    NativeLocator,
    NativeNegotiation,
    NonNegativeInt,
    PositiveInt,
    RequestId,
    _NativeModel,
    _invoke_native_read_request,
    _structured_error,
)
from ae_mcp.backends.native_project_composition import (
    BoundedName,
    CAPABILITY_VERSION,
    CapabilityContract,
    ExactTime,
    ExactTimeInput,
    IdempotencyKey,
    PositiveTimeInput,
    _IDEMPOTENCY_SCHEMA,
    _ReadExecution,
    _WriteExecution,
    _bounded_unicode,
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
_SIGNED_RATIO = r"^-?[1-9][0-9]*(?:/[1-9][0-9]*)?$"
_LAYER_TYPES = ("av", "camera", "light", "text", "shape", "model3d", "null", "adjustment", "unknown")


class LayerStretchInput(_NativeModel):
    """Exact AEGP A_Ratio, where 1/1 means 100 percent stretch."""

    num: Annotated[StrictInt, Field(ge=-2_147_483_648, le=2_147_483_647)]
    den: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]

    @model_validator(mode="after")
    def _nonzero(self) -> "LayerStretchInput":
        if self.num == 0:
            raise ValueError("layer stretch numerator must be non-zero")
        return self


class LayerSignedRatio(_NativeModel):
    numerator: Annotated[StrictInt, Field(ge=-2_147_483_648, le=2_147_483_647)]
    denominator: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]
    rational: Annotated[StrictStr, Field(min_length=1, max_length=29, pattern=_SIGNED_RATIO)]

    @model_validator(mode="after")
    def _canonical(self) -> "LayerSignedRatio":
        if self.numerator == 0:
            raise ValueError("layer stretch numerator must be non-zero")
        divisor = math.gcd(abs(self.numerator), self.denominator)
        numerator = self.numerator // divisor
        denominator = self.denominator // divisor
        expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
        if self.rational != expected:
            raise ValueError("rational is not the reduced numerator/denominator")
        return self


def stretch_percent_to_ratio(stretch_percent: str) -> LayerStretchInput:
    """Convert an already-validated public percentage to an exact A_Ratio."""

    ratio = Fraction(Decimal(stretch_percent)) / 100
    return LayerStretchInput(num=ratio.numerator, den=ratio.denominator)


class LayerDetailsArguments(_NativeModel):
    layer_locator: NativeLocator

    @model_validator(mode="after")
    def _layer_kind(self) -> "LayerDetailsArguments":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must identify a layer")
        return self


class LayerDetailsValue(_NativeModel):
    layer_locator: NativeLocator
    composition_locator: NativeLocator
    stack_index: PositiveInt
    name: Annotated[StrictStr, Field(max_length=1024)]
    type: Literal["av", "camera", "light", "text", "shape", "model3d", "null", "adjustment", "unknown"]
    video_enabled: StrictBool
    is_three_d: StrictBool
    locked: StrictBool
    parent_locator: NativeLocator | None
    source_item_locator: NativeLocator | None
    in_point: ExactTime
    duration: ExactTime
    start_time: ExactTime
    stretch: LayerSignedRatio

    @model_validator(mode="after")
    def _coherent_details(self) -> "LayerDetailsValue":
        layer = self.layer_locator
        composition = self.composition_locator
        if layer.kind != "layer" or composition.kind != "composition":
            raise ValueError("layer details require layer and composition locators")
        if layer.context() != composition.context():
            raise ValueError("layer details locators escaped the current graph context")
        for locator, kinds, field in (
            (self.parent_locator, {"layer"}, "parentLocator"),
            (self.source_item_locator, {"item", "composition"}, "sourceItemLocator"),
        ):
            if locator is not None and (locator.kind not in kinds or locator.context() != layer.context()):
                raise ValueError(f"{field} escaped the layer graph context")
        if self.parent_locator is not None and self.parent_locator.object_id == layer.object_id:
            raise ValueError("a layer cannot parent itself")
        _bounded_unicode(self.name, field="name", allow_empty=True)
        return self


class _LayerWriteArguments(_NativeModel):
    layer_locator: NativeLocator
    idempotency_key: IdempotencyKey

    @model_validator(mode="after")
    def _layer_kind(self) -> "_LayerWriteArguments":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must identify a layer")
        return self


class LayerNameSetArguments(_LayerWriteArguments):
    name: BoundedName

    @model_validator(mode="after")
    def _valid_name(self) -> "LayerNameSetArguments":
        _bounded_unicode(self.name, field="name", allow_empty=False)
        return self


class LayerRangeSetArguments(_LayerWriteArguments):
    in_point: ExactTimeInput
    duration: PositiveTimeInput


class LayerStartTimeSetArguments(_LayerWriteArguments):
    start_time: ExactTimeInput


class LayerStretchSetArguments(_LayerWriteArguments):
    stretch: LayerStretchInput


class LayerOrderSetArguments(_LayerWriteArguments):
    target_stack_index: PositiveInt


class LayerParentSetArguments(_LayerWriteArguments):
    parent_layer_locator: NativeLocator | None

    @model_validator(mode="after")
    def _valid_parent(self) -> "LayerParentSetArguments":
        parent = self.parent_layer_locator
        if parent is None:
            return self
        if parent.kind != "layer" or parent.context() != self.layer_locator.context():
            raise ValueError("parentLayerLocator must identify a layer in the same graph context")
        if parent.object_id == self.layer_locator.object_id:
            raise ValueError("a layer cannot parent itself")
        return self


class LayerDuplicateArguments(_LayerWriteArguments):
    new_name: BoundedName

    @model_validator(mode="after")
    def _valid_name(self) -> "LayerDuplicateArguments":
        _bounded_unicode(self.new_name, field="newName", allow_empty=False)
        return self


class LayerNameSetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_name: Annotated[StrictStr, Field(max_length=1024)]
    after_name: BoundedName

    @model_validator(mode="after")
    def _transition(self) -> "LayerNameSetValue":
        _require_layer(self.layer_locator)
        _bounded_unicode(self.after_name, field="afterName", allow_empty=False)
        if self.before_name == self.after_name:
            raise ValueError("layer name did not change")
        return self


class LayerRangeSetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_in_point: ExactTime
    before_duration: ExactTime
    after_in_point: ExactTime
    after_duration: ExactTime

    @model_validator(mode="after")
    def _transition(self) -> "LayerRangeSetValue":
        _require_layer(self.layer_locator)
        if _times_equal(self.before_in_point, self.after_in_point) and _times_equal(self.before_duration, self.after_duration):
            raise ValueError("layer range did not change")
        return self


class LayerStartTimeSetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_start_time: ExactTime
    after_start_time: ExactTime

    @model_validator(mode="after")
    def _transition(self) -> "LayerStartTimeSetValue":
        _require_layer(self.layer_locator)
        if _times_equal(self.before_start_time, self.after_start_time):
            raise ValueError("layer start time did not change")
        return self


class LayerStretchSetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_stretch: LayerSignedRatio
    after_stretch: LayerSignedRatio

    @model_validator(mode="after")
    def _transition(self) -> "LayerStretchSetValue":
        _require_layer(self.layer_locator)
        if _ratios_equal(self.before_stretch, self.after_stretch):
            raise ValueError("layer stretch did not change")
        return self


class LayerOrderSetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_stack_index: PositiveInt
    after_stack_index: PositiveInt

    @model_validator(mode="after")
    def _transition(self) -> "LayerOrderSetValue":
        _require_layer(self.layer_locator)
        if self.before_stack_index == self.after_stack_index:
            raise ValueError("layer order did not change")
        return self


class LayerParentSetValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    before_parent_locator: NativeLocator | None
    after_parent_locator: NativeLocator | None

    @model_validator(mode="after")
    def _transition(self) -> "LayerParentSetValue":
        _require_layer(self.layer_locator)
        for locator in (self.before_parent_locator, self.after_parent_locator):
            if locator is not None and (
                locator.kind != "layer"
                or locator.context() != self.layer_locator.context()
                or locator.object_id == self.layer_locator.object_id
            ):
                raise ValueError("parent locator is not bound to the layer context")
        if self.before_parent_locator == self.after_parent_locator:
            raise ValueError("layer parent did not change")
        return self


class LayerDuplicateValue(_NativeModel):
    changed: Literal[True]
    source_layer_locator: NativeLocator
    new_layer_locator: NativeLocator
    composition_locator: NativeLocator
    layer_count_before: NonNegativeInt
    layer_count_after: PositiveInt
    new_layer: LayerDetailsValue

    @model_validator(mode="after")
    def _verified_duplicate(self) -> "LayerDuplicateValue":
        source = self.source_layer_locator
        created = self.new_layer_locator
        composition = self.composition_locator
        if source.kind != "layer" or created.kind != "layer" or composition.kind != "composition":
            raise ValueError("duplicate returned invalid locator kinds")
        if source.context() != created.context() or source.context() != composition.context():
            raise ValueError("duplicate locators do not share one fresh graph context")
        if source.object_id == created.object_id:
            raise ValueError("duplicate must return a distinct layer locator")
        if self.new_layer.layer_locator != created or self.new_layer.composition_locator != composition:
            raise ValueError("newLayer is not bound to the duplicate locators")
        if self.layer_count_after != self.layer_count_before + 1:
            raise ValueError("duplicate must add exactly one layer")
        return self


def _require_layer(locator: NativeLocator) -> None:
    if locator.kind != "layer":
        raise ValueError("layerLocator must identify a layer")


def _ratios_equal(left: LayerSignedRatio | LayerStretchInput, right: LayerSignedRatio | LayerStretchInput) -> bool:
    left_num = left.numerator if isinstance(left, LayerSignedRatio) else left.num
    left_den = left.denominator if isinstance(left, LayerSignedRatio) else left.den
    right_num = right.numerator if isinstance(right, LayerSignedRatio) else right.num
    right_den = right.denominator if isinstance(right, LayerSignedRatio) else right.den
    return left_num * right_den == right_num * left_den


def _duplicate_semantics_equal(source: LayerDetailsValue, created: LayerDetailsValue) -> bool:
    """Compare the state AE Duplicate Layer is required to preserve.

    Identity, name, and stack position intentionally differ.  Every other
    user-visible layer/timeline relationship must be the same in the fresh
    post-mutation graph.
    """

    return (
        source.composition_locator == created.composition_locator
        and source.type == created.type
        and source.video_enabled == created.video_enabled
        and source.is_three_d == created.is_three_d
        and source.locked == created.locked
        and source.parent_locator == created.parent_locator
        and source.source_item_locator == created.source_item_locator
        and _times_equal(source.in_point, created.in_point)
        and _times_equal(source.duration, created.duration)
        and _times_equal(source.start_time, created.start_time)
        and _ratios_equal(source.stretch, created.stretch)
    )


class LayerDetailsExecution(_ReadExecution):
    value: LayerDetailsValue


class LayerNameSetExecution(_WriteExecution):
    value: LayerNameSetValue


class LayerRangeSetExecution(_WriteExecution):
    value: LayerRangeSetValue


class LayerStartTimeSetExecution(_WriteExecution):
    value: LayerStartTimeSetValue


class LayerStretchSetExecution(_WriteExecution):
    value: LayerStretchSetValue


class LayerOrderSetExecution(_WriteExecution):
    value: LayerOrderSetValue


class LayerParentSetExecution(_WriteExecution):
    value: LayerParentSetValue


class LayerDuplicateExecution(_WriteExecution):
    value: LayerDuplicateValue


LAYER_DETAILS_READ_CAPABILITY_ID = "ae.layer.details.read"
LAYER_NAME_SET_CAPABILITY_ID = "ae.layer.name.set"
LAYER_RANGE_SET_CAPABILITY_ID = "ae.layer.range.set"
LAYER_START_TIME_SET_CAPABILITY_ID = "ae.layer.start-time.set"
LAYER_STRETCH_SET_CAPABILITY_ID = "ae.layer.stretch.set"
LAYER_ORDER_SET_CAPABILITY_ID = "ae.layer.order.set"
LAYER_PARENT_SET_CAPABILITY_ID = "ae.layer.parent.set"
LAYER_DUPLICATE_CAPABILITY_ID = "ae.layer.duplicate"


def _signed_ratio_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["numerator", "denominator", "rational"],
        "properties": {
            "numerator": {"type": "integer", "minimum": -2_147_483_648, "maximum": 2_147_483_647, "not": {"const": 0}},
            "denominator": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
            "rational": {"type": "string", "minLength": 1, "maxLength": 29, "pattern": _SIGNED_RATIO},
        },
        "x-invariant": "rational-is-the-reduced-canonical-form-of-numerator-over-denominator",
    }


def _nullable_locator_schema(*kinds: str) -> dict[str, Any]:
    return {"oneOf": [{"type": "null"}, _locator_schema(*kinds)]}


def _layer_details_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "layerLocator", "compositionLocator", "stackIndex", "name", "type",
            "videoEnabled", "isThreeD", "locked", "parentLocator", "sourceItemLocator",
            "inPoint", "duration", "startTime", "stretch",
        ],
        "properties": {
            "layerLocator": _locator_schema("layer"),
            "compositionLocator": _locator_schema("composition"),
            "stackIndex": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
            "name": {"type": "string", "maxLength": 1024},
            "type": {"enum": list(_LAYER_TYPES)},
            "videoEnabled": {"type": "boolean"},
            "isThreeD": {"type": "boolean"},
            "locked": {"type": "boolean"},
            "parentLocator": _nullable_locator_schema("layer"),
            "sourceItemLocator": _nullable_locator_schema("item", "composition"),
            "inPoint": _exact_time_schema(),
            "duration": _exact_time_schema(),
            "startTime": _exact_time_schema(),
            "stretch": _signed_ratio_schema(),
        },
        "x-invariant": "all-locators-share-one-current-graph-context",
    }


def _layer_write_input(value_name: str, value_schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["layerLocator", value_name, "idempotencyKey"],
        "properties": {
            "layerLocator": _locator_schema("layer"),
            value_name: value_schema,
            "idempotencyKey": _IDEMPOTENCY_SCHEMA,
        },
    }


def _layer_write_result(before_name: str, after_name: str, value_schema: dict[str, Any], invariant: str) -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["changed", "layerLocator", before_name, after_name],
        "properties": {
            "changed": {"const": True},
            "layerLocator": _locator_schema("layer"),
            before_name: value_schema,
            after_name: value_schema,
        },
        "x-invariant": invariant,
    }


_NAME_SCHEMA = {"type": "string", "minLength": 1, "maxLength": 255}
_LAYER_DETAILS_INPUT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["layerLocator"],
    "properties": {"layerLocator": _locator_schema("layer")},
}
_LAYER_DETAILS_RESULT_SCHEMA = _layer_details_schema()
_LAYER_NAME_INPUT_SCHEMA = _layer_write_input("name", _NAME_SCHEMA)
_LAYER_NAME_RESULT_SCHEMA = _layer_write_result(
    "beforeName", "afterName", _NAME_SCHEMA,
    "afterName-equals-request-and-differs-from-beforeName",
)
_LAYER_NAME_RESULT_SCHEMA["properties"]["beforeName"] = {"type": "string", "maxLength": 1024}
_LAYER_RANGE_INPUT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["layerLocator", "inPoint", "duration", "idempotencyKey"],
    "properties": {
        "layerLocator": _locator_schema("layer"),
        "inPoint": _time_input_schema(),
        "duration": _time_input_schema(positive=True),
        "idempotencyKey": _IDEMPOTENCY_SCHEMA,
    },
}
_LAYER_RANGE_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["changed", "layerLocator", "beforeInPoint", "beforeDuration", "afterInPoint", "afterDuration"],
    "properties": {
        "changed": {"const": True}, "layerLocator": _locator_schema("layer"),
        "beforeInPoint": _exact_time_schema(), "beforeDuration": _exact_time_schema(),
        "afterInPoint": _exact_time_schema(), "afterDuration": _exact_time_schema(),
    },
    "x-invariant": "after-range-equals-request-and-differs-from-before-range",
}
_LAYER_START_INPUT_SCHEMA = _layer_write_input("startTime", _time_input_schema())
_LAYER_START_RESULT_SCHEMA = _layer_write_result(
    "beforeStartTime", "afterStartTime", _exact_time_schema(),
    "afterStartTime-equals-request-and-differs-from-beforeStartTime",
)
_STRETCH_INPUT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["num", "den"],
    "properties": {
        "num": {"type": "integer", "minimum": -2_147_483_648, "maximum": 2_147_483_647, "not": {"const": 0}},
        "den": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
    },
}
_LAYER_STRETCH_INPUT_SCHEMA = _layer_write_input("stretch", _STRETCH_INPUT_SCHEMA)
_LAYER_STRETCH_RESULT_SCHEMA = _layer_write_result(
    "beforeStretch", "afterStretch", _signed_ratio_schema(),
    "afterStretch-equals-request-and-differs-from-beforeStretch",
)
_STACK_INDEX_SCHEMA = {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX}
_LAYER_ORDER_INPUT_SCHEMA = _layer_write_input("targetStackIndex", _STACK_INDEX_SCHEMA)
_LAYER_ORDER_RESULT_SCHEMA = _layer_write_result(
    "beforeStackIndex", "afterStackIndex", _STACK_INDEX_SCHEMA,
    "afterStackIndex-equals-request-and-differs-from-beforeStackIndex",
)
_NULLABLE_LAYER_SCHEMA = _nullable_locator_schema("layer")
_LAYER_PARENT_INPUT_SCHEMA = _layer_write_input("parentLayerLocator", _NULLABLE_LAYER_SCHEMA)
_LAYER_PARENT_RESULT_SCHEMA = _layer_write_result(
    "beforeParentLocator", "afterParentLocator", _NULLABLE_LAYER_SCHEMA,
    "afterParentLocator-equals-request-and-differs-from-beforeParentLocator",
)
_LAYER_DUPLICATE_INPUT_SCHEMA = _layer_write_input("newName", _NAME_SCHEMA)
_LAYER_DUPLICATE_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": [
        "changed", "sourceLayerLocator", "newLayerLocator", "compositionLocator",
        "layerCountBefore", "layerCountAfter", "newLayer",
    ],
    "properties": {
        "changed": {"const": True},
        "sourceLayerLocator": _locator_schema("layer"),
        "newLayerLocator": _locator_schema("layer"),
        "compositionLocator": _locator_schema("composition"),
        "layerCountBefore": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "layerCountAfter": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
        "newLayer": _layer_details_schema(),
    },
    "x-invariant": "fresh-locators-share-one-post-mutation-generation;new-layer-locator-matches-newLayer;layerCountAfter-equals-layerCountBefore-plus-one",
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


_OPEN_PROJECT = "An After Effects project must be open."

_SPECS = (
    _ContractSpec(
        LAYER_DETAILS_READ_CAPABILITY_ID,
        "Read one After Effects layer and its exact timeline state.",
        "read", "idempotent",
        "Reads layer state without changing After Effects state.",
        (_OPEN_PROJECT, "layerLocator must come from a current native layer listing."),
        "aemcp.requirement.native.layer-details-read",
        _LAYER_DETAILS_INPUT_SCHEMA, _LAYER_DETAILS_RESULT_SCHEMA, "layer-details-read",
    ),
    _ContractSpec(
        LAYER_NAME_SET_CAPABILITY_ID,
        "Rename one After Effects layer.",
        "write", "idempotency-key",
        "Changes one layer name and creates one After Effects Undo step.",
        ("layerLocator must be current.", "name must differ from the current name."),
        "aemcp.requirement.native.layer-name-set",
        _LAYER_NAME_INPUT_SCHEMA, _LAYER_NAME_RESULT_SCHEMA, "layer-name-set",
    ),
    _ContractSpec(
        LAYER_RANGE_SET_CAPABILITY_ID,
        "Set one layer in point and duration using exact rational time.",
        "write", "idempotency-key",
        "Changes one layer range and creates one After Effects Undo step.",
        ("layerLocator must be current.", "The range must fit the composition and differ from the current range."),
        "aemcp.requirement.native.layer-range-set",
        _LAYER_RANGE_INPUT_SCHEMA, _LAYER_RANGE_RESULT_SCHEMA, "layer-range-set",
    ),
    _ContractSpec(
        LAYER_START_TIME_SET_CAPABILITY_ID,
        "Set one layer start time using exact rational time.",
        "write", "idempotency-key",
        "Changes one layer start time and creates one After Effects Undo step.",
        ("layerLocator must be current.", "startTime must differ from the current start time."),
        "aemcp.requirement.native.layer-start-time-set",
        _LAYER_START_INPUT_SCHEMA, _LAYER_START_RESULT_SCHEMA, "layer-start-time-set",
    ),
    _ContractSpec(
        LAYER_STRETCH_SET_CAPABILITY_ID,
        "Set one layer stretch as an exact signed ratio.",
        "write", "idempotency-key",
        "Changes one layer stretch and creates one After Effects Undo step.",
        ("layerLocator must be current.", "stretch must be nonzero and differ from the current stretch."),
        "aemcp.requirement.native.layer-stretch-set",
        _LAYER_STRETCH_INPUT_SCHEMA, _LAYER_STRETCH_RESULT_SCHEMA, "layer-stretch-set",
    ),
    _ContractSpec(
        LAYER_ORDER_SET_CAPABILITY_ID,
        "Move one layer to an explicit composition stack index.",
        "write", "idempotency-key",
        "Changes one layer stack position and creates one After Effects Undo step.",
        ("layerLocator must be current.", "targetStackIndex must exist and differ from the current stack index."),
        "aemcp.requirement.native.layer-order-set",
        _LAYER_ORDER_INPUT_SCHEMA, _LAYER_ORDER_RESULT_SCHEMA, "layer-order-set",
    ),
    _ContractSpec(
        LAYER_PARENT_SET_CAPABILITY_ID,
        "Set or clear one layer parent.",
        "write", "idempotency-key",
        "Changes one layer parent and creates one After Effects Undo step.",
        (
            "Both locators must be current and in the same composition.",
            "A layer cannot parent itself and the requested parent must differ from the current parent.",
        ),
        "aemcp.requirement.native.layer-parent-set",
        _LAYER_PARENT_INPUT_SCHEMA, _LAYER_PARENT_RESULT_SCHEMA, "layer-parent-set",
    ),
    _ContractSpec(
        LAYER_DUPLICATE_CAPABILITY_ID,
        "Duplicate one layer with an explicit new name.",
        "write", "idempotency-key",
        "Adds one layer and creates one After Effects Undo step.",
        ("layerLocator must be current.",),
        "aemcp.requirement.native.layer-duplicate",
        _LAYER_DUPLICATE_INPUT_SCHEMA, _LAYER_DUPLICATE_RESULT_SCHEMA, "layer-duplicate",
    ),
)

CAPABILITY_CONTRACTS = {spec.capability_id: spec.contract() for spec in _SPECS}


async def invoke_layer_details_read(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> LayerDetailsExecution:
    arguments = LayerDetailsArguments(layer_locator=layer_locator)
    contract = CAPABILITY_CONTRACTS[LAYER_DETAILS_READ_CAPABILITY_ID]
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=contract.capability_id,
        capability_version=CAPABILITY_VERSION,
        arguments=arguments.model_dump(mode="json", by_alias=True),
        locator=arguments.layer_locator,
        locator_field="params.arguments.layerLocator",
        stale_locator_hint="Call ae_listCompositionLayers and copy a fresh layer_locator.",
        descriptor_validator=_descriptor_validator(contract),
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = LayerDetailsValue.model_validate(result.value)
        digest = _value_digest(contract.capability_id, value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native layer details did not match the typed contract.") from exc
    if (
        value.layer_locator != arguments.layer_locator
        or result.evidence.postcondition.kind != contract.postcondition_kind
        or result.evidence.postcondition.digest != digest
    ):
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native layer details were not bound to the request and evidence.")
    return LayerDetailsExecution(implementation=descriptor, negotiation=negotiation, value=value, evidence=result.evidence)


ValueT = TypeVar("ValueT", bound=_NativeModel)


async def _invoke_layer_write(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    contract: CapabilityContract,
    arguments: _LayerWriteArguments,
    value_model: type[ValueT],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
    allow_replay: bool = False,
) -> tuple[NativeNegotiation, NativeCapabilityDescriptor, RequestId, Any, ValueT]:
    hint = "Read fresh layer details and inspect the Undo stack before issuing another layer write."
    negotiation, descriptor, request, result = await _invoke_package_write_request(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=arguments,
        locator=arguments.layer_locator,
        locator_field="params.arguments.layerLocator",
        allow_replay=allow_replay,
        inspect_hint=hint,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    value = _validate_write_value(contract=contract, result=result, value_model=value_model, inspect_hint=hint)
    return negotiation, descriptor, request.request_id, result, value


def _write_execution(
    execution_type: type[_WriteExecution],
    *,
    descriptor: NativeCapabilityDescriptor,
    negotiation: NativeNegotiation,
    request_id: str,
    arguments: _LayerWriteArguments,
    result: Any,
    value: _NativeModel,
) -> _WriteExecution:
    return execution_type(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=request_id,
        idempotency_key=arguments.idempotency_key,
        replayed=result.replayed,
        value=value,
        evidence=result.evidence,
    )


def _possibly_side_effecting(message: str, capability_id: str) -> NativeBackendError:
    from ae_mcp.backends.native import NativeRecovery

    return NativeBackendError(
        "POSSIBLY_SIDE_EFFECTING_FAILURE",
        message,
        retryable=False,
        side_effect="may-have-occurred",
        recovery=NativeRecovery(
            action="inspect-state",
            hint="Read fresh layer details and inspect the Undo stack before issuing another layer write.",
        ),
        details={"capabilityId": capability_id},
    )


async def invoke_layer_name_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], name: str, idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> LayerNameSetExecution:
    arguments = LayerNameSetArguments(layer_locator=layer_locator, name=name, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[LAYER_NAME_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_layer_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerNameSetValue, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if value.layer_locator != arguments.layer_locator or value.after_name != arguments.name:
        raise _possibly_side_effecting("Native layer name readback did not match the requested value.", contract.capability_id)
    return _write_execution(LayerNameSetExecution, descriptor=descriptor, negotiation=negotiation, request_id=transport_id, arguments=arguments, result=result, value=value)  # type: ignore[return-value]


async def invoke_layer_range_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], in_point: Mapping[str, Any], duration: Mapping[str, Any],
    idempotency_key: str, deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> LayerRangeSetExecution:
    arguments = LayerRangeSetArguments(layer_locator=layer_locator, in_point=in_point, duration=duration, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[LAYER_RANGE_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_layer_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerRangeSetValue, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if (
        value.layer_locator != arguments.layer_locator
        or not _times_equal(value.after_in_point, arguments.in_point)
        or not _times_equal(value.after_duration, arguments.duration)
    ):
        raise _possibly_side_effecting("Native layer range readback did not match the requested value.", contract.capability_id)
    return _write_execution(LayerRangeSetExecution, descriptor=descriptor, negotiation=negotiation, request_id=transport_id, arguments=arguments, result=result, value=value)  # type: ignore[return-value]


async def invoke_layer_start_time_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], start_time: Mapping[str, Any], idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> LayerStartTimeSetExecution:
    arguments = LayerStartTimeSetArguments(layer_locator=layer_locator, start_time=start_time, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[LAYER_START_TIME_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_layer_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerStartTimeSetValue, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if value.layer_locator != arguments.layer_locator or not _times_equal(value.after_start_time, arguments.start_time):
        raise _possibly_side_effecting("Native layer start-time readback did not match the requested value.", contract.capability_id)
    return _write_execution(LayerStartTimeSetExecution, descriptor=descriptor, negotiation=negotiation, request_id=transport_id, arguments=arguments, result=result, value=value)  # type: ignore[return-value]


async def invoke_layer_stretch_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], stretch: LayerStretchInput | Mapping[str, Any],
    idempotency_key: str, deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> LayerStretchSetExecution:
    arguments = LayerStretchSetArguments(layer_locator=layer_locator, stretch=stretch, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[LAYER_STRETCH_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_layer_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerStretchSetValue, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if value.layer_locator != arguments.layer_locator or not _ratios_equal(value.after_stretch, arguments.stretch):
        raise _possibly_side_effecting("Native layer stretch readback did not match the requested value.", contract.capability_id)
    return _write_execution(LayerStretchSetExecution, descriptor=descriptor, negotiation=negotiation, request_id=transport_id, arguments=arguments, result=result, value=value)  # type: ignore[return-value]


async def invoke_layer_order_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], target_stack_index: int, idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> LayerOrderSetExecution:
    arguments = LayerOrderSetArguments(layer_locator=layer_locator, target_stack_index=target_stack_index, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[LAYER_ORDER_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_layer_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerOrderSetValue, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if value.layer_locator != arguments.layer_locator or value.after_stack_index != arguments.target_stack_index:
        raise _possibly_side_effecting("Native layer order readback did not match the requested value.", contract.capability_id)
    return _write_execution(LayerOrderSetExecution, descriptor=descriptor, negotiation=negotiation, request_id=transport_id, arguments=arguments, result=result, value=value)  # type: ignore[return-value]


async def invoke_layer_parent_set(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], parent_layer_locator: NativeLocator | Mapping[str, Any] | None,
    idempotency_key: str, deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> LayerParentSetExecution:
    arguments = LayerParentSetArguments(
        layer_locator=layer_locator, parent_layer_locator=parent_layer_locator, idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[LAYER_PARENT_SET_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_layer_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerParentSetValue, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    if value.layer_locator != arguments.layer_locator or value.after_parent_locator != arguments.parent_layer_locator:
        raise _possibly_side_effecting("Native layer parent readback did not match the requested value.", contract.capability_id)
    return _write_execution(LayerParentSetExecution, descriptor=descriptor, negotiation=negotiation, request_id=transport_id, arguments=arguments, result=result, value=value)  # type: ignore[return-value]


async def invoke_layer_duplicate(
    backend: NativeInvokeBackend, *, request_id: str,
    layer_locator: NativeLocator | Mapping[str, Any], new_name: str, idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> LayerDuplicateExecution:
    arguments = LayerDuplicateArguments(layer_locator=layer_locator, new_name=new_name, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[LAYER_DUPLICATE_CAPABILITY_ID]
    negotiation, descriptor, transport_id, result, value = await _invoke_layer_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=LayerDuplicateValue, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
        allow_replay=True,
    )
    source = value.source_layer_locator
    original = arguments.layer_locator
    valid_identity = (
        source.object_id == original.object_id
        and source.host_instance_id == original.host_instance_id
        and source.session_id == original.session_id
        and source.project_id != original.project_id
        and source.generation > original.generation
        and value.new_layer.name == arguments.new_name
    )
    if not valid_identity:
        raise _possibly_side_effecting("Native duplicate identity did not match the requested source and name.", contract.capability_id)
    try:
        source_read = await invoke_layer_details_read(
            backend,
            request_id="source-check-" + hashlib.sha256(request_id.encode("utf-8")).hexdigest()[:32],
            layer_locator=value.source_layer_locator,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
    except NativeBackendError as exc:
        raise _possibly_side_effecting(
            "The duplicate committed, but the fresh source layer could not be verified.",
            contract.capability_id,
        ) from exc
    if not _duplicate_semantics_equal(source_read.value, value.new_layer):
        raise _possibly_side_effecting(
            "The duplicate committed, but its stable layer semantics did not match the source.",
            contract.capability_id,
        )
    if result.replayed:
        try:
            replay = await invoke_layer_details_read(
                backend,
                request_id="replay-check-" + hashlib.sha256(request_id.encode("utf-8")).hexdigest()[:32],
                layer_locator=value.new_layer_locator,
                deadline_unix_ms=deadline_unix_ms,
                cancellation=cancellation,
            )
        except NativeBackendError as exc:
            raise _structured_error(
                "DUPLICATE_REQUEST",
                "The committed duplicate key no longer identifies a verifiable layer.",
                details={"field": "params.arguments.idempotencyKey", "capabilityId": contract.capability_id},
                recovery_hint="Refresh the layer list and inspect the composition before issuing another duplicate.",
            ) from exc
        if replay.value != value.new_layer:
            raise _structured_error(
                "DUPLICATE_REQUEST",
                "The committed duplicate key no longer matches the current layer state.",
                details={"field": "params.arguments.idempotencyKey", "capabilityId": contract.capability_id},
                recovery_hint="Refresh the layer list and inspect the composition before issuing another duplicate.",
            )
    return _write_execution(LayerDuplicateExecution, descriptor=descriptor, negotiation=negotiation, request_id=transport_id, arguments=arguments, result=result, value=value)  # type: ignore[return-value]


__all__ = [
    "CAPABILITY_CONTRACTS",
    "LAYER_DETAILS_READ_CAPABILITY_ID",
    "LAYER_DUPLICATE_CAPABILITY_ID",
    "LAYER_NAME_SET_CAPABILITY_ID",
    "LAYER_ORDER_SET_CAPABILITY_ID",
    "LAYER_PARENT_SET_CAPABILITY_ID",
    "LAYER_RANGE_SET_CAPABILITY_ID",
    "LAYER_START_TIME_SET_CAPABILITY_ID",
    "LAYER_STRETCH_SET_CAPABILITY_ID",
    "LayerDetailsExecution",
    "LayerDetailsValue",
    "LayerDuplicateExecution",
    "LayerNameSetExecution",
    "LayerOrderSetExecution",
    "LayerParentSetExecution",
    "LayerRangeSetExecution",
    "LayerSignedRatio",
    "LayerStartTimeSetExecution",
    "LayerStretchInput",
    "LayerStretchSetExecution",
    "invoke_layer_details_read",
    "invoke_layer_duplicate",
    "invoke_layer_name_set",
    "invoke_layer_order_set",
    "invoke_layer_parent_set",
    "invoke_layer_range_set",
    "invoke_layer_start_time_set",
    "invoke_layer_stretch_set",
    "stretch_percent_to_ratio",
]
