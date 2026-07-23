"""Pydantic schemas for the registered ae-mcp verbs.

Each schema corresponds 1:1 with a verb in HANDLERS. pydantic generates
JSON schema for MCP tools/list at runtime; keep field docstrings short — the
LLM reads them in the tool-picker.
"""

from __future__ import annotations

import math
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from typing import Annotated, Any, Dict, List, Literal, Optional, Tuple, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    constr,
    field_validator,
    model_validator,
)


# Common literal set used by several schemas (effects / layer types).
LayerType = Literal[
    "solid", "text", "shape", "null", "adjustment", "camera", "light"
]

SnapshotMethod = Literal["DesktopCopy", "PrintWindow"]
OutputFormat = Literal["json", "text"]
NonNegativeFloat = Annotated[float, Field(ge=0)]


class _StrictModel(BaseModel):
    """Base: forbid extras so typos surface early."""
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Core 9
# ---------------------------------------------------------------------------


class AeInitArgs(_StrictModel):
    """ae.init — bootstrap / refresh project snapshot."""
    refresh_only: bool = Field(
        False,
        description="When true, only refresh project_state; skip full instructions.",
    )


class AeOverviewArgs(_StrictModel):
    """ae.overview — project summary (no args)."""
    pass


class AeProjectSummaryArgs(_StrictModel):
    """ae.projectSummary — verified native AEGP project summary (no args).

    This public tool is explicitly bound to ae.project.summary@1. It never
    falls back to ae.overview or to JSX when the native execution plane is
    unavailable.
    """
    pass


class AeGetProjectBitDepthArgs(_StrictModel):
    """ae.getProjectBitDepth — read project bits per channel through native AEGP."""


class AeSetProjectBitDepthArgs(_StrictModel):
    """ae.setProjectBitDepth — set project bits per channel through native AEGP.

    This write never falls back to JSX. Use one stable idempotency key for one
    user intent; a claimed key cannot dispatch a second mutation.
    """

    target_depth: Literal[8, 16, 32] = Field(
        ...,
        description="Required target bits per channel: exactly 8, 16, or 32.",
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description=(
            "Stable 16-64 character key for this bit-depth intent. Reusing a claimed "
            "key returns DUPLICATE_REQUEST and cannot perform a second mutation."
        ),
    )


_LOCATOR_UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"


class _AeLocatorInput(BaseModel):
    """Camel-case locator shape copied verbatim from native read results."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        strict=True,
    )

    host_instance_id: str = Field(alias="hostInstanceId", pattern=_LOCATOR_UUID)
    session_id: str = Field(alias="sessionId", pattern=_LOCATOR_UUID)
    project_id: str = Field(alias="projectId", pattern=_LOCATOR_UUID)
    generation: int = Field(ge=1, le=9_007_199_254_740_991)
    object_id: str = Field(alias="objectId", pattern=_LOCATOR_UUID)


class AeProjectLocator(_AeLocatorInput):
    kind: Literal["project"]


class AeCompositionLocator(_AeLocatorInput):
    kind: Literal["composition"]


class AeLayerLocator(_AeLocatorInput):
    kind: Literal["layer"]


class AePropertyLocator(_AeLocatorInput):
    kind: Literal["stream"]


class AeListProjectItemsArgs(_StrictModel):
    """ae.listProjectItems — list bounded project items through native AEGP only.

    The first page needs no locator. For later pages, copy project_locator from
    the prior result so a project/session change fails as STALE_LOCATOR rather
    than silently continuing in another project. This tool never falls back to
    JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    project_locator: Optional[AeProjectLocator] = Field(
        None,
        description=(
            "Project locator returned by this tool. Required when offset is non-zero."
        ),
    )
    offset: int = Field(
        0,
        ge=0,
        le=9_007_199_254_740_991,
        description="Zero-based project-item offset.",
    )
    limit: int = Field(
        25,
        ge=1,
        le=50,
        description="Maximum items requested for this bounded page (default 25, max 50).",
    )

    @model_validator(mode="after")
    def _continuation_requires_project(self) -> "AeListProjectItemsArgs":
        if self.offset > 0 and self.project_locator is None:
            raise ValueError("project_locator is required when offset is non-zero")
        return self


class AeListCompositionLayersArgs(_StrictModel):
    """ae.listCompositionLayers — list a composition's layers through native AEGP only.

    Copy composition_locator from ae_listProjectItems. Numeric comp ids and
    names are intentionally not accepted, and this tool never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    composition_locator: AeCompositionLocator = Field(
        ...,
        description="Composition locator returned by ae_listProjectItems.",
    )
    offset: int = Field(
        0,
        ge=0,
        le=9_007_199_254_740_991,
        description="Zero-based layer offset; returned stackIndex values are one-based.",
    )
    limit: int = Field(
        25,
        ge=1,
        le=50,
        description="Maximum layers requested for this bounded page (default 25, max 50).",
    )


class AeListSelectedLayersArgs(_StrictModel):
    """ae.listSelectedLayers — list selected composition layers through native AEGP only.

    Copy composition_locator from ae_listProjectItems. The result contains only
    selected layers (in stack order), never property/mask/effect/keyframe
    selections, and this tool never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    composition_locator: AeCompositionLocator = Field(
        ...,
        description="Composition locator returned by ae_listProjectItems.",
    )
    offset: int = Field(
        0,
        ge=0,
        le=9_007_199_254_740_991,
        description="Zero-based offset within the selected-layer result set.",
    )
    limit: int = Field(
        25,
        ge=1,
        le=50,
        description=(
            "Maximum selected layers requested for this bounded page "
            "(default 25, max 50)."
        ),
    )


class AeGetLayerDetailsArgs(_StrictModel):
    """ae.getLayerDetails — read exact native timing and hierarchy for one layer."""

    model_config = ConfigDict(extra="forbid", strict=True)

    layer_locator: AeLayerLocator = Field(
        ...,
        description="Fresh layer locator returned by ae_listCompositionLayers.",
    )


class AeGetLayerCompositingStateArgs(_StrictModel):
    """Read native layer switches, quality, and blending state."""

    model_config = ConfigDict(extra="forbid", strict=True)

    layer_locator: AeLayerLocator = Field(
        ...,
        description="Fresh layer locator returned by ae_listCompositionLayers.",
    )


