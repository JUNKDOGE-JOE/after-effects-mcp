"""Frozen public request schemas for Text, Shape, and Marker authoring."""

from __future__ import annotations

import math
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any, Literal, Optional, Union

from pydantic import ConfigDict, Field, field_validator, model_validator

from ae_mcp.schemas import (
    AeCompositionLocator,
    AeLayerLocator,
    AeMaskVertexInput,
    AeMediaColor,
    _StrictModel,
)


SAFE_MAX = 9_007_199_254_740_991
DECIMAL_PATTERN = r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"
IDEMPOTENCY_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
DecimalString = Annotated[
    str, Field(min_length=1, max_length=32, pattern=DECIMAL_PATTERN)
]


def unicode_scalars(
    value: str, *, field: str, maximum: int, minimum: int = 0
) -> str:
    if "\x00" in value or any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError(f"{field} must contain only non-NUL Unicode scalar values")
    if not minimum <= len(value) <= maximum:
        raise ValueError(f"{field} must contain {minimum}..{maximum} Unicode scalar values")
    return value


def bounded_decimal(
    value: str,
    *,
    field: str,
    minimum: Decimal,
    maximum: Decimal,
    exclusive_minimum: bool = False,
) -> str:
    try:
        decimal = Decimal(value)
        binary = float(value)
    except (InvalidOperation, OverflowError, ValueError) as error:
        raise ValueError(f"{field} must be a finite canonical decimal") from error
    if not decimal.is_finite() or not math.isfinite(binary):
        raise ValueError(f"{field} must be a finite canonical decimal")
    if binary == 0 and (not decimal.is_zero() or value.startswith("-")):
        raise ValueError(f"{field} must be a canonical binary-convertible decimal")
    below = decimal <= minimum if exclusive_minimum else decimal < minimum
    if below or decimal > maximum:
        raise ValueError(f"{field} is outside the frozen numeric range")
    return value


class AeFontSelection(_StrictModel):
    preferred_postscript_name: str = Field(..., min_length=1, max_length=255)
    fallback_postscript_names: list[str] = Field(..., min_length=0, max_length=4)
    on_missing: Literal["error", "use-first-installed-fallback"]

    @field_validator("preferred_postscript_name")
    @classmethod
    def valid_preferred(cls, value: str) -> str:
        return unicode_scalars(
            value, field="preferred_postscript_name", minimum=1, maximum=255
        )

    @field_validator("fallback_postscript_names")
    @classmethod
    def valid_fallbacks(cls, value: list[str]) -> list[str]:
        for item in value:
            unicode_scalars(
                item, field="fallback_postscript_names", minimum=1, maximum=255
            )
        if len(set(value)) != len(value):
            raise ValueError("fallback_postscript_names must be unique")
        return value


class AeTextBoxSize(_StrictModel):
    width_pixels: DecimalString
    height_pixels: DecimalString

    @field_validator("width_pixels", "height_pixels")
    @classmethod
    def valid_dimension(cls, value: str, info: Any) -> str:
        return bounded_decimal(
            value,
            field=info.field_name,
            minimum=Decimal(0),
            maximum=Decimal(30_000),
            exclusive_minimum=True,
        )


class AeTextCharacterStylePatch(_StrictModel):
    font: AeFontSelection | None = None
    font_size_pixels: DecimalString | None = None
    fill_color: AeMediaColor | None = None
    stroke_color: AeMediaColor | None = None
    stroke_width_pixels: DecimalString | None = None
    stroke_over_fill: bool | None = None
    tracking: int | None = Field(None, ge=-10_000, le=10_000)
    auto_leading: bool | None = None
    leading_pixels: DecimalString | None = None
    faux_bold: bool | None = None
    faux_italic: bool | None = None

    @field_validator("font_size_pixels")
    @classmethod
    def valid_font_size(cls, value: str | None) -> str | None:
        return value if value is None else bounded_decimal(
            value,
            field="font_size_pixels",
            minimum=Decimal(0),
            maximum=Decimal(1296),
            exclusive_minimum=True,
        )

    @field_validator("stroke_width_pixels")
    @classmethod
    def valid_stroke_width(cls, value: str | None) -> str | None:
        return value if value is None else bounded_decimal(
            value,
            field="stroke_width_pixels",
            minimum=Decimal(0),
            maximum=Decimal(1000),
        )

    @field_validator("leading_pixels")
    @classmethod
    def valid_leading(cls, value: str | None) -> str | None:
        return value if value is None else bounded_decimal(
            value,
            field="leading_pixels",
            minimum=Decimal(0),
            maximum=Decimal(12_960),
            exclusive_minimum=True,
        )

    @model_validator(mode="after")
    def valid_patch(self) -> "AeTextCharacterStylePatch":
        if not any(getattr(self, field) is not None for field in self.model_fields_set):
            raise ValueError("style must contain at least one requested field")
        if self.auto_leading is True and self.leading_pixels is not None:
            raise ValueError("leading_pixels is forbidden when auto_leading is true")
        if self.auto_leading is False and self.leading_pixels is None:
            raise ValueError("setting auto_leading false requires leading_pixels")
        return self


