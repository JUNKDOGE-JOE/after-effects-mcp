'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SessionStore } = require('./session');

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