class _AeLayerWriteArgs(_StrictModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    layer_locator: AeLayerLocator = Field(
        ...,
        description="Fresh layer locator returned by ae_listCompositionLayers.",
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description="Stable key for this one layer write intent; use a new key for a new intent.",
    )


class _AeLayerBooleanSwitchArgs(_AeLayerWriteArgs):
    enabled: bool = Field(
        ...,
        description="Exact desired switch state. Read current state first; no-op writes are rejected.",
    )


class AeSetLayerVisibilityArgs(_AeLayerBooleanSwitchArgs):
    """Set the layer video/eyeball switch."""


class AeSetLayerSoloArgs(_AeLayerBooleanSwitchArgs):
    """Set the layer Solo switch."""


class AeSetLayerLockedArgs(_AeLayerBooleanSwitchArgs):
    """Set the layer Lock switch."""


class AeSetLayerShyArgs(_AeLayerBooleanSwitchArgs):
    """Set the layer Shy switch."""


class AeSetLayerMotionBlurArgs(_AeLayerBooleanSwitchArgs):
    """Set the layer Motion Blur switch."""


class AeSetLayerThreeDArgs(_AeLayerBooleanSwitchArgs):
    """Set the layer 3D switch."""


class AeSetLayerAdjustmentArgs(_AeLayerBooleanSwitchArgs):
    """Set the layer Adjustment Layer switch."""


class AeSetLayerQualityArgs(_AeLayerWriteArgs):
    """Set the layer render quality from a closed native enum."""

    quality: Literal["wireframe", "draft", "best"] = Field(
        ...,
        description="Exact After Effects layer quality.",
    )


class AeSetLayerBlendingModeArgs(_AeLayerWriteArgs):
    """Set the layer blending mode while preserving alpha/matte fields."""

    mode: Literal[
        "normal", "dissolve", "add", "multiply", "screen", "overlay", "soft-light",
        "hard-light", "darken", "lighten", "difference", "hue", "saturation", "color",
        "luminosity", "color-dodge", "color-burn", "exclusion", "linear-dodge",
        "linear-burn", "linear-light", "vivid-light", "pin-light", "hard-mix",
        "lighter-color", "darker-color", "subtract", "divide",
    ] = Field(..., description="Exact allowlisted After Effects blending mode.")


_TRANSFORM_DECIMAL = r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"
TransformComponents = List[
    Annotated[str, Field(min_length=1, max_length=32, pattern=_TRANSFORM_DECIMAL)]
]


def _validate_transform_decimal(value: str, *, field: str) -> None:
    try:
        decimal_value = Decimal(value)
        binary_value = float(value)
    except (InvalidOperation, OverflowError, ValueError) as exc:
        raise ValueError(f"{field} must be a finite binary64 decimal") from exc
    if not decimal_value.is_finite() or not math.isfinite(binary_value):
        raise ValueError(f"{field} must be a finite binary64 decimal")
    if binary_value == 0 and not decimal_value.is_zero():
        raise ValueError(f"{field} must not underflow binary64")
    if binary_value == 0 and value.startswith("-"):
        raise ValueError(f"{field} must normalize negative zero to 0")


def _validate_transform_components(
    values: TransformComponents,
    *,
    field: str,
) -> TransformComponents:
    for value in values:
        _validate_transform_decimal(value, field=field)
    return values


class AeGetLayerTransformArgs(_StrictModel):
    """ae.getLayerTransform — read the standard transform fields without property locators."""

    model_config = ConfigDict(extra="forbid", strict=True)
    layer_locator: AeLayerLocator = Field(
        ...,
        description="Fresh layer locator returned by ae_listCompositionLayers.",
    )


class AeSetLayerAnchorPointArgs(_AeLayerWriteArgs):
    """ae.setLayerAnchorPoint — set a static 2D/3D anchor point through native AEGP."""

    anchor_point: TransformComponents = Field(..., min_length=2, max_length=3)

    @field_validator("anchor_point")
    @classmethod
    def _finite_anchor(cls, value: TransformComponents) -> TransformComponents:
        return _validate_transform_components(value, field="anchor_point")


class AeSetLayerPositionArgs(_AeLayerWriteArgs):
    """ae.setLayerPosition — set a static 2D/3D position through native AEGP."""

    position: TransformComponents = Field(..., min_length=2, max_length=3)

    @field_validator("position")
    @classmethod
    def _finite_position(cls, value: TransformComponents) -> TransformComponents:
        return _validate_transform_components(value, field="position")


class AeSetLayerScaleArgs(_AeLayerWriteArgs):
    """ae.setLayerScale — set static 2D/3D scale percentages through native AEGP."""

    scale_percent: TransformComponents = Field(..., min_length=2, max_length=3)

    @field_validator("scale_percent")
    @classmethod
    def _finite_scale(cls, value: TransformComponents) -> TransformComponents:
        return _validate_transform_components(value, field="scale_percent")


class AeSetLayerRotationArgs(_AeLayerWriteArgs):
    """ae.setLayerRotation — set static 2D/Z rotation degrees through native AEGP."""

    rotation_degrees: str = Field(
        ..., min_length=1, max_length=32, pattern=_TRANSFORM_DECIMAL,
    )

    @field_validator("rotation_degrees")
    @classmethod
    def _finite_rotation(cls, value: str) -> str:
        _validate_transform_decimal(value, field="rotation_degrees")
        return value


class AeSetLayerOpacityArgs(_AeLayerWriteArgs):
    """ae.setLayerOpacity — set static opacity in the inclusive 0..100 percent range."""

    opacity_percent: str = Field(
        ..., min_length=1, max_length=32, pattern=_TRANSFORM_DECIMAL,
    )

    @field_validator("opacity_percent")
    @classmethod
    def _valid_opacity(cls, value: str) -> str:
        _validate_transform_decimal(value, field="opacity_percent")
        decimal_value = Decimal(value)
        if decimal_value < 0 or decimal_value > 100:
            raise ValueError("opacity_percent must be between 0 and 100 inclusive")
        return value


class AeSetLayerOrientationArgs(_AeLayerWriteArgs):
    """ae.setLayerOrientation — set static orientation degrees on a 3D layer."""

    orientation_degrees: TransformComponents = Field(
        ..., min_length=3, max_length=3,
    )

    @field_validator("orientation_degrees")
    @classmethod
    def _finite_orientation(cls, value: TransformComponents) -> TransformComponents:
        return _validate_transform_components(value, field="orientation_degrees")


def _valid_layer_name(value: str, *, field: str) -> str:
    if not value or "\x00" in value or any(
        0xD800 <= ord(character) <= 0xDFFF for character in value
    ):
        raise ValueError(f"{field} must contain 1-255 non-NUL Unicode scalar values")
    return value


class AeRenameLayerArgs(_AeLayerWriteArgs):
    """ae.renameLayer — rename one layer with native readback and Undo."""

    name: str = Field(
        ...,
        min_length=1,
        max_length=255,
        pattern=r"^[^\u0000]+$",
        description="Exact new layer name (1-255 Unicode scalar values).",
    )

    @model_validator(mode="after")
    def _valid_name(self) -> "AeRenameLayerArgs":
        _valid_layer_name(self.name, field="name")
        return self


class AeSetLayerRangeArgs(_AeLayerWriteArgs):
    """ae.setLayerRange — set exact comp-time in point and positive duration."""

    in_point: "AeCompositionTimeInput" = Field(
        ...,
        description="Exact composition-time layer in point as value/scale.",
    )
    duration: "AePositiveCompositionTimeInput" = Field(
        ...,
        description="Exact positive layer duration as value/scale.",
    )


class AeSetLayerStartTimeArgs(_AeLayerWriteArgs):
    """ae.setLayerStartTime — set the layer source offset in composition time."""

    start_time: "AeCompositionTimeInput" = Field(
        ...,
        description="Exact layer start/source offset in composition time as value/scale.",
    )


_LAYER_STRETCH_DECIMAL = r"^-?(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,6})?$"


class AeSetLayerStretchArgs(_AeLayerWriteArgs):
    """ae.setLayerStretch — set an exact non-zero layer stretch percentage."""

    stretch_percent: str = Field(
        ...,
        min_length=1,
        max_length=12,
        pattern=_LAYER_STRETCH_DECIMAL,
        description=(
            "Exact decimal percentage in [-9900, 9900], excluding zero; negative "
            "values reverse playback. Up to six fractional digits are accepted when "
            "the reduced value fits After Effects' signed 32-bit ratio."
        ),
    )

    @field_validator("stretch_percent")
    @classmethod
    def _valid_stretch(cls, stretch_percent: str) -> str:
        try:
            value = Decimal(stretch_percent)
        except InvalidOperation as error:
            raise ValueError("stretch_percent must be a finite decimal") from error
        if not value.is_finite() or value == 0 or abs(value) > Decimal("9900"):
            raise ValueError("stretch_percent must be non-zero and within [-9900, 9900]")
        ratio = Fraction(value) / 100
        if (
            ratio.numerator < -2_147_483_648
            or ratio.numerator > 2_147_483_647
            or ratio.denominator > 2_147_483_647
        ):
            raise ValueError(
                "stretch_percent must be exactly representable as a signed 32-bit AEGP ratio"
            )
        return stretch_percent


class AeReorderLayerArgs(_AeLayerWriteArgs):
    """ae.reorderLayer — move one layer to a one-based composition stack index."""

    target_stack_index: int = Field(
        ...,
        ge=1,
        le=1_000_000,
        description="Requested one-based stack index in the layer's current composition.",
    )


class AeSetLayerParentArgs(_AeLayerWriteArgs):
    """ae.setLayerParent — set or clear one same-composition layer parent."""

    parent_layer_locator: Optional[AeLayerLocator] = Field(
        ...,
        description="Fresh same-composition parent locator, or null to clear parenting.",
    )

    @model_validator(mode="after")
    def _valid_parent_context(self) -> "AeSetLayerParentArgs":
        parent = self.parent_layer_locator
        if parent is None:
            return self
        layer = self.layer_locator
        if (
            parent.host_instance_id != layer.host_instance_id
            or parent.session_id != layer.session_id
            or parent.project_id != layer.project_id
            or parent.generation != layer.generation
        ):
            raise ValueError("parent_layer_locator must share the layer's current context")
        if parent.object_id == layer.object_id:
            raise ValueError("a layer cannot parent itself")
        return self


class AeDuplicateLayerArgs(_AeLayerWriteArgs):
    """ae.duplicateLayer — duplicate one layer and return fresh native locators."""

    new_name: str = Field(
        ...,
        min_length=1,
        max_length=255,
        pattern=r"^[^\u0000]+$",
        description="Required exact name for the duplicate (1-255 Unicode scalar values).",
    )

    @model_validator(mode="after")
    def _valid_duplicate_name(self) -> "AeDuplicateLayerArgs":
        _valid_layer_name(self.new_name, field="new_name")
        return self


class AeGetCompositionTimeArgs(_StrictModel):
    """ae.getCompositionTime — read exact composition time through native AEGP.

    Copy composition_locator from ae_listProjectItems. This native-only read
    never accepts a composition name/id and never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    composition_locator: AeCompositionLocator = Field(
        ...,
        description="Composition locator returned by ae_listProjectItems.",
    )


class AeCompositionTimeInput(_StrictModel):
    """Exact A_Time value/scale pair accepted by native composition writes."""

    model_config = ConfigDict(extra="forbid", strict=True)

    value: int = Field(..., ge=-2_147_483_648, le=2_147_483_647)
    scale: int = Field(..., ge=1, le=4_294_967_295)


class AePositiveCompositionTimeInput(AeCompositionTimeInput):
    """Exact positive A_Time value/scale pair for composition durations."""

    value: int = Field(..., ge=1, le=2_147_483_647)


class AeNonNegativeCompositionTimeInput(AeCompositionTimeInput):
    """Exact non-negative time used for a composition work-area start."""

    value: int = Field(..., ge=0, le=2_147_483_647)


class AeProjectItemLocator(_AeLocatorInput):
    """Opaque project-item locator copied from a native project-context result."""

    kind: Literal["item", "composition"]


class AeGetProjectContextArgs(_StrictModel):
    """ae.getProjectContext — read current project, selection, and composition context.

    The selected-item page is bounded and every returned locator is tied to the
    current native session. This native-only read never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    selection_offset: int = Field(
        0,
        ge=0,
        le=9_007_199_254_740_991,
        description="Zero-based offset within the current Project-panel selection.",
    )
    selection_limit: int = Field(
        50,
        ge=1,
        le=50,
        description="Maximum selected project items returned (default and max 50).",
    )


class AeGetProjectItemMetadataArgs(_StrictModel):
    """ae.getProjectItemMetadata — read one project's item metadata.

    Copy item from ae_getProjectContext or ae_listProjectItems. Both ordinary
    project items and compositions are accepted; names and numeric ids are not.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    item_locator: AeProjectItemLocator = Field(
        ...,
        description="Fresh item or composition locator from a native project read.",
    )


class AeGetCompositionSettingsArgs(_StrictModel):
    """ae.getCompositionSettings — read exact settings for one composition.

    Copy composition from ae_getProjectContext or ae_listProjectItems. The
    result uses exact integer time and ratio values and never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    composition_locator: AeCompositionLocator = Field(
        ...,
        description="Fresh composition locator from a native project read.",
    )


class _AeProjectItemWriteArgs(_StrictModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    item_locator: AeProjectItemLocator = Field(
        ...,
        description="Fresh item or composition locator from a native project read.",
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description="Stable key for this one write intent; use a new key for a new intent.",
    )


class AeSetCompositionWorkAreaArgs(_StrictModel):
    """ae.setCompositionWorkArea — set one composition's exact work area.

    The start is non-negative, duration is positive, and native readback
    verifies the transition. This write never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    composition_locator: AeCompositionLocator = Field(
        ...,
        description="Fresh composition locator from a native project read.",
    )
    start: AeNonNegativeCompositionTimeInput = Field(
        ...,
        description="Exact non-negative work-area start as value/scale.",
    )
    duration: AePositiveCompositionTimeInput = Field(
        ...,
        description="Exact positive work-area duration as value/scale.",
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description="Stable key for this work-area intent; use a new key for a new intent.",
    )


class AeRenameProjectItemArgs(_AeProjectItemWriteArgs):
    """ae.renameProjectItem — rename one project item with verified readback."""

    name: str = Field(
        ...,
        min_length=1,
        max_length=255,
        pattern=r"^[^\u0000]+$",
        description="Exact new name (1–255 Unicode scalar values).",
    )

    @model_validator(mode="after")
    def _valid_name(self) -> "AeRenameProjectItemArgs":
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.name):
            raise ValueError("name must contain only Unicode scalar values")
        return self


class AeSetProjectItemCommentArgs(_AeProjectItemWriteArgs):
    """ae.setProjectItemComment — set or clear one project item's comment."""

    comment: str = Field(
        ...,
        max_length=1024,
        pattern=r"^[^\u0000]*$",
        description="Exact comment (0–1024 Unicode scalar values); empty clears it.",
    )

    @model_validator(mode="after")
    def _valid_comment(self) -> "AeSetProjectItemCommentArgs":
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.comment):
            raise ValueError("comment must contain only Unicode scalar values")
        return self


class AeSetProjectItemLabelArgs(_AeProjectItemWriteArgs):
    """ae.setProjectItemLabel — set one numeric After Effects label slot."""

    label_id: int = Field(
        ...,
        ge=0,
        le=16,
        description="After Effects label slot 0–16; 0 means no label.",
    )


class AeDuplicateCompositionArgs(_StrictModel):
    """ae.duplicateComposition — duplicate one composition with a chosen name.

    Returns fresh locators because duplication changes the project graph. A
    stable idempotency key prevents accidental duplicate creation.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    composition_locator: AeCompositionLocator = Field(
        ...,
        description="Fresh source composition locator from a native project read.",
    )
    new_name: str = Field(
        ...,
        min_length=1,
        max_length=255,
        pattern=r"^[^\u0000]+$",
        description="Exact name for the new composition (1–255 Unicode scalar values).",
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description="Stable key for this duplicate intent; reuse never creates another copy.",
    )

    @model_validator(mode="after")
    def _valid_name(self) -> "AeDuplicateCompositionArgs":
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.new_name):
            raise ValueError("new_name must contain only Unicode scalar values")
        return self


class AeSetCompositionTimeArgs(_StrictModel):
    """ae.setCompositionTime — set exact composition time through native AEGP.

    Copy composition_locator from ae_listProjectItems. The exact value/scale
    pair is passed to AEGP_SetItemCurrentTime, verified by native readback, and
    never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    composition_locator: AeCompositionLocator = Field(
        ...,
        description="Composition locator returned by ae_listProjectItems.",
    )
    target_time: AeCompositionTimeInput = Field(
        ...,
        description=(
            "Exact A_Time numerator/value and positive scale. For 2.5 seconds, "
            "use value=5 and scale=2."
        ),
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description=(
            "Stable key for one timeline-write intent. Never reuse it for a new time."
        ),
    )


class AeLayerSolidColorInput(_StrictModel):
    """Integer RGBA color avoids ambiguous floating-point JSON."""

    model_config = ConfigDict(extra="forbid", strict=True)

    red: int = Field(255, ge=0, le=255)
    green: int = Field(255, ge=0, le=255)
    blue: int = Field(255, ge=0, le=255)
    alpha: int = Field(255, ge=0, le=255)


class AePositiveRatioInput(_StrictModel):
    """Exact positive numerator/denominator pair for native A_Ratio values."""

    model_config = ConfigDict(extra="forbid", strict=True)

    numerator: int = Field(..., ge=1, le=2_147_483_647)
    denominator: int = Field(..., ge=1, le=2_147_483_647)


class AeCreateCompositionArgs(_StrictModel):
    """ae.createComposition — create one root composition through native AEGP.

    Defaults describe a common 1920x1080, five-second, 24 fps square-pixel
    composition. The write never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    name: str = Field(
        ...,
        min_length=1,
        max_length=255,
        pattern=r"^[^\u0000]+$",
        description=(
            "Exact composition name (1–255 Unicode scalar values; U+0000 is forbidden)."
        ),
    )
    width: int = Field(1920, ge=1, le=30_000)
    height: int = Field(1080, ge=1, le=30_000)
    duration: AePositiveCompositionTimeInput = Field(
        default_factory=lambda: AePositiveCompositionTimeInput(value=5, scale=1),
        description="Exact positive duration; defaults to five seconds.",
    )
    frame_rate: AePositiveRatioInput = Field(
        default_factory=lambda: AePositiveRatioInput(numerator=24, denominator=1),
        description="Exact positive frames-per-second ratio; defaults to 24/1.",
    )
    pixel_aspect_ratio: AePositiveRatioInput = Field(
        default_factory=lambda: AePositiveRatioInput(numerator=1, denominator=1),
        description="Exact positive pixel-aspect ratio; defaults to square pixels.",
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description=(
            "Stable key for one composition-create intent. Reusing it never "
            "creates a duplicate composition."
        ),
    )

    @model_validator(mode="after")
    def _valid_native_values(self) -> "AeCreateCompositionArgs":
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.name):
            raise ValueError("name must contain only Unicode scalar values")
        return self


class AeCreateCompositionLayerArgs(_StrictModel):
    """ae.createCompositionLayer — create one native null or solid layer.

    Copy composition_locator from ae_listProjectItems. Omitted solid dimensions
    and duration inherit the composition, while omitted color is opaque white.
    This native-only write never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    composition_locator: AeCompositionLocator = Field(
        ...,
        description="Fresh composition locator returned by ae_listProjectItems.",
    )
    kind: Literal["null", "solid"] = Field(
        ...,
        description="The bounded native layer kind to create.",
    )
    name: str = Field(
        ...,
        min_length=1,
        max_length=255,
        description="Exact layer name (1–255 Unicode scalar values).",
    )
    color: Optional[AeLayerSolidColorInput] = Field(
        None,
        description="Solid-only RGBA channels from 0 to 255; omit for opaque white.",
    )
    width: Optional[int] = Field(
        None,
        ge=1,
        le=30_000,
        description="Solid-only width; omit to inherit the composition width.",
    )
    height: Optional[int] = Field(
        None,
        ge=1,
        le=30_000,
        description="Solid-only height; omit to inherit the composition height.",
    )
    duration: Optional[AeCompositionTimeInput] = Field(
        None,
        description="Solid-only exact duration; omit to inherit composition duration.",
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description=(
            "Stable key for one layer-create intent. Reusing it replays the "
            "verified result and never creates a duplicate."
        ),
    )

    @model_validator(mode="after")
    def _solid_fields_match_kind(self) -> "AeCreateCompositionLayerArgs":
        if any(0xD800 <= ord(character) <= 0xDFFF for character in self.name):
            raise ValueError("name must contain only Unicode scalar values")
        if self.kind == "null" and any(
            value is not None
            for value in (self.color, self.width, self.height, self.duration)
        ):
            raise ValueError(
                "color, width, height, and duration are accepted only for kind='solid'"
            )
        return self


class AeApplyLayerEffectArgs(_StrictModel):
    """ae.applyLayerEffect — apply one installed effect through native AEGP.

    Copy layer_locator from ae_listCompositionLayers and pass the installed
    effect's exact, locale-independent match name. This native-only write never
    falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    layer_locator: AeLayerLocator = Field(
        ...,
        description="Fresh layer locator returned by ae_listCompositionLayers.",
    )
    effect_match_name: str = Field(
        ...,
        min_length=1,
        max_length=47,
        description=(
            "Exact installed effect matchName, for example 'ADBE Slider Control'."
        ),
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description=(
            "Stable key for one apply intent. Reusing it replays the verified "
            "result and never adds a duplicate effect."
        ),
    )

    @model_validator(mode="after")
    def _valid_match_name(self) -> "AeApplyLayerEffectArgs":
        if any(
            0xD800 <= ord(character) <= 0xDFFF
            for character in self.effect_match_name
        ):
            raise ValueError("effect_match_name must contain only Unicode scalar values")
        return self


class AeListLayerPropertiesArgs(_StrictModel):
    """ae.listLayerProperties — list direct native properties on a layer/group.

    Copy layer_locator from ae_listCompositionLayers. To descend exactly one
    level, copy parent_property_locator from a prior result. This bounded read
    never recursively walks the tree and never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    layer_locator: AeLayerLocator = Field(
        ...,
        description="Layer locator returned by ae_listCompositionLayers.",
    )
    parent_property_locator: Optional[AePropertyLocator] = Field(
        None,
        description=(
            "Property-group locator returned by this tool; omit for layer roots."
        ),
    )
    offset: int = Field(
        0,
        ge=0,
        le=9_007_199_254_740_991,
        description="Zero-based direct-child property offset.",
    )
    limit: int = Field(
        25,
        ge=1,
        le=25,
        description="Maximum direct properties requested (default 25, max 25).",
    )


class AeListLayerPropertyKeyframesArgs(_StrictModel):
    """ae.listLayerPropertyKeyframes — list exact native keyframes on one property.

    Copy property_locator from ae_listLayerProperties. This bounded read returns
    exact composition-time fractions, primitive values, and unambiguous native
    interpolation. It never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    property_locator: AePropertyLocator = Field(
        ...,
        description="Leaf property locator returned by ae_listLayerProperties.",
    )
    offset: int = Field(
        0,
        ge=0,
        le=9_007_199_254_740_991,
        description="Zero-based keyframe offset.",
    )
    limit: int = Field(
        25,
        ge=1,
        le=25,
        description="Maximum keyframes requested (default 25, max 25).",
    )


_PROPERTY_DECIMAL = r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"


class AePropertyScalarInput(_StrictModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["scalar"]
    value: str = Field(..., min_length=1, max_length=32, pattern=_PROPERTY_DECIMAL)


class AePropertyVectorInput(_StrictModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["vector"]
    components: List[
        Annotated[str, Field(min_length=1, max_length=32, pattern=_PROPERTY_DECIMAL)]
    ] = Field(..., min_length=2, max_length=3)


class AePropertyColorInput(_StrictModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    kind: Literal["color"]
    alpha: str = Field(..., min_length=1, max_length=32, pattern=_PROPERTY_DECIMAL)
    red: str = Field(..., min_length=1, max_length=32, pattern=_PROPERTY_DECIMAL)
    green: str = Field(..., min_length=1, max_length=32, pattern=_PROPERTY_DECIMAL)
    blue: str = Field(..., min_length=1, max_length=32, pattern=_PROPERTY_DECIMAL)


class AeSetLayerPropertyValueArgs(_StrictModel):
    """ae.setLayerPropertyValue — set one primitive native layer property.

    Copy both locators from ae_listLayerProperties. The first slice accepts
    only non-keyframed scalar/vector/color streams and never falls back to JSX.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    layer_locator: AeLayerLocator = Field(
        ...,
        description="Layer locator used to obtain the property locator.",
    )
    property_locator: AePropertyLocator = Field(
        ...,
        description="Leaf property locator returned by ae_listLayerProperties.",
    )
    value: Union[
        AePropertyScalarInput,
        AePropertyVectorInput,
        AePropertyColorInput,
    ] = Field(
        ...,
        description="Typed scalar, 2/3 component vector, or ARGB color value.",
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description=(
            "Stable key for one property-write intent. Never reuse it for a new value."
        ),
    )


class _AeLayerPropertyKeyframeTargetArgs(_StrictModel):
    """Stable property locator plus exact composition time; never an array index."""

    model_config = ConfigDict(extra="forbid", strict=True)

    property_locator: AePropertyLocator = Field(
        ...,
        description="Leaf property locator returned by ae_listLayerProperties.",
    )
    time: AeCompositionTimeInput = Field(
        ...,
        description=(
            "Exact composition time as an int32 value and positive uint32 scale. "
            "The public contract intentionally does not accept a keyframe index."
        ),
    )


class _AeLayerPropertyKeyframeWriteArgs(_AeLayerPropertyKeyframeTargetArgs):
    model_config = ConfigDict(extra="forbid", strict=True)

    layer_locator: AeLayerLocator = Field(
        ...,
        description="Layer locator used to obtain property_locator.",
    )
    idempotency_key: str = Field(
        ...,
        min_length=16,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        description=(
            "Stable key for this one keyframe write intent; use a new key for a "
            "different target time or requested state."
        ),
    )

    @model_validator(mode="after")
    def _same_locator_context(self) -> "_AeLayerPropertyKeyframeWriteArgs":
        layer = self.layer_locator
        prop = self.property_locator
        if (
            layer.host_instance_id != prop.host_instance_id
            or layer.session_id != prop.session_id
            or layer.project_id != prop.project_id
            or layer.generation != prop.generation
        ):
            raise ValueError(
                "property_locator must share the layer_locator's current context"
            )
        return self


class AeGetLayerPropertyKeyframeDetailsArgs(_AeLayerPropertyKeyframeTargetArgs):
    """Read one native keyframe by stable property locator and exact time."""


class AeAddLayerPropertyKeyframeArgs(_AeLayerPropertyKeyframeWriteArgs):
    """Add one primitive native keyframe with a required initial value and Undo."""

    value: Union[
        AePropertyScalarInput,
        AePropertyVectorInput,
        AePropertyColorInput,
    ] = Field(
        ...,
        description="Typed initial scalar, 2/3 component vector, or ARGB color value.",
    )


class AeSetLayerPropertyKeyframeValueArgs(_AeLayerPropertyKeyframeWriteArgs):
    """Set one existing native keyframe value with verified readback and Undo."""

    value: Union[
        AePropertyScalarInput,
        AePropertyVectorInput,
        AePropertyColorInput,
    ] = Field(
        ...,
        description="Typed replacement scalar, 2/3 component vector, or ARGB color value.",
    )


class AeSetLayerPropertyKeyframeInterpolationArgs(
    _AeLayerPropertyKeyframeWriteArgs
):
    """Set explicit incoming and outgoing interpolation on one keyframe."""

    in_interpolation: Literal["linear", "bezier", "hold"] = Field(
        ...,
        description="Incoming temporal interpolation; choose exactly one enum value.",
    )
    out_interpolation: Literal["linear", "bezier", "hold"] = Field(
        ...,
        description="Outgoing temporal interpolation; choose exactly one enum value.",
    )


class AeKeyframeEaseInput(_StrictModel):
    """One native temporal-ease speed/influence pair as finite decimals."""

    model_config = ConfigDict(extra="forbid", strict=True)

    speed: str = Field(..., min_length=1, max_length=32, pattern=_PROPERTY_DECIMAL)
    influence: str = Field(
        ...,
        min_length=1,
        max_length=32,
        pattern=_PROPERTY_DECIMAL,
        description="Influence percentage in the inclusive range 0..100.",
    )

    @model_validator(mode="after")
    def _finite_ease(self) -> "AeKeyframeEaseInput":
        try:
            speed = Decimal(self.speed)
            influence = Decimal(self.influence)
            speed_binary = float(self.speed)
            influence_binary = float(self.influence)
        except (InvalidOperation, OverflowError, ValueError) as error:
            raise ValueError("keyframe ease values must be finite decimals") from error
        if (
            not speed.is_finite()
            or not influence.is_finite()
            or not math.isfinite(speed_binary)
            or not math.isfinite(influence_binary)
        ):
            raise ValueError("keyframe ease values must be finite decimals")
        for text, decimal_value, binary_value in (
            (self.speed, speed, speed_binary),
            (self.influence, influence, influence_binary),
        ):
            if binary_value == 0 and not decimal_value.is_zero():
                raise ValueError("keyframe ease values must not underflow binary64")
            if binary_value == 0 and text.startswith("-"):
                raise ValueError("keyframe ease values must normalize negative zero to 0")
        if influence < 0 or influence > 100:
            raise ValueError("keyframe ease influence must be within 0..100")
        return self


class AeKeyframeEaseDimensionInput(_StrictModel):
    """Ease for one zero-based property dimension."""

    model_config = ConfigDict(extra="forbid", strict=True)

    dimension: int = Field(..., ge=0, le=3)
    in_ease: AeKeyframeEaseInput
    out_ease: AeKeyframeEaseInput


class AeSetLayerPropertyKeyframeTemporalEaseArgs(
    _AeLayerPropertyKeyframeWriteArgs
):
    """Set typed temporal ease for every dimension of one native keyframe."""

    dimensions: List[AeKeyframeEaseDimensionInput] = Field(
        ...,
        min_length=1,
        max_length=4,
        description=(
            "One entry per property dimension, in contiguous zero-based order. "
            "Use one for scalar, two for 2D, three for 3D, and four for color."
        ),
    )

    @model_validator(mode="after")
    def _contiguous_dimensions(
        self,
    ) -> "AeSetLayerPropertyKeyframeTemporalEaseArgs":
        if [item.dimension for item in self.dimensions] != list(
            range(len(self.dimensions))
        ):
            raise ValueError("dimensions must be contiguous and zero-based")
        return self


class AeSetLayerPropertyKeyframeBehaviorArgs(_AeLayerPropertyKeyframeWriteArgs):
    """Toggle exactly one native keyframe behavior flag."""

    behavior: Literal[
        "temporal-continuous",
        "temporal-auto-bezier",
        "spatial-continuous",
        "spatial-auto-bezier",
        "roving",
    ] = Field(..., description="The single native keyframe behavior to change.")
    enabled: bool = Field(..., description="Required target state for that behavior.")


class AeDeleteLayerPropertyKeyframeArgs(_AeLayerPropertyKeyframeWriteArgs):
    """Delete one native keyframe selected by exact composition time with Undo."""


class AeLayersArgs(_StrictModel):
    """ae.layers — list layers in a comp (paginated)."""
    comp_id: Optional[str] = Field(
        None,
        description="AE comp id. Omit for the active comp.",
    )
    offset: int = Field(0, ge=0, description="Pagination offset (0-based).")
    limit: int = Field(
        0, ge=0, le=10000,
        description="Max layers to return; 0 (default) returns all (back-compat).",
    )
    format: OutputFormat = Field(
        "json",
        description="'json' (default, structured) or 'text' (compact paginated table).",
    )


class AeReadPropsArgs(_StrictModel):
    """ae.readProps — run read-only JSX and return its JSON.

    Caller supplies explicit JSX; the backend runs it via Backend.exec().
    Use this for ad-hoc reads not covered by the typed read verbs.
    """
    code: str = Field(
        ...,
        description="JSX source. Should end with a JSON.stringify(...) expression.",
    )


class AeExecArgs(_StrictModel):
    """ae.exec — run JSX under an undo group, return the last expression value."""
    code: str = Field(..., description="Full JSX source.")
    undo_group_name: Optional[str] = Field(
        None, description="Undo-stack label; helps identify scripted edits."
    )
    checkpoint_label: Optional[str] = Field(
        None, description="Non-empty: auto-create a checkpoint before run (skipped if backend.manages_checkpoints)."
    )
    timeout_sec: int = Field(
        30, ge=1, le=600, description="Per-call timeout in seconds (default 30)."
    )


CheckpointAction = Literal["create", "list"]


class AeCheckpointArgs(_StrictModel):
    """ae.checkpoint — create or list .aep snapshots."""
    action: CheckpointAction = Field(
        "list",
        description="'create' = save .aep snapshot; 'list' = enumerate existing.",
    )
    label: str = Field(
        "",
        description="Human-readable tag (used when action='create').",
    )
    limit: int = Field(
        20, ge=1, le=200,
        description="Max entries returned when action='list'.",
    )


class AeRevertArgs(_StrictModel):
    """ae.revert — revert to a previously saved checkpoint by id."""
    checkpoint_id: str = Field(..., description="Checkpoint id to revert to.")
    branch_before_revert: bool = Field(
        False, description="If true, branch current state before reverting."
    )


class AeSnapshotArgs(_StrictModel):
    """ae.snapshot — capture a PNG of the AE viewer (via active Snapshotter)."""
    out_path: Optional[str] = Field(
        None, description="PNG output path. Default: release/logs/integration_runs/ae_viewer_<ts>.png"
    )
    hwnd: Optional[str] = Field(
        None, description="Explicit child HWND ('0x...' or decimal). Overrides auto-pick."
    )
    main_window: bool = Field(
        False, description="If true, capture the whole AE main window instead of the viewer."
    )
    method: SnapshotMethod = Field(
        "DesktopCopy",
        description="Capture method hint forwarded to the active Snapshotter; meaning is implementation-defined.",
    )


class AePreviewFrameArgs(_StrictModel):
    """ae.previewFrame — render real AE comp frames to PNG files."""
    comp_id: Optional[str] = Field(
        None, description="AE comp id. Omit for the active comp."
    )
    time: Optional[float] = Field(
        None, ge=0, description="Single frame time in seconds. Ignored when times is set."
    )
    times: Optional[List[NonNegativeFloat]] = Field(
        None, description="Render multiple frame times in seconds."
    )
    out_dir: Optional[str] = Field(
        None, description="Output directory. Default: temp ae_mcp_previews session directory."
    )
    include_base64: bool = Field(
        False, description="Attach base64 PNG bytes to each returned frame."
    )
    scale: float = Field(
        1.0, gt=0, le=4,
        description=(
            "Output scale factor applied to the captured PNG (0<scale<=4). "
            "1.0 = native size; e.g. 0.5 returns a half-size image. The frame "
            "is captured at native size then resampled to scale before return."
        ),
    )
    repaint_delay_ms: int = Field(
        300, ge=0, le=5000,
        description=(
            "Milliseconds to wait between setting comp.time and capturing the "
            "viewer fallback, so AE's main thread has time to repaint at the "
            "new time. Ignored when saveFrameToPng writes the comp frame."
        ),
    )


class AeApplyEffectArgs(_StrictModel):
    """ae.applyEffect — apply an effect to a layer by match-name."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")
    layer_id: int = Field(..., ge=1, description="1-based layer index.")
    effect_match_name: str = Field(
        ...,
        description="Effect matchName, e.g. 'ADBE Gaussian Blur 2' or 'ADBE Drop Shadow'.",
    )


class AePingArgs(_StrictModel):
    """ae.ping — handshake smoke test for live diagnostics."""
    expect: str = Field("pong", description="String to echo back.")


# ---------------------------------------------------------------------------
# Typed 6 (Python builds JSX, dispatches via ae.exec)
# ---------------------------------------------------------------------------


class AeCreateLayerArgs(_StrictModel):
    """ae.createLayer — create a layer in a comp."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")
    type: LayerType = Field(..., description="Layer kind.")
    name: str = Field(..., min_length=1, description="Layer display name.")
    color: Optional[Tuple[float, float, float, float]] = Field(
        None, description="RGBA 0..1. Used by solid / shape / text colour fallback."
    )
    size: Optional[Tuple[float, float]] = Field(
        None, description="[w, h] pixels. Used by solid; defaults to comp size when omitted."
    )
    duration: Optional[float] = Field(
        None, gt=0, description="Layer duration (seconds). Defaults to comp duration."
    )
    position: Optional[Tuple[float, float, float]] = Field(
        None, description="[x, y, z] position on creation."
    )


