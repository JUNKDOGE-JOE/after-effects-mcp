"""Strict Core adapter for grouped native effect, mask, and footage operations.

The native host groups these operations into one read and one write
capability so they share suite acquisition, session binding, and evidence.
Public MCP handlers remain operation-specific and this adapter validates the
closed result shape again before returning it.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any, Literal, Mapping

from pydantic import Field, StrictBool, StrictInt, StrictStr, ValidationError, model_validator

from ae_mcp.backends.native import (
    CapabilityDetail,
    DecimalString,
    NativeBackendError,
    NativeCancellationToken,
    NativeCapabilityDescriptor,
    NativeExecutionEvidence,
    NativeInvokeBackend,
    NativeInvokeRequest,
    NativeInvokeResult,
    NativeLocator,
    NativeNegotiation,
    NativeRecovery,
    RequestId,
    _NativeModel,
    _capabilities_query_digest,
    _capabilities_registry_digest,
    _ensure_active,
    _invoke_native_read_request,
    _invoke_request_digest,
    _sha256_closed_json,
    _structured_error,
    _validate_invoke_error_binding,
)
from ae_mcp.backends.native_project_composition import (
    CAPABILITY_VERSION,
    CapabilityContract,
    IdempotencyKey,
    _ReadExecution,
    _WriteExecution,
    _descriptor_validator,
)


NATIVE_MEDIA_READ_CAPABILITY_ID = "ae.native.media.read"
NATIVE_MEDIA_WRITE_CAPABILITY_ID = "ae.native.media.write"

ReadOperation = Literal[
    "effects-installed-list",
    "effects-layer-list",
    "effect-details",
    "masks-list",
    "mask-details",
    "mask-path",
    "footage-details",
    "footage-interpretation",
]
WriteOperation = Literal[
    "effect-enabled",
    "effect-reorder",
    "effect-duplicate",
    "effect-delete",
    "mask-create",
    "mask-properties",
    "mask-path",
    "mask-duplicate",
    "mask-delete",
    "footage-import",
    "footage-replace",
    "footage-interpretation",
    "footage-proxy",
    "item-use-proxy",
]
MediaOperation = ReadOperation | WriteOperation

_READ_OPERATIONS = [
    "effects-installed-list",
    "effects-layer-list",
    "effect-details",
    "masks-list",
    "mask-details",
    "mask-path",
    "footage-details",
    "footage-interpretation",
]
_WRITE_OPERATIONS = [
    "effect-enabled",
    "effect-reorder",
    "effect-duplicate",
    "effect-delete",
    "mask-create",
    "mask-properties",
    "mask-path",
    "mask-duplicate",
    "mask-delete",
    "footage-import",
    "footage-replace",
    "footage-interpretation",
    "footage-proxy",
    "item-use-proxy",
]


def _contract_schema(operations: list[str], *, write: bool, result: bool) -> dict[str, Any]:
    kind = "result" if result else "argument"
    return {
        "additionalProperties": True,
        "properties": {"operation": {"enum": operations}},
        "required": ["operation"],
        "type": "object",
        "x-invariant": (
            "the-operation-discriminator-selects-one-closed-"
            f"{'write' if write else 'read'}-{kind}-shape-"
            f"{'validated-again-by-the-public-Core-adapter' if result else 'enforced-by-the-compiled-codec'}"
        ),
    }


CAPABILITY_CONTRACTS = {
    NATIVE_MEDIA_READ_CAPABILITY_ID: CapabilityContract(
        NATIVE_MEDIA_READ_CAPABILITY_ID,
        "Execute one closed native effect, mask, or footage read.",
        "read",
        "idempotent",
        "Reads bounded After Effects effect, mask, or footage state without changing it.",
        (
            "An After Effects project must be open.",
            "The operation-specific locators must belong to the current native session.",
        ),
        "aemcp.requirement.native.media-read",
        _contract_schema(_READ_OPERATIONS, write=False, result=False),
        _contract_schema(_READ_OPERATIONS, write=False, result=True),
        "native-media-read",
    ),
    NATIVE_MEDIA_WRITE_CAPABILITY_ID: CapabilityContract(
        NATIVE_MEDIA_WRITE_CAPABILITY_ID,
        "Execute one closed native effect, mask, or footage mutation.",
        "write",
        "idempotency-key",
        "Changes one bounded After Effects media-editing target and creates one Undo step.",
        (
            "An After Effects project must be open.",
            "The operation-specific locators must belong to the current native session.",
        ),
        "aemcp.requirement.native.media-write",
        _contract_schema(_WRITE_OPERATIONS, write=True, result=False),
        _contract_schema(_WRITE_OPERATIONS, write=True, result=True),
        "native-media-write",
    ),
}


SafeIndex = Annotated[StrictInt, Field(ge=1, le=9_007_199_254_740_991)]
SafeCount = Annotated[StrictInt, Field(ge=0, le=9_007_199_254_740_991)]
EffectKey = Annotated[StrictInt, Field(ge=-9_007_199_254_740_991, le=9_007_199_254_740_991)]
class MediaColor(_NativeModel):
    red: Annotated[StrictInt, Field(ge=0, le=255)]
    green: Annotated[StrictInt, Field(ge=0, le=255)]
    blue: Annotated[StrictInt, Field(ge=0, le=255)]
    alpha: Annotated[StrictInt, Field(ge=0, le=255)]


class MediaRatio(_NativeModel):
    numerator: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]
    denominator: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]


class MediaDuration(_NativeModel):
    value: Annotated[StrictInt, Field(ge=-2_147_483_648, le=2_147_483_647)]
    scale: Annotated[StrictInt, Field(ge=1, le=4_294_967_295)]


class MediaSequence(_NativeModel):
    enabled: StrictBool
    force_alphabetical: StrictBool | None = None
    start_frame: Annotated[StrictInt, Field(ge=0, le=2_147_483_647)] | None = None
    end_frame: Annotated[StrictInt, Field(ge=0, le=2_147_483_647)] | None = None

    @model_validator(mode="after")
    def _valid_sequence(self) -> "MediaSequence":
        if not self.enabled and (
            self.force_alphabetical is True
            or self.start_frame is not None
            or self.end_frame is not None
        ):
            raise ValueError("disabled sequence cannot include sequence options")
        if (
            self.start_frame is not None
            and self.end_frame is not None
            and self.end_frame < self.start_frame
        ):
            raise ValueError("sequence endFrame precedes startFrame")
        return self


class MaskPropertiesPatch(_NativeModel):
    mode: Literal["none", "add", "subtract", "intersect", "lighten", "darken", "difference"] | None = None
    inverted: StrictBool | None = None
    motion_blur: Literal["same-as-layer", "off", "on"] | None = None
    feather_falloff: Literal["smooth", "linear"] | None = None
    color: MediaColor | None = None
    locked: StrictBool | None = None
    roto_bezier: StrictBool | None = None

    @model_validator(mode="after")
    def _non_empty(self) -> "MaskPropertiesPatch":
        if not self.model_fields_set or not any(
            getattr(self, field) is not None for field in self.model_fields_set
        ):
            raise ValueError("properties must contain at least one requested field")
        return self


class MaskVertex(_NativeModel):
    position: tuple[DecimalString, DecimalString]
    in_tangent: tuple[DecimalString, DecimalString]
    out_tangent: tuple[DecimalString, DecimalString]


class FootageInterpretationPatch(_NativeModel):
    loop_count: Annotated[StrictInt, Field(ge=1, le=4_294_967_295)] | None = None
    pixel_aspect: MediaRatio | None = None
    native_fps: DecimalString | None = None
    conform_fps: DecimalString | None = None
    alpha_mode: Literal["straight", "premultiplied", "ignore"] | None = None
    premultiply_color: MediaColor | None = None

    @model_validator(mode="after")
    def _valid_patch(self) -> "FootageInterpretationPatch":
        if not self.model_fields_set or not any(
            getattr(self, field) is not None for field in self.model_fields_set
        ):
            raise ValueError("interpretation must contain at least one requested field")
        if self.premultiply_color is not None and self.alpha_mode != "premultiplied":
            raise ValueError("premultiplyColor requires alphaMode premultiplied")
        for text in (self.native_fps, self.conform_fps):
            if text is not None and Decimal(text) < 0:
                raise ValueError("frame rates must be non-negative")
        return self


_ARGUMENT_FIELDS: dict[str, tuple[set[str], set[str]]] = {
    "effects-installed-list": ({"operation", "offset", "limit"}, set()),
    "effects-layer-list": ({"operation", "layer_locator", "offset", "limit"}, set()),
    "effect-details": ({"operation", "layer_locator", "effect_index", "installed_effect_key"}, set()),
    "masks-list": ({"operation", "layer_locator", "offset", "limit"}, set()),
    "mask-details": ({"operation", "layer_locator", "mask_index", "mask_id"}, set()),
    "mask-path": ({"operation", "layer_locator", "mask_index", "mask_id"}, {"closed", "vertices", "idempotency_key"}),
    "footage-details": ({"operation", "item_locator"}, set()),
    "footage-interpretation": ({"operation", "item_locator", "proxy"}, {"interpretation", "idempotency_key"}),
    "effect-enabled": ({"operation", "layer_locator", "effect_index", "installed_effect_key", "enabled", "idempotency_key"}, set()),
    "effect-reorder": ({"operation", "layer_locator", "effect_index", "installed_effect_key", "target_index", "idempotency_key"}, set()),
    "effect-duplicate": ({"operation", "layer_locator", "effect_index", "installed_effect_key", "idempotency_key"}, set()),
    "effect-delete": ({"operation", "layer_locator", "effect_index", "installed_effect_key", "idempotency_key"}, set()),
    "mask-create": ({"operation", "layer_locator", "idempotency_key"}, set()),
    "mask-properties": ({"operation", "layer_locator", "mask_index", "mask_id", "properties", "idempotency_key"}, set()),
    "mask-duplicate": ({"operation", "layer_locator", "mask_index", "mask_id", "target_index", "idempotency_key"}, set()),
    "mask-delete": ({"operation", "layer_locator", "mask_index", "mask_id", "idempotency_key"}, set()),
    "footage-import": ({"operation", "source_path", "idempotency_key"}, {"folder_locator", "sequence"}),
    "footage-replace": ({"operation", "item_locator", "source_path", "idempotency_key"}, {"sequence"}),
    "footage-proxy": ({"operation", "item_locator", "source_path", "idempotency_key"}, {"sequence"}),
    "item-use-proxy": ({"operation", "item_locator", "enabled", "idempotency_key"}, set()),
}


class NativeMediaArguments(_NativeModel):
    operation: MediaOperation
    layer_locator: NativeLocator | None = None
    item_locator: NativeLocator | None = None
    folder_locator: NativeLocator | None = None
    offset: Annotated[StrictInt, Field(ge=0, le=9_007_199_254_740_991)] | None = None
    limit: Annotated[StrictInt, Field(ge=1, le=100)] | None = None
    effect_index: SafeIndex | None = None
    installed_effect_key: EffectKey | None = None
    mask_index: SafeIndex | None = None
    mask_id: EffectKey | None = None
    target_index: SafeIndex | None = None
    enabled: StrictBool | None = None
    properties: MaskPropertiesPatch | None = None
    closed: StrictBool | None = None
    vertices: list[MaskVertex] | None = None
    source_path: Annotated[StrictStr, Field(min_length=1, max_length=1024)] | None = None
    sequence: MediaSequence | None = None
    proxy: StrictBool | None = None
    interpretation: FootageInterpretationPatch | None = None
    idempotency_key: IdempotencyKey | None = None

    @model_validator(mode="after")
    def _closed_operation(self) -> "NativeMediaArguments":
        required, optional = _ARGUMENT_FIELDS[self.operation]
        fields = set(self.model_fields_set)
        if not required.issubset(fields) or not fields.issubset(required | optional):
            raise ValueError(f"{self.operation} arguments are not closed")
        if any(getattr(self, field) is None for field in required):
            raise ValueError(f"{self.operation} required arguments must not be null")
        if self.installed_effect_key == 0 or self.mask_id == 0:
            raise ValueError("stable effect and mask references must be non-zero")
        if self.operation == "mask-path":
            write = self.idempotency_key is not None
            if write != (self.closed is not None and self.vertices is not None):
                raise ValueError("mask-path write requires closed, vertices, and idempotencyKey")
            if write and len(self.vertices or ()) < (3 if self.closed else 2):
                raise ValueError("mask path has too few vertices")
            if self.vertices is not None and len(self.vertices) > 128:
                raise ValueError("mask path has too many vertices")
        if self.operation == "footage-interpretation":
            write = self.idempotency_key is not None
            if write != (self.interpretation is not None):
                raise ValueError("footage interpretation write requires interpretation and idempotencyKey")
        for locator, kind in (
            (self.layer_locator, "layer"),
            (self.folder_locator, "item"),
        ):
            if locator is not None and locator.kind != kind:
                raise ValueError(f"locator must have kind {kind}")
        if self.item_locator is not None and self.item_locator.kind not in {"item", "composition"}:
            raise ValueError("itemLocator must identify a project item")
        if self.source_path is not None and (
            "\x00" in self.source_path
            or any(0xD800 <= ord(character) <= 0xDFFF for character in self.source_path)
        ):
            raise ValueError("sourcePath must contain bounded Unicode scalar values")
        return self

    def wire_payload(self) -> dict[str, Any]:
        return self.model_dump(
            mode="json",
            by_alias=True,
            include=self.model_fields_set,
            exclude_none=False,
        )


class InstalledEffect(_NativeModel):
    display_name: Annotated[StrictStr, Field(max_length=255)]
    match_name: Annotated[StrictStr, Field(max_length=255)]
    category: Annotated[StrictStr, Field(max_length=255)]
    installed_effect_key: EffectKey


class LayerEffect(InstalledEffect):
    effect_index: SafeIndex
    active: StrictBool
    audio_only: StrictBool
    audio_too: StrictBool
    missing: StrictBool


class LayerMask(_NativeModel):
    mask_index: SafeIndex
    mask_id: EffectKey
    mode: Literal["none", "add", "subtract", "intersect", "lighten", "darken", "difference"]
    inverted: StrictBool
    motion_blur: Literal["same-as-layer", "off", "on"]
    feather_falloff: Literal["smooth", "linear"]
    color: MediaColor
    locked: StrictBool
    roto_bezier: StrictBool


class MaskPath(_NativeModel):
    closed: StrictBool
    vertices: Annotated[list[MaskVertex], Field(max_length=128)]

    @model_validator(mode="after")
    def _valid_path(self) -> "MaskPath":
        minimum = 3 if self.closed else 2
        if self.vertices and len(self.vertices) < minimum:
            raise ValueError("mask path has too few vertices")
        return self


class FootageInterpretation(_NativeModel):
    loop_count: Annotated[StrictInt, Field(ge=1, le=4_294_967_295)]
    pixel_aspect: MediaRatio
    native_fps: DecimalString
    conform_fps: DecimalString
    alpha_mode: Literal["straight", "premultiplied", "ignore"]
    premultiply_color: MediaColor


_VALUE_FIELDS: dict[str, set[str]] = {
    "effects-installed-list": {"operation", "effects", "total", "offset", "limit", "returned", "has_more", "next_offset"},
    "effects-layer-list": {"operation", "layer_locator", "effects", "total", "offset", "limit", "returned", "has_more", "next_offset"},
    "effect-details": {"operation", "layer_locator", "effect"},
    "effect-enabled": {"operation", "before_enabled", "after_enabled", "changed", "effect_index", "installed_effect_key"},
    "effect-reorder": {"operation", "before_count", "after_count", "changed", "installed_effect_key", "layer_locator", "before_index", "after_index"},
    "effect-duplicate": {"operation", "before_count", "after_count", "changed", "installed_effect_key", "layer_locator"},
    "effect-delete": {"operation", "before_count", "after_count", "changed", "installed_effect_key", "layer_locator"},
    "masks-list": {"operation", "layer_locator", "masks", "total", "offset", "limit", "returned", "has_more", "next_offset"},
    "mask-details": {"operation", "layer_locator", "mask"},
    "mask-path": {"operation", "mask_index", "mask_id", "path"},
    "mask-create": {"operation", "before_count", "after_count", "changed", "layer_locator", "mask_index", "mask_id"},
    "mask-properties": {"operation", "changed", "mask"},
    "mask-duplicate": {"operation", "before_count", "after_count", "changed", "layer_locator", "mask_index", "mask_id"},
    "mask-delete": {"operation", "before_count", "after_count", "changed", "layer_locator"},
    "footage-details": {
        "operation", "duration", "file_count", "files_per_frame", "has_audio",
        "has_proxy", "has_video", "height", "item_locator", "missing", "name",
        "pixel_aspect", "signature", "source_path", "still", "using_proxy", "width",
    },
    "footage-interpretation": {"operation", "item_locator", "proxy", "interpretation"},
    "footage-import": {"operation", "before_item_count", "after_item_count", "changed", "item_locator"},
    "footage-replace": {"operation", "changed", "item_locator", "proxy"},
    "footage-proxy": {"operation", "changed", "item_locator", "proxy"},
    "item-use-proxy": {"operation", "changed", "item_locator", "after_enabled"},
}


class NativeMediaValue(_NativeModel):
    operation: MediaOperation
    layer_locator: NativeLocator | None = None
    item_locator: NativeLocator | None = None
    effects: list[InstalledEffect | LayerEffect] | None = None
    effect: LayerEffect | None = None
    masks: list[LayerMask] | None = None
    mask: LayerMask | None = None
    path: MaskPath | None = None
    interpretation: FootageInterpretation | None = None
    total: SafeCount | None = None
    offset: SafeCount | None = None
    limit: Annotated[StrictInt, Field(ge=1, le=100)] | None = None
    returned: Annotated[StrictInt, Field(ge=0, le=100)] | None = None
    has_more: StrictBool | None = None
    next_offset: SafeCount | None = None
    effect_index: SafeIndex | None = None
    installed_effect_key: EffectKey | None = None
    mask_index: SafeIndex | None = None
    mask_id: EffectKey | None = None
    before_index: SafeIndex | None = None
    after_index: SafeIndex | None = None
    before_count: SafeCount | None = None
    after_count: SafeCount | None = None
    before_item_count: SafeCount | None = None
    after_item_count: SafeCount | None = None
    before_enabled: StrictBool | None = None
    after_enabled: StrictBool | None = None
    changed: Literal[True] | None = None
    proxy: StrictBool | None = None
    duration: MediaDuration | None = None
    file_count: SafeCount | None = None
    files_per_frame: SafeCount | None = None
    has_audio: StrictBool | None = None
    has_proxy: StrictBool | None = None
    has_video: StrictBool | None = None
    height: SafeCount | None = None
    missing: StrictBool | None = None
    name: Annotated[StrictStr, Field(max_length=1024)] | None = None
    pixel_aspect: MediaRatio | None = None
    signature: StrictInt | None = None
    source_path: Annotated[StrictStr, Field(max_length=1024)] | None = None
    still: StrictBool | None = None
    using_proxy: StrictBool | None = None
    width: SafeCount | None = None

    @model_validator(mode="after")
    def _closed_value(self) -> "NativeMediaValue":
        expected = set(_VALUE_FIELDS[self.operation])
        # Read mask-path additionally returns its layer locator; the write does not.
        if self.operation == "mask-path" and "layer_locator" in self.model_fields_set:
            expected.add("layer_locator")
        if set(self.model_fields_set) != expected:
            raise ValueError(f"{self.operation} result is not closed")
        if self.installed_effect_key == 0 or self.mask_id == 0:
            raise ValueError("stable effect and mask references must be non-zero")
        if self.operation.endswith("-list"):
            if self.returned is None or self.total is None or self.offset is None:
                raise ValueError("list result is incomplete")
            if self.returned > self.limit or self.offset + self.returned > self.total:  # type: ignore[operator]
                raise ValueError("list pagination facts are inconsistent")
            if self.has_more != (self.next_offset is not None):
                raise ValueError("list hasMore and nextOffset disagree")
        if self.operation == "effect-enabled" and self.after_enabled is None:
            raise ValueError("effect enabled result is incomplete")
        if self.operation == "effect-reorder" and self.before_index == self.after_index:
            raise ValueError("effect reorder did not change stack position")
        if self.operation == "footage-import" and (
            self.before_item_count is None
            or self.after_item_count != self.before_item_count + 1
        ):
            raise ValueError("footage import did not add exactly one project item")
        return self

    def wire_payload(self) -> dict[str, Any]:
        return self.model_dump(
            mode="json",
            by_alias=True,
            include=self.model_fields_set,
            exclude_none=False,
        )


class NativeMediaReadExecution(_ReadExecution):
    value: NativeMediaValue


class NativeMediaWriteExecution(_WriteExecution):
    value: NativeMediaValue


def _bound_locators(arguments: NativeMediaArguments) -> tuple[tuple[NativeLocator, str], ...]:
    fields: list[tuple[NativeLocator, str]] = []
    for locator, field in (
        (arguments.layer_locator, "params.arguments.layerLocator"),
        (arguments.item_locator, "params.arguments.itemLocator"),
        (arguments.folder_locator, "params.arguments.folderLocator"),
    ):
        if locator is not None:
            fields.append((locator, field))
    return tuple(fields)


def _validate_value(
    *,
    contract: CapabilityContract,
    operation: MediaOperation,
    result: NativeInvokeResult,
    side_effecting: bool,
    inspect_hint: str,
    arguments: NativeMediaArguments,
) -> NativeMediaValue:
    try:
        value = NativeMediaValue.model_validate(result.value)
        _validate_operation_binding(arguments, value)
        digest = _sha256_closed_json({
            "capabilityId": contract.capability_id,
            "capabilityVersion": CAPABILITY_VERSION,
            "value": value.wire_payload(),
        })
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        if side_effecting:
            raise NativeBackendError(
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "Native media value was malformed after dispatch.",
                retryable=False,
                side_effect="may-have-occurred",
                recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
                details={"capabilityId": contract.capability_id},
            ) from exc
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native media value was malformed after dispatch.",
        ) from exc
    if (
        value.operation != operation
        or result.evidence.postcondition.kind != contract.postcondition_kind
        or result.evidence.postcondition.digest != digest
    ):
        if side_effecting:
            raise NativeBackendError(
                "POSSIBLY_SIDE_EFFECTING_FAILURE",
                "Native media postcondition did not verify the requested operation.",
                retryable=False,
                side_effect="may-have-occurred",
                recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
                details={"capabilityId": contract.capability_id},
            )
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native media postcondition did not verify the requested operation.",
        )
    return value


def _validate_operation_binding(
    arguments: NativeMediaArguments,
    value: NativeMediaValue,
) -> None:
    """Bind operation-specific readback to the exact public request."""

    if value.operation != arguments.operation:
        raise ValueError("native media result operation does not match the request")
    if arguments.layer_locator is not None and arguments.operation in {
        "effects-layer-list", "effect-details", "masks-list", "mask-details", "mask-path",
    }:
        if value.layer_locator != arguments.layer_locator:
            raise ValueError("native media read returned another layer")
    if arguments.item_locator is not None and arguments.operation in {
        "footage-details", "footage-interpretation", "footage-replace",
        "footage-proxy", "item-use-proxy",
    }:
        if value.item_locator != arguments.item_locator:
            raise ValueError("native media result returned another project item")
    if arguments.effect_index is not None:
        if arguments.operation in {"effect-details", "effect-enabled"}:
            actual_index = value.effect.effect_index if value.effect is not None else value.effect_index
            if actual_index != arguments.effect_index:
                raise ValueError("effect result is not bound to effectIndex")
        if arguments.operation == "effect-reorder" and value.before_index != arguments.effect_index:
            raise ValueError("effect reorder beforeIndex does not match the request")
    if arguments.installed_effect_key is not None:
        actual_key = (
            value.effect.installed_effect_key
            if value.effect is not None
            else value.installed_effect_key
        )
        if actual_key != arguments.installed_effect_key:
            raise ValueError("effect result is not bound to installedEffectKey")
    if arguments.mask_index is not None:
        actual_mask = value.mask
        if actual_mask is not None:
            if actual_mask.mask_index != arguments.mask_index or actual_mask.mask_id != arguments.mask_id:
                raise ValueError("mask result is not bound to maskIndex and maskId")
        elif arguments.operation in {"mask-details", "mask-path"}:
            if value.mask_index != arguments.mask_index or value.mask_id != arguments.mask_id:
                raise ValueError("mask result is not bound to maskIndex and maskId")
    if arguments.operation == "effect-enabled" and value.after_enabled != arguments.enabled:
        raise ValueError("effect enabled readback does not match the request")
    if arguments.operation == "effect-reorder" and value.after_index != arguments.target_index:
        raise ValueError("effect reorder readback does not match targetIndex")
    if arguments.operation == "mask-properties":
        if value.mask is None or arguments.properties is None:
            raise ValueError("mask properties readback is incomplete")
        requested = arguments.properties.model_dump(
            mode="json", by_alias=True, include=arguments.properties.model_fields_set
        )
        actual = value.mask.model_dump(mode="json", by_alias=True)
        if any(actual.get(key) != expected for key, expected in requested.items()):
            raise ValueError("mask properties readback does not match the patch")
    if arguments.operation == "mask-path" and arguments.vertices is not None:
        if value.path is None:
            raise ValueError("mask path readback is missing")
        requested_vertices = [
            tuple(Decimal(component) for pair in (
                vertex.position, vertex.in_tangent, vertex.out_tangent
            ) for component in pair)
            for vertex in arguments.vertices
        ]
        actual_vertices = [
            tuple(Decimal(component) for pair in (
                vertex.position, vertex.in_tangent, vertex.out_tangent
            ) for component in pair)
            for vertex in value.path.vertices
        ]
        if value.path.closed != arguments.closed or actual_vertices != requested_vertices:
            raise ValueError("mask path readback does not match the requested path")
    if arguments.operation == "footage-interpretation" and arguments.interpretation is not None:
        if value.interpretation is None:
            raise ValueError("footage interpretation readback is missing")
        requested = arguments.interpretation.model_dump(
            mode="json",
            by_alias=True,
            include=arguments.interpretation.model_fields_set,
        )
        actual = value.interpretation.model_dump(mode="json", by_alias=True)
        for decimal_field in ("nativeFps", "conformFps"):
            if decimal_field in requested:
                if Decimal(actual[decimal_field]) != Decimal(requested[decimal_field]):
                    raise ValueError("footage interpretation frame-rate readback does not match")
                requested.pop(decimal_field)
        if any(actual.get(key) != expected for key, expected in requested.items()):
            raise ValueError("footage interpretation readback does not match the patch")
    if arguments.operation == "footage-replace" and value.proxy is not False:
        raise ValueError("main-footage replacement readback reported proxy footage")
    if arguments.operation == "footage-proxy" and value.proxy is not True:
        raise ValueError("proxy-footage readback did not report proxy footage")
    if arguments.operation == "item-use-proxy" and value.after_enabled != arguments.enabled:
        raise ValueError("proxy selection readback does not match the request")


async def invoke_native_media_read(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    arguments: NativeMediaArguments | Mapping[str, Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> NativeMediaReadExecution:
    parsed = NativeMediaArguments.model_validate(arguments)
    if parsed.operation not in _READ_OPERATIONS:
        raise _structured_error("INVALID_ARGUMENT", "Operation is not a native media read.")
    contract = CAPABILITY_CONTRACTS[NATIVE_MEDIA_READ_CAPABILITY_ID]
    locators = _bound_locators(parsed)
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=contract.capability_id,
        capability_version=CAPABILITY_VERSION,
        arguments=parsed.wire_payload(),
        locator=None,
        locator_field="",
        additional_locators=locators,
        stale_locator_hint="Refresh the operation-specific locator with a native read before retrying.",
        descriptor_validator=_descriptor_validator(contract),
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    value = _validate_value(
        contract=contract,
        operation=parsed.operation,
        result=result,
        side_effecting=False,
        inspect_hint="",
        arguments=parsed,
    )
    return NativeMediaReadExecution(
        implementation=descriptor,
        negotiation=negotiation,
        value=value,
        evidence=result.evidence,
    )


async def _invoke_media_write_request(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    contract: CapabilityContract,
    arguments: NativeMediaArguments,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
    inspect_hint: str,
) -> tuple[NativeNegotiation, NativeCapabilityDescriptor, NativeInvokeRequest, NativeInvokeResult]:
    _ensure_active(deadline_unix_ms, cancellation)
    negotiation = await backend.negotiate(
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    _ensure_active(deadline_unix_ms, cancellation)
    capability_ids: tuple[str, ...] | None = None
    capability_detail: CapabilityDetail = "full"
    capability_limit = 100
    capabilities = await backend.capabilities(
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    expected_query_digest = _capabilities_query_digest(
        session_id=negotiation.session_id,
        ids=capability_ids,
        detail=capability_detail,
        limit=capability_limit,
    )
    try:
        registry_digest = _capabilities_registry_digest(capabilities.items)
    except (TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capability registry could not be verified.",
        ) from exc
    if (
        capabilities.session_id != negotiation.session_id
        or capabilities.detail != capability_detail
        or capabilities.next_cursor is not None
        or capabilities.query_digest != expected_query_digest
        or capabilities.capabilities_digest != registry_digest
        or capabilities.capabilities_digest != negotiation.capabilities_digest
    ):
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            "Native capabilities were not bound to the negotiated session.",
        )
    matches = [
        item for item in capabilities.items
        if item.capability_id == contract.capability_id
        and item.capability_version == CAPABILITY_VERSION
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error(
            "NATIVE_UNSUPPORTED",
            f"Native host did not advertise {contract.capability_id}@1.",
        )
    _descriptor_validator(contract)(descriptor, host_platform=negotiation.host_platform)
    for locator, field in _bound_locators(arguments):
        if (
            locator.host_instance_id != negotiation.host_instance_id
            or locator.session_id != negotiation.session_id
        ):
            raise _structured_error(
                "STALE_LOCATOR",
                "Native locator does not belong to the negotiated host session.",
                details={"field": field, "capabilityId": contract.capability_id},
                recovery_hint="Refresh the operation-specific locator with a native read before retrying.",
            )
    _ensure_active(deadline_unix_ms, cancellation)
    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=contract.capability_id,
        capability_version=CAPABILITY_VERSION,
        arguments=arguments.wire_payload(),
        deadline_unix_ms=deadline_unix_ms,
    )
    try:
        result = await backend.invoke(request, cancellation=cancellation)
    except NativeBackendError as exc:
        _validate_invoke_error_binding(exc, request)
        raise
    undo = result.evidence.undo
    expected_request_digest = _invoke_request_digest(request, negotiation)
    if (
        result.capability_id != request.capability_id
        or result.capability_version != request.capability_version
        or result.engine != "native-aegp"
        or result.replayed
        or result.evidence.request_id != request.request_id
        or result.evidence.host_instance_id != negotiation.host_instance_id
        or result.evidence.session_id != negotiation.session_id
        or result.evidence.effect != "committed"
        or undo is None
        or undo.available is not True
        or undo.verified is not False
        or undo.group_id is not None
        or result.evidence.completed_at_unix_ms > deadline_unix_ms
        or result.evidence.request_digest != expected_request_digest
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "Native media write could not be verified after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": contract.capability_id},
        )
    return negotiation, descriptor, request, result


async def invoke_native_media_write(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    arguments: NativeMediaArguments | Mapping[str, Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> NativeMediaWriteExecution:
    parsed = NativeMediaArguments.model_validate(arguments)
    if parsed.operation not in _WRITE_OPERATIONS:
        raise _structured_error("INVALID_ARGUMENT", "Operation is not a native media write.")
    contract = CAPABILITY_CONTRACTS[NATIVE_MEDIA_WRITE_CAPABILITY_ID]
    hint = (
        "Read the affected effect stack, mask stack, or footage item and inspect "
        "the After Effects Undo stack before issuing another write."
    )
    negotiation, descriptor, request, result = await _invoke_media_write_request(
        backend,
        request_id=request_id,
        contract=contract,
        arguments=parsed,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
        inspect_hint=hint,
    )
    value = _validate_value(
        contract=contract,
        operation=parsed.operation,
        result=result,
        side_effecting=True,
        inspect_hint=hint,
        arguments=parsed,
    )
    return NativeMediaWriteExecution(
        implementation=descriptor,
        negotiation=negotiation,
        transport_request_id=request.request_id,
        idempotency_key=parsed.idempotency_key,
        replayed=result.replayed,
        value=value,
        evidence=result.evidence,
    )


__all__ = [
    "CAPABILITY_CONTRACTS",
    "NATIVE_MEDIA_READ_CAPABILITY_ID",
    "NATIVE_MEDIA_WRITE_CAPABILITY_ID",
    "NativeMediaArguments",
    "NativeMediaReadExecution",
    "NativeMediaValue",
    "NativeMediaWriteExecution",
    "invoke_native_media_read",
    "invoke_native_media_write",
]
