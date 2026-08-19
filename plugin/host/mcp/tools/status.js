'use strict';

// ae_status — read same-process host status. One tool per module: each file
// exports { definition, call(args, context, deps) } and tools.js aggregates
// them, so parallel tool work lands in separate files instead of one registry.

const { textResult } = require('../tool-result');

const definition = {
    name: 'ae_status',
    description: 'Read same-process ae-mcp host status without a network round trip.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

async function call(args, context, deps) {
    if (Object.keys(args).length !== 0) {
        return { result: textResult({ ok: false, error: 'ae_status accepts no arguments' }, true) };
    }
    const status = deps.getStatus(context.port);
    status.mcp = { sessions: deps.sessionCount(), protocolVersion: context.session.protocolVersion };
    return { result: textResult(status, false) };
}

module.exports = { definition, call };
