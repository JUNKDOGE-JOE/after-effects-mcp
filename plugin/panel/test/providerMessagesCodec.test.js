import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  anthropicMessageToResponse,
  chatCompletionToMessages,
  messagesBodyToChatBody,
  messagesBodyToResponsesBody,
  responseToMessages,
  responsesBodyToMessagesBody,
} from '../src/lib/providerMessagesCodec.js';

function capsulePair() {
  const values = new Map();
  return {
    seal({ sourceProtocol, item }) {
      const token = `capsule-${values.size + 1}`;
      values.set(token, { version: 1, sourceProtocol, item: structuredClone(item) });
      return token;
    },
    open(token, { sourceProtocol }) {
      const value = values.get(token);
      if (!value || value.sourceProtocol !== sourceProtocol) throw new Error('capsule mismatch');
      return structuredClone(value);
    },
  };
}

function claudeCodeMinimalBody() {
  return {
    model: 'claude-test',
    max_tokens: 32000,
    stream: true,
    context_management: {
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    },
    output_config: { effort: 'max' },
    thinking: { type: 'adaptive' },
    metadata: { user_id: '{"device_id":"hash","session_id":"session"}' },
    system: [
      { type: 'text', text: 'first', cache_control: null },
      { type: 'text', text: 'second', cache_control: { type: 'ephemeral' } },
    ],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'text', text: '', cache_control: null },
      ],
    }],
  };
}

test('Claude Code minimal Messages defaults convert to Chat with explicit consumed paths', () => {
  const converted = messagesBodyToChatBody(claudeCodeMinimalBody());

  assert.deepEqual(converted.body, {
    model: 'claude-test',
    max_tokens: 32000,
    stream: true,
    reasoning_effort: 'xhigh',
    messages: [
      { role: 'system', content: 'first' },
      { role: 'system', content: 'second' },
      { role: 'user', content: 'hello' },
    ],
  });
  assert.deepEqual(converted.consumed, [
    'context_management',
    'messages[0].content[1].cache_control',
    'metadata',
    'system[0].cache_control',
    'system[1].cache_control',
  ]);
});

test('Claude Code minimal Messages defaults convert to Responses without losing system blocks', () => {
  const converted = messagesBodyToResponsesBody(claudeCodeMinimalBody());

  assert.deepEqual(converted.body, {
    model: 'claude-test',
    max_output_tokens: 32000,
    stream: true,
    reasoning: { effort: 'xhigh' },
    input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'first' }] },
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'second' }] },
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'hello' },
        { type: 'input_text', text: '' },
      ] },
    ],
  });
  assert.ok(converted.consumed.includes('context_management'));
  assert.ok(converted.consumed.includes('metadata'));
});

test('Messages text and base64 or URL images map to both OpenAI request dialects', () => {
  const body = {
    model: 'vision-model',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect' },
        { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
      ],
    }],
  };

  assert.deepEqual(messagesBodyToChatBody(body).body.messages[0].content, [
    { type: 'text', text: 'inspect' },
    { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } },
  ]);
  assert.deepEqual(messagesBodyToResponsesBody(body).body.input[0].content, [
    { type: 'input_text', text: 'inspect' },
    { type: 'input_image', image_url: 'https://example.test/a.png' },
    { type: 'input_image', image_url: 'data:image/png;base64,YWJj' },
  ]);
});

function toolConversation() {
  return {
    model: 'tool-model',
    max_tokens: 256,
    tools: [
      {
        name: 'first_tool',
        description: 'first',
        input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
        strict: true,
        cache_control: { type: 'ephemeral' },
      },
      {
        name: 'second_tool',
        input_schema: { type: 'object', properties: {} },
      },
    ],
    tool_choice: { type: 'auto', disable_parallel_tool_use: false },
    messages: [
      { role: 'user', content: 'run both' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 'call-1', name: 'first_tool', input: { x: 1 } },
          { type: 'tool_use', id: 'call-2', name: 'second_tool', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'one', is_error: false },
          { type: 'tool_result', tool_use_id: 'call-2', content: [{ type: 'text', text: 'failed' }], is_error: true },
          { type: 'text', text: 'continue' },
        ],
      },
    ],
  };
}

