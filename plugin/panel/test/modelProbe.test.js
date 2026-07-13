import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseModelsList,
  parseProviderModelInventory,
  probeHeaders,
  probeProviderModels,
} from '../src/cep/modelProbe.js';

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

test('parseProviderModelInventory retains only safe modality and task metadata', () => {
  assert.deepEqual(parseProviderModelInventory({ data: [{
    id: 'vision-chat',
    display_name: 'Vision Chat',
    task: 'chat',
    input_modalities: ['text', 'image', 7],
    output_modalities: ['text'],
    capabilities: ['tools'],
    provider_private_blob: 'not persisted',
  }] }), [{
    id: 'vision-chat',
    label: 'Vision Chat',
    metadata: {
      task: 'chat',
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      capabilities: ['tools'],
    },
  }]);
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

test('probeProviderModels preserves UTF-8 model metadata split across response chunks', async () => {
  const body = Buffer.from(JSON.stringify({ data: [{ id: '模型-😀' }] }), 'utf8');
  const emojiOffset = body.indexOf(Buffer.from('😀', 'utf8'));
  const https = makeHttps((options, res, onRes) => {
    onRes(Object.assign(res, { statusCode: 200 }));
    res.handlers.data(body.subarray(0, emojiOffset + 1));
    res.handlers.data(body.subarray(emojiOffset + 1));
    res.handlers.end();
  });

  const result = await probeProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-x',
    httpsImpl: https,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, [{ id: '模型-😀', label: '模型-😀' }]);
});

test('probeProviderModels aborts sustained chunked responses above 512 KiB', async () => {
  let requestDestroyed = 0;
  let responseDestroyed = 0;
  const https = makeHttps((options, res, onRes, req) => {
    res.destroy = () => { responseDestroyed += 1; };
    req.destroy = () => { requestDestroyed += 1; };
    onRes(Object.assign(res, { statusCode: 200 }));
    for (let index = 0; index < 140; index += 1) {
      res.handlers.data(Buffer.alloc(4096, 120));
      if (index === 128) {
        assert.equal(requestDestroyed, 1);
        assert.equal(responseDestroyed, 1);
      }
    }
    res.handlers.end();
  });

  const result = await probeProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-x',
    httpsImpl: https,
  });

  assert.deepEqual(result.models, []);
  assert.equal(result.detail, 'Provider model response exceeded size limit');
  assert.equal(requestDestroyed, 1);
  assert.equal(responseDestroyed, 1);
});

test('probeProviderModels aborts both streams when the request times out', async () => {
  let requestDestroyed = 0;
  let responseDestroyed = 0;
  const https = {
    request(options, onRes) {
      const responseHandlers = {};
      const res = {
        statusCode: 200,
        on(event, handler) { responseHandlers[event] = handler; return this; },
        destroy() { responseDestroyed += 1; },
      };
      let timeoutHandler = null;
      const req = {
        on() { return this; },
        setTimeout(timeoutMs, handler) { timeoutHandler = handler; },
        destroy() { requestDestroyed += 1; },
        end() {
          onRes(res);
          timeoutHandler();
        },
      };
      return req;
    },
  };

  const result = await probeProviderModels({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-x',
    httpsImpl: https,
  });

  assert.deepEqual(result.models, []);
  assert.equal(result.detail, 'Provider model request timed out');
  assert.equal(requestDestroyed, 1);
  assert.equal(responseDestroyed, 1);
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
  assert.equal(down.detail, 'Network error while probing provider models');
});

