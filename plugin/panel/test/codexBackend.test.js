import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend } from '../src/cep/codexBackend.js';

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
  // Real app-server responses omit the jsonrpc envelope (verified live) -
  // fixtures match reality; notification fixtures keep the envelope so the
  // tolerant parser stays covered for both shapes.
  proc.pushStdout({ id: request.id, result });
}

async function startTurn(backend, proc, text = 'hello') {
  const pending = backend.sendUser(text);
  await flush();
  const init = parseWrites(proc)[0];
  assert.equal(init.method, 'initialize');
  // granular askForApproval is rejected without this opt-in (live error)
  assert.equal(init.params.capabilities.experimentalApi, true);
  respond(proc, init, {});
  await flush();
  const threadStart = parseWrites(proc)[1];
  assert.equal(threadStart.method, 'thread/start');
  respond(proc, threadStart, { threadId: 'thread_1' });
  await flush();
  const turnStart = parseWrites(proc)[2];
  assert.equal(turnStart.method, 'turn/start');
  return { pending, init, threadStart, turnStart };
}

function makeBackend(options = {}) {
  const events = [];
  const spawned = makeSpawn();
  const fsWrites = [];
  const backend = createCodexBackend({
    spawnImpl: spawned.spawn,
    getModel: () => 'gpt-5.5',
    getEffort: () => 'high',
    getFast: () => true,
    getPermissionMode: () => 'manual',
    getMcpSpec: async () => ({ command: 'ae-mcp', args: ['--stdio'], env: { A: 'B' } }),
    onEvent: (evt) => events.push(evt),
    lang: 'en',
    tierFilePath: 'C:\\tmp\\ae-mcp-approval-tier.txt',
    fsImpl: {
      writeFileSync(file, text) {
        fsWrites.push({ file, text });
      },
    },
    env: {
      PATH: 'C:\\Node',
      TEMP: 'C:\\tmp',
      AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel',
    },
    ...options,
  });
  return { backend, events, spawned, fsWrites };
}

test('createCodexBackend starts codex app-server and sends thread/start with AE MCP config', async () => {
  const { backend, spawned, fsWrites } = makeBackend();

  const pending = backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls.length, 1);
  assert.equal(spawned.calls[0].command, 'codex');
  assert.deepEqual(spawned.calls[0].args, ['app-server']);
  assert.equal(spawned.calls[0].options.shell, true);
  assert.equal(spawned.calls[0].options.stdio, 'pipe');
  assert.equal(spawned.calls[0].options.windowsHide, true);
  assert.deepEqual(fsWrites, [{ file: 'C:\\tmp\\ae-mcp-approval-tier.txt', text: 'manual' }]);

  const proc = spawned.procs[0];
  const init = parseWrites(proc)[0];
  assert.equal(init.method, 'initialize');
  assert.deepEqual(init.params.clientInfo, { name: 'ae-mcp-panel', version: '0.5.0' });
  respond(proc, init, {});
  await flush();

  const threadStart = parseWrites(proc)[1];
  assert.equal(threadStart.method, 'thread/start');
  assert.equal(threadStart.params.ephemeral, true);
  assert.equal(threadStart.params.cwd, 'C:\\Repo\\plugin');
  assert.equal(threadStart.params.model, 'gpt-5.5');
  assert.equal(threadStart.params.approvalsReviewer, 'user');
  assert.deepEqual(threadStart.params.approvalPolicy, {
    granular: { mcp_elicitations: true, rules: true, sandbox_approval: true },
  });
  assert.deepEqual(threadStart.params.sandboxPolicy, { type: 'readOnly' });
  assert.deepEqual(threadStart.params.config.mcp_servers.ae, {
    command: 'ae-mcp',
    args: ['--stdio'],
    env: {
      A: 'B',
      AE_MCP_BACKEND: 'ae-mcp',
      AE_MCP_APPROVAL_TIER_FILE: 'C:\\tmp\\ae-mcp-approval-tier.txt',
    },
  });
  respond(proc, threadStart, { threadId: 'thread_1' });
  await flush();

  const turnStart = parseWrites(proc)[2];
  assert.equal(turnStart.method, 'turn/start');
  assert.deepEqual(turnStart.params, {
    threadId: 'thread_1',
    input: [{ type: 'text', text: 'hello' }],
    model: 'gpt-5.5',
    effort: 'high',
    serviceTier: 'priority',
    approvalPolicy: {
      granular: { mcp_elicitations: true, rules: true, sandbox_approval: true },
    },
    sandboxPolicy: { type: 'readOnly' },
  });

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('createCodexBackend reuses threadId on subsequent turns', async () => {
  const { backend, spawned, fsWrites } = makeBackend({
    getFast: () => false,
    getPermissionMode: () => 'auto',
  });
  const firstPending = backend.sendUser('one');
  await flush();
  const proc = spawned.procs[0];
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  respond(proc, parseWrites(proc)[1], { threadId: 'thread_1' });
  await flush();
  const first = { pending: firstPending };
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await first.pending;

  const second = backend.sendUser('two');
  await flush();
  const writes = parseWrites(proc);
  assert.equal(writes.filter((w) => w.method === 'thread/start').length, 1);
  const secondTurn = writes[writes.length - 1];
  assert.equal(secondTurn.method, 'turn/start');
  assert.equal(secondTurn.params.threadId, 'thread_1');
  assert.equal(secondTurn.params.input[0].text, 'two');
  assert.equal(Object.hasOwn(secondTurn.params, 'serviceTier'), false);
  assert.deepEqual(fsWrites.map((w) => w.text), ['auto', 'auto']);
  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await second;
});

test('createCodexBackend maps app-server turn and tool notifications to panel events', async () => {
  const { backend, events, spawned } = makeBackend();
  const pending = backend.sendUser('events');
  await flush();
  const proc = spawned.procs[0];
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  respond(proc, parseWrites(proc)[1], { threadId: 'thread_1' });
  await flush();

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
    { type: 'text-delta', text: 'hi', phase: 'final_answer' },
    { type: 'tool-start', toolUseId: 'call_x', name: 'mcp__ae__ae_ping', input: {} },
    { type: 'tool-result', toolUseId: 'call_x', name: 'mcp__ae__ae_ping', ok: true, text: '{"ok": true}', durationMs: 53 },
    { type: 'turn-end', stopReason: 'end_turn' },
  ]);
});

