import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeBackend } from '../src/cep/openCodeBackend.js';
import { openCodeDescriptorFromModels, openCodeStaticDescriptor } from '../src/lib/backendCapabilities.js';

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeProc() {
  const stdoutHandlers = [];
  const stderrHandlers = [];
  const exitHandlers = [];
  const errorHandlers = [];
  let killed = false;
  return {
    get killed() {
      return killed;
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
    exit(code = 0, signal = null) {
      for (const handler of exitHandlers) handler(code, signal);
    },
    error(error) {
      for (const handler of errorHandlers) handler(error);
    },
    pushStderr(text) {
      for (const handler of stderrHandlers) handler(text);
    },
    pushStdout(text) {
      for (const handler of stdoutHandlers) handler(text);
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
  const sseStreams = [];
  let sse = null;
  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method: options.method || 'GET', path: parsed.pathname, body });
    if (parsed.pathname === '/event') {
      sse = makeSseStream();
      sseStreams.push(sse);
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
  return {
    fetchImpl,
    calls,
    sseStreams,
    get sse() { return sse; },
  };
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
  const platform = {
    id: 'windows-x64',
    paths: { tempRoot: 'C:\\tmp', join: (parts) => parts.join('\\') },
    fs: fsImpl,
    completeSpawnEnv: (base = {}, additions = {}) => ({ ...base, ...additions }),
    resolveExecutable: options.resolveExecutable || (async () => ({ ok: true, id: 'opencode', path: 'C:\\Tools\\opencode.exe', argsPrefix: [], source: 'path', version: '1.0.0', arch: 'x64' })),
    spawn: (executable, args, spawnOptions) => {
      if (options.spawnError) throw options.spawnError;
      return spawned.spawn(executable.path, [...(executable.argsPrefix || []), ...args], spawnOptions);
    },
  };
  const backend = createOpenCodeBackend({
    platform,
    fetchImpl: fetched.fetchImpl,
    getPort: async () => 4567,
    fsImpl,
    tempDirName: () => 'ae-opencode-test',
    getMcpSpec: async () => ({
      kind: 'http',
      url: 'http://127.0.0.1:11488/mcp/c/opencode-default-token',
      name: 'ae',
    }),
    getToolMeta: async () => TOOL_META,
    getModel: () => 'north-mini-code-free',
    getPermissionMode: () => 'manual',
    onEvent: (evt) => events.push(evt),
    env: { PATH: 'C:\\Node' },
    ...options,
  });
  return { backend, events, spawned, fetched, fsImpl };
}

test('createOpenCodeBackend sends official file parts and accepts at dispatch', async () => {
  const { backend, events, fetched } = makeBackend();
  const pending = backend.sendUser({
    turnId: 'turn-1',
    text: 'inspect',
    attachments: [{
      id: 'att-1',
      name: 'notes.pdf',
      localPath: 'C:\\tmp\\notes.pdf',
      size: 12,
      mediaType: 'application/pdf',
      temporary: false,
    }],
  });
  await flush();

  const message = fetched.calls.find((call) => call.path === '/session/session_1/message');
  assert.deepEqual(message.body, {
    parts: [
      { type: 'text', text: 'inspect' },
      {
        type: 'file',
        mime: 'application/pdf',
        filename: 'notes.pdf',
        url: 'file:///C:/tmp/notes.pdf',
      },
    ],
  });
  assert.deepEqual(events[0], {
    type: 'turn-accepted',
    turnId: 'turn-1',
    transport: 'opencode-file-part',
  });
  assert.equal(JSON.stringify(events).includes('C:\\tmp'), false);

  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await pending;
  assert.deepEqual(backend.getMessages()[0], { role: 'user', text: 'inspect' });
});

test('createOpenCodeBackend redacts an attachment path split across output and transcript', async () => {
  const path = 'C:\\private\\customer.mov';
  const fileUrl = 'file:///C:/private/customer.mov';
  const { backend, events, fetched } = makeBackend();
  const pending = backend.sendUser({
    turnId: 'turn-redact-output',
    text: 'inspect',
    attachments: [{
      id: 'att-1',
      name: 'customer.mov',
      localPath: path,
      size: 12,
      mediaType: 'video/quicktime',
      temporary: false,
    }],
  });
  await flush();

  fetched.sse.push({
    type: 'message.part.delta',
    properties: { sessionID: 'session_1', field: 'text', delta: 'file:///C:/private/' },
  });
  fetched.sse.push({
    type: 'message.part.delta',
    properties: { sessionID: 'session_1', field: 'text', delta: 'customer.mov' },
  });
  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await pending;

  const rendered = JSON.stringify({ events, messages: backend.getMessages() });
  assert.equal(rendered.includes(path), false);
  assert.equal(rendered.includes(fileUrl), false);
  assert.match(rendered, /\[redacted\]/);
});

test('createOpenCodeBackend redacts an attachment path split across stderr failure', async () => {
  const path = 'C:\\private\\customer.mov';
  const { backend, events, spawned } = makeBackend();
  const pending = backend.sendUser({
    turnId: 'turn-redact-stderr',
    text: 'inspect',
    attachments: [{
      id: 'att-1',
      name: 'customer.mov',
      localPath: path,
      size: 12,
      mediaType: 'video/quicktime',
      temporary: false,
    }],
  });
  await flush();

  const proc = spawned.procs[0];
  proc.pushStderr('failed C:\\private\\');
  proc.pushStderr('customer.mov');
  proc.exit(1);
  await pending;

  const rendered = JSON.stringify(events);
  assert.equal(rendered.includes(path), false);
  assert.match(rendered, /\[redacted\]/);
});

test('createOpenCodeBackend keeps attachment stderr redaction until the persistent process exits', async () => {
  const fileUrl = 'file:///C:/private/late-customer.mov';
  const { backend, events, spawned, fetched } = makeBackend();
  const first = backend.sendUser({
    turnId: 'turn-attachment',
    text: 'inspect',
    attachments: [{
      id: 'att-1',
      name: 'late-customer.mov',
      localPath: 'C:\\private\\late-customer.mov',
      size: 20,
      mediaType: 'video/quicktime',
      temporary: false,
    }],
  });
  await flush();
  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await first;

  const proc = spawned.procs[0];
  proc.pushStderr('late file:///C:/private/');
  proc.pushStderr('late-customer.mov');
  const second = backend.sendUser({
    turnId: 'turn-text-only',
    text: 'next',
    attachments: [],
  });
  await flush();
  proc.exit(1);
  await second;

  const rendered = JSON.stringify(events);
  assert.equal(rendered.includes(fileUrl), false);
  assert.match(rendered, /\[redacted\]/);
});

test('createOpenCodeBackend correlates a failed message POST as uncertain without retry', async () => {
  const base = makeFetch();
  let rejectMessage;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/session/session_1/message') {
      base.calls.push({
        method: options.method || 'GET',
        path: parsed.pathname,
        body: options.body ? JSON.parse(options.body) : null,
      });
      return await new Promise((_resolve, reject) => { rejectMessage = reject; });
    }
    return base.fetchImpl(url, options);
  };
  const { backend, events } = makeBackend({ fetchImpl });
  const pending = backend.sendUser({
    turnId: 'turn-post-failed',
    text: 'inspect',
    attachments: [],
  });
  for (let index = 0; index < 20 && !rejectMessage; index += 1) await flush();
  assert.equal(typeof rejectMessage, 'function');
  // Accepted must land while the POST is still in flight (SSE deltas can
  // arrive before the blocking POST returns; see the reply-order fix).
  assert.equal(events.some((evt) => evt.type === 'turn-accepted' && evt.turnId === 'turn-post-failed'), true);
  rejectMessage(new Error('message POST disconnected'));
  await pending;

  // The turn was accepted at dispatch, so a POST failure is an in-chat error
  // for the already-rendered turn, not a draft-recovery dispatchState.
  assert.deepEqual(events.at(-1), {
    type: 'error',
    kind: 'backend',
    code: 'TURN_START_FAILED',
    message: 'OpenCode turn could not be started.',
    detail: { endpoint: '/session/session_1/message' },
    turnId: 'turn-post-failed',
    dispatchState: 'uncertain',
  });
  assert.equal(base.calls.filter((call) => call.path === '/session/session_1/message').length, 1);
});

