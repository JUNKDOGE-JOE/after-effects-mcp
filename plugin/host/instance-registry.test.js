'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

test('worker admission reserves startup headroom without refusing bookkeeping for an already running worker', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-memory-budget-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    const gib = 1024 * 1024 * 1024;
    let free = 5 * gib;
    const registry = new InstanceRegistry({ root, memoryAvailable: () => free, minFreeMemoryBytes: 2 * gib,
        workerEstimateBytes: gib, isProcessAlive: () => true });
    await registry.reserve({ instanceId: 'worker-a', role: 'worker' });
    free = 3 * gib;
    await assert.rejects(registry.reserve({ instanceId: 'worker-b', role: 'worker' }), error => error.code === 'INSTANCE_BUDGET');
    free = gib;
    await registry.register({ instanceId: 'worker-a', role: 'worker', pid: 42 });
    assert.equal((await registry.get('worker-a')).state, 'running');
});
const { InstanceRegistry, normalizeProjectPath } = require('./instance-registry');

function temporary(t) {
    const base = path.resolve(os.tmpdir());
    const root = fs.mkdtempSync(path.join(base, 'ae-mcp-instances-'));
    assert.equal(path.dirname(root), base);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('project keys normalize Windows spelling and reject an inherited relative cwd', () => {
    assert.equal(normalizeProjectPath('C:/Jobs/One.aep'), normalizeProjectPath('c:\\jobs\\ONE.aep'));
    assert.equal(normalizeProjectPath('\\\\HOST\\share\\p.aep'), normalizeProjectPath('//host/share/P.aep'));
    assert.equal(normalizeProjectPath(null), null);
    assert.throws(() => normalizeProjectPath('relative.aep'), { code: 'INVALID_PATH' });
    assert.throws(() => normalizeProjectPath('C:relative.aep'), { code: 'INVALID_PATH' });
});

test('real filesystem reservations exclude the same project across registry objects', async (t) => {
    const root = temporary(t);
    const first = new InstanceRegistry({ root, isProcessAlive: () => true });
    const second = new InstanceRegistry({ root, isProcessAlive: () => true });
    const results = await Promise.allSettled([
        first.reserve({ instanceId: 'one', projectPath: 'C:/jobs/one.aep' }),
        second.reserve({ instanceId: 'two', projectPath: 'c:\\JOBS\\ONE.aep' }),
    ]);
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'PROJECT_OCCUPIED');
    const [record] = await second.list();
    assert.equal(record.state, 'starting');
    const running = await first.register({ instanceId: record.instanceId, endpoint: 'http://127.0.0.1:11489/mcp', pid: 123 });
    assert.equal(running.state, 'running');
    assert.equal((await second.get(record.instanceId)).endpoint, running.endpoint);
});

test('starting, running, closing and unknown all retain resource slots until explicit close', async (t) => {
    const registry = new InstanceRegistry({ root: temporary(t), maxInstances: 2, maxWorkers: 1, isProcessAlive: () => true });
    await registry.reserve({ instanceId: 'primary', projectPath: 'C:/one.aep' });
    await registry.reserve({ instanceId: 'worker', role: 'worker', ownerInstanceId: 'primary' });
    await assert.rejects(registry.reserve({ role: 'worker' }), { code: 'INSTANCE_BUDGET' });
    await registry.register({ instanceId: 'worker', pid: 42 });
    for (const state of ['closing', 'unknown']) {
        await registry.update('worker', { state });
        await assert.rejects(registry.reserve({ role: 'worker' }), { code: 'INSTANCE_BUDGET' });
    }
    await registry.unregister('worker', 'task-completed');
    await registry.unregister('worker', 'second-close');
    assert.equal((await registry.get('worker')).reason, 'task-completed');
    assert.equal((await registry.list()).length, 1);
    assert.equal((await registry.list({ includeClosed: true })).length, 2);
    await assert.rejects(registry.register({ instanceId: 'worker' }), { code: 'INSTANCE_CLOSED' });
    await registry.reserve({ instanceId: 'replacement', role: 'worker' });
});

