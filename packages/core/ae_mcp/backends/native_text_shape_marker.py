"""Strict Core/native contracts for the frozen Shape and Marker tools."""

from __future__ import annotations

import math
from decimal import Decimal, InvalidOperation
from math import gcd
from typing import Annotated, Any, Literal, Mapping

from pydantic import Field, StrictBool, StrictInt, StrictStr, model_validator

from ae_mcp.backends.native import (
    DecimalString,
    NativeBackendError,
    NativeCancellationToken,
    NativeInvokeBackend,
    NativeLocator,
    NonNegativeInt,
    PositiveInt,
    SignedInt32,
    UnsignedInt32,
    _NativeModel,
    _invoke_native_read_request,
    _structured_error,
)
from ae_mcp.backends.native_project_composition import (
    CAPABILITY_VERSION,
    CapabilityContract,
    IdempotencyKey,
    _ReadExecution,
    _WriteExecution,
    _descriptor_validator,
    _invoke_package_write_request,
    _validate_write_value,
    _value_digest,
)


SAFE_MAX = 9_007_199_254_740_991
ShapeCapabilityId = Literal[
    "ae.shape.layer.create",
    "ae.shape.groups.list",
    "ae.shape.group.create",
    "ae.shape.path.set",
    "ae.shape.fill-style.set",
    "ae.shape.stroke-style.set",
    "ae.shape.group.reorder",
]
MarkerCapabilityId = Literal[
    "ae.marker.list",
    "ae.marker.create",
    "ae.marker.set",
    "ae.marker.delete",
]


class Color8(_NativeModel):
    red: Annotated[StrictInt, Field(ge=0, le=255)]
    green: Annotated[StrictInt, Field(ge=0, le=255)]
    blue: Annotated[StrictInt, Field(ge=0, le=255)]
    alpha: Annotated[StrictInt, Field(ge=0, le=255)]


class BezierVertex(_NativeModel):
    position: tuple[DecimalString, DecimalString]
    in_tangent: tuple[DecimalString, DecimalString]
    out_tangent: tuple[DecimalString, DecimalString]

    @model_validator(mode="after")
    def finite_coordinates(self) -> "BezierVertex":
        for text in (*self.position, *self.in_tangent, *self.out_tangent):
            _bounded_decimal(text, minimum=None, maximum=None)
        return self


class BezierPath(_NativeModel):
    closed: StrictBool
    vertices: tuple[BezierVertex, ...] = Field(min_length=2, max_length=128)

    @model_validator(mode="after")
    def valid_topology(self) -> "BezierPath":
        if self.closed and len(self.vertices) < 3:
            raise ValueError("a closed Bezier path requires at least three vertices")
        return self


class ShapeGroupRef(_NativeModel):
    layer_locator: NativeLocator
    group_index: PositiveInt
    stream_id: SignedInt32

    @model_validator(mode="after")
    def layer_kind(self) -> "ShapeGroupRef":
        if self.layer_locator.kind != "layer":
            raise ValueError("layerLocator must identify a layer")
        return self


class ShapeFill(_NativeModel):
    enabled: StrictBool
    color: Color8
    opacity_percent: DecimalString

    @model_validator(mode="after")
    def valid_opacity(self) -> "ShapeFill":
        _bounded_decimal(
            self.opacity_percent, minimum=Decimal(0), maximum=Decimal(100)
        )
        return self


class ShapeStroke(_NativeModel):
    enabled: StrictBool
    color: Color8
    opacity_percent: DecimalString
    width_pixels: DecimalString
    stroke_over_fill: StrictBool

    @model_validator(mode="after")
    def valid_values(self) -> "ShapeStroke":
        _bounded_decimal(
            self.opacity_percent, minimum=Decimal(0), maximum=Decimal(100)
        )
        _bounded_decimal(
            self.width_pixels, minimum=Decimal(0), maximum=Decimal(1000)
        )
        return self


class ShapeGroup(_NativeModel):
    ref: ShapeGroupRef
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    path: BezierPath
    fill: ShapeFill
    stroke: ShapeStroke


class ShapeLayerCreateArguments(_NativeModel):
    composition_locator: NativeLocator
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    idempotency_key: IdempotencyKey


class ShapeGroupsListArguments(_NativeModel):
    layer_locator: NativeLocator
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]


