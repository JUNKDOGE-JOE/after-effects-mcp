'use strict';

const crypto = require('crypto');
const { normalizeProjectPath } = require('../instance-registry');

function id(prefix) { return prefix + '_' + crypto.randomBytes(16).toString('hex'); }
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function contextInstanceId(value) {
    const match = typeof value === 'string' && /^([A-Za-z0-9._-]+):[0-9a-f]{32}$/.exec(value);
    return match ? match[1] : null;
}

function guardProjectCode(code, context) {
    if (!context || !context.contextId || typeof code !== 'string') return code;
    const expected = JSON.stringify(context.projectPath || null);
    const generation = JSON.stringify(context.projectGeneration === undefined ? null : context.projectGeneration);
    return '(function(){var p=app.project;var s=$.global.__aemcpObservedProject;'
        + 'if((p.file?p.file.fsName:null)!==' + expected
        + '||(' + generation + '!==null&&(!s||s.generation!==' + generation
        + '||(typeof isValid==="function"&&!isValid(s.root)))))throw new Error("SOURCE_PROJECT_CHANGED: bind the current project before executing");}());' + code;
}

function unknownOutcome(value, depth) {
    if (!value || typeof value !== 'object' || (depth || 0) > 4) return false;
    if (value.code === 'POSSIBLY_SIDE_EFFECTING_FAILURE' || value.errorCode === 'POSSIBLY_SIDE_EFFECTING_FAILURE'
        || ['unknown', 'uncertain', 'indeterminate', 'possibly-side-effecting-failure'].includes(value.disposition)
        || ['unknown', 'may-have-occurred'].includes(value.sideEffect)) return true;
    return ['payload', 'result', 'structuredContent', 'error'].some((key) => unknownOutcome(value[key], (depth || 0) + 1));
}

class WorkspaceManager {
    constructor(options) {
        const input = options || {};
        if (typeof input.instanceId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(input.instanceId)
            || typeof input.readProject !== 'function') throw new TypeError('A valid instanceId and readProject are required');
        this.instanceId = input.instanceId;
        this.workspaceId = input.workspaceId || id('workspace');
        this.readProject = input.readProject;
        this.isDraining = input.isDraining || (() => false);
        this.contexts = new Map();
        this.project = null;
        this.writer = null;
        this.activeTurn = null;
        this.uncertain = null;
        this.closed = false;
        this.pending = 0;
        this.inflight = false;
        this.queue = Promise.resolve();
    }

    _enqueue(task) {
        this.pending += 1;
        const run = this.queue.then(async () => {
            this.inflight = true;
            try { return await task(); }
            finally { this.inflight = false; this.pending -= 1; this._settleWriter(); }
        });
        this.queue = run.catch(() => {});
        return run;
    }

    async _refresh() {
        if (this.closed) throw failure('WORKSPACE_CLOSED', 'The project host is closed');
        const current = await this.readProject();
        if (!current || !Object.prototype.hasOwnProperty.call(current, 'projectPath')) {
            throw failure('PROJECT_UNAVAILABLE', 'The host did not report its current project');
        }
        const project = { projectPath: current.projectPath, projectKey: normalizeProjectPath(current.projectPath),
            projectGeneration: current.projectGeneration === undefined ? null : current.projectGeneration };
        if (this.project && (this.project.projectKey !== project.projectKey
            || this.project.projectGeneration !== project.projectGeneration)) {
            this.contexts.forEach((context) => { context.valid = false; });
            this.writer = null;
            this.activeTurn = null;
            this.workspaceId = id('workspace');
        }
        this.project = project;
    }

    _context(contextId, write, allowUncertain) {
        if (!contextId) throw failure('WORKSPACE_REQUIRED', 'context_id is required; no target was selected');
        if (this.closed) throw failure('WORKSPACE_CLOSED', 'The project host is closed');
        const context = this.contexts.get(contextId);
        if (!context) throw failure('CONTEXT_NOT_FOUND', 'Unknown work context');
        if (!context.valid || context.workspaceId !== this.workspaceId) throw failure('SOURCE_PROJECT_CHANGED', 'The source project changed; bind the new project explicitly');
        if (write && context.access !== 'write') throw failure('WORKSPACE_READONLY', 'This context is read-only');
        if (write && this.uncertain && !allowUncertain) throw failure('RESULT_UNKNOWN', 'A dispatched operation must be reconciled before writing');
        return context;
    }

    _idle() {
        if (this.pending || this.inflight || this.activeTurn || this.isDraining()) throw failure('WORKSPACE_BUSY', 'A turn or AE operation is active; ownership cannot change');
        if (this.uncertain) throw failure('RESULT_UNKNOWN', 'A dispatched operation must be reconciled before ownership changes');
    }

    _settleWriter() {
        if (!this.pending && !this.activeTurn && !this.uncertain && !this.isDraining()) this.writer = null;
    }

    _claim(contextId, activity = {}) {
        this._context(contextId, true);
        const ownerId = activity.ownerId || contextId;
        if (activity.managedTurns && (!this.activeTurn || this.activeTurn.ownerId !== ownerId
            || this.activeTurn.turnId !== activity.turnId)) throw failure('TURN_INACTIVE', 'The panel turn has ended');
        if (this.isDraining() || (this.activeTurn && this.activeTurn.ownerId !== ownerId)) {
            throw failure('WORKSPACE_BUSY', 'Another turn or a draining AE operation still owns this project');
        }
        this.writer = contextId;
    }

