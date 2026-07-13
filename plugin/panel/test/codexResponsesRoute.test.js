import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCodexResponsesRoute, responsesBodyToChatBody } from '../src/cep/codexResponsesRoute.js';
import {
  closeServer,
  deterministicCrypto,
  listen,
  providerFixture,
  requestText,
  resolvedModelProfile,
  routeFixture,
  routeHeaders,
} from './helpers/providerRouteFixtures.js';

test('responsesBodyToChatBody maps text-only Responses input to chat completions', () => {
  assert.deepEqual(responsesBodyToChatBody({
    model: 'gpt-5.4',
    instructions: 'system rules',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'say ok' }] }],
    max_output_tokens: 12,
    stream: true,
  }), {
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'system rules' },
      { role: 'user', content: 'say ok' },
    ],
    max_tokens: 12,
    stream: true,
  });
});

test('the Chat facade converts /responses and forwards only /chat/completions upstream', async () => {
  const upstreamCalls = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamCalls.push({ path: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl_route","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant","content":"CODEX_"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl_route","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{"content":"ROUTE_OK"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl_route","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  let route = null;
  let upstreamListening = false;
  try {
    const upstreamPort = await listen(upstream);
    upstreamListening = true;
    const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    route = createCodexResponsesRoute({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async (_provider, { scope }) => {
        assert.equal(scope, 'model');
        return resolvedModelProfile({
          baseUrl,
          auth: { kind: 'header', name: 'authorization', value: 'Bearer sk-upstream' },
        });
      },
      requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
      cryptoImpl: deterministicCrypto(),
    });
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'gpt-5.4',
        input: 'reply ok',
        max_output_tokens: 16,
        stream: true,
      },
    });

    assert.equal(result.status, 200);
    assert.equal(upstreamCalls[0].path, '/v1/chat/completions');
    assert.equal(upstreamCalls[0].headers.authorization, 'Bearer sk-upstream');
    assert.equal(upstreamCalls[0].body.stream, true);
    assert.deepEqual(upstreamCalls[0].body.messages, [{ role: 'user', content: 'reply ok' }]);
    assert.match(result.body, /event: response.output_text.delta/);
    assert.match(result.body, /CODEX_ROUTE_OK/);
    assert.match(result.body, /event: response.completed/);
  } finally {
    if (route) await route.close();
    if (upstreamListening) await closeServer(upstream);
  }
});

test('the Chat facade rejects Provider credentials split across upstream SSE events', async () => {
  const secret = 'opaque-provider-secret';
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"chat-secret","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"opaque-provider-"},"finish_reason":null}]}\n\n');
      res.end('data: {"id":"chat-secret","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"secret"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  let route = null;
  try {
    const port = await listen(upstream);
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    route = createCodexResponsesRoute({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async () => resolvedModelProfile({
        baseUrl,
        auth: { kind: 'header', name: 'authorization', value: `Bearer ${secret}` },
      }),
      requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
      cryptoImpl: deterministicCrypto(),
    });
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'gpt-5.4', input: 'safe', stream: true },
    });
    assert.equal(result.status, 502);
    assert.equal(result.body.includes(secret), false);
    assert.equal(JSON.parse(result.body).error.code, 'provider_stream_credential_reflection');
  } finally {
    if (route) await route.close();
    await closeServer(upstream);
  }
});

test('Chat conversion failures never echo credential-shaped unknown keys', async () => {
  const secret = 'opaque-provider-secret';
  for (const reflectedKey of [secret, 'opaque%2dprovider%2dsecret', 'opaque\\u002dprovider-secret']) {
    const upstream = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chat-invalid',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-5.4',
          choices: [{ index: 0, message: { role: 'assistant', content: 'safe' }, finish_reason: 'stop' }],
          [reflectedKey]: true,
        }));
      });
    });
    let route = null;
    try {
      const port = await listen(upstream);
      const baseUrl = `http://127.0.0.1:${port}/v1`;
      route = createCodexResponsesRoute({
        provider: providerFixture({ baseUrl }),
        resolveRequestProfile: async () => resolvedModelProfile({
          baseUrl,
          auth: { kind: 'header', name: 'authorization', value: `Bearer ${secret}` },
        }),
        requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
        cryptoImpl: deterministicCrypto(),
      });
      const local = await route.start();
      const result = await requestText(`${local.baseUrl}/responses`, {
        method: 'POST',
        headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
        body: { model: 'gpt-5.4', input: 'safe', stream: false },
      });
      assert.equal(result.status, 502);
      assert.equal(result.body.includes(secret), false);
      assert.equal(result.body.includes(reflectedKey), false);
      assert.deepEqual(JSON.parse(result.body).error, {
        type: 'provider_protocol_error',
        code: 'invalid_chat_completion',
        message: 'Provider returned an invalid Chat Completion.',
      });
    } finally {
      if (route) await route.close();
      await closeServer(upstream);
    }
  }
});

