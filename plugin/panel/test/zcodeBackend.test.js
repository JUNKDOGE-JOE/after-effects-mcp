import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createZcodeBackend } from '../src/cep/zcodeBackend.js';
import { zcodeStaticDescriptor, zcodeDescriptorFromModels } from '../src/lib/backendCapabilities.js';

// --- harness (mirrors codexBackend.test.js shape, adapted to ZCode protocol) ---

function makeProc() {
  const stdoutHandlers = [];
  const stderrHandlers = [];
  const exitHandlers = [];
  const errorHandlers = [];
  const writes = [];
  let killed = false;
  return {
    writes,
    get killed() { return killed; },
    stdin: { write(line) { writes.push(line); } },
    stdout: { on(event, handler) { if (event === 'data') stdoutHandlers.push(handler); } },
    stderr: { on(event, handler) { if (event === 'data') stderrHandlers.push(handler); } },
    on(event, handler) {
      if (event === 'exit') exitHandlers.push(handler);
      if (event === 'error') errorHandlers.push(handler);
    },
    kill() { killed = true; },
    pushStdout(message) {
      const line = typeof message === 'string' ? message : JSON.stringify(message) + '\n';
      for (const handler of stdoutHandlers) handler(line);
    },
    exit(code = 0, signal = null) { for (const h of exitHandlers) h(code, signal); },
    error(error) { for (const h of errorHandlers) h(error); },
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

// Respond to a ZCode request (no jsonrpc field — the protocol is stripped).
function respond(proc, request, result = {}) {
  proc.pushStdout({ id: request.id, result });
}

// Push a ZCode notification (event) with the given type/payload.
function pushEvent(proc, type, payload = {}, extra = {}) {
  proc.pushStdout({
    method: 'session/event',
    params: { type, payload, sessionId: 'sess_test', seq: extra.seq || 1, ...extra },
  });
}

const TOOL_META = {
  allowedTools: [],
  annotations: {
    mcp__ae__ae_overview: { readOnly: true, destructive: false },
    mcp__ae__ae_setProperty: { readOnly: false, destructive: false },
    mcp__ae__ae_exec: { readOnly: false, destructive: true },
  },
};

function makeBackend(options = {}) {
  const events = [];
  const spawned = makeSpawn();
  const backend = createZcodeBackend({
    spawnImpl: spawned.spawn,
    getModel: () => 'glm-5.2',
    getPermissionMode: () => 'manual',
    getToolMeta: async () => TOOL_META,
    getServerInstructions: () => '',
    onEvent: (evt) => events.push(evt),
    lang: 'en',
    env: {
      PATH: 'C:\\Node',
      TEMP: 'C:\\tmp',
      LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel',
    },
    resolveCli: async () => ({ ok: true, cliPath: 'C:\\ZCode\\zcode.cjs' }),
    resolveNode: async () => ({ ok: true, nodePath: 'C:\\Node\\node.exe', version: 'v24.0.0' }),
    ...options,
  });
  return { backend, events, spawned };
}

// Drive a full session/create + subscribe + session/send handshake.
async function startTurn(backend, spawned, text = 'hello') {
  const pending = backend.sendUser(text);
  await flush();
  const proc = spawned.procs[0];

  // 1. session/create
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.method, 'session/create');
  respond(proc, createReq, { session: { sessionId: 'sess_test' }, settings: { model: { available: [] } } });
  await flush();

  // 2. session/subscribe (fire-and-forget, no response needed)
  // 3. session/send
  const sendReq = parseWrites(proc).find((m) => m.method === 'session/send');
  assert.ok(sendReq, 'session/send was sent');
  respond(proc, sendReq, { accepted: true, sessionId: 'sess_test' });
  await flush();
  return { pending, proc, createReq, sendReq };
}

// --- tests ---

test('createZcodeBackend spawns node with zcode.cjs app-server args', async () => {
  const { backend, spawned } = makeBackend();
  backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls.length, 1);
  assert.equal(spawned.calls[0].command, 'C:\\Node\\node.exe');
  assert.deepEqual(spawned.calls[0].args, ['C:\\ZCode\\zcode.cjs', 'app-server']);
  assert.equal(spawned.calls[0].options.stdio, 'pipe');
  assert.equal(spawned.calls[0].options.windowsHide, true);
});

