'use strict';

/* Approval gates for the two tool surfaces.

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
*/

// Tool Library 门尚未移植到宿主。

const fs = require('fs');
const { VERB_ANNOTATIONS } = require('./annotations');

const VALID_TIERS = ['readonly', 'manual', 'auto', 'none'];
const TIER_CACHE = new Map();
const READONLY_DENIED = 'blocked by read-only approval tier '
    + '(switch the panel approval chip to allow writes)';
const NO_PROMPT_API = 'approval required but this client cannot prompt; '
    + 'switch the approval tier or use the panel chat';

function readTier(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (error) {
        TIER_CACHE.set(filePath, { mtimeMs: null, tier: 'manual' });
        return 'manual';
    }
    const cached = TIER_CACHE.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.tier;
    let tier = 'manual';
    try {
        tier = String(fs.readFileSync(filePath, 'utf8')).split(/\r?\n/, 1)[0].trim();
    } catch (error) {
        tier = 'manual';
    }
    if (VALID_TIERS.indexOf(tier) === -1) tier = 'manual';
    TIER_CACHE.set(filePath, { mtimeMs: stat.mtimeMs, tier });
    return tier;
}

function gateDecision(tier, toolName) {
    const annotations = VERB_ANNOTATIONS[toolName] || {};
    const readOnly = Boolean(annotations.readOnlyHint);
    const destructive = Boolean(annotations.destructiveHint);
    if (tier === 'readonly') return readOnly ? 'allow' : 'deny-readonly';
    if (tier === 'manual') return readOnly ? 'allow' : 'elicit';
    if (tier === 'auto') return destructive ? 'elicit' : 'allow';
    if (tier === 'none') return 'allow';
    return gateDecision('manual', toolName);
}

function riskLabel(toolName) {
    const annotations = VERB_ANNOTATIONS[toolName] || {};
    if (annotations.destructiveHint) return 'destructive';
    if (annotations.readOnlyHint) return 'read-only';
    return 'non-destructive write';
}

function approvalSummary(args) {
    const input = args || {};
    return {
        code: typeof input.code === 'string' ? input.code.slice(0, 200) : '',
        undo_group_name: input.undo_group_name === undefined ? null : input.undo_group_name,
        checkpoint_label: input.checkpoint_label === undefined ? null : input.checkpoint_label,
    };
}

async function enforce(toolName, context, deps) {
    const policy = context && context.policy;
    const tier = policy ? policy.approvalTier : null;
    if (tier === null || tier === undefined) return null;
    const decision = gateDecision(tier, toolName);
    if (decision === 'allow') return null;
    if (decision === 'deny-readonly') return { ok: false, error: READONLY_DENIED };
    const queue = deps && deps.approvals;
    if (!queue || typeof queue.request !== 'function') {
        return { ok: false, error: NO_PROMPT_API };
    }
    try {
        const selected = await queue.request({
            conversationId: context.session.conversationId,
            sessionId: context.session.id,
            tool: toolName,
            risk: riskLabel(toolName),
            summary: approvalSummary(context.arguments),
        });
        if (selected === 'accept') return null;
        return { ok: false, error: 'User denied this action.' };
    } catch (error) {
        return {
            ok: false,
            error: 'approval required but elicitation failed: '
                + (error && error.message ? error.message : String(error)),
        };
    }
}

module.exports = {
    READONLY_DENIED,
    NO_PROMPT_API,
    readTier,
    gateDecision,
    riskLabel,
    enforce,
};
