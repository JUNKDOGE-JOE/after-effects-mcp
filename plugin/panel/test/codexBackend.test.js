import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend } from '../src/cep/codexBackend.js';
import { PANEL_VERSION } from '../src/cep/mcpClient.js';

function makeProc() {
  const stdoutHandlers = [];
  const stderrHandlers = [];
  const exitHandlers = [];
  const errorHandlers = [];
  const writes = [];
  let killed = false;

  return {
    writes,
    get killed() {
      return killed;
    },
    stdin: {
      write(line) {
        writes.push(line);
      },
    },
    stdout: {
      on(event, handler) {
        if (event === 'data') stdoutHandlers.push(handler);
      },
    },
    stderr: {
      on(event, handler) {
        if (event === 'data') stderrHandlers.push(handler);
      },
    },
    on(event, handler) {
      if (event === 'exit') exitHandlers.push(handler);
      if (event === 'error') errorHandlers.push(handler);
    },
    kill() {
      killed = true;
    },
    pushStdout(message) {
      const line = typeof message === 'string' ? message : JSON.stringify(message) + '\n';
      for (const handler of stdoutHandlers) handler(line);
    },
    pushStderr(text) {
      for (const handler of stderrHandlers) handler(text);
    },
    exit(code = 0, signal = null) {
      for (const handler of exitHandlers) handler(code, signal);
    },
    error(error) {
      for (const handler of errorHandlers) handler(error);
    },
  };
}

function makeSpawn() {
  const calls = [];
  const procs = [];
  function spawn(command, args, options) {
    const proc = makeProc();
    calls.push({ command, args, options, proc });
    procs.push(proc);
    return proc;
  }
  return { spawn, calls, procs };
}

