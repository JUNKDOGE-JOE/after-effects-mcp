'use strict';

const jsonrpc = require('./jsonrpc');

function textResult(value, isError) {
    const result = {
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
    };
    if (isError) result.isError = true;
    return result;
}

function noTopLevelCombinator(schema) {
    return !['oneOf', 'allOf', 'anyOf'].some(function (key) {
        return Object.prototype.hasOwnProperty.call(schema, key);
    });
}

function buildTools(deps) {
    const tools = [{
        name: 'ae_status',
        description: 'Read same-process ae-mcp host status without a network round trip.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, {
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
    }];
    tools.forEach(function (tool) {
        if (!noTopLevelCombinator(tool.inputSchema)) {
            throw new Error('tool schema has a top-level combinator: ' + tool.name);
        }
    });

    async function call(params, context) {
        if (!jsonrpc.isObject(params) || typeof params.name !== 'string') {
            return { invalid: 'tools/call requires a tool name' };
        }
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!jsonrpc.isObject(args)) return { invalid: 'tools/call arguments must be an object' };
        if (params.name === 'ae_status') {
            if (Object.keys(args).length !== 0) {
                return { result: textResult({ ok: false, error: 'ae_status accepts no arguments' }, true) };
            }
            const status = deps.getStatus(context.port);
            status.mcp = { sessions: deps.sessionCount(), protocolVersion: context.session.protocolVersion };
            return { result: textResult(status, false) };
        }
        if (params.name !== 'ae_exec') {
            return { result: textResult({ ok: false, error: 'unknown tool: ' + params.name }, true) };
        }
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

    return { list: function () { return tools; }, call };
}

module.exports = { buildTools, noTopLevelCombinator, textResult };
