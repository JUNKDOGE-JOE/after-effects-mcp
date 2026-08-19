'use strict';

// Shared checkpoint mechanics. ae_exec uses the best-effort wrapper while
// ae_checkpoint and ae_revert use the explicit result-producing primitives.

const fs = require('fs');
const path = require('path');
const { parseJsxResult } = require('./jsx-result');
const { renderTemplate } = require('./template');

const PROJECT_PATH_CODE =
    'JSON.stringify({ok:true,' + 'path: app.project.file ? app.project.file.fsName : null})';
const CHECKPOINT_TEMPLATE = fs.readFileSync(
    path.resolve(__dirname, '../../jsx/templates/checkpoint_create.jsx'),
    'utf8',
);

function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function executionFailure(execution) {
    const payload = Object.assign(
        {},
        (execution && execution.payload) || {
            ok: false,
            error: 'invalid JSX execution result',
        },
    );
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
        Promise.resolve(promise).then(
            function (value) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            function (error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(error);
            },
        );
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
            // Metadata preservation is best-effort; copied bytes are the boundary.
        }
    }
    return fs.existsSync(destination) ? fs.statSync(destination).size : null;
}

// The replacement temp file must live beside the destination: rename is only
// atomic within one volume. Kept here with checkpoint file mechanics so both
// checkpoint/revert tests can exercise the same persistence boundary.
function atomicReplace(source, destination, fsImpl) {
    const io = fsImpl || fs;
    const directory = path.dirname(destination);
    io.mkdirSync(directory, { recursive: true });
    const temporary =
        io.mkdtempSync(path.join(directory, '.' + path.basename(destination) + '.')) + '.aep.tmp';
    try {
        io.copyFileSync(source, temporary);
        io.renameSync(temporary, destination);
    } catch (error) {
        try {
            if (io.existsSync(temporary)) io.unlinkSync(temporary);
        } catch (cleanupError) {
            /* best effort */
        }
        throw error;
    }
}

async function resolveProjectPath(context, deps) {
    const execution = await withTimeout(
        deps.executeJsx({
            code: PROJECT_PATH_CODE,
            timeoutMs: 10000,
            client: context.session.clientName,
            nativeProjectGraphEffect: 'preserve',
        }),
        15000,
    );
    const parsed = parseJsxResult(requireSuccessfulExecution(execution));
    return record(parsed) && parsed.ok === true ? parsed.path || null : null;
}

async function createCheckpoint(options, context, deps) {
    const projectPath =
        options.projectPath === undefined ? await resolveProjectPath(context, deps) : options.projectPath;
    if (!projectPath) return { ok: false, error: 'untitled-project', projectPath: null };
    const store = deps.getCheckpointStore();
    const id = options.id || store.makeId();
    const destination = store.aepPath(projectPath, id);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const code = renderTemplate(CHECKPOINT_TEMPLATE, { dst_path: JSON.stringify(destination) });
    const execution = await deps.executeJsx({
        code,
        undoGroup: options.undoGroup,
        timeoutMs: 60000,
        client: context.session.clientName,
        nativeProjectGraphEffect: 'preserve',
    });
    const parsed = parseJsxResult(requireSuccessfulExecution(execution));
    if (!record(parsed) || parsed.ok !== true) {
        return { ok: false, error: 'checkpoint-failed: bad-result', backendResult: parsed };
    }
    if (parsed.skipped) return { ok: false, error: parsed.reason || 'skipped', backendResult: parsed };
    const sizeBytes = ensureCheckpointFile(projectPath, destination, parsed);
    if (sizeBytes === null) {
        return {
            ok: false,
            error: 'checkpoint file missing after AE copy',
            path: destination,
            backendResult: parsed,
        };
    }
    store.writeMeta({
        sourceProjectPath: projectPath,
        id,
        label: options.label || '',
        activeCompId: parsed.activeCompId === undefined ? null : parsed.activeCompId,
        currentTime: Number(parsed.currentTime) || 0,
        sizeBytes,
    });
    store.prune(projectPath);
    return {
        ok: true,
        id,
        label: options.label || '',
        path: destination,
        sizeBytes,
        projectPath,
        activeCompId: parsed.activeCompId === undefined ? null : parsed.activeCompId,
        currentTime: Number(parsed.currentTime) || 0,
    };
}

async function autoCheckpoint(args, context, deps) {
    if (!args.checkpoint_label) return null;
    try {
        const checkpoint = await createCheckpoint({ label: args.checkpoint_label }, context, deps);
        if (checkpoint.ok) return null;
        if (checkpoint.error === 'untitled-project') return 'untitled-project';
        if (checkpoint.error === 'checkpoint file missing after AE copy') return 'checkpoint-file-missing';
        return checkpoint.error || 'checkpoint-failed: bad-result';
    } catch (error) {
        if (error && error.code === 'CHECKPOINT_TIMEOUT') return 'checkpoint-timeout';
        return 'checkpoint-failed: ' + (error && error.message ? error.message : String(error));
    }
}

module.exports = {
    PROJECT_PATH_CODE,
    autoCheckpoint,
    atomicReplace,
    createCheckpoint,
    ensureCheckpointFile,
    executionFailure,
    record,
    requireSuccessfulExecution,
    resolveProjectPath,
    withTimeout,
};