test('createOpenCodeBackend starts opencode serve, writes isolated ae MCP config, and sends a session message', async () => {
  const { backend, spawned, fetched, fsImpl } = makeBackend();
  const pending = backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls.length, 1);
  assert.equal(spawned.calls[0].command, 'C:\\Tools\\opencode.exe');
  assert.deepEqual(spawned.calls[0].args, ['serve', '--port', '4567']);
  assert.equal(spawned.calls[0].options.shell, undefined);
  assert.equal(spawned.calls[0].options.windowsHide, true);
  // OpenCode scopes project context to cwd; inheriting AE's cwd ballooned
  // provider requests until relay-side WAFs rejected them (2026-08-20).
  assert.equal(spawned.calls[0].options.cwd, 'C:\\tmp\\ae-opencode-test');
  assert.equal(spawned.calls[0].options.env.XDG_CONFIG_HOME, 'C:\\tmp\\ae-opencode-test');

  assert.equal(fsImpl.writes.length, 1);
  assert.equal(fsImpl.writes[0].file, 'C:\\tmp\\ae-opencode-test\\opencode\\opencode.json');
  assert.deepEqual(JSON.parse(fsImpl.writes[0].text).mcp.ae, {
    type: 'remote',
    url: 'http://127.0.0.1:11488/mcp/c/opencode-default-token',
    enabled: true,
  });

  await flush();
  const sessionCall = fetched.calls.find((call) => call.path === '/session');
  assert.deepEqual(sessionCall.body.model, { id: 'north-mini-code-free', providerID: 'opencode' });
  assert.equal('permission' in sessionCall.body, false);
  assert.equal(fetched.calls.some((call) => call.path === '/session/session_1/message' && call.body.parts[0].text === 'hello'), true);

  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await pending;
});

