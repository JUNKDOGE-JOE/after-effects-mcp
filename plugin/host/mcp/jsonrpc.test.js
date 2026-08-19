'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const rpc = require('./jsonrpc');

test('jsonrpc validates request shape and notification distinction', () => {
    const request = { jsonrpc: '2.0', id: 7, method: 'ping' };
    assert.equal(rpc.validateMessage(request), null);
    assert.equal(rpc.isNotification(request), false);
    assert.equal(rpc.result(request, {}).id, 7);
    assert.equal(rpc.isNotification({ jsonrpc: '2.0', method: 'ping' }), true);
    assert.equal(rpc.result({ jsonrpc: '2.0', method: 'ping' }, {}), null);
    assert.equal(rpc.isResponse({ jsonrpc: '2.0', id: 9, result: {} }), true);
    assert.equal(rpc.isResponse({ jsonrpc: '2.0', id: 9, result: {}, error: {} }), false);
    assert.match(rpc.validateMessage({ jsonrpc: '1.0', method: 'ping' }), /jsonrpc/);
    assert.match(rpc.validateMessage({ jsonrpc: '2.0', id: {}, method: 'ping' }), /id/);
});

test('jsonrpc errors reserve protocol codes for protocol failures', () => {
    assert.deepEqual(rpc.invalidParams({ id: 'a' }, 'bad').error, {
        code: -32602,
        message: 'Invalid params',
        data: 'bad',
    });
    assert.equal(rpc.methodNotFound({ id: 1 }).error.code, -32601);
    assert.equal(rpc.error(null, -32700, 'Parse error').id, null);
});
