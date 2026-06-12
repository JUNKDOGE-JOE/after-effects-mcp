import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/lib/sse.js';
import { createAgentLoop } from '../src/lib/agentLoop.js';

function sseFrame(event, data) {
  return 'event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n';
}

function textTurn(text, stopReason = 'end_turn') {
  return [
    sseFrame('message_start', { type: 'message_start' }),
    sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason } }),
    sseFrame('message_stop', { type: 'message_stop' }),
  ].join('');
}

function toolTurn({ id = 'tu_1', name = 'ae.newText', input = { text: 'Hi' } } = {}) {
  const json = JSON.stringify(input);
  return [
    sseFrame('message_start', { type: 'message_start' }),
    sseFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } }),
    sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(0, 5) } }),
    sseFrame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(5) } }),
    sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sseFrame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    sseFrame('message_stop', { type: 'message_stop' }),
  ].join('');
}

function anthropicFromSse(turns, calls = []) {
  return async function fakeAnthropic(options) {
    calls.push({ ...options, messages: structuredClone(options.messages), tools: options.tools });
    const sse = turns.shift();
    if (!sse) throw new Error('No fake Anthropic turn queued');

    const blocks = new Map();
    let stopReason = 'end_turn';
    const parser = createSseParser(({ data }) => {
      if (data.type === 'content_block_start') {
        const block = data.content_block;
        if (block.type === 'text') blocks.set(data.index, { type: 'text', text: block.text || '' });
        if (block.type === 'tool_use') blocks.set(data.index, { type: 'tool_use', id: block.id, name: block.name, inputJson: '' });
      }
      if (data.type === 'content_block_delta') {
        const block = blocks.get(data.index);
        if (data.delta.type === 'text_delta') {
          block.text += data.delta.text;
          options.onTextDelta(data.delta.text);
        }
        if (data.delta.type === 'input_json_delta') block.inputJson += data.delta.partial_json;
      }
      if (data.type === 'message_delta') stopReason = data.delta.stop_reason;
    });
    parser.feed(sse);

    const content = Array.from(blocks.values()).map((block) => {
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: JSON.parse(block.inputJson || '{}') };
      }
      return block;
    });
    return { assistantMessage: { role: 'assistant', content }, stopReason };
  };
}

function makeMcp({ tools, resultText = 'ok', isError = false } = {}) {
  const calls = [];
  return {
    calls,
    listTools: async () => tools || [
      { name: 'ae.overview', description: 'read', inputSchema: {}, annotations: { readOnlyHint: true } },
      { name: 'ae.newText', description: 'write', inputSchema: {}, annotations: { readOnlyHint: false } },
      { name: 'ae.exec', description: 'danger', inputSchema: {}, annotations: { destructiveHint: true } },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: resultText }], isError };
    },
  };
}

function makeLoop({ anthropic, mcp = makeMcp(), mode = 'none', events = [], getEffort, getFast }) {
  return createAgentLoop({
    getApiKey: () => 'sk-test',
    getModel: () => 'claude-sonnet-4-6',
    getPermissionMode: () => mode,
    getEffort,
    getFast,
    mcp,
    anthropic,
    onEvent: (evt) => events.push(evt),
  });
}

