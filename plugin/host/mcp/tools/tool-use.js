'use strict';

const { VERB_ANNOTATIONS } = require('../annotations');
const { enforce } = require('../approval-gate');
const { executionFailure } = require('../checkpoint-ops');
const { parseJsxResult } = require('../jsx-result');
const { textResult } = require('../tool-result');
const { defaultLibrary } = require('../tool-library');

const definition = {
    name: 'ae_toolUse',
    description: 'Replay a Tool Library artifact by id. Prefer it over rewriting a script for a repeated task.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', minLength: 1, description: 'Artifact id from ae_toolSearch.' },
            args: { type: 'object', default: {}, description: 'Tool arguments.' },
        },
        required: ['name'],
        additionalProperties: false,
    },
    annotations: VERB_ANNOTATIONS.ae_toolUse,
};

function library(deps) {
    if (deps && typeof deps.getToolLibrary === 'function') return deps.getToolLibrary();
    return (deps && deps.toolLibrary) || defaultLibrary();
}

function invalid(message) {
    return { result: textResult({ ok: false, error: message }, true) };
}

function touchUsage(store, artifact) {
    if (!artifact || artifact.source.type === 'bundled' || artifact.source.type === 'legacy') return;
    try { store.touchUsage(artifact.id); } catch (error) { void error; }
}

function recordUsage(context, deps, artifactId) {
    if (!deps || typeof deps.recordMcpActivity !== 'function') return;
    const session = context && context.session ? context.session : {};
    deps.recordMcpActivity({
        tool: 'ae_toolUse',
        artifactId,
        operation: 'use',
        ok: true,
        transport: 'mcp',
        client: typeof session.clientName === 'string' ? session.clientName : null,
    });
}

async function call(args, context, deps) {
    if (typeof args.name !== 'string' || !args.name) return invalid('`name` must be a non-empty string');
    if (args.args !== undefined && (args.args === null || typeof args.args !== 'object'
        || Array.isArray(args.args))) {
        return invalid('`args` must be an object');
    }
    if (!deps || typeof deps.executeJsx !== 'function') return invalid('JSX execution is unavailable');
    try {
        const store = library(deps);
        const plan = store.plan(args.name, args.args || {});
        const denied = await enforce('ae_toolUse', Object.assign({}, context, {
            arguments: { name: args.name, args: plan.normalizedArgs, plan_hash: plan.planHash },
        }), deps);
        if (denied) return { result: textResult(denied, true) };

        // Approval consumption re-reads the artifact. This is independent of
        // renderPlan's second current-content check immediately before dispatch.
        store.consumePlan(plan);
        const code = store.renderPlan(plan);
        const artifact = store.getArtifact(plan.artifactId);
        const execution = await deps.executeJsx({
            code,
            undoGroup: 'Tool Library: ' + artifact.name,
            timeoutMs: 60000,
            client: context.session.clientName,
            nativeProjectGraphEffect: 'invalidate',
        });
        if (!execution || !execution.payload || execution.payload.ok !== true) {
            return { result: textResult(executionFailure(execution), true) };
        }
        const parsed = parseJsxResult(execution.payload.result);
        if (parsed && parsed.ok === false) return { result: textResult(parsed, true) };
        touchUsage(store, artifact);
        recordUsage(context, deps, plan.artifactId);
        return { result: textResult(parsed, parsed && parsed.ok === false) };
    } catch (error) {
        return invalid(error && error.message ? error.message : String(error));
    }
}

module.exports = { definition, call };
