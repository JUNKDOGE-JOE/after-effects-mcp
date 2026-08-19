'use strict';

// ae_exec — run ExtendScript through the host JSX bridge (shares the /exec
// execution chain: pause / client block, undo group, transport envelope,
// native graph invalidation, activity log).

const fs = require('fs');
const path = require('path');
const { textResult } = require('../tool-result');
const { VERB_ANNOTATIONS } = require('../annotations');
const { enforce } = require('../approval-gate');
const { parseJsxResult } = require('../jsx-result');
const { renderTemplate } = require('../template');

const PROJECT_PATH_CODE = 'JSON.stringify({ok:true,'
    + 'path: app.project.file ? app.project.file.fsName : null})';
const CHECKPOINT_TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, '../../../jsx/templates/checkpoint_create.jsx'),
    'utf8',
);

const definition = {
    name: 'ae_exec',
    description: 'Run ExtendScript in After Effects through the host JSX bridge.',
    inputSchema: {
        type: 'object',
        properties: {
            code: { type: 'string', minLength: 1 },
            undo_group_name: { type: 'string' },
            checkpoint_label: { type: 'string' },
            timeout_sec: { type: 'number', minimum: 1, maximum: 600 },
        },
        required: ['code'],
        additionalProperties: false,
    },
    annotations: Object.assign({}, VERB_ANNOTATIONS.ae_exec, { openWorldHint: false }),
};

function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function executionFailure(execution) {
    const payload = Object.assign({}, execution && execution.payload || {
        ok: false, error: 'invalid JSX execution result',
    });
    if (execution && execution.disposition) payload.disposition = execution.disposition;
    return payload;
}

function requireSuccessfulExecution(execution) {
    const payload = execution && execution.payload;
    if (!payload || payload.ok !== true || typeof payload.result !== 'string') {
        const failure = executionFailure(execution);
        const error = new Error(failure.error || 'JSX execution failed');
        if (failure.disposition) error.disposition = failure.disposition;
        throw error;
    }
    return payload.result;
}

function withTimeout(promise, timeoutMs) {
    return new Promise(function (resolve, reject) {
        let settled = false;
        const timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            const error = new Error('checkpoint timed out');
            error.code = 'CHECKPOINT_TIMEOUT';
            reject(error);
        }, timeoutMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
        Promise.resolve(promise).then(function (value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, function (error) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

function ensureCheckpointFile(projectPath, destination, parsed) {
    const reportedSize = Number(parsed.sizeBytes) || 0;
    if (fs.existsSync(destination) && reportedSize > 0) {
        return Math.max(reportedSize, fs.statSync(destination).size);
    }
    if (fs.existsSync(projectPath)) {
        fs.copyFileSync(projectPath, destination);
        try {
            const sourceStat = fs.statSync(projectPath);
            fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
        } catch (error) {
            // Metadata preservation is best-effort; the copied bytes are the
            // correctness boundary for this fallback.
        }
    }
    return fs.existsSync(destination) ? fs.statSync(destination).size : null;
}

async function resolveProjectPath(context, deps) {
    const execution = await withTimeout(deps.executeJsx({
        code: PROJECT_PATH_CODE,
        timeoutMs: 10000,
        client: context.session.clientName,
        nativeProjectGraphEffect: 'preserve',
    }), 15000);
    const parsed = parseJsxResult(requireSuccessfulExecution(execution));
    return record(parsed) && parsed.ok === true ? parsed.path || null : null;
}

async function autoCheckpoint(args, context, deps) {
    if (!args.checkpoint_label) return null;
    try {
        const projectPath = await resolveProjectPath(context, deps);
        if (!projectPath) return 'untitled-project';
        const store = deps.getCheckpointStore();
        const id = store.makeId();
        const destination = store.aepPath(projectPath, id);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const checkpointCode = renderTemplate(CHECKPOINT_TEMPLATE, {
            dst_path: JSON.stringify(destination),
        });
        const checkpointExecution = await deps.executeJsx({
            code: checkpointCode,
            timeoutMs: 60000,
            client: context.session.clientName,
            nativeProjectGraphEffect: 'preserve',
        });
        const parsed = parseJsxResult(requireSuccessfulExecution(checkpointExecution));
        if (!record(parsed) || parsed.ok !== true) return 'checkpoint-failed: bad-result';
        if (parsed.skipped) return parsed.reason || 'skipped';
        const sizeBytes = ensureCheckpointFile(projectPath, destination, parsed);
        if (sizeBytes === null) return 'checkpoint-file-missing';
        store.writeMeta({
            sourceProjectPath: projectPath,
            id,
            label: args.checkpoint_label,
            activeCompId: parsed.activeCompId === undefined ? null : parsed.activeCompId,
            currentTime: Number(parsed.currentTime) || 0,
            sizeBytes,
        });
        store.prune(projectPath);
        return null;
    } catch (error) {
        if (error && error.code === 'CHECKPOINT_TIMEOUT') return 'checkpoint-timeout';
        return 'checkpoint-failed: ' + (error && error.message ? error.message : String(error));
    }
}

async function call(args, context, deps) {
    if (typeof args.code !== 'string' || args.code.length === 0) {
        return { result: textResult({ ok: false, error: 'missing or empty `code`' }, true) };
    }
    if (args.undo_group_name !== undefined && typeof args.undo_group_name !== 'string') {
        return { result: textResult({ ok: false, error: '`undo_group_name` must be a string' }, true) };
    }
    if (args.checkpoint_label !== undefined && typeof args.checkpoint_label !== 'string') {
        return { result: textResult({ ok: false, error: '`checkpoint_label` must be a string' }, true) };
    }
    if (args.timeout_sec !== undefined
        && (!Number.isFinite(args.timeout_sec) || args.timeout_sec < 1 || args.timeout_sec > 600)) {
        return { result: textResult({ ok: false, error: '`timeout_sec` must be between 1 and 600' }, true) };
    }
    try {
        const denied = await enforce(
            'ae_exec',
            Object.assign({}, context, { arguments: args }),
            deps,
        );
        if (denied) return { result: textResult(denied, true) };
        const checkpointSkipped = await autoCheckpoint(args, context, deps);
        const execution = await deps.executeJsx({
            code: args.code,
            undoGroup: args.undo_group_name,
            // Auto-checkpoint belongs to the ae_exec MCP tool layer. The shared
            // /exec chain intentionally continues to accept but ignore this
            // field so direct HTTP /exec retains today's Python-era semantics.
            checkpointLabel: args.checkpoint_label,
            timeoutMs: (args.timeout_sec === undefined ? 30 : args.timeout_sec) * 1000,
            client: context.session.clientName,
            nativeProjectGraphEffect: 'invalidate',
        });
        if (!execution || !execution.payload || execution.payload.ok !== true) {
            const failure = executionFailure(execution);
            return { result: textResult(failure, true) };
        }
        const parsed = parseJsxResult(execution.payload.result);
        if (record(parsed) && checkpointSkipped
            && !Object.prototype.hasOwnProperty.call(parsed, 'checkpointSkipped')) {
            parsed.checkpointSkipped = checkpointSkipped;
        }
        return { result: textResult(parsed, record(parsed) && parsed.ok === false) };
    } catch (error) {
        const payload = { ok: false, error: error && error.message ? error.message : String(error) };
        if (error && typeof error.disposition === 'string') payload.disposition = error.disposition;
        return { result: textResult(payload, true) };
    }
}

module.exports = { definition, call };
