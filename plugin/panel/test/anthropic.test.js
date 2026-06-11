import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendAnthropicMessage } from '../src/lib/anthropic.js';

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
    apiKey: 'sk-test',
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
