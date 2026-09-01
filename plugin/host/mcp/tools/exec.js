'use strict';

const crypto = require('crypto');
const { textResult } = require('../tool-result');
const { VERB_ANNOTATIONS } = require('../annotations');
const { enforce } = require('../approval-gate');
const { parseExecResult } = require('../jsx-result');
const { matchHint } = require('../error-hints');
const { candidateGuidance, captureSuccessfulScript } = require('../candidate-artifacts');

const HISTORY_REDACTION_MARKERS = [
    'omitted from prior model history',
    'hidden from history to save tokens'
];
const HISTORY_REDACTION_WORDS = /\b(omitted|redacted|hidden|elided)\b/i;
const HISTORY_REDACTION_CONTEXT = /\b(history|tokens?|context)\b/i;
const PLACEHOLDER_STREAK_FIELD = 'placeholderRejectionStreak';

function isHistoryRedactionPlaceholder(value) {
    if (typeof value !== 'string') return false;
    if (HISTORY_REDACTION_MARKERS.some((marker) => value.includes(marker))) return true;
    const trimmed = value.trim();
    const placeholderShape = value.length <= 300 && (
        /^\/\*[\s\S]*\*\/$/.test(trimmed)
        || (trimmed.charAt(0) === '[' && trimmed.charAt(trimmed.length - 1) === ']')
        || (!/[\r\n]/.test(trimmed) && !/[;{=(]/.test(trimmed))
    );
    return placeholderShape
        && HISTORY_REDACTION_WORDS.test(value)
        && HISTORY_REDACTION_CONTEXT.test(value);
}

function placeholderError(recovery) {
    const suffix = recovery
        ? ' omit `code` entirely to rerun the stored recovery script, or pass a full replacement script.'
        : '';
    return `\`code\` is a redaction placeholder from the conversation history, not runnable code (earlier scripts are hidden to save tokens). Write the complete script again from scratch.${suffix}`;
}

function placeholderStreak(context) {
    const session = context && context.session;
    if (!session || typeof session !== 'object') return 1;
    const next = Number.isInteger(session[PLACEHOLDER_STREAK_FIELD])
        ? session[PLACEHOLDER_STREAK_FIELD] + 1 : 1;
    session[PLACEHOLDER_STREAK_FIELD] = next;
    return next;
}

function resetPlaceholderStreak(context) {
    const session = context && context.session;
    if (session && typeof session === 'object') session[PLACEHOLDER_STREAK_FIELD] = 0;
}

function recordPlaceholderRejection(code, context, deps, tool, streak) {
    if (!deps || typeof deps.recordMcpActivity !== 'function') return;
    const session = context && context.session ? context.session : {};
    deps.recordMcpActivity({
        tool,
        transport: 'mcp',
        ok: false,
        verdict: 'placeholder_rejected',
        client: typeof session.clientName === 'string' ? session.clientName : null,
        streak,
        scriptChars: code.length,
        scriptHead: code.replace(/\s+/g, ' ').trim().slice(0, 200),
    });
}

function escalatedPlaceholderError(streak, context, deps) {
    const prefix = 'Redaction placeholder rejected (consecutive rejection #' + streak + ').';
    const guidance = candidateGuidance('', context, deps);
    if (guidance.indexOf('Recent successful scripts you can rerun:') !== -1) return prefix + guidance;
    return prefix + ' Write the complete script from scratch; do not resend redacted history';
}

function placeholderResponse(code, context, deps, tool, recovery) {
    const streak = placeholderStreak(context);
    recordPlaceholderRejection(code, context, deps, tool, streak);
    const error = streak === 1
        ? candidateGuidance(placeholderError(recovery), context, deps)
        : escalatedPlaceholderError(streak, context, deps);
    return {
        result: textResult({ ok: false, error }, true),
    };
}
const {
    autoCheckpoint,
    executionFailure,
    record,
    resolveProjectPath,
} = require('../checkpoint-ops');
const { resolveForKey } = require('../checkpoint-store');
const { RECOVERY_ID } = require('../recovery-store');
const { revertToCheckpoint } = require('./revert');

let recentProjectPath = null;

const definition = {
    name: 'ae_exec',
    description: 'Run a new ExtendScript in After Effects. Dispatched failures may return a recoveryId and editable scriptPath; retry those only with ae_execRecover. Successful content remains a string with contentType "json" or "text".',
    inputSchema: {
        type: 'object',
        properties: {
            code: {
                type: 'string',
                minLength: 1,
                description: 'New ExtendScript to run.',
            },
            undo_group_name: { type: 'string' },
            checkpoint_label: { type: 'string' },
            timeout_sec: { type: 'number', minimum: 1, maximum: 600 },
        },
        required: ['code'],
        additionalProperties: false,
    },
    outputSchema: {
        type: 'object',
        properties: {
            ok: { type: 'boolean' },
            content: { type: 'string' },
            contentType: { type: 'string', enum: ['text', 'json'] },
            error: { type: 'string' },
            disposition: { type: 'string' },
            recoveryId: { type: 'string' },
            scriptPath: { type: 'string' },
            checkpointId: { type: ['string', 'null'] },
            errorLine: { type: ['number', 'null'] },
            errorSource: { type: 'string' },
            touched: { type: ['object', 'null'] },
            logs: { type: 'array', items: { type: 'string' } },
            logsTruncated: { type: 'boolean' },
            revision: { type: 'object' },
            attempt: { type: 'number' },
            restored: { type: 'string' },
            artifactId: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: true,
    },
    annotations: Object.assign({}, VERB_ANNOTATIONS.ae_exec, { openWorldHint: false }),
};

function hasOwn(value, field) {
    return Object.prototype.hasOwnProperty.call(value, field);
}

function recoveryIdHint(args) {
    return hasOwn(args, 'code')
        ? '; corrected code was not executed; use the exact id returned by ae_exec, or call ae_exec with code to start a new execution'
        : '';
}

const EXEC_FIELDS = ['code', 'undo_group_name', 'checkpoint_label', 'timeout_sec'];
const RECOVERY_FIELDS = EXEC_FIELDS.concat(['recoveryId', 'retryMode']);

function unsupportedField(args, allowed) {
    const names = Object.keys(args);
    for (let i = 0; i < names.length; i += 1) {
        if (allowed.indexOf(names[i]) === -1) return names[i];
    }
    return null;
}

function executionArgsError(args) {
    if (args.undo_group_name !== undefined && typeof args.undo_group_name !== 'string') {
        return '`undo_group_name` must be a string';
    }
    if (args.checkpoint_label !== undefined && typeof args.checkpoint_label !== 'string') {
        return '`checkpoint_label` must be a string';
    }
    if (args.timeout_sec !== undefined
        && (!Number.isFinite(args.timeout_sec) || args.timeout_sec < 1 || args.timeout_sec > 600)) {
        return '`timeout_sec` must be between 1 and 600';
    }
    return null;
}

function initialValidationError(args) {
    if (hasOwn(args, 'recoveryId') || hasOwn(args, 'retryMode')) {
        return 'recovery fields are only accepted by `ae_execRecover`';
    }
    const unsupported = unsupportedField(args, EXEC_FIELDS);
    if (unsupported) return 'unsupported argument: `' + unsupported + '`';
    if (typeof args.code !== 'string' || args.code.length === 0) {
        return 'missing or empty `code`';
    }
    return executionArgsError(args);
}

function recoveryValidationError(args) {
    const unsupported = unsupportedField(args, RECOVERY_FIELDS);
    if (unsupported) return 'unsupported argument: `' + unsupported + '`';
    if (typeof args.recoveryId !== 'string' || !RECOVERY_ID.test(args.recoveryId)) {
        return '`recoveryId` must match ^[a-z0-9]{6}$' + recoveryIdHint(args);
    }
    if (hasOwn(args, 'code') && (typeof args.code !== 'string' || args.code.length === 0)) {
        return 'missing or empty `code`';
    }
    if (hasOwn(args, 'retryMode')
        && ['restore', 'continue'].indexOf(args.retryMode) === -1) {
        return '`retryMode` must be restore or continue';
    }
    return executionArgsError(args);
}

function sha256(code) {
    return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

function nullableArg(args, name) {
    return args[name] === undefined ? null : args[name];
}

function storedArgs(args) {
    return {
        undo_group_name: nullableArg(args, 'undo_group_name'),
        checkpoint_label: nullableArg(args, 'checkpoint_label'),
        timeout_sec: nullableArg(args, 'timeout_sec'),
    };
}

function currentCheckpoint(checkpointRun) {
    return checkpointRun && checkpointRun.checkpoint && checkpointRun.checkpoint.ok === true
        ? checkpointRun.checkpoint : null;
}

function annotateCheckpoint(value, checkpointRun) {
    if (record(value) && checkpointRun && checkpointRun.skipped
        && !hasOwn(value, 'checkpointSkipped')) {
        value.checkpointSkipped = checkpointRun.skipped;
    }
    return value;
}

function executionDisposition(execution, failure) {
    if (failure && typeof failure.disposition === 'string') return failure.disposition;
    if (execution && typeof execution.disposition === 'string') return execution.disposition;
    return null;
}

function recordMcpFailure(execution, failure, code, deps, tool) {
    if (!execution || !execution.payload || execution.payload.ok !== true || !failure || failure.ok !== false || !deps || typeof deps.recordMcpActivity !== 'function') return;
    const error = typeof failure.error === 'string' ? failure.error : String(failure.error || 'MCP execution failed');
    const match = matchHint(error);
    deps.recordMcpActivity({
        tool: tool || 'ae_exec',
        transport: 'mcp',
        ok: false,
        verdict: 'mcp_failed',
        error,
        scriptChars: typeof code === 'string' ? code.length : undefined,
        scriptHead: typeof code === 'string' ? code.replace(/\s+/g, ' ').trim().slice(0, 200) : undefined,
        ...(match ? { hinted: true, hintIndex: match.index } : {})
    });
}

function resultFailure(execution) {
    if (!execution || !execution.payload || execution.payload.ok !== true) {
        return executionFailure(execution);
    }
    const parsed = parseExecResult(execution.payload.resultType, execution.payload.result);
    if (parsed.ok !== false) return null;
    ['projectPath', 'revision', 'logs', 'logsTruncated'].forEach(function (field) {
        if (hasOwn(execution.payload, field)) parsed[field] = execution.payload[field];
    });
    return parsed;
}

function withErrorSource(failure, code) {
    if (!failure || !Number.isInteger(failure.errorLine) || failure.errorLine < 1
        || typeof code !== 'string') return failure;
    const lines = code.split(/\r?\n/);
    if (failure.errorLine > lines.length) return failure;
    return Object.assign({}, failure, {
        errorSource: lines[failure.errorLine - 1].trim().slice(0, 200),
    });
}

function attemptRecord(values) {
    const failure = values.failure || null;
    const revision = failure && failure.revision
        ? failure.revision
        : (values.execution && values.execution.payload && values.execution.payload.revision) || null;
    const touched = failure && failure.touched
        ? failure.touched
        : (values.execution && values.execution.payload && values.execution.payload.touched) || null;
    return {
        n: values.n,
        at: new Date().toISOString(),
        scriptSha256: sha256(values.code),
        retryMode: values.retryMode,
        restored: values.restored,
        checkpointId: values.checkpointId || null,
        ok: !failure,
        error: failure ? failure.error || 'ae_exec failed' : null,
        errorLine: failure && hasOwn(failure, 'errorLine') ? failure.errorLine : null,
        errorSource: failure && hasOwn(failure, 'errorSource') ? failure.errorSource : null,
        disposition: failure ? executionDisposition(values.execution, failure) : null,
        revision,
        touchedLevel: touched && typeof touched.level === 'string' ? touched.level : null,
    };
}

function recoverySourcePath(failure, checkpointRun) {
    if (failure && hasOwn(failure, 'projectPath')) return failure.projectPath || null;
    const checkpoint = checkpointRun && checkpointRun.checkpoint;
    if (checkpoint && checkpoint.projectPath) return checkpoint.projectPath;
    return recentProjectPath;
}

function createRecovery(args, context, deps, code, execution, failure, checkpointRun) {
    const checkpoint = currentCheckpoint(checkpointRun);
    const checkpointId = checkpoint ? checkpoint.id : null;
    const sourceProjectPath = recoverySourcePath(failure, checkpointRun) || null;
    const attempt = attemptRecord({
        n: 1,
        code,
        retryMode: 'initial',
        restored: 'not-applicable',
        checkpointId,
        execution,
        failure,
    });
    const entry = deps.getRecoveryStore().create({
        sourceProjectPath,
        code,
        meta: {
            checkpointId,
            args: storedArgs(args),
            client: context.session.clientName,
            conversationId: context.session.conversationId || null,
            attempts: [attempt],
        },
    });
    return Object.assign({}, failure, {
        recoveryId: entry.recoveryId,
        scriptPath: entry.scriptPath,
        checkpointId,
        attempt: 1,
    });
}

async function execute(code, args, context, deps) {
    return deps.executeJsx({
        code,
        undoGroup: args.undo_group_name === null ? undefined : args.undo_group_name,
        checkpointLabel: args.checkpoint_label === null ? undefined : args.checkpoint_label,
        timeoutMs: (args.timeout_sec === undefined || args.timeout_sec === null
            ? 30 : args.timeout_sec) * 1000,
        client: context.session.clientName,
        nativeProjectGraphEffect: 'invalidate',
        diagnostics: true,
    });
}

async function runInitial(args, context, deps) {
    const denied = await enforce('ae_exec', Object.assign({}, context, { arguments: args }), deps);
    if (denied) return denied;
    const checkpointRun = await autoCheckpoint(args, context, deps);
    const execution = await execute(args.code, args, context, deps);
    if (execution) resetPlaceholderStreak(context);
    if (execution && execution.payload
        && hasOwn(execution.payload, 'projectPath')) {
        recentProjectPath = execution.payload.projectPath || null;
    }
    const failure = withErrorSource(resultFailure(execution), args.code);
    recordMcpFailure(execution, failure, args.code, deps, 'ae_exec');
    if (failure) {
        annotateCheckpoint(failure, checkpointRun);
        const disposition = executionDisposition(execution, failure);
        if (execution && execution.payload && execution.payload.ok !== true
            && ['failed', 'uncertain'].indexOf(disposition) === -1) return failure;
        return createRecovery(args, context, deps, args.code, execution, failure, checkpointRun);
    }
    const parsed = parseExecResult(execution.payload.resultType, execution.payload.result);
    const artifactId = captureSuccessfulScript(args.code, args, context, deps, 'ae_exec');
    if (artifactId) parsed.artifactId = artifactId;
    return annotateCheckpoint(parsed, checkpointRun);
}

function effectiveArgs(meta, args) {
    const prior = meta.args && typeof meta.args === 'object' ? meta.args : {};
    const output = {};
    ['undo_group_name', 'checkpoint_label', 'timeout_sec'].forEach(function (name) {
        const value = hasOwn(args, name) ? args[name] : prior[name];
        if (value !== null && value !== undefined) output[name] = value;
    });
    return output;
}

function sameProject(expected, actual) {
    if (!expected || !actual) return expected === actual;
    return resolveForKey(expected) === resolveForKey(actual);
}

function lastAttempt(meta) {
    return Array.isArray(meta.attempts) && meta.attempts.length
        ? meta.attempts[meta.attempts.length - 1] : null;
}

function unchangedRevision(meta) {
    const prior = lastAttempt(meta);
    const revision = prior && prior.revision;
    return revision && typeof revision.before === 'number' && typeof revision.after === 'number'
        && revision.before === revision.after;
}

async function restoreForRetry(recoveryId, retryMode, meta, context, deps) {
    if (retryMode === 'continue') return { ok: true, restored: 'skipped' };
    if (!meta.checkpointId) {
        if (unchangedRevision(meta)) return { ok: true, restored: 'not-needed' };
        const prior = lastAttempt(meta);
        const revision = prior && prior.revision ? prior.revision : { before: null, after: null };
        return {
            ok: false,
            code: 'RECOVERY_RESTORE_UNAVAILABLE',
            error: 'no checkpoint was recorded for this call and the project changed (revision '
                + String(revision.before) + '\u2192' + String(revision.after)
                + '); pass retryMode:"continue" to run on the current state, or ae_revert to an earlier checkpoint first',
        };
    }
    const projectPath = await resolveProjectPath(context, deps);
    if (!sameProject(meta.sourceProjectPath || null, projectPath || null)) {
        return {
            ok: false,
            code: 'RECOVERY_PROJECT_MISMATCH',
            error: 'recovery ' + recoveryId + ' belongs to project '
                + String(meta.sourceProjectPath) + ' but ' + String(projectPath)
                + ' is open; open the matching project or use the recovery from its checkpoint directory',
        };
    }
    const reverted = await revertToCheckpoint(
        meta.checkpointId,
        { projectPath },
        context,
        deps,
    );
    if (!reverted || reverted.ok !== true) {
        return Object.assign({}, reverted || { ok: false, error: 'checkpoint restore failed' }, {
            recoveryId,
            stage: 'restore',
        });
    }
    recentProjectPath = projectPath;
    return { ok: true, restored: 'checkpoint' };
}

async function runRecovery(args, context, deps) {
    const store = deps.getRecoveryStore();
    const entry = store.lookup(args.recoveryId, recentProjectPath);
    if (!entry) {
        return {
            ok: false,
            error: 'unknown recoveryId: ' + args.recoveryId + recoveryIdHint(args),
        };
    }
    const meta = store.readMeta(entry);
    const code = hasOwn(args, 'code') ? args.code : store.readScript(entry);
    if (!code) return { ok: false, error: 'recovery script is empty: ' + args.recoveryId };
    const retryMode = args.retryMode || 'restore';
    const resolvedArgs = effectiveArgs(meta, args);
    const approvalArguments = Object.assign({}, resolvedArgs, {
        code,
        recoveryId: args.recoveryId,
        retryMode,
        restoreCheckpointId: meta.checkpointId || null,
    });
    const denied = await enforce(
        'ae_execRecover',
        Object.assign({}, context, { arguments: approvalArguments }),
        deps,
    );
    if (denied) return denied;
    if (hasOwn(args, 'code')) store.writeScript(entry, code);
    const restoration = await restoreForRetry(args.recoveryId, retryMode, meta, context, deps);
    if (!restoration.ok) return restoration;
    const checkpointRun = await autoCheckpoint(resolvedArgs, context, deps);
    const checkpoint = currentCheckpoint(checkpointRun);
    if (checkpoint) {
        meta.checkpointId = checkpoint.id;
        meta.sourceProjectPath = checkpoint.projectPath;
        store.writeMeta(entry, meta);
    }
    const execution = await execute(code, resolvedArgs, context, deps);
    if (execution) resetPlaceholderStreak(context);
    if (execution && execution.payload
        && hasOwn(execution.payload, 'projectPath')) {
        recentProjectPath = execution.payload.projectPath || null;
    }
    const failure = withErrorSource(resultFailure(execution), code);
    recordMcpFailure(execution, failure, code, deps, 'ae_execRecover');
    const attemptNumber = Array.isArray(meta.attempts) ? meta.attempts.length + 1 : 1;
    const checkpointId = checkpoint ? checkpoint.id : (meta.checkpointId || null);
    const attempt = attemptRecord({
        n: attemptNumber,
        code,
        retryMode,
        restored: restoration.restored,
        checkpointId,
        execution,
        failure,
    });
    store.appendAttempt(entry, attempt);
    if (failure) {
        annotateCheckpoint(failure, checkpointRun);
        return Object.assign({}, failure, {
            recoveryId: args.recoveryId,
            scriptPath: entry.scriptPath,
            checkpointId,
            attempt: attemptNumber,
            restored: restoration.restored,
        });
    }
    const parsed = parseExecResult(execution.payload.resultType, execution.payload.result);
    annotateCheckpoint(parsed, checkpointRun);
    const artifactId = captureSuccessfulScript(code, resolvedArgs, context, deps, 'ae_execRecover');
    return Object.assign({}, parsed, {
        recoveryId: args.recoveryId,
        attempt: attemptNumber,
        restored: restoration.restored,
        ...(artifactId ? { artifactId } : {}),
    });
}

async function call(args, context, deps) {
    if (isHistoryRedactionPlaceholder(args && args.code)) {
        return placeholderResponse(args.code, context, deps, 'ae_exec', false);
    }
    const input = args || {};
    const invalid = initialValidationError(input);
    if (invalid) return { result: textResult({ ok: false, error: invalid }, true) };
    try {
        const value = await runInitial(input, context, deps);
        return { result: textResult(value, record(value) && value.ok === false) };
    } catch (error) {
        const payload = { ok: false, error: error && error.message ? error.message : String(error) };
        if (error && typeof error.disposition === 'string') payload.disposition = error.disposition;
        return { result: textResult(payload, true) };
    }
}

async function recover(args, context, deps) {
    if (isHistoryRedactionPlaceholder(args && args.code)) {
        return placeholderResponse(args.code, context, deps, 'ae_execRecover', true);
    }
    const input = args || {};
    const invalid = recoveryValidationError(input);
    if (invalid) return { result: textResult({ ok: false, error: invalid }, true) };
    try {
        const value = await runRecovery(input, context, deps);
        return { result: textResult(value, record(value) && value.ok === false) };
    } catch (error) {
        const payload = { ok: false, error: error && error.message ? error.message : String(error) };
        if (error && typeof error.disposition === 'string') payload.disposition = error.disposition;
        return { result: textResult(payload, true) };
    }
}

module.exports = {
    definition,
    call,
    recover,
    _resetRecentProjectPathForTest: function () { recentProjectPath = null; },
};
