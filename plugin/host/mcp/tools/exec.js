'use strict';

// ae_exec — run ExtendScript through the host JSX bridge (shares the /exec
// execution chain: pause / client block, undo group, transport envelope,
// native graph invalidation, activity log).

const { textResult } = require('../tool-result');
const { VERB_ANNOTATIONS } = require('../annotations');
const { enforce } = require('../approval-gate');
const { parseJsxResult } = require('../jsx-result');
const { autoCheckpoint, executionFailure, record } = require('../checkpoint-ops');

const definition = {
    name: 'ae_exec',
    description: 'Run ExtendScript in After Effects through the host JSX bridge.',
    inputSchema: {
        type: 'object',
        properties: {
            code: { type: 'string', minLength: 1 },
            undo_group_name: { type: 'string' },
            checkpoint_label: { type: 'string' },
            timeout_sec: { type: 'number', minimum: 1, maximum: 600 },
        },
        required: ['code'],
        additionalProperties: false,
    },
    annotations: Object.assign({}, VERB_ANNOTATIONS.ae_exec, { openWorldHint: false }),
};

async function call(args, context, deps) {
    if (typeof args.code !== 'string' || args.code.length === 0) {
        return { result: textResult({ ok: false, error: 'missing or empty `code`' }, true) };
    }
    if (args.undo_group_name !== undefined && typeof args.undo_group_name !== 'string') {
        return { result: textResult({ ok: false, error: '`undo_group_name` must be a string' }, true) };
    }
    if (args.checkpoint_label !== undefined && typeof args.checkpoint_label !== 'string') {
        return { result: textResult({ ok: false, error: '`checkpoint_label` must be a string' }, true) };
    }
    if (args.timeout_sec !== undefined
        && (!Number.isFinite(args.timeout_sec) || args.timeout_sec < 1 || args.timeout_sec > 600)) {
        return { result: textResult({ ok: false, error: '`timeout_sec` must be between 1 and 600' }, true) };
    }
    try {
        const denied = await enforce(
            'ae_exec',
            Object.assign({}, context, { arguments: args }),
            deps,
        );
        if (denied) return { result: textResult(denied, true) };
        const checkpointSkipped = await autoCheckpoint(args, context, deps);
        const execution = await deps.executeJsx({
            code: args.code,
            undoGroup: args.undo_group_name,
            // Auto-checkpoint belongs to the ae_exec MCP tool layer. The shared
            // /exec chain intentionally continues to accept but ignore this
            // field so direct HTTP /exec retains today's Python-era semantics.
            checkpointLabel: args.checkpoint_label,
            timeoutMs: (args.timeout_sec === undefined ? 30 : args.timeout_sec) * 1000,
            client: context.session.clientName,
            nativeProjectGraphEffect: 'invalidate',
        });
        if (!execution || !execution.payload || execution.payload.ok !== true) {
            const failure = executionFailure(execution);
            return { result: textResult(failure, true) };
        }
        const parsed = parseJsxResult(execution.payload.result);
        if (record(parsed) && checkpointSkipped
            && !Object.prototype.hasOwnProperty.call(parsed, 'checkpointSkipped')) {
            parsed.checkpointSkipped = checkpointSkipped;
        }
        return { result: textResult(parsed, record(parsed) && parsed.ok === false) };
    } catch (error) {
        const payload = { ok: false, error: error && error.message ? error.message : String(error) };
        if (error && typeof error.disposition === 'string') payload.disposition = error.disposition;
        return { result: textResult(payload, true) };
    }
}

module.exports = { definition, call };
