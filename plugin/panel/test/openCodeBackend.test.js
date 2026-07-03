import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeBackend } from '../src/cep/openCodeBackend.js';
import { openCodeDescriptorFromModels, openCodeStaticDescriptor } from '../src/lib/backendCapabilities.js';

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeProc() {
  const exitHandlers = [];
  const errorHandlers = [];
  let killed = false;
  return {
    get killed() {
      return killed;
    },
    stdout: { on() {} },
    stderr: { on() {} },
    on(event, handler) {
      if (event === 'exit') exitHandlers.push(handler);
      if (event === 'error') errorHandlers.push(handler);
    },
    kill() {
      killed = true;
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

function makeSseStream() {
  const chunks = [];
  const waiters = [];
  let closed = false;
  function nextChunk() {
    if (chunks.length) return Promise.resolve({ done: false, value: chunks.shift() });
    if (closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => waiters.push(resolve));
  }
  return {
    push(event) {
      const frame = 'event: message\ndata: ' + JSON.stringify(event) + '\n\n';
      const chunk = new TextEncoder().encode(frame);
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value: chunk });
      else chunks.push(chunk);
    },
    close() {
      closed = true;
      const waiter = waiters.shift();
      if (waiter) waiter({ done: true, value: undefined });
    },
    responseBody() {
      return {
        getReader() {
          return { read: nextChunk };
        },
      };
    },
  };
}

function jsonResponse(value, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

function makeFetch() {
  const calls = [];
  const sse = makeSseStream();
  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || 'GET', path: parsed.pathname, body });
    if (parsed.pathname === '/event') {
      return { ok: true, status: 200, body: sse.responseBody() };
    }
    if (parsed.pathname === '/mcp') return jsonResponse({ ae: { status: 'connected' } });
    if (parsed.pathname === '/session' && options.method === 'POST') return jsonResponse({ id: 'session_1' });
    if (parsed.pathname === '/config/providers') {
      return jsonResponse({
        opencode: {
          id: 'opencode',
          name: 'OpenCode Zen',
          models: { 'north-mini-code-free': { name: 'North Mini Code Free' } },
        },
      });
    }
    return jsonResponse({ ok: true });
  }
  return { fetchImpl, calls, sse };
}

function makeFs() {
  const writes = [];
  const dirs = [];
  return {
    writes,
    dirs,
    mkdirSync(dir, options) {
      dirs.push({ dir, options });
    },
    writeFileSync(file, text) {
      writes.push({ file, text });
    },
    rmSync() {},
  };
}

const TOOL_META = {
  annotations: {
    mcp__ae__ae_overview: { readOnly: true, destructive: false },
    mcp__ae__ae_setProperty: { readOnly: false, destructive: false },
    mcp__ae__ae_exec: { readOnly: false, destructive: true },
  },
};

function makeBackend(options = {}) {
  const events = [];
  const spawned = makeSpawn();
  const fetched = makeFetch();
  const fsImpl = makeFs();
  const backend = createOpenCodeBackend({
    spawnImpl: spawned.spawn,
    fetchImpl: fetched.fetchImpl,
    getPort: async () => 4567,
    fsImpl,
    osImpl: { tmpdir: () => 'C:\\tmp' },
    pathImpl: {
      join: (...parts) => parts.join('\\'),
    },
    tempDirName: () => 'ae-opencode-test',
    getMcpSpec: async () => ({ command: 'ae-mcp', args: ['--stdio'], env: { A: 'B' } }),
    getToolMeta: async () => TOOL_META,
    getModel: () => 'north-mini-code-free',
    getPermissionMode: () => 'manual',
    onEvent: (evt) => events.push(evt),
    env: { PATH: 'C:\\Node' },
    ...options,
  });
  return { backend, events, spawned, fetched, fsImpl };
}

test('createOpenCodeBackend starts opencode serve, writes isolated ae MCP config, and sends a session message', async () => {
  const { backend, spawned, fetched, fsImpl } = makeBackend();
  const pending = backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls.length, 1);
  assert.equal(spawned.calls[0].command, 'opencode');
  assert.deepEqual(spawned.calls[0].args, ['serve', '--port', '4567']);
  assert.equal(spawned.calls[0].options.shell, true);
  assert.equal(spawned.calls[0].options.windowsHide, true);
  assert.equal(spawned.calls[0].options.env.XDG_CONFIG_HOME, 'C:\\tmp\\ae-opencode-test');

  assert.equal(fsImpl.writes.length, 1);
  assert.equal(fsImpl.writes[0].file, 'C:\\tmp\\ae-opencode-test\\opencode\\opencode.json');
  assert.deepEqual(JSON.parse(fsImpl.writes[0].text).mcp.ae, {
    type: 'local',
    command: ['ae-mcp', '--stdio'],
    enabled: true,
    timeout: 120000,
    environment: { A: 'B', AE_MCP_BACKEND: 'ae-mcp' },
  });

  await flush();
  const sessionCall = fetched.calls.find((call) => call.path === '/session');
  assert.deepEqual(sessionCall.body.model, { id: 'north-mini-code-free', providerID: 'opencode' });
  assert.equal(sessionCall.body.permission.type, 'ask');
  assert.equal(fetched.calls.some((call) => call.path === '/session/session_1/message' && call.body.parts[0].text === 'hello'), true);

  fetched.sse.push({ type: 'session.status', properties: { sessionID: 'session_1', status: { type: 'idle' } } });
  await pending;
});

