'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WorkspaceManager, contextInstanceId, createProjectRestoreGuard } = require('./workspaces');
const vm = require('node:vm');

function fixture(instanceId) {
    const project = { projectPath: 'C:/jobs/one.aep', projectGeneration: 1 };
    const manager = new WorkspaceManager({ instanceId: instanceId || 'ae-one', readProject: async () => ({ ...project }) });
    return { project, manager };
}
function bind(manager, access) { return manager.bind({ access: access || 'write', workDir: 'C:/work' }); }
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test('restore continuation only opens its exact unchanged empty project and updates the calling generation', async () => {
    for (const change of ['none', 'empty-project', 'edited-project', 'token']) {
        const guard = createProjectRestoreGuard();
        const app = { project: { file: { fsName: 'C:/one.aep' }, rootFolder: {}, revision: 1 } };
        const $ = { global: { __aemcpProjectSerial: 1, __aemcpObservedProject: { root: app.project.rootFolder, generation: 1 } } };
        const scope = vm.createContext({ app, $, isValid: root => root === app.project.rootFolder });
        const context = { contextId: 'bound', projectPath: 'C:/one.aep', projectGeneration: 1,
            acceptRestoredProject: value => value };
        const close = '(function(){app.project={file:null,rootFolder:{},numItems:0,dirty:false,revision:1};return JSON.stringify({ok:true,closed:true});}())';
        const open = '(function(){app.project={file:{fsName:"C:/one.aep"},rootFolder:{},revision:1};return JSON.stringify({ok:true,openedPath:"C:/one.aep"});}())';
        assert.throws(() => guard.wrap(open, 'open', context), /No completed project close/);
        vm.runInContext(guard.wrap(close, 'close', context), scope);
        if (change === 'empty-project') app.project.rootFolder = {};
        if (change === 'edited-project') app.project.dirty = true;
        if (change === 'token') $.global.__aemcpRestore.token = 'other';
        if (change !== 'none') {
            assert.throws(() => vm.runInContext(guard.wrap(open, 'open', context), scope), /SOURCE_PROJECT_CHANGED/);
            continue;
        }
        const result = vm.runInContext(guard.wrap(open, 'open', context), scope);
        await guard.accept({ payload: { ok: true, result } }, 'open', context);
        assert.equal(context.projectGeneration, 2);
        assert.equal(vm.runInContext(guard.wrap('42', null, context), scope), 42);
        assert.throws(() => guard.wrap(open, 'open', context), /No completed project close/);
    }
});

test('confirmed restore rebinds only the executing writer while its panel turn retains ownership', async () => {
    const { manager, project } = fixture();
    const writer = await bind(manager), stale = await bind(manager);
    const activity = { ownerId: 'panel', turnId: 'turn', managedTurns: true };
    await manager.startTurn(writer.contextId, 'panel', 'turn');
    assert.throws(() => manager.acceptRestoredProject(writer.contextId, { ...project, projectGeneration: 2 }), /executing writer/);
    await manager.run(writer.contextId, true, async () => {
        project.projectGeneration = 2;
        const restored = manager.acceptRestoredProject(writer.contextId, project);
        assert.notEqual(restored.workspaceId, writer.workspaceId);
        assert.equal(manager.inspect().activeTurn.turnId, 'turn');
    }, activity);
    assert.equal(await manager.run(writer.contextId, true, current => current.projectGeneration, activity), 2);
    await assert.rejects(manager.run(stale.contextId, false, () => assert.fail()), { code: 'SOURCE_PROJECT_CHANGED' });
    const next = await bind(manager);
    await assert.rejects(manager.run(next.contextId, true, () => assert.fail()), { code: 'WORKSPACE_BUSY' });
    manager.endTurn('panel', 'turn');
    assert.equal(await manager.run(next.contextId, true, () => 'handoff'), 'handoff');
});

test('workspace, instance and context identities stay distinct and explicit context reuse keeps ownership', async () => {
    const { manager } = fixture();
    const writer = await bind(manager);
    const reader = await bind(manager, 'read');
    assert.equal(contextInstanceId(writer.contextId), 'ae-one');
    assert.equal(contextInstanceId('ae-one:invented'), null);
    assert.notEqual(writer.workspaceId, writer.instanceId);
    assert.notEqual(writer.contextId, writer.workspaceId);
    assert.equal((await bind(manager)).access, 'write');
    assert.equal(manager.inspect().writerContextId, null);
    assert.deepEqual(await manager.bind({ access: 'write', contextId: writer.contextId }), writer);
    await assert.rejects(manager.bind({ access: 'write', contextId: 'ae-one:' + 'a'.repeat(32) }), { code: 'CONTEXT_NOT_FOUND' });
    await assert.rejects(manager.run(reader.contextId, true, () => assert.fail('must not dispatch')), { code: 'WORKSPACE_READONLY' });
    await assert.rejects(manager.run(null, false, () => assert.fail('must not guess')), { code: 'WORKSPACE_REQUIRED' });
    assert.throws(() => manager.getContext(), { code: 'WORKSPACE_REQUIRED' });
});