    async startTurn(contextId, ownerId, turnId) {
        if (this.activeTurn && this.activeTurn.ownerId === ownerId && this.activeTurn.turnId === turnId) return;
        this._idle();
        return this._enqueue(async () => {
            await this._refresh();
            this._claim(contextId, { ownerId });
            this.activeTurn = { contextId, ownerId, turnId };
        });
    }

    endTurn(ownerId, turnId) {
        if (!this.activeTurn || this.activeTurn.ownerId !== ownerId || this.activeTurn.turnId !== turnId) return false;
        this.activeTurn = null;
        this._settleWriter();
        return true;
    }

    getContext(contextId) { return clone(this._context(contextId, false)); }

    inspect(contextId) {
        this._settleWriter();
        const context = contextId ? this.getContext(contextId) : null;
        return clone({ instanceId: this.instanceId, workspaceId: this.workspaceId, project: this.project,
            writerContextId: this.writer, pending: this.pending, inflight: this.inflight,
            uncertain: this.uncertain, activeTurn: this.activeTurn, draining: this.isDraining(), closed: this.closed, context });
    }

    bind(options) {
        const input = options || {};
        return this._enqueue(async () => {
            await this._refresh();
            if (input.instanceId && input.instanceId !== this.instanceId) throw failure('WRONG_INSTANCE', 'The requested instance is not this host');
            if (!['read', 'write'].includes(input.access)) throw failure('INVALID_ACCESS', 'access must be read or write');
            if (input.projectPath !== undefined && normalizeProjectPath(input.projectPath) !== this.project.projectKey) {
                throw failure('SOURCE_PROJECT_CHANGED', 'The requested project is not open in this host');
            }
            if (input.contextId) {
                const existing = this._context(input.contextId, false);
                if (input.access === 'write' && this.uncertain) throw failure('RESULT_UNKNOWN', 'The prior write outcome is unresolved');
                if (input.workDir !== undefined && normalizeProjectPath(input.workDir) !== normalizeProjectPath(existing.workDir)) {
                    throw failure('CONTEXT_CONFLICT', 'An existing context keeps its original work directory');
                }
                if (input.access === 'write') existing.access = 'write';
                return clone(existing);
            }
            normalizeProjectPath(input.workDir);
            if (input.access === 'write' && this.uncertain) throw failure('RESULT_UNKNOWN', 'The prior write outcome is unresolved');
            const context = { contextId: this.instanceId + ':' + crypto.randomBytes(16).toString('hex'), workspaceId: this.workspaceId, instanceId: this.instanceId,
                access: input.access, workDir: input.workDir || null, projectPath: this.project.projectPath,
                projectGeneration: this.project.projectGeneration, valid: true };
            this.contexts.set(context.contextId, context);
            return clone(context);
        });
    }

    async assertContext(contextId, write) {
        this._context(contextId, write);
        return this._enqueue(async () => { await this._refresh(); return clone(this._context(contextId, write)); });
    }

    async run(contextId, write, callback, activity) {
        if (typeof callback !== 'function') return Promise.reject(new TypeError('callback is required'));
        this._context(contextId, write);
        return this._enqueue(async () => {
            await this._refresh();
            const context = this._context(contextId, write);
            if (write) this._claim(contextId, activity);
            try {
                const result = await callback(clone(context));
                if (write && unknownOutcome(result)) this.markUncertain(contextId, { reason: 'dispatched result is unknown' });
                return result;
            } catch (error) {
                if (write && unknownOutcome(error)) this.markUncertain(contextId, { reason: error.message || 'dispatched result is unknown' });
                throw error;
            }
        });
    }

    async release(contextId) {
        this._idle();
        return this._enqueue(async () => {
            await this._refresh();
            const context = this._context(contextId, false);
            this.contexts.delete(contextId);
            if (this.writer === contextId) this.writer = null;
            return { released: true, contextId: context.contextId, instanceId: this.instanceId };
        });
    }

    async transfer(fromContextId, toContextId) {
        this._idle();
        return this._enqueue(async () => {
            await this._refresh();
            const from = fromContextId ? this._context(fromContextId, true) : null;
            const to = this._context(toContextId, false);
            if (from) from.access = 'read';
            to.access = 'write';
            this.writer = toContextId;
            return clone(to);
        });
    }

    markUncertain(contextId, details) {
        this._context(contextId, true, true);
        this.writer = contextId;
        this.uncertain = { contextId, project: clone(this.project), details: clone(details || {}), at: Date.now() };
    }

    async reconcile(contextId, confirmation) {
        if (this.pending || this.inflight) throw failure('WORKSPACE_BUSY', 'Wait for dispatched work before reconciling');
        if (!confirmation || confirmation.resolved !== true || typeof confirmation.evidenceId !== 'string' || !confirmation.evidenceId.trim()) {
            throw failure('RECONCILIATION_REQUIRED', 'Confirmed AE state and an evidenceId are required');
        }
        return this._enqueue(async () => {
            await this._refresh();
            if (!this.contexts.has(contextId) || !this.uncertain || this.uncertain.contextId !== contextId) {
                throw failure('CONTEXT_CONFLICT', 'Only the uncertain writer can reconcile');
            }
            const prior = this.uncertain;
            this.uncertain = null;
            return { resolved: true, evidenceId: confirmation.evidenceId, prior };
        });
    }

    close() { this.closed = true; }
}

module.exports = { WorkspaceManager, contextInstanceId, guardProjectCode };