test('parallel tool_use and tool_result turns preserve ids, arguments, and error semantics', () => {
  const chat = messagesBodyToChatBody(toolConversation());
  const assistant = chat.body.messages[1];
  assert.equal(chat.body.parallel_tool_calls, true);
  assert.deepEqual(assistant.tool_calls.map((call) => call.id), ['call-1', 'call-2']);
  assert.equal(chat.body.messages[2].content, 'one');
  assert.equal(chat.body.messages[3].content, '[tool_error]\nfailed');
  assert.deepEqual(chat.body.messages[4], { role: 'user', content: 'continue' });
  assert.ok(chat.consumed.includes('messages[2].content[0].is_error'));
  assert.ok(chat.consumed.includes('messages[2].content[1].is_error'));
  assert.ok(chat.consumed.includes('tools[0].cache_control'));

  const responses = messagesBodyToResponsesBody(toolConversation());
  assert.equal(responses.body.parallel_tool_calls, true);
  assert.deepEqual(
    responses.body.input.filter((item) => item.type === 'function_call').map((item) => item.call_id),
    ['call-1', 'call-2'],
  );
  assert.deepEqual(
    responses.body.input.filter((item) => item.type === 'function_call_output').map((item) => item.output),
    ['one', '[tool_error]\nfailed'],
  );
});

test('Responses requests convert system, image, function calls, outputs, and parallel policy to Messages', () => {
  const converted = responsesBodyToMessagesBody({
    model: 'responses-model',
    instructions: 'system',
    max_output_tokens: 200,
    stream: true,
    parallel_tool_calls: false,
    tools: [{ type: 'function', name: 'inspect', description: 'inspect', parameters: { type: 'object' }, strict: true }],
    tool_choice: 'auto',
    store: false,
    prompt_cache_key: 'cache-key',
    client_metadata: { trace: 'one' },
    reasoning: { effort: 'xhigh', summary: 'auto' },
    input: [
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: 'data:image/png;base64,YWJj', detail: 'auto' },
      ] },
      { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'inspect', arguments: '{"x":1}', status: 'completed' },
      { type: 'function_call_output', id: 'out-1', call_id: 'call-1', output: 'ok', status: 'completed' },
    ],
  });

  assert.equal(converted.body.max_tokens, 200);
  assert.deepEqual(converted.body.system, [{ type: 'text', text: 'system' }]);
  assert.deepEqual(converted.body.messages[0].content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'YWJj' },
  });
  assert.deepEqual(converted.body.messages[1].content, [
    { type: 'tool_use', id: 'call-1', name: 'inspect', input: { x: 1 } },
  ]);
  assert.deepEqual(converted.body.messages[2].content, [
    { type: 'tool_result', tool_use_id: 'call-1', content: 'ok' },
  ]);
  assert.deepEqual(converted.body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
  assert.deepEqual(converted.body.thinking, { type: 'adaptive' });
  assert.deepEqual(converted.body.output_config, { effort: 'max' });
  for (const path of [
    'client_metadata',
    'include',
    'input[0].content[1].detail',
    'input[1].id',
    'input[1].status',
    'input[2].id',
    'input[2].status',
    'prompt_cache_key',
    'reasoning.summary',
    'store',
  ]) {
    if (path !== 'include') assert.ok(converted.consumed.includes(path), path);
  }
});

test('Responses tool namespaces flatten into Messages tools without dropping namespace guidance', () => {
  const converted = responsesBodyToMessagesBody({
    model: 'responses-model',
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
  });

  assert.deepEqual(converted.body.tools, [{
    name: 'ae_overview',
    description: 'After Effects tools\n\nRead the project',
    input_schema: { type: 'object', properties: {} },
    strict: true,
  }]);
});