class AeSetPropertyArgs(_StrictModel):
    """ae.setProperty — write a property on a layer by dotted path."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")
    layer_id: int = Field(..., ge=1, description="1-based layer index.")
    path: str = Field(
        ...,
        description="Property path like 'Transform/Position' or 'Effects/Gaussian Blur/Blurriness'.",
    )
    value: Any = Field(
        None,
        description="Scalar or array passed to setValue. Exactly one of value/expression is required.",
    )
    expression: Optional[str] = Field(
        None,
        min_length=1,
        description="AE expression text. Exactly one of value/expression is required.",
    )
    at_time: Optional[float] = Field(
        None,
        description=(
            "If set, writes a keyframe at this time (seconds; negative times "
            "are legal in AE). Omit to write the constant value."
        ),
    )

    @model_validator(mode="after")
    def validate_write_shape(self) -> "AeSetPropertyArgs":
        has_value = "value" in self.model_fields_set
        has_expression = "expression" in self.model_fields_set
        if has_value == has_expression:
            raise ValueError("exactly one of value or expression is required")
        if has_expression and self.expression is None:
            raise ValueError("expression must be a non-empty string")
        if has_expression and self.at_time is not None:
            raise ValueError("expression forbids at_time")
        return self


class AeMoveLayerArgs(_StrictModel):
    """ae.moveLayer — reorder a layer within its comp."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")
    layer_id: int = Field(..., ge=1, description="1-based layer index to move.")
    to_index: int = Field(..., ge=1, description="Target 1-based index.")


