'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ConversationStore } = require('./conversations');
const { SessionStore } = require('./session');

test('conversations create, get, update, list, and close bound sessions and writers', () => {
    const sessions = new SessionStore();
    const conversations = new ConversationStore(sessions);
    const created = conversations.create({
        label: 'chat-3',
        policy: { approvalTier: 'manual', expertGuidance: false },
    });
    assert.match(created.id, /^[0-9a-f]{32}$/);
    assert.match(created.token, /^[0-9a-f]{48}$/);
    assert.equal(created.path, '/mcp/c/' + created.token);
    assert.deepEqual(conversations.get(created.token), created);
    assert.deepEqual(conversations.getById(created.id), created);
    assert.deepEqual(conversations.list(), [created]);

    const updated = conversations.update(created.id, {
        approvalTier: 'readonly', expertGuidance: true, label: 'renamed',
    });
    assert.deepEqual(updated.policy, {
        approvalTier: 'readonly', expertGuidance: true, label: 'renamed',
    });

    const session = sessions.create('2025-06-18', 'claude@chat-3', created.id);
    let closed = 0;
    sessions.addWriter(session, {
        send: function () {},
        close: function () { closed += 1; },
        onClose: function () {},
    });
    const external = sessions.create('2025-06-18', 'cursor', null);
    assert.equal(conversations.close(created.id), true);
    assert.equal(closed, 1);
    assert.equal(sessions.get(session.id), null);
    assert.equal(sessions.get(external.id), external);
    assert.equal(conversations.get(created.token), null);
    assert.equal(conversations.close(created.id), false);
});

test('conversations reject invalid policy tiers and labels', () => {
    const conversations = new ConversationStore(new SessionStore());
    assert.throws(function () { conversations.create({ label: '' }); }, /label/);
    assert.throws(function () {
        conversations.create({ label: 'chat', policy: { approvalTier: 'bogus' } });
    }, /approvalTier/);
    assert.throws(function () {
        conversations.create({ label: 'chat', policy: { expertGuidance: 'yes' } });
    }, /expertGuidance/);
});
