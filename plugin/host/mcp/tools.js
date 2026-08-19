'use strict';

// /mcp tool registry. Every tool lives in its own module under ./tools/ and
// exports { definition, call(args, context, deps) }; this file only
// aggregates, validates the advertised schemas, and dispatches by name.
// Add a tool = add a file + one entry in TOOL_MODULES (keep list order: it is
// the tools/list order clients see).

const jsonrpc = require('./jsonrpc');
const { textResult, noTopLevelCombinator } = require('./tool-result');

const TOOL_MODULES = [
    require('./tools/status'),
    require('./tools/exec'),
];

function buildTools(deps) {
    const byName = new Map();
    const definitions = TOOL_MODULES.map(function (mod) {
        if (!mod || !mod.definition || typeof mod.definition.name !== 'string' || typeof mod.call !== 'function') {
            throw new Error('tool module must export { definition, call }');
        }
        if (!noTopLevelCombinator(mod.definition.inputSchema)) {
            throw new Error('tool schema has a top-level combinator: ' + mod.definition.name);
        }
        if (byName.has(mod.definition.name)) {
            throw new Error('duplicate tool name: ' + mod.definition.name);
        }
        byName.set(mod.definition.name, mod);
        return mod.definition;
    });

    async function call(params, context) {
        if (!jsonrpc.isObject(params) || typeof params.name !== 'string') {
            return { invalid: 'tools/call requires a tool name' };
        }
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!jsonrpc.isObject(args)) return { invalid: 'tools/call arguments must be an object' };
        const mod = byName.get(params.name);
        if (!mod) {
            return { result: textResult({ ok: false, error: 'unknown tool: ' + params.name }, true) };
        }
        return mod.call(args, context, deps);
    }

    return { list: function () { return definitions; }, call };
}

module.exports = { buildTools, noTopLevelCombinator, textResult, TOOL_MODULES };