test('createOpenCodeBackend writes only a per-conversation remote MCP URL', async () => {
  const url = 'http://127.0.0.1:11488/mcp/c/opencode-token';
  const { backend, fetched, fsImpl } = makeBackend({
    getMcpSpec: async () => ({ kind: 'http', url, name: 'ae' }),
  });
  const pending = backend.sendUser('http mcp');
  await flush();

  assert.deepEqual(JSON.parse(fsImpl.writes[0].text).mcp.ae, {
    type: 'remote',
    url,
    enabled: true,
  });
  assert.match(JSON.parse(fsImpl.writes[0].text).mcp.ae.url, /\/mcp\/c\//);
  fetched.sse.push({ type: 'session.status', properties: { sessionID: 'session_1', status: { type: 'idle' } } });
  await pending;
});

test('createOpenCodeBackend injects panel-managed OpenCode provider definitions', async () => {
  const { backend, fetched, fsImpl } = makeBackend({
    getProviders: () => [{
      id: 'aemcp-relay',
      name: 'Relay',
      baseUrl: 'https://relay.example/v1',
      modelId: 'claude-test',
      allowInsecureHttp: false,
      needsApiKey: false,
    }],
    getModel: () => 'aemcp-relay/claude-test',
  });
  const pending = backend.sendUser('provider config');
  await flush();

  const config = JSON.parse(fsImpl.writes[0].text);
  assert.deepEqual(config.permission, { '*': 'allow' });
  assert.deepEqual(config.provider, {
    'aemcp-relay': {
      npm: '@ai-sdk/anthropic',
      name: 'Relay',
      options: { baseURL: 'https://relay.example/v1' },
      models: { 'claude-test': { name: 'claude-test' } },
    },
  });
  assert.deepEqual(fetched.calls.find((call) => call.path === '/session').body.model, {
    id: 'claude-test',
    providerID: 'aemcp-relay',
  });

  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
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
    { type: 'error', kind: 'aborted', code: 'TURN_ABORTED', message: 'Turn aborted.' },
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

test('session.error objects surface their nested message as UPSTREAM_ERROR', async () => {
  const { backend, events, fetched } = makeBackend();
  const pending = backend.sendUser({ turnId: 'turn-err', text: 'hello', attachments: [] });
  for (let index = 0; index < 30
    && !fetched.calls.some((call) => call.path === '/session/session_1/message'); index += 1) {
    await flush();
  }
  fetched.sse.push({
    type: 'session.error',
    properties: {
      sessionID: 'session_1',
      error: { name: 'UnknownError', data: { message: 'relay rejected the model request' } },
    },
  });
  await pending;
  const errorEvent = [...events].reverse().find((evt) => evt.type === 'error');
  assert.equal(errorEvent.message, 'relay rejected the model request');
  assert.equal(errorEvent.code, 'UPSTREAM_ERROR');
  assert.equal(errorEvent.detail.errorName, 'UnknownError');
});

test('OpenCode session creation HTTP 400 keeps status, endpoint, and a bounded response excerpt', async () => {
  const base = makeFetch();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/session' && options.method === 'POST') {
      return jsonResponse({ error: 'request body rejected' }, false, 400);
    }
    return base.fetchImpl(url, options);
  };
  const { backend, events } = makeBackend({ fetchImpl });
  await backend.sendUser({ turnId: 'turn-session-400', text: 'hello', attachments: [] });

  const error = events.find((event) => event.type === 'error');
  assert.equal(error.code, 'UPSTREAM_HTTP_400');
  assert.deepEqual(error.detail, {
    httpStatus: 400,
    endpoint: '/session',
    responseExcerpt: '{"error":"request body rejected"}',
  });
  assert.equal(error.dispatchState, 'not-started');
});

test('OpenCode MCP readiness timeout keeps the fixed message and last response detail', async () => {
  const base = makeFetch();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/mcp') return jsonResponse({ error: 'starting' }, false, 503);
    return base.fetchImpl(url, options);
  };
  const { backend, events } = makeBackend({
    fetchImpl,
    readyTimeoutMs: 3,
    readyPollMs: 0,
    sleepImpl: async () => {},
  });
  await backend.sendUser({ turnId: 'turn-mcp-timeout', text: 'hello', attachments: [] });

  const error = events.find((event) => event.type === 'error');
  assert.equal(error.code, 'MCP_UNREACHABLE');
  assert.equal(error.message, 'OpenCode MCP server did not become ready.');
  assert.equal(error.detail.mcpStatus, 503);
  assert.equal(error.detail.httpStatus, 503);
  assert.equal(error.detail.lastError, 'OpenCode request failed.');
  assert.equal(error.detail.responseExcerpt, '{"error":"starting"}');
});