class AeSelectLayersArgs(_StrictModel):
    """ae.selectLayers — select layers in a comp."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")
    layer_ids: Union[List[int], Literal["all", "none"]] = Field(
        ..., description="List of layer indices, or the string 'all' / 'none'."
    )


class AeSetTimeArgs(_StrictModel):
    """ae.setTime — set comp current time (seconds)."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")
    time: float = Field(..., ge=0, description="Seconds from comp start.")


class AeGetTimeArgs(_StrictModel):
    """ae.getTime — read comp current time (seconds)."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")


class AeGetPropertiesArgs(_StrictModel):
    """ae.getProperties — search properties by name across selected layers."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active.")
    layer_ids: List[Annotated[int, Field(ge=1)]] = Field(..., min_length=1, description="1-based layer indices to scan.")
    query: str = Field(..., description="Multi-word AND; '|' separates OR groups. Terms match display name + matchName + English aliases for common transform/text/mask props. On localized (non-English) AE prefer matchName words, e.g. 'text document'.")
    offset: int = Field(0, ge=0, description="Pagination offset.")
    limit: int = Field(50, ge=1, le=500, description="Pagination size.")


class AeScanPropertyTreeArgs(_StrictModel):
    """ae.scanPropertyTree — deep DFS dump of one layer's property tree."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active.")
    layer_id: int = Field(..., ge=1, description="1-based layer index.")
    max_depth: int = Field(4, ge=1, le=10, description="DFS depth cap.")
    include_values: bool = Field(True, description="Set false to skip .value reads.")


class AeInspectPropertyCapabilitiesArgs(_StrictModel):
    """ae.inspectPropertyCapabilities — what can be mutated on a property path."""
    comp_id: Optional[str] = Field(None)
    layer_id: int = Field(..., ge=1)
    path: str = Field(..., description="'Transform/Position' style path.")


class AeGetExpressionsArgs(_StrictModel):
    """ae.getExpressions — read all expressions in a comp."""
    comp_id: str = Field(..., description="AE comp id (required).")
    layer_ids: Optional[List[int]] = Field(None, description="Restrict to these layers.")
    prop: Optional[str] = Field(None, description="matchName substring filter.")
    max_results: int = Field(200, ge=1, le=1000)


class AeValidateExpressionsArgs(_StrictModel):
    """ae.validateExpressions — force-evaluate expressions and report errors."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")
    layer_ids: Optional[List[int]] = Field(None, description="Restrict to these layers.")
    prop: Optional[str] = Field(None, description="matchName/name substring filter.")
    sample_times: Optional[List[NonNegativeFloat]] = Field(
        None, description="Times to evaluate. Default: current comp time."
    )
    max_results: int = Field(500, ge=1, le=2000)


