import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, sendAnthropicMessage } from '../src/lib/anthropic.js';

function sseFrame(event, data) {
  return 'event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n';
}

function streamFromText(text) {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

function requestProfile(overrides = {}) {
  return {
    providerId: 'relay',
    baseUrl: 'https://api.anthropic.com',
    allowInsecureHttp: false,
    auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' },
    extraHeaders: [],
    authProfileRevision: 1,
    ...overrides,
  };
}

test('sendAnthropicMessage parses tool input from input_json_delta after empty start input', async () => {
  const body = [
    sseFrame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'ae.newText', input: {} },
    }),
    sseFrame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"text":"Hi"}' },
    }),
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    sseFrame('message_stop', { type: 'message_stop' }),
  ].join('');

  const result = await sendAnthropicMessage({
    requestProfile: requestProfile(),
    messages: [{ role: 'user', content: 'make text' }],
    tools: [],
    fetchImpl: async () => ({ ok: true, body: streamFromText(body) }),
  });

  assert.deepEqual(result, {
    assistantMessage: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_1', name: 'ae.newText', input: { text: 'Hi' } }],
    },
    stopReason: 'tool_use',
  });
});

test('buildSystemPrompt includes ExtendScript pitfall anchors in both languages', () => {
  for (const prompt of [buildSystemPrompt('zh'), buildSystemPrompt('en')]) {
    assert.match(prompt, /AEMCP\.easeKeys/);
    assert.match(prompt, /mustFind/);
    assert.match(prompt, /matchName/);
  }
});

test('buildSystemPrompt includes runtime and file hygiene boundaries', () => {
  for (const prompt of [buildSystemPrompt('zh'), buildSystemPrompt('en')]) {
    assert.match(prompt, /Do not switch to OS screenshots/);
    assert.match(prompt, /report the MCP failure/);
    assert.match(prompt, /project workspace/);
    assert.match(prompt, /temporary files/);
  }
});

test('sendAnthropicMessage sends effort and fast-mode parameters when requested', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, body: streamFromText(sseFrame('message_stop', { type: 'message_stop' })) };
  };

  await sendAnthropicMessage({
    requestProfile: requestProfile(),
    model: 'claude-opus-4-8',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    effort: 'high',
    fast: true,
    fetchImpl,
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.output_config.effort, 'high');
  assert.equal(body.speed, 'fast');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'fast-mode-2026-02-01');
});

test('sendAnthropicMessage can target an Anthropic-compatible base URL', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, body: streamFromText(sseFrame('message_stop', { type: 'message_stop' })) };
  };

  await sendAnthropicMessage({
    requestProfile: requestProfile({ baseUrl: 'https://proxy.example/anthropic/' }),
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    fetchImpl,
  });

  assert.equal(calls[0].url, 'https://proxy.example/anthropic/v1/messages');
});

test('sendAnthropicMessage omits effort and fast fields by default', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, body: streamFromText(sseFrame('message_stop', { type: 'message_stop' })) };
  };

  await sendAnthropicMessage({
    requestProfile: requestProfile(),
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    fetchImpl,
  });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(Object.hasOwn(body, 'output_config'), false);
  assert.equal(Object.hasOwn(body, 'speed'), false);
  assert.equal(Object.hasOwn(calls[0].init.headers, 'anthropic-beta'), false);
});

test('sendAnthropicMessage maps 404 to model errors', async () => {
  await assert.rejects(
    sendAnthropicMessage({
      requestProfile: requestProfile(),
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'not_found_error' }),
    }),
    (error) => error.kind === 'model'
  );
});

test('sendAnthropicMessage materializes auth and extra headers only for fetch', async () => {
  const calls = [];
  await sendAnthropicMessage({
    requestProfile: requestProfile({
      auth: { kind: 'header', name: 'Authorization', value: 'Bearer resolved-only-for-request' },
      extraHeaders: [{ name: 'x-feature', value: 'enabled', source: 'literal' }],
    }),
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, body: streamFromText(sseFrame('message_stop', { type: 'message_stop' })) };
    },
  });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer resolved-only-for-request');
  assert.equal(calls[0].init.headers['x-feature'], 'enabled');
  assert.equal(Object.hasOwn(calls[0].init.headers, 'x-api-key'), false);
});

test('sendAnthropicMessage blocks legacy non-loopback HTTP unless the persisted profile was explicitly confirmed', async () => {
  let fetchCalls = 0;
  await assert.rejects(
    sendAnthropicMessage({
      requestProfile: requestProfile({
        baseUrl: 'http://legacy-relay.example/v1',
        allowInsecureHttp: false,
      }),
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
    }),
    (error) => error.kind === 'configuration',
  );
  assert.equal(fetchCalls, 0);
});

test('sendAnthropicMessage revalidates credential-bearing URLs immediately before fetch', async () => {
  for (const baseUrl of [
    'https://user:secret@relay.example/v1',
    'https://relay.example/v1?region=secret-value',
  ]) {
    let fetchCalls = 0;
    await assert.rejects(
      sendAnthropicMessage({
        requestProfile: requestProfile({ baseUrl }),
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        fetchImpl: async () => { fetchCalls += 1; throw new Error('must not fetch'); },
      }),
      (error) => error.kind === 'configuration',
    );
    assert.equal(fetchCalls, 0);
  }
});

test('sendAnthropicMessage fails closed on every redirect without contacting the redirect target', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const target of [
      'https://api.anthropic.com/redirect-target',
      'https://redirected.example/redirect-target',
    ]) {
      const first = 'https://api.anthropic.com/v1/messages';
      let firstRequests = 0;
      let targetRequests = 0;
      const fetchImpl = async (url, init = {}) => {
        if (url === first) {
          firstRequests += 1;
          if (init.redirect === 'manual') {
            return { ok: false, status, text: async () => '' };
          }
          return fetchImpl(target, { ...init, method: status === 303 ? 'GET' : init.method });
        }
        if (url === target) {
          targetRequests += 1;
          return { ok: true, body: streamFromText(sseFrame('message_stop', { type: 'message_stop' })) };
        }
        throw new Error('unexpected fetch target');
      };

      await assert.rejects(
        sendAnthropicMessage({
          requestProfile: requestProfile(),
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          fetchImpl,
        }),
        (error) => error.kind === 'network',
      );
      assert.equal(firstRequests, 1, `status ${status}`);
      assert.equal(targetRequests, 0, `status ${status}, target ${new URL(target).origin}`);
    }
  }
});