test('the Chat facade retries once with developer mapped to system after an explicit role rejection', async () => {
  const upstreamCalls = [];
  const upstreamSecret = 'sk-role-retry-secret';
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamCalls.push({ headers: req.headers, body: JSON.parse(body || '{}') });
      if (upstreamCalls.length === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'messages[1].role: unknown variant `developer`, expected one of `system`, `user`, `assistant`, `tool`, `latest_reminder`',
          },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl_role_retry',
        object: 'chat.completion',
        created: 1,
        model: 'chat-only-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ROLE_RETRY_OK' },
          finish_reason: 'stop',
        }],
      }));
    });
  });
  let route = null;
  let upstreamListening = false;
  try {
    const upstreamPort = await listen(upstream);
    upstreamListening = true;
    const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    route = createCodexResponsesRoute({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async () => resolvedModelProfile({
        baseUrl,
        auth: { kind: 'header', name: 'authorization', value: `Bearer ${upstreamSecret}` },
      }),
      requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
      cryptoImpl: deterministicCrypto(),
    });
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'chat-only-model',
        instructions: 'Global policy.',
        input: [
          { role: 'developer', content: 'Project policy.' },
          { role: 'user', content: 'Continue.' },
        ],
        stream: false,
      },
    });

    assert.equal(result.status, 200);
    assert.equal(upstreamCalls.length, 2);
    assert.equal(upstreamCalls.every((call) => call.headers.authorization === `Bearer ${upstreamSecret}`), true);
    assert.deepEqual(upstreamCalls[0].body.messages, [
      { role: 'system', content: 'Global policy.' },
      { role: 'developer', content: 'Project policy.' },
      { role: 'user', content: 'Continue.' },
    ]);
    assert.deepEqual(upstreamCalls[1].body.messages, [
      { role: 'system', content: 'Global policy.' },
      { role: 'system', content: 'Project policy.' },
      { role: 'user', content: 'Continue.' },
    ]);
    assert.equal(result.body.includes('ROLE_RETRY_OK'), true);
    assert.equal(result.body.includes(upstreamSecret), false);
  } finally {
    if (route) await route.close();
    if (upstreamListening) await closeServer(upstream);
  }
});

test('the Chat facade bounds developer-role fallback to one retry and redacts the final error', async () => {
  const upstreamBodies = [];
  const upstreamSecret = 'role-retry-secret-value';
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamBodies.push(JSON.parse(body || '{}'));
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `messages: Unexpected role "developer". Credential ${upstreamSecret}`,
        },
      }));
    });
  });
  let route = null;
  let upstreamListening = false;
  try {
    const upstreamPort = await listen(upstream);
    upstreamListening = true;
    const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    route = createCodexResponsesRoute({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async () => resolvedModelProfile({
        baseUrl,
        auth: { kind: 'header', name: 'authorization', value: `Bearer ${upstreamSecret}` },
      }),
      requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
      cryptoImpl: deterministicCrypto(),
    });
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'chat-only-model',
        input: [{ role: 'developer', content: 'Keep this content.' }],
        stream: false,
      },
    });

    assert.equal(result.status, 400);
    assert.equal(upstreamBodies.length, 2);
    assert.deepEqual(upstreamBodies[0].messages, [
      { role: 'developer', content: 'Keep this content.' },
    ]);
    assert.deepEqual(upstreamBodies[1].messages, [
      { role: 'system', content: 'Keep this content.' },
    ]);
    assert.deepEqual(JSON.parse(result.body).error, {
      type: 'provider_error',
      code: 'provider_error',
      message: 'messages: Unexpected role "developer". Credential [redacted]',
    });
    assert.equal(result.body.includes(upstreamSecret), false);
  } finally {
    if (route) await route.close();
    if (upstreamListening) await closeServer(upstream);
  }
});

