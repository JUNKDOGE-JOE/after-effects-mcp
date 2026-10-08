'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function writeJson(file, value) {
    const temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value), 'utf8');
    fs.renameSync(temporary, file);
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function waitFor(check, timeoutMs, pollMs) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        function poll() {
            try {
                const value = check();
                if (value) return resolve(value);
                if (timeoutMs && Date.now() - started >= timeoutMs) throw new Error('worker response timed out');
                setTimeout(poll, pollMs);
            } catch (error) { reject(error); }
        }
        poll();
    });
}

async function createReadonlyWorker(options) {
    const { checkpointPath, workDir, startWorker } = options;
    const closeTimeoutMs = options.closeTimeoutMs === undefined ? 30000 : options.closeTimeoutMs;
    const failureCloseTimeoutMs = options.failureCloseTimeoutMs === undefined ? 2000 : options.failureCloseTimeoutMs;
    if (!Number.isFinite(failureCloseTimeoutMs) || failureCloseTimeoutMs <= 0) throw new TypeError('failureCloseTimeoutMs must be positive and finite');
    if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs <= 0) throw new TypeError('closeTimeoutMs must be positive and finite');
    if (typeof startWorker !== 'function') throw new TypeError('startWorker is required');
    if (!path.isAbsolute(workDir || '') || !path.isAbsolute(checkpointPath || '')) {
        throw new TypeError('absolute workDir and checkpointPath are required');
    }
    if (options.ownerClosedPath != null && (typeof options.ownerClosedPath !== 'string' || !path.isAbsolute(options.ownerClosedPath))) {
        throw new TypeError('ownerClosedPath must be absolute');
    }
    if (options.ownerClosedPath && fs.existsSync(options.ownerClosedPath)) {
        throw Object.assign(new Error('Owner panel closed'), { code: 'OWNER_CLOSED' });
    }
    const root = fs.mkdtempSync(path.join(workDir, 'ae-mcp-worker-'));
    const snapshotPath = path.join(root, 'snapshot.aep');
    const scriptPath = path.join(root, 'start.jsx');
    const runtimePath = path.resolve(__dirname, '../../jsx/runtime.jsx');
    const entryPath = path.resolve(__dirname, '../../jsx/readonly-worker.jsx');
    const configuration = { root, snapshotPath, runtimePath, ownerClosedPath: options.ownerClosedPath || null,
        ownerProcessId: (options.platform || process.platform) === 'win32' ? process.pid : null };
    const pollMs = options.pollMs || 50;
    let record;
    let queue = Promise.resolve();
    let stopping = false;
    let faulted = false;
    let closePromise = null;
    const child = () => record && (record.process || record.child);
    const exited = () => child() && (child().exitCode !== null && child().exitCode !== undefined
        || child().signalCode !== null && child().signalCode !== undefined);
    const requestStop = () => {
        stopping = true;
        writeJson(path.join(root, 'stop.json'), { stop: true });
    };
    const close = () => {
        if (closePromise) return closePromise;
        requestStop();
        closePromise = waitFor(() => {
            const result = readJson(path.join(root, 'closed.json'));
            if (result && result.ok === false) throw new Error(result.error || 'worker refused to close');
            return exited() || (!child() && result);
        }, closeTimeoutMs, pollMs)
            .catch((cause) => {
                const error = new Error('Worker close could not be confirmed: ' + cause.message);
                error.code = 'WORKER_CLOSE_UNCONFIRMED';
                error.disposition = 'indeterminate';
                error.pid = record && record.pid;
                error.snapshotRetained = true;
                throw error;
            })
            .then(() => {
                let snapshotRemoved = false;
                if (path.dirname(snapshotPath) !== root) throw new Error('worker snapshot escaped its directory');
                try { fs.unlinkSync(snapshotPath); snapshotRemoved = true; }
                catch (error) { if (error.code !== 'ENOENT') return { closed: true, snapshotRemoved }; snapshotRemoved = true; }
                return { closed: true, snapshotRemoved };
            });
        return closePromise;
    };
    const handle = { requestStop, close };
    let published = false;
    function publishStarted() {
        Object.assign(handle, { pid: record && record.pid, instanceId: record && record.instanceId });
        if (!published && typeof options.onStarted === 'function') {
            published = true;
            options.onStarted(handle);
        }
    }
    try {
        fs.copyFileSync(checkpointPath, snapshotPath, fs.constants.COPYFILE_EXCL);
        fs.writeFileSync(scriptPath, '$.global.__aemcpWorkerConfig=' + JSON.stringify(configuration)
            + ';\n$.evalFile(new File(' + JSON.stringify(entryPath) + '));\n', 'utf8');
        record = await startWorker({ scriptPath, workDir: root, env: options.env, instanceId: options.instanceId });
        publishStarted();
        const ready = await waitFor(() => {
            const response = readJson(path.join(root, 'ready.json'));
            if (!response && exited()) throw new Error('worker exited before readiness');
            return response;
        }, options.startTimeoutMs || 60000, pollMs);
        if (!ready.ok || path.normalize(ready.projectPath || '') !== path.normalize(snapshotPath)) {
            throw Object.assign(new Error(ready.error || 'worker opened the wrong snapshot'), {
                code: ready.code || 'WORKER_START_FAILED', disposition: ready.code === 'WORKER_PROJECT_CHANGED' ? 'indeterminate' : 'not_dispatched',
            });
        }
    } catch (error) {
        record = record || error.launchedInstance;
        if (record) {
            error.launchedInstance = record;
            try { publishStarted(); requestStop(); }
            catch (cleanupError) { error.cleanupError = cleanupError.message; }
            const refused = () => {
                const ready = readJson(path.join(root, 'ready.json'));
                const closed = readJson(path.join(root, 'closed.json'));
                return error.code === 'WORKER_PROJECT_CHANGED' || ready && ready.code === 'WORKER_PROJECT_CHANGED'
                    || closed && closed.ok === false;
            };
            if (!refused()) {
                try {
                    await waitFor(() => {
                        if (refused()) return true;
                        return exited() || (!child() && readJson(path.join(root, 'closed.json')));
                    }, failureCloseTimeoutMs, pollMs);
                } catch (_) {
                    // No acknowledgement cannot prove the current AE project is ours.
                    // Keep the process/snapshot for inspection; never force-kill user work.
                    error.cleanupError = 'Worker exit unconfirmed; PID and snapshot retained';
                    error.snapshotRetained = true;
                }
            }
            if (exited() && fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
            error.launchedInstance = record;
        } else if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);
        throw error;
    }
    function executeJsx(request) {
        const run = queue.then(async () => {
            if (stopping || faulted) throw new Error('worker is no longer accepting reads');
            if (!request || typeof request.code !== 'string') throw new TypeError('internal JSX code is required');
            const id = crypto.randomBytes(12).toString('hex');
            writeJson(path.join(root, 'request.json'), { id, code: request.code });
            try {
                const result = await waitFor(() => {
                    const response = readJson(path.join(root, id + '.json'));
                    if (!response && exited()) throw new Error('worker exited during a read');
                    return response;
                }, request.timeoutMs || 30000, pollMs);
                return { status: 200, payload: result };
            } catch (error) {
                faulted = true;
                error.disposition = 'uncertain';
                throw error;
            }
        });
        queue = run.catch(() => {});
        return run;
    }
    return Object.assign(handle, { executeJsx });
}

module.exports = { createReadonlyWorker };
