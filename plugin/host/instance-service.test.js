'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { InstanceRegistry } = require('./instance-registry');
const { createInstanceService, PROJECT_READ, changesProject } = require('./instance-service');

function reply(value) { return { payload: { ok: true, result: JSON.stringify(value) } }; }
function context() { return { session: { id: 'shared-connection', clientName: 'test' }, policy: { approvalTier: null } }; }
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function fixture(t) {
    const base = path.resolve(os.tmpdir());
    const root = fs.mkdtempSync(path.join(base, 'ae-mcp-service-'));
    assert.equal(path.dirname(root), base);
    const alivePids = new Set([321, process.pid]);
    const registry = new InstanceRegistry({ root: path.join(root, 'instances'), isProcessAlive: pid => alivePids.has(pid) });
    const state = { projectPath: path.join(root, 'one.aep'), dirty: false, revision: 1, stop: null };
    fs.writeFileSync(state.projectPath, 'disposable test placeholder');
    const requests = [];
    const services = [];
    const closing = [];
    const unregister = registry.unregister.bind(registry);
    registry.unregister = (...args) => { const pending = unregister(...args); closing.push(pending); return pending; };
    let nextCepPid = 600;
    function open(instanceId) {
        const cepPid = ++nextCepPid;
        alivePids.add(cepPid);
        const service = createInstanceService({ registry, instanceId: instanceId || 'ae-test', aePid: 321,
            cepPid,
            workDir: root, launcher: {}, executeJsx: async (request) => {
                requests.push(request);
                if (request.code === PROJECT_READ) return reply({ projectPath: state.projectPath, dirty: state.dirty, revision: state.revision });
                assert.equal(request.client, 'instance-stop');
                return state.stop ? state.stop(request) : reply({ ok: true, stopRequested: true });
            } });
        services.push(service);
        return service;
    }
    t.after(async () => {
        await Promise.all(services.map((service) => service.markClosed('test-completed')));
        await Promise.all(closing);
        fs.rmSync(root, { recursive: true, force: true });
    });
    const service = open();
    await service.publish('http://127.0.0.1:11488/mcp');
    return { service, registry, state, requests, root, open, alivePids };
}

function bind(service, access) {
    return service.workspace('bind', { instance_id: service.instanceId, access }, context());
}
function route(service, binding, name, args, invoke) {
    return service.routeTool({ name, arguments: Object.assign({}, args, { context_id: binding.context_id }) }, context(), invoke || (async (value) => value));
}

test('publish reads the attached AE path and registers the actual endpoint and PID', async (t) => {
    const { service, registry, state, requests } = await fixture(t);
    const record = await registry.get(service.instanceId);
    assert.equal(record.projectPath, state.projectPath);
    assert.equal(record.pid, 321);
    assert.equal(record.endpoint, 'http://127.0.0.1:11488/mcp');
    assert.equal(record.state, 'running');
    assert.equal(requests[0].code, PROJECT_READ);
    assert.equal(await service.target({ project_path: state.projectPath }), service.instanceId);
});

test('a reader can explicitly take over writes without learning another chat handle', async t => {
    const { service } = await fixture(t);
    const old = await bind(service, 'write');
    const reader = await bind(service, 'read');
    await assert.rejects(service.workspace('transfer', { context_id: reader.context_id }, context()), { code: 'TRANSFER_CONFIRMATION_REQUIRED' });
    const transferred = await service.workspace('transfer', { context_id: reader.context_id, confirm: true }, context());
    assert.equal(transferred.context_id, reader.context_id);
    assert.equal(transferred.access, 'write');
    await assert.rejects(route(service, old, 'ae_exec', { code: 'ignored' }), { code: 'WORKSPACE_READONLY' });
    await service.workspace('release', { context_id: reader.context_id }, context());
    const acquired = await service.workspace('bind', { context_id: old.context_id, access: 'write' }, context());
    assert.equal(acquired.context_id, old.context_id);
    assert.equal(acquired.access, 'write');
});

test('explicit contexts isolate read and write rights even with the same client connection', async (t) => {
    const { service } = await fixture(t);
    const writer = await bind(service, 'write');
    const reader = await bind(service, 'read');
    assert.notEqual(writer.context_id, reader.context_id);
    assert.equal(writer.workspace_id, reader.workspace_id);
    const current = await route(service, reader, 'ae_read', { target: 'project' });
    assert.equal(current.contextId, reader.context_id);
    await assert.rejects(route(service, reader, 'ae_exec', { code: 'return 1;' }), { code: 'WORKSPACE_READONLY' });
    assert.equal((await route(service, writer, 'ae_exec', { code: 'return 1;' })).contextId, writer.context_id);
    await assert.rejects(bind(service, 'write'), { code: 'WORKSPACE_BUSY' });
    await service.workspace('transfer', { context_id: writer.context_id, target_context_id: reader.context_id }, context());
    await assert.rejects(route(service, writer, 'ae_exec', { code: 'return 1;' }), { code: 'WORKSPACE_READONLY' });
    assert.equal((await route(service, reader, 'ae_exec', { code: 'return 1;' })).contextId, reader.context_id);
});