test('probeProviderModels sends a resolved probe profile without collapsing auth or scoped headers', async () => {
  const probeSecret = 'resolved-probe-secret';
  const extraSecret = 'resolved-extra-secret';
  const calls = [];
  const requestImpl = async (input) => {
    calls.push(input);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 'resolved-model' }] }),
    };
  };
  const result = await probeProviderModels({
    requestProfile: {
      providerId: 'provider-1',
      baseUrl: 'https://provider.example/openai/v1',
      allowInsecureHttp: false,
      auth: { kind: 'header', name: 'x-probe-token', value: probeSecret },
      extraHeaders: [
        { name: 'x-provider-feature', value: 'enabled', source: 'literal' },
        { name: 'x-provider-session', value: extraSecret, source: 'secret' },
      ],
      authProfileRevision: 4,
    },
    protocol: 'openai-compatible',
    requestImpl,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.models, [{ id: 'resolved-model', label: 'resolved-model' }]);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, '/openai/v1/models');
  assert.deepEqual(calls[0].headers, {
    'x-provider-feature': 'enabled',
    'x-provider-session': extraSecret,
    'x-probe-token': probeSecret,
  });
  assert.equal(Object.hasOwn(calls[0], 'apiKey'), false);
  assert.equal(JSON.stringify(result).includes(probeSecret), false);
  assert.equal(JSON.stringify(result).includes(extraSecret), false);
});

test('probeProviderModels rejects JSON-escaped credentials in model ids and labels', async () => {
  for (const secret of ['opaque"provider-secret', 'opaque\\provider-secret']) {
    const result = await probeProviderModels({
      requestProfile: {
        providerId: 'provider-1',
        baseUrl: 'https://provider.example/v1',
        allowInsecureHttp: false,
        auth: { kind: 'header', name: 'Authorization', value: `Bearer ${secret}` },
        extraHeaders: [],
        authProfileRevision: 1,
      },
      protocol: 'openai-compatible',
      requestImpl: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: secret, display_name: `label ${secret}` }] }),
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.detail, 'Provider model metadata was rejected');
    assert.deepEqual(result.models, []);
  }
});

test('probeProviderModels rejects percent and Unicode encoded credentials in model metadata', async () => {
  const secret = 'opaque-provider-secret';
  for (const reflected of [
    'opaque%2dprovider%2dsecret',
    'opaque\\u002dprovider%2dsecret',
    'opaque%252dprovider%252dsecret',
  ]) {
    const result = await probeProviderModels({
      requestProfile: {
        providerId: 'provider-1',
        baseUrl: 'https://provider.example/v1',
        allowInsecureHttp: false,
        auth: { kind: 'header', name: 'Authorization', value: `Bearer ${secret}` },
        extraHeaders: [],
        authProfileRevision: 1,
      },
      protocol: 'openai-compatible',
      requestImpl: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: [{ id: reflected }] }),
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.detail, 'Provider model metadata was rejected');
  }
});

test('probeProviderModels converts injected request failures into a non-secret network result', async () => {
  const secret = 'request-error-secret';
  const result = await probeProviderModels({
    requestProfile: {
      providerId: 'provider-1',
      baseUrl: 'https://provider.example/v1',
      allowInsecureHttp: false,
      auth: { kind: 'header', name: 'Authorization', value: `Bearer ${secret}` },
      extraHeaders: [],
      authProfileRevision: 1,
    },
    requestImpl: async () => { throw new Error(`socket failed ${secret}`); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.deepEqual(result.models, []);
  assert.equal(result.detail, 'Network error while probing provider models');
  assert.equal(result.apiRoot, 'https://provider.example/v1');
  assert.equal(result.authScheme, 'bearer');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('probeProviderModels tries configured-root before plus-v1 and records the successful root', async () => {
  const calls = [];
  const result = await probeProviderModels({
    baseUrl: 'https://relay.example/proxy',
    apiKey: 'sk-test',
    requestImpl: async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":{"message":"missing"}}' }
        : { status: 200, headers: { 'content-type': 'application/json' }, body: '{"data":[{"id":"m"}]}' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.apiRootId, 'plus-v1');
  assert.equal(result.apiRoot, 'https://relay.example/proxy/v1');
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    '/proxy/models',
    '/proxy/v1/models',
  ]);
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
