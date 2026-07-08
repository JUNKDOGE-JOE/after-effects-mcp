import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProviderDialect } from '../src/cep/providerDetect.js';

function makeHttps(responses) {
  const calls = [];
  return {
    calls,
    request(options, onRes) {
      const req = {
        handlers: {},
        body: '',
        on(ev, fn) { this.handlers[ev] = fn; return this; },
        setTimeout() {},
        destroy() {},
        write(chunk) { this.body += chunk; },
        end() {
          const response = responses.shift();
          calls.push({ options, body: this.body });
          if (!response) throw new Error('Unexpected request: ' + options.method + ' ' + options.path);
          if (response.error) {
            this.handlers.error(new Error(response.error));
            return;
          }
          const res = {
            handlers: {},
            on(ev, fn) { this.handlers[ev] = fn; },
          };
          onRes(Object.assign(res, { statusCode: response.status }));
          if (response.body !== undefined) res.handlers.data(response.body);
          res.handlers.end();
        },
      };
      return req;
    },
  };
}

function modelBody(id = 'glm-5.2') {
  return JSON.stringify({ data: [{ id }] });
}

test('detectProviderDialect accepts bearer auth and responses wire API', async () => {
  const https = makeHttps([
    { status: 200, body: modelBody('glm-5.2') },
    { status: 200, body: '{}' },
  ]);

  const result = await detectProviderDialect({
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'sk-good',
    httpsImpl: https,
    now: () => 123,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.dialect, { wireApi: 'responses', authScheme: 'bearer', source: 'detected', updatedAt: 123 });
  assert.deepEqual(result.models, [{ id: 'glm-5.2', label: 'glm-5.2' }]);
  assert.deepEqual(result.tried, [
    { step: 'auth', candidate: 'bearer', status: 200, outcome: 'accepted' },
    { step: 'wire', candidate: 'responses', status: 200, outcome: 'accepted' },
  ]);
  assert.equal(https.calls[0].options.path, '/v1/models');
  assert.equal(https.calls[0].options.headers.Authorization, 'Bearer sk-good');
  assert.equal(https.calls[1].options.path, '/v1/responses');
  assert.deepEqual(JSON.parse(https.calls[1].body), { model: 'glm-5.2', input: 'ping', max_output_tokens: 16, stream: false });
});

test('detectProviderDialect falls through bearer to x-api-key and chat', async () => {
  const https = makeHttps([
    { status: 401, body: 'no' },
    { status: 200, body: modelBody('chat-model') },
    { status: 404, body: 'missing' },
    { status: 200, body: '{}' },
  ]);

  const result = await detectProviderDialect({
    baseUrl: 'https://provider.example',
    apiKey: 'sk-x',
    httpsImpl: https,
    now: () => 456,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.dialect, { wireApi: 'chat', authScheme: 'x-api-key', source: 'detected', updatedAt: 456 });
  assert.equal(https.calls[1].options.headers['x-api-key'], 'sk-x');
  assert.equal(https.calls[2].options.path, '/v1/responses');
  assert.equal(https.calls[3].options.path, '/v1/chat/completions');
  assert.deepEqual(result.tried, [
    { step: 'auth', candidate: 'bearer', status: 401, outcome: 'rejected' },
    { step: 'auth', candidate: 'x-api-key', status: 200, outcome: 'accepted' },
    { step: 'wire', candidate: 'responses', status: 404, outcome: 'rejected' },
    { step: 'wire', candidate: 'chat', status: 200, outcome: 'accepted' },
  ]);
});

test('detectProviderDialect tries only none auth when apiKey is empty', async () => {
  const https = makeHttps([
    { status: 200, body: modelBody('public-model') },
    { status: 200, body: '{}' },
  ]);

  const result = await detectProviderDialect({
    baseUrl: 'https://public.example',
    apiKey: '',
    httpsImpl: https,
    now: () => 789,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dialect.authScheme, 'none');
  assert.equal(https.calls.length, 2);
  assert.deepEqual(https.calls[0].options.headers, {});
  assert.deepEqual(result.tried.map((t) => t.candidate), ['none', 'responses']);
});

test('detectProviderDialect reports auth when all model auth attempts are rejected', async () => {
  const https = makeHttps([
    { status: 401, body: 'bearer no' },
    { status: 403, body: 'x no' },
    { status: 401, body: 'none no' },
  ]);

  const result = await detectProviderDialect({
    baseUrl: 'https://locked.example',
    apiKey: 'sk-bad',
    httpsImpl: https,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'auth');
  assert.equal(https.calls.length, 3);
  assert.deepEqual(result.tried.map((t) => t.candidate), ['bearer', 'x-api-key', 'none']);
});

test('detectProviderDialect stops immediately on network error', async () => {
  const https = makeHttps([
    { error: 'ECONNREFUSED' },
    { status: 200, body: modelBody('should-not-run') },
  ]);

  const result = await detectProviderDialect({
    baseUrl: 'https://down.example',
    apiKey: 'sk-down',
    httpsImpl: https,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'network');
  assert.equal(https.calls.length, 1);
  assert.deepEqual(result.tried, [{ step: 'auth', candidate: 'bearer', status: 0, outcome: 'network' }]);
});

test('detectProviderDialect accepts responses on 400 JSON error object', async () => {
  const https = makeHttps([
    { status: 200, body: modelBody('strict-model') },
    { status: 400, body: JSON.stringify({ error: { message: 'unsupported parameter' } }) },
    { status: 200, body: '{}' },
  ]);

  const result = await detectProviderDialect({
    baseUrl: 'https://strict.example',
    apiKey: 'sk-strict',
    httpsImpl: https,
  });

  assert.equal(result.ok, true);
  assert.equal(result.dialect.wireApi, 'responses');
  assert.equal(https.calls.length, 2);
  assert.deepEqual(result.tried.at(-1), { step: 'wire', candidate: 'responses', status: 400, outcome: 'accepted' });
});

test('detectProviderDialect reports wire-undetected when responses and chat are missing', async () => {
  const https = makeHttps([
    { status: 200, body: modelBody('model') },
    { status: 404, body: 'not found' },
    { status: 404, body: 'not found' },
  ]);

  const result = await detectProviderDialect({
    baseUrl: 'https://models-only.example',
    apiKey: 'sk-wire',
    httpsImpl: https,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'wire-undetected');
  assert.deepEqual(result.tried.slice(1), [
    { step: 'wire', candidate: 'responses', status: 404, outcome: 'rejected' },
    { step: 'wire', candidate: 'chat', status: 404, outcome: 'rejected' },
  ]);
});

test('detectProviderDialect skips anthropic providers', async () => {
  const https = makeHttps([{ status: 200, body: modelBody('unused') }]);

  const result = await detectProviderDialect({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-a',
    protocol: 'anthropic',
    httpsImpl: https,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-applicable');
  assert.deepEqual(result.tried, []);
  assert.equal(https.calls.length, 0);
});

test('detectProviderDialect does not include apiKey in tried or detail', async () => {
  const apiKey = 'sk-test-secret-1234567890';
  const https = makeHttps([
    { status: 401, body: 'Authorization: Bearer ' + apiKey },
    { status: 403, body: 'x-api-key=' + apiKey },
    { status: 401, body: 'apiKey=' + apiKey },
  ]);

  const result = await detectProviderDialect({
    baseUrl: 'https://secret.example',
    apiKey,
    httpsImpl: https,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'auth');
  assert.doesNotMatch(JSON.stringify(result.tried), new RegExp(apiKey));
  assert.doesNotMatch(result.detail, new RegExp(apiKey));
});
