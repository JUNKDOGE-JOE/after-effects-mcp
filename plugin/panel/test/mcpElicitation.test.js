import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _createRpc } from '../src/cep/mcpClient.js';

function makeRpc(onRequest) {
  const writes = [];
  let push;
  const rpc = _createRpc(
    (line) => writes.push(JSON.parse(line)),
    (handler) => { push = (message) => handler(JSON.stringify(message) + '\n'); },
    { timeoutMs: 1000, onRequest },
  );
  return { rpc, writes, push };
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('_createRpc answers an inbound elicitation request with exact JSON-RPC result', async () => {
  const seen = [];
  const io = makeRpc(async (request, { signal }) => {
    seen.push({ request, signal });
    return { action: 'accept', content: { decision: 'once' } };
  });
  io.push({
    jsonrpc: '2.0',
    id: 'server-1',
    method: 'elicitation/create',
    params: { message: 'Approve?', requestedSchema: { type: 'object' } },
  });
  await tick();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].request.method, 'elicitation/create');
  assert.equal(seen[0].signal.aborted, false);
  assert.deepEqual(io.writes, [{
    jsonrpc: '2.0',
    id: 'server-1',
    result: { action: 'accept', content: { decision: 'once' } },
  }]);
});

test('_createRpc does not confuse a same-id server request with an outbound response', async () => {
  const io = makeRpc(async () => ({ action: 'decline', content: {} }));
  const outbound = io.rpc.request('tools/list', {});
  assert.equal(io.writes[0].id, 1);
  io.push({ jsonrpc: '2.0', id: 1, method: 'elicitation/create', params: {} });
  await tick();
  assert.deepEqual(io.writes[1], {
    jsonrpc: '2.0', id: 1, result: { action: 'decline', content: {} },
  });
  io.push({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
  assert.deepEqual(await outbound, { tools: [] });
});

test('_createRpc returns method-not-found and never responds to notifications', async () => {
  const io = makeRpc(async (request) => {
    const error = new Error('unsupported');
    error.code = -32601;
    error.data = { method: request.method };
    throw error;
  });
  io.push({ jsonrpc: '2.0', method: 'notifications/progress', params: {} });
  io.push({ jsonrpc: '2.0', id: 9, method: 'unknown/request', params: {} });
  await tick();

  assert.deepEqual(io.writes, [{
    jsonrpc: '2.0',
    id: 9,
    error: { code: -32601, message: 'Method not found', data: { method: 'unknown/request' } },
  }]);
});

test('_createRpc cancellation notification aborts pending elicitation as cancel', async () => {
  let observedSignal;
  const io = makeRpc(async (_request, { signal }) => {
    observedSignal = signal;
    await new Promise(() => {});
  });
  io.push({ jsonrpc: '2.0', id: 7, method: 'elicitation/create', params: {} });
  await tick();
  io.push({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 7, reason: 'server cancelled' },
  });
  await tick();

  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(io.writes, [{
    jsonrpc: '2.0', id: 7, result: { action: 'cancel', content: {} },
  }]);
});

test('_createRpc close aborts every pending inbound request as cancel', async () => {
  const signals = [];
  const io = makeRpc(async (_request, { signal }) => {
    signals.push(signal);
    await new Promise(() => {});
  });
  io.push({ jsonrpc: '2.0', id: 10, method: 'elicitation/create', params: {} });
  io.push({ jsonrpc: '2.0', id: 11, method: 'elicitation/create', params: {} });
  await tick();
  io.rpc.close();
  await tick();

  assert.deepEqual(signals.map((signal) => signal.aborted), [true, true]);
  assert.deepEqual(io.writes, [
    { jsonrpc: '2.0', id: 10, result: { action: 'cancel', content: {} } },
    { jsonrpc: '2.0', id: 11, result: { action: 'cancel', content: {} } },
  ]);
});
