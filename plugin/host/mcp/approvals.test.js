'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ApprovalQueue } = require('./approvals');

function details() {
    return {
        conversationId: 'conversation-1',
        sessionId: 'session-1',
        tool: 'ae_exec',
        risk: 'destructive',
        summary: { code: '1 + 1', undo_group_name: 'test', checkpoint_label: null },
    };
}

test('approval request emits request and resolves accept', async () => {
    const approvals = new ApprovalQueue({ timeoutMs: 1000, now: function () { return 0; } });
    let emitted = null;
    approvals.on('request', function (item) { emitted = item; });
    const pending = approvals.request(details());
    assert.equal(approvals.list().length, 1);
    assert.equal(emitted.createdAt, '1970-01-01T00:00:00.000Z');
    assert.deepEqual(emitted.summary, details().summary);
    assert.equal(approvals.resolve(emitted.id, 'accept'), true);
    assert.equal(await pending, 'accept');
    assert.deepEqual(approvals.list(), []);
});

test('approval request resolves decline and rejects invalid resolutions', async () => {
    const approvals = new ApprovalQueue({ timeoutMs: 1000 });
    const pending = approvals.request(details());
    const id = approvals.list()[0].id;
    assert.equal(approvals.resolve(id, 'invalid'), false);
    assert.equal(approvals.resolve('missing', 'decline'), false);
    assert.equal(approvals.resolve(id, 'decline'), true);
    assert.equal(await pending, 'decline');
});

test('approval timeout is a decline', async () => {
    const approvals = new ApprovalQueue({ timeoutMs: 5 });
    const result = await approvals.request(details());
    assert.equal(result, 'decline');
    assert.deepEqual(approvals.list(), []);
});