test('OpenCode separates session-start failure from a dispatched message POST failure', async () => {
  const base = makeFetch();
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/session' && options.method === 'POST') return jsonResponse({});
    return base.fetchImpl(url, options);
  };
  const { backend, events } = makeBackend({ fetchImpl });
  await backend.sendUser({ turnId: 'turn-no-session', text: 'hello', attachments: [] });

  const error = events.find((event) => event.type === 'error');
  assert.equal(error.code, 'SESSION_START_FAILED');
  assert.equal(error.dispatchState, 'not-started');
});

test('OpenCode captures stdout in the same bounded process tail', async () => {
  const { backend, spawned, fetched } = makeBackend();
  const pending = backend.sendUser({ turnId: 'turn-stdout', text: 'hello', attachments: [] });
  await flush();
  spawned.procs[0].pushStdout('server ready on stdout\n');
  assert.match(backend.getStderrTail(), /server ready on stdout/);
  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await pending;
});

test('OpenCode maps session.error HTTP status to an upstream HTTP category', async () => {
  const { backend, events, fetched } = makeBackend();
  const pending = backend.sendUser({ turnId: 'turn-http-error', text: 'hello', attachments: [] });
  for (let index = 0; index < 30
    && !fetched.calls.some((call) => call.path === '/session/session_1/message'); index += 1) {
    await flush();
  }
  fetched.sse.push({
    type: 'session.error',
    properties: {
      sessionID: 'session_1',
      error: { name: 'RelayError', data: { message: 'unexpected status 403' } },
    },
  });
  await pending;
  const error = events.find((event) => event.type === 'error');
  assert.equal(error.code, 'UPSTREAM_HTTP_403');
  assert.equal(error.detail.httpStatus, 403);
  assert.equal(error.detail.upstreamMessage, 'unexpected status 403');
});

