"""Pydantic schemas for the registered ae-mcp verbs.

Each schema corresponds 1:1 with a verb in HANDLERS. pydantic generates
JSON schema for MCP tools/list at runtime; keep field docstrings short — the
LLM reads them in the tool-picker.
"""

from __future__ import annotations

from copy import deepcopy
import math
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from typing import Annotated, Any, Dict, List, Literal, Optional, Tuple, Union

from jsonschema import Draft202012Validator
from pydantic import (
    BaseModel as _PydanticBaseModel,
    ConfigDict,
    Field,
    constr,
    field_validator,
    model_validator,
)

from ae_mcp.native_exec_generated import (
    NATIVE_EXEC_INPUT_SCHEMA,
    PRIMITIVES as NATIVE_EXEC_PRIMITIVES,
)


# Common literal set used by several schemas (effects / layer types).
LayerType = Literal[
    "solid", "text", "shape", "null", "adjustment", "camera", "light"
]

SnapshotMethod = Literal["DesktopCopy", "PrintWindow"]
OutputFormat = Literal["json", "text"]
NonNegativeFloat = Annotated[float, Field(ge=0)]


class _StrictModel(_PydanticBaseModel):
    """Base: forbid extras so typos surface early."""
    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------------------
# Core 9
# ---------------------------------------------------------------------------


_LOCATOR_UUID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"


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


def _valid_layer_name(value: str, *, field: str) -> str:
    if not value or "\x00" in value or any(
        0xD800 <= ord(character) <= 0xDFFF for character in value
    ):
        raise ValueError(f"{field} must contain 1-255 non-NUL Unicode scalar values")
    return value


_LAYER_STRETCH_DECIMAL = r"^-?(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,6})?$"


def _same_locator_context(left: _AeLocatorInput, right: _AeLocatorInput) -> bool:
    """Return whether two locators belong to the same native graph context."""

    return (
        left.host_instance_id,
        left.session_id,
        left.project_id,
        left.generation,
    ) == (
        right.host_instance_id,
        right.session_id,
        right.project_id,
        right.generation,
    )


_PROPERTY_DECIMAL = r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"


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


NativeProgramOperation = Dict[str, Any]
_NATIVE_EXEC_VALIDATOR = Draft202012Validator(NATIVE_EXEC_INPUT_SCHEMA)
_NATIVE_EXEC_PRIMITIVE_BY_ID = {
    row["id"]: row for row in NATIVE_EXEC_PRIMITIVES
}


