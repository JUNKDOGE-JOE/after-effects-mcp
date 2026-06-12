"""Opt-in approval gate driven by a tier file (panel-controlled).

Activated only when AE_MCP_APPROVAL_TIER_FILE is set: the embedding UI
(panel Codex adapter) writes one of readonly/manual/auto/none into that
file and flips it when the user changes the approval chip. Decisions
come from VERB_ANNOTATIONS (the same source as the Claude backend's
canUseTool tiers), so semantics match across backends.
"""
from __future__ import annotations

import os
from typing import Any, Literal

from ae_mcp.annotations import VERB_ANNOTATIONS

Tier = Literal["readonly", "manual", "auto", "none"]
Decision = Literal["allow", "deny-readonly", "elicit"]

_VALID_TIERS: set[str] = {"readonly", "manual", "auto", "none"}
_TIER_CACHE: dict[str, tuple[int | None, str]] = {}

_READONLY_DENIED = (
    "blocked by read-only approval tier "
    "(switch the panel approval chip to allow writes)"
)
_NO_PROMPT_API = (
    "approval required but this client cannot prompt; "
    "switch the approval tier or use the panel chat"
)
_ELICIT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "approve": {
            "type": "boolean",
            "title": "Approve",
            "description": "Approve this After Effects action.",
        }
    },
    "required": ["approve"],
}


def read_tier(path: str) -> str:
    """Read the approval tier file, defaulting to manual on unsafe input."""
    try:
        stat = os.stat(path)
    except OSError:
        _TIER_CACHE[path] = (None, "manual")
        return "manual"

    mtime_ns = stat.st_mtime_ns
    cached = _TIER_CACHE.get(path)
    if cached is not None and cached[0] == mtime_ns:
        return cached[1]

    try:
        with open(path, encoding="utf-8") as f:
            tier = f.readline().strip()
    except OSError:
        tier = "manual"

    if tier not in _VALID_TIERS:
        tier = "manual"

    _TIER_CACHE[path] = (mtime_ns, tier)
    return tier


def gate_decision(tier: str, verb_name: str) -> Decision:
    """Return the approval decision for a verb under the active tier."""
    annotations = VERB_ANNOTATIONS.get(verb_name)
    read_only = bool(getattr(annotations, "readOnlyHint", False))
    destructive = bool(getattr(annotations, "destructiveHint", False))

    if tier == "readonly":
        return "allow" if read_only else "deny-readonly"
    if tier == "manual":
        return "allow" if read_only else "elicit"
    if tier == "auto":
        return "elicit" if destructive else "allow"
    if tier == "none":
        return "allow"
    return gate_decision("manual", verb_name)


async def enforce(name: str, ctx: Any) -> dict[str, Any] | None:
    """Apply the configured approval tier before a tool executes."""
    path = os.environ.get("AE_MCP_APPROVAL_TIER_FILE")
    if not path:
        return None

    tier = read_tier(path)
    decision = gate_decision(tier, name)
    if decision == "allow":
        return None
    if decision == "deny-readonly":
        return {"ok": False, "error": _READONLY_DENIED}

    session = getattr(ctx, "session", None)
    elicit = getattr(session, "elicit_form", None) or getattr(session, "elicit", None)
    if elicit is None:
        return {"ok": False, "error": _NO_PROMPT_API}

    risk = _risk_label(name)
    message = f"Approve After Effects tool action {name} ({risk})?"
    related_request_id = getattr(ctx, "request_id", None)
    try:
        result = await elicit(
            message=message,
            requestedSchema=_ELICIT_SCHEMA,
            related_request_id=related_request_id,
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"approval required but elicitation failed: {e}"}

    if getattr(result, "action", None) == "accept":
        return None
    return {"ok": False, "error": "User denied this action."}


def _risk_label(name: str) -> str:
    annotations = VERB_ANNOTATIONS.get(name)
    if bool(getattr(annotations, "destructiveHint", False)):
        return "destructive"
    if bool(getattr(annotations, "readOnlyHint", False)):
        return "read-only"
    return "non-destructive write"
