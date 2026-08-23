'use strict';

const execTool = require('./exec');
const { VERB_ANNOTATIONS } = require('../annotations');

const definition = {
    name: 'ae_execRecover',
    description: 'Retry one dispatched ae_exec failure using its exact server-issued recoveryId. Omit code to run the saved editable script, or provide corrected code. The default restores the recorded checkpoint; retryMode:"continue" keeps the current project state.',
    inputSchema: {
        type: 'object',
        properties: {
            recoveryId: {
                type: 'string',
                minLength: 6,
                maxLength: 6,
                description: 'Exact recoveryId returned by ae_exec. Never invent or guess it.',
            },
            code: {
                type: 'string',
                minLength: 1,
                description: 'Optional corrected ExtendScript; otherwise the saved script is used.',
            },
            retryMode: { type: 'string', enum: ['restore', 'continue'], default: 'restore' },
            undo_group_name: { type: 'string' },
            checkpoint_label: { type: 'string' },
            timeout_sec: { type: 'number', minimum: 1, maximum: 600 },
        },
        required: ['recoveryId'],
        additionalProperties: false,
    },
    outputSchema: execTool.definition.outputSchema,
    annotations: Object.assign({}, VERB_ANNOTATIONS.ae_execRecover, { openWorldHint: false }),
};

module.exports = { definition, call: execTool.recover };
