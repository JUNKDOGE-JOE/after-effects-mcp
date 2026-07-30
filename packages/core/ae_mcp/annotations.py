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
    "ae.exec": _ann(False, True, False),
    "ae.nativeExec": _ann(False, True, True),
    "ae.checkpoint": _ann(False, False, False),
    "ae.revert": _ann(False, True, False),
    "ae.snapshot": _ann(True, False, True),
    "ae.previewFrame": _ann(True, False, True),
    "ae.ping": _ann(True, False, True),
    "ae.status": _ann(True, False, True),
    "ae.diagnose": _ann(True, False, True),
    "ae.validateExpressions": _ann(True, False, True),
    "ae.skillList": _ann(True, False, True),
    # skillUse can execute stored JSX and carries ae.exec's worst-path hints.
    "ae.skillUse": _ann(False, True, False),
    "ae.toolIndex": _ann(True, False, True),
    "ae.toolSearch": _ann(True, False, True),
    "ae.toolInspect": _ann(True, False, True),
    "ae.toolUse": _ann(False, True, False),
}