test('explicit transfer revokes the former writer and release does not close the host', async () => {
    const { manager } = fixture();
    const writer = await bind(manager);
    const reader = await bind(manager, 'read');
    const next = await manager.transfer(writer.contextId, reader.contextId);
    assert.equal(next.access, 'write');
    assert.equal(manager.getContext(writer.contextId).access, 'read');
    await assert.rejects(manager.assertContext(writer.contextId, true), { code: 'WORKSPACE_READONLY' });
    assert.equal(await manager.run(reader.contextId, true, () => 'written'), 'written');
    await manager.release(reader.contextId);
    assert.equal(manager.inspect().closed, false);
    assert.equal(manager.inspect().writerContextId, null);
    await bind(manager);
});

test('project path and supplied generation changes invalidate every old binding', async () => {
    const { manager, project } = fixture();
    const first = await bind(manager);
    project.projectPath = 'C:/jobs/two.aep';
    await assert.rejects(manager.run(first.contextId, true, () => assert.fail('wrong project')), { code: 'SOURCE_PROJECT_CHANGED' });
    const second = await bind(manager);
    assert.notEqual(second.workspaceId, first.workspaceId);
    project.projectGeneration += 1;
    await assert.rejects(manager.assertContext(second.contextId), { code: 'SOURCE_PROJECT_CHANGED' });
    await assert.rejects(manager.bind({ access: 'read', projectPath: 'C:/other.aep', workDir: 'C:/work' }), { code: 'SOURCE_PROJECT_CHANGED' });
    assert.equal((await manager.bind({ access: 'read', workDir: null })).workDir, null);
    await assert.rejects(manager.bind({ access: 'read', workDir: 'relative' }), { code: 'INVALID_PATH' });
});