test('request codecs use structured 400 and compact 501 errors with exact field paths', () => {
  assert.throws(
    () => messagesBodyToChatBody({
      model: 'm',
      max_tokens: 'bad',
      messages: [{ role: 'user', content: 'x' }],
    }),
    (error) => error.status === 400
      && error.code === 'invalid_messages_field'
      && error.param === 'max_tokens',
  );
  assert.throws(
    () => messagesBodyToChatBody({
      model: 'm',
      max_tokens: 10,
      messages: [{ role: 'user', content: [{ type: 'audio', data: 'x' }] }],
    }),
    (error) => error.status === 501
      && error.code === 'unsupported_messages_field'
      && error.param === 'messages[0].content[0].type',
  );
  assert.throws(
    () => responsesBodyToMessagesBody({
      model: 'm',
      input: 'x',
      previous_response_id: 'resp-old',
    }),
    (error) => error.status === 501
      && error.code === 'unsupported_responses_field'
      && error.param === 'previous_response_id',
  );
});

test('Chat reasoning and usage round-trip through an authenticated Messages capsule', () => {
  const capsule = capsulePair();
  const completion = {
    id: 'chat-1',
    object: 'chat.completion',
    created: 1,
    model: 'chat-model',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'answer', reasoning_content: 'private reasoning' },
      finish_reason: 'stop',
      logprobs: null,
    }],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 4,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 2, text_tokens: 12, audio_tokens: 0, image_tokens: 0 },
      completion_tokens_details: {
        reasoning_tokens: 2,
        text_tokens: 4,
        audio_tokens: 0,
        image_tokens: 0,
      },
      input_tokens: 0,
      output_tokens: 0,
      input_tokens_details: null,
      claude_cache_creation_5_m_tokens: 1,
      claude_cache_creation_1_h_tokens: 2,
    },
  };
  const message = chatCompletionToMessages(completion, { sealReasoning: capsule.seal });

  assert.deepEqual(message.content[0], {
    type: 'thinking',
    thinking: 'private reasoning',
    signature: 'capsule-1',
  });
  assert.deepEqual(message.usage, {
    input_tokens: 7,
    output_tokens: 4,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 2,
    cache_creation: {
      ephemeral_5m_input_tokens: 1,
      ephemeral_1h_input_tokens: 2,
    },
    output_tokens_details: { thinking_tokens: 2 },
  });
  const replay = messagesBodyToChatBody({
    model: 'chat-model',
    max_tokens: 100,
    messages: [
      { role: 'assistant', content: message.content },
      { role: 'user', content: 'next' },
    ],
  }, { openReasoning: capsule.open });
  assert.equal(replay.body.messages[0].reasoning_content, 'private reasoning');

  const conflicting = structuredClone(completion);
  conflicting.usage.input_tokens = 11;
  assert.throws(
    () => chatCompletionToMessages(conflicting, { sealReasoning: capsule.seal }),
    (error) => error.status === 502 && error.param === 'usage.input_tokens',
  );
});

test('Responses reasoning, text, parallel tools, stop, and usage convert to Messages and replay', () => {
  const capsule = capsulePair();
  const reasoningItem = {
    id: 'rs-1',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'summary' }],
    encrypted_content: 'opaque-upstream-value',
    status: 'completed',
  };
  const message = responseToMessages({
    id: 'resp-1',
    object: 'response',
    status: 'completed',
    model: 'responses-model',
    output: [
      reasoningItem,
      {
        id: 'msg-1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
      },
      { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'one', arguments: '{}', status: 'completed' },
      { type: 'function_call', id: 'fc-2', call_id: 'call-2', name: 'two', arguments: '{"v":2}', status: 'completed' },
    ],
    usage: {
      input_tokens: 20,
      output_tokens: 8,
      total_tokens: 28,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 3 },
    },
  }, { sealReasoning: capsule.seal });

  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.content[0], { type: 'thinking', thinking: 'summary', signature: 'capsule-1' });
  assert.deepEqual(message.content.filter((block) => block.type === 'tool_use').map((block) => block.id), ['call-1', 'call-2']);
  assert.deepEqual(message.usage, {
    input_tokens: 15,
    output_tokens: 8,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 5,
  });

  const replay = messagesBodyToResponsesBody({
    model: 'responses-model',
    max_tokens: 100,
    messages: [
      { role: 'assistant', content: message.content },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call-1', content: 'one' },
        { type: 'tool_result', tool_use_id: 'call-2', content: 'two' },
      ] },
    ],
  }, { openReasoning: capsule.open });
  assert.deepEqual(replay.body.input[0], reasoningItem);
});

