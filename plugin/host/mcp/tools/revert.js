'use strict';

const fs = require('fs');
const path = require('path');
const { textResult } = require('../tool-result');
const { VERB_ANNOTATIONS } = require('../annotations');
const { enforce } = require('../approval-gate');
const { parseJsxResult } = require('../jsx-result');
const { renderTemplate } = require('../template');
const {
    atomicReplace,
    createCheckpoint,
    requireSuccessfulExecution,
    resolveProjectPath,
} = require('../checkpoint-ops');

const CLOSE_TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, '../../../jsx/templates/revert_close.jsx'),
    'utf8',
);
const OPEN_TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, '../../../jsx/templates/revert_open.jsx'),
    'utf8',
);

const definition = {
    name: 'ae_revert',
    description: 'Revert to a previously saved checkpoint by id.',
    inputSchema: {
        type: 'object',
        properties: {
            checkpoint_id: { type: 'string', minLength: 1, description: 'Checkpoint id to revert to.' },
            branch_before_revert: {
                type: 'boolean',
                default: false,
                description: 'If true, branch current state before reverting.',
            },
        },
        required: ['checkpoint_id'],
        additionalProperties: false,
    },
    annotations: VERB_ANNOTATIONS.ae_revert,
};

async function runTemplate(template, variables, context, deps) {
    const execution = await deps.executeJsx({
        code: renderTemplate(template, variables || {}),
        timeoutMs: 60000,
        client: context.session.clientName,
        nativeProjectGraphEffect: 'preserve',
    });
    return parseJsxResult(requireSuccessfulExecution(execution));
}

async function branch(projectPath, checkpointId, context, deps) {
    try {
        const result = await createCheckpoint(
            { label: 'before-revert-' + checkpointId.slice(0, 8), projectPath },
            context,
            deps,
        );
        return result.ok ? result.id : null;
    } catch (error) {
        return null;
    }
}

function checkpointMeta(store, projectPath, checkpointId) {
    if (typeof store.readMeta === 'function') return store.readMeta(projectPath, checkpointId);
    if (typeof store.list !== 'function') return null;
    const entries = store.list(projectPath, { limit: 10000 });
    return entries.find(function (entry) { return entry.id === checkpointId; }) || null;
}

async function restoreViewer(meta, context, deps) {
    if (!meta || meta.activeCompId === null || meta.activeCompId === undefined) return null;
    const code = '(function(){try{var item=app.project.itemByID('
        + JSON.stringify(Number(meta.activeCompId))
        + ');if(typeof CompItem!=="undefined"&&item instanceof CompItem){item.openInViewer();item.time='
        + JSON.stringify(Number(meta.currentTime) || 0)
        + ';return JSON.stringify({ok:true,viewerRestored:true});}}catch(ignore){}'
        + 'return JSON.stringify({ok:true,viewerRestored:false});})()';
    try {
        const execution = await deps.executeJsx({
            code,
            timeoutMs: 10000,
            client: context.session.clientName,
            nativeProjectGraphEffect: 'preserve',
        });
        const parsed = parseJsxResult(requireSuccessfulExecution(execution));
        return Boolean(parsed && parsed.ok === true && parsed.viewerRestored === true);
    } catch (error) {
        return false;
    }
}

async function revertToCheckpoint(checkpointId, options, context, deps) {
    const input = options || {};
    try {
        const projectPath = input.projectPath === undefined
            ? await resolveProjectPath(context, deps) : input.projectPath;
        if (!projectPath)
            return {
                ok: false,
                reverted: false,
                error: 'cannot revert an unsaved/untitled project; save it first so there is a path to restore',
            };
        const store = deps.getCheckpointStore();
        const checkpoint = store.lookupAep(projectPath, checkpointId);
        if (!checkpoint)
            return {
                ok: false,
                reverted: false,
                error: 'checkpoint not found: ' + checkpointId,
            };
        if (!fs.existsSync(checkpoint))
            return {
                ok: false,
                reverted: false,
                error: 'checkpoint .aep missing: ' + checkpoint,
            };
        const meta = checkpointMeta(store, projectPath, checkpointId);
        const branchedFromId = input.branchBeforeRevert
            ? await branch(projectPath, checkpointId, context, deps)
            : null;
        const close = await runTemplate(CLOSE_TEMPLATE, {}, context, deps);
        if (!close || close.ok !== true)
            return {
                ok: false,
                reverted: false,
                stage: 'close',
                error:
                    'revert aborted: close failed: ' +
                    ((close && close.error) || JSON.stringify(close)),
                branchedFromId,
            };
        const openVariables = { aep_path: JSON.stringify(String(projectPath).replace(/\\/g, '/')) };
        try {
            (deps.atomicReplace || atomicReplace)(checkpoint, projectPath);
        } catch (error) {
            let recoveredOriginal = false;
            try {
                const reopened = await runTemplate(OPEN_TEMPLATE, openVariables, context, deps);
                recoveredOriginal = Boolean(reopened && reopened.ok);
            } catch (openError) {
                /* reporting below */
            }
            return {
                ok: false,
                reverted: false,
                stage: 'replace',
                error:
                    'revert failed during restore: ' +
                    (error && error.message ? error.message : String(error)),
                recoveredOriginal,
                branchedFromId,
            };
        }
        const opened = await runTemplate(OPEN_TEMPLATE, openVariables, context, deps);
        if (!opened || opened.ok !== true)
            return {
                ok: false,
                reverted: true,
                stage: 'reopen',
                error:
                    'checkpoint restored but reopen failed: ' +
                    ((opened && opened.error) || JSON.stringify(opened)),
                branchedFromId,
            };
        const result = {
            ok: true,
            reverted: true,
            openedPath: opened.openedPath,
            restoredTo: projectPath,
            branchedFromId,
        };
        const viewerRestored = await restoreViewer(meta, context, deps);
        if (viewerRestored === false) result.viewerRestored = false;
        return result;
    } catch (error) {
        return {
            ok: false,
            reverted: false,
            stage: 'resolve',
            error: error && error.message ? error.message : String(error),
        };
    }
}

async function call(args, context, deps) {
    if (typeof args.checkpoint_id !== 'string' || !args.checkpoint_id)
        return {
            result: textResult({ ok: false, error: '`checkpoint_id` must be a non-empty string' }, true),
        };
    if (args.branch_before_revert !== undefined && typeof args.branch_before_revert !== 'boolean')
        return { result: textResult({ ok: false, error: '`branch_before_revert` must be a boolean' }, true) };
    const denied = await enforce('ae_revert', Object.assign({}, context, { arguments: args }), deps);
    if (denied) return { result: textResult(denied, true) };
    const result = await revertToCheckpoint(
        args.checkpoint_id,
        { branchBeforeRevert: args.branch_before_revert === true },
        context,
        deps,
    );
    return { result: textResult(result, result.ok !== true) };
}

module.exports = {
    definition,
    call,
    revertToCheckpoint,
    _atomicReplace: atomicReplace,
};