test('inflight and queued work prevent handoff while status queries remain immediate', async () => {
    const { manager } = fixture();
    const writer = await bind(manager);
    const reader = await bind(manager, 'read');
    const started = deferred();
    const finish = deferred();
    const order = [];
    const first = manager.run(writer.contextId, true, async () => {
        order.push('first-start'); started.resolve(); await finish.promise; order.push('first-end');
    });
    await started.promise;
    const second = manager.run(writer.contextId, true, () => order.push('second'));
    assert.equal(manager.inspect().pending, 2);
    assert.equal(manager.getContext(reader.contextId).access, 'read');
    await assert.rejects(manager.transfer(writer.contextId, reader.contextId), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(manager.release(writer.contextId), { code: 'WORKSPACE_BUSY' });
    finish.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
    await manager.transfer(writer.contextId, reader.contextId);
});

test('different managers perform work concurrently with no global AE lock', async () => {
    const first = fixture('ae-first').manager;
    const second = fixture('ae-second').manager;
    const a = await bind(first);
    const b = await bind(second);
    const running = deferred();
    const finish = deferred();
    const pending = first.run(a.contextId, true, async () => { running.resolve(); await finish.promise; });
    await running.promise;
    try {
        assert.equal(await second.run(b.contextId, true, () => 'parallel'), 'parallel');
        assert.equal(first.inspect().inflight, true);
    } finally { finish.resolve(); await pending; }
});

test('uncertain writes survive reconnect-like reuse and require evidence from their owner', async () => {
    const { manager } = fixture();
    const writer = await bind(manager);
    const reader = await bind(manager, 'read');
    const result = { result: { structuredContent: { disposition: 'indeterminate' } } };
    assert.equal(await manager.run(writer.contextId, true, () => result), result);
    await assert.rejects(manager.bind({ access: 'write', contextId: writer.contextId }), { code: 'RESULT_UNKNOWN' });
    await assert.rejects(manager.transfer(writer.contextId, reader.contextId), { code: 'RESULT_UNKNOWN' });
    await assert.rejects(manager.release(writer.contextId), { code: 'RESULT_UNKNOWN' });
    assert.equal(await manager.run(reader.contextId, false, () => 'read-back'), 'read-back');
    await assert.rejects(manager.reconcile(writer.contextId, { resolved: true }), { code: 'RECONCILIATION_REQUIRED' });
    await assert.rejects(manager.reconcile(reader.contextId, { resolved: true, evidenceId: 'state-1' }), { code: 'CONTEXT_CONFLICT' });
    await manager.reconcile(writer.contextId, { resolved: true, evidenceId: 'state-1' });
    await manager.transfer(writer.contextId, reader.contextId);
});

test('thrown uncertain outcomes lock writes; ordinary validation errors do not', async () => {
    const { manager } = fixture();
    const writer = await bind(manager);
    await assert.rejects(manager.run(writer.contextId, true, () => { throw new Error('invalid input'); }), /invalid input/);
    assert.equal(manager.inspect().uncertain, null);
    await assert.rejects(manager.run(writer.contextId, true, () => {
        throw Object.assign(new Error('dispatch disconnected'), { code: 'POSSIBLY_SIDE_EFFECTING_FAILURE' });
    }), { code: 'POSSIBLY_SIDE_EFFECTING_FAILURE' });
    assert.equal(manager.inspect().uncertain.contextId, writer.contextId);
    manager.close();
    await assert.rejects(manager.run(writer.contextId, false, () => {}), { code: 'WORKSPACE_CLOSED' });
});

test('existing JSX and native failure envelopes preserve uncertainty without locking not-dispatched failures', async () => {
    for (const result of [
        { payload: { ok: false }, disposition: 'uncertain' },
        { result: { structuredContent: { ok: false, error: { sideEffect: 'may-have-occurred' } } } },
    ]) {
        const { manager } = fixture();
        const writer = await manager.bind({ access: 'write', workDir: null });
        await manager.run(writer.contextId, true, () => ({ payload: { ok: false }, disposition: 'not_dispatched' }));
        assert.equal(manager.inspect().uncertain, null);
        await manager.run(writer.contextId, true, () => result);
        assert.equal(manager.inspect().uncertain.contextId, writer.contextId);
    }
});

test('the original uncertain owner can reconcile an observed project switch but its old binding stays invalid', async () => {
    const { manager, project } = fixture();
    const writer = await bind(manager);
    manager.markUncertain(writer.contextId, { reason: 'dispatch timed out' });
    project.projectPath = 'C:/jobs/two.aep';
    await manager.reconcile(writer.contextId, { resolved: true, evidenceId: 'audit-and-state-2' });
    assert.equal(manager.inspect().uncertain, null);
    assert.throws(() => manager.getContext(writer.contextId), { code: 'SOURCE_PROJECT_CHANGED' });
    const next = await bind(manager);
    assert.equal(next.projectPath, project.projectPath);
});

test('panel turns retain ownership between calls and only their matching end permits another owner', async () => {
    const { manager } = fixture();
    const a = await bind(manager);
    const explicit = await bind(manager);
    const b = await bind(manager);
    const activity = { ownerId: 'chat-a', turnId: 'turn-1', managedTurns: true };
    await manager.startTurn(a.contextId, 'chat-a', 'turn-1');
    await manager.run(explicit.contextId, true, () => 'same conversation', activity);
    await assert.rejects(manager.run(b.contextId, true, () => assert.fail()), { code: 'WORKSPACE_BUSY' });
    await assert.rejects(manager.transfer(a.contextId, b.contextId), { code: 'WORKSPACE_BUSY' });
    assert.equal(manager.endTurn('chat-a', 'wrong-turn'), false);
    assert.equal(manager.inspect().activeTurn.turnId, 'turn-1');
    manager.endTurn('chat-a', 'turn-1');
    assert.equal(manager.inspect().writerContextId, null);
    await manager.startTurn(b.contextId, 'chat-b', 'turn-2');
    assert.equal(manager.endTurn('chat-a', 'turn-1'), false);
    await assert.rejects(manager.run(a.contextId, true, () => assert.fail(), activity), { code: 'TURN_INACTIVE' });
    manager.endTurn('chat-b', 'turn-2');
    assert.equal(await manager.run(a.contextId, true, () => 'external call'), 'external call');
    assert.equal(manager.inspect().writerContextId, null);
});

test('turn end cannot release pending writes, stale queued calls, draining engines or uncertain results', async () => {
    const { manager } = fixture();
    const a = await bind(manager);
    const b = await bind(manager);
    const started = deferred(), finish = deferred();
    const activity = { ownerId: 'chat', turnId: 'turn', managedTurns: true };
    await manager.startTurn(a.contextId, 'chat', 'turn');
    const first = manager.run(a.contextId, true, async () => { started.resolve(); await finish.promise; }, activity);
    await started.promise;
    const queued = manager.run(a.contextId, true, () => assert.fail('ended turn must not dispatch'), activity);
    const rejected = assert.rejects(queued, { code: 'TURN_INACTIVE' });
    manager.endTurn('chat', 'turn');
    assert.equal(manager.inspect().writerContextId, a.contextId);
    await assert.rejects(manager.startTurn(b.contextId, 'other', 'next'), { code: 'WORKSPACE_BUSY' });
    finish.resolve();
    await Promise.all([first, rejected]);
    let draining = true;
    manager.isDraining = () => draining;
    await assert.rejects(manager.run(b.contextId, true, () => assert.fail()), { code: 'WORKSPACE_BUSY' });
    draining = false;
    await manager.startTurn(a.contextId, 'chat', 'next');
    await manager.run(a.contextId, true, () => ({ disposition: 'uncertain' }), { ownerId: 'chat' });
    manager.endTurn('chat', 'next');
    assert.equal(manager.inspect().writerContextId, a.contextId);
    await assert.rejects(manager.run(b.contextId, true, () => assert.fail()), { code: 'RESULT_UNKNOWN' });
    await manager.reconcile(a.contextId, { resolved: true, evidenceId: 'verified' });
    assert.equal(manager.inspect().writerContextId, null);
    await manager.run(b.contextId, true, () => 'safe takeover');
});
