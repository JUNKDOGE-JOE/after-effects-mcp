"""Pydantic schemas for the 22 ae-mcp verbs.

Each schema corresponds 1:1 with a verb in HANDLERS. pydantic generates
JSON schema for MCP tools/list at runtime; keep field docstrings short — the
LLM reads them in the tool-picker.
"""

from __future__ import annotations

from typing import Annotated, Any, Dict, List, Literal, Optional, Tuple, Union

from pydantic import BaseModel, ConfigDict, Field, constr


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
            "viewer, so AE's main thread has time to repaint at the new time. "
            "Lower = faster, riskier. 0 = no wait (will likely capture stale viewer)."
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
        ...,
        description="Scalar or array. Numeric arrays are passed as-is to setValue.",
    )
    at_time: Optional[float] = Field(
        None, description="If set, writes a keyframe at this time instead of the constant value."
    )


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
    layer_ids: List[int] = Field(..., description="1-based layer indices to scan.")
    query: str = Field(..., description="Multi-word AND; '|' separates OR groups.")
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


# ---------------------------------------------------------------------------
# Registry of verb -> schema (handlers.core / handlers.typed reference this)
# ---------------------------------------------------------------------------


SCHEMAS = {
    "ae.init": AeInitArgs,
    "ae.overview": AeOverviewArgs,
    "ae.layers": AeLayersArgs,
    "ae.readProps": AeReadPropsArgs,
    "ae.exec": AeExecArgs,
    "ae.checkpoint": AeCheckpointArgs,
    "ae.revert": AeRevertArgs,
    "ae.snapshot": AeSnapshotArgs,
    "ae.previewFrame": AePreviewFrameArgs,
    "ae.applyEffect": AeApplyEffectArgs,
    "ae.ping": AePingArgs,
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
    "ae.createRig": AeCreateRigArgs,
}

assert len(SCHEMAS) == 30, f"expected 30 verbs, got {len(SCHEMAS)}"
