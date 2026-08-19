'use strict';

// ae_exec — run ExtendScript through the host JSX bridge (shares the /exec
// execution chain: pause / client block, undo group, transport envelope,
// native graph invalidation, activity log).

const { textResult } = require('../tool-result');

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
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
};

async function call(args, context, deps) {
    if (typeof args.code !== 'string' || args.code.length === 0) {
        return { result: textResult({ ok: false, error: 'missing or empty `code`' }, true) };
    }
    if (args.undo_group_name !== undefined && typeof args.undo_group_name !== 'string') {
        return { result: textResult({ ok: false, error: '`undo_group_name` must be a string' }, true) };
    }
    if (args.timeout_sec !== undefined
        && (!Number.isFinite(args.timeout_sec) || args.timeout_sec < 1 || args.timeout_sec > 600)) {
        return { result: textResult({ ok: false, error: '`timeout_sec` must be between 1 and 600' }, true) };
    }
    try {
        const execution = await deps.executeJsx({
            code: args.code,
            undoGroup: args.undo_group_name,
            checkpointLabel: args.checkpoint_label,
            timeoutMs: (args.timeout_sec === undefined ? 30 : args.timeout_sec) * 1000,
            client: context.session.clientName,
            nativeProjectGraphEffect: 'invalidate',
        });
        const payload = execution.payload;
        if (execution.disposition) payload.disposition = execution.disposition;
        return { result: textResult(payload, !payload.ok) };
    } catch (error) {
        const payload = { ok: false, error: error && error.message ? error.message : String(error) };
        if (error && typeof error.disposition === 'string') payload.disposition = error.disposition;
        return { result: textResult(payload, true) };
    }
}

module.exports = { definition, call };