// Fixtures use the real OpenCode wire shape:
// { type, properties } with dotted types; text via message.part.delta
// (field:'text'), tools via message.part.updated (part.type:'tool', state),
// turn lifecycle via session.status (busy/idle). MCP tool name is doubled
// "ae_ae_ping" (server "ae" + tool "ae_ping").
test('createOpenCodeBackend maps text, reasoning, tool, and idle SSE events to panel events', async () => {
  const { backend, events, fetched } = makeBackend();
  const pending = backend.sendUser('events');
  await flush();

  fetched.sse.push({ type: 'session.status', properties: { sessionID: 'session_1', status: { type: 'busy' } } });
  fetched.sse.push({ type: 'message.part.delta', properties: { sessionID: 'session_1', field: 'reasoning', delta: 'think' } });
  fetched.sse.push({ type: 'message.part.delta', properties: { sessionID: 'session_1', field: 'text', delta: 'hi' } });
  fetched.sse.push({ type: 'message.part.updated', properties: { sessionID: 'session_1', part: { type: 'tool', tool: 'ae_ae_ping', callID: 'tool_1', state: { status: 'running', input: { x: 1 } } } } });
  fetched.sse.push({ type: 'message.part.updated', properties: { sessionID: 'session_1', part: { type: 'tool', tool: 'ae_ae_ping', callID: 'tool_1', state: { status: 'completed', output: '{"ok":true}', time: { start: 0, end: 25 } } } } });
  fetched.sse.push({ type: 'session.status', properties: { sessionID: 'session_1', status: { type: 'idle' } } });
  await pending;

  assert.deepEqual(events, [
    { type: 'turn-start' },
    { type: 'thinking', active: true },
    { type: 'thinking', active: false },
    { type: 'text-delta', text: 'hi' },
    { type: 'tool-start', toolUseId: 'tool_1', name: 'mcp__ae__ae_ping', input: { x: 1 } },
    { type: 'tool-result', toolUseId: 'tool_1', name: 'mcp__ae__ae_ping', ok: true, text: '{"ok":true}', durationMs: 25 },
    { type: 'turn-end', stopReason: 'end_turn' },
  ]);
});

test('OpenCode approval adapter applies annotation tiers and posts approval replies', async () => {
  const { backend, events, fetched } = makeBackend({ getPermissionMode: () => 'auto' });
  const pending = backend.sendUser('approve');
  await flush();

  // Permission prompts may not appear on read-only tool paths, so the adapter
  // matches defensively on a permission*ask* type.
  fetched.sse.push({
    type: 'permission.asked',
    properties: { sessionID: 'session_1', permissionID: 'perm_1', tool: 'ae_ae_exec', input: { code: 'app.project' } },
  });
  await flush();
  assert.deepEqual(events.at(-1), {
    type: 'approval-required',
    toolUseId: 'perm_1',
    name: 'mcp__ae__ae_exec',
    input: { code: 'app.project' },
    risk: 'destructive',
  });

  await backend.approve('perm_1', 'allow-session');
  assert.deepEqual(fetched.calls.at(-1), {
    method: 'POST',
    path: '/session/session_1/permission/perm_1',
    body: { action: 'allow', remember: true },
  });
  assert.deepEqual(events.at(-1), { type: 'tool-allowed', toolUseId: 'perm_1' });

  fetched.sse.push({
    type: 'permission.asked',
    properties: { sessionID: 'session_1', permissionID: 'perm_2', tool: 'ae_ae_exec', input: { code: 'app.project.item(1).remove()' } },
  });
  await flush();
  assert.equal(events.at(-1).type, 'tool-allowed');
  assert.equal(fetched.calls.at(-1).path, '/session/session_1/permission/perm_2');

  fetched.sse.push({ type: 'session.status', properties: { sessionID: 'session_1', status: { type: 'idle' } } });
  await pending;
});

test('OpenCode stop interrupts the session, drains pending approvals, and emits one aborted error', async () => {
  const { backend, events, fetched } = makeBackend();
  const pending = backend.sendUser('stop');
  await flush();
  fetched.sse.push({ type: 'permission.asked', properties: { sessionID: 'session_1', permissionID: 'perm_stop', tool: 'ae_ae_exec', input: {} } });
  await flush();

  await backend.stop();
  assert.equal(fetched.calls.some((call) => call.path === '/session/session_1/interrupt'), true);
  assert.deepEqual(events.slice(-2), [
    { type: 'tool-denied', toolUseId: 'perm_stop' },
    { type: 'error', kind: 'aborted', message: 'Turn aborted.' },
  ]);
  await pending;
});

test('openCode descriptors use the free default and map provider model metadata', () => {
  const staticDescriptor = openCodeStaticDescriptor();
  assert.equal(staticDescriptor.id, 'opencode');
  assert.equal(staticDescriptor.defaultModelId, 'north-mini-code-free');
  assert.equal(staticDescriptor.supportsFast('north-mini-code-free'), false);
  assert.deepEqual(staticDescriptor.models[0].effortLevels, []);

  const descriptor = openCodeDescriptorFromModels({
    opencode: {
      name: 'OpenCode Zen',
      models: {
        'north-mini-code-free': { name: 'North Mini Code Free' },
        'south-pro-code': { name: 'South Pro Code' },
      },
    },
  });
  assert.equal(descriptor.id, 'opencode');
  assert.deepEqual(descriptor.models.map((m) => m.id), ['north-mini-code-free', 'south-pro-code']);
  assert.equal(descriptor.defaultModelId, 'north-mini-code-free');
  assert.equal(descriptor.approvalModes.length, 4);
});