test('the Chat facade retries max_tokens once as max_completion_tokens without changing the request', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamBodies.push(JSON.parse(body || '{}'));
      if (upstreamBodies.length === 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: 'unsupported_parameter',
            param: 'max_tokens',
            message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
          },
        }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl_token_retry',
        object: 'chat.completion',
        created: 1,
        model: 'chat-only-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'TOKEN_RETRY_OK' },
          finish_reason: 'stop',
        }],
      }));
    });
  });
  let route = null;
  let upstreamListening = false;
  try {
    const upstreamPort = await listen(upstream);
    upstreamListening = true;
    const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    route = createCodexResponsesRoute({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
      requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
      cryptoImpl: deterministicCrypto(),
    });
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'chat-only-model',
        instructions: 'Global policy.',
        input: [
          { role: 'developer', content: 'Project policy.' },
          { role: 'user', content: 'Use the tools in order.' },
        ],
        max_output_tokens: 32,
        temperature: 0.2,
        tools: [
          { type: 'function', name: 'first_tool', parameters: { type: 'object', properties: {} } },
          { type: 'function', name: 'second_tool', parameters: { type: 'object', properties: {} } },
        ],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        prompt_cache_key: 'cache-token-retry',
        client_metadata: { session_id: 'session-token-retry' },
        stream: false,
      },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.includes('TOKEN_RETRY_OK'), true);
    assert.equal(upstreamBodies.length, 2);
    const [initial, retried] = upstreamBodies;
    assert.equal(initial.max_tokens, 32);
    assert.equal(Object.hasOwn(initial, 'max_completion_tokens'), false);
    assert.equal(Object.hasOwn(retried, 'max_tokens'), false);
    assert.equal(retried.max_completion_tokens, 32);
    assert.deepEqual(
      Object.keys(retried),
      Object.keys(initial).map((name) => (name === 'max_tokens' ? 'max_completion_tokens' : name)),
    );
    const withoutTokenLimit = (body) => Object.fromEntries(
      Object.entries(body).filter(([name]) => name !== 'max_tokens' && name !== 'max_completion_tokens'),
    );
    assert.deepEqual(withoutTokenLimit(retried), withoutTokenLimit(initial));
    assert.deepEqual(retried.messages.map((message) => message.role), ['system', 'developer', 'user']);
    assert.deepEqual(retried.tools.map((tool) => tool.function.name), ['first_tool', 'second_tool']);
  } finally {
    if (route) await route.close();
    if (upstreamListening) await closeServer(upstream);
  }
});

test('the Chat facade does not retry a max_tokens validation error that is not a field rejection', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamBodies.push(JSON.parse(body || '{}'));
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          code: 'invalid_value',
          param: 'max_tokens',
          message: 'max_tokens must be less than or equal to 16.',
        },
      }));
    });
  });
  let route = null;
  let upstreamListening = false;
  try {
    const upstreamPort = await listen(upstream);
    upstreamListening = true;
    const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    route = createCodexResponsesRoute({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
      requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
      cryptoImpl: deterministicCrypto(),
    });
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'chat-only-model',
        input: 'Keep the validation error.',
        max_output_tokens: 32,
        stream: false,
      },
    });

    assert.equal(result.status, 422);
    assert.equal(upstreamBodies.length, 1);
    assert.equal(upstreamBodies[0].max_tokens, 32);
    assert.equal(Object.hasOwn(upstreamBodies[0], 'max_completion_tokens'), false);
    assert.equal(JSON.parse(result.body).error.message, 'max_tokens must be less than or equal to 16.');
  } finally {
    if (route) await route.close();
    if (upstreamListening) await closeServer(upstream);
  }
});

test('the Chat facade composes its two compatibility fallbacks and stops after three requests', async () => {
  const upstreamBodies = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamBodies.push(JSON.parse(body || '{}'));
      res.writeHead(upstreamBodies.length === 2 ? 422 : 400, { 'Content-Type': 'application/json' });
      if (upstreamBodies.length === 1) {
        res.end(JSON.stringify({ error: { message: 'Unexpected developer role in messages.' } }));
        return;
      }
      res.end(JSON.stringify({
        error: {
          code: 'unsupported_parameter',
          param: 'max_tokens',
          message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
        },
      }));
    });
  });
  let route = null;
  let upstreamListening = false;
  try {
    const upstreamPort = await listen(upstream);
    upstreamListening = true;
    const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    route = createCodexResponsesRoute({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
      requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
      cryptoImpl: deterministicCrypto(),
    });
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'chat-only-model',
        input: [
          { role: 'developer', content: 'Keep policy first.' },
          { role: 'user', content: 'Continue.' },
        ],
        max_output_tokens: 32,
        tools: [{ type: 'function', name: 'ordered_tool', parameters: { type: 'object', properties: {} } }],
        stream: false,
      },
    });

    assert.equal(result.status, 400);
    assert.equal(upstreamBodies.length, 3);
    assert.deepEqual(upstreamBodies.map((body) => body.messages[0].role), ['developer', 'system', 'system']);
    assert.deepEqual(upstreamBodies.map((body) => Object.hasOwn(body, 'max_tokens')), [true, true, false]);
    assert.deepEqual(upstreamBodies.map((body) => Object.hasOwn(body, 'max_completion_tokens')), [false, false, true]);
    assert.deepEqual(upstreamBodies.map((body) => body.tools[0].function.name), [
      'ordered_tool',
      'ordered_tool',
      'ordered_tool',
    ]);
  } finally {
    if (route) await route.close();
    if (upstreamListening) await closeServer(upstream);
  }
});