test('project reassignment is atomic and an old lock is never broken by timestamp', async (t) => {
    const root = temporary(t);
    const registry = new InstanceRegistry({ root, lockTimeoutMs: 20 });
    await registry.reserve({ instanceId: 'one', projectPath: 'C:/one.aep' });
    await registry.reserve({ instanceId: 'two', projectPath: 'C:/two.aep' });
    await assert.rejects(registry.update('two', { projectPath: 'C:/one.aep' }), { code: 'PROJECT_OCCUPIED' });
    assert.equal((await registry.get('two')).projectPath, 'C:/two.aep');
    fs.writeFileSync(registry.lock, 'occupied');
    fs.utimesSync(registry.lock, new Date(0), new Date(0));
    await assert.rejects(registry.reserve({}), { code: 'REGISTRY_BUSY' });
    assert.equal(fs.readFileSync(registry.lock, 'utf8'), 'occupied');
});

test('two separate Node processes cannot reserve one project twice', async (t) => {
    const root = temporary(t);
    const gate = path.join(root, 'start');
    const source = `
        const fs = require('fs');
        const { InstanceRegistry } = require(process.argv[1]);
        process.stdout.write('ready\\n');
        (async () => {
            while (!fs.existsSync(process.argv[3])) await new Promise(r => setTimeout(r, 5));
            try {
                const value = await new InstanceRegistry({root: process.argv[2]}).reserve({projectPath:'C:/same.aep'});
                process.stdout.write(JSON.stringify({ok:true,id:value.instanceId})+'\\n');
            } catch(e) { process.stdout.write(JSON.stringify({ok:false,code:e.code})+'\\n'); }
        })().catch(e => { process.stderr.write(String(e)); process.exitCode=1; });`;
    function child() {
        const process = spawn(global.process.execPath, ['-e', source, require.resolve('./instance-registry'), root, gate]);
        let readyResolve;
        const ready = new Promise((resolve) => { readyResolve = resolve; });
        const result = new Promise((resolve, reject) => {
            let buffer = '';
            let value;
            process.stdout.on('data', (chunk) => {
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop();
                lines.forEach((line) => { if (line === 'ready') readyResolve(); else if (line) value = JSON.parse(line); });
            });
            process.on('error', reject);
            process.on('exit', (code) => { if (code) reject(new Error('child exited ' + code)); else resolve(value); });
        });
        return { ready, result };
    }
    const children = [child(), child()];
    await Promise.all(children.map((item) => item.ready));
    fs.writeFileSync(gate, 'go');
    const results = await Promise.all(children.map((item) => item.result));
    assert.equal(results.filter((item) => item.ok).length, 1);
    assert.equal(results.find((item) => !item.ok).code, 'PROJECT_OCCUPIED');
});

test('a dead CEP keeps its live AE project and resource slot until the AE process exits', async (t) => {
    const root = temporary(t);
    const live = new Set([1001, 2001]);
    const registry = new InstanceRegistry({ root, maxInstances: 1, isProcessAlive: pid => live.has(pid) });
    await registry.register({ instanceId: 'main', pid: 1001, cepPid: 2001, projectPath: 'C:/one.aep', endpoint: 'http://127.0.0.1:11488/mcp' });
    live.delete(2001);
    const [disconnected] = await registry.list();
    assert.equal(disconnected.state, 'unknown');
    assert.equal(disconnected.pid, 1001);
    assert.equal(disconnected.reason, 'panel-host-exited');
    assert.equal(fs.existsSync(path.join(root, 'main.closed')), true);
    await assert.rejects(registry.reserve({ projectPath: 'C:/one.aep' }), { code: 'PROJECT_OCCUPIED' });
    await assert.rejects(registry.reserve({ projectPath: 'C:/two.aep' }), { code: 'INSTANCE_BUDGET' });
    live.delete(1001);
    assert.equal((await registry.get('main')).state, 'closed');
    assert.equal((await registry.reserve({ projectPath: 'C:/one.aep' })).state, 'starting');
});

test('unknown PID probes and starting reservations never imply a released owner', async (t) => {
    const registry = new InstanceRegistry({ root: temporary(t), isProcessAlive: () => null });
    await registry.reserve({ instanceId: 'starting', projectPath: 'C:/one.aep' });
    assert.equal((await registry.get('starting')).state, 'starting');
    await registry.register({ instanceId: 'unidentified', pid: null, cepPid: null, projectPath: 'C:/two.aep' });
    await registry.register({ instanceId: 'inaccessible', pid: 901, cepPid: 902, projectPath: 'C:/three.aep' });
    assert.equal((await registry.get('unidentified')).state, 'running');
    assert.equal((await registry.get('inaccessible')).state, 'running');
    await assert.rejects(registry.reserve({ projectPath: 'C:/two.aep' }), { code: 'PROJECT_OCCUPIED' });
    assert.equal((await registry.register({ instanceId: 'starting', pid: 903, cepPid: 904 })).state, 'running');
});

