import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import test from 'node:test';

import { createUniversalProviderRoute } from '../src/cep/universalProviderRoute.js';
import {
  closeServer,
  listen,
  requestText,
  routeHeaders,
} from './helpers/providerRouteFixtures.js';

function upstreamServer(records) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      records.push({
        path: req.url,
        headers: req.headers,
        body: bodyText ? JSON.parse(bodyText) : null,
      });
      const current = records.at(-1);
      if (current.body?.stream === true && req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          'data: ' + JSON.stringify({
            id: 'chat_stream_1',
            object: 'chat.completion.chunk',
            created: 1,
            model: current.body.model,
            choices: [{
              index: 0,
              delta: { role: 'assistant', content: 'OK' },
              finish_reason: 'stop',
              logprobs: null,
            }],
          }),
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'));
        return;
      }
      if (current.body?.stream === true && req.url.startsWith('/v1/responses')) {
        const response = {
          id: 'resp_stream_1',
          object: 'response',
          status: 'completed',
          model: current.body.model,
          output: [{
            id: 'msg_stream_1',
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'OK' }],
          }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: response.completed\ndata: ' + JSON.stringify({
          type: 'response.completed',
          response,
        }) + '\n\n');
        return;
      }
      if (current.body?.stream === true && req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end([
          'event: message_start',
          'data: ' + JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_stream_1',
              type: 'message',
              role: 'assistant',
              model: current.body.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }),
          '',
          'event: content_block_start',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
          '',
          'event: content_block_delta',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
          '',
          'event: content_block_stop',
          'data: {"type":"content_block_stop","index":0}',
          '',
          'event: message_delta',
          'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
          '',
          'event: message_stop',
          'data: {"type":"message_stop"}',
          '',
          '',
        ].join('\n'));
        return;
      }
      if (req.url.startsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chat_1',
          object: 'chat.completion',
          created: 1,
          model: records.at(-1).body.model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
            logprobs: null,
          }],
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'native_1',
        object: req.url.includes('/messages') ? 'message' : 'response',
        type: req.url.includes('/messages') ? 'message' : undefined,
        role: req.url.includes('/messages') ? 'assistant' : undefined,
        content: req.url.includes('/messages') ? [{ type: 'text', text: 'OK' }] : undefined,
        stop_reason: req.url.includes('/messages') ? 'end_turn' : undefined,
        output: req.url.includes('/messages') ? undefined : [],
        status: req.url.includes('/messages') ? undefined : 'completed',
        model: records.at(-1).body.model,
      }));
    });
  });
}

function controlledUpstream(records, respond) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const record = {
        path: req.url,
        headers: req.headers,
        body: bodyText ? JSON.parse(bodyText) : null,
      };
      records.push(record);
      respond({ req, res, record, attempt: records.length });
    });
  });
}

function sendNativeMessage(res, model = 'native-m') {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'native_message_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'OK' }],
    model,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
}

function makeRoute({ apiRoot, records, capabilities, profileCalls, audit = [], secret = 'upstream-secret' }) {
  const provider = {
    id: 'provider-1',
    modelList: {
      models: [
        { id: 'native-r', label: 'native-r' },
        { id: 'native-m', label: 'native-m' },
        { id: 'chat-m', label: 'chat-m' },
      ],
    },
    headers: [],
  };
  return createUniversalProviderRoute({
    provider,
    resolveCapability: async ({ modelId }) => ({
      ok: true,
      upstreamProtocol: capabilities[modelId],
      apiRoot,
      auth: {
        scheme: capabilities[modelId] === 'messages' ? 'x-api-key' : 'bearer',
        headerName: null,
      },
      features: { compact: 'unsupported', countTokens: 'unsupported' },
    }),
    resolveRequestProfile: async (_provider, details) => {
      profileCalls.push(details);
      return {
        providerId: 'provider-1',
        baseUrl: apiRoot,
        apiRoot,
        allowInsecureHttp: true,
        auth: details.protocol === 'messages'
          ? { kind: 'header', name: 'x-api-key', value: secret }
          : { kind: 'header', name: 'authorization', value: `Bearer ${secret}` },
        extraHeaders: [],
      };
    },
    requireImpl: (name) => ({ http, https, crypto })[name],
    onAudit: (entry) => audit.push(entry),
  });
}

