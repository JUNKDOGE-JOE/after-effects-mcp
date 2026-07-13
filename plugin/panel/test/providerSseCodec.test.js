import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createChatSseCollector,
  createMessagesSseCollector,
  createResponsesSseCollector,
  messagesSseEvents,
  responsesSseEvents,
} from '../src/lib/providerSseCodec.js';

function format(events) {
  return events.map(([event, data]) => (
    'event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n'
  )).join('');
}

test('strict Responses collector accepts all three explicit terminal events', () => {
  for (const status of ['completed', 'incomplete', 'failed']) {
    const response = { id: 'resp_1', object: 'response', status, model: 'm', output: [] };
    const collector = createResponsesSseCollector();
    collector.feed('event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress"}}\n\n');
    collector.feed('event: response.' + status + '\ndata: ' + JSON.stringify({
      type: 'response.' + status,
      response,
    }) + '\n\n');
    assert.deepEqual(collector.end(), response);
  }
});

test('strict Chat collector accepts bounded terminal EOF and preserves reasoning/tools', () => {
  const collector = createChatSseCollector();
  collector.feed([
    'data: {"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"hidden","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"noop","arguments":"{"}}]},"finish_reason":null,"logprobs":null}]}',
    '',
    'data: {"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]},"finish_reason":"tool_calls","logprobs":null}]}',
    '',
    '',
  ].join('\n'));
  const completion = collector.end();
  assert.equal(completion.choices[0].message.reasoning_content, 'hidden');
  assert.equal(completion.choices[0].message.tool_calls[0].function.arguments, '{}');
  assert.equal(completion.choices[0].finish_reason, 'tool_calls');
});

test('strict Chat collector accepts one final usage-only chunk before done', () => {
  const collector = createChatSseCollector();
  collector.feed([
    'data: {"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null,"logprobs":null}]}',
    '',
    'data: {"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}',
    '',
    'data: {"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n'));
  const completion = collector.end();
  assert.deepEqual(completion.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });

  const duplicate = createChatSseCollector();
  duplicate.feed([
    'data: {"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop","logprobs":null}]}',
    '',
    'data: {"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{}}',
    '',
    '',
  ].join('\n'));
  assert.throws(
    () => duplicate.feed('data: {"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{}}\n\n'),
    (error) => error.code === 'upstream_sse_malformed' && error.param === 'data.usage',
  );
});

test('strict Chat collector rejects incomplete tool JSON at clean EOF', () => {
  const collector = createChatSseCollector();
  collector.feed('data: {"id":"chat_1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"noop","arguments":"{"}}]},"finish_reason":"tool_calls","logprobs":null}]}\n\n');
  assert.throws(() => collector.end(), (error) => error.code === 'upstream_sse_truncated');
});

test('strict Responses collector rejects missing terminal and residual frames', () => {
  const missing = createResponsesSseCollector();
  missing.feed('data: {"type":"response.created","response":{"status":"in_progress"}}\n\n');
  assert.throws(() => missing.end(), (error) => error.code === 'upstream_sse_terminal_missing');

  const truncated = createResponsesSseCollector();
  truncated.feed('data: {"type":"response.completed"');
  assert.throws(() => truncated.end(), (error) => error.code === 'upstream_sse_truncated');
});

test('Messages event generation and collection round-trip text, tools, thinking, usage, and message_stop', () => {
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [
      { type: 'thinking', thinking: 'hidden', signature: 'sig' },
      { type: 'text', text: 'OK' },
      { type: 'tool_use', id: 'call_1', name: 'noop', input: { value: 1 } },
      { type: 'redacted_thinking', data: 'opaque' },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 4 },
  };
  const collector = createMessagesSseCollector();
  const source = new TextEncoder().encode(format(messagesSseEvents(message)));
  for (let offset = 0; offset < source.length; offset += 11) {
    collector.feed(source.slice(offset, offset + 11));
  }
  const result = collector.end();
  assert.equal(result.terminalMode, 'message_stop');
  assert.deepEqual(result.message, message);
});

test('Messages collector permits only bounded EOF with stop reason and all block stops', () => {
  const collector = createMessagesSseCollector();
  collector.feed([
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"usage":{}}}',
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
    '',
  ].join('\n'));
  assert.equal(collector.end().terminalMode, 'bounded_eof');

  const truncated = createMessagesSseCollector();
  truncated.feed('event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"x","usage":{}}}\n\n');
  truncated.feed('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
  truncated.feed('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}\n\n');
  assert.throws(() => truncated.end(), (error) => error.code === 'upstream_sse_truncated');
});

test('Responses event generation preserves typed output and incomplete terminal', () => {
  const response = {
    id: 'resp_1',
    object: 'response',
    status: 'incomplete',
    model: 'm',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [
      { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'opaque' },
      {
        id: 'msg_1',
        type: 'message',
        status: 'incomplete',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Partial' }],
      },
      {
        id: 'fc_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'noop',
        arguments: '{}',
      },
    ],
  };
  const events = responsesSseEvents(response);
  assert.equal(events.at(-1)[0], 'response.incomplete');
  const collector = createResponsesSseCollector();
  collector.feed(format(events));
  assert.deepEqual(collector.end(), response);
});
