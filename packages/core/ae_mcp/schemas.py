"""Pydantic schemas for the registered ae-mcp verbs.

Each schema corresponds 1:1 with a verb in HANDLERS. pydantic generates
JSON schema for MCP tools/list at runtime; keep field docstrings short — the
LLM reads them in the tool-picker.
"""

from __future__ import annotations

from typing import Annotated, Any, Dict, List, Literal, Optional, Tuple, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    constr,
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


ToolArtifactKind = Literal["jsx", "expression", "prompt-skill", "recipe", "diagnostic"]
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


class AeToolUseArgs(_StrictModel):
    """ae.toolUse — render or run the prepare, grant, execute protocol."""
    artifact_id: Optional[str] = Field(None, min_length=1, max_length=256)
    action: Literal["render", "prepare", "grant", "execute"]
    operation: Optional[ToolArtifactOperation] = None
    args: Dict[str, Any] = Field(default_factory=dict)
    target: Dict[str, Any] = Field(default_factory=dict)
    plan_hash: Optional[str] = Field(None, min_length=1, max_length=256)
    grant_id: Optional[str] = Field(None, min_length=1, max_length=256)
    grant_scope: Optional[Literal["once", "session"]] = None

    @model_validator(mode="after")
    def validate_action_shape(self) -> "AeToolUseArgs":
        if self.action == "render":
            if self.artifact_id is None or self.plan_hash is not None or self.grant_id is not None:
                raise ValueError("render requires artifact_id and forbids plan_hash/grant_id")
            if self.grant_scope is not None or self.target:
                raise ValueError("render forbids grant_scope and target")
            if self.operation not in {None, "render"}:
                raise ValueError("render operation must be render")
            self.operation = "render"
        elif self.action == "prepare":
            if self.artifact_id is None or self.operation is None:
                raise ValueError("prepare requires artifact_id and operation")
            if self.plan_hash is not None or self.grant_id is not None or self.grant_scope is not None:
                raise ValueError("prepare forbids plan_hash/grant_id/grant_scope")
        elif self.action == "grant":
            if self.plan_hash is None or self.grant_scope is None:
                raise ValueError("grant requires plan_hash and grant_scope")
            if self.artifact_id is not None or self.grant_id is not None:
                raise ValueError("grant forbids artifact_id/grant_id")
            if self.operation is not None or self.args or self.target:
                raise ValueError("grant forbids operation/args/target")
        else:
            if self.plan_hash is None or self.grant_id is None:
                raise ValueError("execute requires plan_hash and grant_id")
            if self.artifact_id is not None or self.grant_scope is not None:
                raise ValueError("execute forbids artifact_id/grant_scope")
            if self.operation is not None or self.args or self.target:
                raise ValueError("execute forbids operation/args/target")
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

assert len(SCHEMAS) == 49, f"expected 49 verbs, got {len(SCHEMAS)}"
