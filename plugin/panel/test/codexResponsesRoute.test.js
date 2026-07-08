import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCodexResponsesRoute, responsesBodyToChatBody } from '../src/cep/codexResponsesRoute.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function requestText(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(url);
    const req = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname + endpoint.search,
      method,
      headers,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

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

test('createCodexResponsesRoute adapts streaming Responses requests to chat completions', async () => {
  const upstreamCalls = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      upstreamCalls.push({ path: req.url, headers: req.headers, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"CODEX_"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"ROUTE_OK"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  const route = createCodexResponsesRoute({
    requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: 'sk-upstream',
    authScheme: 'bearer',
  });

  try {
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    await route.close();
    await close(upstream);
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
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"ae_status","arguments":"{"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const upstreamPort = await listen(upstream);
  const route = createCodexResponsesRoute({
    requireImpl: (name) => { if (name === 'http') return http; throw new Error('unexpected module ' + name); },
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: 'sk-upstream',
    authScheme: 'bearer',
  });

  try {
    const local = await route.start();
    const result = await requestText(`${local.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    await route.close();
    await close(upstream);
  }
});