function parseWrites(proc) {
  return proc.writes.map((line) => JSON.parse(line));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function respond(proc, request, result = {}) {
  proc.pushStdout({ id: request.id, result });
}

const TOOL_META = {
  allowedTools: [],
  annotations: {
    mcp__ae__ae_overview: { readOnly: true, destructive: false },
    mcp__ae__ae_setProperty: { readOnly: false, destructive: false },
    mcp__ae__ae_exec: { readOnly: false, destructive: true },
  },
};

function realElicitation(tool, params = {}) {
  return {
    threadId: 'thread_1',
    turnId: 'turn_1',
    serverName: 'ae',
    mode: 'form',
    _meta: {
      codex_approval_kind: 'mcp_tool_call',
      persist: ['session', 'always'],
      tool_description: `${tool} — run JSX under an undo group, return the last expression value.`,
      tool_params: params,
      tool_params_display: Object.entries(params).map(([name, value]) => ({ name, value, display_name: name })),
    },
    message: `Allow the ae MCP server to run tool "${tool}"?`,
    requestedSchema: { type: 'object', properties: {} },
  };
}

function makeBackend(options = {}) {
  const events = [];
  const spawned = makeSpawn();
  const backend = createCodexBackend({
    spawnImpl: spawned.spawn,
    getModel: () => 'gpt-5.5',
    getEffort: () => 'high',
    getFast: () => true,
    getPermissionMode: () => 'manual',
    getMcpSpec: async () => ({ command: 'ae-mcp', args: ['--stdio'], env: { A: 'B' } }),
    getToolMeta: async () => TOOL_META,
    onEvent: (evt) => events.push(evt),
    lang: 'en',
    env: {
      PATH: 'C:\\Node',
      TEMP: 'C:\\tmp',
      AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel',
    },
    ...options,
  });
  return { backend, events, spawned };
}

async function startTurn(backend, spawned, text = 'hello') {
  const pending = backend.sendUser(text);
  await flush();
  const proc = spawned.procs[0];
  const init = parseWrites(proc)[0];
  assert.equal(init.method, 'initialize');
  assert.equal(init.params.capabilities.experimentalApi, true);
  respond(proc, init, {});
  await flush();
  const threadStart = parseWrites(proc)[1];
  assert.equal(threadStart.method, 'thread/start');
  respond(proc, threadStart, { threadId: 'thread_1' });
  await flush();
  const turnStart = parseWrites(proc)[2];
  assert.equal(turnStart.method, 'turn/start');
  respond(proc, turnStart, {});
  await flush();
  return { pending, proc, init, threadStart, turnStart };
}

function pushElicitation(proc, id, params) {
  proc.pushStdout({
    jsonrpc: '2.0',
    id,
    method: 'mcpServer/elicitation/request',
    params,
  });
}

test('createCodexBackend starts codex app-server and sends thread/start with AE MCP config', async () => {
  const { backend, spawned } = makeBackend();
  const pending = backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls.length, 1);
  assert.equal(spawned.calls[0].command, 'codex');
  assert.deepEqual(spawned.calls[0].args, ['app-server']);
  assert.equal(spawned.calls[0].options.shell, true);
  assert.equal(spawned.calls[0].options.stdio, 'pipe');
  assert.equal(spawned.calls[0].options.windowsHide, true);

  const proc = spawned.procs[0];
  const init = parseWrites(proc)[0];
  assert.equal(init.method, 'initialize');
  assert.deepEqual(init.params.clientInfo, { name: 'ae-mcp-panel', version: PANEL_VERSION });
  respond(proc, init, {});
  await flush();

  const threadStart = parseWrites(proc)[1];
  assert.equal(threadStart.params.ephemeral, true);
  assert.equal(threadStart.params.cwd, 'C:\\Repo\\plugin');
  assert.equal(threadStart.params.model, 'gpt-5.5');
  assert.equal(threadStart.params.approvalsReviewer, 'user');
  assert.deepEqual(threadStart.params.approvalPolicy, {
    granular: { mcp_elicitations: true, rules: false, sandbox_approval: false },
  });
  assert.deepEqual(threadStart.params.sandboxPolicy, { type: 'readOnly' });
  assert.deepEqual(threadStart.params.config.mcp_servers.ae, {
    command: 'ae-mcp',
    args: ['--stdio'],
    env: {
      A: 'B',
      AE_MCP_BACKEND: 'ae-mcp',
    },
  });
  assert.equal(Object.hasOwn(threadStart.params.config.mcp_servers.ae.env, 'AE_MCP_APPROVAL_TIER_FILE'), false);
  respond(proc, threadStart, { threadId: 'thread_1' });
  await flush();

  const turnStart = parseWrites(proc)[2];
  assert.deepEqual(turnStart.params, {
    threadId: 'thread_1',
    input: [{ type: 'text', text: 'hello' }],
    model: 'gpt-5.5',
    effort: 'high',
    serviceTier: 'priority',
    approvalPolicy: {
      granular: { mcp_elicitations: true, rules: false, sandbox_approval: false },
    },
    sandboxPolicy: { type: 'readOnly' },
  });
  respond(proc, turnStart, {});
  await flush();

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('createCodexBackend starts app-server with custom provider config when supplied', async () => {
  const { backend, spawned } = makeBackend({
    getProviderProfile: () => ({
      codexBaseUrl: 'https://proxy.example/openai',
      codexApiKey: 'sk-proxy',
      codexProviderId: 'my-provider',
      codexWireApi: 'chat',
    }),
  });

  const { pending, proc } = await startTurn(backend, spawned, 'custom provider');

  assert.equal(spawned.calls[0].command, 'codex');
  assert.deepEqual(spawned.calls[0].args, [
    'app-server',
    '-c', 'model_provider="my-provider"',
    '-c', 'model_providers.my-provider.name="AE MCP Custom"',
    '-c', 'model_providers.my-provider.base_url="https://proxy.example/openai"',
    '-c', 'model_providers.my-provider.env_key="AE_MCP_CODEX_API_KEY"',
    '-c', 'model_providers.my-provider.wire_api="responses"',
    '-c', 'model_providers.my-provider.requires_openai_auth=false',
  ]);
  assert.equal(spawned.calls[0].options.env.AE_MCP_CODEX_API_KEY, 'sk-proxy');

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('createCodexBackend reuses threadId on subsequent turns', async () => {
  const { backend, spawned } = makeBackend({
    getFast: () => false,
    getPermissionMode: () => 'auto',
  });
  const { pending, proc } = await startTurn(backend, spawned, 'one');
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  const second = backend.sendUser('two');
  await flush();
  const writes = parseWrites(proc);
  assert.equal(writes.filter((w) => w.method === 'thread/start').length, 1);
  const secondTurn = writes.at(-1);
  assert.equal(secondTurn.method, 'turn/start');
  assert.equal(secondTurn.params.threadId, 'thread_1');
  assert.equal(secondTurn.params.input[0].text, 'two');
  assert.equal(Object.hasOwn(secondTurn.params, 'serviceTier'), false);
  respond(proc, secondTurn, {});
  await flush();
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend maps app-server turn and tool notifications to panel events', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'events');

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread_1' } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { phase: 'final_answer', delta: 'hi' } });
  proc.pushStdout({
    jsonrpc: '2.0',
    method: 'item/started',
    params: { item: { type: 'mcpToolCall', id: 'call_x', server: 'ae', tool: 'ae_ping', arguments: {} } },
  });
  proc.pushStdout({
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      item: {
        type: 'mcpToolCall',
        id: 'call_x',
        server: 'ae',
        tool: 'ae_ping',
        status: 'completed',
        arguments: {},
        result: { content: [{ type: 'text', text: '{"ok": true}' }] },
        error: null,
        durationMs: 53,
      },
    },
  });
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  assert.deepEqual(events, [
    { type: 'turn-start' },
    { type: 'thinking', active: false },
    { type: 'text-delta', text: 'hi', phase: 'final_answer' },
    { type: 'tool-start', toolUseId: 'call_x', name: 'mcp__ae__ae_ping', input: {} },
    { type: 'tool-result', toolUseId: 'call_x', name: 'mcp__ae__ae_ping', ok: true, text: '{"ok": true}', durationMs: 53 },
    { type: 'turn-end', stopReason: 'end_turn' },
  ]);
});

test('codex approval adapter applies four tiers and annotations', async () => {
  const cases = [
    { mode: 'none', tool: 'ae_exec', params: { code: 'app.project' }, response: 'accept', event: null },
    { mode: 'readonly', tool: 'ae_setProperty', params: { value: 1 }, response: 'decline', event: { type: 'tool-denied', toolUseId: 'ask_readonly' }, id: 'ask_readonly' },
    { mode: 'auto', tool: 'ae_setProperty', params: { value: 2 }, response: 'accept', event: null },
    { mode: 'auto', tool: 'ae_exec', params: { code: 'app.project' }, response: null, event: { type: 'approval-required', toolUseId: 'ask_auto', name: 'mcp__ae__ae_exec', input: { code: 'app.project' }, risk: 'destructive' }, id: 'ask_auto' },
    { mode: 'manual', tool: 'ae_overview', params: {}, response: 'accept', event: null },
  ];

  for (const item of cases) {
    const { backend, events, spawned } = makeBackend({ getPermissionMode: () => item.mode });
    const { pending, proc } = await startTurn(backend, spawned, item.mode);
    const id = item.id || `ask_${item.mode}`;
    pushElicitation(proc, id, realElicitation(item.tool, item.params));

    if (item.response) {
      assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id, result: { action: item.response, content: {} } });
      assert.equal(events.some((evt) => evt.type === 'approval-required'), false);
    } else {
      assert.deepEqual(events.at(-1), item.event);
    }
    if (item.event && item.event.type === 'tool-denied') assert.deepEqual(events.at(-1), item.event);
    proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
    await pending;
  }
});

test('manual approval allow, allow-session, and deny write elicitation responses', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'approve');

  pushElicitation(proc, 'ask_1', realElicitation('ae_exec', { code: 'app.project' }));
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'ask_1',
    name: 'mcp__ae__ae_exec',
    input: { code: 'app.project' },
    risk: 'destructive',
  });
  backend.approve('ask_1', 'allow');
  assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id: 'ask_1', result: { action: 'accept', content: {} } });
  assert.deepEqual(events.at(-1), { type: 'tool-allowed', toolUseId: 'ask_1' });

  pushElicitation(proc, 'ask_2', realElicitation('ae_exec', { code: 'app.project.item(1).remove()' }));
  backend.approve('ask_2', 'allow-session');
  assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id: 'ask_2', result: { action: 'accept', content: {} } });
  assert.deepEqual(events.at(-1), { type: 'tool-allowed', toolUseId: 'ask_2' });

  const eventCount = events.length;
  pushElicitation(proc, 'ask_3', realElicitation('ae_exec', { code: 'app.project' }));
  assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id: 'ask_3', result: { action: 'accept', content: {} } });
  assert.equal(events.length, eventCount);

  pushElicitation(proc, 22, realElicitation('ae_setProperty', { value: 3 }));
  backend.approve('22', 'deny');
  assert.deepEqual(events.at(-1), { type: 'tool-denied', toolUseId: '22' });
  assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id: 22, result: { action: 'decline', content: {} } });

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('elicitation tool name parsing supports message regex and tool_description fallback', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'parse');

  pushElicitation(proc, 'ask_msg', realElicitation('ae_setProperty', { value: 4 }));
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'ask_msg',
    name: 'mcp__ae__ae_setProperty',
    input: { value: 4 },
    risk: 'write',
  });
  backend.approve('ask_msg', 'deny');

  const fallback = realElicitation('ae_exec', { code: 'app.project' });
  delete fallback.message;
  pushElicitation(proc, 'ask_desc', fallback);
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'ask_desc',
    name: 'mcp__ae__ae_exec',
    input: { code: 'app.project' },
    risk: 'destructive',
  });

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('thinking events track reasoning start, completion, and answer delta', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'think');

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 'thread_1' } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/started', params: { item: { type: 'reasoning', id: 'r1' } } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/completed', params: { item: { type: 'reasoning', id: 'r1' } } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/started', params: { item: { type: 'reasoning', id: 'r2' } } });
  proc.pushStdout({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'done' } });

  assert.deepEqual(events.filter((evt) => evt.type === 'thinking'), [
    { type: 'thinking', active: true },
    { type: 'thinking', active: false },
    { type: 'thinking', active: true },
    { type: 'thinking', active: false },
  ]);

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('createCodexBackend stop interrupts the turn, drains pending approvals, and emits aborted error', async () => {
  const { backend, events, spawned } = makeBackend();
  const { pending, proc } = await startTurn(backend, spawned, 'stop');

  proc.pushStdout({ method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1' } } });
  pushElicitation(proc, 'ask_stop', realElicitation('ae_exec', {}));
  backend.stop();
  const writes = parseWrites(proc);

  assert.equal(writes.at(-2).method, 'turn/interrupt');
  assert.deepEqual(writes.at(-2).params, { threadId: 'thread_1', turnId: 'turn_1' });
  assert.deepEqual(writes.at(-1), { jsonrpc: '2.0', id: 'ask_stop', result: { action: 'decline', content: {} } });
  assert.deepEqual(events.slice(-2), [
    { type: 'tool-denied', toolUseId: 'ask_stop' },
    { type: 'error', kind: 'aborted', message: 'Turn aborted.' },
  ]);
  await pending;
});

test('createCodexBackend reset kills the app-server process and clears thread state', async () => {
  const { backend, spawned } = makeBackend();
  const { pending: first, proc } = await startTurn(backend, spawned, 'one');

  backend.reset();
  assert.equal(proc.killed, true);
  await first;

  const second = backend.sendUser('two');
  await flush();
  assert.equal(spawned.calls.length, 2);
  const proc2 = spawned.procs[1];
  respond(proc2, parseWrites(proc2)[0], {});
  await flush();
  respond(proc2, parseWrites(proc2)[1], { threadId: 'thread_2' });
  await flush();
  respond(proc2, parseWrites(proc2)[2], {});
  proc2.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend prepends server instructions as a preamble on the first turn only', async () => {
  const { backend, spawned } = makeBackend({ getServerInstructions: () => 'CODEX_PREAMBLE' });
  const { pending, proc } = await startTurn(backend, spawned, 'first message');

  const firstTurn = parseWrites(proc).at(-1);
  assert.equal(firstTurn.method, 'turn/start');
  const firstText = firstTurn.params.input[0].text;
  assert.ok(firstText.startsWith('CODEX_PREAMBLE'));
  assert.ok(firstText.includes('first message'));

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  const second = backend.sendUser('second message');
  await flush();
  const secondTurn = parseWrites(proc).at(-1);
  assert.equal(secondTurn.method, 'turn/start');
  assert.equal(secondTurn.params.threadId, 'thread_1');
  // The preamble lives in thread history; the second turn must not repeat it.
  assert.equal(secondTurn.params.input[0].text, 'second message');
  assert.equal(secondTurn.params.input[0].text.includes('CODEX_PREAMBLE'), false);
  respond(proc, secondTurn, {});
  await flush();
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend re-sends the preamble after a thread reset', async () => {
  const { backend, spawned } = makeBackend({ getServerInstructions: () => 'CODEX_PREAMBLE' });
  const { pending, proc } = await startTurn(backend, spawned, 'before reset');
  assert.ok(parseWrites(proc).at(-1).params.input[0].text.startsWith('CODEX_PREAMBLE'));
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;

  backend.reset();
  await pending;

  // A brand-new thread (after reset) spawns a fresh process and must re-send
  // the preamble. Drive the new proc manually since startTurn targets procs[0].
  const second = backend.sendUser('after reset');
  await flush();
  const proc2 = spawned.procs[1];
  respond(proc2, parseWrites(proc2)[0], {});
  await flush();
  respond(proc2, parseWrites(proc2)[1], { threadId: 'thread_2' });
  await flush();
  const turn = parseWrites(proc2)[2];
  assert.equal(turn.method, 'turn/start');
  assert.ok(turn.params.input[0].text.startsWith('CODEX_PREAMBLE'));
  assert.ok(turn.params.input[0].text.includes('after reset'));
  respond(proc2, turn, {});
  await flush();
  proc2.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend probeAccount initializes and reads account plus model list', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  assert.equal(spawned.calls[0].command, 'codex');
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  assert.equal(parseWrites(proc)[1].method, 'account/read');
  respond(proc, parseWrites(proc)[1], { account: { type: 'chatgpt', email: 'a@example.com', planType: 'plus' } });
  await flush();
  assert.equal(parseWrites(proc)[2].method, 'model/list');
  respond(proc, parseWrites(proc)[2], { models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false }] });

  assert.deepEqual(await probe, {
    loggedIn: true,
    runtimeOk: true,
    email: 'a@example.com',
    planType: 'plus',
    models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false }],
  });
});

test('createCodexBackend probeAccount reports runtime ok when OpenAI auth is absent', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  respond(proc, parseWrites(proc)[1], { requiresOpenaiAuth: true });
  await flush();
  respond(proc, parseWrites(proc)[2], { models: [] });

  assert.deepEqual(await probe, {
    loggedIn: false,
    runtimeOk: true,
    detail: 'OpenAI auth required',
    models: [],
  });
});