class AeNativeExecArgs(_StrictModel):
    """ae.nativeExec — execute one bounded linear program of curated AEGP primitives.

    Use ae.exec for operations supported by the maintained AE scripting object
    model. Native programs allow at most 64 ordered operations and may reference
    only earlier request-local values. Programs containing writes require one
    stable operationKey and one real AE undoGroup.
    """

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        strict=True,
    )

    operation_key: Optional[str] = Field(default=None, alias="operationKey")
    undo_group: Optional[str] = Field(default=None, alias="undoGroup")
    operations: List[NativeProgramOperation] = Field(
        min_length=1,
        max_length=64,
    )

    @model_validator(mode="before")
    @classmethod
    def _generated_contract(cls, value: Any) -> Any:
        errors = sorted(
            _NATIVE_EXEC_VALIDATOR.iter_errors(value),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            error = errors[0]
            field = ".".join(str(part) for part in error.absolute_path)
            location = f" at {field}" if field else ""
            raise ValueError(
                f"native program does not match the generated schema{location}: "
                f"{error.message}"
            )
        return value

    @model_validator(mode="after")
    def _ordered_reference_frame(self) -> "AeNativeExecArgs":
        saved_kinds: dict[str, str] = {}
        public_names: set[str] = set()
        for index, operation in enumerate(self.operations):
            primitive = _NATIVE_EXEC_PRIMITIVE_BY_ID[operation["op"]]
            arguments = operation["args"]
            for field, reference in primitive["reference_arguments"].items():
                if field not in arguments:
                    if reference["required"]:
                        raise ValueError(
                            f"operations.{index}.args.{field} is required"
                        )
                    continue
                referenced_name = arguments[field]["ref"]
                actual_kind = saved_kinds.get(referenced_name)
                if actual_kind is None:
                    raise ValueError(
                        f"operations.{index}.args.{field} must reference an "
                        "earlier saved value"
                    )
                expected_kind = reference["kind"]
                if actual_kind != expected_kind:
                    raise ValueError(
                        f"operations.{index}.args.{field} expects "
                        f"{expected_kind}, got {actual_kind}"
                    )

            save_as = operation.get("saveAs")
            return_as = operation.get("returnAs")
            for field, name in (("saveAs", save_as), ("returnAs", return_as)):
                if name is None:
                    continue
                if name in public_names:
                    raise ValueError(
                        f"operations.{index}.{field} duplicates named value {name}"
                    )
                public_names.add(name)
            if return_as is not None and primitive["exportable"] is not True:
                raise ValueError(
                    f"operations.{index}.returnAs cannot export "
                    f"{primitive['result_kind']}"
                )
            if save_as is not None:
                saved_kinds[save_as] = primitive["result_kind"]
        return self

    @classmethod
    def __get_pydantic_json_schema__(cls, _core_schema, _handler):
        schema = deepcopy(NATIVE_EXEC_INPUT_SCHEMA)
        schema["title"] = cls.__name__
        schema["description"] = (cls.__doc__ or "").strip()
        return schema


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
    """ae.previewFrame — return real composition pixels as PNG image content.

    Preview before and after visible edits, and at intermediate checkpoints.
    Call after the latest write and use only the newest captureId so an older
    frame is not mistaken for current state. Frames can contain private project
    material; preview only the user-authorized composition and times. Use scale
    or selected times when a smaller visual review is sufficient.

    The composition background appears with its RGB but alpha 0 where no layer
    covers the frame: After Effects paints that background in its viewport
    without compositing it into the exported alpha. A transparent preview pixel
    with the configured background RGB therefore does not mean the background
    setting write failed.
    """
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
        False,
        description=(
            "Also attach base64 PNG bytes inside each JSON frame. First-class "
            "MCP image content is always returned; leave false to avoid sending "
            "a duplicate inline copy."
        ),
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


class AePingArgs(_StrictModel):
    """ae.ping — handshake smoke test for live diagnostics."""
    expect: str = Field("pong", description="String to echo back.")


# ---------------------------------------------------------------------------
# Typed 6 (Python builds JSX, dispatches via ae.exec)
# ---------------------------------------------------------------------------


class AeValidateExpressionsArgs(_StrictModel):
    """ae.validateExpressions — force-evaluate expressions and report errors."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")
    layer_ids: Optional[List[int]] = Field(None, description="Restrict to these layers.")
    prop: Optional[str] = Field(None, description="matchName/name substring filter.")
    sample_times: Optional[List[NonNegativeFloat]] = Field(
        None, description="Times to evaluate. Default: current comp time."
    )
    max_results: int = Field(500, ge=1, le=2000)


SearchScope = Literal["layers", "expressions", "effects", "comps", "items"]
SkillTemplateType = Literal["jsx", "prompt"]
SkillName = constr(pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
RigType = Literal["transform_controller", "effect_controls", "puppet_pin_nulls", "apply_preset"]
RigControlType = Literal["slider", "angle", "checkbox", "color"]


class AeSkillListArgs(_StrictModel):
    """ae.skillList — list stored reusable prompt/JSX skills."""
    include_templates: bool = Field(
        False, description="When true, include full template and args_schema."
    )


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


class _AePanelToolIndexArgs(AeToolIndexArgs):
    """Private panel-only index schema; never advertised through tools/list."""

    kinds: Optional[List[PanelToolArtifactKind]] = None


class _AePanelToolSearchArgs(AeToolSearchArgs):
    """Private panel-only search schema; never advertised through tools/list."""

    kinds: Optional[List[PanelToolArtifactKind]] = None


class _AeToolSaveArtifactDraft(_StrictModel):
    name: str = Field(..., min_length=1, max_length=128)
    description: str = Field(..., max_length=4096)
    kind: Literal["jsx"]
    category: str = Field(..., min_length=1, max_length=128)
    tags: List[
        Annotated[str, Field(min_length=1, max_length=64)]
    ] = Field(..., max_length=32)
    compatibility: Dict[str, Any]
    declared_risk: ToolArtifactRisk
    content: str
    args_schema: Dict[str, Any]


class _AeToolSaveCreateRequest(_StrictModel):
    mode: Literal["create"]
    intent: Literal["user-requested", "model-curated"]
    status: Literal["candidate", "saved"]
    artifact: _AeToolSaveArtifactDraft

    @model_validator(mode="after")
    def validate_intent_status(self) -> "_AeToolSaveCreateRequest":
        if self.intent == "model-curated" and self.status != "candidate":
            raise ValueError("model-curated save may create only a candidate")
        return self


class _AeToolSavePromoteRequest(_StrictModel):
    mode: Literal["promote"]
    intent: Literal["user-requested"]
    status: Literal["saved"]
    artifact_id: str = Field(..., min_length=1, max_length=256)
    expected_revision: int = Field(..., strict=True, ge=1)
    expected_content_hash: str = Field(..., pattern=r"^[0-9a-f]{64}$")


_AeToolSaveRequest = Annotated[
    Union[_AeToolSaveCreateRequest, _AeToolSavePromoteRequest],
    Field(discriminator="mode"),
]


class AeToolUseArgs(_StrictModel):
    """ae.toolUse — render or run the hash-bound execution protocol."""
    artifact_id: Optional[str] = Field(None, min_length=1, max_length=256)
    action: Literal[
        "render",
        "prepare",
        "grant",
        "execute",
        "start",
        "status",
        "cancel",
        "history",
        "save",
    ]
    save: Optional[_AeToolSaveRequest] = None
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
        if self.action == "save":
            if self.save is None:
                raise ValueError("save requires a save payload")
            if (
                any(
                    value is not None
                    for value in (
                        self.artifact_id,
                        self.operation,
                        self.plan_hash,
                        self.grant_id,
                        self.grant_scope,
                        self.execution_id,
                        self.operation_id,
                        self.limit,
                    )
                )
                or self.args
                or self.target
            ):
                raise ValueError("save accepts a save payload only")
        elif self.save is not None:
            raise ValueError("save payload requires action save")
        elif self.action == "render":
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


_MEDIA_DECIMAL = r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$"


def _valid_media_path(value: str) -> None:
    if "\x00" in value or any(0xD800 <= ord(character) <= 0xDFFF for character in value):
        raise ValueError("source_path must contain only non-NUL Unicode scalar values")


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
    "ae.exec": AeExecArgs,
    "ae.nativeExec": AeNativeExecArgs,
    "ae.checkpoint": AeCheckpointArgs,
    "ae.revert": AeRevertArgs,
    "ae.snapshot": AeSnapshotArgs,
    "ae.previewFrame": AePreviewFrameArgs,
    "ae.ping": AePingArgs,
    "ae.status": AeStatusArgs,
    "ae.diagnose": AeDiagnoseArgs,
    "ae.validateExpressions": AeValidateExpressionsArgs,
    "ae.skillList": AeSkillListArgs,
    "ae.skillUse": AeSkillUseArgs,
    "ae.toolIndex": AeToolIndexArgs,
    "ae.toolSearch": AeToolSearchArgs,
    "ae.toolInspect": AeToolInspectArgs,
    "ae.toolUse": AeToolUseArgs,
}

assert len(SCHEMAS) == 16, f"expected final public registry, got {len(SCHEMAS)}"
