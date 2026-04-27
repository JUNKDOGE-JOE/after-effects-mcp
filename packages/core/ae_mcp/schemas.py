"""Pydantic schemas for the 24 ae-mcp verbs.

Each schema corresponds 1:1 with a verb in HANDLERS. pydantic generates
JSON schema for MCP tools/list at runtime; keep field docstrings short — the
LLM reads them in the tool-picker.
"""

from __future__ import annotations

from typing import Any, List, Literal, Optional, Tuple, Union

from pydantic import BaseModel, ConfigDict, Field


# Common literal set used by several schemas (effects / layer types).
LayerType = Literal[
    "solid", "text", "shape", "null", "adjustment", "camera", "light"
]

SnapshotMethod = Literal["DesktopCopy", "PrintWindow"]


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
    """ae.layers — list layers in a comp."""
    comp_id: Optional[str] = Field(
        None,
        description="AE comp id. Omit for the active comp.",
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


# ---------------------------------------------------------------------------
# AEBMethod plugin-specific verbs (Topic B: Isolate Selected + Toast Query)
# ---------------------------------------------------------------------------


class AeIsolateToggleArgs(_StrictModel):
    """ae.isolateToggle — toggle Motion4-style '/' timeline isolation session."""
    pass


class AeToastQueryArgs(_StrictModel):
    """ae.toastQuery — read current active toast queue for test assertions."""
    pass


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


class AeGetKeyframesArgs(_StrictModel):
    """ae.getKeyframes — keyframe data for a property path."""
    comp_id: Optional[str] = Field(None)
    layer_id: int = Field(..., ge=1)
    path: str = Field(...)


SearchScope = Literal["layers", "expressions", "effects", "comps", "items"]


class AeSearchProjectArgs(_StrictModel):
    """ae.searchProject — fuzzy search across the whole project."""
    query: str = Field(..., description="Multi-word AND; '|' OR groups.")
    scope: List[SearchScope] = Field(
        default_factory=lambda: ["layers", "expressions", "effects", "comps", "items"],
        description="Which kinds of objects to scan.",
    )
    limit: int = Field(100, ge=1, le=500)


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
    "ae.applyEffect": AeApplyEffectArgs,
    "ae.ping": AePingArgs,
    "ae.createLayer": AeCreateLayerArgs,
    "ae.setProperty": AeSetPropertyArgs,
    "ae.moveLayer": AeMoveLayerArgs,
    "ae.selectLayers": AeSelectLayersArgs,
    "ae.setTime": AeSetTimeArgs,
    "ae.getTime": AeGetTimeArgs,
    "ae.isolateToggle": AeIsolateToggleArgs,
    "ae.toastQuery":    AeToastQueryArgs,
    "ae.getProperties": AeGetPropertiesArgs,
    "ae.scanPropertyTree": AeScanPropertyTreeArgs,
    "ae.inspectPropertyCapabilities": AeInspectPropertyCapabilitiesArgs,
    "ae.getExpressions": AeGetExpressionsArgs,
    "ae.getKeyframes": AeGetKeyframesArgs,
    "ae.searchProject": AeSearchProjectArgs,
}

assert len(SCHEMAS) == 24, f"expected 24 verbs, got {len(SCHEMAS)}"