test('session/create is sent with a workspace object and permission mode', async () => {
  const { backend, spawned } = makeBackend();
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.method, 'session/create');
  assert.ok(createReq.params.workspace, 'workspace object present');
  assert.equal(typeof createReq.params.workspace.workspacePath, 'string');
  assert.equal(createReq.params.mode, 'build'); // manual tier -> build
});

test('messages omit the jsonrpc field (ZCode strict-parses and rejects it)', async () => {
  const { backend, spawned } = makeBackend();
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  for (const line of proc.writes) {
    const msg = JSON.parse(line);
    assert.equal(msg.jsonrpc, undefined, 'no jsonrpc field on outbound messages');
  }
});

test('text-delta events flow from model.streaming notifications', async () => {
  const { backend, events, spawned } = makeBackend();
  const { proc } = await startTurn(backend, spawned, 'say PONG');
  // Stream two deltas then complete the turn.
  pushEvent(proc, 'turn.started', { turnNumber: 0 });
  pushEvent(proc, 'model.streaming', { delta: 'PON', kind: 'text_delta', done: false });
  pushEvent(proc, 'model.streaming', { delta: 'G', kind: 'text_delta', done: false });
  pushEvent(proc, 'turn.completed', { response: 'PONG', usage: { totalTokens: 10 } });
  await flush();

  const deltas = events.filter((e) => e.type === 'text-delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].text, 'PON');
  assert.equal(deltas[1].text, 'G');
  assert.ok(events.some((e) => e.type === 'turn-start'));
  assert.ok(events.some((e) => e.type === 'turn-end' && e.stopReason === 'end_turn'));
});

test('manual tier emits approval-required for a non-read-only tool', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'manual' });
  const { proc } = await startTurn(backend, spawned, 'set a property');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_1',
    toolName: 'ae_setProperty',
    riskLevel: 'medium',
    input: { layerId: 1 },
    requestId: 'r1',
  });
  await flush();

  const approval = events.find((e) => e.type === 'approval-required');
  assert.ok(approval, 'approval-required emitted');
  assert.equal(approval.toolUseId, 'tc_1');
  assert.equal(approval.name, 'mcp__ae__ae_setProperty');
  assert.equal(approval.risk, 'write');
});

test('readonly tier auto-denies a tool', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'readonly' });
  const { proc } = await startTurn(backend, spawned, 'set a property');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_2',
    toolName: 'ae_setProperty',
    riskLevel: 'medium',
    input: {},
    requestId: 'r2',
  });
  await flush();
  assert.ok(events.some((e) => e.type === 'tool-denied' && e.toolUseId === 'tc_2'));
});

test('none tier auto-allows a destructive tool', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'none' });
  const { proc } = await startTurn(backend, spawned, 'exec code');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_3',
    toolName: 'ae_exec',
    riskLevel: 'critical',
    input: {},
    requestId: 'r3',
  });
  await flush();
  assert.ok(events.some((e) => e.type === 'tool-allowed' && e.toolUseId === 'tc_3'));
});

test('approve(allow) resolves a pending approval and emits tool-allowed', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'manual' });
  const { proc } = await startTurn(backend, spawned, 'set a property');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_4',
    toolName: 'ae_setProperty',
    riskLevel: 'medium',
    input: {},
    requestId: 'r4',
  });
  await flush();
  backend.approve('tc_4', 'allow');
  await flush();
  assert.ok(events.some((e) => e.type === 'tool-allowed' && e.toolUseId === 'tc_4'));
});

test('stop emits an aborted error and drains pending approvals', async () => {
  const { backend, events, spawned } = makeBackend({ getPermissionMode: () => 'manual' });
  const { proc } = await startTurn(backend, spawned, 'set a property');
  pushEvent(proc, 'permission.requested', {
    toolCallId: 'tc_5',
    toolName: 'ae_setProperty',
    riskLevel: 'medium',
    input: {},
    requestId: 'r5',
  });
  await flush();
  backend.stop();
  await flush();
  assert.ok(events.some((e) => e.type === 'tool-denied' && e.toolUseId === 'tc_5'));
  assert.ok(events.some((e) => e.type === 'error' && e.kind === 'aborted'));
});

