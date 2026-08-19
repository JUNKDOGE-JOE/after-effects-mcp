'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { SseWriter } = require('./sse');

function response() {
    const res = new EventEmitter();
    res.frames = [];
    res.writableEnded = false;
    res.status = function () { return res; };
    res.set = function () { return res; };
    res.flushHeaders = function () {};
    res.write = function (frame) { res.frames.push(frame); };
    res.end = function () { res.writableEnded = true; };
    return res;
}

test('SSE writer emits comments and incrementing JSON-RPC message frames', () => {
    const res = response();
    const writer = new SseWriter(res, { keepaliveMs: 60000 }).start();
    writer.send({ jsonrpc: '2.0', id: 1, result: {} });
    writer.send({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
    assert.equal(res.frames[0], ': keepalive\n\n');
    assert.match(res.frames[1], /^id: 1\nevent: message\ndata: /);
    assert.match(res.frames[2], /^id: 2\nevent: message\ndata: /);
    writer.close();
    assert.equal(res.writableEnded, true);
});
