'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CheckpointStore } = require('./checkpoint-store');
const { createReadJobs, validateRequest } = require('./read-jobs');
const tool = require('./tools/read-job');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-read-jobs-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    const projectPath = path.join(root, 'Main.aep');
    const store = new CheckpointStore({ root: path.join(root, 'state') });
    fs.mkdirSync(store.dirFor(projectPath), { recursive: true });
    fs.writeFileSync(store.aepPath(projectPath, 'baseline'), 'checkpoint');
    store.writeMeta({ sourceProjectPath: projectPath, id: 'baseline' });
    return { store, context: { contextId: 'owner', projectPath, workDir: root, session: { clientName: 'test' } } };
}
function request(id) { return { id, tool: 'ae_read', arguments: { target: 'project' } }; }
function reply() {
    return { payload: { ok: true, result: JSON.stringify({ ok: true,
        projectLocator: { locatorKind: 'jsx', projectId: null }, total: 0, offset: 0,
        limit: 50, returned: 0, hasMore: false, nextOffset: null, items: [],
    }) } };
}
async function until(check) {
    for (let i = 0; i < 100; i += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('test condition did not settle');
}

test('runs existing read handlers on a retained checkpoint and paginates source-labelled results', async (t) => {
    const { store, context } = fixture(t);
    let started = 0;
    let active = 0;
    let peak = 0;
    const jobs = createReadJobs({ getCheckpointStore: () => store, maxWorkers: 2, createWorker: async (options) => {
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        assert.equal(options.checkpointPath, store.lookupAep(context.projectPath, 'baseline'));
        return { executeJsx: async (input) => {
            assert.match(input.code, /var project = app.project/);
            assert.equal(store.remove(context.projectPath, 'baseline'), false);
            await new Promise((resolve) => setTimeout(resolve, 5));
            return reply();
        }, close: async () => { active -= 1; } };
    } });
    const first = jobs.submit({ checkpoint_id: 'baseline', requests: [request('a'), request('b'), request('c')] }, context);
    const second = jobs.submit({ checkpoint_id: 'baseline', requests: [request('d')] }, context);
    await until(() => jobs.status(second.job_id, context).state === 'completed');
    assert.equal(jobs.status(first.job_id, context).state, 'completed');
    assert.ok(started >= 2);
    assert.equal(peak, 2);
    const page = jobs.result(first.job_id, context, { offset: 1, limit: 1 });
    assert.equal(page.results[0].id, 'b');
    assert.equal(page.results[0].result.total, 0);
    assert.equal(page.next_offset, 2);
    assert.equal(page.source.realtime, false);
    assert.equal(page.source.checkpoint_id, 'baseline');
    assert.equal(JSON.stringify(page.source).includes(context.projectPath), false);
    assert.throws(() => jobs.status(first.job_id, { contextId: 'other' }), /not found/);
    assert.equal(store.remove(context.projectPath, 'baseline'), true);
    await jobs.close();
});

test('cancel and owner close stop queued reads without pretending an active call was interrupted', async (t) => {
    const { store, context } = fixture(t);
    let releaseRead;
    let calls = 0;
    let stopSignals = 0;
    const gate = new Promise((resolve) => { releaseRead = resolve; });
    const jobs = createReadJobs({ getCheckpointStore: () => store, maxWorkers: 1, createWorker: async () => ({
        executeJsx: async () => { calls += 1; await gate; return reply(); },
        requestStop: () => { stopSignals += 1; }, close: async () => {},
    }) });
    const job = jobs.submit({ checkpoint_id: 'baseline', requests: [request('active'), request('queued')] }, context);
    await until(() => calls === 1);
    assert.equal(jobs.cancel(job.job_id, context).state, 'cancel_requested');
    jobs.closeOwner(context.contextId);
    assert.ok(stopSignals > 0);
    assert.equal(jobs.status(job.job_id, context).running, 1);
    releaseRead();
    await until(() => jobs.status(job.job_id, context).state === 'owner_closed');
    assert.equal(calls, 1);
    assert.equal(jobs.result(job.job_id, context).results[1].status, 'not-started');
    await jobs.close();
});

test('missing snapshots and script/write requests are rejected before worker startup', async (t) => {
    const { store, context } = fixture(t);
    let starts = 0;
    const jobs = createReadJobs({ getCheckpointStore: () => store, createWorker: async () => { starts += 1; } });
    assert.throws(() => jobs.submit({ checkpoint_id: 'missing', requests: [request('a')] }, context), /checkpoint/);
    for (const candidate of [
        { id: 'a', tool: 'ae_exec', arguments: { code: 'app.project.save()' } },
        { ...request('a'), code: 'app.project.save()' },
        { id: 'a', tool: 'ae_read', arguments: { target: 'layers' } },
        { id: 'a', tool: 'ae_previewFrame', arguments: { comp_id: '5' } },
        { id: 'a', tool: 'ae_previewFrame', arguments: { comp_id: '5', time: 0, guide_layers: false } },
    ]) assert.throws(() => jobs.submit({ checkpoint_id: 'baseline', requests: [candidate] }, context));
    assert.equal(starts, 0);
    validateRequest({ id: 'p', tool: 'ae_previewFrame', arguments: { comp_id: '5', times: [0, 1] } });
    const result = await tool.call({ action: 'status', job_id: 'missing' }, context, { getReadJobs: () => jobs });
    assert.equal(result.result.isError, true);
    await jobs.close();
});

test('a failed read is reported independently while the remaining readonly requests finish', async (t) => {
    const { store, context } = fixture(t);
    let calls = 0;
    const jobs = createReadJobs({ getCheckpointStore: () => store, maxWorkers: 1, createWorker: async () => ({
        executeJsx: async () => ++calls === 1 ? { payload: { ok: false, error: 'read failed' } } : reply(), close: async () => {},
    }) });
    const submitted = await tool.call({ action: 'submit', checkpoint_id: 'baseline', requests: [request('bad'), request('good')] }, context, { getReadJobs: () => jobs });
    const id = submitted.result.structuredContent.job_id;
    await until(() => jobs.status(id, context).state === 'failed');
    assert.deepEqual(jobs.result(id, context).results.map((entry) => entry.status), ['failed', 'completed']);
    await jobs.close();
});


test('preview result pages attach one original budgeted image result and keep captures distinct', async (t) => {
    const { store, context } = fixture(t);
    const { encodePng } = require('./png');
    const previews = [];
    const jobs = createReadJobs({ getCheckpointStore: () => store,
        previewRoot: path.join(context.workDir, 'previews'), resultRoot: path.join(context.workDir, 'results'),
        createWorker: async () => ({ executeJsx: async (input) => {
            const outputPath = JSON.parse(/var outFile = new File\((.+)\);/.exec(input.code)[1]);
            previews.push(outputPath);
            fs.writeFileSync(outputPath, encodePng(Buffer.alloc(16, 255), 2, 2));
            return { payload: { ok: true, result: JSON.stringify({ ok: true, path: outputPath,
                source: 'comp', method: 'saveFrameToPng', compId: '1', compName: 'Main', time: 0,
                compWidth: 2, compHeight: 2, resolutionFactor: [1, 1] }) } };
        }, close: async () => {} }),
    });
    const job = jobs.submit({ checkpoint_id: 'baseline', requests: ['a', 'b'].map((id) => ({
        id, tool: 'ae_previewFrame', arguments: { comp_id: '1', time: 0 },
    })) }, context);
    await until(() => ['completed', 'failed'].includes(jobs.status(job.job_id, context).state));
    assert.equal(jobs.status(job.job_id, context).state, 'completed');
    assert.notEqual(previews[0], previews[1]);
    const response = await tool.call({ action: 'result', job_id: job.job_id, offset: 1, limit: 1 }, context, { getReadJobs: () => jobs });
    assert.equal(response.result.structuredContent.image_request_id, 'b');
    assert.equal(response.result.content.filter((block) => block.type === 'image').length, 1);
    assert.equal(jobs.result(job.job_id, context).results[0].result.frames[0].base64, undefined);
    await jobs.close();
});


test('owner closure signals a worker that has spawned but is not ready yet', async (t) => {
    const { store, context } = fixture(t);
    let started = false;
    let stopSignals = 0;
    let ready;
    const gate = new Promise((resolve) => { ready = resolve; });
    const jobs = createReadJobs({ getCheckpointStore: () => store, maxWorkers: 1, createWorker: async (options) => {
        const handle = { requestStop: () => { stopSignals += 1; }, close: async () => {},
            executeJsx: async () => { throw new Error('cancelled worker must not dispatch'); } };
        options.onStarted(handle);
        started = true;
        await gate;
        return handle;
    } });
    const job = jobs.submit({ checkpoint_id: 'baseline', requests: [request('queued')] }, context);
    await until(() => started);
    jobs.closeOwner(context.contextId);
    assert.equal(stopSignals, 1);
    ready();
    await jobs.close();
    assert.equal(jobs.status(job.job_id, context).state, 'owner_closed');
});


test('unconfirmed worker cleanup cannot become a fully cancelled job', async (t) => {
    const { store, context } = fixture(t);
    let signal;
    const gate = new Promise((resolve) => { signal = resolve; });
    const jobs = createReadJobs({ getCheckpointStore: () => store, maxWorkers: 1, createWorker: async () => ({
        pid: 321, executeJsx: async () => { await gate; return reply(); },
        close: async () => { throw Object.assign(new Error('timeout'), { code: 'WORKER_CLOSE_UNCONFIRMED' }); },
    }) });
    const job = jobs.submit({ checkpoint_id: 'baseline', requests: [request('a')] }, context);
    await until(() => jobs.status(job.job_id, context).running === 1);
    jobs.cancel(job.job_id, context);
    signal();
    await jobs.close();
    const status = jobs.status(job.job_id, context);
    assert.equal(status.state, 'indeterminate');
    assert.equal(status.cleanup_unknown[0].pid, 321);
    assert.equal(status.cleanup_unknown[0].snapshot_retained, true);
});