class ShapeGroupCreateArguments(_NativeModel):
    layer_locator: NativeLocator
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    path: BezierPath
    fill: ShapeFill
    stroke: ShapeStroke
    idempotency_key: IdempotencyKey


class ShapePathSetArguments(_NativeModel):
    group_ref: ShapeGroupRef
    path: BezierPath
    idempotency_key: IdempotencyKey


class ShapeFillStyleSetArguments(_NativeModel):
    group_ref: ShapeGroupRef
    fill: ShapeFill
    idempotency_key: IdempotencyKey


class ShapeStrokeStyleSetArguments(_NativeModel):
    group_ref: ShapeGroupRef
    stroke: ShapeStroke
    idempotency_key: IdempotencyKey


class ShapeGroupReorderArguments(_NativeModel):
    group_ref: ShapeGroupRef
    target_index: PositiveInt
    idempotency_key: IdempotencyKey


class ShapeLayerCreateValue(_NativeModel):
    changed: Literal[True]
    composition_locator: NativeLocator
    layer_locator: NativeLocator
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    stack_index: PositiveInt
    layer_count_before: NonNegativeInt
    layer_count_after: PositiveInt

    @model_validator(mode="after")
    def verified_counts(self) -> "ShapeLayerCreateValue":
        if (
            self.composition_locator.kind != "composition"
            or self.layer_locator.kind != "layer"
            or self.layer_count_after != self.layer_count_before + 1
        ):
            raise ValueError("shape layer result is inconsistent")
        return self


class ShapeGroupsListValue(_NativeModel):
    layer_locator: NativeLocator
    total: NonNegativeInt
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]
    returned: Annotated[StrictInt, Field(ge=0, le=50)]
    has_more: StrictBool
    next_offset: NonNegativeInt | None
    groups: tuple[ShapeGroup, ...] = Field(max_length=50)

    @model_validator(mode="after")
    def verified_page(self) -> "ShapeGroupsListValue":
        consumed = self.offset + self.returned
        expected_more = consumed < self.total
        if (
            self.layer_locator.kind != "layer"
            or self.returned != len(self.groups)
            or self.returned > self.limit
            or consumed > self.total
            or self.has_more is not expected_more
            or self.next_offset != (consumed if expected_more else None)
        ):
            raise ValueError("shape group page is inconsistent")
        refs = [(item.ref.group_index, item.ref.stream_id) for item in self.groups]
        if len(refs) != len(set(refs)):
            raise ValueError("shape group page contains duplicate refs")
        return self


class ShapeGroupCreateValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    group_count_before: NonNegativeInt
    group_count_after: PositiveInt
    group: ShapeGroup

    @model_validator(mode="after")
    def verified_counts(self) -> "ShapeGroupCreateValue":
        if self.group_count_after != self.group_count_before + 1:
            raise ValueError("shape group result count is inconsistent")
        return self


class ShapePathSetValue(_NativeModel):
    changed: Literal[True]
    group_ref: ShapeGroupRef
    before_path: BezierPath
    after_path: BezierPath


class ShapeFillStyleSetValue(_NativeModel):
    changed: Literal[True]
    group_ref: ShapeGroupRef
    before_fill: ShapeFill
    after_fill: ShapeFill


class ShapeStrokeStyleSetValue(_NativeModel):
    changed: Literal[True]
    group_ref: ShapeGroupRef
    before_stroke: ShapeStroke
    after_stroke: ShapeStroke


class ShapeGroupOrderItem(_NativeModel):
    group_index: PositiveInt
    stream_id: SignedInt32
    name: Annotated[StrictStr, Field(min_length=1, max_length=255)]


class ShapeGroupReorderValue(_NativeModel):
    changed: Literal[True]
    layer_locator: NativeLocator
    stream_id: SignedInt32
    before_index: PositiveInt
    after_index: PositiveInt
    groups: tuple[ShapeGroupOrderItem, ...] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def verified_order(self) -> "ShapeGroupReorderValue":
        identities = [(item.group_index, item.stream_id) for item in self.groups]
        if len(identities) != len(set(identities)):
            raise ValueError("shape group order contains duplicates")
        if self.before_index == self.after_index:
            raise ValueError("shape group reorder must change index")
        return self


class ExactTimeInput(_NativeModel):
    value: SignedInt32
    scale: UnsignedInt32


