'use strict';

const { textResult } = require('../tool-result');

const definition = {
    name: 'ae_readJob',
    description: 'Submit bounded reads or native previews against an existing checkpoint, inspect progress, retrieve paginated snapshot results, or request cancellation. No arbitrary scripts or realtime claims.',
    inputSchema: {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['submit', 'status', 'result', 'cancel'] },
            checkpoint_id: { type: 'string', description: 'Checkpoint id returned by a successful ae_checkpoint call.' },
            job_id: { type: 'string', description: 'Job id returned by submit.' },
            requests: { type: 'array', minItems: 1, maxItems: 32, items: {
                type: 'object', properties: {
                    id: { type: 'string', minLength: 1, maxLength: 100 },
                    tool: { type: 'string', enum: ['ae_read', 'ae_previewFrame'] },
                    arguments: { type: 'object',
                        description: 'Use the matching ae_read or ae_previewFrame arguments. Select a comp explicitly; previews require explicit times. No out_dir or prior capture references.' },
                }, required: ['id', 'tool', 'arguments'], additionalProperties: false,
            } },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
        }, required: ['action'], additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

async function call(args, context, deps) {
    try {
        const allowed = { submit: ['action', 'checkpoint_id', 'requests'], status: ['action', 'job_id'],
            result: ['action', 'job_id', 'offset', 'limit'], cancel: ['action', 'job_id'] }[args.action];
        if (!allowed || Object.keys(args).some((key) => !allowed.includes(key))) throw new Error('invalid read job arguments');
        const jobs = deps.getReadJobs();
        if (args.action === 'submit') return { result: textResult(jobs.submit(args, context)) };
        if (typeof args.job_id !== 'string' || !args.job_id) throw new Error('job_id is required');
        const result = args.action === 'result' ? jobs.result(args.job_id, context, args)
            : jobs[args.action](args.job_id, context);
        const images = args.action === 'result' ? jobs.resultImages(args.job_id, context, args) : null;
        if (images) result.image_request_id = images.requestId;
        const response = textResult(result);
        if (images) response.content.push(...images.content);
        return { result: response };
    } catch (error) { return { result: textResult({ ok: false, error: error.message }, true) }; }
}

module.exports = { definition, call };
