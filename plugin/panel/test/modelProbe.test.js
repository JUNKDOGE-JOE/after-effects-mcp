import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelsList, probeHeaders, probeProviderModels } from '../src/cep/modelProbe.js';

test('parseModelsList handles OpenAI-style {data:[{id}]}', () => {
  const models = parseModelsList({ data: [{ id: 'glm-5.2' }, { id: 'deepseek-v4' }, { object: 'noise' }] });
  assert.deepEqual(models, [
    { id: 'glm-5.2', label: 'glm-5.2' },
    { id: 'deepseek-v4', label: 'deepseek-v4' },
  ]);
});

test('parseModelsList handles Anthropic-style display_name and bare arrays', () => {
  assert.deepEqual(parseModelsList({ data: [{ id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }] }),
    [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }]);
  assert.deepEqual(parseModelsList([{ id: 'm1' }]), [{ id: 'm1', label: 'm1' }]);
  assert.deepEqual(parseModelsList(null), []);
});

test('probeHeaders picks auth scheme by protocol', () => {
  assert.deepEqual(probeHeaders('openai-compatible', 'sk-x'), { Authorization: 'Bearer sk-x' });
  assert.deepEqual(probeHeaders('openai-compatible', 'sk-x', { authScheme: 'bearer' }), { Authorization: 'Bearer sk-x' });
  assert.deepEqual(probeHeaders('openai-compatible', 'sk-x', { authScheme: 'x-api-key' }), { 'x-api-key': 'sk-x' });
  assert.deepEqual(probeHeaders('openai-compatible', 'sk-x', { authScheme: 'none' }), {});
  assert.deepEqual(probeHeaders('anthropic', 'sk-a'), { 'x-api-key': 'sk-a', 'anthropic-version': '2023-06-01' });
});

function makeHttps(handler) {
  return {
    request(options, onRes) {
      const res = { handlers: {}, on(ev, fn) { this.handlers[ev] = fn; } };
      const req = {
        handlers: {},
        on(ev, fn) { this.handlers[ev] = fn; return this; },
        setTimeout() {},
        destroy() {},
        end() { handler(options, res, onRes, req); },
      };
      return req;
    },
  };
}

test('probeProviderModels returns ok with parsed models on 200', async () => {
  const https = makeHttps((options, res, onRes) => {
    assert.equal(options.path, '/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer sk-x');
    onRes(Object.assign(res, { statusCode: 200 }));
    res.handlers.data(JSON.stringify({ data: [{ id: 'glm-5.2' }] }));
    res.handlers.end();
  });
  const result = await probeProviderModels({ baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-x', protocol: 'openai-compatible', httpsImpl: https });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, [{ id: 'glm-5.2', label: 'glm-5.2' }]);
});

test('probeProviderModels respects openai-compatible dialect auth schemes', async () => {
  const seen = [];
  const https = makeHttps((options, res, onRes) => {
    seen.push(options.headers);
    onRes(Object.assign(res, { statusCode: 200 }));
    res.handlers.data(JSON.stringify({ data: [{ id: 'm' }] }));
    res.handlers.end();
  });

  await probeProviderModels({ baseUrl: 'https://h/v1', apiKey: 'sk', dialect: { authScheme: 'bearer' }, httpsImpl: https });
  await probeProviderModels({ baseUrl: 'https://h/v1', apiKey: 'sk', dialect: { authScheme: 'x-api-key' }, httpsImpl: https });
  await probeProviderModels({ baseUrl: 'https://h/v1', apiKey: 'sk', authScheme: 'none', httpsImpl: https });

  assert.deepEqual(seen, [
    { Authorization: 'Bearer sk' },
    { 'x-api-key': 'sk' },
    {},
  ]);
});

test('probeProviderModels degrades to ok:false on 401 and network error', async () => {
  const https401 = makeHttps((options, res, onRes) => {
    onRes(Object.assign(res, { statusCode: 401 }));
    res.handlers.data('unauthorized');
    res.handlers.end();
  });
  const denied = await probeProviderModels({ baseUrl: 'https://h/v1', apiKey: 'bad', httpsImpl: https401 });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 401);

  const httpsErr = makeHttps((options, res, onRes, req) => { req.handlers.error(new Error('ECONNREFUSED')); });
  const down = await probeProviderModels({ baseUrl: 'https://h/v1', apiKey: 'k', httpsImpl: httpsErr });
  assert.equal(down.ok, false);
  assert.match(down.detail, /ECONNREFUSED/);
});

test('probeProviderModels does not include secret-bearing error bodies in detail', async () => {
  const apiKey = 'sk-test-secret-1234567890';
  const https = makeHttps((options, res, onRes) => {
    onRes(Object.assign(res, { statusCode: 401 }));
    res.handlers.data('Authorization: Bearer ' + apiKey + '\napiKey=' + apiKey);
    res.handlers.end();
  });

  const result = await probeProviderModels({ baseUrl: 'https://h/v1', apiKey, httpsImpl: https });

  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.detail, 'HTTP 401 from provider');
  assert.doesNotMatch(result.detail, new RegExp(apiKey));
  assert.doesNotMatch(result.detail, /Authorization/i);
  assert.doesNotMatch(result.detail, /Bearer/i);
});

test('probeProviderModels blocks unapproved non-loopback HTTP before auth headers or network access', async () => {
  const apiKey = 'sk-never-materialize-123456';
  let requestCalls = 0;
  let observedOptions = null;
  const http = {
    request(options) {
      requestCalls += 1;
      observedOptions = options;
      throw new Error('network must not be reached');
    },
  };

  const result = await probeProviderModels({
    baseUrl: 'http://relay.example/v1',
    apiKey,
    allowInsecureHttp: false,
    httpsImpl: http,
  });

  assert.deepEqual(result, {
    ok: false,
    status: 0,
    models: [],
    detail: 'Insecure provider HTTP is not approved',
  });
  assert.equal(requestCalls, 0);
  assert.equal(observedOptions, null);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('probeProviderModels permits loopback HTTP and explicitly approved non-loopback HTTP', async () => {
  for (const input of [
    { baseUrl: 'http://127.0.0.1:11434/v1', allowInsecureHttp: false },
    { baseUrl: 'http://relay.example/v1', allowInsecureHttp: true },
  ]) {
    let requestCalls = 0;
    const http = makeHttps((options, res, onRes) => {
      requestCalls += 1;
      assert.equal(options.protocol, 'http:');
      onRes(Object.assign(res, { statusCode: 200 }));
      res.handlers.data(JSON.stringify({ data: [{ id: 'allowed-model' }] }));
      res.handlers.end();
    });
    const result = await probeProviderModels({
      ...input,
      apiKey: 'sk-allowed-12345678',
      httpsImpl: http,
    });
    assert.equal(result.ok, true);
    assert.equal(requestCalls, 1);
  }
});
