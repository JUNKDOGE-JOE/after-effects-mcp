"""Pydantic schemas for the 15 AEBM MCP verbs.

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

    The aebm-file backend does NOT implement the Atom-style path walker, so
    callers must supply explicit JSX. See AEBM_MCP.md for examples.
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
        None, description="Human-readable checkpoint tag (ignored in aebm-file)."
    )
    timeout_sec: int = Field(
        30, ge=1, le=600, description="Per-call timeout in seconds (default 30)."
    )


class AeCheckpointArgs(_StrictModel):
    """ae.checkpoint — list recent checkpoints (stub: returns empty)."""
    limit: int = Field(20, ge=1, le=200)


class AeRevertArgs(_StrictModel):
    """ae.revert — revert to a checkpoint (stub: returns NotImplemented)."""
    checkpoint_id: str = Field(..., description="Checkpoint id to revert to.")
    branch_before_revert: bool = Field(
        False, description="If true, branch current state before reverting."
    )


class AeSnapshotArgs(_StrictModel):
    """ae.snapshot — capture a PNG of the AE viewer via Win32 BitBlt."""
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
        description="DesktopCopy (default, works for D3D11) or PrintWindow (GDI-only, diagnostic).",
    )


class AeApplyEffectArgs(_StrictModel):
    """ae.applyEffect — apply an effect to a layer by match-name."""
    comp_id: Optional[str] = Field(None, description="AE comp id. Omit for active comp.")
    layer_id: int = Field(..., ge=1, description="1-based layer index.")
    effect_match_name: str = Field(
        ...,
        description="Effect matchName, e.g. 'ADBE Gaussian Blur 2' or 'ADBE Drop Shadow'.",
    )


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
    "ae.createLayer": AeCreateLayerArgs,
    "ae.setProperty": AeSetPropertyArgs,
    "ae.moveLayer": AeMoveLayerArgs,
    "ae.selectLayers": AeSelectLayersArgs,
    "ae.setTime": AeSetTimeArgs,
    "ae.getTime": AeGetTimeArgs,
}

assert len(SCHEMAS) == 15, f"expected 15 verbs, got {len(SCHEMAS)}"
