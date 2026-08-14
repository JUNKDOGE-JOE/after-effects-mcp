"""Approval gates for the two tool surfaces.

There are two, with **opposite defaults**, and the difference is deliberate. It
has been read from the source as a fail-open bug (#243), so it is written down
here rather than left to be rediscovered.

**Verb surface** -- ae_exec, ae_previewFrame, and the rest. Gated by
`enforce()`, active only when AE_MCP_APPROVAL_TIER_FILE is set: the embedding
UI writes one of readonly/manual/auto/none into that file and flips it when the
user changes the approval chip. With the variable unset the gate is a no-op,
because the caller is then some other MCP client whose own permission system is
the gate. The panel deliberately does not set the variable for its Codex
adapter for exactly that reason -- asserted in
plugin/panel/test/codexBackend.test.js. Defaulting this to `manual` instead is
not a safe one-line change: a client with no elicitation capability would hit
_NO_PROMPT_API on every write and be unable to do anything at all.

**Tool Library and skill surface** -- ae_toolUse, ae_skillUse. These execute
stored programs rather than a verb the caller just wrote, so they are excluded
from `enforce()` at the dispatch site and gated by `plan_decision()` /
`authorize_plan()` instead, which fall back to `manual` when
AE_MCP_TOOL_APPROVAL_TIER_FILE is absent. **The higher-risk surface is the
fail-closed one.**

A missing or unreadable tier *file* falls back to `manual` on both surfaces
(see `read_tier`). Only the absence of the environment variable separates them,
and it means different things in the two places: "no UI is driving this gate,
and the client has its own", versus "no UI is driving this gate, so assume
nothing".

Neither gate is the authentication boundary. /exec requires a shared secret
(plugin/host/auth-token.js) and the panel has a kill switch and per-client
block list in front of both.

Decisions come from VERB_ANNOTATIONS (the same source as the Claude backend's
canUseTool tiers), so semantics match across backends.
"""
from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, Literal, Mapping

from ae_mcp.annotations import VERB_ANNOTATIONS

if TYPE_CHECKING:
    from ae_mcp.tool_execution import ExecutionPlan

Tier = Literal["readonly", "manual", "auto", "none"]
Decision = Literal["allow", "deny-readonly", "elicit"]
PlanDecision = Literal["allow", "deny", "elicit"]
PlanAuthorization = Literal["once", "session"]

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


class PlanAuthorizationDenied(PermissionError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code

    def public_dict(self) -> dict[str, object]:
        return {"ok": False, "error": self.code, "message": str(self)}


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


def current_tool_tier() -> Tier:
    """Tier for the Tool Library surface, which runs stored programs.

    Unset means `manual`, the opposite of `enforce()`. That asymmetry is the
    point: this surface executes code the caller did not write in this turn, so
    an absent configuration is a reason to ask, not a reason to proceed.
    """
    path = os.environ.get("AE_MCP_TOOL_APPROVAL_TIER_FILE")
    if not path:
        return "manual"
    return read_tier(path)  # type: ignore[return-value]


def plan_decision(tier: str, risk: str) -> PlanDecision:
    if tier not in _VALID_TIERS:
        tier = "manual"
    if risk not in {"read", "write", "destructive", "external"}:
        return "deny"
    if tier == "readonly":
        return "allow" if risk == "read" else "deny"
    if tier == "manual":
        return "allow" if risk == "read" else "elicit"
    if risk in {"destructive", "external"}:
        return "elicit"
    return "allow"


def build_plan_elicitation_schema(
    plan: "ExecutionPlan", *, requested_scope: PlanAuthorization | None = None
) -> dict[str, object]:
    decisions = ["once", "deny"]
    if plan.risk == "write" and requested_scope != "once":
        decisions.insert(1, "session")
    return {
        "type": "object",
        "properties": {
            "decision": {
                "type": "string",
                "enum": decisions,
                "title": "Approval",
            }
        },
        "required": ["decision"],
        "additionalProperties": False,
        "x-ae-mcp-plan": plan.public_dict(),
    }


async def authorize_plan(
    plan: "ExecutionPlan",
    ctx: Any,
    *,
    requested_scope: PlanAuthorization | None = None,
) -> PlanAuthorization:
    decision = plan_decision(current_tool_tier(), plan.risk)
    if decision == "allow":
        return "once"
    if decision == "deny":
        raise PlanAuthorizationDenied(
            "tool_plan_readonly",
            "The current approval tier does not permit this tool plan.",
        )

    session = getattr(ctx, "session", None)
    elicit = getattr(session, "elicit_form", None) or getattr(session, "elicit", None)
    if elicit is None:
        raise PlanAuthorizationDenied(
            "tool_plan_elicitation_unavailable",
            "This tool plan requires approval, but the client cannot prompt.",
        )
    try:
        result = await elicit(
            message=f"Approve Tool Library action for {plan.artifact_id} ({plan.risk})?",
            requestedSchema=build_plan_elicitation_schema(
                plan, requested_scope=requested_scope
            ),
            related_request_id=getattr(ctx, "request_id", None),
        )
    except Exception as exc:
        raise PlanAuthorizationDenied(
            "tool_plan_elicitation_failed",
            "Tool plan approval could not be completed.",
        ) from exc
    if getattr(result, "action", None) != "accept":
        raise PlanAuthorizationDenied(
            "tool_plan_denied", "The user denied this tool plan."
        )
    content = getattr(result, "content", None)
    selected = content.get("decision") if isinstance(content, Mapping) else None
    if selected == "once":
        return "once"
    if selected == "session" and plan.risk == "write":
        return "session"
    if selected == "deny":
        raise PlanAuthorizationDenied(
            "tool_plan_denied", "The user denied this tool plan."
        )
    raise PlanAuthorizationDenied(
        "tool_plan_invalid_approval",
        "The client returned an invalid tool plan approval.",
    )


async def enforce(name: str, ctx: Any) -> dict[str, Any] | None:
    """Apply the configured approval tier before a verb executes.

    Returns None to allow. See the module docstring for why an unset variable
    allows here while `current_tool_tier` denies: this gate exists so the panel
    UI can drive it, and its absence means another client owns the prompt.
    """
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