test('the Chat facade does not retry a provider error that merely mentions developer', async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      upstreamCalls += 1;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Developer quota is exhausted.' } }));
    });
  });
  let route = null;
  let upstreamListening = false;
  try {
    const upstreamPort = await listen(upstream);
    upstreamListening = true;
    const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    route = createCodexResponsesRoute({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async () => resolvedModelProfile({ baseUrl }),
      requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
      cryptoImpl: deterministicCrypto(),
    });
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'chat-only-model',
        input: [{ role: 'developer', content: 'Keep this content.' }],
      },
    });

    assert.equal(result.status, 400);
    assert.equal(upstreamCalls, 1);
    assert.equal(JSON.parse(result.body).error.message, 'Developer quota is exhausted.');
  } finally {
    if (route) await route.close();
    if (upstreamListening) await closeServer(upstream);
  }
});

test('the Chat facade returns a structured 501 before credentials or upstream for unsupported Responses features', async () => {
  let resolveCalls = 0;
  let upstreamCalls = 0;
  const route = routeFixture({
    resolveRequestProfile: async () => {
      resolveCalls += 1;
      return resolvedModelProfile();
    },
    createUpstreamRequest: () => {
      upstreamCalls += 1;
      throw new Error('unsupported Responses features must not reach upstream');
    },
  });
  try {
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'gpt-5.4',
        input: [{ role: 'developer', content: 'continue under policy' }],
        previous_response_id: 'response-secret-must-not-escape',
      },
    });

    assert.equal(result.status, 501);
    assert.match(String(result.headers['content-type']), /^application\/json\b/);
    assert.deepEqual(JSON.parse(result.body), {
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_responses_field',
        message: 'Unsupported Responses field: previous_response_id',
        param: 'previous_response_id',
      },
    });
    assert.equal(result.body.includes('response-secret-must-not-escape'), false);
    assert.equal(resolveCalls, 0);
    assert.equal(upstreamCalls, 0);
  } finally {
    await route.close();
  }
});

test('responsesBodyToChatBody maps function tools and tool history', () => {
  assert.deepEqual(responsesBodyToChatBody({
    model: 'gpt-5.4',
    tools: [{ type: 'function', name: 'ae_status', description: 'status', parameters: { type: 'object', properties: {} } }],
    tool_choice: { type: 'function', name: 'ae_status' },
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'check' }] },
      { type: 'function_call', call_id: 'call_1', name: 'ae_status', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ],
    stream: false,
  }), {
    model: 'gpt-5.4',
    messages: [
      { role: 'user', content: 'check' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ae_status', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ],
    stream: false,
    tools: [{ type: 'function', function: { name: 'ae_status', description: 'status', parameters: { type: 'object', properties: {} } } }],
    tool_choice: { type: 'function', function: { name: 'ae_status' } },
  });
});

test('createCodexResponsesRoute adapts streaming tool_calls to Responses function_call events', async () => {
  const upstreamCalls = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamCalls.push({ path: req.url, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"chatcmpl_tool","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"ae_status","arguments":"{"}}]},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl_tool","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"chatcmpl_tool","object":"chat.completion.chunk","created":1,"model":"gpt-5.4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  let route = null;
  let upstreamListening = false;
  try {
    const upstreamPort = await listen(upstream);
    upstreamListening = true;
    const baseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
    route = createCodexResponsesRoute({
      provider: providerFixture({ baseUrl }),
      resolveRequestProfile: async (_provider, { scope }) => {
        assert.equal(scope, 'model');
        return resolvedModelProfile({ baseUrl });
      },
      requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
      cryptoImpl: deterministicCrypto(),
    });
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'gpt-5.4',
        input: 'use tool',
        tools: [{ type: 'function', name: 'ae_status', parameters: { type: 'object', properties: {} } }],
        stream: true,
      },
    });

    assert.equal(result.status, 200);
    assert.equal(upstreamCalls[0].path, '/v1/chat/completions');
    assert.equal(upstreamCalls[0].body.tools[0].function.name, 'ae_status');
    assert.match(result.body, /event: response.output_item.added/);
    assert.match(result.body, /"type":"function_call"/);
    assert.match(result.body, /ae_status/);
    assert.match(result.body, /event: response.function_call_arguments.delta/);
    assert.match(result.body, /event: response.completed/);
  } finally {
    if (route) await route.close();
    if (upstreamListening) await closeServer(upstream);
  }
});