test('a live project change invalidates old contexts and a new bind updates the registered workspace', async (t) => {
    const { service, registry, state, root } = await fixture(t);
    const old = await bind(service, 'write');
    state.projectPath = path.join(root, 'two.aep');
    await assert.rejects(route(service, old, 'ae_exec', {}, () => assert.fail('must not reach another project')), { code: 'SOURCE_PROJECT_CHANGED' });
    const next = await bind(service, 'write');
    assert.notEqual(next.workspace_id, old.workspace_id);
    assert.equal(next.project_path, state.projectPath);
    const record = await registry.get(service.instanceId);
    assert.equal(record.projectPath, state.projectPath);
    assert.equal(record.workspaceId, next.workspace_id);
    state.projectPath = undefined;
    await assert.rejects(route(service, next, 'ae_read', {}), { code: 'PROJECT_UNAVAILABLE' });
});

test('stop rejects newly arriving bindings and operations while its AE response is pending', async (t) => {
    const { service, registry, state } = await fixture(t);
    const reader = await bind(service, 'read');
    const started = deferred();
    const finish = deferred();
    state.stop = async () => { started.resolve(); await finish.promise; return reply({ ok: true, stopRequested: true }); };
    const stopping = service.instances('stop', { instance_id: service.instanceId });
    await started.promise;
    try {
        await assert.rejects(bind(service, 'read'), { code: 'WORKSPACE_CLOSED' });
        const refused = await route(service, reader, 'ae_read', {}, () => assert.fail('stop must block dispatch'));
        assert.equal(refused.result.structuredContent.code, 'OWNER_CLOSED');
    } finally { finish.resolve(); await stopping; }
    assert.equal(service.accepting(), false);
    assert.equal((await registry.get(service.instanceId)).state, 'closing');
});

test('a definite dirty-project refusal leaves the primary open and permits further work', async (t) => {
    const { service, registry, state } = await fixture(t);
    const reader = await bind(service, 'read');
    state.dirty = true;
    state.stop = () => reply({ ok: false, error: 'unsaved-changes' });
    const stopped = await service.instances('stop', { instance_id: service.instanceId, save_policy: 'refuse-dirty' });
    assert.equal(stopped.error, 'unsaved-changes');
    assert.equal(service.accepting(), true);
    assert.equal((await registry.get(service.instanceId)).state, 'running');
    assert.equal((await route(service, reader, 'ae_read', {})).contextId, reader.context_id);
    await bind(service, 'write');
});

test('a bind awaiting project discovery cannot acquire a writer after stop begins', async (t) => {
    const { service, registry, state } = await fixture(t);
    const lookupStarted = deferred();
    const finishLookup = deferred();
    const stopStarted = deferred();
    const finishStop = deferred();
    const list = registry.list.bind(registry);
    registry.list = async (...args) => {
        const records = await list(...args);
        lookupStarted.resolve(); await finishLookup.promise; return records;
    };
    const binding = service.workspace('bind', { project_path: state.projectPath, access: 'write' }, context());
    await lookupStarted.promise;
    state.stop = async () => { stopStarted.resolve(); await finishStop.promise; return reply({ ok: true, stopRequested: true }); };
    const stopping = service.instances('stop', { instance_id: service.instanceId });
    await stopStarted.promise;
    try {
        finishLookup.resolve();
        await assert.rejects(binding, { code: 'WORKSPACE_CLOSED' });
    } finally { finishLookup.resolve(); finishStop.resolve(); await stopping; }
});

test('reopening a disconnected panel on the same live AE replaces its identity without freeing the project', async (t) => {
    const { service, registry, open } = await fixture(t);
    await service.markClosed('panel-closed');
    assert.equal((await registry.get(service.instanceId)).state, 'unknown');
    const reopened = open(service.instanceId);
    assert.notEqual(reopened.instanceId, service.instanceId);
    await reopened.publish('http://127.0.0.1:11489/mcp');
    assert.equal((await registry.get(service.instanceId)).state, 'closed');
    assert.equal((await registry.get(reopened.instanceId)).state, 'running');
    assert.equal((await registry.list()).length, 1);
});

