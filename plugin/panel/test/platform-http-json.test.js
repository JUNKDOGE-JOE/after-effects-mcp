import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHttpJsonRequester } from '../src/cep/platform/http-json.js';

function transport(step, calls) {
  return { request(url, options, onResponse) {
    calls.push({ url: url.toString(), options });
    const requestListeners = {};
    const req = {
      on(event, handler) { requestListeners[event] = handler; return req; },
      setTimeout(_ms, handler) { req.timeout = handler; return req; },
      destroy(error) { requestListeners.error?.(error); },
      end() {
        queueMicrotask(() => {
          if (step === 'timeout') return req.timeout();
          if (step instanceof Error) return requestListeners.error?.(step);
          const res = new EventEmitter();
          res.statusCode = step.status;
          res.setEncoding = () => {};
          onResponse(res);
          res.emit('data', step.body);
          if (step.responseError) res.emit('error', step.responseError);
          else res.emit('end');
        });
      },
    };
    return req;
  } };
}

test('requestJson selects HTTPS and parses JSON without hiding HTTP status', async () => {
  const httpCalls = [];
  const httpsCalls = [];
  const requestJson = createHttpJsonRequester({
    httpImpl: transport({ status: 500, body: 'no' }, httpCalls),
    httpsImpl: transport({ status: 200, body: '{"data":[]}' }, httpsCalls),
  });
  assert.deepEqual(await requestJson({ url: 'https://relay.test/v1/models', headers: { accept: 'application/json' }, timeoutMs: 25 }), {
    ok: true, status: 200, json: { data: [] }, text: '{"data":[]}',
  });
  assert.equal(httpCalls.length, 0);
  assert.equal(httpsCalls[0].options.method, 'GET');
});

test('requestJson returns non-2xx bodies and rejects timeout/socket errors', async () => {
  const calls = [];
  const non2xx = createHttpJsonRequester({ httpImpl: transport({ status: 503, body: 'busy' }, calls) });
  assert.deepEqual(await non2xx({ url: 'http://relay.test/models' }), {
    ok: false, status: 503, json: null, text: 'busy',
  });
  const timeout = createHttpJsonRequester({ httpsImpl: transport('timeout', []) });
  await assert.rejects(timeout({ url: 'https://relay.test/models' }), /timed out/);
  const socket = createHttpJsonRequester({ httpsImpl: transport(new Error('socket closed'), []) });
  await assert.rejects(socket({ url: 'https://relay.test/models' }), /socket closed/);
});

test('requestJson rejects a response-stream error after a partial body', async () => {
  const responseError = new Error('response aborted');
  const requestJson = createHttpJsonRequester({
    httpsImpl: transport({ status: 200, body: '{"partial":', responseError }, []),
  });
  await assert.rejects(requestJson({ url: 'https://relay.test/models' }), responseError);
});
