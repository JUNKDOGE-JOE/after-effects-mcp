import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/lib/sse.js';
import { createAgentLoop } from '../src/lib/agentLoop.js';
import { buildSystemPrompt } from '../src/lib/anthropic.js';

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

function makeLoop({ anthropic, mcp = makeMcp(), mode = 'none', events = [], getEffort, getFast, resolveRequestProfile }) {
  return createAgentLoop({
    resolveRequestProfile: resolveRequestProfile || (async () => ({
      providerId: 'test-provider',
      baseUrl: 'https://api.anthropic.com',
      allowInsecureHttp: false,
      auth: { kind: 'header', name: 'x-api-key', value: 'sk-test' },
      extraHeaders: [],
      authProfileRevision: 1,
    })),
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

test('createAgentLoop passes custom Anthropic base URL to the direct API backend', async () => {
  const calls = [];
  const loop = makeLoop({
    anthropic: anthropicFromSse([textTurn('ok')], calls),
    resolveRequestProfile: async () => ({
      providerId: 'proxy',
      baseUrl: 'https://proxy.example/anthropic',
      allowInsecureHttp: false,
      auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' },
      extraHeaders: [],
      authProfileRevision: 2,
    }),
  });

  await loop.sendUser('hi');

  assert.equal(calls[0].requestProfile.baseUrl, 'https://proxy.example/anthropic');
});

test('createAgentLoop resolves a request profile once per model call and never emits its secret', async () => {
  const events = [];
  const calls = [];
  let resolveCalls = 0;
  const loop = makeLoop({
    anthropic: anthropicFromSse([textTurn('ok')], calls),
    events,
    resolveRequestProfile: async () => {
      resolveCalls += 1;
      return {
        providerId: 'relay',
        baseUrl: 'https://relay.example',
        allowInsecureHttp: false,
        auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' },
        extraHeaders: [],
        authProfileRevision: 1,
      };
    },
  });
  await loop.sendUser('hi');
  assert.equal(resolveCalls, 1);
  assert.equal(calls[0].requestProfile.auth.value, 'resolved-only-for-request');
  assert.equal(JSON.stringify(events).includes('resolved-only-for-request'), false);
  assert.equal(JSON.stringify(loop.getMessages()).includes('resolved-only-for-request'), false);
});

test('createAgentLoop redacts resolved secret values from model errors', async () => {
  const events = [];
  const loop = makeLoop({
    anthropic: async () => { throw Object.assign(new Error('upstream echoed resolved-only-for-request'), { kind: 'network' }); },
    events,
    resolveRequestProfile: async () => ({
      providerId: 'relay',
      baseUrl: 'https://relay.example',
      allowInsecureHttp: false,
      auth: { kind: 'header', name: 'x-api-key', value: 'resolved-only-for-request' },
      extraHeaders: [],
      authProfileRevision: 1,
    }),
  });
  await loop.sendUser('hi');
  assert.equal(JSON.stringify(events).includes('resolved-only-for-request'), false);
});

test('createAgentLoop also redacts the bare token from a Bearer auth value', async () => {
  const events = [];
  const loop = makeLoop({
    anthropic: async () => { throw Object.assign(new Error('provider echoed bare-token-marker'), { kind: 'network' }); },
    events,
    resolveRequestProfile: async () => ({
      providerId: 'relay',
      baseUrl: 'https://relay.example',
      allowInsecureHttp: false,
      auth: { kind: 'header', name: 'Authorization', value: 'Bearer bare-token-marker' },
      extraHeaders: [],
      authProfileRevision: 1,
    }),
  });
  await loop.sendUser('hi');
  assert.equal(JSON.stringify(events).includes('bare-token-marker'), false);
});

test('createAgentLoop redacts credentials echoed in deltas and assistant history', async () => {
  const events = [];
  const loop = makeLoop({
    anthropic: async ({ onTextDelta }) => {
      onTextDelta('echoed-token-');
      onTextDelta('marker');
      return {
        assistantMessage: { role: 'assistant', content: [{ type: 'text', text: 'echoed-token-marker' }] },
        stopReason: 'end_turn',
      };
    },
    events,
    resolveRequestProfile: async () => ({
      providerId: 'relay',
      baseUrl: 'https://relay.example',
      allowInsecureHttp: false,
      auth: { kind: 'header', name: 'x-api-key', value: 'echoed-token-marker' },
      extraHeaders: [],
      authProfileRevision: 1,
    }),
  });
  await loop.sendUser('hi');
  assert.equal(JSON.stringify(events).includes('echoed-token-marker'), false);
  assert.equal(events.filter((event) => event.type === 'text-delta').map((event) => event.text).join('').includes('echoed-token-marker'), false);
  assert.equal(JSON.stringify(loop.getMessages()).includes('echoed-token-marker'), false);
});

test('createAgentLoop appends ae-mcp server instructions to the system prompt', async () => {
  const calls = [];
  const mcp = { ...makeMcp(), getServerInstructions: () => 'GUARDRAILS_X' };
  const loop = makeLoop({ anthropic: anthropicFromSse([textTurn('ok')], calls), mcp });

  await loop.sendUser('hi');

  // Both the static BYOK prompt and the server guardrails must be present.
  assert.ok(calls[0].system.includes('GUARDRAILS_X'));
  assert.ok(calls[0].system.includes(buildSystemPrompt('zh')));
});

test('createAgentLoop omits server instructions when the mcp fake lacks the method', async () => {
  const calls = [];
  const loop = makeLoop({ anthropic: anthropicFromSse([textTurn('ok')], calls) });

  await loop.sendUser('hi');

  // Default-safe: a fake without getServerInstructions yields the bare prompt.
  assert.equal(calls[0].system, buildSystemPrompt('zh'));
});

test('createAgentLoop delegates staged toolUse and skillUse calls directly to core', async () => {
  const events = [];
  const mcp = makeMcp({
    tools: [
      { name: 'ae_toolUse', inputSchema: {}, annotations: { destructiveHint: true } },
      { name: 'mcp__ae__ae_skillUse', inputSchema: {}, annotations: { destructiveHint: true } },
    ],
  });
  const loop = makeLoop({
    anthropic: anthropicFromSse([
      toolTurn({ id: 'plan', name: 'ae_toolUse', input: { action: 'prepare', artifact_id: 'user:1' } }),
      textTurn('planned'),
      toolTurn({ id: 'legacy', name: 'mcp__ae__ae_skillUse', input: { name: 'legacy', execute: true } }),
      textTurn('executed'),
    ]),
    mcp,
    mode: 'readonly',
    events,
  });

  await loop.sendUser('plan');
  await loop.sendUser('legacy');

  assert.deepEqual(mcp.calls, [
    { name: 'ae_toolUse', args: { action: 'prepare', artifact_id: 'user:1' } },
    { name: 'mcp__ae__ae_skillUse', args: { name: 'legacy', execute: true } },
  ]);
  assert.equal(events.some((event) => event.type === 'approval-required'), false);
  assert.equal(events.some((event) => event.type === 'tool-denied'), false);
});

test('dynamic delegation never creates a tool-name session allowance', async () => {
  const events = [];
  const mcp = makeMcp({
    tools: [
      { name: 'ae_toolUse', inputSchema: {}, annotations: { readOnlyHint: false } },
    ],
  });
  const loop = makeLoop({
    anthropic: anthropicFromSse([
      toolTurn({ id: 'staged', name: 'ae_toolUse', input: { action: 'grant', plan_hash: 'b'.repeat(64) } }),
      textTurn('granted'),
      toolTurn({ id: 'not-staged', name: 'ae_toolUse', input: { action: 'delete' } }),
      textTurn('denied'),
    ]),
    mcp,
    mode: 'manual',
    events,
  });

  const first = loop.sendUser('grant');
  const firstOutcome = await Promise.race([
    first.then(() => 'completed'),
    waitFor(events, 'approval-required'),
  ]);
  if (firstOutcome !== 'completed') {
    loop.approve(firstOutcome.toolUseId, 'deny');
    await first;
  }
  assert.equal(firstOutcome, 'completed');
  const second = loop.sendUser('delete');
  const approval = await waitFor(events, 'approval-required');
  assert.equal(approval.toolUseId, 'not-staged');
  loop.approve(approval.toolUseId, 'deny');
  await second;

  assert.deepEqual(mcp.calls, [
    { name: 'ae_toolUse', args: { action: 'grant', plan_hash: 'b'.repeat(64) } },
  ]);
});
