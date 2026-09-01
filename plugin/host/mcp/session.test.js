'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MAX_SESSIONS, SessionStore } = require('./session');

test('session store creates random session ids and tears down SSE writers', () => {
    const store = new SessionStore();
    const session = store.create('2025-06-18', 'cursor');
    assert.match(session.id, /^[0-9a-f]{32}$/);
    assert.equal(store.size, 1);
    let sent = null;
    let closed = 0;
    let onClose = null;
    const writer = {
        send: function (message) { sent = message; },
        close: function () { closed += 1; },
        onClose: function (fn) { onClose = fn; },
    };
    store.addWriter(session, writer);
    store.publish(session, { method: 'notifications/progress' });
    assert.deepEqual(sent, { method: 'notifications/progress' });
    assert.equal(store.delete(session.id), true);
    assert.equal(closed, 1);
    onClose();
    assert.equal(store.size, 0);
    assert.equal(store.delete(session.id), false);
});

test('session store evicts the least recently active session without a writer at capacity', () => {
    const store = new SessionStore();
    const oldest = store.create('2025-06-18', 'oldest');
    oldest.lastActivityAt = 1;
    for (let index = 1; index < MAX_SESSIONS; index += 1) {
        const session = store.create('2025-06-18', 'client-' + index);
        session.lastActivityAt = index + 1;
    }
    const replacement = store.create('2025-06-18', 'replacement');
    assert.equal(store.size, MAX_SESSIONS);
    assert.equal(store.get(oldest.id), null);
    assert.equal(store.get(replacement.id), replacement);
});

test('session store permits an additional session when every retained session has a writer', () => {
    const warnings = [];
    const store = new SessionStore({ logger: function (event) { warnings.push(event); } });
    for (let index = 0; index < MAX_SESSIONS; index += 1) {
        const session = store.create('2025-06-18', 'client-' + index);
        store.addWriter(session, { onClose: function () {}, close: function () {} });
    }
    store.create('2025-06-18', 'overflow');
    assert.equal(store.size, MAX_SESSIONS + 1);
    assert.deepEqual(warnings, [{
        level: 'warn',
        source: 'mcp-session-store',
        message: 'MCP session limit reached with active writers',
        maxSessions: MAX_SESSIONS,
    }]);
});
