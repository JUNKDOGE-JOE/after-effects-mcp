'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createReadonlyWorker } = require('./readonly-worker');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-worker-test-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    const checkpointPath = path.join(root, 'baseline.aep');
    fs.writeFileSync(checkpointPath, 'immutable source');
    return { root, checkpointPath };
}
function configuration(scriptPath) {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const context = { $: { global: {}, evalFile() {} }, File: function () {} };
    vm.runInNewContext(source, context);
    return context.$.global.__aemcpWorkerConfig;
}

test('worker copies the fixed checkpoint, serializes requests, and stops without saving the source', async (t) => {
    const { root, checkpointPath } = fixture(t);
    let config;
    let timer;
    const requests = [];
    t.after(() => clearInterval(timer));
    const worker = await createReadonlyWorker({ checkpointPath, workDir: root, pollMs: 1, startWorker: async ({ scriptPath }) => {
        config = configuration(scriptPath);
        assert.equal(fs.readFileSync(config.snapshotPath, 'utf8'), 'immutable source');
        fs.writeFileSync(path.join(config.root, 'ready.json'), JSON.stringify({ ok: true, projectPath: config.snapshotPath }));
        timer = setInterval(() => {
            const requestPath = path.join(config.root, 'request.json');
            if (fs.existsSync(requestPath)) {
                const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
                fs.unlinkSync(requestPath);
                requests.push(request.code);
                fs.writeFileSync(path.join(config.root, request.id + '.json'), JSON.stringify({ ok: true, result: request.code }));
            }
            if (fs.existsSync(path.join(config.root, 'stop.json'))) {
                clearInterval(timer);
                fs.writeFileSync(path.join(config.root, 'closed.json'), '{"ok":true}');
            }
        }, 1);
        return { pid: 123, instanceId: 'owned-worker' };
    } });
    fs.writeFileSync(checkpointPath, 'changed later');
    const results = await Promise.all([worker.executeJsx({ code: 'first' }), worker.executeJsx({ code: 'second' })]);
    assert.deepEqual(requests, ['first', 'second']);
    assert.deepEqual(results.map((value) => value.payload.result), ['first', 'second']);
    assert.equal(fs.readFileSync(config.snapshotPath, 'utf8'), 'immutable source');
    assert.equal((await worker.close()).snapshotRemoved, true);
    assert.equal(fs.readFileSync(checkpointPath, 'utf8'), 'changed later');
    await assert.rejects(worker.executeJsx({ code: 'late' }), /no longer accepting/);
});

test('a worker read timeout prevents a second dispatch until the owned worker exits', async (t) => {
    const { root, checkpointPath } = fixture(t);
    let config;
    const worker = await createReadonlyWorker({ checkpointPath, workDir: root, pollMs: 1, startWorker: async ({ scriptPath }) => {
        config = configuration(scriptPath);
        fs.writeFileSync(path.join(config.root, 'ready.json'), JSON.stringify({ ok: true, projectPath: config.snapshotPath }));
        return {};
    } });
    await assert.rejects(worker.executeJsx({ code: 'slow', timeoutMs: 5 }), { disposition: 'uncertain' });
    await assert.rejects(worker.executeJsx({ code: 'next' }), /no longer accepting/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(config.root, 'request.json'))).code, 'slow');
    fs.writeFileSync(path.join(config.root, 'closed.json'), '{"ok":true}');
    await worker.close();
});


function jsxFixture(t, options = {}) {
    const { root, checkpointPath } = fixture(t);
    class File {
        constructor(value) { this.fsName = path.normalize(String(value)); }
        get exists() { return fs.existsSync(this.fsName); }
        open(mode) { this.mode = mode; return true; }
        read() { return fs.readFileSync(this.fsName, 'utf8'); }
        write(value) { this.text = value; }
        close() { if (this.mode === 'w') fs.writeFileSync(this.fsName, this.text); }
        rename(name) { fs.renameSync(this.fsName, path.join(path.dirname(this.fsName), name)); return true; }
        remove() { fs.unlinkSync(this.fsName); return true; }
    }
    let clock = 0;
    let scheduled;
    const state = { closed: false, quit: false, opened: 0 };
    const ownerClosedPath = path.join(root, 'owner-closed');
    const closeOwner = () => fs.writeFileSync(ownerClosedPath, 'closed');
    if (options.ownerClosed) closeOwner();
    const app = {
        project: { file: options.foreign ? new File(path.join(root, 'user.aep')) : null, numItems: 0,
            close(option) { assert.equal(option, 'discard'); state.closed = true; } },
        open(file) { this.project.file = file; state.opened += 1; },
        scheduleTask(code) { scheduled = code; return 1; },
        cancelTask(id) { assert.equal(id, 1); },
        quit() { state.quit = true; },
    };
    const context = { File, app, CloseOptions: { DO_NOT_SAVE_CHANGES: 'discard' },
        Date: function () { this.getTime = () => clock; }, advance: (ms) => { clock += ms; }, closeOwner,
        $: { global: { __aemcpWorkerConfig: { root, snapshotPath: checkpointPath, runtimePath: 'runtime.jsx', ownerClosedPath } }, evalFile() {} },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../jsx/readonly-worker.jsx'), 'utf8'), context);
    const tick = () => vm.runInContext(scheduled, context);
    const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name)));
    return { root, checkpointPath, state, context, tick, read, closeOwner,
        request(code) {
            const id = '1234567890abcdef12345678';
            fs.writeFileSync(path.join(root, 'request.json'), JSON.stringify({ id, code }));
            tick();
            return read(id + '.json');
        } };
}

