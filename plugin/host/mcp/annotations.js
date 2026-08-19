'use strict';

// Single source of truth for the target Phase 1 MCP tool annotations. External
// agent frameworks branch on these hints, and approval-gate.js uses the same
// values so panel and client policy classifications cannot drift.

function ann(readOnlyHint, destructiveHint, idempotentHint) {
    return Object.freeze({ readOnlyHint, destructiveHint, idempotentHint });
}

const VERB_ANNOTATIONS = Object.freeze({
    ae_exec: ann(false, true, false),
    ae_status: ann(true, false, true),
    ae_previewFrame: ann(true, false, true),
    ae_read: ann(true, false, true),
    ae_checkpoint: ann(false, false, false),
    ae_revert: ann(false, true, false),
    ae_validateExpressions: ann(true, false, true),
    ae_nativeExec: ann(false, true, true),
    ae_toolUse: ann(false, true, false),
    ae_toolSearch: ann(true, false, true),
    ae_skillUse: ann(false, true, false),
});

module.exports = { VERB_ANNOTATIONS };
