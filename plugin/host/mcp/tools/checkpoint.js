'use strict';

const { textResult } = require('../tool-result');
const { VERB_ANNOTATIONS } = require('../annotations');
const { enforce } = require('../approval-gate');
const { createCheckpoint, resolveProjectPath } = require('../checkpoint-ops');

const definition = {
    name: 'ae_checkpoint',
    description: 'Create or list .aep checkpoints for the current saved project.',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['create', 'list'],
                default: 'list',
                description: "'create' = save .aep snapshot; 'list' = enumerate existing.",
            },
            label: {
                type: 'string',
                default: '',
                description: "Human-readable tag (used when action='create').",
            },
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 200,
                default: 20,
                description: "Max entries returned when action='list'.",
            },
        },
        additionalProperties: false,
    },
    annotations: VERB_ANNOTATIONS.ae_checkpoint,
};

function invalid(message) {
    return { result: textResult({ ok: false, error: message }, true) };
}

async function call(args, context, deps) {
    const action = args.action === undefined ? 'list' : args.action;
    const label = args.label === undefined ? '' : args.label;
    const limit = args.limit === undefined ? 20 : args.limit;
    if (action !== 'create' && action !== 'list') return invalid('`action` must be `create` or `list`');
    if (typeof label !== 'string') return invalid('`label` must be a string');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        return invalid('`limit` must be between 1 and 200');
    const denied = await enforce('ae_checkpoint', Object.assign({}, context, { arguments: args }), deps);
    if (denied) return { result: textResult(denied, true) };
    try {
        if (action === 'list') {
            const projectPath = await resolveProjectPath(context, deps);
            const checkpoints = projectPath ? deps.getCheckpointStore().list(projectPath, { limit }) : [];
            return { result: textResult({ ok: true, checkpoints, total: checkpoints.length }) };
        }
        const checkpoint = await createCheckpoint(
            { label, undoGroup: 'MCP checkpoint: ' + label },
            context,
            deps,
        );
        return { result: textResult(checkpoint, !checkpoint.ok) };
    } catch (error) {
        return invalid(error && error.message ? error.message : String(error));
    }
}

module.exports = { definition, call };