test('OpenCode SSE disconnect emits EVENT_STREAM_FAILED and settles the turn', async () => {
  const { backend, events, fetched, spawned } = makeBackend();
  const pending = backend.sendUser({ turnId: 'turn-sse-close', text: 'hello', attachments: [] });
  for (let index = 0; index < 30
    && !fetched.calls.some((call) => call.path === '/session/session_1/message'); index += 1) {
    await flush();
  }
  fetched.sse.close();
  await pending;

  const errors = events.filter((event) => event.type === 'error');
  assert.equal(errors.length, 1);
  const [error] = errors;
  assert.equal(error.code, 'EVENT_STREAM_FAILED');
  assert.equal(error.detail.endpoint, '/event');
  assert.equal(error.turnId, 'turn-sse-close');
  assert.equal(spawned.procs[0].killed, true);
});

test('OpenCode restarts after an idle SSE disconnect without emitting a turn error', async () => {
  const { backend, events, fetched, spawned } = makeBackend();
  await backend.probeAccount();
  assert.equal(spawned.calls.length, 1);
  fetched.sse.close();
  await flush();
  await flush();

  assert.equal(events.some((event) => event.type === 'error'), false);
  const pending = backend.sendUser({ turnId: 'turn-after-idle-close', text: 'hello', attachments: [] });
  for (let index = 0; index < 30
    && !fetched.calls.some((call) => call.path === '/session/session_1/message'); index += 1) {
    await flush();
  }
  assert.equal(spawned.calls.length, 2);
  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await pending;
  assert.equal(events.some((event) => event.type === 'error'), false);
});

test('OpenCode reads getLang for each resolution failure without rebuilding the backend', async () => {
  let currentLang = 'en';
  const h = makeBackend({
    getLang: () => currentLang,
    resolveExecutable: async () => ({ ok: false, code: 'NOT_FOUND' }),
  });

  await h.backend.sendUser({ turnId: 'turn-en', text: 'hello', attachments: [] });
  currentLang = 'zh';
  await h.backend.sendUser({ turnId: 'turn-zh', text: 'hello', attachments: [] });

  const errors = h.events.filter((event) => event.type === 'error');
  assert.match(errors[0].message, /not found/i);
  assert.match(errors[1].message, /未找到/);
  assert.equal(h.spawned.calls.length, 0);
});

test('OpenCode distinguishes CLI architecture and spawn failures', async () => {
  const resolution = makeBackend({
    resolveExecutable: async () => ({
      ok: false,
      code: 'ARCH_MISMATCH',
      attempts: [{ path: 'C:\\Tools\\opencode.exe', source: 'path', detail: 'architecture arm64' }],
    }),
  });
  await resolution.backend.sendUser({ turnId: 'turn-arch', text: 'hello', attachments: [] });
  const arch = resolution.events.find((event) => event.type === 'error');
  assert.equal(arch.code, 'CLI_ARCH_MISMATCH');
  assert.match(arch.message, /arm64/);
  assert.equal(arch.detail.resolution.attempts.length, 1);

  const denied = new Error('spawn EACCES');
  denied.code = 'EACCES';
  const spawn = makeBackend({ spawnError: denied });
  await spawn.backend.sendUser({ turnId: 'turn-spawn', text: 'hello', attachments: [] });
  assert.equal(spawn.events.find((event) => event.type === 'error')?.code, 'SPAWN_FAILED');
});

test('probe then send reuse one opencode instance and one event stream', async () => {
  const { backend, spawned, fetched } = makeBackend();
  await backend.probeAccount();
  assert.equal(spawned.calls.length, 1);
  const pending = backend.sendUser({ turnId: 'turn-reuse', text: 'hello', attachments: [] });
  for (let index = 0; index < 30
    && !fetched.calls.some((call) => call.path === '/session/session_1/message'); index += 1) {
    await flush();
  }
  assert.equal(spawned.calls.length, 1);
  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await pending;
  assert.equal(spawned.calls.length, 1);
});