Justification = Literal[
    "left",
    "right",
    "center",
    "full-last-left",
    "full-last-right",
    "full-last-center",
    "full-last-full",
]


class AeTextParagraphStylePatch(_StrictModel):
    justification: Justification | None = None
    first_line_indent_pixels: DecimalString | None = None
    start_indent_pixels: DecimalString | None = None
    end_indent_pixels: DecimalString | None = None
    space_before_pixels: DecimalString | None = None
    space_after_pixels: DecimalString | None = None

    @field_validator(
        "first_line_indent_pixels",
        "start_indent_pixels",
        "end_indent_pixels",
        "space_before_pixels",
        "space_after_pixels",
    )
    @classmethod
    def valid_decimal(cls, value: str | None, info: Any) -> str | None:
        return value if value is None else bounded_decimal(
            value,
            field=info.field_name,
            minimum=Decimal(-30_000),
            maximum=Decimal(30_000),
        )

    @model_validator(mode="after")
    def nonempty(self) -> "AeTextParagraphStylePatch":
        if not any(getattr(self, field) is not None for field in self.model_fields_set):
            raise ValueError("style must contain at least one requested field")
        return self


class AeBezierPathInput(_StrictModel):
    closed: bool
    vertices: list[AeMaskVertexInput] = Field(..., min_length=2, max_length=128)

    @model_validator(mode="after")
    def enough_vertices(self) -> "AeBezierPathInput":
        if self.closed and len(self.vertices) < 3:
            raise ValueError("a closed Bezier path requires at least three vertices")
        return self


class AeShapeGroupRefInput(_StrictModel):
    layer_locator: AeLayerLocator
    group_index: int = Field(..., ge=1, le=SAFE_MAX)
    stream_id: int = Field(..., ge=-2_147_483_648, le=2_147_483_647)


class AeShapeFillInput(_StrictModel):
    enabled: bool
    color: AeMediaColor
    opacity_percent: DecimalString

    @field_validator("opacity_percent")
    @classmethod
    def opacity(cls, value: str) -> str:
        return bounded_decimal(
            value, field="opacity_percent", minimum=Decimal(0), maximum=Decimal(100)
        )


class AeShapeStrokeInput(_StrictModel):
    enabled: bool
    color: AeMediaColor
    opacity_percent: DecimalString
    width_pixels: DecimalString
    stroke_over_fill: bool

    @field_validator("opacity_percent")
    @classmethod
    def opacity(cls, value: str) -> str:
        return bounded_decimal(
            value, field="opacity_percent", minimum=Decimal(0), maximum=Decimal(100)
        )

    @field_validator("width_pixels")
    @classmethod
    def width(cls, value: str) -> str:
        return bounded_decimal(
            value, field="width_pixels", minimum=Decimal(0), maximum=Decimal(1000)
        )


class AeCreateShapeFillInput(AeShapeFillInput):
    opacity_percent: DecimalString = "100"


class AeCreateShapeStrokeInput(AeShapeStrokeInput):
    opacity_percent: DecimalString = "100"


class AeExactTimeInput(_StrictModel):
    value: int = Field(..., ge=-2_147_483_648, le=2_147_483_647)
    scale: int = Field(..., ge=1, le=4_294_967_295)


class AeMarkerLayerTargetInput(_StrictModel):
    kind: Literal["layer"]
    layer_locator: AeLayerLocator


class AeMarkerCompositionTargetInput(_StrictModel):
    kind: Literal["composition"]
    composition_locator: AeCompositionLocator