test('returns distinct OpenAI and Anthropic local roots and proxies native Responses verbatim', async () => {
  const records = [];
  const profileCalls = [];
  const upstream = upstreamServer(records);
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls,
  });
  try {
    const local = await route.start();
    assert.equal(local.openaiBaseUrl, local.origin + '/v1');
    assert.equal(local.anthropicBaseUrl, local.origin);
    const result = await requestText(local.openaiBaseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'native-r',
        input: 'OK',
        future_typed_field: { preserved: true },
      },
    });
    assert.equal(result.status, 200);
    assert.equal(records.length, 1);
    assert.equal(records[0].path, '/v1/responses');
    assert.equal(records[0].headers.authorization, 'Bearer upstream-secret');
    assert.equal(records[0].headers['x-ae-mcp-route-token'], undefined);
    assert.deepEqual(records[0].body.future_typed_field, { preserved: true });
    assert.equal(profileCalls[0].modelId, 'native-r');
    assert.equal(profileCalls[0].protocol, 'responses');
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('native Responses and Chat facade successes remove reflected Provider credentials', async () => {
  const secret = 'upstream-secret';
  const records = [];
  const upstream = controlledUpstream(records, ({ res, record }) => {
    const body = record.path.startsWith('/v1/chat/completions')
      ? {
        id: 'chat_secret',
        object: 'chat.completion',
        created: 1,
        model: record.body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: secret },
          finish_reason: 'stop',
          logprobs: null,
        }],
      }
      : {
        id: 'response_secret',
        object: 'response',
        status: 'completed',
        model: record.body.model,
        metadata: { [secret]: 'safe' },
        output: [{
          id: 'message_secret',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: secret }],
        }],
      };
    const encoded = JSON.stringify(body);
    const split = encoded.indexOf(secret) + 'upstream-'.length;
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': secret });
    res.write(encoded.slice(0, split));
    res.end(encoded.slice(split));
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls: [],
  });
  try {
    const local = await route.start();
    for (const model of ['native-r', 'chat-m']) {
      const result = await requestText(local.openaiBaseUrl + '/responses', {
        method: 'POST',
        headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
        body: { model, input: 'safe', stream: false },
      });
      assert.equal(result.status, 200);
      assert.equal(result.headers['x-request-id'], undefined);
      assert.equal(result.body.includes(secret), false);
      assert.match(result.body, /\[redacted\]/);
      if (model === 'native-r') {
        assert.equal(Object.hasOwn(JSON.parse(result.body).metadata, '[redacted]'), true);
      }
    }
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('native non-streaming responses remove encoded credentials from body and headers', async () => {
  const secret = 'opaque-provider-secret';
  const reflected = 'opaque%2dprovider%2dsecret';
  const records = [];
  const upstream = controlledUpstream(records, ({ res, record }) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': reflected,
      'x-fragment-left': 'opaque-provider-',
      'x-fragment-right': 'secret',
    });
    res.end(JSON.stringify({
      id: 'response-encoded',
      object: 'response',
      status: 'completed',
      model: record.body.model,
      output: [{
        id: 'message-encoded',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: reflected }],
      }],
      metadata: { left: 'opaque-provider-', right: 'secret' },
    }));
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses' },
    profileCalls: [],
    secret,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.openaiBaseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'native-r', input: 'safe', stream: false },
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers['x-request-id'], undefined);
    assert.equal(result.headers['x-fragment-left'], undefined);
    assert.equal(result.headers['x-fragment-right'], undefined);
    assert.equal(result.body.includes(reflected), false);
    assert.match(result.body, /\[redacted\]/);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('native SSE rejects credentials split across unknown metadata events before forwarding any frame', async () => {
  const secret = 'opaque-provider-secret';
  const records = [];
  const upstream = controlledUpstream(records, ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: future.event\ndata: {"type":"future.event","metadata":{"left":"opaque-provider-"}}\n\n');
    res.end('event: future.event\ndata: {"type":"future.event","metadata":{"right":"secret"}}\n\n');
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses' },
    profileCalls: [],
    secret,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.openaiBaseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'native-r', input: 'safe', stream: true },
    });
    assert.equal(result.status, 502);
    assert.equal(result.body.includes(secret), false);
    assert.equal(JSON.parse(result.body).error.code, 'provider_stream_credential_reflection');
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('native SSE preserves safe unknown events byte-for-byte after validation', async () => {
  const records = [];
  const transcript = 'event: future.event\ndata: {"type":"future.event","future_field":{"preserved":true}}\n\n';
  const upstream = controlledUpstream(records, ({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(transcript);
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses' },
    profileCalls: [],
  });
  try {
    const local = await route.start();
    const result = await requestText(local.openaiBaseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'native-r', input: 'safe', stream: true },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, transcript);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('converted response errors never echo credential-shaped unknown keys', async () => {
  const secret = 'opaque-provider-secret';
  const reflectedKey = 'opaque%2dprovider%2dsecret';
  const records = [];
  const upstream = controlledUpstream(records, ({ res, record }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chat-invalid',
      object: 'chat.completion',
      created: 1,
      model: record.body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'safe' }, finish_reason: 'stop' }],
      [reflectedKey]: true,
    }));
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'chat-m': 'chat' },
    profileCalls: [],
    secret,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.openaiBaseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'chat-m', input: 'safe', stream: false },
    });
    assert.equal(result.status, 502);
    assert.equal(result.body.includes(secret), false);
    assert.equal(result.body.includes(reflectedKey), false);
    const error = JSON.parse(result.body).error;
    if (Object.hasOwn(error, 'param')) assert.equal(error.param, 'provider_response');
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('proxies native Messages from the Anthropic root without forwarding the local token', async () => {
  const records = [];
  const profileCalls = [];
  const upstream = upstreamServer(records);
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.anthropicBaseUrl + '/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + local.routeToken,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219',
        'content-type': 'application/json',
      },
      body: {
        model: 'native-m',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'OK' }],
        context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      },
    });
    assert.equal(result.status, 200);
    assert.equal(records.length, 1);
    assert.equal(records[0].path, '/v1/messages?beta=true');
    assert.equal(records[0].headers['x-api-key'], 'upstream-secret');
    assert.equal(records[0].headers.authorization, undefined);
    assert.equal(records[0].headers['anthropic-beta'], 'claude-code-20250219');
    assert.deepEqual(records[0].body.context_management, {
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    });
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('retries native Messages once after removing only explicitly rejected Anthropic beta values', async () => {
  const records = [];
  const audit = [];
  const upstream = controlledUpstream(records, ({ res, attempt }) => {
    if (attempt === 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Unexpected value(s) `advisor-tool-2026-03-01`, `thinking-token-count-2026-05-13` for the `anthropic-beta` header.',
        },
      }));
      return;
    }
    sendNativeMessage(res);
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls: [],
    audit,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.anthropicBaseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + local.routeToken,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'supported-beta, advisor-tool-2026-03-01, thinking-token-count-2026-05-13',
        'content-type': 'application/json',
      },
      body: {
        model: 'native-m',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'OK' }],
      },
    });
    assert.equal(result.status, 200);
    assert.equal(records.length, 2);
    assert.equal(
      records[0].headers['anthropic-beta'],
      'supported-beta, advisor-tool-2026-03-01, thinking-token-count-2026-05-13',
    );
    assert.equal(records[1].headers['anthropic-beta'], 'supported-beta');
    assert.deepEqual(records[1].body, records[0].body);
    assert.equal(audit.filter((entry) => entry.event === 'provider_route_compat_retry').length, 1);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('does not retry native Messages for an unrelated upstream 400', async () => {
  const records = [];
  const upstream = controlledUpstream(records, ({ res }) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Request body is invalid.' } }));
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls: [],
  });
  try {
    const local = await route.start();
    const result = await requestText(local.anthropicBaseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + local.routeToken,
        'anthropic-beta': 'advisor-tool-2026-03-01',
        'content-type': 'application/json',
      },
      body: { model: 'native-m', max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] },
    });
    assert.equal(result.status, 400);
    assert.equal(records.length, 1);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('does not retry when the upstream names an Anthropic beta value that was not sent', async () => {
  const records = [];
  const upstream = controlledUpstream(records, ({ res }) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: 'Unexpected value(s) `different-beta` for the `anthropic-beta` header.',
      },
    }));
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls: [],
  });
  try {
    const local = await route.start();
    const result = await requestText(local.anthropicBaseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + local.routeToken,
        'anthropic-beta': 'advisor-tool-2026-03-01',
        'content-type': 'application/json',
      },
      body: { model: 'native-m', max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] },
    });
    assert.equal(result.status, 400);
    assert.equal(records.length, 1);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('limits Anthropic beta compatibility to one retry', async () => {
  const records = [];
  const upstream = controlledUpstream(records, ({ res, attempt }) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: attempt === 1
          ? 'Unexpected value(s) `advisor-tool-2026-03-01` for the `anthropic-beta` header.'
          : 'Unexpected value(s) `supported-beta` for the `anthropic-beta` header.',
      },
    }));
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls: [],
  });
  try {
    const local = await route.start();
    const result = await requestText(local.anthropicBaseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + local.routeToken,
        'anthropic-beta': 'supported-beta, advisor-tool-2026-03-01',
        'content-type': 'application/json',
      },
      body: { model: 'native-m', max_tokens: 16, messages: [{ role: 'user', content: 'OK' }] },
    });
    assert.equal(result.status, 400);
    assert.equal(records.length, 2);
    assert.equal(records[1].headers['anthropic-beta'], 'supported-beta');
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('routes a Chat-only model through the secured Responses facade', async () => {
  const records = [];
  const profileCalls = [];
  const audit = [];
  const upstream = upstreamServer(records);
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls,
    audit,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.openaiBaseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'chat-m', input: 'OK', stream: false },
    });
    assert.equal(result.status, 200);
    assert.equal(records.length, 1);
    assert.equal(records[0].path, '/v1/chat/completions');
    assert.deepEqual(records[0].body.messages, [{ role: 'user', content: 'OK' }]);
    assert.equal(JSON.parse(result.body).object, 'response');
    assert.equal(audit.at(-1).conversion, 'responses-to-chat');
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('returns model-specific compact 501 before resolving credentials', async () => {
  const records = [];
  const profileCalls = [];
  const upstream = upstreamServer(records);
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.openaiBaseUrl + '/responses/compact', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'native-r' },
    });
    assert.equal(result.status, 501);
    assert.equal(JSON.parse(result.body).error.code, 'provider_compaction_unsupported');
    assert.equal(profileCalls.length, 0);
    assert.equal(records.length, 0);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('maps selector-level compact unavailability to the non-recoverable compaction contract', async () => {
  let profileCalls = 0;
  const route = createUniversalProviderRoute({
    provider: { id: 'provider-1', headers: [], modelList: { models: [{ id: 'model-a' }] } },
    resolveCapability: async () => ({ ok: false, reasonCode: 'unavailable' }),
    resolveRequestProfile: async () => {
      profileCalls += 1;
      throw new Error('must not resolve credentials');
    },
    requireImpl: (name) => ({ http, https, crypto })[name],
  });
  try {
    const local = await route.start();
    const result = await requestText(local.openaiBaseUrl + '/responses/compact', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: { model: 'model-a' },
    });
    assert.equal(result.status, 501);
    assert.equal(JSON.parse(result.body).error.code, 'provider_compaction_unsupported');
    assert.equal(profileCalls, 0);
  } finally {
    await route.close();
  }
});

