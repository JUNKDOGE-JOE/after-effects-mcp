'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { createStatePaths } = require('./state-paths');

function registryError(code, message) {
    return Object.assign(new Error(message), { code });
}

function normalizeProjectPath(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || !value.trim()) throw registryError('INVALID_PATH', 'An absolute project path is required');
    const windows = /^[A-Za-z]:/.test(value) || /^(?:\\\\|\/\/)/.test(value);
    const api = windows ? path.win32 : path.posix;
    if (!api.isAbsolute(value)) throw registryError('INVALID_PATH', 'An absolute project path is required');
    let resolved = value;
    try { resolved = fs.realpathSync(value); } catch (_) { /* A launch can reserve a project before it exists. */ }
    return windows ? path.win32.normalize(resolved).toLowerCase() : path.posix.normalize(resolved);
}

function newId(prefix) { return prefix + '_' + crypto.randomBytes(16).toString('hex'); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
const STATES = ['starting', 'running', 'closing', 'unknown', 'closed'];
const FIELDS = ['endpoint', 'pid', 'cepPid', 'projectPath', 'workspaceId', 'ownerInstanceId', 'state', 'reason', 'ticketPath'];

function processAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === 'ESRCH' ? false : null; }
}

class InstanceRegistry {
    constructor(options) {
        const input = options || {};
        const paths = input.statePaths || createStatePaths(input);
        this.root = path.resolve(input.root || paths.instances || path.join(paths.stateDir, 'instances'));
        this.file = path.join(this.root, 'registry.json');
        this.lock = path.join(this.root, 'registry.lock');
        this.maxInstances = input.maxInstances === undefined ? 4 : input.maxInstances;
        this.maxWorkers = input.maxWorkers === undefined ? 2 : input.maxWorkers;
        this.lockTimeoutMs = input.lockTimeoutMs === undefined ? 2000 : input.lockTimeoutMs;
        this.memoryAvailable = input.memoryAvailable || os.freemem;
        this.minFreeMemoryBytes = input.minFreeMemoryBytes || 0;
        this.workerEstimateBytes = input.workerEstimateBytes || 0;
        this.isProcessAlive = input.isProcessAlive || processAlive;
        if (![this.maxInstances, this.maxWorkers].every((n) => Number.isInteger(n) && n >= 0 && n <= 64)
            || this.maxInstances === 0 || !Number.isFinite(this.lockTimeoutMs) || this.lockTimeoutMs < 0) {
            throw registryError('INVALID_BUDGET', 'Instance budgets must be bounded non-negative integers');
        }
    }

    _readSync() {
        try {
            const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (data.version !== 1 || !Array.isArray(data.instances) || data.instances.length > 128) throw new Error('invalid registry');
            return data.instances;
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw registryError('REGISTRY_UNREADABLE', 'Cannot read instance registry: ' + error.message);
        }
    }

    _alive(pid) {
        if (!Number.isSafeInteger(pid) || pid <= 1) return null;
        try {
            const result = this.isProcessAlive(pid);
            return typeof result === 'boolean' ? result : null;
        } catch (_) { return null; }
    }

    _marker(record) { return path.join(this.root, record.instanceId + '.closed'); }

    _observedState(record) {
        if (record.state === 'closed') return null;
        if (this._alive(record.pid) === false) {
            return { state: 'closed', reason: record.role === 'primary' ? 'primary-exited' : 'worker-exited' };
        }
        if (record.role !== 'primary') return null;
        if (fs.existsSync(this._marker(record))) return { state: 'unknown',
            reason: record.reason === 'panel-host-exited' ? record.reason : 'panel-disconnected' };
        if (this._alive(record.cepPid) === false) return { state: 'unknown', reason: 'panel-host-exited' };
        return null;
    }