class AeGetKeyframesArgs(_StrictModel):
    """ae.getKeyframes — keyframe data for a property path."""
    comp_id: Optional[str] = Field(None)
    layer_id: int = Field(..., ge=1)
    path: str = Field(...)


SearchScope = Literal["layers", "expressions", "effects", "comps", "items"]
SkillTemplateType = Literal["jsx", "prompt"]
SkillName = constr(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
RigType = Literal["transform_controller", "effect_controls", "puppet_pin_nulls", "apply_preset"]
RigControlType = Literal["slider", "angle", "checkbox", "color"]


class RigControl(_StrictModel):
    """A single expression control for createRig's effect_controls rig.

    Each control becomes a native AE expression-control effect on the
    controller (Slider/Angle/Checkbox/Color) wired to drive `property`.
    """
    name: str = Field(
        ..., min_length=1, description="Control display name (also the effect name)."
    )
    type: RigControlType = Field(
        "slider", description="Control kind -> native AE expression control."
    )
    property: str = Field(
        "Transform/Opacity",
        description=(
            "Target property to drive. Currently wired for the transform paths "
            "Transform/Position|Scale|Rotation|Opacity."
        ),
    )


class AeSearchProjectArgs(_StrictModel):
    """ae.searchProject — fuzzy search across the whole project."""
    query: str = Field(..., description="Multi-word AND; '|' OR groups.")
    scope: List[SearchScope] = Field(
        default_factory=lambda: ["layers", "expressions", "effects", "comps", "items"],
        description="Which kinds of objects to scan.",
    )
    limit: int = Field(100, ge=1, le=500)


class AeSkillListArgs(_StrictModel):
    """ae.skillList — list stored reusable prompt/JSX skills."""
    include_templates: bool = Field(
        False, description="When true, include full template and args_schema."
    )


class AeSkillCreateArgs(_StrictModel):
    """ae.skillCreate — create a reusable local skill JSON file."""
    name: SkillName = Field(..., description="Skill id: letters, numbers, dash, underscore.")
    description: str = Field("", description="Short human description.")
    template_type: SkillTemplateType = Field("jsx", description="'jsx' or 'prompt'.")
    template: str = Field(..., min_length=1, description="Template text using ${arg} placeholders.")
    args_schema: Dict[str, Dict[str, Any]] = Field(
        default_factory=dict, description="Small JSON schema-ish arg metadata."
    )
    overwrite: bool = Field(False, description="Replace existing skill when true.")


class AeSkillEditArgs(_StrictModel):
    """ae.skillEdit — update an existing reusable skill."""
    name: SkillName = Field(..., description="Existing skill name.")
    description: Optional[str] = Field(None)
    template_type: Optional[SkillTemplateType] = Field(None)
    template: Optional[str] = Field(None, min_length=1)
    args_schema: Optional[Dict[str, Dict[str, Any]]] = Field(None)


class AeSkillDeleteArgs(_StrictModel):
    """ae.skillDelete — delete a stored local skill."""
    name: SkillName = Field(..., description="Skill name to delete.")


class AeSkillUseArgs(_StrictModel):
    """ae.skillUse — render a skill, optionally executing JSX skills in AE."""
    name: SkillName = Field(..., description="Skill name to render/use.")
    args: Dict[str, Any] = Field(default_factory=dict, description="Template argument values.")
    execute: bool = Field(False, description="When true, execute rendered JSX in AE.")


ToolArtifactKind = Literal[
    "jsx", "expression", "prompt-skill", "recipe", "diagnostic"
]
PanelToolArtifactKind = Literal[
    "jsx", "expression", "prompt-skill", "recipe", "diagnostic", "system-command"
]
ToolArtifactStatus = Literal["candidate", "saved", "pinned", "archived", "deprecated"]
ToolArtifactRisk = Literal["read", "write", "destructive", "external"]
ToolArtifactOperation = Literal["render", "execute", "apply"]
ToolSourceType = Literal["user", "legacy", "bundled", "chat-tool-call", "imported"]


class AeToolIndexArgs(_StrictModel):
    """ae.toolIndex — list lightweight Tool Library summaries."""
    kinds: Optional[List[ToolArtifactKind]] = None
    statuses: Optional[List[ToolArtifactStatus]] = None
    source_types: Optional[List[ToolSourceType]] = None
    include_candidates: bool = False
    limit: int = Field(100, ge=1, le=1000)


class AeToolSearchArgs(_StrictModel):
    """ae.toolSearch — search lightweight Tool Library summaries."""
    query: str = Field(..., max_length=512)
    kinds: Optional[List[ToolArtifactKind]] = None
    categories: Optional[List[str]] = None
    tags: Optional[List[str]] = None
    risks: Optional[List[ToolArtifactRisk]] = None
    statuses: Optional[List[ToolArtifactStatus]] = None
    source_types: Optional[List[ToolSourceType]] = None
    offset: int = Field(0, ge=0)
    limit: int = Field(50, ge=1, le=1000)


class AeToolInspectArgs(_StrictModel):
    """ae.toolInspect — read one full Tool Library artifact as untrusted content."""
    artifact_id: str = Field(..., min_length=1, max_length=256)


class AePanelToolIndexArgs(AeToolIndexArgs):
    """Private panel-only index schema; never advertised through tools/list."""

    kinds: Optional[List[PanelToolArtifactKind]] = None


class AePanelToolSearchArgs(AeToolSearchArgs):
    """Private panel-only search schema; never advertised through tools/list."""

    kinds: Optional[List[PanelToolArtifactKind]] = None


class AeToolUseArgs(_StrictModel):
    """ae.toolUse — render or run the hash-bound execution protocol."""
    artifact_id: Optional[str] = Field(None, min_length=1, max_length=256)
    action: Literal[
        "render", "prepare", "grant", "execute", "start", "status", "cancel", "history"
    ]
    operation: Optional[ToolArtifactOperation] = None
    args: Dict[str, Any] = Field(default_factory=dict)
    target: Dict[str, Any] = Field(default_factory=dict)
    plan_hash: Optional[str] = Field(None, min_length=1, max_length=256)
    grant_id: Optional[str] = Field(None, min_length=1, max_length=256)
    grant_scope: Optional[Literal["once", "session"]] = None
    execution_id: Optional[str] = Field(None, min_length=1, max_length=256)
    operation_id: Optional[str] = Field(
        None,
        min_length=16,
        max_length=128,
        description=(
            "Stable caller-generated id for execute/start. Reuse it only for the "
            "same planHash after a lost response or across Core clients; the server "
            "returns the existing execution. A different planHash conflicts, while "
            "changing operation_id authorizes a distinct execution."
        ),
    )
    limit: Optional[int] = Field(None, ge=1, le=100)

    @model_validator(mode="after")
    def validate_action_shape(self) -> "AeToolUseArgs":
        if self.action == "render":
            if (
                self.artifact_id is None
                or self.plan_hash is not None
                or self.grant_id is not None
            ):
                raise ValueError("render requires artifact_id and forbids plan_hash/grant_id")
            if (
                self.grant_scope is not None
                or self.target
                or self.execution_id is not None
                or self.operation_id is not None
                or self.limit is not None
            ):
                raise ValueError(
                    "render forbids grant_scope/target/execution_id/operation_id/limit"
                )
            if self.operation not in {None, "render"}:
                raise ValueError("render operation must be render")
            self.operation = "render"
        elif self.action == "prepare":
            if self.artifact_id is None or self.operation is None:
                raise ValueError("prepare requires artifact_id and operation")
            if any(
                value is not None
                for value in (
                    self.plan_hash,
                    self.grant_id,
                    self.grant_scope,
                    self.execution_id,
                    self.operation_id,
                    self.limit,
                )
            ):
                raise ValueError(
                    "prepare forbids plan_hash/grant_id/grant_scope/"
                    "execution_id/operation_id/limit"
                )
        elif self.action == "grant":
            if self.plan_hash is None or self.grant_scope is None:
                raise ValueError("grant requires plan_hash and grant_scope")
            if any(
                value is not None
                for value in (
                    self.artifact_id,
                    self.grant_id,
                    self.execution_id,
                    self.operation_id,
                    self.limit,
                )
            ):
                raise ValueError(
                    "grant forbids artifact_id/grant_id/execution_id/operation_id/limit"
                )
            if self.operation is not None or self.args or self.target:
                raise ValueError("grant forbids operation/args/target")
        elif self.action in {"execute", "start"}:
            if self.plan_hash is None or self.grant_id is None:
                raise ValueError(f"{self.action} requires plan_hash and grant_id")
            if self.operation_id is None:
                raise ValueError(f"{self.action} requires operation_id")
            if any(
                value is not None
                for value in (
                    self.artifact_id,
                    self.grant_scope,
                    self.execution_id,
                    self.limit,
                )
            ):
                raise ValueError(
                    f"{self.action} forbids artifact_id/grant_scope/execution_id/limit"
                )
            if self.operation is not None or self.args or self.target:
                raise ValueError(f"{self.action} forbids operation/args/target")
        elif self.action in {"status", "cancel"}:
            if self.execution_id is None:
                raise ValueError(f"{self.action} requires execution_id")
            if (
                any(
                    value is not None
                    for value in (
                        self.artifact_id,
                        self.operation,
                        self.plan_hash,
                        self.grant_id,
                        self.grant_scope,
                        self.operation_id,
                        self.limit,
                    )
                )
                or self.args
                or self.target
            ):
                raise ValueError(f"{self.action} accepts execution_id only")
        else:
            if self.artifact_id is None:
                raise ValueError("history requires artifact_id")
            if (
                any(
                    value is not None
                    for value in (
                        self.operation,
                        self.plan_hash,
                        self.grant_id,
                        self.grant_scope,
                        self.execution_id,
                        self.operation_id,
                    )
                )
                or self.args
                or self.target
            ):
                raise ValueError("history accepts artifact_id and limit only")
            if self.limit is None:
                self.limit = 20
        return self


class AeToolCreateArgs(_StrictModel):
    """ae.toolCreate — create a native user Tool Library artifact."""
    name: str = Field(..., min_length=1, max_length=128)
    description: str = Field("", max_length=4096)
    kind: ToolArtifactKind
    category: str = Field("workflow", min_length=1, max_length=128)
    tags: List[str] = Field(default_factory=list, max_length=32)
    compatibility: Dict[str, Any] = Field(default_factory=dict)
    declared_risk: ToolArtifactRisk = "write"
    status: Literal["candidate", "saved"] = "saved"
    content: Any
    args_schema: Dict[str, Any] = Field(default_factory=dict)
    expected_store_revision: Optional[int] = Field(None, ge=0)


class AeToolEditArgs(_StrictModel):
    """ae.toolEdit — CAS-edit one Tool Library artifact."""
    artifact_id: str = Field(..., min_length=1, max_length=256)
    changes: Dict[str, Any] = Field(..., min_length=1)
    expected_revision: int = Field(..., ge=1)
    expected_content_hash: str = Field(..., min_length=64, max_length=64)
    replace_artifact_id: Optional[str] = Field(None, min_length=1, max_length=256)

    @model_validator(mode="after")
    def validate_edit_shape(self) -> "AeToolEditArgs":
        allowed = {
            "name", "description", "kind", "category", "tags", "compatibility",
            "declared_risk", "declaredRisk", "status", "content", "args_schema",
            "argsSchema", "verification_action", "verificationAction",
        }
        if not set(self.changes).issubset(allowed):
            raise ValueError("changes contain unsupported fields")
        verification = self.changes.get(
            "verification_action", self.changes.get("verificationAction")
        )
        if verification is not None and verification not in {"mark-reviewed", "clear"}:
            raise ValueError("verification_action is invalid")
        if self.replace_artifact_id is not None and self.changes.get("status") != "saved":
            raise ValueError("replacement is valid only while promoting a candidate")
        return self


class _ToolCasMutationArgs(_StrictModel):
    artifact_id: str = Field(..., min_length=1, max_length=256)
    expected_revision: int = Field(..., ge=1)
    expected_content_hash: str = Field(..., min_length=64, max_length=64)


class AeToolDeleteArgs(_ToolCasMutationArgs):
    """ae.toolDelete — permanently delete one user Tool Library artifact."""


class AeToolArchiveArgs(_ToolCasMutationArgs):
    """ae.toolArchive — archive one Tool Library artifact."""


class AeToolDuplicateArgs(_ToolCasMutationArgs):
    """ae.toolDuplicate — copy an exact artifact into the native user store."""
    name: str = Field(..., min_length=1, max_length=128)


class AeToolPromoteFromHistoryArgs(_ToolCasMutationArgs):
    """ae.toolPromoteFromHistory — promote a candidate artifact to saved."""
    replace_artifact_id: Optional[str] = Field(None, min_length=1, max_length=256)


class AeToolImportArgs(_StrictModel):
    """ae.toolImport — preview, commit, or discard a quarantined package import."""
    action: Literal["preview", "commit", "discard"]
    path: Optional[str] = Field(None, min_length=1, max_length=32768)
    import_id: Optional[str] = Field(None, min_length=1, max_length=256)
    resolutions: Dict[str, Literal["keep", "duplicate"]] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_import_shape(self) -> "AeToolImportArgs":
        if self.action == "preview":
            if self.path is None or self.import_id is not None or self.resolutions:
                raise ValueError("preview requires path only")
        elif self.action == "commit":
            if self.import_id is None or self.path is not None:
                raise ValueError("commit requires import_id and forbids path")
        elif self.import_id is None or self.path is not None or self.resolutions:
            raise ValueError("discard requires import_id only")
        return self


class AeToolExportArgs(_StrictModel):
    """ae.toolExport — write a deterministic Tool Library package."""
    artifact_ids: List[str] = Field(..., min_length=1, max_length=511)
    out_path: str = Field(..., min_length=1, max_length=32768)


class AeCreateRigArgs(_StrictModel):
    """ae.createRig — create controller/expression rigs or apply an AE preset."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for the active comp.")
    target_layer_id: int = Field(1, ge=1, description="1-based target layer index.")
    rig_type: RigType = Field("transform_controller", description="Rig workflow to create.")
    name: str = Field("Controller", min_length=1, description="Controller layer/effect name.")
    controls: Optional[List[RigControl]] = Field(
        None,
        description=(
            "For rig_type='effect_controls': typed list of expression controls to "
            "build. Merged into options['controls'] (takes precedence over a raw "
            "options['controls'])."
        ),
    )
    options: Dict[str, Any] = Field(default_factory=dict, description="Rig-type-specific options.")


class AeStatusArgs(_StrictModel):
    """ae.status — diagnose the ae-mcp install: backend selection result (with install hints when missing), installed backends, snapshotter availability. Call this first when other AE tools are missing or failing."""
    pass


class AeDiagnoseArgs(_StrictModel):
    """ae.diagnose — end-to-end connection self-check for external MCP clients: host reachable, Python bridge handshake seen, auth token valid, AE responsive + project open. Works even when backend selection fails. Call after wiring ae-mcp into a client to verify the full chain in one shot."""
    pass


# ---------------------------------------------------------------------------
# Registry of verb -> schema (handlers.core / handlers.typed reference this)
# ---------------------------------------------------------------------------


SCHEMAS = {
    "ae.init": AeInitArgs,
    "ae.overview": AeOverviewArgs,
    "ae.projectSummary": AeProjectSummaryArgs,
    "ae.getProjectBitDepth": AeGetProjectBitDepthArgs,
    "ae.setProjectBitDepth": AeSetProjectBitDepthArgs,
    "ae.listProjectItems": AeListProjectItemsArgs,
    "ae.listCompositionLayers": AeListCompositionLayersArgs,
    "ae.listSelectedLayers": AeListSelectedLayersArgs,
    "ae.getCompositionTime": AeGetCompositionTimeArgs,
    "ae.setCompositionTime": AeSetCompositionTimeArgs,
    "ae.createComposition": AeCreateCompositionArgs,
    "ae.createCompositionLayer": AeCreateCompositionLayerArgs,
    "ae.applyLayerEffect": AeApplyLayerEffectArgs,
    "ae.listLayerProperties": AeListLayerPropertiesArgs,
    "ae.listLayerPropertyKeyframes": AeListLayerPropertyKeyframesArgs,
    "ae.setLayerPropertyValue": AeSetLayerPropertyValueArgs,
    "ae.getLayerTransform": AeGetLayerTransformArgs,
    "ae.setLayerAnchorPoint": AeSetLayerAnchorPointArgs,
    "ae.setLayerPosition": AeSetLayerPositionArgs,
    "ae.setLayerScale": AeSetLayerScaleArgs,
    "ae.setLayerRotation": AeSetLayerRotationArgs,
    "ae.setLayerOpacity": AeSetLayerOpacityArgs,
    "ae.setLayerOrientation": AeSetLayerOrientationArgs,
    "ae.getLayerPropertyKeyframeDetails": AeGetLayerPropertyKeyframeDetailsArgs,
    "ae.addLayerPropertyKeyframe": AeAddLayerPropertyKeyframeArgs,
    "ae.setLayerPropertyKeyframeValue": AeSetLayerPropertyKeyframeValueArgs,
    "ae.setLayerPropertyKeyframeInterpolation": AeSetLayerPropertyKeyframeInterpolationArgs,
    "ae.setLayerPropertyKeyframeTemporalEase": AeSetLayerPropertyKeyframeTemporalEaseArgs,
    "ae.setLayerPropertyKeyframeBehavior": AeSetLayerPropertyKeyframeBehaviorArgs,
    "ae.deleteLayerPropertyKeyframe": AeDeleteLayerPropertyKeyframeArgs,
    "ae.layers": AeLayersArgs,
    "ae.readProps": AeReadPropsArgs,
    "ae.exec": AeExecArgs,
    "ae.checkpoint": AeCheckpointArgs,
    "ae.revert": AeRevertArgs,
    "ae.snapshot": AeSnapshotArgs,
    "ae.previewFrame": AePreviewFrameArgs,
    "ae.applyEffect": AeApplyEffectArgs,
    "ae.ping": AePingArgs,
    "ae.status": AeStatusArgs,
    "ae.diagnose": AeDiagnoseArgs,
    "ae.createLayer": AeCreateLayerArgs,
    "ae.setProperty": AeSetPropertyArgs,
    "ae.moveLayer": AeMoveLayerArgs,
    "ae.selectLayers": AeSelectLayersArgs,
    "ae.setTime": AeSetTimeArgs,
    "ae.getTime": AeGetTimeArgs,
    "ae.getProperties": AeGetPropertiesArgs,
    "ae.scanPropertyTree": AeScanPropertyTreeArgs,
    "ae.inspectPropertyCapabilities": AeInspectPropertyCapabilitiesArgs,
    "ae.getExpressions": AeGetExpressionsArgs,
    "ae.validateExpressions": AeValidateExpressionsArgs,
    "ae.getKeyframes": AeGetKeyframesArgs,
    "ae.searchProject": AeSearchProjectArgs,
    "ae.skillList": AeSkillListArgs,
    "ae.skillCreate": AeSkillCreateArgs,
    "ae.skillEdit": AeSkillEditArgs,
    "ae.skillDelete": AeSkillDeleteArgs,
    "ae.skillUse": AeSkillUseArgs,
    "ae.toolIndex": AeToolIndexArgs,
    "ae.toolSearch": AeToolSearchArgs,
    "ae.toolInspect": AeToolInspectArgs,
    "ae.toolUse": AeToolUseArgs,
    "ae.toolCreate": AeToolCreateArgs,
    "ae.toolEdit": AeToolEditArgs,
    "ae.toolDelete": AeToolDeleteArgs,
    "ae.toolArchive": AeToolArchiveArgs,
    "ae.toolDuplicate": AeToolDuplicateArgs,
    "ae.toolPromoteFromHistory": AeToolPromoteFromHistoryArgs,
    "ae.toolImport": AeToolImportArgs,
    "ae.toolExport": AeToolExportArgs,
    "ae.createRig": AeCreateRigArgs,
}

assert len(SCHEMAS) == 72, f"expected 72 verbs, got {len(SCHEMAS)}"
