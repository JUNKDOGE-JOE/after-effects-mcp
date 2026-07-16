"""Single source of truth for MCP tool annotations.

External agent frameworks run their own approval tiers; these hints are what
their auto-review modes branch on. Keep the dict exhaustive - test_annotations
enforces one entry per registered verb.
"""
from __future__ import annotations

from mcp.types import ToolAnnotations


def _ann(read_only: bool, destructive: bool, idempotent: bool) -> ToolAnnotations:
    return ToolAnnotations(
        readOnlyHint=read_only,
        destructiveHint=destructive,
        idempotentHint=idempotent,
    )


# Classification rules:
# - read/diagnostic/list/get/status/search/snapshot/preview/validate -> read-only
# - set/move/select/update-style writes -> non-destructive, usually idempotent
# - create/apply/checkpoint/use-style writes -> non-destructive, not idempotent
# - delete/revert/arbitrary code execution -> destructive, not idempotent
VERB_ANNOTATIONS: dict[str, ToolAnnotations] = {
    "ae.init": _ann(True, False, True),
    "ae.overview": _ann(True, False, True),
    "ae.projectSummary": _ann(True, False, True),
    "ae.getProjectBitDepth": _ann(True, False, True),
    "ae.setProjectBitDepth": _ann(False, False, True),
    "ae.listProjectItems": _ann(True, False, True),
    "ae.listCompositionLayers": _ann(True, False, True),
    "ae.listSelectedLayers": _ann(True, False, True),
    "ae.getCompositionTime": _ann(True, False, True),
    "ae.setCompositionTime": _ann(False, False, True),
    "ae.createCompositionLayer": _ann(False, False, True),
    "ae.listLayerProperties": _ann(True, False, True),
    "ae.setLayerPropertyValue": _ann(False, False, True),
    "ae.layers": _ann(True, False, True),
    "ae.readProps": _ann(True, False, True),
    "ae.exec": _ann(False, True, False),
    "ae.checkpoint": _ann(False, False, False),
    "ae.revert": _ann(False, True, False),
    "ae.snapshot": _ann(True, False, True),
    "ae.previewFrame": _ann(True, False, True),
    "ae.applyEffect": _ann(False, False, False),
    "ae.ping": _ann(True, False, True),
    "ae.createRig": _ann(False, False, False),
    "ae.skillList": _ann(True, False, True),
    "ae.skillCreate": _ann(False, False, False),
    "ae.skillEdit": _ann(False, False, True),
    "ae.skillDelete": _ann(False, True, False),
    # skillUse can execute stored arbitrary JSX (execute=true) — ae.exec by
    # proxy, so it carries the same worst-path destructive hint.
    "ae.skillUse": _ann(False, True, False),
    "ae.toolIndex": _ann(True, False, True),
    "ae.toolSearch": _ann(True, False, True),
    "ae.toolInspect": _ann(True, False, True),
    "ae.toolUse": _ann(False, True, False),
    "ae.toolCreate": _ann(False, False, False),
    "ae.toolEdit": _ann(False, False, True),
    "ae.toolDelete": _ann(False, True, False),
    "ae.toolArchive": _ann(False, False, True),
    "ae.toolDuplicate": _ann(False, False, False),
    "ae.toolPromoteFromHistory": _ann(False, False, True),
    "ae.toolImport": _ann(False, False, False),
    "ae.toolExport": _ann(False, True, True),
    "ae.status": _ann(True, False, True),
    "ae.diagnose": _ann(True, False, True),
    "ae.createLayer": _ann(False, False, False),
    "ae.setProperty": _ann(False, False, True),
    "ae.moveLayer": _ann(False, False, True),
    "ae.selectLayers": _ann(False, False, True),
    "ae.setTime": _ann(False, False, True),
    "ae.getTime": _ann(True, False, True),
    "ae.getProperties": _ann(True, False, True),
    "ae.scanPropertyTree": _ann(True, False, True),
    "ae.inspectPropertyCapabilities": _ann(True, False, True),
    "ae.getExpressions": _ann(True, False, True),
    "ae.validateExpressions": _ann(True, False, True),
    "ae.getKeyframes": _ann(True, False, True),
    "ae.searchProject": _ann(True, False, True),
}