    _reconcile(records) {
        for (const record of records) {
            const observed = this._observedState(record);
            if (!observed) continue;
            if (observed.state === 'unknown' && !fs.existsSync(this._marker(record))) {
                fs.writeFileSync(this._marker(record), JSON.stringify({ instanceId: record.instanceId, reason: observed.reason }), 'utf8');
            }
            if (record.state !== observed.state || record.reason !== observed.reason) {
                Object.assign(record, observed, { updatedAt: Date.now() });
            }
        }
    }

    canReattach(record, candidate) {
        return record && record.role === 'primary' && record.state !== 'closed'
            && Number.isSafeInteger(candidate.pid) && candidate.pid > 1 && record.pid === candidate.pid
            && this._alive(candidate.pid) === true && Number.isSafeInteger(candidate.cepPid) && candidate.cepPid > 1
            && (fs.existsSync(this._marker(record))
                || record.cepPid !== candidate.cepPid && this._alive(record.cepPid) === false);
    }

    async _read() {
        const records = this._readSync();
        if (!records.some((record) => {
            const observed = this._observedState(record);
            return observed && (record.state !== observed.state || record.reason !== observed.reason);
        })) return records;
        return this._mutate(current => current);
    }

    async _mutate(change) {
        fs.mkdirSync(this.root, { recursive: true });
        const deadline = Date.now() + this.lockTimeoutMs;
        let lock = null;
        while (lock === null) {
            try { lock = fs.openSync(this.lock, 'wx'); }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                // A stale timestamp does not prove that the owner or its AE stopped.
                if (Date.now() >= deadline) throw registryError('REGISTRY_BUSY', 'Instance registry is occupied; no ownership was changed');
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
        }
        const temporary = path.join(this.root, newId('registry') + '.tmp');
        try {
            // Do not yield while holding the lock: CEP may tear down the context at an await boundary.
            const records = this._readSync();
            this._reconcile(records);
            const result = change(records);
            if (result && typeof result.then === 'function') throw new TypeError('Registry mutations must be synchronous');
            const active = records.filter((record) => record.state !== 'closed');
            const closed = records.filter((record) => record.state === 'closed').sort((a, b) => b.updatedAt - a.updatedAt);
            fs.writeFileSync(temporary, JSON.stringify({ version: 1, instances: active.concat(closed.slice(0, 64)) }), 'utf8');
            fs.renameSync(temporary, this.file);
            return copy(result);
        } finally {
            try { fs.unlinkSync(temporary); } catch (_) {}
            try { fs.closeSync(lock); } finally { fs.unlinkSync(this.lock); }
        }
    }

    _check(records, candidate) {
        if (!['primary', 'worker'].includes(candidate.role) || !STATES.includes(candidate.state)) {
            throw registryError('INVALID_INSTANCE', 'Invalid instance role or state');
        }
        candidate.projectKey = normalizeProjectPath(candidate.projectPath);
        if (candidate.state === 'closed') return;
        const others = records.filter((record) => record.instanceId !== candidate.instanceId && record.state !== 'closed');
        if (candidate.role === 'worker' && candidate.state === 'starting'
            && !records.some(record => record.instanceId === candidate.instanceId)) {
            const starting = others.filter(record => record.role === 'worker' && record.state === 'starting').length;
            if (this.memoryAvailable() - (starting + 1) * this.workerEstimateBytes < this.minFreeMemoryBytes) {
                throw registryError('INSTANCE_BUDGET', 'Insufficient free memory for another read worker; keep the primary responsive');
            }
        }
        if (candidate.role === 'primary' && candidate.projectKey && others.some((record) =>
            record.role === 'primary' && record.projectKey === candidate.projectKey)) {
            throw registryError('PROJECT_OCCUPIED', 'The project already has a primary instance or a starting reservation');
        }
        if (others.length >= this.maxInstances || (candidate.role === 'worker'
            && others.filter((record) => record.role === 'worker').length >= this.maxWorkers)) {
            throw registryError('INSTANCE_BUDGET', 'The instance resource budget is occupied');
        }
    }