test('native primitive mutability grants read-only programs and blocks every write or unknown primitive', async (t) => {
    const { service } = await fixture(t);
    const reader = await bind(service, 'read');
    const reads = { operations: [{ op: 'project.items.list', args: { offset: 0, limit: 1 } }] };
    const writes = { operations: [{ op: 'composition.time.set', args: {} }] };
    assert.equal(changesProject('ae_nativeExec', reads), false);
    assert.equal(changesProject('ae_nativeExec', writes), true);
    assert.equal(changesProject('ae_nativeExec', { operations: [{ op: 'unknown' }] }), true);
    assert.equal(changesProject('ae_nativeExec', {}), true);
    assert.equal((await route(service, reader, 'ae_nativeExec', reads)).contextId, reader.context_id);
    await assert.rejects(route(service, reader, 'ae_nativeExec', writes), { code: 'WORKSPACE_READONLY' });
    const writer = await bind(service, 'write');
    assert.equal((await route(service, writer, 'ae_nativeExec', writes)).contextId, writer.context_id);
});

test('reconcile requires a same-context observation, explicit confirmation and an unchanged AE revision', async (t) => {
    const { service, state } = await fixture(t);
    const writer = await bind(service, 'write');
    const reader = await bind(service, 'read');
    await route(service, writer, 'ae_exec', {}, async () => ({ result: {
        structuredContent: { ok: false, disposition: 'uncertain' }, isError: true,
    } }));
    const reconcile = (observationId, confirm) => service.workspace('reconcile', {
        context_id: writer.context_id, observation_id: observationId, confirm,
    }, context());
    const observe = (binding, name) => route(service, binding, name || 'ae_read', {}, async () => ({
        result: { structuredContent: { ok: true, projectPath: state.projectPath }, content: [] },
    }));
    await assert.rejects(reconcile('invented', true), { code: 'RECONCILIATION_REQUIRED' });
    const other = await observe(reader);
    await assert.rejects(reconcile(other.result.structuredContent.observation_id, true), { code: 'RECONCILIATION_REQUIRED' });
    const observed = await observe(writer);
    const observationId = observed.result.structuredContent.observation_id;
    assert.match(observationId, /^obs_/);
    await assert.rejects(reconcile(observationId, false), { code: 'RECONCILIATION_REQUIRED' });
    state.revision += 1;
    await assert.rejects(reconcile(observationId, true), { code: 'OBSERVATION_STALE' });
    const fresh = await observe(writer, 'ae_previewFrame');
    const resolved = await reconcile(fresh.result.structuredContent.observation_id, true);
    assert.equal(resolved.resolved, true);
    assert.equal(service.workspaces.inspect().uncertain, null);
    assert.equal((await route(service, writer, 'ae_exec', {})).contextId, writer.context_id);
});

function liveProjectReader(projectPath) {
    const roots = new Set();
    let root = { id: 1 };
    roots.add(root);
    const app = { project: { rootFolder: root, file: projectPath ? { fsName: projectPath } : null,
        revision: 10, dirty: false } };
    const engine = vm.createContext({ app, $: { global: {} }, isValid: value => roots.has(value) });
    return {
        app,
        read: () => JSON.parse(vm.runInContext(PROJECT_READ, engine)),
        replace() {
            roots.delete(root);
            root = { id: 1 };
            roots.add(root);
            app.project = { rootFolder: root, file: projectPath ? { fsName: projectPath } : null,
                revision: 20, dirty: false };
        },
    };
}

test('the actual PROJECT_READ script preserves generation across ordinary revision increases', () => {
    const reader = liveProjectReader('C:/projects/saved.aep');
    const first = reader.read();
    reader.app.project.revision += 1;
    reader.app.project.dirty = true;
    const second = reader.read();
    assert.equal(second.projectGeneration, first.projectGeneration);
    assert.equal(second.revision, 11);
    assert.equal(second.projectPath, 'C:/projects/saved.aep');
    reader.app.project.revision = 1;
    assert.notEqual(reader.read().projectGeneration, second.projectGeneration);
});

test('the actual PROJECT_READ generation invalidates old contexts when untitled or same-path roots are replaced', async () => {
    const { WorkspaceManager } = require('./mcp/workspaces');
    for (const projectPath of [null, 'C:/projects/same.aep']) {
        const reader = liveProjectReader(projectPath);
        const manager = new WorkspaceManager({ instanceId: 'vm-ae', readProject: async () => reader.read() });
        const before = await manager.bind({ access: 'write', workDir: 'C:/work' });
        const generation = reader.read().projectGeneration;
        reader.replace();
        assert.notEqual(reader.read().projectGeneration, generation);
        await assert.rejects(manager.run(before.contextId, true, () => assert.fail('must not write the replacement project')),
            { code: 'SOURCE_PROJECT_CHANGED' });
        const after = await manager.bind({ access: 'write', workDir: 'C:/work' });
        assert.notEqual(after.workspaceId, before.workspaceId);
        assert.equal(after.projectPath, projectPath);
    }
});