test('Anthropic thinking is sealed into a Responses capsule and restores without parsing opaque data', () => {
  const capsule = capsulePair();
  const thinking = { type: 'thinking', thinking: 'hidden', signature: 'opaque-native-signature' };
  const redacted = { type: 'redacted_thinking', data: 'opaque-native-redacted' };
  const response = anthropicMessageToResponse({
    id: 'msg-9',
    type: 'message',
    role: 'assistant',
    model: 'messages-model',
    content: [thinking, redacted, { type: 'text', text: 'done', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation: {
        ephemeral_1h_input_tokens: 1,
        ephemeral_5m_input_tokens: 1,
      },
      output_tokens_details: { thinking_tokens: 2 },
    },
  }, { id: 'resp-9', sealReasoning: capsule.seal });

  assert.equal(response.id, 'resp-9');
  assert.deepEqual(response.usage, {
    input_tokens: 15,
    output_tokens: 4,
    total_tokens: 19,
    input_tokens_details: { cached_tokens: 3 },
    output_tokens_details: { reasoning_tokens: 2 },
  });
  const restored = responsesBodyToMessagesBody({
    model: 'messages-model',
    input: response.output,
    max_output_tokens: 100,
  }, { openReasoning: capsule.open });
  assert.deepEqual(restored.body.messages[0].content[0], thinking);
  assert.deepEqual(restored.body.messages[0].content[1], redacted);
  assert.equal(restored.body.messages[0].content[2].text, 'done');

  assert.throws(
    () => anthropicMessageToResponse({
      id: 'msg-cache-mismatch',
      type: 'message',
      role: 'assistant',
      model: 'messages-model',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_creation_input_tokens: 2,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 1,
        },
      },
    }),
    (error) => error.status === 502 && error.param === 'usage.cache_creation',
  );
});

test('Anthropic tool terminal state must agree with emitted tool calls', () => {
  const response = anthropicMessageToResponse({
    id: 'msg-tool',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } }],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 2, output_tokens: 1 },
  });
  assert.deepEqual(response.output[0], {
    id: 'fc_call-1',
    type: 'function_call',
    call_id: 'call-1',
    name: 'lookup',
    arguments: '{"q":"x"}',
    status: 'completed',
  });
  assert.throws(
    () => anthropicMessageToResponse({
      id: 'msg-tool-mismatch',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: {} }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    }),
    (error) => error.status === 502 && error.param === 'stop_reason',
  );
});

test('max-token terminal reasons map in both response directions', () => {
  const messages = responseToMessages({
    id: 'resp-limit',
    object: 'response',
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    model: 'm',
    output: [{
      id: 'msg-limit',
      type: 'message',
      status: 'incomplete',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'partial' }],
    }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
  assert.equal(messages.stop_reason, 'max_tokens');

  const response = anthropicMessageToResponse({
    id: 'msg-limit',
    type: 'message',
    role: 'assistant',
    model: 'm',
    content: [{ type: 'text', text: 'partial' }],
    stop_reason: 'max_tokens',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  });
  assert.equal(response.status, 'incomplete');
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
});

test('non-stream response converters reject unknown response fields instead of dropping them', () => {
  assert.throws(
    () => chatCompletionToMessages({
      id: 'chat',
      object: 'chat.completion',
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok', vendor_field: true }, finish_reason: 'stop' }],
    }),
    (error) => error.status === 502 && error.param === 'choices[0].message.vendor_field',
  );
  assert.throws(
    () => anthropicMessageToResponse({
      id: 'msg',
      type: 'message',
      role: 'assistant',
      model: 'm',
      content: [{ type: 'server_tool_use', id: 'x' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    (error) => error.status === 501 && error.param === 'content[0].type',
  );
});
