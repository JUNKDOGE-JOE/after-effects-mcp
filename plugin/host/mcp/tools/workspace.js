'use strict';

const { textResult } = require('../tool-result');
const { enforce } = require('../approval-gate');
const definition = {
    name: 'ae_workspace',
    description: 'Bind a task to an AE project. Write access is a capability; ownership lasts for an active panel turn or external AE call. Idle ownership is handed over automatically. Pass context_id on AE calls. Releasing a context does not close AE.',
    inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
            action: { type: 'string', enum: ['bind', 'inspect', 'release', 'transfer', 'reconcile'], default: 'bind' },
            instance_id: { type: 'string' }, project_path: { type: 'string' },
            context_id: { type: 'string' }, target_context_id: { type: 'string' },
            observation_id: { type: 'string', description: 'Server-issued observation from ae_read or ae_previewFrame after an uncertain write.' },
            confirm: { type: 'boolean', description: 'Confirm a verified reconciliation observation. Idle ownership transfer needs no confirmation.' },
            access: { type: 'string', enum: ['read', 'write'], default: 'read' },
            work_dir: { type: 'string', description: 'Absolute task working directory used for checkpoint fallback.' },
        },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

async function call(args, context, deps) {
    try {
        if (!deps.workspace) throw new Error('Workspace binding is unavailable in this host.');
        if (args.access === 'write' || ['transfer', 'reconcile'].includes(args.action)) {
            const approvalContext = Object.assign({}, context, { arguments: args });
            const denied = await enforce('ae_workspace', approvalContext, deps);
            if (denied) return { result: textResult(denied, true) };
        }
        const value = await deps.workspace(args.action || 'bind', args, context);
        if (value.forwarded) return { result: value.forwarded };
        return { result: textResult(value, value.ok === false) };
    } catch (error) {
        return { result: textResult({ ok: false, code: error.code || 'WORKSPACE_ERROR', error: error.message }, true) };
    }
}

module.exports = { definition, call };
