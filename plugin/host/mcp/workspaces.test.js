'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WorkspaceManager, contextInstanceId } = require('./workspaces');

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

test('workspace, instance and context identities stay distinct and explicit context reuse keeps ownership', async () => {
    const { manager } = fixture();
    const writer = await bind(manager);
    const reader = await bind(manager, 'read');
    assert.equal(contextInstanceId(writer.contextId), 'ae-one');
    assert.equal(contextInstanceId('ae-one:invented'), null);
    assert.notEqual(writer.workspaceId, writer.instanceId);
    assert.notEqual(writer.contextId, writer.workspaceId);
    await assert.rejects(bind(manager), { code: 'WORKSPACE_BUSY' });
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