test('converts Claude Messages defaults through a Chat-only model and emits message_stop', async () => {
  const records = [];
  const profileCalls = [];
  const audit = [];
  const upstream = upstreamServer(records);
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls,
    audit,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.anthropicBaseUrl + '/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + local.routeToken,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,interleaved-thinking',
        'content-type': 'application/json',
      },
      body: {
        model: 'chat-m',
        max_tokens: 32000,
        stream: true,
        system: [{
          type: 'text',
          text: 'Policy',
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }],
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
        context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
        metadata: { user_id: 'local-user' },
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.includes('event: message_stop'), true);
    assert.equal(records[0].path, '/v1/chat/completions');
    assert.equal(records[0].body.messages[0].role, 'system');
    assert.equal(records[0].body.messages[1].role, 'user');
    assert.equal(records[0].body.reasoning_effort, 'xhigh');
    assert.equal(records[0].headers.authorization, 'Bearer upstream-secret');
    assert.equal(records[0].headers['anthropic-beta'], undefined);
    assert.equal(audit.at(-1).conversion, 'messages-to-chat');
    assert.equal(audit.at(-1).consumed.includes('metadata'), true);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('converts Claude Messages through native Responses and returns Anthropic SSE', async () => {
  const records = [];
  const profileCalls = [];
  const upstream = upstreamServer(records);
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.anthropicBaseUrl + '/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + local.routeToken,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: {
        model: 'native-r',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'OK' }],
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.includes('event: message_stop'), true);
    assert.equal(records[0].path, '/v1/responses');
    assert.equal(records[0].body.input[0].role, 'user');
    assert.equal(records[0].body.max_output_tokens, 32);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('converts Codex Responses through native Messages and returns response.completed', async () => {
  const records = [];
  const profileCalls = [];
  const upstream = upstreamServer(records);
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.openaiBaseUrl + '/responses', {
      method: 'POST',
      headers: routeHeaders(local.routeToken, { 'content-type': 'application/json' }),
      body: {
        model: 'native-m',
        input: 'OK',
        max_output_tokens: 32,
        stream: true,
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.includes('event: response.completed'), true);
    assert.equal(records[0].path, '/v1/messages');
    assert.equal(records[0].body.messages[0].role, 'user');
    assert.equal(records[0].body.max_tokens, 32);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('replays Chat reasoning through an authenticated Messages capsule on the next turn', async () => {
  const records = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      records.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chat_reasoning_' + records.length,
        object: 'chat.completion',
        created: 1,
        model: body.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: records.length === 1 ? 'FIRST' : 'SECOND',
            reasoning_content: records.length === 1 ? 'private chain state' : 'continued state',
          },
          finish_reason: 'stop',
          logprobs: null,
        }],
      }));
    });
  });
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls: [],
  });
  try {
    const local = await route.start();
    const headers = {
      authorization: 'Bearer ' + local.routeToken,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
    const first = await requestText(local.anthropicBaseUrl + '/v1/messages', {
      method: 'POST',
      headers,
      body: {
        model: 'chat-m',
        max_tokens: 32,
        stream: false,
        messages: [{ role: 'user', content: 'First' }],
      },
    });
    assert.equal(first.status, 200);
    const firstMessage = JSON.parse(first.body);
    const thinking = firstMessage.content.find((block) => block.type === 'thinking');
    assert.equal(thinking.thinking, 'private chain state');
    assert.equal(thinking.signature.includes('private chain state'), false);

    const second = await requestText(local.anthropicBaseUrl + '/v1/messages', {
      method: 'POST',
      headers,
      body: {
        model: 'chat-m',
        max_tokens: 32,
        stream: false,
        messages: [
          { role: 'user', content: 'First' },
          { role: 'assistant', content: firstMessage.content },
          { role: 'user', content: 'Continue' },
        ],
      },
    });
    assert.equal(second.status, 200);
    assert.equal(records[1].messages[1].reasoning_content, 'private chain state');
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('returns conversion 501 with a field path before resolving Provider credentials', async () => {
  const records = [];
  const profileCalls = [];
  const upstream = upstreamServer(records);
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.anthropicBaseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + local.routeToken,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: {
        model: 'chat-m',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'OK' }],
        unsupported_future_field: 'sentinel-must-not-escape',
      },
    });
    assert.equal(result.status, 501);
    assert.equal(JSON.parse(result.body).error.param, 'unsupported_future_field');
    assert.equal(result.body.includes('sentinel-must-not-escape'), false);
    assert.equal(profileCalls.length, 0);
    assert.equal(records.length, 0);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});

test('serves the frozen model list without touching Provider credentials', async () => {
  const records = [];
  const profileCalls = [];
  const upstream = upstreamServer(records);
  await listen(upstream);
  const apiRoot = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const route = makeRoute({
    apiRoot,
    records,
    capabilities: { 'native-r': 'responses', 'native-m': 'messages', 'chat-m': 'chat' },
    profileCalls,
  });
  try {
    const local = await route.start();
    const result = await requestText(local.openaiBaseUrl + '/models', {
      headers: routeHeaders(local.routeToken),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body).data.map((entry) => entry.id), [
      'native-r',
      'native-m',
      'chat-m',
    ]);
    assert.equal(profileCalls.length, 0);
  } finally {
    await route.close();
    await closeServer(upstream);
  }
});
