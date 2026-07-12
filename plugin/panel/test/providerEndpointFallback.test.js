import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeProviderModels } from '../src/cep/modelProbe.js';
import { probeProviderCapabilities } from '../src/cep/providerCapabilityProbe.js';

function requestProfile() {
  return {
    providerId: 'relay',
    baseUrl: 'https://relay.example',
    allowInsecureHttp: false,
    authProfileRevision: 1,
    auth: { kind: 'header', name: 'Authorization', value: 'Bearer provider-secret' },
    extraHeaders: [],
  };
}

function authScheme(headers) {
  if (Object.hasOwn(headers || {}, 'authorization')) return 'bearer';
  if (Object.hasOwn(headers || {}, 'x-api-key')) return 'x-api-key';
  return 'none';
}

test('model discovery reaches the same-origin v1 candidate after root auth and network failures', async () => {
  const calls = [];
  const result = await probeProviderModels({
    requestProfile: requestProfile(),
    requestImpl: async ({ url, headers }) => {
      const path = new URL(url).pathname;
      const scheme = authScheme(headers);
      calls.push({ path, scheme });
      if (path === '/models') {
        if (scheme === 'bearer') return { status: 403, body: '{}' };
        throw new Error('network');
      }
      if (path === '/v1/models' && scheme === 'bearer') {
        return { status: 200, body: JSON.stringify({ data: [{ id: 'model-a' }] }) };
      }
      return { status: 403, body: '{}' };
    },
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.apiRoot, 'https://relay.example/v1');
  assert.equal(result.authScheme, 'bearer');
  assert.deepEqual(calls.slice(0, 3), [
    { path: '/models', scheme: 'bearer' },
    { path: '/models', scheme: 'x-api-key' },
    { path: '/v1/models', scheme: 'bearer' },
  ]);
});

test('capability detection reaches v1 chat after the root candidate rejects both auth attempts', async () => {
  const calls = [];
  const jsonHeaders = { 'content-type': 'application/json' };
  const requestImpl = async ({ url, headers, body }) => {
    const path = new URL(url).pathname;
    const scheme = authScheme(headers);
    calls.push({ path, scheme });
    if (path === '/models') {
      if (scheme === 'bearer') return { status: 403, headers: jsonHeaders, body: '{}' };
      throw new Error('network');
    }
    if (path === '/v1/models' && scheme === 'bearer') {
      return {
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({ data: [{ id: 'model-a' }] }),
      };
    }
    if (!path.startsWith('/v1/')) {
      if (scheme === 'bearer') return { status: 403, headers: jsonHeaders, body: '{}' };
      throw new Error('network');
    }
    if (path === '/v1/chat/completions' && scheme === 'bearer') {
      if (body?.stream === true) {
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: [
            'data: {"id":"chatcmpl-a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
            '',
            'data: {"id":"chatcmpl-a","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
            '',
            'data: [DONE]',
            '',
            '',
          ].join('\n'),
        };
      }
      return {
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          id: 'chatcmpl-a',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          }],
        }),
      };
    }
    return {
      status: 404,
      headers: jsonHeaders,
      body: JSON.stringify({ error: { code: 'unsupported_endpoint', message: 'not supported' } }),
    };
  };

  const provider = {
    id: 'relay',
    protocol: 'openai-compatible',
    baseUrl: 'https://relay.example',
    allowInsecureHttp: false,
    authProfileRevision: 1,
  };
  const result = await probeProviderCapabilities({
    provider,
    modelId: 'model-a',
    requestImpl,
    resolveRequestProfile: async () => requestProfile(),
  });

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.preferredProtocol, 'chat');
  assert.equal(result.capabilities.chat.support, 'supported');
  assert.equal(result.capabilities.chat.apiRoot, 'https://relay.example/v1');
  assert.equal(result.capabilities.chat.authScheme, 'bearer');
  assert.equal(calls.some((call) => call.path === '/chat/completions'), true);
  assert.equal(calls.some((call) => call.path === '/v1/chat/completions'), true);
});