test('cold startup cannot publish an unrelated project and only becomes ready after its requested project opens', async (t) => {
    const { service, registry, state, root, alivePids } = await fixture(t);
    await service.markClosed('test-replaced');
    alivePids.delete(321);
    assert.equal((await registry.get(service.instanceId)).state, 'closed');
    const expected = state.projectPath;
    let actual = path.join(root, 'wrong.aep');
    await registry.reserve({ instanceId: 'cold-ticket', projectPath: expected });
    const cold = createInstanceService({ instanceId: 'cold-ticket', projectPath: expected, registry, launcher: {},
        executeJsx: async () => reply({ projectPath: actual }) });
    try {
        await assert.rejects(cold.publish('http://127.0.0.1:11490/mcp'), { code: 'STARTUP_PROJECT_MISMATCH' });
        const refused = await registry.get('cold-ticket');
        assert.equal(refused.state, 'unknown');
        assert.equal(refused.projectPath, expected);
        assert.equal(refused.endpoint, null);
        actual = expected;
        await cold.publish('http://127.0.0.1:11490/mcp');
        assert.equal((await registry.get('cold-ticket')).state, 'running');
    } finally { await cold.markClosed('test-completed'); }
});

test('panel shutdown is idempotent and writes only its marker before a live caller reconciles the registry', async (t) => {
    const { service, registry, state } = await fixture(t);
    let closeJobs = 0;
    service.setJobs({ close: () => { closeJobs += 1; return Promise.resolve(); } });
    const first = service.markClosed('panel-closed');
    const second = service.markClosed('panel-stopped');
    assert.equal(first, second);
    await first;
    assert.equal(closeJobs, 1);
    assert.equal(JSON.parse(fs.readFileSync(service.ownerClosedPath, 'utf8')).reason, 'panel-closed');
    assert.equal(JSON.parse(fs.readFileSync(registry.file, 'utf8')).instances[0].state, 'running');
    assert.equal(fs.existsSync(registry.lock), false);
    assert.equal((await registry.get(service.instanceId)).state, 'unknown');
    await assert.rejects(registry.reserve({ projectPath: state.projectPath }), { code: 'PROJECT_OCCUPIED' });
});

test('manual reopen after CEP death keeps the AE and gives it fresh contexts without replay', async (t) => {
    const { service, registry, open, alivePids } = await fixture(t);
    const oldBinding = await bind(service, 'write');
    const old = await registry.get(service.instanceId);
    alivePids.delete(old.cepPid);
    assert.equal((await registry.get(service.instanceId)).state, 'unknown');
    const reopened = open(service.instanceId);
    assert.notEqual(reopened.instanceId, service.instanceId);
    await reopened.publish('http://127.0.0.1:11488/mcp');
    assert.equal((await registry.get(reopened.instanceId)).pid, old.pid);
    assert.throws(() => reopened.workspaces.getContext(oldBinding.context_id), { code: 'CONTEXT_NOT_FOUND' });
    assert.equal(reopened.workspaces.inspect().writerContextId, null);
    const fresh = await bind(reopened, 'write');
    assert.notEqual(fresh.context_id, oldBinding.context_id);
    assert.equal((await registry.list()).length, 1);
});

test('router refuses an unknown host and never reuses its cached downstream session', async () => {
    const { WorkspaceRouter } = require('./mcp/workspace-router');
    const record = { instanceId: 'ae', state: 'running', cepPid: 101, endpoint: 'http://127.0.0.1:11488/mcp' };
    const calls = [];
    let sessions = 0;
    const router = new WorkspaceRouter({ get: async () => ({ ...record }) }, {
        request: async (message, peer, output) => {
            calls.push({ method: message.method, sessionId: peer.sessionId });
            if (message.method === 'initialize') peer.sessionId = 'session-' + ++sessions;
            if (message.id !== undefined) output.write(JSON.stringify({ id: message.id, result: { ok: true } }));
        },
    });
    await router.call('ae', { name: 'ae_read' });
    record.state = 'unknown';
    const count = calls.length;
    await assert.rejects(router.call('ae', { name: 'ae_read' }), { code: 'INSTANCE_NOT_READY' });
    assert.equal(calls.length, count);
    record.state = 'running';
    record.cepPid = 102;
    await router.call('ae', { name: 'ae_read' });
    assert.equal(sessions, 2);
    assert.equal(calls.at(-1).sessionId, 'session-2');
});