class ExactTime(ExactTimeInput):
    seconds_rational: Annotated[
        StrictStr, Field(min_length=1, max_length=28)
    ]

    @model_validator(mode="after")
    def canonical_time(self) -> "ExactTime":
        divisor = gcd(abs(self.value), self.scale)
        numerator = self.value // divisor
        denominator = self.scale // divisor
        expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
        if self.seconds_rational != expected:
            raise ValueError("secondsRational is not the exact reduced value/scale")
        return self


class LayerMarkerTarget(_NativeModel):
    kind: Literal["layer"]
    layer_locator: NativeLocator


class CompositionMarkerTarget(_NativeModel):
    kind: Literal["composition"]
    composition_locator: NativeLocator


MarkerTarget = LayerMarkerTarget | CompositionMarkerTarget


class MarkerRefInput(_NativeModel):
    target: MarkerTarget = Field(discriminator="kind")
    time: ExactTimeInput


class MarkerRef(_NativeModel):
    target: MarkerTarget = Field(discriminator="kind")
    time: ExactTime


class CuePointParameter(_NativeModel):
    key: Annotated[StrictStr, Field(min_length=1, max_length=255)]
    value: Annotated[StrictStr, Field(max_length=1024)]


class MarkerState(_NativeModel):
    ref: MarkerRef
    marker_index: PositiveInt
    duration: ExactTime
    comment: Annotated[StrictStr, Field(max_length=1024)]
    chapter: Annotated[StrictStr, Field(max_length=128)]
    url: Annotated[StrictStr, Field(max_length=1024)]
    frame_target: Annotated[StrictStr, Field(max_length=128)]
    cue_point_name: Annotated[StrictStr, Field(max_length=64)]
    cue_point_parameters: tuple[CuePointParameter, ...] = Field(max_length=64)
    navigation: StrictBool
    protected_region: StrictBool
    label_id: Annotated[StrictInt, Field(ge=0, le=16)]

    @model_validator(mode="after")
    def valid_state(self) -> "MarkerState":
        if self.duration.value < 0:
            raise ValueError("marker duration must be non-negative")
        keys = [item.key for item in self.cue_point_parameters]
        if len(keys) != len(set(keys)):
            raise ValueError("marker cue parameter keys must be unique")
        return self


class MarkerValueInput(_NativeModel):
    duration: ExactTimeInput
    comment: Annotated[StrictStr, Field(max_length=1024)]
    chapter: Annotated[StrictStr, Field(max_length=128)]
    url: Annotated[StrictStr, Field(max_length=1024)]
    frame_target: Annotated[StrictStr, Field(max_length=128)]
    cue_point_name: Annotated[StrictStr, Field(max_length=64)]
    cue_point_parameters: tuple[CuePointParameter, ...] = Field(max_length=64)
    navigation: StrictBool
    protected_region: StrictBool
    label_id: Annotated[StrictInt, Field(ge=0, le=16)]


class MarkerPatch(_NativeModel):
    duration: ExactTimeInput | None = None
    comment: Annotated[StrictStr, Field(max_length=1024)] | None = None
    chapter: Annotated[StrictStr, Field(max_length=128)] | None = None
    url: Annotated[StrictStr, Field(max_length=1024)] | None = None
    frame_target: Annotated[StrictStr, Field(max_length=128)] | None = None
    cue_point_name: Annotated[StrictStr, Field(max_length=64)] | None = None
    cue_point_parameters: tuple[CuePointParameter, ...] | None = Field(
        None, max_length=64
    )
    navigation: StrictBool | None = None
    protected_region: StrictBool | None = None
    label_id: Annotated[StrictInt, Field(ge=0, le=16)] | None = None


class MarkersListArguments(_NativeModel):
    target: MarkerTarget = Field(discriminator="kind")
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]


class MarkerCreateArguments(_NativeModel):
    target: MarkerTarget = Field(discriminator="kind")
    time: ExactTimeInput
    marker: MarkerValueInput
    idempotency_key: IdempotencyKey


class MarkerSetArguments(_NativeModel):
    marker_ref: MarkerRefInput
    patch: MarkerPatch
    idempotency_key: IdempotencyKey


class MarkerDeleteArguments(_NativeModel):
    marker_ref: MarkerRefInput
    idempotency_key: IdempotencyKey