test('createCodexBackend routes elicitation requests through approval-required and approve responses', async () => {
  const { backend, events, spawned } = makeBackend();
  const pending = backend.sendUser('approve');
  await flush();
  const proc = spawned.procs[0];
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  respond(proc, parseWrites(proc)[1], { threadId: 'thread_1' });
  await flush();

  proc.pushStdout({
    jsonrpc: '2.0',
    id: 'ask_1',
    method: 'mcpServer/elicitation/request',
    params: { server: 'ae', tool: 'ae_exec', name: 'ae_exec', arguments: { code: 'app.project' } },
  });
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'ask_1',
    name: 'mcp__ae__ae_exec',
    input: { code: 'app.project' },
  });

  backend.approve('ask_1', 'allow-session');
  const accept = parseWrites(proc).at(-1);
  assert.deepEqual(accept, { jsonrpc: '2.0', id: 'ask_1', result: { action: 'accept', content: {} } });

  proc.pushStdout({
    jsonrpc: '2.0',
    id: 22,
    method: 'mcpServer/elicitation/request',
    params: { server: 'ae', tool: 'ae_delete', arguments: { id: 1 } },
  });
  backend.approve('22', 'deny');
  assert.deepEqual(events.at(-1), { type: 'tool-denied', toolUseId: '22' });
  assert.deepEqual(parseWrites(proc).at(-1), { jsonrpc: '2.0', id: 22, result: { action: 'decline', content: {} } });

  proc.pushStdout({ jsonrpc: '2.0', method: 'turn/completed', params: {} });
  await pending;
});

test('createCodexBackend stop interrupts the turn, drains pending approvals, and emits aborted error', async () => {
  const { backend, events, spawned } = makeBackend();
  const pending = backend.sendUser('stop');
  await flush();
  const proc = spawned.procs[0];
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  respond(proc, parseWrites(proc)[1], { threadId: 'thread_1' });
  await flush();

  proc.pushStdout({ method: 'turn/started', params: { threadId: 'thread_1', turn: { id: 'turn_1' } } });
  proc.pushStdout({ jsonrpc: '2.0', id: 'ask_stop', method: 'mcpServer/elicitation/request', params: { tool: 'ae_exec', arguments: {} } });
  backend.stop();
  const writes = parseWrites(proc);

  assert.equal(writes.at(-2).method, 'turn/interrupt');
  // TurnInterruptParams requires BOTH ids (schema-verified)
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
  const first = backend.sendUser('one');
  await flush();
  const proc = spawned.procs[0];
  respond(proc, parseWrites(proc)[0], {});
  await flush();
  respond(proc, parseWrites(proc)[1], { threadId: 'thread_1' });
  await flush();

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
    email: 'a@example.com',
    planType: 'plus',
    models: [{ id: 'gpt-5.5', displayName: 'GPT-5.5', hidden: false }],
  });
});
