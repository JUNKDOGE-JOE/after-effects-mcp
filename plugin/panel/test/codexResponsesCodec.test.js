import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
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

function streamHarness(maxFrameBytes = 1024 * 1024) {
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

const rejectedRequests = [
  ['image input', jsonFixture('responses-request-unsupported-image.json'), 'input[0].content[0].type'],
  ['audio input', { model: 'm', input: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }] }] }, 'input[0].content[0].type'],
  ['file input', { model: 'm', input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file_1' }] }] }, 'input[0].content[0].type'],
  ['hosted tool', { model: 'm', input: 'x', tools: [{ type: 'web_search_preview' }] }, 'tools[0].type'],
  ['conversation', { model: 'm', input: 'x', conversation: 'c1' }, 'conversation'],
  ['previous response', { model: 'm', input: 'x', previous_response_id: 'r1' }, 'previous_response_id'],
  ['background', { model: 'm', input: 'x', background: true }, 'background'],
  ['reasoning configuration', { model: 'm', input: 'x', reasoning: { effort: 'high' } }, 'reasoning'],
  ['unknown top-level field', { model: 'm', input: 'x', store: false }, 'store'],
  ['unknown output item', { model: 'm', input: [{ type: 'computer_call', id: 'item_1' }] }, 'input[0].type'],
  ['reasoning item', { model: 'm', input: [{ type: 'reasoning', summary: [] }] }, 'input[0].type'],
  ['non-string function arguments', { model: 'm', input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: {} }] }, 'input[0].arguments'],
  ['invalid function arguments', { model: 'm', input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{' }] }, 'input[0].arguments'],
  ['malformed function output', { model: 'm', input: [{ type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: { ok: true } }] }, 'input[1].output'],
  ['unknown function tool field', { model: 'm', input: 'x', tools: [{ type: 'function', name: 'f', parameters: {}, extra: true }] }, 'tools[0].extra'],
];

for (const [name, body, param] of rejectedRequests) {
  test(`rejects ${name}`, () => {
    assert.throws(
      () => responsesBodyToChatBody(body),
      (error) => error.name === 'ResponsesCompatibilityError'
        && error.status === 400
        && error.code === 'unsupported_responses_field'
        && error.param === param
        && error.message === `Unsupported Responses field: ${param}`,
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
