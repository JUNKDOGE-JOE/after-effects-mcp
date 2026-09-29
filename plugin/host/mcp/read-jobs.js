'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectDirKey } = require('./checkpoint-store');
const read = require('./tools/read');
const preview = require('./tools/preview-frame');

function validateRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some((key) => !['id', 'tool', 'arguments'].includes(key))
        || typeof request.id !== 'string' || !request.id || request.id.length > 100
        || !['ae_read', 'ae_previewFrame'].includes(request.tool)) throw new Error('invalid readonly request');
    const args = request.arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('request arguments must be an object');
    if (request.tool === 'ae_read') {
        const normalized = read.normalizeArgs(args);
        const error = read.validateArgs(normalized);
        if (error) throw new Error(error);
        if (!['project', 'comps'].includes(normalized.target) && !normalized.comp) throw new Error('snapshot reads require an explicit composition');
    } else {
        const allowed = Object.keys(preview.definition.inputSchema.properties);
        if (Object.keys(args).some((key) => !allowed.includes(key))) throw new Error('unsupported preview argument');
        if (args.out_dir !== undefined) throw new Error('read jobs manage their preview output directory');
        if (!/^\d+$/.test(String(args.comp_id || ''))) throw new Error('snapshot previews require an explicit comp_id');
        const hasTime = args.time !== undefined || Array.isArray(args.times) && args.times.length > 0 || args.range;
        const compareTimes = args.compare && args.compare.a && args.compare.b
            && args.compare.a.time !== undefined && args.compare.b.time !== undefined;
        if (!hasTime && !compareTimes) throw new Error('snapshot previews require explicit sample times');
        if (args.compare && !compareTimes) throw new Error('read jobs cannot compare unrelated capture histories');
    }
}