class MarkersListValue(_NativeModel):
    target: MarkerTarget = Field(discriminator="kind")
    total: NonNegativeInt
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]
    returned: Annotated[StrictInt, Field(ge=0, le=50)]
    has_more: StrictBool
    next_offset: NonNegativeInt | None
    markers: tuple[MarkerState, ...] = Field(max_length=50)

    @model_validator(mode="after")
    def verified_page(self) -> "MarkersListValue":
        consumed = self.offset + self.returned
        expected_more = consumed < self.total
        if (
            self.returned != len(self.markers)
            or self.returned > self.limit
            or consumed > self.total
            or self.has_more is not expected_more
            or self.next_offset != (consumed if expected_more else None)
        ):
            raise ValueError("marker page is inconsistent")
        if any(marker.ref.target != self.target for marker in self.markers):
            raise ValueError("marker page contains an entry from another target")
        rationals = [
            (marker.ref.time.value, marker.ref.time.scale)
            for marker in self.markers
        ]
        for left, right in zip(rationals, rationals[1:]):
            if left[0] * right[1] >= right[0] * left[1]:
                raise ValueError("markers must be strictly ordered by exact time")
        return self


class MarkerCreateValue(_NativeModel):
    changed: Literal[True]
    before: None
    after: MarkerState


class MarkerSetValue(_NativeModel):
    changed: Literal[True]
    before: MarkerState
    after: MarkerState

    @model_validator(mode="after")
    def stable_identity(self) -> "MarkerSetValue":
        if self.before.ref != self.after.ref:
            raise ValueError("marker set must preserve target and exact time")
        return self


class MarkerDeleteValue(_NativeModel):
    changed: Literal[True]
    before: MarkerState
    after: None


class TsmReadExecution(_ReadExecution):
    value: _NativeModel


class TsmWriteExecution(_WriteExecution):
    value: _NativeModel


def _bounded_decimal(
    text: str,
    *,
    minimum: Decimal | None,
    maximum: Decimal | None,
) -> None:
    try:
        decimal = Decimal(text)
        binary = float(text)
    except (InvalidOperation, OverflowError, ValueError) as error:
        raise ValueError("decimal value must be finite and binary-convertible") from error
    if not decimal.is_finite() or not math.isfinite(binary):
        raise ValueError("decimal value must be finite and binary-convertible")
    if binary == 0 and (not decimal.is_zero() or text.startswith("-")):
        raise ValueError("decimal value must be canonical and not underflow")
    if minimum is not None and decimal < minimum:
        raise ValueError("decimal value is below the frozen range")
    if maximum is not None and decimal > maximum:
        raise ValueError("decimal value is above the frozen range")


ARGUMENT_MODELS = {
    "ae.shape.layer.create": ShapeLayerCreateArguments,
    "ae.shape.groups.list": ShapeGroupsListArguments,
    "ae.shape.group.create": ShapeGroupCreateArguments,
    "ae.shape.path.set": ShapePathSetArguments,
    "ae.shape.fill-style.set": ShapeFillStyleSetArguments,
    "ae.shape.stroke-style.set": ShapeStrokeStyleSetArguments,
    "ae.shape.group.reorder": ShapeGroupReorderArguments,
    "ae.marker.list": MarkersListArguments,
    "ae.marker.create": MarkerCreateArguments,
    "ae.marker.set": MarkerSetArguments,
    "ae.marker.delete": MarkerDeleteArguments,
}

VALUE_MODELS = {
    "ae.shape.layer.create": ShapeLayerCreateValue,
    "ae.shape.groups.list": ShapeGroupsListValue,
    "ae.shape.group.create": ShapeGroupCreateValue,
    "ae.shape.path.set": ShapePathSetValue,
    "ae.shape.fill-style.set": ShapeFillStyleSetValue,
    "ae.shape.stroke-style.set": ShapeStrokeStyleSetValue,
    "ae.shape.group.reorder": ShapeGroupReorderValue,
    "ae.marker.list": MarkersListValue,
    "ae.marker.create": MarkerCreateValue,
    "ae.marker.set": MarkerSetValue,
    "ae.marker.delete": MarkerDeleteValue,
}


def _schema(model: type[_NativeModel]) -> dict[str, Any]:
    """Contract schema shared with the native track, including closed aliases."""
    return model.model_json_schema(by_alias=True, mode="validation")


