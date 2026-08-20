'use strict';

const { VERB_ANNOTATIONS } = require('../annotations');
const { textResult } = require('../tool-result');
const { defaultLibrary } = require('../tool-library');

const definition = {
    name: 'ae_toolSearch',
    description: 'List, search, or inspect persisted Tool Library artifacts.',
    inputSchema: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Case-insensitive search text.' },
            name: { type: 'string', description: 'Exact artifact id to inspect.' },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 1000, default: 50 },
        },
        additionalProperties: false,
    },
    annotations: VERB_ANNOTATIONS.ae_toolSearch,
};

function library(deps) {
    return (deps && deps.toolLibrary) || defaultLibrary();
}

function invalid(message) {
    return { result: textResult({ ok: false, error: message }, true) };
}

async function call(args, context, deps) {
    void context;
    if (args.name !== undefined && typeof args.name !== 'string') {
        return invalid('`name` must be a string');
    }
    if (args.query !== undefined && typeof args.query !== 'string') {
        return invalid('`query` must be a string');
    }
    if (args.name !== undefined && args.query !== undefined) {
        return invalid('`name` and `query` cannot be used together');
    }
    const offset = args.offset === undefined ? 0 : args.offset;
    const limit = args.limit === undefined ? 50 : args.limit;
    if (!Number.isInteger(offset) || offset < 0) return invalid('`offset` must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        return invalid('`limit` must be between 1 and 1000');
    }
    try {
        const store = library(deps);
        if (args.name !== undefined) {
            return { result: textResult({ ok: true, artifact: store.resolveArtifact(args.name) }) };
        }
        if (args.query !== undefined) {
            const found = store.searchAll(args.query, { offset, limit, statuses: ['saved', 'pinned'] });
            return { result: textResult(Object.assign({ ok: true }, found)) };
        }
        return {
            result: textResult({
                ok: true,
                artifacts: store.allSummaries().filter(function (artifact) {
                    return artifact.status === 'saved' || artifact.status === 'pinned';
                }),
            }),
        };
    } catch (error) {
        return invalid(error && error.message ? error.message : String(error));
    }
}

module.exports = { definition, call };