test('only one new panel can atomically replace the dead host of the same AE', async (t) => {
    const live = new Set([1001, 2001, 2002, 2003]);
    const registry = new InstanceRegistry({ root: temporary(t), maxInstances: 1, isProcessAlive: pid => live.has(pid) });
    await registry.register({ instanceId: 'old', pid: 1001, cepPid: 2001, projectPath: 'C:/one.aep' });
    await assert.rejects(registry.register({ instanceId: 'premature', replacesInstanceId: 'old', pid: 1001, cepPid: 2002, projectPath: 'C:/one.aep' }),
        { code: 'REATTACH_REFUSED' });
    live.delete(2001);
    const results = await Promise.allSettled(['fresh-a', 'fresh-b'].map((instanceId, i) => registry.register({
        instanceId, replacesInstanceId: 'old', pid: 1001, cepPid: 2002 + i, projectPath: 'C:/one.aep',
    })));
    assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(results.find(value => value.status === 'rejected').reason.code, 'REATTACH_REFUSED');
    const [current] = await registry.list();
    assert.equal(current.state, 'running');
    assert.equal(current.pid, 1001);
    assert.equal((await registry.get('old')).replacedByInstanceId, current.instanceId);
    await assert.rejects(registry.reserve({ projectPath: 'C:/one.aep' }), { code: 'PROJECT_OCCUPIED' });
});

test('reattachment never replaces a different AE and dead workers release only their own slots', async (t) => {
    const live = new Set([1001, 1002, 2001, 2002, 3001]);
    const registry = new InstanceRegistry({ root: temporary(t), isProcessAlive: pid => live.has(pid) });
    await registry.register({ instanceId: 'main', pid: 1001, cepPid: 2001, projectPath: 'C:/one.aep' });
    await registry.register({ instanceId: 'worker', role: 'worker', pid: 3001, ownerInstanceId: 'main' });
    live.delete(2001);
    await assert.rejects(registry.register({ instanceId: 'wrong-ae', replacesInstanceId: 'main', pid: 1002, cepPid: 2002 }),
        { code: 'REATTACH_REFUSED' });
    assert.equal((await registry.get('worker')).state, 'running');
    live.delete(3001);
    assert.equal((await registry.get('worker')).state, 'closed');
    assert.equal((await registry.get('main')).state, 'unknown');
});

test('registry mutations release their lock before yielding to queued teardown work', async (t) => {
    const registry = new InstanceRegistry({ root: temporary(t), isProcessAlive: () => true });
    let lockSeen;
    await registry._mutate(records => {
        queueMicrotask(() => { lockSeen = fs.existsSync(registry.lock); });
        return records;
    });
    assert.equal(lockSeen, false);
    await assert.rejects(registry._mutate(() => { throw new Error('mutation failed'); }), /mutation failed/);
    assert.equal(fs.existsSync(registry.lock), false);
});

const { darwinMemorySample } = require('./instance-registry');
function memoryProbe(overrides = {}) {
    const page = overrides.page || 16384;
    const text = overrides.text === undefined ? `Mach Virtual Memory Statistics: (page size of ${page} bytes)\nPages free: 65536.\nPages purgeable: 131072.\nPages inactive: 999999.\nPages speculative: 999999.\nPages occupied by compressor: 999999.\n` : overrides.text;
    const calls = [];
    let tick = 0, pressure = 0;
    const sample = darwinMemorySample({
        now: () => tick++ ? (overrides.elapsed === undefined ? 300 : overrides.elapsed) : 0,
        freeMemory: () => overrides.free === undefined ? 1024 ** 3 : overrides.free,
        totalMemory: () => 16 * 1024 ** 3,
        run: (file, args, options) => {
            calls.push({ file, args, options });
            if (overrides.error) throw Object.assign(new Error('private output'), { code: overrides.error });
            return file === '/usr/bin/vm_stat' ? text : (overrides.pressures || ['1', '1'])[pressure++];
        }
    });
    return { sample, calls };
}

