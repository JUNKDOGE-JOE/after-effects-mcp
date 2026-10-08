'use strict';

// /mcp tool registry. Every tool lives in its own module under ./tools/ and
// exports { definition, call(args, context, deps) }; this file only
// aggregates, validates the advertised schemas, and dispatches by name.
// Add a tool = add a file + one entry in TOOL_MODULES (keep list order: it is
// the tools/list order clients see).

const jsonrpc = require('./jsonrpc');
const { textResult, noTopLevelCombinator } = require('./tool-result');
const { HINT_MARK, matchHint } = require('./error-hints');
const { createProjectRestoreGuard } = require('./workspaces');

function assertPatternDescriptions(schema, toolName, path) {
    if (schema === null || typeof schema !== 'object') return;
    const location = path || '$';
    const properties = schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return;
    Object.keys(properties).forEach(function (name) {
        const property = properties[name];
        if (property && typeof property === 'object'
            && Object.prototype.hasOwnProperty.call(property, 'pattern')
            && (typeof property.description !== 'string' || property.description.trim() === '')) {
            throw new Error('MCP tool inputSchema pattern requires a description: '
                + toolName + ' at ' + location + '.properties.' + name);
        }
    });
}

const TOOL_MODULES = [
    require('./tools/status'),
    require('./tools/exec'),
    require('./tools/exec-recover'),
    require('./tools/preview-frame'),
    require('./tools/read'),
    require('./tools/checkpoint'),
    require('./tools/revert'),
    require('./tools/validate-expressions'),
    require('./tools/native-exec'),
    require('./tools/tool-search'),
    require('./tools/tool-use'),
    require('./tools/tool-save'),
    require('./tools/skill-use'),
    require('./tools/instances'),
    require('./tools/workspace'),
    require('./tools/read-job'),
];

function publicDefinition(mod) {
    const common = { context_id: { type: 'string', description: 'Project binding from ae_workspace.' } };
    if (['ae_exec', 'ae_execRecover'].includes(mod.definition.name)) common.checkpoint_continue = {
        type: 'object', additionalProperties: false, required: ['failure_id', 'confirm'],
        properties: {
            failure_id: { type: 'string', description: 'Exact checkpoint_failure_id returned for this operation.' },
            confirm: { type: 'boolean', description: 'Set true only after the user explicitly permits this operation without its failed checkpoint.' },
        },
    };
    return Object.assign({}, mod.definition, {
        inputSchema: Object.assign({}, mod.definition.inputSchema, {
            properties: Object.assign({}, mod.definition.inputSchema.properties, common),
        }),
    });
}

function buildTools(deps) {
    const byName = new Map();
    const definitions = TOOL_MODULES.map(function (mod) {
        if (!mod || !mod.definition || typeof mod.definition.name !== 'string' || typeof mod.call !== 'function') {
            throw new Error('tool module must export { definition, call }');
        }
        if (!noTopLevelCombinator(mod.definition.inputSchema)) {
            throw new Error('tool schema has a top-level combinator: ' + mod.definition.name);
        }
        assertPatternDescriptions(mod.definition.inputSchema, mod.definition.name, 'inputSchema');
        if (byName.has(mod.definition.name)) {
            throw new Error('duplicate tool name: ' + mod.definition.name);
        }
        byName.set(mod.definition.name, mod);
        return publicDefinition(mod);
    });

    async function call(params, context) {
        if (!jsonrpc.isObject(params) || typeof params.name !== 'string') {
            return { invalid: 'tools/call requires a tool name' };
        }
        const rawArgs = params.arguments === undefined ? {} : params.arguments;
        if (!jsonrpc.isObject(rawArgs)) return { invalid: 'tools/call arguments must be an object' };
        const args = Object.assign({}, rawArgs);
        delete args.checkpoint_continue;
        if (params.name !== 'ae_workspace') delete args.context_id;
        if (!jsonrpc.isObject(args)) return { invalid: 'tools/call arguments must be an object' };
        const mod = byName.get(params.name);
        if (!mod) {
            return { result: textResult({ ok: false, error: 'unknown tool: ' + params.name }, true) };
        }
        const activityRef = {};
        const callContext = Object.assign({}, context, { tool: params.name, transport: 'mcp' });
        let executionContext = callContext;
        const restoreGuard = createProjectRestoreGuard();
        const callDeps = Object.assign({}, deps, {
            executeJsx: typeof deps.executeJsx === 'function'
                ? async function (request) {
                    const input = Object.assign({}, request, {
                        tool: params.name,
                        transport: 'mcp',
                        activityRef,
                    });
                    if (typeof input.code === 'string') activityRef.code = input.code;
                    const phase = input.projectRestorePhase;
                    if (phase && !['ae_revert', 'ae_execRecover'].includes(params.name)) {
                        throw new Error('Only checkpoint recovery may continue a project restore');
                    }
                    delete input.projectRestorePhase;
                    input.code = restoreGuard.wrap(input.code, phase, executionContext);
                    const execution = await deps.executeJsx(input);
                    await restoreGuard.accept(execution, phase, executionContext);
                    return execution;
                }
                : deps.executeJsx,
        });
        let output;
        try {
            const invoke = (boundContext) => {
                executionContext = boundContext || callContext;
                return mod.call(args, executionContext, callDeps);
            };
            output = typeof deps.routeTool === 'function'
                ? await deps.routeTool(params, callContext, invoke)
                : await invoke(callContext);
        } catch (error) {
            output = { result: textResult({ ok: false, error: error && error.message ? error.message : String(error),
                ...(error && error.code ? { code: error.code } : {}),
                ...(error && error.disposition ? { disposition: error.disposition } : {}) }, true) };
        }
        if (!output || output.result === undefined) {
            output = { result: textResult({ ok: false, error: 'tool returned no result' }, true) };
        }
        const structured = output && output.result && output.result.structuredContent;
        const errorText = structured && typeof structured.error === 'string' ? structured.error : '';
        if (activityRef.id && errorText.indexOf(HINT_MARK) !== -1
            && typeof deps.updateActivity === 'function') {
            const match = matchHint(errorText);
            if (match) {
                deps.updateActivity(activityRef.id, {
                    ok: false,
                    error: errorText,
                    hinted: true,
                    hintIndex: match.index,
                    ...(typeof activityRef.code === 'string'
                        ? {
                            scriptChars: activityRef.code.length,
                            scriptHead: activityRef.code.replace(/\s+/g, ' ').trim().slice(0, 200),
                        } : {}),
                });
            }
        }
        if (!activityRef.id && typeof deps.recordMcpActivity === 'function') {
            deps.recordMcpActivity({
                client: callContext.session && callContext.session.clientName,
                tool: params.name,
                transport: 'mcp',
                engine: 'mcp',
                ok: !(structured && structured.ok === false),
                ...(structured && structured.error ? { error: structured.error } : {}),
            });
        }
        return output;
    }

    return { list: function () { return definitions; }, call };
}

module.exports = {
    buildTools,
    noTopLevelCombinator,
    textResult,
    TOOL_MODULES,
    publicDefinition,
    assertPatternDescriptions,
};
