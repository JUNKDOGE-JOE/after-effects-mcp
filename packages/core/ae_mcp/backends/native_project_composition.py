"""Strict Core contracts for the Project / Composition native capability package.

This module is deliberately bound to eight named AEGP capabilities.  It does
not select between native and JSX implementations and it does not accept raw
source.  Public handlers choose this native path explicitly.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Annotated, Any, Callable, Literal, Mapping, TypeVar

from pydantic import (
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    ValidationError,
    model_validator,
)

from ae_mcp.backends.native import (
    CapabilityDetail,
    NativeBackendError,
    NativeCancellationToken,
    NativeCapabilities,
    NativeCapabilityDescriptor,
    NativeExecutionEvidence,
    NativeInvokeBackend,
    NativeInvokeRequest,
    NativeInvokeResult,
    NativeLocator,
    NativeNegotiation,
    NativePlatform,
    NativeRecovery,
    NonNegativeInt,
    PositiveInt,
    RequestId,
    Sha256,
    SignedInt32,
    UnsignedInt32,
    _NativeModel,
    _capabilities_query_digest,
    _capabilities_registry_digest,
    _ensure_active,
    _invoke_native_read_request,
    _invoke_request_digest,
    _native_read_audit_fields,
    _sha256_closed_json,
    _structured_error,
    _validate_invoke_error_binding,
)


_SAFE_MAX = 9_007_199_254_740_991
_UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
_IDEMPOTENCY_KEY_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"
_RATIONAL = r"^(?:0|-?[1-9][0-9]*(?:/[1-9][0-9]*)?)$"
_POSITIVE_RATIONAL = r"^[1-9][0-9]*(?:/[1-9][0-9]*)?$"

IdempotencyKey = Annotated[
    StrictStr,
    Field(min_length=16, max_length=64, pattern=_IDEMPOTENCY_KEY_PATTERN),
]
BoundedName = Annotated[StrictStr, Field(min_length=1, max_length=255)]
BoundedComment = Annotated[StrictStr, Field(max_length=1024)]


def _bounded_unicode(value: str, *, field: str, allow_empty: bool) -> str:
    if not allow_empty and not value:
        raise ValueError(f"{field} must not be empty")
    if "\x00" in value or any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError(f"{field} must contain only non-NUL Unicode scalar values")
    return value


class ExactTime(_NativeModel):
    value: SignedInt32
    scale: UnsignedInt32
    seconds_rational: Annotated[
        StrictStr,
        Field(min_length=1, max_length=28, pattern=_RATIONAL),
    ]

    @model_validator(mode="after")
    def _canonical_rational(self) -> "ExactTime":
        divisor = math.gcd(abs(self.value), self.scale)
        numerator = self.value // divisor
        denominator = self.scale // divisor
        expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
        if self.seconds_rational != expected:
            raise ValueError("secondsRational is not the exact reduced value/scale")
        return self


class ExactTimeInput(_NativeModel):
    value: SignedInt32
    scale: UnsignedInt32


class NonNegativeTimeInput(ExactTimeInput):
    value: Annotated[StrictInt, Field(ge=0, le=2_147_483_647)]


class PositiveTimeInput(ExactTimeInput):
    value: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]


class ExactRatio(_NativeModel):
    numerator: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]
    denominator: Annotated[StrictInt, Field(ge=1, le=2_147_483_647)]
    rational: Annotated[
        StrictStr,
        Field(min_length=1, max_length=28, pattern=_POSITIVE_RATIONAL),
    ]

    @model_validator(mode="after")
    def _canonical_rational(self) -> "ExactRatio":
        divisor = math.gcd(self.numerator, self.denominator)
        numerator = self.numerator // divisor
        denominator = self.denominator // divisor
        expected = str(numerator) if denominator == 1 else f"{numerator}/{denominator}"
        if self.rational != expected:
            raise ValueError("rational is not the exact reduced numerator/denominator")
        return self


class WorkArea(_NativeModel):
    start: ExactTime
    duration: ExactTime

    @model_validator(mode="after")
    def _valid_bounds(self) -> "WorkArea":
        if self.start.value < 0 or self.duration.value <= 0:
            raise ValueError("work area requires a non-negative start and positive duration")
        return self


class ProjectItemSummary(_NativeModel):
    locator: NativeLocator
    name: Annotated[StrictStr, Field(max_length=1024)]
    type: Literal["folder", "composition", "footage", "unknown"]
    parent_locator: NativeLocator

    @model_validator(mode="after")
    def _valid_locators(self) -> "ProjectItemSummary":
        expected = "composition" if self.type == "composition" else "item"
        if self.locator.kind != expected:
            raise ValueError("project item locator kind does not match its type")
        if self.parent_locator.kind not in {"project", "item"}:
            raise ValueError("project item parent must be a project or folder locator")
        if self.locator.context() != self.parent_locator.context():
            raise ValueError("project item parent escaped its project context")
        return self


class ProjectSelectionPage(_NativeModel):
    total: NonNegativeInt
    offset: NonNegativeInt
    limit: Annotated[StrictInt, Field(ge=1, le=50)]
    returned: Annotated[StrictInt, Field(ge=0, le=50)]
    has_more: StrictBool
    next_offset: NonNegativeInt | None
    items: tuple[ProjectItemSummary, ...] = Field(max_length=50)

    @model_validator(mode="after")
    def _verified_page(self) -> "ProjectSelectionPage":
        if self.returned != len(self.items) or self.returned > self.limit:
            raise ValueError("selected item page count does not match returned")
        consumed = self.offset + self.returned
        if consumed > self.total:
            raise ValueError("selected item page exceeds total")
        expected_more = consumed < self.total
        expected_next = consumed if expected_more else None
        if expected_more and self.returned == 0:
            raise ValueError("selected item continuation made no progress")
        if self.has_more is not expected_more or self.next_offset != expected_next:
            raise ValueError("selected item continuation metadata is inconsistent")
        if len({item.locator.object_id for item in self.items}) != len(self.items):
            raise ValueError("selected item page contains duplicate locators")
        return self


class ProjectContextArguments(_NativeModel):
    selection_offset: NonNegativeInt
    selection_limit: Annotated[StrictInt, Field(ge=1, le=50)]


class ProjectContextValue(_NativeModel):
    project_locator: NativeLocator
    generation: PositiveInt
    active_item: ProjectItemSummary | None
    most_recently_used_composition: ProjectItemSummary | None
    selection: ProjectSelectionPage

    @model_validator(mode="after")
    def _bound_context(self) -> "ProjectContextValue":
        if self.project_locator.kind != "project":
            raise ValueError("projectLocator must have kind project")
        if self.generation != self.project_locator.generation:
            raise ValueError("generation does not match projectLocator")
        related = [self.active_item, self.most_recently_used_composition, *self.selection.items]
        if any(item is not None and item.locator.context() != self.project_locator.context() for item in related):
            raise ValueError("project context contains a locator from another project generation")
        if (
            self.most_recently_used_composition is not None
            and self.most_recently_used_composition.type != "composition"
        ):
            raise ValueError("mostRecentlyUsedComposition must identify a composition")
        return self


class ProjectItemMetadataArguments(_NativeModel):
    item_locator: NativeLocator

    @model_validator(mode="after")
    def _item_kind(self) -> "ProjectItemMetadataArguments":
        if self.item_locator.kind not in {"item", "composition"}:
            raise ValueError("itemLocator must identify a project item")
        return self


class ProjectItemMetadataValue(_NativeModel):
    item_locator: NativeLocator
    name: Annotated[StrictStr, Field(max_length=1024)]
    type: Literal["folder", "composition", "footage", "unknown"]
    parent_locator: NativeLocator | None
    comment: Annotated[StrictStr, Field(max_length=1024)]
    label_id: Annotated[StrictInt, Field(ge=0, le=16)]
    width: Annotated[StrictInt, Field(ge=1, le=30_000)] | None = None
    height: Annotated[StrictInt, Field(ge=1, le=30_000)] | None = None
    duration: ExactTime | None = None
    pixel_aspect_ratio: ExactRatio | None = None
    layer_count: NonNegativeInt | None = None

    @model_validator(mode="after")
    def _valid_metadata(self) -> "ProjectItemMetadataValue":
        expected = "composition" if self.type == "composition" else "item"
        if self.item_locator.kind != expected:
            raise ValueError("itemLocator kind does not match metadata type")
        if self.parent_locator is not None:
            if self.parent_locator.kind not in {"project", "item"}:
                raise ValueError("metadata parentLocator must identify a project or folder")
            if self.item_locator.context() != self.parent_locator.context():
                raise ValueError("metadata parentLocator escaped the item context")
        _bounded_unicode(self.name, field="name", allow_empty=True)
        _bounded_unicode(self.comment, field="comment", allow_empty=True)
        if self.type == "composition":
            if any(value is None for value in (
                self.width,
                self.height,
                self.duration,
                self.pixel_aspect_ratio,
                self.layer_count,
            )):
                raise ValueError("composition metadata requires all composition facts")
            if self.width == 0 or self.height == 0 or self.duration.value <= 0:  # type: ignore[union-attr]
                raise ValueError("composition metadata dimensions and duration must be positive")
        elif self.layer_count is not None:
            raise ValueError("layerCount is accepted only for composition metadata")
        return self


class CompositionSettingsSnapshot(_NativeModel):
    name: Annotated[StrictStr, Field(max_length=1024)]
    width: Annotated[StrictInt, Field(ge=1, le=30_000)]
    height: Annotated[StrictInt, Field(ge=1, le=30_000)]
    duration: ExactTime
    frame_duration: ExactTime
    frame_rate: ExactRatio
    pixel_aspect_ratio: ExactRatio
    work_area: WorkArea
    display_start_time: ExactTime
    layer_count: NonNegativeInt

    @model_validator(mode="after")
    def _coherent_settings(self) -> "CompositionSettingsSnapshot":
        _bounded_unicode(self.name, field="name", allow_empty=True)
        if self.duration.value <= 0 or self.frame_duration.value <= 0:
            raise ValueError("composition duration and frameDuration must be positive")
        if (
            self.frame_duration.value * self.frame_rate.numerator
            != self.frame_duration.scale * self.frame_rate.denominator
        ):
            raise ValueError("frameRate must be the exact reciprocal of frameDuration")
        work_end_left = (
            self.work_area.start.value * self.work_area.duration.scale
            + self.work_area.duration.value * self.work_area.start.scale
        )
        work_end_scale = self.work_area.start.scale * self.work_area.duration.scale
        if work_end_left * self.duration.scale > self.duration.value * work_end_scale:
            raise ValueError("work area exceeds composition duration")
        return self


class CompositionSettingsArguments(_NativeModel):
    composition_locator: NativeLocator

    @model_validator(mode="after")
    def _composition_kind(self) -> "CompositionSettingsArguments":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must identify a composition")
        return self


class CompositionSettingsValue(CompositionSettingsSnapshot):
    composition_locator: NativeLocator

    @model_validator(mode="after")
    def _composition_identity(self) -> "CompositionSettingsValue":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must identify a composition")
        return self


class CompositionWorkAreaSetArguments(_NativeModel):
    composition_locator: NativeLocator
    start: NonNegativeTimeInput
    duration: PositiveTimeInput
    idempotency_key: IdempotencyKey

    @model_validator(mode="after")
    def _composition_kind(self) -> "CompositionWorkAreaSetArguments":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must identify a composition")
        return self


def _times_equal(left: ExactTime | ExactTimeInput, right: ExactTime | ExactTimeInput) -> bool:
    return left.value * right.scale == right.value * left.scale


def _work_areas_equal(left: WorkArea, right: WorkArea) -> bool:
    return _times_equal(left.start, right.start) and _times_equal(left.duration, right.duration)


class CompositionWorkAreaSetValue(_NativeModel):
    changed: Literal[True]
    composition_locator: NativeLocator
    before_work_area: WorkArea
    after_work_area: WorkArea

    @model_validator(mode="after")
    def _verified_transition(self) -> "CompositionWorkAreaSetValue":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must identify a composition")
        if _work_areas_equal(self.before_work_area, self.after_work_area):
            raise ValueError("composition work area did not change")
        return self


class _ProjectItemWriteArguments(_NativeModel):
    item_locator: NativeLocator
    idempotency_key: IdempotencyKey

    @model_validator(mode="after")
    def _item_kind(self) -> "_ProjectItemWriteArguments":
        if self.item_locator.kind not in {"item", "composition"}:
            raise ValueError("itemLocator must identify a project item")
        return self


class ProjectItemNameSetArguments(_ProjectItemWriteArguments):
    name: BoundedName

    @model_validator(mode="after")
    def _valid_name(self) -> "ProjectItemNameSetArguments":
        _bounded_unicode(self.name, field="name", allow_empty=False)
        return self


class ProjectItemCommentSetArguments(_ProjectItemWriteArguments):
    comment: BoundedComment

    @model_validator(mode="after")
    def _valid_comment(self) -> "ProjectItemCommentSetArguments":
        _bounded_unicode(self.comment, field="comment", allow_empty=True)
        return self


class ProjectItemLabelSetArguments(_ProjectItemWriteArguments):
    label_id: Annotated[StrictInt, Field(ge=0, le=16)]


class ProjectItemNameSetValue(_NativeModel):
    changed: Literal[True]
    item_locator: NativeLocator
    before_name: Annotated[StrictStr, Field(max_length=1024)]
    after_name: BoundedName

    @model_validator(mode="after")
    def _changed_name(self) -> "ProjectItemNameSetValue":
        if self.item_locator.kind not in {"item", "composition"}:
            raise ValueError("itemLocator must identify a project item")
        _bounded_unicode(self.after_name, field="afterName", allow_empty=False)
        if self.before_name == self.after_name:
            raise ValueError("project item name did not change")
        return self


class ProjectItemCommentSetValue(_NativeModel):
    changed: Literal[True]
    item_locator: NativeLocator
    before_comment: BoundedComment
    after_comment: BoundedComment

    @model_validator(mode="after")
    def _changed_comment(self) -> "ProjectItemCommentSetValue":
        if self.item_locator.kind not in {"item", "composition"}:
            raise ValueError("itemLocator must identify a project item")
        _bounded_unicode(self.before_comment, field="beforeComment", allow_empty=True)
        _bounded_unicode(self.after_comment, field="afterComment", allow_empty=True)
        if self.before_comment == self.after_comment:
            raise ValueError("project item comment did not change")
        return self


class ProjectItemLabelSetValue(_NativeModel):
    changed: Literal[True]
    item_locator: NativeLocator
    before_label_id: Annotated[StrictInt, Field(ge=0, le=16)]
    after_label_id: Annotated[StrictInt, Field(ge=0, le=16)]

    @model_validator(mode="after")
    def _changed_label(self) -> "ProjectItemLabelSetValue":
        if self.item_locator.kind not in {"item", "composition"}:
            raise ValueError("itemLocator must identify a project item")
        if self.before_label_id == self.after_label_id:
            raise ValueError("project item label did not change")
        return self


class CompositionDuplicateArguments(_NativeModel):
    composition_locator: NativeLocator
    new_name: BoundedName
    idempotency_key: IdempotencyKey

    @model_validator(mode="after")
    def _valid_arguments(self) -> "CompositionDuplicateArguments":
        if self.composition_locator.kind != "composition":
            raise ValueError("compositionLocator must identify a composition")
        _bounded_unicode(self.new_name, field="newName", allow_empty=False)
        return self


class CompositionDuplicateValue(_NativeModel):
    changed: Literal[True]
    source_composition_locator: NativeLocator
    new_composition_locator: NativeLocator
    project_item_count_before: NonNegativeInt
    project_item_count_after: NonNegativeInt
    source_settings: CompositionSettingsSnapshot
    new_settings: CompositionSettingsSnapshot

    @model_validator(mode="after")
    def _verified_duplicate(self) -> "CompositionDuplicateValue":
        source = self.source_composition_locator
        created = self.new_composition_locator
        if source.kind != "composition" or created.kind != "composition":
            raise ValueError("duplicate locators must identify compositions")
        if source.context() != created.context() or source.object_id == created.object_id:
            raise ValueError("duplicate must return distinct locators in one fresh context")
        if self.project_item_count_after != self.project_item_count_before + 1:
            raise ValueError("duplicate must add exactly one project item")
        _bounded_unicode(self.new_settings.name, field="newSettings.name", allow_empty=False)
        source_facts = self.source_settings.model_dump(exclude={"name"})
        new_facts = self.new_settings.model_dump(exclude={"name"})
        if source_facts != new_facts:
            raise ValueError("duplicate settings must match the source settings")
        return self


class _ReadExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    evidence: NativeExecutionEvidence
    engine: Literal["native-aegp"] = "native-aegp"

    def audit_fields(self) -> dict[str, Any]:
        return _native_read_audit_fields(self.implementation, self.negotiation, self.evidence)


class ProjectContextExecution(_ReadExecution):
    value: ProjectContextValue


class ProjectItemMetadataExecution(_ReadExecution):
    value: ProjectItemMetadataValue


class CompositionSettingsExecution(_ReadExecution):
    value: CompositionSettingsValue


def _write_audit_fields(
    implementation: NativeCapabilityDescriptor,
    negotiation: NativeNegotiation,
    evidence: NativeExecutionEvidence,
    *,
    transport_request_id: str,
    idempotency_key: str,
    replayed: bool,
) -> dict[str, Any]:
    undo = evidence.undo
    return {
        "engine": "native-aegp",
        "capabilityId": evidence.capability_id,
        "capabilityVersion": evidence.capability_version,
        "contractDigest": implementation.contract_digest,
        "selectedWireVersion": negotiation.selected_wire_version,
        "pluginVersion": negotiation.plugin_version,
        "compiledSdkVersion": negotiation.compiled_sdk_version,
        "sourceCommit": negotiation.source_commit,
        "hostInstanceId": evidence.host_instance_id,
        "sessionId": evidence.session_id,
        "sessionGeneration": negotiation.session_generation,
        "capabilitiesDigest": negotiation.capabilities_digest,
        "requestId": transport_request_id,
        "evidenceRequestId": evidence.request_id,
        "idempotencyKey": idempotency_key,
        "replayed": replayed,
        "effect": evidence.effect,
        "requestDigest": evidence.request_digest,
        "postconditionAlgorithm": evidence.postcondition.algorithm,
        "postconditionDigest": evidence.postcondition.digest,
        "undoAvailable": undo.available if undo is not None else False,
        "undoVerified": undo.verified if undo is not None else False,
        "startedAtUnixMs": evidence.started_at_unix_ms,
        "completedAtUnixMs": evidence.completed_at_unix_ms,
    }


class _WriteExecution(_NativeModel):
    implementation: NativeCapabilityDescriptor
    negotiation: NativeNegotiation
    transport_request_id: RequestId
    idempotency_key: IdempotencyKey
    replayed: StrictBool
    evidence: NativeExecutionEvidence
    engine: Literal["native-aegp"] = "native-aegp"

    def audit_fields(self) -> dict[str, Any]:
        return _write_audit_fields(
            self.implementation,
            self.negotiation,
            self.evidence,
            transport_request_id=self.transport_request_id,
            idempotency_key=self.idempotency_key,
            replayed=self.replayed,
        )


class CompositionWorkAreaSetExecution(_WriteExecution):
    value: CompositionWorkAreaSetValue


class ProjectItemNameSetExecution(_WriteExecution):
    value: ProjectItemNameSetValue


class ProjectItemCommentSetExecution(_WriteExecution):
    value: ProjectItemCommentSetValue


class ProjectItemLabelSetExecution(_WriteExecution):
    value: ProjectItemLabelSetValue


class CompositionDuplicateExecution(_WriteExecution):
    value: CompositionDuplicateValue


PROJECT_CONTEXT_READ_CAPABILITY_ID = "ae.project.context.read"
PROJECT_ITEM_METADATA_READ_CAPABILITY_ID = "ae.project.item.metadata.read"
COMPOSITION_SETTINGS_READ_CAPABILITY_ID = "ae.composition.settings.read"
COMPOSITION_WORK_AREA_SET_CAPABILITY_ID = "ae.composition.work-area.set"
PROJECT_ITEM_NAME_SET_CAPABILITY_ID = "ae.project.item.name.set"
PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID = "ae.project.item.comment.set"
PROJECT_ITEM_LABEL_SET_CAPABILITY_ID = "ae.project.item.label.set"
COMPOSITION_DUPLICATE_CAPABILITY_ID = "ae.composition.duplicate"

CAPABILITY_VERSION = 1


def _locator_schema(*kinds: str) -> dict[str, Any]:
    kind_schema: dict[str, Any] = {"const": kinds[0]} if len(kinds) == 1 else {"enum": list(kinds)}
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["kind", "hostInstanceId", "sessionId", "projectId", "generation", "objectId"],
        "properties": {
            "kind": kind_schema,
            "hostInstanceId": {"type": "string", "pattern": _UUID},
            "sessionId": {"type": "string", "pattern": _UUID},
            "projectId": {"type": "string", "pattern": _UUID},
            "generation": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
            "objectId": {"type": "string", "pattern": _UUID},
        },
    }


def _time_input_schema(*, positive: bool = False, non_negative: bool = False) -> dict[str, Any]:
    minimum = 1 if positive else (0 if non_negative else -2_147_483_648)
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["value", "scale"],
        "properties": {
            "value": {"type": "integer", "minimum": minimum, "maximum": 2_147_483_647},
            "scale": {"type": "integer", "minimum": 1, "maximum": 4_294_967_295},
        },
    }


def _exact_time_schema() -> dict[str, Any]:
    schema = _time_input_schema()
    schema["required"].append("secondsRational")
    schema["properties"]["secondsRational"] = {
        "type": "string", "minLength": 1, "maxLength": 28, "pattern": _RATIONAL,
    }
    return schema


def _ratio_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["numerator", "denominator", "rational"],
        "properties": {
            "numerator": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
            "denominator": {"type": "integer", "minimum": 1, "maximum": 2_147_483_647},
            "rational": {"type": "string", "minLength": 1, "maxLength": 28, "pattern": _POSITIVE_RATIONAL},
        },
    }


def _work_area_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["start", "duration"],
        "properties": {"start": _exact_time_schema(), "duration": _exact_time_schema()},
    }


def _project_item_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["locator", "name", "type", "parentLocator"],
        "properties": {
            "locator": _locator_schema("item", "composition"),
            "name": {"type": "string", "maxLength": 1024},
            "type": {"enum": ["folder", "composition", "footage", "unknown"]},
            "parentLocator": _locator_schema("project", "item"),
        },
    }


def _settings_snapshot_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "name", "width", "height", "duration", "frameDuration", "frameRate",
            "pixelAspectRatio", "workArea", "displayStartTime", "layerCount",
        ],
        "properties": {
            "name": {"type": "string", "maxLength": 1024},
            "width": {"type": "integer", "minimum": 1, "maximum": 30_000},
            "height": {"type": "integer", "minimum": 1, "maximum": 30_000},
            "duration": _exact_time_schema(),
            "frameDuration": _exact_time_schema(),
            "frameRate": _ratio_schema(),
            "pixelAspectRatio": _ratio_schema(),
            "workArea": _work_area_schema(),
            "displayStartTime": _exact_time_schema(),
            "layerCount": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        },
    }


_PROJECT_CONTEXT_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["selectionOffset", "selectionLimit"],
    "properties": {
        "selectionOffset": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "selectionLimit": {"type": "integer", "minimum": 1, "maximum": 50},
    },
}
_PROJECT_CONTEXT_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["projectLocator", "generation", "activeItem", "mostRecentlyUsedComposition", "selection"],
    "properties": {
        "projectLocator": _locator_schema("project"),
        "generation": {"type": "integer", "minimum": 1, "maximum": _SAFE_MAX},
        "activeItem": {"anyOf": [_project_item_schema(), {"type": "null"}]},
        "mostRecentlyUsedComposition": {"anyOf": [_project_item_schema(), {"type": "null"}]},
        "selection": {
            "type": "object",
            "additionalProperties": False,
            "required": ["total", "offset", "limit", "returned", "hasMore", "nextOffset", "items"],
            "properties": {
                "total": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
                "offset": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                "returned": {"type": "integer", "minimum": 0, "maximum": 50},
                "hasMore": {"type": "boolean"},
                "nextOffset": {"anyOf": [
                    {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
                    {"type": "null"},
                ]},
                "items": {"type": "array", "maxItems": 50, "items": _project_item_schema()},
            },
        },
    },
}

_PROJECT_ITEM_METADATA_INPUT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["itemLocator"],
    "properties": {"itemLocator": _locator_schema("item", "composition")},
}
_PROJECT_ITEM_METADATA_RESULT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["itemLocator", "name", "type", "parentLocator", "comment", "labelId"],
    "properties": {
        "itemLocator": _locator_schema("item", "composition"),
        "name": {"type": "string", "maxLength": 1024},
        "type": {"enum": ["folder", "composition", "footage", "unknown"]},
        "parentLocator": {"anyOf": [_locator_schema("project", "item"), {"type": "null"}]},
        "comment": {"type": "string", "maxLength": 1024},
        "labelId": {"type": "integer", "minimum": 0, "maximum": 16},
        "width": {"type": "integer", "minimum": 1, "maximum": 30_000},
        "height": {"type": "integer", "minimum": 1, "maximum": 30_000},
        "duration": _exact_time_schema(),
        "pixelAspectRatio": _ratio_schema(),
        "layerCount": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
    },
}

_COMPOSITION_SETTINGS_INPUT_SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["compositionLocator"],
    "properties": {"compositionLocator": _locator_schema("composition")},
}
_COMPOSITION_SETTINGS_RESULT_SCHEMA = {
    **_settings_snapshot_schema(),
    "required": ["compositionLocator", *_settings_snapshot_schema()["required"]],
    "properties": {
        "compositionLocator": _locator_schema("composition"),
        **_settings_snapshot_schema()["properties"],
    },
}

_IDEMPOTENCY_SCHEMA = {
    "type": "string", "minLength": 16, "maxLength": 64, "pattern": _IDEMPOTENCY_KEY_PATTERN,
}
_COMPOSITION_WORK_AREA_SET_INPUT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["compositionLocator", "start", "duration", "idempotencyKey"],
    "properties": {
        "compositionLocator": _locator_schema("composition"),
        "start": _time_input_schema(non_negative=True),
        "duration": _time_input_schema(positive=True),
        "idempotencyKey": _IDEMPOTENCY_SCHEMA,
    },
}
_COMPOSITION_WORK_AREA_SET_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["changed", "compositionLocator", "beforeWorkArea", "afterWorkArea"],
    "properties": {
        "changed": {"const": True},
        "compositionLocator": _locator_schema("composition"),
        "beforeWorkArea": _work_area_schema(),
        "afterWorkArea": _work_area_schema(),
    },
}


def _item_write_input(value_name: str, value_schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object", "additionalProperties": False,
        "required": ["itemLocator", value_name, "idempotencyKey"],
        "properties": {
            "itemLocator": _locator_schema("item", "composition"),
            value_name: value_schema,
            "idempotencyKey": _IDEMPOTENCY_SCHEMA,
        },
    }


def _item_write_result(before_name: str, after_name: str, value_schema: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object", "additionalProperties": False,
        "required": ["changed", "itemLocator", before_name, after_name],
        "properties": {
            "changed": {"const": True},
            "itemLocator": _locator_schema("item", "composition"),
            before_name: value_schema,
            after_name: value_schema,
        },
    }


_NAME_SCHEMA = {"type": "string", "minLength": 1, "maxLength": 255}
_COMMENT_SCHEMA = {"type": "string", "maxLength": 1024}
_LABEL_SCHEMA = {"type": "integer", "minimum": 0, "maximum": 16}
_PROJECT_ITEM_NAME_SET_INPUT_SCHEMA = _item_write_input("name", _NAME_SCHEMA)
_PROJECT_ITEM_NAME_SET_RESULT_SCHEMA = _item_write_result("beforeName", "afterName", _NAME_SCHEMA)
_PROJECT_ITEM_NAME_SET_RESULT_SCHEMA["properties"]["beforeName"] = {
    "type": "string",
    "maxLength": 1024,
}
_PROJECT_ITEM_COMMENT_SET_INPUT_SCHEMA = _item_write_input("comment", _COMMENT_SCHEMA)
_PROJECT_ITEM_COMMENT_SET_RESULT_SCHEMA = _item_write_result("beforeComment", "afterComment", _COMMENT_SCHEMA)
_PROJECT_ITEM_LABEL_SET_INPUT_SCHEMA = _item_write_input("labelId", _LABEL_SCHEMA)
_PROJECT_ITEM_LABEL_SET_RESULT_SCHEMA = _item_write_result("beforeLabelId", "afterLabelId", _LABEL_SCHEMA)

_COMPOSITION_DUPLICATE_INPUT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["compositionLocator", "newName", "idempotencyKey"],
    "properties": {
        "compositionLocator": _locator_schema("composition"),
        "newName": _NAME_SCHEMA,
        "idempotencyKey": _IDEMPOTENCY_SCHEMA,
    },
}
_COMPOSITION_DUPLICATE_RESULT_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": [
        "changed", "sourceCompositionLocator", "newCompositionLocator",
        "projectItemCountBefore", "projectItemCountAfter", "sourceSettings", "newSettings",
    ],
    "properties": {
        "changed": {"const": True},
        "sourceCompositionLocator": _locator_schema("composition"),
        "newCompositionLocator": _locator_schema("composition"),
        "projectItemCountBefore": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "projectItemCountAfter": {"type": "integer", "minimum": 0, "maximum": _SAFE_MAX},
        "sourceSettings": _settings_snapshot_schema(),
        "newSettings": _settings_snapshot_schema(),
    },
}


@dataclass(frozen=True)
class CapabilityContract:
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

    @property
    def input_contract_id(self) -> str:
        return f"aemcp.contract.{self.capability_id}.input.v1"

    @property
    def result_contract_id(self) -> str:
        return f"aemcp.contract.{self.capability_id}.result.v1"

    @property
    def contract_digest(self) -> str:
        return _sha256_closed_json({"inputSchema": self.input_schema, "resultSchema": self.result_schema})


CAPABILITY_CONTRACTS: dict[str, CapabilityContract] = {
    PROJECT_CONTEXT_READ_CAPABILITY_ID: CapabilityContract(
        PROJECT_CONTEXT_READ_CAPABILITY_ID,
        "Read current After Effects project context and selected items.",
        "read", "idempotent",
        "Reads project context without changing After Effects state.",
        ("An After Effects project must be open.",),
        "aemcp.requirement.native.project-context-read",
        _PROJECT_CONTEXT_INPUT_SCHEMA, _PROJECT_CONTEXT_RESULT_SCHEMA,
        "project-context-read",
    ),
    PROJECT_ITEM_METADATA_READ_CAPABILITY_ID: CapabilityContract(
        PROJECT_ITEM_METADATA_READ_CAPABILITY_ID,
        "Read metadata and bounded type facts for one After Effects project item.",
        "read", "idempotent",
        "Reads project item metadata without changing After Effects state.",
        (
            "An After Effects project must be open.",
            "itemLocator must come from ae.project.context.read@1 or ae.project.items.list@1.",
        ),
        "aemcp.requirement.native.project-item-metadata-read",
        _PROJECT_ITEM_METADATA_INPUT_SCHEMA, _PROJECT_ITEM_METADATA_RESULT_SCHEMA,
        "project-item-metadata-read",
    ),
    COMPOSITION_SETTINGS_READ_CAPABILITY_ID: CapabilityContract(
        COMPOSITION_SETTINGS_READ_CAPABILITY_ID,
        "Read exact settings for one After Effects composition.",
        "read", "idempotent",
        "Reads composition settings without changing After Effects state.",
        (
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.context.read@1 or ae.project.items.list@1.",
        ),
        "aemcp.requirement.native.composition-settings-read",
        _COMPOSITION_SETTINGS_INPUT_SCHEMA, _COMPOSITION_SETTINGS_RESULT_SCHEMA,
        "composition-settings-read",
    ),
    COMPOSITION_WORK_AREA_SET_CAPABILITY_ID: CapabilityContract(
        COMPOSITION_WORK_AREA_SET_CAPABILITY_ID,
        "Set the exact work area of one After Effects composition.",
        "write", "idempotency-key",
        "Changes one composition work area and creates one After Effects Undo step.",
        (
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.context.read@1 or ae.project.items.list@1.",
            "start plus duration must fit within the composition duration.",
            "The requested work area must differ from the current work area.",
        ),
        "aemcp.requirement.native.composition-work-area-set",
        _COMPOSITION_WORK_AREA_SET_INPUT_SCHEMA, _COMPOSITION_WORK_AREA_SET_RESULT_SCHEMA,
        "composition-work-area-set",
    ),
    PROJECT_ITEM_NAME_SET_CAPABILITY_ID: CapabilityContract(
        PROJECT_ITEM_NAME_SET_CAPABILITY_ID,
        "Rename one After Effects project item.",
        "write", "idempotency-key",
        "Changes one project item name and creates one After Effects Undo step.",
        (
            "An After Effects project must be open.",
            "itemLocator must come from ae.project.context.read@1 or ae.project.items.list@1.",
            "name must differ from the current project item name.",
        ),
        "aemcp.requirement.native.project-item-name-set",
        _PROJECT_ITEM_NAME_SET_INPUT_SCHEMA, _PROJECT_ITEM_NAME_SET_RESULT_SCHEMA,
        "project-item-name-set",
    ),
    PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID: CapabilityContract(
        PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID,
        "Set or clear one After Effects project item comment.",
        "write", "idempotency-key",
        "Changes one project item comment and creates one After Effects Undo step.",
        (
            "An After Effects project must be open.",
            "itemLocator must come from ae.project.context.read@1 or ae.project.items.list@1.",
            "comment must differ from the current project item comment.",
        ),
        "aemcp.requirement.native.project-item-comment-set",
        _PROJECT_ITEM_COMMENT_SET_INPUT_SCHEMA, _PROJECT_ITEM_COMMENT_SET_RESULT_SCHEMA,
        "project-item-comment-set",
    ),
    PROJECT_ITEM_LABEL_SET_CAPABILITY_ID: CapabilityContract(
        PROJECT_ITEM_LABEL_SET_CAPABILITY_ID,
        "Set one numeric After Effects project item label slot.",
        "write", "idempotency-key",
        "Changes one project item label and creates one After Effects Undo step.",
        (
            "An After Effects project must be open.",
            "itemLocator must come from ae.project.context.read@1 or ae.project.items.list@1.",
            "labelId must differ from the current project item label.",
        ),
        "aemcp.requirement.native.project-item-label-set",
        _PROJECT_ITEM_LABEL_SET_INPUT_SCHEMA, _PROJECT_ITEM_LABEL_SET_RESULT_SCHEMA,
        "project-item-label-set",
    ),
    COMPOSITION_DUPLICATE_CAPABILITY_ID: CapabilityContract(
        COMPOSITION_DUPLICATE_CAPABILITY_ID,
        "Duplicate one After Effects composition with an explicit new name.",
        "write", "idempotency-key",
        "Adds one composition and creates one After Effects Undo step.",
        (
            "An After Effects project must be open.",
            "compositionLocator must come from ae.project.context.read@1 or ae.project.items.list@1.",
        ),
        "aemcp.requirement.native.composition-duplicate",
        _COMPOSITION_DUPLICATE_INPUT_SCHEMA, _COMPOSITION_DUPLICATE_RESULT_SCHEMA,
        "composition-duplicate",
    ),
}


def _validate_descriptor(
    descriptor: NativeCapabilityDescriptor,
    *,
    host_platform: NativePlatform,
    contract: CapabilityContract,
) -> None:
    requirements = tuple((item.id, item.contract_version) for item in descriptor.requirements)
    expected = (
        descriptor.capability_id == contract.capability_id
        and descriptor.capability_version == CAPABILITY_VERSION
        and descriptor.schema_version == 1
        and descriptor.engine == "native-aegp"
        and descriptor.summary == contract.summary
        and descriptor.risk == contract.risk
        and descriptor.mutability == ("read-only" if contract.risk == "read" else "mutating")
        and descriptor.idempotency == contract.idempotency
        and descriptor.cancellation == "before-dispatch"
        and descriptor.undo == ("not-applicable" if contract.risk == "read" else "ae-undo-group")
        and descriptor.side_effect_summary == contract.side_effect_summary
        and descriptor.preconditions == contract.preconditions
        and descriptor.input_contract_id == contract.input_contract_id
        and descriptor.result_contract_id == contract.result_contract_id
        and descriptor.contract_digest == contract.contract_digest
        and descriptor.contract_digest == _sha256_closed_json({
            "inputSchema": descriptor.input_schema,
            "resultSchema": descriptor.result_schema,
        })
        and descriptor.input_schema == contract.input_schema
        and descriptor.result_schema == contract.result_schema
        and requirements == ((contract.requirement_id, 1),)
        and host_platform in descriptor.compatibility.intended_platforms
    )
    if not expected:
        raise _structured_error(
            "NATIVE_CONTRACT_MISMATCH",
            f"Negotiated {contract.capability_id} contract does not match Core.",
        )


def _descriptor_validator(contract: CapabilityContract) -> Callable[..., None]:
    def validate(descriptor: NativeCapabilityDescriptor, *, host_platform: NativePlatform) -> None:
        _validate_descriptor(descriptor, host_platform=host_platform, contract=contract)
    return validate


def _value_digest(capability_id: str, value: _NativeModel) -> str:
    payload = value.model_dump(mode="json", by_alias=True)
    if capability_id == PROJECT_ITEM_METADATA_READ_CAPABILITY_ID:
        # The native wire omits unsupported type-specific facts instead of
        # serializing them as null.  Preserve required parentLocator=null.
        for field in ("width", "height", "duration", "pixelAspectRatio", "layerCount"):
            if payload.get(field) is None:
                payload.pop(field, None)
    return _sha256_closed_json({
        "capabilityId": capability_id,
        "capabilityVersion": CAPABILITY_VERSION,
        "value": payload,
    })


async def invoke_project_context_read(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    selection_offset: int,
    selection_limit: int,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> ProjectContextExecution:
    arguments = ProjectContextArguments(
        selection_offset=selection_offset,
        selection_limit=selection_limit,
    )
    contract = CAPABILITY_CONTRACTS[PROJECT_CONTEXT_READ_CAPABILITY_ID]
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=contract.capability_id,
        capability_version=CAPABILITY_VERSION,
        arguments=arguments.model_dump(mode="json", by_alias=True),
        locator=None,
        locator_field="",
        descriptor_validator=_descriptor_validator(contract),
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = ProjectContextValue.model_validate(result.value)
        digest = _value_digest(contract.capability_id, value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native project context did not match its typed contract.") from exc
    if (
        value.selection.offset != arguments.selection_offset
        or value.selection.limit != arguments.selection_limit
        or value.project_locator.host_instance_id != negotiation.host_instance_id
        or value.project_locator.session_id != negotiation.session_id
        or result.evidence.postcondition.kind != contract.postcondition_kind
        or result.evidence.postcondition.digest != digest
    ):
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native project context was not bound to its request and evidence.")
    return ProjectContextExecution(implementation=descriptor, negotiation=negotiation, value=value, evidence=result.evidence)


async def invoke_project_item_metadata_read(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    item_locator: NativeLocator | Mapping[str, Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> ProjectItemMetadataExecution:
    arguments = ProjectItemMetadataArguments(item_locator=item_locator)
    contract = CAPABILITY_CONTRACTS[PROJECT_ITEM_METADATA_READ_CAPABILITY_ID]
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=contract.capability_id,
        capability_version=CAPABILITY_VERSION,
        arguments=arguments.model_dump(mode="json", by_alias=True),
        locator=arguments.item_locator,
        locator_field="params.arguments.itemLocator",
        stale_locator_hint="Call ae_getProjectContext and copy a fresh item_locator.",
        descriptor_validator=_descriptor_validator(contract),
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = ProjectItemMetadataValue.model_validate(result.value)
        digest = _value_digest(contract.capability_id, value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native project item metadata did not match its typed contract.") from exc
    if (
        value.item_locator != arguments.item_locator
        or result.evidence.postcondition.kind != contract.postcondition_kind
        or result.evidence.postcondition.digest != digest
    ):
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native project item metadata was not bound to its request and evidence.")
    return ProjectItemMetadataExecution(implementation=descriptor, negotiation=negotiation, value=value, evidence=result.evidence)


async def invoke_composition_settings_read(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    composition_locator: NativeLocator | Mapping[str, Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> CompositionSettingsExecution:
    arguments = CompositionSettingsArguments(composition_locator=composition_locator)
    contract = CAPABILITY_CONTRACTS[COMPOSITION_SETTINGS_READ_CAPABILITY_ID]
    negotiation, descriptor, _request, result = await _invoke_native_read_request(
        backend,
        request_id=request_id,
        capability_id=contract.capability_id,
        capability_version=CAPABILITY_VERSION,
        arguments=arguments.model_dump(mode="json", by_alias=True),
        locator=arguments.composition_locator,
        locator_field="params.arguments.compositionLocator",
        stale_locator_hint="Call ae_getProjectContext and copy a fresh composition_locator.",
        descriptor_validator=_descriptor_validator(contract),
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    try:
        value = CompositionSettingsValue.model_validate(result.value)
        digest = _value_digest(contract.capability_id, value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native composition settings did not match its typed contract.") from exc
    if (
        value.composition_locator != arguments.composition_locator
        or result.evidence.postcondition.kind != contract.postcondition_kind
        or result.evidence.postcondition.digest != digest
    ):
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native composition settings were not bound to the request and evidence.")
    return CompositionSettingsExecution(implementation=descriptor, negotiation=negotiation, value=value, evidence=result.evidence)


async def _invoke_package_write_request(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    contract: CapabilityContract,
    arguments: _NativeModel,
    locator: NativeLocator,
    locator_field: str,
    allow_replay: bool,
    inspect_hint: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
) -> tuple[NativeNegotiation, NativeCapabilityDescriptor, NativeInvokeRequest, NativeInvokeResult]:
    """Shared dispatch guard for only the five writes in this capability package."""

    _ensure_active(deadline_unix_ms, cancellation)
    negotiation = await backend.negotiate(deadline_unix_ms=deadline_unix_ms, cancellation=cancellation)
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
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native capability registry could not be verified.") from exc
    if (
        capabilities.session_id != negotiation.session_id
        or capabilities.detail != capability_detail
        or capabilities.next_cursor is not None
        or capabilities.query_digest != expected_query_digest
        or capabilities.capabilities_digest != registry_digest
        or capabilities.capabilities_digest != negotiation.capabilities_digest
    ):
        raise _structured_error("NATIVE_CONTRACT_MISMATCH", "Native capabilities were not bound to the negotiated session.")
    matches = [
        item for item in capabilities.items
        if item.capability_id == contract.capability_id and item.capability_version == CAPABILITY_VERSION
    ]
    descriptor = matches[0] if len(matches) == 1 else None
    if descriptor is None:
        raise _structured_error("NATIVE_UNSUPPORTED", f"Native host did not advertise {contract.capability_id}@1.")
    _validate_descriptor(descriptor, host_platform=negotiation.host_platform, contract=contract)
    if locator.host_instance_id != negotiation.host_instance_id or locator.session_id != negotiation.session_id:
        raise _structured_error(
            "STALE_LOCATOR",
            "Native locator does not belong to the negotiated host session.",
            details={"field": locator_field, "capabilityId": contract.capability_id},
            recovery_hint="Call ae_getProjectContext and copy a fresh locator before retrying.",
        )
    _ensure_active(deadline_unix_ms, cancellation)
    request = NativeInvokeRequest(
        request_id=request_id,
        capability_id=contract.capability_id,
        capability_version=CAPABILITY_VERSION,
        arguments=arguments.model_dump(mode="json", by_alias=True),
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
        or (result.replayed and not allow_replay)
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
            f"Native {contract.capability_id} result could not be verified after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": contract.capability_id},
        )
    return negotiation, descriptor, request, result


ValueT = TypeVar("ValueT", bound=_NativeModel)


def _validate_write_value(
    *,
    contract: CapabilityContract,
    result: NativeInvokeResult,
    value_model: type[ValueT],
    inspect_hint: str,
) -> ValueT:
    try:
        value = value_model.model_validate(result.value)
        digest = _value_digest(contract.capability_id, value)
    except (ValidationError, TypeError, ValueError, UnicodeError) as exc:
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            f"Native {contract.capability_id} value was malformed after dispatch.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": contract.capability_id},
        ) from exc
    if result.evidence.postcondition.kind != contract.postcondition_kind or result.evidence.postcondition.digest != digest:
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE",
            f"Native {contract.capability_id} postcondition evidence did not verify.",
            retryable=False,
            side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=inspect_hint),
            details={"capabilityId": contract.capability_id},
        )
    return value


async def invoke_composition_work_area_set(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    composition_locator: NativeLocator | Mapping[str, Any],
    start: ExactTimeInput | Mapping[str, Any],
    duration: ExactTimeInput | Mapping[str, Any],
    idempotency_key: str,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None = None,
) -> CompositionWorkAreaSetExecution:
    arguments = CompositionWorkAreaSetArguments(
        composition_locator=composition_locator,
        start=start,
        duration=duration,
        idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[COMPOSITION_WORK_AREA_SET_CAPABILITY_ID]
    hint = "Read composition settings and inspect the Undo stack before issuing another work-area write."
    negotiation, descriptor, request, result = await _invoke_package_write_request(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        locator=arguments.composition_locator, locator_field="params.arguments.compositionLocator",
        allow_replay=False, inspect_hint=hint, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    value = _validate_write_value(contract=contract, result=result, value_model=CompositionWorkAreaSetValue, inspect_hint=hint)
    if (
        value.composition_locator != arguments.composition_locator
        or not _times_equal(value.after_work_area.start, arguments.start)
        or not _times_equal(value.after_work_area.duration, arguments.duration)
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE", "Native work-area readback did not match the requested value.",
            retryable=False, side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=hint),
            details={"capabilityId": contract.capability_id},
        )
    return CompositionWorkAreaSetExecution(
        implementation=descriptor, negotiation=negotiation, transport_request_id=request.request_id,
        idempotency_key=arguments.idempotency_key, replayed=result.replayed, value=value, evidence=result.evidence,
    )


async def _invoke_item_write(
    backend: NativeInvokeBackend,
    *,
    request_id: str,
    contract: CapabilityContract,
    arguments: _ProjectItemWriteArguments,
    value_model: type[ValueT],
    requested_value: Any,
    read_after: Callable[[ValueT], Any],
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken | None,
) -> tuple[NativeNegotiation, NativeCapabilityDescriptor, NativeInvokeRequest, NativeInvokeResult, ValueT]:
    hint = "Read the project item metadata and inspect the Undo stack before issuing another metadata write."
    negotiation, descriptor, request, result = await _invoke_package_write_request(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        locator=arguments.item_locator, locator_field="params.arguments.itemLocator",
        allow_replay=False, inspect_hint=hint, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    value = _validate_write_value(contract=contract, result=result, value_model=value_model, inspect_hint=hint)
    if value.item_locator != arguments.item_locator or read_after(value) != requested_value:  # type: ignore[attr-defined]
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE", "Native project-item readback did not match the requested value.",
            retryable=False, side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=hint),
            details={"capabilityId": contract.capability_id},
        )
    return negotiation, descriptor, request, result, value


async def invoke_project_item_name_set(
    backend: NativeInvokeBackend, *, request_id: str,
    item_locator: NativeLocator | Mapping[str, Any], name: str, idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> ProjectItemNameSetExecution:
    arguments = ProjectItemNameSetArguments(item_locator=item_locator, name=name, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[PROJECT_ITEM_NAME_SET_CAPABILITY_ID]
    negotiation, descriptor, request, result, value = await _invoke_item_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=ProjectItemNameSetValue, requested_value=arguments.name,
        read_after=lambda item: item.after_name, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    return ProjectItemNameSetExecution(implementation=descriptor, negotiation=negotiation, transport_request_id=request.request_id, idempotency_key=arguments.idempotency_key, replayed=result.replayed, value=value, evidence=result.evidence)


async def invoke_project_item_comment_set(
    backend: NativeInvokeBackend, *, request_id: str,
    item_locator: NativeLocator | Mapping[str, Any], comment: str, idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> ProjectItemCommentSetExecution:
    arguments = ProjectItemCommentSetArguments(item_locator=item_locator, comment=comment, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID]
    negotiation, descriptor, request, result, value = await _invoke_item_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=ProjectItemCommentSetValue, requested_value=arguments.comment,
        read_after=lambda item: item.after_comment, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    return ProjectItemCommentSetExecution(implementation=descriptor, negotiation=negotiation, transport_request_id=request.request_id, idempotency_key=arguments.idempotency_key, replayed=result.replayed, value=value, evidence=result.evidence)


async def invoke_project_item_label_set(
    backend: NativeInvokeBackend, *, request_id: str,
    item_locator: NativeLocator | Mapping[str, Any], label_id: int, idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> ProjectItemLabelSetExecution:
    arguments = ProjectItemLabelSetArguments(item_locator=item_locator, label_id=label_id, idempotency_key=idempotency_key)
    contract = CAPABILITY_CONTRACTS[PROJECT_ITEM_LABEL_SET_CAPABILITY_ID]
    negotiation, descriptor, request, result, value = await _invoke_item_write(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        value_model=ProjectItemLabelSetValue, requested_value=arguments.label_id,
        read_after=lambda item: item.after_label_id, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    return ProjectItemLabelSetExecution(implementation=descriptor, negotiation=negotiation, transport_request_id=request.request_id, idempotency_key=arguments.idempotency_key, replayed=result.replayed, value=value, evidence=result.evidence)


async def invoke_composition_duplicate(
    backend: NativeInvokeBackend, *, request_id: str,
    composition_locator: NativeLocator | Mapping[str, Any], new_name: str, idempotency_key: str,
    deadline_unix_ms: int, cancellation: NativeCancellationToken | None = None,
) -> CompositionDuplicateExecution:
    arguments = CompositionDuplicateArguments(
        composition_locator=composition_locator, new_name=new_name, idempotency_key=idempotency_key,
    )
    contract = CAPABILITY_CONTRACTS[COMPOSITION_DUPLICATE_CAPABILITY_ID]
    hint = "Refresh project context, inspect the project item count and Undo stack, then decide whether another duplicate is needed."
    negotiation, descriptor, request, result = await _invoke_package_write_request(
        backend, request_id=request_id, contract=contract, arguments=arguments,
        locator=arguments.composition_locator, locator_field="params.arguments.compositionLocator",
        allow_replay=True, inspect_hint=hint, deadline_unix_ms=deadline_unix_ms, cancellation=cancellation,
    )
    value = _validate_write_value(contract=contract, result=result, value_model=CompositionDuplicateValue, inspect_hint=hint)
    source = value.source_composition_locator
    original = arguments.composition_locator
    if (
        value.new_settings.name != arguments.new_name
        or source.host_instance_id != original.host_instance_id
        or source.session_id != original.session_id
        or source.generation <= original.generation
    ):
        raise NativeBackendError(
            "POSSIBLY_SIDE_EFFECTING_FAILURE", "Native duplicate identity did not match the requested source and name.",
            retryable=False, side_effect="may-have-occurred",
            recovery=NativeRecovery(action="inspect-state", hint=hint),
            details={"capabilityId": contract.capability_id},
        )
    if result.replayed:
        try:
            replay = await invoke_composition_settings_read(
                backend,
                request_id="replay-check-" + hashlib.sha256(request_id.encode("utf-8")).hexdigest()[:32],
                composition_locator=value.new_composition_locator,
                deadline_unix_ms=deadline_unix_ms,
                cancellation=cancellation,
            )
        except NativeBackendError as exc:
            raise _structured_error(
                "DUPLICATE_REQUEST",
                "The committed duplicate key no longer identifies a verifiable composition.",
                details={"field": "params.arguments.idempotencyKey", "capabilityId": contract.capability_id},
                recovery_hint=hint,
            ) from exc
        replay_snapshot = CompositionSettingsSnapshot.model_validate(
            replay.value.model_dump(mode="json", by_alias=True, exclude={"composition_locator"})
        )
        if replay_snapshot != value.new_settings:
            raise _structured_error(
                "DUPLICATE_REQUEST",
                "The committed duplicate key no longer matches the current composition state.",
                details={"field": "params.arguments.idempotencyKey", "capabilityId": contract.capability_id},
                recovery_hint=hint,
            )
    return CompositionDuplicateExecution(
        implementation=descriptor, negotiation=negotiation, transport_request_id=request.request_id,
        idempotency_key=arguments.idempotency_key, replayed=result.replayed, value=value, evidence=result.evidence,
    )


__all__ = [
    "CAPABILITY_CONTRACTS",
    "CAPABILITY_VERSION",
    "COMPOSITION_DUPLICATE_CAPABILITY_ID",
    "COMPOSITION_SETTINGS_READ_CAPABILITY_ID",
    "COMPOSITION_WORK_AREA_SET_CAPABILITY_ID",
    "PROJECT_CONTEXT_READ_CAPABILITY_ID",
    "PROJECT_ITEM_COMMENT_SET_CAPABILITY_ID",
    "PROJECT_ITEM_LABEL_SET_CAPABILITY_ID",
    "PROJECT_ITEM_METADATA_READ_CAPABILITY_ID",
    "PROJECT_ITEM_NAME_SET_CAPABILITY_ID",
    "CompositionDuplicateExecution",
    "CompositionDuplicateValue",
    "CompositionSettingsExecution",
    "CompositionSettingsSnapshot",
    "CompositionSettingsValue",
    "CompositionWorkAreaSetExecution",
    "CompositionWorkAreaSetValue",
    "ExactRatio",
    "ExactTime",
    "ProjectContextExecution",
    "ProjectContextValue",
    "ProjectItemCommentSetExecution",
    "ProjectItemLabelSetExecution",
    "ProjectItemMetadataExecution",
    "ProjectItemMetadataValue",
    "ProjectItemNameSetExecution",
    "WorkArea",
    "invoke_composition_duplicate",
    "invoke_composition_settings_read",
    "invoke_composition_work_area_set",
    "invoke_project_context_read",
    "invoke_project_item_comment_set",
    "invoke_project_item_label_set",
    "invoke_project_item_metadata_read",
    "invoke_project_item_name_set",
]