test('maintained JSX entry opens its snapshot, serves a request, and closes without saving', (t) => {
    const worker = jsxFixture(t);
    assert.equal(worker.read('ready.json').ok, true);
    assert.equal(JSON.parse(worker.request('JSON.stringify({ok:true,value:7})').result).value, 7);
    fs.writeFileSync(path.join(worker.root, 'stop.json'), '{}');
    worker.tick();
    assert.equal(worker.state.closed, true);
    assert.equal(worker.state.quit, true);
    assert.equal(fs.readFileSync(worker.checkpointPath, 'utf8'), 'immutable source');
});

test('an owner already closed before startup exits an empty worker without opening its snapshot', (t) => {
    const worker = jsxFixture(t, { ownerClosed: true });
    assert.equal(worker.read('ready.json').code, 'OWNER_CLOSED');
    assert.equal(worker.state.opened, 0);
    assert.equal(worker.state.quit, true);
});

test('owner closure during a synchronous request is handled only after its result', (t) => {
    const worker = jsxFixture(t);
    assert.equal(worker.request('closeOwner(); JSON.stringify({ok:true})').ok, true);
    assert.equal(worker.state.quit, false);
    worker.tick();
    assert.equal(worker.read('closed.json').reason, 'owner-closed');
    assert.equal(worker.state.quit, true);
});

test('idle timeout counts from completion and never interrupts a long request', (t) => {
    const worker = jsxFixture(t);
    assert.equal(worker.request('advance(180000); JSON.stringify({ok:true})').ok, true);
    worker.tick();
    assert.equal(worker.state.quit, false);
    worker.context.advance(120000);
    worker.tick();
    assert.equal(worker.read('closed.json').reason, 'idle-timeout');
    assert.equal(worker.state.quit, true);
});

test('worker reports host errors without invoking their unsafe string coercion', (t) => {
    const worker = jsxFixture(t);
    const result = worker.request('throw {message:"AE error",toString:function(){throw new Error("coercion failed");}}');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'AE error');
});

test('owner closure does not close an unrelated project at startup or after switching', (t) => {
    const foreign = jsxFixture(t, { foreign: true, ownerClosed: true });
    assert.equal(foreign.read('ready.json').code, 'WORKER_PROJECT_CHANGED');
    assert.equal(foreign.state.quit, false);
    const changed = jsxFixture(t);
    changed.context.app.project.file = { fsName: path.join(changed.root, 'user.aep') };
    changed.closeOwner();
    changed.tick();
    assert.equal(changed.read('closed.json').ok, false);
    assert.equal(changed.state.closed, false);
    assert.equal(changed.state.quit, false);
});

test('unconfirmed worker closure is bounded and retains the snapshot and pid', async (t) => {
    const { root, checkpointPath } = fixture(t);
    let config;
    const worker = await createReadonlyWorker({ checkpointPath, workDir: root, pollMs: 1, closeTimeoutMs: 5,
        startWorker: async ({ scriptPath }) => {
            config = configuration(scriptPath);
            fs.writeFileSync(path.join(config.root, 'ready.json'), JSON.stringify({ ok: true, projectPath: config.snapshotPath }));
            return { pid: 321 };
        } });
    await assert.rejects(worker.close(), { code: 'WORKER_CLOSE_UNCONFIRMED', disposition: 'indeterminate', pid: 321 });
    assert.equal(fs.existsSync(config.snapshotPath), true);
});


test('the Node launcher preserves an explicit foreign-project refusal', async (t) => {
    const { root, checkpointPath } = fixture(t);
    let killed = false;
    const ownerClosedPath = path.join(root, 'owner-closed');
    await assert.rejects(createReadonlyWorker({ checkpointPath, workDir: root, ownerClosedPath, pollMs: 1,
        stopWorker: async () => { killed = true; }, startWorker: async ({ scriptPath }) => {
            const config = configuration(scriptPath);
            assert.equal(config.ownerClosedPath, ownerClosedPath);
            fs.writeFileSync(path.join(config.root, 'ready.json'), JSON.stringify({ ok: false,
                code: 'WORKER_PROJECT_CHANGED', error: 'Other project' }));
            return { pid: 321 };
        } }), { code: 'WORKER_PROJECT_CHANGED', disposition: 'indeterminate' });
    assert.equal(killed, false);
    fs.writeFileSync(ownerClosedPath, 'closed');
    await assert.rejects(createReadonlyWorker({ checkpointPath, workDir: root, ownerClosedPath,
        startWorker: async () => { throw new Error('must not start'); } }), { code: 'OWNER_CLOSED' });
});


test('a bookkeeping failure after spawn preserves the snapshot until normal worker exit', async (t) => {
    const { root, checkpointPath } = fixture(t);
    const child = { exitCode: null, signalCode: null };
    let config;
    let retainedBeforeExit = false;
    let forced = false;
    let published = false;
    await assert.rejects(createReadonlyWorker({ checkpointPath, workDir: root, pollMs: 1,
        failureCloseTimeoutMs: 100, onStarted: () => { published = true; },
        stopWorker: async () => { forced = true; }, startWorker: async ({ scriptPath }) => {
            config = configuration(scriptPath);
            setTimeout(() => {
                retainedBeforeExit = fs.existsSync(config.snapshotPath);
                assert.equal(fs.existsSync(path.join(config.root, 'stop.json')), true);
                child.exitCode = 0;
            }, 5);
            throw Object.assign(new Error('registration failed'), { launchedInstance: { pid: 321, process: child } });
        } }), /registration failed/);
    assert.equal(published, true);
    assert.equal(retainedBeforeExit, true);
    assert.equal(forced, false);
    assert.equal(fs.existsSync(config.snapshotPath), false);
});