function createReadJobs(deps) {
    if (typeof deps.createWorker !== 'function' || typeof deps.getCheckpointStore !== 'function') throw new TypeError('read jobs require worker and checkpoint dependencies');
    const maxWorkers = Math.max(1, Math.min(4, deps.maxWorkers || 2));
    const maxJobs = Math.max(1, Math.min(50, deps.maxJobs || 20));
    const jobs = new Map();
    const waiters = [];
    let activeWorkers = 0;
    let closed = false;
    async function acquire() {
        if (activeWorkers >= maxWorkers) await new Promise((resolve) => waiters.push(resolve));
        else activeWorkers += 1;
    }
    function releaseSlot() {
        if (waiters.length) waiters.shift()();
        else activeWorkers -= 1;
    }
    function get(jobId, context) {
        const job = jobs.get(jobId);
        if (!job || job.contextId !== context.contextId) throw new Error('read job not found for this context');
        return job;
    }
    function statusOf(job) {
        return { job_id: job.id, state: job.state, source: job.source, total: job.requests.length,
            completed: job.results.filter((entry) => entry && entry.status === 'completed').length,
            failed: job.results.filter((entry) => entry && entry.status === 'failed').length,
            running: job.running, errors: job.errors.slice(), cleanup_unknown: job.cleanupUnknown.slice() };
    }
    async function runWorker(job, workerIndex) {
        await acquire();
        let worker;
        try {
            if (job.cancelled) return;
            worker = await deps.createWorker({ checkpointPath: job.checkpointPath, jobId: job.id,
                workerIndex, source: job.source, context: job.context,
                onStarted(handle) {
                    worker = handle;
                    job.workers.add(handle);
                    if (job.cancelled && handle.requestStop) handle.requestStop();
                } });
            job.workers.add(worker);
            while (!job.cancelled && job.cursor < job.requests.length) {
                const index = job.cursor++;
                const request = job.requests[index];
                job.running += 1;
                try {
                    const handler = request.tool === 'ae_read' ? read : preview;
                    const args = request.tool === 'ae_previewFrame'
                        ? { ...request.arguments, include_base64: false } : request.arguments;
                    const output = await handler.call(args, job.context, { ...deps,
                        executeJsx: worker.executeJsx, previewSessionId: job.id,
                    });
                    const result = output.result.structuredContent;
                    if (request.tool === 'ae_previewFrame' && Array.isArray(output.result.content)) {
                        const directory = path.join(deps.resultRoot || path.join(os.tmpdir(), 'ae_mcp_read_jobs'), job.id);
                        fs.mkdirSync(directory, { recursive: true });
                        const contentPath = path.join(directory, index + '.json');
                        fs.writeFileSync(contentPath, JSON.stringify(output.result.content), 'utf8');
                        job.contentPaths[index] = contentPath;
                    }
                    const failed = output.result.isError === true || result && result.ok === false;
                    job.results[index] = { id: request.id, status: failed ? 'failed' : 'completed',
                        source: job.source, worker_index: workerIndex, result };
                    if (result && result.disposition === 'uncertain') break;
                } catch (error) {
                    job.results[index] = { id: request.id, status: 'failed', source: job.source, error: error.message };
                } finally { job.running -= 1; }
            }
        } catch (error) { job.errors.push(error.message); }
        finally {
            if (worker) {
                try { await worker.close(); } catch (error) {
                    job.errors.push('worker close: ' + error.message);
                    job.cleanupUnknown.push({ code: error.code || 'WORKER_CLOSE_UNCONFIRMED',
                        disposition: 'indeterminate', pid: worker.pid || null, snapshot_retained: true });
                }
                job.workers.delete(worker);
            }
            releaseSlot();
        }
    }
    async function run(job) {
        job.state = job.cancelled ? 'cancel_requested' : 'running';
        try {
            await Promise.all(Array.from({ length: Math.min(maxWorkers, job.requests.length) }, (_, index) => runWorker(job, index)));
            for (let index = 0; index < job.requests.length; index += 1) {
                if (!job.results[index]) job.results[index] = { id: job.requests[index].id,
                    status: 'not-started', source: job.source, reason: job.cancelled ? job.cancelReason : 'worker-unavailable' };
            }
            job.state = job.cleanupUnknown.length ? 'indeterminate' : job.cancelled ? (job.cancelReason === 'owner-closed' ? 'owner_closed' : 'cancelled')
                : job.errors.length || job.results.some((entry) => entry.status !== 'completed') ? 'failed' : 'completed';
        } finally { job.releaseSnapshot(); job.finished = true; }
    }
    function submit(args, context) {
        if (closed) throw new Error('read jobs are closed');
        if (!context || !context.contextId || !context.projectPath) throw new Error('a bound project context is required');
        if (typeof args.checkpoint_id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(args.checkpoint_id)) throw new Error('checkpoint_id is required');
        if (!Array.isArray(args.requests) || !args.requests.length || args.requests.length > 32) throw new Error('requests must contain 1 to 32 items');
        args.requests.forEach(validateRequest);
        if (new Set(args.requests.map((request) => request.id)).size !== args.requests.length) throw new Error('request ids must be unique');
        while (jobs.size >= maxJobs) {
            const oldest = Array.from(jobs.values()).find((job) => job.finished);
            if (!oldest) throw new Error('read job capacity reached');
            oldest.contentPaths.forEach((file) => { try { fs.unlinkSync(file); } catch (_) {} });
            jobs.delete(oldest.id);
        }
        const store = deps.getCheckpointStore();
        const releaseSnapshot = store.retain(context.projectPath, args.checkpoint_id);
        let checkpointPath;
        let metadata;
        try {
            checkpointPath = store.lookupAep(context.projectPath, args.checkpoint_id);
            metadata = store.readMeta(context.projectPath, args.checkpoint_id);
            if (!checkpointPath || !metadata) throw new Error('checkpoint is missing its source record');
        } catch (error) { releaseSnapshot(); throw error; }
        const id = crypto.randomBytes(16).toString('hex');
        const source = { mode: 'snapshot', checkpoint_id: args.checkpoint_id,
            project_key: projectDirKey(context.projectPath), captured_at: metadata.ts, realtime: false };
        const job = { id, contextId: context.contextId, context, source, checkpointPath, releaseSnapshot,
            requests: JSON.parse(JSON.stringify(args.requests)), results: [], contentPaths: [], cursor: 0, running: 0,
            state: 'queued', cancelled: false, finished: false, workers: new Set(), errors: [], cleanupUnknown: [] };
        jobs.set(id, job);
        job.completion = Promise.resolve().then(() => run(job));
        return statusOf(job);
    }
    function cancelJob(job, reason) {
        if (job.finished) return statusOf(job);
        job.cancelled = true;
        job.cancelReason = reason;
        job.state = 'cancel_requested';
        job.workers.forEach((worker) => {
            try { if (worker.requestStop) worker.requestStop(); } catch (error) { job.errors.push(error.message); }
        });
        return statusOf(job);
    }
    return {
        submit,
        status: (id, context) => statusOf(get(id, context)),
        result(id, context, { offset = 0, limit = 10 } = {}) {
            if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('invalid result page');
            const job = get(id, context);
            const end = Math.min(job.requests.length, offset + limit);
            return { ...statusOf(job), offset, next_offset: end < job.requests.length ? end : null,
                results: job.requests.slice(offset, end).map((request, index) => job.results[offset + index]
                    || { id: request.id, status: 'pending', source: job.source }) };
        },
        resultImages(id, context, { offset = 0, limit = 10 } = {}) {
            const job = get(id, context);
            const index = job.contentPaths.findIndex((file, index) => file && index >= offset && index < offset + limit);
            if (index < 0) return null;
            const content = JSON.parse(fs.readFileSync(job.contentPaths[index], 'utf8')).filter((block) => block.type === 'image');
            let total = 0;
            for (const block of content) {
                if (typeof block.data !== 'string' || block.data.length > preview.IMAGE_BUDGET_PER_IMAGE_BASE64) throw new Error('preview image exceeded its response budget');
                total += block.data.length;
            }
            if (total > preview.IMAGE_BUDGET_TOTAL_BASE64) throw new Error('preview images exceeded the response budget');
            return { requestId: job.requests[index].id, content };
        },
        cancel: (id, context) => cancelJob(get(id, context), 'cancelled'),
        closeOwner(contextId) { jobs.forEach((job) => { if (job.contextId === contextId) cancelJob(job, 'owner-closed'); }); },
        close() {
            closed = true;
            jobs.forEach((job) => cancelJob(job, 'owner-closed'));
            return Promise.all(Array.from(jobs.values()).map((job) => job.completion));
        },
    };
}

module.exports = { createReadJobs, validateRequest };