async function waitFor(events, type) {
  for (let i = 0; i < 50; i++) {
    const found = events.find((evt) => evt.type === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for ' + type);
}

test('createAgentLoop streams a pure text turn into history', async () => {
  const events = [];
  const loop = makeLoop({ anthropic: anthropicFromSse([textTurn('Hello')]), events });

  await loop.sendUser('Say hi');

  assert.deepEqual(events.map((evt) => evt.type), ['turn-start', 'text-delta', 'turn-end']);
  assert.equal(events[1].text, 'Hello');
  assert.equal(events[2].stopReason, 'end_turn');
  assert.deepEqual(loop.getMessages(), [
    { role: 'user', content: 'Say hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
  ]);
});

test('createAgentLoop runs a tool directly and continues after tool_result', async () => {
  const events = [];
  const calls = [];
  const mcp = makeMcp();
  const loop = makeLoop({ anthropic: anthropicFromSse([toolTurn(), textTurn('Done')], calls), mcp, mode: 'auto', events });

  await loop.sendUser('Create text');

  assert.deepEqual(mcp.calls, [{ name: 'ae.newText', args: { text: 'Hi' } }]);
  assert.deepEqual(events.map((evt) => evt.type), ['turn-start', 'tool-start', 'tool-result', 'text-delta', 'turn-end']);
  assert.equal(calls[1].messages.at(-1).content[0].type, 'tool_result');
  assert.equal(calls[1].messages.at(-1).content[0].content, 'ok');
});

test('createAgentLoop waits for manual approval and resumes on allow', async () => {
  const events = [];
  const mcp = makeMcp();
  const loop = makeLoop({ anthropic: anthropicFromSse([toolTurn(), textTurn('Allowed')]), mcp, mode: 'manual', events });

  const pending = loop.sendUser('Create text');
  const approval = await waitFor(events, 'approval-required');
  loop.approve(approval.toolUseId, 'allow');
  await pending;

  assert.equal(approval.risk, 'write');
  assert.deepEqual(mcp.calls, [{ name: 'ae.newText', args: { text: 'Hi' } }]);
  assert.equal(events.find((evt) => evt.type === 'tool-result').ok, true);
});

test('createAgentLoop sends denied tool_result back to the model', async () => {
  const events = [];
  const calls = [];
  const loop = makeLoop({ anthropic: anthropicFromSse([toolTurn(), textTurn('Denied noted')], calls), mode: 'manual', events });

  const pending = loop.sendUser('Create text');
  const approval = await waitFor(events, 'approval-required');
  loop.approve(approval.toolUseId, 'deny');
  await pending;

  const result = calls[1].messages.at(-1).content[0];
  assert.equal(result.type, 'tool_result');
  assert.equal(result.is_error, true);
  assert.equal(result.content, 'User denied this action.');
  assert.equal(events.some((evt) => evt.type === 'tool-denied'), true);
});

test('createAgentLoop allow-session lets the same tool run directly later', async () => {
  const events = [];
  const mcp = makeMcp();
  const loop = makeLoop({
    anthropic: anthropicFromSse([toolTurn({ id: 'tu_1' }), textTurn('One'), toolTurn({ id: 'tu_2' }), textTurn('Two')]),
    mcp,
    mode: 'manual',
    events,
  });

  const first = loop.sendUser('First');
  const approval = await waitFor(events, 'approval-required');
  loop.approve(approval.toolUseId, 'allow-session');
  await first;
  await loop.sendUser('Second');

  assert.equal(events.filter((evt) => evt.type === 'approval-required').length, 1);
  assert.equal(mcp.calls.length, 2);
});

test('createAgentLoop stop aborts fetch and keeps only the user message', async () => {
  const events = [];
  const anthropic = async ({ signal, onTextDelta }) => {
    onTextDelta('partial');
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const loop = makeLoop({ anthropic, events });

  const pending = loop.sendUser('Long task');
  await waitFor(events, 'text-delta');
  loop.stop();
  await pending;

  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).kind, 'aborted');
  assert.deepEqual(loop.getMessages(), [{ role: 'user', content: 'Long task' }]);
});

test('createAgentLoop stops after 25 consecutive tool rounds', async () => {
  const events = [];
  const mcp = makeMcp();
  const turns = Array.from({ length: 25 }, (_, i) => toolTurn({ id: 'tu_' + i, name: 'ae.overview', input: { i } }));
  const loop = makeLoop({ anthropic: anthropicFromSse(turns), mcp, mode: 'none', events });

  await loop.sendUser('Loop tools');

  const error = events.find((evt) => evt.type === 'error');
  assert.equal(error.kind, 'mcp');
  assert.match(error.message, /25/);
  assert.equal(mcp.calls.length, 25);
});

test('createAgentLoop repairs dangling tool_use when stopped during approval', async () => {
  const events = [];
  const turns = [toolTurn({ id: 'tu_stop', name: 'ae.newText' }), textTurn('Done.')];
  const calls = [];
  const loop = makeLoop({ anthropic: anthropicFromSse(turns, calls), mode: 'manual', events });

  const run = loop.sendUser('make a layer');
  await waitFor(events, 'approval-required');
  loop.stop();
  await run;

  assert.deepEqual(events.filter((evt) => evt.type === 'tool-denied'), [
    { type: 'tool-denied', toolUseId: 'tu_stop' },
  ]);

  // History must stay continuable: the recorded assistant tool_use needs a
  // matching tool_result before the next user message.
  const messages = loop.getMessages();
  const assistantIdx = messages.findIndex((m) => m.role === 'assistant');
  assert.ok(assistantIdx >= 0);
  const repair = messages[assistantIdx + 1];
  assert.equal(repair.role, 'user');
  assert.equal(repair.content[0].type, 'tool_result');
  assert.equal(repair.content[0].tool_use_id, 'tu_stop');
  assert.equal(repair.content[0].is_error, true);

  // And a follow-up send must reach Anthropic without throwing.
  await loop.sendUser('never mind, just say hi');
  const sent = calls[calls.length - 1].messages;
  assert.equal(sent[sent.length - 1].content, 'never mind, just say hi');
});

test('createAgentLoop readonly denies writes without approval and allows read tools', async () => {
  const events = [];
  const calls = [];
  const mcp = makeMcp();
  const loop = makeLoop({
    anthropic: anthropicFromSse([
      toolTurn({ id: 'tu_write', name: 'ae.newText' }),
      textTurn('Denied noted'),
      toolTurn({ id: 'tu_read', name: 'ae.overview' }),
      textTurn('Read done'),
    ], calls),
    mcp,
    mode: 'readonly',
    events,
  });

  await loop.sendUser('try write');
  await loop.sendUser('read');

  assert.deepEqual(mcp.calls, [{ name: 'ae.overview', args: { text: 'Hi' } }]);
  assert.equal(events.some((evt) => evt.type === 'approval-required'), false);
  assert.deepEqual(events.filter((evt) => evt.type === 'tool-denied'), [
    { type: 'tool-denied', toolUseId: 'tu_write' },
  ]);
  const deniedResult = calls[1].messages.at(-1).content[0];
  assert.equal(deniedResult.type, 'tool_result');
  assert.equal(deniedResult.is_error, true);
  assert.match(deniedResult.content, /read-only/);
});

test('createAgentLoop passes effort and fast options to Anthropic', async () => {
  const calls = [];
  const loop = makeLoop({
    anthropic: anthropicFromSse([textTurn('ok')], calls),
    getEffort: () => 'low',
    getFast: () => true,
  });

  await loop.sendUser('hi');

  assert.equal(calls[0].effort, 'low');
  assert.equal(calls[0].fast, true);
});