test('reset kills the process and clears transcript', async () => {
  const { backend, spawned } = makeBackend();
  const { proc } = await startTurn(backend, spawned, 'hello');
  backend.reset();
  assert.ok(spawned.procs[0].killed, 'process killed on reset');
  assert.deepEqual(backend.getMessages(), []);
});

test('probeAccount reports loggedIn when session/create succeeds', async () => {
  const { backend, spawned } = makeBackend();
  const probe = backend.probeAccount();
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  respond(proc, createReq, { session: { sessionId: 'sess_probe' }, settings: { model: { available: [] } } });
  await flush();
  const result = await probe;
  assert.equal(result.loggedIn, true);
  assert.equal(result.provider, 'zcode');
});

test('probeAccount reports not-logged-in when the CLI cannot be resolved', async () => {
  const { backend } = makeBackend({ resolveCli: async () => ({ ok: false, detail: 'not installed' }) });
  const result = await backend.probeAccount();
  assert.equal(result.loggedIn, false);
  assert.match(result.detail, /not installed/);
});

// --- descriptor tests ---

test('zcodeStaticDescriptor satisfies the backend descriptor contract', () => {
  const d = zcodeStaticDescriptor();
  assert.equal(d.id, 'zcode');
  assert.ok(Array.isArray(d.models) && d.models.length > 0);
  assert.ok(d.defaultModelId);
  assert.equal(typeof d.supportsFast, 'function');
  assert.equal(d.perTurnModelSwitch, true);
  assert.equal(Array.isArray(d.approvalModes) && d.approvalModes.length, 4);
  // thoughtLevel enum is low/medium/high (verified in zcode.cjs 0.14.8).
  assert.deepEqual(d.models[0].effortLevels, ['low', 'medium', 'high']);
  assert.equal(d.defaultEffort, 'medium');
});

test('session/create carries thoughtLevel when getEffort returns a valid level', async () => {
  const { backend, spawned } = makeBackend({ getEffort: () => 'high' });
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.method, 'session/create');
  assert.equal(createReq.params.thoughtLevel, 'high');
});

test('session/create omits thoughtLevel when getEffort is null', async () => {
  const { backend, spawned } = makeBackend({ getEffort: () => null });
  backend.sendUser('hello');
  await flush();
  const proc = spawned.procs[0];
  const createReq = parseWrites(proc)[0];
  assert.equal(createReq.params.thoughtLevel, undefined);
});

test('setThoughtLevel pushes a session/setThoughtLevel request', async () => {
  const { backend, spawned } = makeBackend();
  const { proc } = await startTurn(backend, spawned, 'hello');
  const before = parseWrites(proc).length;
  const pending = backend.setThoughtLevel('high');
  await flush();
  const setReq = parseWrites(proc).slice(before).find((m) => m.method === 'session/setThoughtLevel');
  assert.ok(setReq, 'session/setThoughtLevel sent');
  assert.equal(setReq.params.thoughtLevel, 'high');
  respond(proc, setReq, { ok: true });
  assert.equal(await pending, true);
});

test('setThoughtLevel rejects an invalid level', async () => {
  const { backend, spawned } = makeBackend();
  await startTurn(backend, spawned, 'hello');
  const ok = await backend.setThoughtLevel('turbo');
  assert.equal(ok, false);
});

test('zcodeDescriptorFromModels builds from session/create model.available', () => {
  const result = zcodeDescriptorFromModels({
    settings: {
      model: {
        available: [
          { label: 'GLM-5.2', ref: { modelId: 'glm-5.2', providerId: 'mediastorm_glm' }, contextWindow: 1000000 },
          { label: 'Deepseek V4', ref: { modelId: 'deepseek-v4-pro', providerId: 'mediastorm_glm' } },
        ],
        current: { modelId: 'glm-5.2', providerId: 'mediastorm_glm' },
      },
    },
  });
  assert.equal(result.id, 'zcode');
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].id, 'mediastorm_glm/glm-5.2');
  assert.equal(result.models[0].label, 'GLM-5.2');
  assert.equal(result.defaultModelId, 'mediastorm_glm/glm-5.2');
});

test('zcodeDescriptorFromModels falls back to static when no models', () => {
  const result = zcodeDescriptorFromModels({});
  assert.equal(result.id, 'zcode');
  assert.ok(result.models.length > 0);
});