test('Darwin counts only free plus purgeable with bounded fixed commands and normal pressure', () => {
    const { sample, calls } = memoryProbe();
    assert.equal(sample.availableBytes, 3 * 1024 ** 3);
    assert.equal(sample.freeBytes, 1024 ** 3);
    assert.equal(sample.purgeableBytes, 2 * 1024 ** 3);
    assert.equal(sample.reason, undefined);
    assert.deepEqual(calls.map(c => c.file), ['/usr/sbin/sysctl', '/usr/bin/vm_stat', '/usr/sbin/sysctl']);
    assert.deepEqual(calls[0].args, ['-n', 'kern.memorystatus_vm_pressure_level']);
    for (const c of calls) {
        assert.equal(c.options.timeout, 200); assert.equal(c.options.maxBuffer, 16384);
        assert.equal(c.options.env.LC_ALL, 'C'); assert.equal(c.options.shell, undefined);
    }
    assert.equal(memoryProbe({ page: 4096 }).sample.availableBytes, 0.75 * 1024 ** 3);
    assert.equal(memoryProbe({ free: 512 * 1024 ** 2 }).sample.availableBytes, 2.5 * 1024 ** 3);
});

test('Darwin denies pressure changes, unknown pressure, stale samples and query failures', () => {
    for (const pressures of [['2', '1'], ['4', '1'], ['0', '1'], ['1', '2'], ['1', '4'], ['1', 'unknown']]) {
        const s = memoryProbe({ pressures }).sample;
        assert.equal(s.availableBytes, 0); assert.equal(s.reason, 'pressure-not-normal');
    }
    for (const elapsed of [751, -1, NaN, Infinity]) {
        assert.equal(memoryProbe({ elapsed }).sample.reason, 'stale-memory-sample');
    }
    assert.equal(memoryProbe({ elapsed: 750 }).sample.availableBytes, 3 * 1024 ** 3);
    for (const error of ['EACCES', 'ENOENT', 'ETIMEDOUT']) {
        const s = memoryProbe({ error }).sample;
        assert.equal(s.availableBytes, 0); assert.equal(s.reason, 'memory-query-failed');
        assert.ok(!JSON.stringify(s).includes('private output'));
    }
});

test('Darwin rejects malformed, duplicated, unsafe and unsupported memory counts', () => {
    const valid = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\nPages purgeable: 131072.\n';
    for (const text of ['', valid.replace('Pages free:', 'Other:'), valid + 'Pages free: 1.\n',
        valid.replace('65536', '-1'), valid.replace('65536', 'NaN'), valid.replace('65536', '9007199254740992'),
        valid.replace('131072', '1048576'), valid.replace('16384', '8192')]) {
        const s = memoryProbe({ text }).sample; assert.equal(s.availableBytes, 0); assert.ok(s.reason);
    }
    for (const free of [NaN, Infinity, -1, 32 * 1024 ** 3]) {
        assert.equal(memoryProbe({ free }).sample.reason, 'invalid-memory-count');
    }
});

test('Darwin measured headroom retains atomic startup reservations and existing worker bookkeeping', async t => {
    const gib = 1024 ** 3;
    let sample = memoryProbe().sample;
    const registry = new InstanceRegistry({ root: temporary(t), minFreeMemoryBytes: 2 * gib,
        workerEstimateBytes: gib, memoryAvailable: () => sample, isProcessAlive: () => true });
    const results = await Promise.allSettled([registry.reserve({ instanceId: 'a', role: 'worker' }),
        registry.reserve({ instanceId: 'b', role: 'worker' })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const refusal = results.find(r => r.status === 'rejected').reason;
    assert.equal(refusal.code, 'INSTANCE_BUDGET');
    assert.ok(refusal.message.includes('"requiredBytes":4294967296'));
    const winner = results.find(r => r.status === 'fulfilled').value;
    sample = { availableBytes: 0, reason: 'memory-query-failed' };
    await registry.register({ instanceId: winner.instanceId, pid: 42 });
    await registry.unregister(winner.instanceId);
    sample = { availableBytes: 3 * gib - 1 };
    await assert.rejects(registry.reserve({ role: 'worker' }), { code: 'INSTANCE_BUDGET' });
    sample = { availableBytes: 4 * gib, reason: 'stale-memory-sample' };
    await assert.rejects(registry.reserve({ role: 'worker' }), { code: 'INSTANCE_BUDGET' });
});