CAPABILITY_CONTRACTS = {
    capability_id: CapabilityContract(
        capability_id,
        f"Execute frozen {capability_id} operation.",
        "read" if capability_id in {"ae.shape.groups.list", "ae.marker.list"} else "write",
        "idempotent" if capability_id in {"ae.shape.groups.list", "ae.marker.list"} else "idempotency-key",
        (
            "Reads bounded After Effects authored state without changing it."
            if capability_id in {"ae.shape.groups.list", "ae.marker.list"}
            else "Changes bounded After Effects authored state and creates one Undo step."
        ),
        ("An After Effects project must be open.",),
        f"aemcp.requirement.native.{capability_id.removeprefix('ae.').replace('.', '-')}",
        _schema(ARGUMENT_MODELS[capability_id]),
        _schema(VALUE_MODELS[capability_id]),
        capability_id.removeprefix("ae.").replace(".", "-"),
    )
    for capability_id in ARGUMENT_MODELS
}


def _primary_locator(arguments: _NativeModel) -> tuple[NativeLocator, str]:
    for field in ("composition_locator", "layer_locator"):
        locator = getattr(arguments, field, None)
        if locator is not None:
            return locator, field
    group_ref = getattr(arguments, "group_ref", None)
    if group_ref is not None:
        return group_ref.layer_locator, "groupRef.layerLocator"
    marker_ref = getattr(arguments, "marker_ref", None)
    target = marker_ref.target if marker_ref is not None else getattr(arguments, "target")
    if target.kind == "layer":
        return target.layer_locator, "target.layerLocator"
    return target.composition_locator, "target.compositionLocator"


async def invoke_tsm_native(
    backend: NativeInvokeBackend,
    *,
    capability_id: str,
    arguments: Mapping[str, Any],
    request_id: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> TsmReadExecution | TsmWriteExecution:
    if capability_id not in CAPABILITY_CONTRACTS:
        raise ValueError(f"unknown Text/Shape/Marker capability: {capability_id}")
    argument_model = ARGUMENT_MODELS[capability_id]
    value_model = VALUE_MODELS[capability_id]
    parsed = argument_model.model_validate(arguments)
    contract = CAPABILITY_CONTRACTS[capability_id]
    locator, locator_field = _primary_locator(parsed)
    write = contract.risk == "write"
    if not write:
        negotiation, descriptor, _request, result = await _invoke_native_read_request(
            backend,
            request_id=request_id,
            capability_id=capability_id,
            capability_version=CAPABILITY_VERSION,
            arguments=parsed.model_dump(mode="json", by_alias=True),
            locator=locator,
            locator_field=locator_field,
            stale_locator_hint="Acquire a fresh target through a public native read.",
            descriptor_validator=_descriptor_validator(contract),
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        try:
            value = value_model.model_validate(result.value)
        except (TypeError, ValueError, UnicodeError) as error:
            raise _structured_error(
                "NATIVE_CONTRACT_MISMATCH",
                f"Native {capability_id} result did not match the frozen response.",
            ) from error
        if (
            result.evidence.postcondition.kind != contract.postcondition_kind
            or result.evidence.postcondition.digest
            != _value_digest(capability_id, value)
        ):
            raise _structured_error(
                "NATIVE_CONTRACT_MISMATCH",
                f"Native {capability_id} postcondition did not verify.",
            )
        return TsmReadExecution(
            implementation=descriptor,
            negotiation=negotiation,
            value=value,
            evidence=result.evidence,
        )

    inspect_hint = f"Inspect {capability_id} target state and audit before retrying."
    negotiation, descriptor, request, result = await _invoke_package_write_request(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=parsed,
        locator=locator,
        locator_field=locator_field,
        allow_replay=True,
        inspect_hint=inspect_hint,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
        exclude_none=capability_id == "ae.marker.set",
    )
    value = _validate_write_value(
        contract=contract,
        result=result,
        value_model=value_model,
        inspect_hint=inspect_hint,
    )
    return TsmWriteExecution(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=request.request_id,
        idempotency_key=parsed.idempotency_key,
        replayed=result.replayed,
        value=value,
        evidence=result.evidence,
    )


__all__ = [
    "ARGUMENT_MODELS",
    "CAPABILITY_CONTRACTS",
    "VALUE_MODELS",
    "invoke_tsm_native",
]
