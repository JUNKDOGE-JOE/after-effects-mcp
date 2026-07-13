import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  chatBodyWithDeveloperRoleAsSystem,
  chatCompletionToResponse,
  createChatSseToResponses,
  responsesBodyToChatBody,
} from '../src/lib/codexResponsesCodec.js';

function jsonFixture(name) {
  return JSON.parse(readFileSync(new URL(`./fixtures/codex/${name}`, import.meta.url), 'utf8'));
}

function textFixture(name) {
  const text = readFileSync(new URL(`./fixtures/codex/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  return name.endsWith('.sse') ? text.replace(/\n*$/, '\n\n') : text;
}

function formatSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamHarness(maxFrameBytes = 1024 * 1024, extras = {}) {
  const events = [];
  const errors = [];
  const codec = createChatSseToResponses({
    id: 'resp_fixture',
    model: 'fixture-model',
    maxFrameBytes,
    writeEvent(event, data) {
      events.push([event, data]);
    },
    fail(error) {
      errors.push(error);
    },
    ...extras,
  });
  return { codec, events, errors };
}

test('converts the complete supported Responses request without mutating it', () => {
  const request = jsonFixture('responses-request-supported.json');
  const before = structuredClone(request);
  assert.deepEqual(responsesBodyToChatBody(request), {
    model: 'fixture-model',
    messages: [
      { role: 'system', content: 'Keep the answer short.' },
      { role: 'user', content: 'Check the composition.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'ae_overview', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ],
    stream: true,
    max_tokens: 128,
    temperature: 0.2,
    top_p: 0.9,
    tools: [
      {
        type: 'function',
        function: {
          name: 'ae_overview',
          description: 'Read project state',
          parameters: { type: 'object', properties: {} },
          strict: true,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'ae_overview' } },
    parallel_tool_calls: false,
  });
  assert.deepEqual(request, before);
});

test('accepts exact no-op Responses defaults and preserves cache metadata', () => {
  assert.deepEqual(responsesBodyToChatBody({
    model: 'm',
    input: 'hello',
    reasoning: null,
    include: [],
    store: false,
    prompt_cache_key: 'cache-1',
    client_metadata: { session_id: 'session-1' },
  }), {
    model: 'm',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
    prompt_cache_key: 'cache-1',
    client_metadata: { session_id: 'session-1' },
  });
});

test('preserves developer by default and maps only that role for a system fallback', () => {
  const chatBody = responsesBodyToChatBody({
    model: 'm',
    instructions: 'Global policy.',
    input: [
      { type: 'message', role: 'developer', content: 'Follow project policy.' },
      { type: 'message', role: 'user', content: 'Continue.' },
    ],
  });
  const before = structuredClone(chatBody);

  assert.deepEqual(chatBody.messages, [
    { role: 'system', content: 'Global policy.' },
    { role: 'developer', content: 'Follow project policy.' },
    { role: 'user', content: 'Continue.' },
  ]);
  assert.deepEqual(chatBodyWithDeveloperRoleAsSystem(chatBody)?.messages, [
    { role: 'system', content: 'Global policy.' },
    { role: 'system', content: 'Follow project policy.' },
    { role: 'user', content: 'Continue.' },
  ]);
  assert.deepEqual(chatBody, before);
  assert.equal(chatBodyWithDeveloperRoleAsSystem({ ...chatBody, messages: [chatBody.messages[0]] }), null);
});

test('flattens Responses tool namespaces without dropping namespace guidance', () => {
  assert.deepEqual(responsesBodyToChatBody({
    model: 'm',
    input: 'hello',
    tools: [{
      type: 'namespace',
      name: 'mcp__ae',
      description: 'After Effects tools',
      tools: [{
        type: 'function',
        name: 'ae_overview',
        description: 'Read the project',
        parameters: { type: 'object', properties: {} },
        strict: true,
      }],
    }],
  }).tools, [{
    type: 'function',
    function: {
      name: 'ae_overview',
      description: 'After Effects tools\n\nRead the project',
      parameters: { type: 'object', properties: {} },
      strict: true,
    },
  }]);
});

test('converts a complete non-streaming Chat completion into a Response', () => {
  assert.deepEqual(
    chatCompletionToResponse(jsonFixture('chat-completion.json'), {
      id: 'resp_fixture',
      model: 'fixture-model',
    }),
    {
      id: 'resp_fixture',
      object: 'response',
      status: 'completed',
      model: 'fixture-model',
      output: [
        {
          id: 'msg_fixture',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Composition checked.' }],
        },
        {
          type: 'function_call',
          id: 'fc_call_2',
          call_id: 'call_2',
          name: 'ae_layers',
          arguments: '{"comp_id":1}',
          status: 'completed',
        },
      ],
    },
  );
});

test('maps a non-streaming Chat length terminal to response.incomplete', () => {
  const response = chatCompletionToResponse({
    id: 'chat_length',
    object: 'chat.completion',
    created: 1,
    model: 'fixture-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'Partial' },
      finish_reason: 'length',
      logprobs: null,
    }],
  }, { id: 'resp_length', model: 'fixture-model' });
  assert.equal(response.status, 'incomplete');
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(response.output[0].status, 'incomplete');
});

test('round-trips Chat reasoning through an opaque Responses capsule', () => {
  const stored = new Map();
  const sealReasoning = (payload) => {
    const token = `capsule-${stored.size + 1}`;
    stored.set(token, payload);
    return token;
  };
  const openReasoning = (token, expected) => {
    const payload = stored.get(token);
    assert.equal(payload.sourceProtocol, expected.sourceProtocol);
    return payload;
  };
  const response = chatCompletionToResponse({
    id: 'chat_reasoning',
    object: 'chat.completion',
    created: 1,
    model: 'deepseek-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        reasoning_content: 'private chain state',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
      logprobs: null,
    }],
  }, { id: 'resp_reasoning', model: 'deepseek-model' }, { sealReasoning });
  assert.equal(response.output[0].type, 'reasoning');
  assert.equal(JSON.stringify(response).includes('private chain state'), false);
  const replay = responsesBodyToChatBody({
    model: 'deepseek-model',
    input: [
      response.output[0],
      response.output[1],
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      { role: 'user', content: 'Continue.' },
    ],
    include: ['reasoning.encrypted_content'],
  }, { openReasoning });
  assert.equal(replay.messages[0].reasoning_content, 'private chain state');
  assert.equal(replay.messages[0].tool_calls[0].id, 'call_1');
});

const unsupportedRequests = [
  ['image input', jsonFixture('responses-request-unsupported-image.json'), 'input[0].content[0].type'],
  ['audio input', { model: 'm', input: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }] }] }, 'input[0].content[0].type'],
  ['file input', { model: 'm', input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }] }, 'input[0].content[0].type'],
  ['hosted tool', { model: 'm', input: 'x', tools: [{ type: 'web_search_preview' }] }, 'tools[0].type'],
  ['conversation', { model: 'm', input: 'x', conversation: 'c1' }, 'conversation'],
  ['previous response', { model: 'm', input: 'x', previous_response_id: 'r1' }, 'previous_response_id'],
  ['background', { model: 'm', input: 'x', background: true }, 'background'],
  ['reasoning configuration', { model: 'm', input: 'x', reasoning: { effort: 'high' } }, 'reasoning'],
  ['non-empty include', { model: 'm', input: 'x', include: ['reasoning.encrypted_content'] }, 'include'],
  ['stored response', { model: 'm', input: 'x', store: true }, 'store'],
  ['unknown top-level field', { model: 'm', input: 'x', extra_field: false }, 'extra_field'],
  ['unknown output item', { model: 'm', input: [{ type: 'computer_call', id: 'item_1' }] }, 'input[0].type'],
  ['reasoning item', { model: 'm', input: [{ type: 'reasoning', summary: [] }] }, 'input[0].type'],
  ['unknown function tool field', { model: 'm', input: 'x', tools: [{ type: 'function', name: 'f', parameters: {}, extra: true }] }, 'tools[0].extra'],
];

const invalidRequests = [
  ['non-string function arguments', { model: 'm', input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: {} }] }, 'input[0].arguments'],
  ['invalid function arguments', { model: 'm', input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{' }] }, 'input[0].arguments'],
  ['malformed function output', { model: 'm', input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: { ok: true } }] }, 'input[1].output'],
  ['missing model', { input: 'x' }, 'model'],
  ['missing input', { model: 'm' }, 'input'],
  ['invalid stream', { model: 'm', input: 'x', stream: 'true' }, 'stream'],
  ['invalid include', { model: 'm', input: 'x', include: null }, 'include'],
  ['invalid store', { model: 'm', input: 'x', store: 'false' }, 'store'],
  ['invalid prompt cache key', { model: 'm', input: 'x', prompt_cache_key: '' }, 'prompt_cache_key'],
  ['invalid client metadata', { model: 'm', input: 'x', client_metadata: [] }, 'client_metadata'],
  ['out-of-range temperature', { model: 'm', input: 'x', temperature: 3 }, 'temperature'],
  ['duplicate tools', { model: 'm', input: 'x', tools: [{ type: 'function', name: 'f', parameters: {} }, { type: 'function', name: 'f', parameters: {} }] }, 'tools'],
  ['tool choice without tools', { model: 'm', input: 'x', tool_choice: 'required' }, 'tool_choice'],
  ['invalid tool choice', { model: 'm', input: 'x', tools: [{ type: 'function', name: 'f', parameters: {} }], tool_choice: 'sometimes' }, 'tool_choice'],
];

for (const [name, body, param] of unsupportedRequests) {
  test(`returns compatibility 501 for ${name}`, () => {
    assert.throws(
      () => responsesBodyToChatBody(body),
      (error) => error.name === 'ResponsesCompatibilityError'
        && error.status === 501
        && error.code === 'unsupported_responses_field'
        && error.param === param
        && error.message === `Unsupported Responses field: ${param}`,
    );
  });
}

for (const [name, body, param] of invalidRequests) {
  test(`keeps malformed ${name} at 400`, () => {
    assert.throws(
      () => responsesBodyToChatBody(body),
      (error) => error.name === 'ResponsesCompatibilityError'
        && error.status === 400
        && error.code === 'invalid_responses_field'
        && error.param === param
        && error.message === `Invalid Responses field: ${param}`,
    );
  });
}

test('rejects malformed non-streaming Chat tool calls', () => {
  const chat = jsonFixture('chat-completion.json');
  chat.choices[0].message.tool_calls[0].function.arguments = { comp_id: 1 };
  assert.throws(
    () => chatCompletionToResponse(chat, { id: 'resp_fixture', model: 'fixture-model' }),
    (error) => error.code === 'invalid_chat_completion'
      && error.param === 'choices[0].message.tool_calls[0].function.arguments',
  );
});

test('converts arbitrarily chunked UTF-8 Chat SSE into the exact Responses event stream', () => {
  const source = new TextEncoder().encode(textFixture('chat-completion.sse'));
  const { codec, events, errors } = streamHarness();
  for (let offset = 0; offset < source.length; offset += 17) {
    codec.feed(source.slice(offset, offset + 17));
  }
  codec.end();
  assert.deepEqual(errors, []);
  assert.equal(events.map(([event, data]) => formatSse(event, data)).join(''), textFixture('responses-stream.expected.sse'));
});

test('hands malformed JSON and malformed tool deltas to the route boundary', () => {
  const malformedJson = streamHarness();
  malformedJson.codec.feed('data: {not-json}\n\n');
  assert.equal(malformedJson.errors.length, 1);
  assert.equal(malformedJson.errors[0].code, 'upstream_sse_malformed');

  const malformedTool = streamHarness();
  malformedTool.codec.feed('data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"f","arguments":{}}}]},"finish_reason":null}]}\n\n');
  assert.equal(malformedTool.errors.length, 1);
  assert.equal(malformedTool.errors[0].code, 'upstream_sse_malformed');
  assert.equal(malformedTool.errors[0].param, 'choices[0].delta.tool_calls[0].function.arguments');
});

test('enforces the SSE frame byte boundary before JSON parsing', () => {
  const frame = 'data: {"object":"chat.completion.chunk","choices":[],"usage":{}}';
  const byteLength = new TextEncoder().encode(frame).byteLength;
  const accepted = streamHarness(byteLength);
  accepted.codec.feed(`${frame}\n\n`);
  assert.deepEqual(accepted.errors, []);

  const rejected = streamHarness(byteLength - 1);
  rejected.codec.feed(`${frame}\n\n`);
  assert.equal(rejected.errors.length, 1);
  assert.equal(rejected.errors[0].code, 'upstream_sse_frame_too_large');
});

test('rejects a truncated stream instead of manufacturing response.completed', () => {
  const { codec, events, errors } = streamHarness();
  codec.feed('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
  codec.end();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'upstream_sse_malformed');
  assert.equal(events.some(([event]) => event === 'response.completed'), false);
});

test('accepts terminal Chat EOF only after a complete supported finish reason', () => {
  const { codec, events, errors } = streamHarness();
  codec.feed('data: {"id":"chat_eof","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop","logprobs":null}]}\n\n');
  codec.end();
  assert.deepEqual(errors, []);
  assert.equal(events.at(-1)[0], 'response.completed');
  assert.equal(events.at(-1)[1].response.status, 'completed');
});

test('maps a streamed Chat length terminal to response.incomplete', () => {
  const { codec, events, errors } = streamHarness();
  codec.feed('data: {"id":"chat_length","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"length","logprobs":null}]}\n\ndata: [DONE]\n\n');
  codec.end();
  assert.deepEqual(errors, []);
  assert.equal(events.at(-1)[0], 'response.incomplete');
  assert.equal(events.at(-1)[1].response.status, 'incomplete');
  assert.deepEqual(events.at(-1)[1].response.incomplete_details, { reason: 'max_output_tokens' });
});

test('seals streamed Chat reasoning before emitting the Responses terminal', () => {
  const { codec, events, errors } = streamHarness(1024 * 1024, {
    sealReasoning: ({ sourceProtocol, item }) => `${sourceProtocol}:${item.length}`,
  });
  codec.feed('data: {"id":"chat_reasoning","object":"chat.completion.chunk","created":1,"model":"fixture-model","choices":[{"index":0,"delta":{"reasoning_content":"hidden","content":"ok"},"finish_reason":"stop","logprobs":null}]}\n\ndata: [DONE]\n\n');
  codec.end();
  assert.deepEqual(errors, []);
  const terminal = events.at(-1)[1].response;
  assert.equal(terminal.output[0].type, 'reasoning');
  assert.equal(terminal.output[0].encrypted_content, 'chat:6');
  assert.equal(JSON.stringify(terminal).includes('hidden'), false);
});