AeMarkerTargetInput = Union[
    AeMarkerLayerTargetInput,
    AeMarkerCompositionTargetInput,
]


class AeMarkerRefInput(_StrictModel):
    target: AeMarkerTargetInput = Field(..., discriminator="kind")
    time: AeExactTimeInput


class AeCuePointParameterInput(_StrictModel):
    key: str = Field(..., min_length=1, max_length=255)
    value: str = Field(..., max_length=1024)

    @field_validator("key")
    @classmethod
    def key_scalars(cls, value: str) -> str:
        return unicode_scalars(value, field="key", minimum=1, maximum=255)

    @field_validator("value")
    @classmethod
    def value_scalars(cls, value: str) -> str:
        return unicode_scalars(value, field="value", maximum=1024)


class AeMarkerValueInput(_StrictModel):
    duration: AeExactTimeInput = Field(
        default_factory=lambda: AeExactTimeInput(value=0, scale=1)
    )
    comment: str = Field("", max_length=1024)
    chapter: str = Field("", max_length=128)
    url: str = Field("", max_length=1024)
    frame_target: str = Field("", max_length=128)
    cue_point_name: str = Field("", max_length=64)
    cue_point_parameters: list[AeCuePointParameterInput] = Field(
        default_factory=list, max_length=64
    )
    navigation: bool = False
    protected_region: bool = False
    label_id: int = Field(0, ge=0, le=16)

    @field_validator("comment", "chapter", "url", "frame_target", "cue_point_name")
    @classmethod
    def strings(cls, value: str, info: Any) -> str:
        limits = {
            "comment": 1024,
            "chapter": 128,
            "url": 1024,
            "frame_target": 128,
            "cue_point_name": 64,
        }
        return unicode_scalars(
            value, field=info.field_name, maximum=limits[info.field_name]
        )

    @field_validator("cue_point_parameters")
    @classmethod
    def unique_keys(
        cls, value: list[AeCuePointParameterInput]
    ) -> list[AeCuePointParameterInput]:
        keys = [parameter.key for parameter in value]
        if len(keys) != len(set(keys)):
            raise ValueError("cue_point_parameters keys must be unique")
        return value

    @model_validator(mode="after")
    def nonnegative_duration(self) -> "AeMarkerValueInput":
        if self.duration.value < 0:
            raise ValueError("marker duration must be non-negative")
        return self


class AeMarkerPatch(_StrictModel):
    duration: AeExactTimeInput | None = None
    comment: str | None = Field(None, max_length=1024)
    chapter: str | None = Field(None, max_length=128)
    url: str | None = Field(None, max_length=1024)
    frame_target: str | None = Field(None, max_length=128)
    cue_point_name: str | None = Field(None, max_length=64)
    cue_point_parameters: list[AeCuePointParameterInput] | None = Field(
        None, max_length=64
    )
    navigation: bool | None = None
    protected_region: bool | None = None
    label_id: int | None = Field(None, ge=0, le=16)

    @field_validator("comment", "chapter", "url", "frame_target", "cue_point_name")
    @classmethod
    def strings(cls, value: str | None, info: Any) -> str | None:
        if value is None:
            return value
        limits = {
            "comment": 1024,
            "chapter": 128,
            "url": 1024,
            "frame_target": 128,
            "cue_point_name": 64,
        }
        return unicode_scalars(
            value, field=info.field_name, maximum=limits[info.field_name]
        )

    @field_validator("cue_point_parameters")
    @classmethod
    def unique_keys(
        cls, value: list[AeCuePointParameterInput] | None
    ) -> list[AeCuePointParameterInput] | None:
        if value is None:
            return value
        keys = [parameter.key for parameter in value]
        if len(keys) != len(set(keys)):
            raise ValueError("cue_point_parameters keys must be unique")
        return value

    @model_validator(mode="after")
    def valid_patch(self) -> "AeMarkerPatch":
        if not any(
            getattr(self, field) is not None
            for field in type(self).model_fields
        ):
            raise ValueError("patch must contain at least one requested field")
        if self.duration is not None and self.duration.value < 0:
            raise ValueError("marker duration must be non-negative")
        return self


# Retained only as private value-model definitions for legacy native carrier
# code until Task 9 removes those carriers. No TSM tool schema is public.
PUBLIC_SCHEMAS: dict[str, type[_StrictModel]] = {}
