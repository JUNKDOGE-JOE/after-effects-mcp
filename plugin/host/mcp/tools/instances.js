'use strict';

const { textResult } = require('../tool-result');
const { enforce } = require('../approval-gate');
const definition = {
    name: 'ae_instances',
    description: 'Discover local AE instances, explicitly start a primary, or stop an owned primary. Closing a panel is never repaired by starting another AE.',
    inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
            action: { type: 'string', enum: ['list', 'start', 'stop'], default: 'list' },
            instance_id: { type: 'string' }, project_path: { type: 'string' },
            work_dir: { type: 'string', description: 'Absolute working directory of this user task, not the AE installation directory.' },
            save_policy: { type: 'string', enum: ['refuse-dirty', 'save', 'discard'], default: 'refuse-dirty' },
        },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

async function call(args, context, deps) {
    try {
        const action = args.action || 'list';
        if (!['list', 'start', 'stop'].includes(action)) throw new Error('Unknown instance action.');
        if (!deps.instances) throw new Error('Instance management is unavailable in this host.');
        if (action !== 'list') {
            const denied = await enforce('ae_instances', Object.assign({}, context, { arguments: args }), deps);
            if (denied) return { result: textResult(denied, true) };
        }
        const value = await deps.instances(action, args, context);
        if (value.forwarded) return { result: value.forwarded };
        return { result: textResult(value, value.ok === false) };
    } catch (error) {
        return { result: textResult({ ok: false, code: error.code || 'INSTANCE_ERROR', error: error.message }, true) };
    }
}

module.exports = { definition, call };