    async list(options) {
        const records = await this._read();
        return records.filter((record) => (options && options.includeClosed) || record.state !== 'closed');
    }

    async get(instanceId) {
        return (await this._read()).find((record) => record.instanceId === instanceId) || null;
    }

    reserve(input) {
        const options = input || {};
        return this._mutate((records) => {
            const instanceId = options.instanceId || newId('instance');
            if (typeof instanceId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(instanceId)) throw registryError('INVALID_INSTANCE', 'A valid instanceId is required');
            if (records.some((record) => record.instanceId === instanceId)) throw registryError('INSTANCE_EXISTS', 'Instance identity already exists');
            const record = { instanceId, role: options.role || 'primary', state: 'starting', projectPath: options.projectPath || null,
                workspaceId: options.workspaceId || null, ownerInstanceId: options.ownerInstanceId || null,
                endpoint: null, pid: null, updatedAt: Date.now() };
            this._check(records, record);
            records.push(record);
            return record;
        });
    }

    register(input) {
        const options = input || {};
        return this._mutate((records) => {
            if (typeof options.instanceId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(options.instanceId)) throw registryError('INVALID_INSTANCE', 'A valid instanceId is required');
            let record = records.find((item) => item.instanceId === options.instanceId);
            const replaced = options.replacesInstanceId
                ? records.find((item) => item.instanceId === options.replacesInstanceId) : null;
            if (options.replacesInstanceId && (record || !this.canReattach(replaced, options))) {
                throw registryError('REATTACH_REFUSED', 'Only a disconnected panel on the same verified AE can be replaced');
            }
            if (record && record.state === 'closed') throw registryError('INSTANCE_CLOSED', 'A closed instance identity cannot be reused');
            if (record && record.role === 'primary' && record.cepPid && options.cepPid && record.cepPid !== options.cepPid) {
                throw registryError('REATTACH_REFUSED', 'A replacement CEP host requires a fresh instance identity');
            }
            if (record && options.role && options.role !== record.role) throw registryError('INVALID_INSTANCE', 'An instance cannot change its role');
            const candidate = Object.assign({}, record || { instanceId: options.instanceId, role: options.role || 'primary', projectPath: null });
            FIELDS.forEach((key) => { if (options[key] !== undefined) candidate[key] = options[key]; });
            candidate.state = 'running';
            candidate.updatedAt = Date.now();
            this._check(replaced ? records.filter(item => item !== replaced) : records, candidate);
            if (replaced) Object.assign(replaced, { state: 'closed', reason: 'panel-reattached',
                replacedByInstanceId: candidate.instanceId, updatedAt: Date.now() });
            if (record) Object.assign(record, candidate);
            else { record = candidate; records.push(record); }
            return record;
        });
    }

    update(instanceId, patch) {
        return this._mutate((records) => {
            const record = records.find((item) => item.instanceId === instanceId);
            if (!record) throw registryError('INSTANCE_NOT_FOUND', 'Unknown instance');
            if (record.state === 'closed') throw registryError('INSTANCE_CLOSED', 'The instance is closed');
            const candidate = Object.assign({}, record);
            FIELDS.forEach((key) => { if (patch && patch[key] !== undefined) candidate[key] = patch[key]; });
            candidate.updatedAt = Date.now();
            this._check(records, candidate);
            return Object.assign(record, candidate);
        });
    }

    unregister(instanceId, reason) {
        return this._mutate((records) => {
            const record = records.find((item) => item.instanceId === instanceId);
            if (!record) throw registryError('INSTANCE_NOT_FOUND', 'Unknown instance');
            if (record.state !== 'closed') Object.assign(record, { state: 'closed', reason: reason || 'closed', updatedAt: Date.now() });
            return record;
        });
    }
}

module.exports = { InstanceRegistry, normalizeProjectPath };
