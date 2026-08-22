import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeBackend } from '../src/cep/openCodeBackend.js';
import { openCodeDescriptorFromModels, openCodeStaticDescriptor } from '../src/lib/backendCapabilities.js';

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeProc(pid = 7001) {
  const stdoutHandlers = [];
  const stderrHandlers = [];
  const exitHandlers = [];
  const errorHandlers = [];
  let killed = false;
  return {
    pid,
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
    const proc = makeProc(7001 + procs.length);
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

function makeFs({ entries = [], files = {}, throwOnRemove = [] } = {}) {
  const writes = [];
  const dirs = [];
  const removals = [];
  const syncRemovals = [];
  const stored = new Map(Object.entries(files));
  return {
    writes,
    dirs,
    removals,
    syncRemovals,
    mkdirSync(dir, options) {
      dirs.push({ dir, options });
    },
    writeFileSync(file, text) {
      writes.push({ file, text });
      stored.set(file, String(text));
    },
    readdirSync() {
      return entries.slice();
    },
    existsSync(file) {
      return stored.has(file);
    },
    readFileSync(file) {
      if (!stored.has(file)) throw new Error('missing file');
      return stored.get(file);
    },
    rm(dir, options, callback) {
      removals.push(dir);
      queueMicrotask(() => callback(null));
    },
    rmSync(dir) {
      syncRemovals.push(dir);
      removals.push(dir);
      if (throwOnRemove.includes(dir)) throw new Error('directory busy');
    },
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
  const fsImpl = options.fsImpl || makeFs(options.fsOptions);
  const terminated = [];
  const platform = {
    id: 'windows-x64',
    pid: 4100,
    paths: {
      tempRoot: 'C:\\tmp',
      configRoot: 'C:\\Users\\test\\.ae-mcp',
      join: (parts) => parts.join('\\'),
    },
    fs: fsImpl,
    completeSpawnEnv: (base = {}, additions = {}) => ({ ...base, ...additions }),
    processAlive: options.processAlive || (async () => false),
    resolveExecutable: options.resolveExecutable || (async () => ({ ok: true, id: 'opencode', path: 'C:\\Tools\\opencode.exe', argsPrefix: [], source: 'path', version: '1.0.0', arch: 'x64' })),
    spawn: (executable, args, spawnOptions) => {
      if (options.spawnError) throw options.spawnError;
      return spawned.spawn(executable.path, [...(executable.argsPrefix || []), ...args], spawnOptions);
    },
    terminateProcess: async (request) => {
      terminated.push(request);
      return { ok: true, matched: true, killed: true, detail: 'terminated' };
    },
  };
  const backend = createOpenCodeBackend({
    platform,
    fetchImpl: fetched.fetchImpl,
    getPort: async () => 4567,
    fsImpl,
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
  return { backend, events, spawned, fetched, fsImpl, terminated };
}

function makeSweepFs(marker, removeImpl) {
  const files = new Map([
    ['C:\\tmp\\ae-opencode-old\\instance.json', JSON.stringify(marker)],
  ]);
  const removals = [];
  const syncRemovals = [];
  return {
    files,
    removals,
    syncRemovals,
    readdirSync: () => ['ae-opencode-old'],
    existsSync: (file) => files.has(file),
    readFileSync: (file) => files.get(file),
    mkdirSync() {},
    writeFileSync(file, text) {
      files.set(file, text);
    },
    rm(dir, options, callback) {
      removals.push(dir);
      if (removeImpl) removeImpl(dir, options, callback);
      else queueMicrotask(() => callback(null));
    },
    rmSync(dir) {
      syncRemovals.push(dir);
    },
  };
}

function makeStableFs(marker) {
  const markerPath = 'C:\\Users\\test\\.ae-mcp\\opencode\\home-11488\\instance.json';
  const files = new Map(marker ? [[markerPath, JSON.stringify(marker)]] : []);
  const writes = [];
  const dirs = [];
  const removals = [];
  return {
    markerPath,
    files,
    writes,
    dirs,
    removals,
    readdirSync: () => [],
    existsSync: (file) => files.has(file),
    readFileSync: (file) => files.get(file),
    mkdirSync(dir, options) {
      dirs.push({ dir, options });
    },
    writeFileSync(file, text) {
      writes.push({ file, text });
      files.set(file, text);
    },
    rm(dir, _options, callback) {
      removals.push(dir);
      files.delete(dir);
      queueMicrotask(() => callback(null));
    },
    rmSync(file) {
      removals.push(file);
      files.delete(file);
    },
  };
}

test('OpenCode reclaims a stable marker owned by this panel before spawn', async () => {
  const fsImpl = makeStableFs({ owner: 'ae-mcp-panel', ownerPid: 4100, pid: 7101 });
  const h = makeBackend({ fsImpl });
  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  assert.deepEqual(h.terminated, [{ pid: 7101, executableName: 'opencode' }]);
  assert.equal(fsImpl.removals.includes(fsImpl.markerPath), true);
});

test('OpenCode does not terminate a stable marker owned by another live panel', async () => {
  const fsImpl = makeStableFs({ owner: 'ae-mcp-panel', ownerPid: 5100, pid: 7102 });
  const aliveRequests = [];
  const h = makeBackend({
    fsImpl,
    processAlive: async (request) => { aliveRequests.push(request); return true; },
  });
  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  assert.deepEqual(aliveRequests, [{ pid: 5100 }]);
  assert.equal(h.terminated.length, 0);
  assert.equal(fsImpl.removals.includes(fsImpl.markerPath), true);
});

test('OpenCode terminates a stable marker after its owner process exits', async () => {
  const fsImpl = makeStableFs({ owner: 'ae-mcp-panel', ownerPid: 5101, pid: 7103 });
  const aliveRequests = [];
  const h = makeBackend({
    fsImpl,
    processAlive: async (request) => { aliveRequests.push(request); return false; },
  });
  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  assert.deepEqual(aliveRequests, [{ pid: 5101 }]);
  assert.deepEqual(h.terminated, [{ pid: 7103, executableName: 'opencode' }]);
  assert.equal(fsImpl.removals.includes(fsImpl.markerPath), true);
});

test('OpenCode reset and unexpected exit remove only the stable instance marker', async () => {
  const configHome = 'C:\\Users\\test\\.ae-mcp\\opencode\\home-11488';
  const resetFs = makeStableFs(null);
  const resetBackend = makeBackend({ fsImpl: resetFs });
  assert.deepEqual(await resetBackend.backend.probeAccount(), { loggedIn: true });
  resetBackend.backend.reset();
  assert.equal(resetFs.removals.includes(resetFs.markerPath), true);
  assert.equal(resetFs.removals.includes(configHome), false);

  const exitFs = makeStableFs(null);
  const exited = makeBackend({ fsImpl: exitFs });
  assert.deepEqual(await exited.backend.probeAccount(), { loggedIn: true });
  exited.spawned.procs[0].exit(1);
  await flush();
  assert.equal(exitFs.removals.includes(exitFs.markerPath), true);
  assert.equal(exitFs.removals.includes(configHome), false);
});

test('OpenCode keeps reasoning parts out of assistant text', async () => {
  const { backend, events, fetched } = makeBackend();
  const pending = backend.sendUser({ turnId: 'turn-reasoning', text: 'reply OK', attachments: [] });
  await flush();

  fetched.sse.push({
    type: 'message.part.updated',
    properties: { sessionID: 'session_1', part: { id: 'prt_A', type: 'reasoning', text: '' } },
  });
  await flush();
  const thinkingBeforeReasoning = events.findIndex((event) => event.type === 'thinking' && event.active === true);
  fetched.sse.push({
    type: 'message.part.delta',
    properties: { sessionID: 'session_1', partID: 'prt_A', field: 'text', delta: 'We need answer only OK.' },
  });
  fetched.sse.push({
    type: 'message.part.updated',
    properties: { sessionID: 'session_1', part: { id: 'prt_A', type: 'reasoning', text: 'We need answer only OK.' } },
  });
  fetched.sse.push({
    type: 'message.part.updated',
    properties: { sessionID: 'session_1', part: { id: 'prt_B', type: 'text', text: '' } },
  });
  fetched.sse.push({
    type: 'message.part.delta',
    properties: { sessionID: 'session_1', partID: 'prt_B', field: 'text', delta: 'OK' },
  });
  fetched.sse.push({
    type: 'message.part.updated',
    properties: { sessionID: 'session_1', part: { id: 'prt_B', type: 'text', text: 'OK' } },
  });
  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await pending;

  const textEvents = events.filter((event) => event.type === 'text-delta');
  assert.equal(textEvents.map((event) => event.text).join(''), 'OK');
  assert.deepEqual(backend.getMessages().at(-1), { role: 'assistant', text: 'OK' });
  const thinkingFinished = events.findIndex((event) => event.type === 'thinking' && event.active === false);
  const firstText = events.findIndex((event) => event.type === 'text-delta');
  assert.ok(thinkingBeforeReasoning >= 0);
  assert.ok(thinkingFinished > thinkingBeforeReasoning);
  assert.ok(firstText > thinkingFinished);
});

test('OpenCode falls back to delta field when the part type is unknown', async () => {
  const { backend, events, fetched } = makeBackend();
  const pending = backend.sendUser('legacy delta');
  await flush();
  fetched.sse.push({
    type: 'message.part.delta',
    properties: { sessionID: 'session_1', partID: 'unknown', field: 'text', delta: 'legacy' },
  });
  fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await pending;
  assert.equal(events.filter((event) => event.type === 'text-delta').map((event) => event.text).join(''), 'legacy');
  assert.deepEqual(backend.getMessages().at(-1), { role: 'assistant', text: 'legacy' });
});

test('OpenCode startup does not wait for asynchronous stale-directory removal', async () => {
  let finishRemove;
  const removePending = new Promise((resolve) => { finishRemove = resolve; });
  let removeStarted;
  const started = new Promise((resolve) => { removeStarted = resolve; });
  const fsImpl = makeSweepFs(null, (_dir, _options, callback) => {
    removeStarted();
    removePending.then(() => callback(null));
  });
  let sweepDone;
  const swept = new Promise((resolve) => { sweepDone = resolve; });
  const h = makeBackend({ fsImpl, onSweepComplete: sweepDone });
  const probe = h.backend.probeAccount();
  await started;

  const result = await Promise.race([
    probe,
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 500)),
  ]);
  assert.deepEqual(result, { loggedIn: true });
  assert.equal(fsImpl.syncRemovals.some((dir) => dir.startsWith('C:\\tmp\\ae-opencode-')), false);
  finishRemove();
  await swept;
  assert.equal(fsImpl.removals.filter((dir) => dir === 'C:\\tmp\\ae-opencode-old').length, 1);
});

test('OpenCode startup survives an asynchronous stale-directory removal failure', async () => {
  const fsImpl = makeSweepFs(null, (_dir, _options, callback) => {
    queueMicrotask(() => callback(new Error('remove failed')));
  });
  let sweepDone;
  const swept = new Promise((resolve) => { sweepDone = resolve; });
  const h = makeBackend({ fsImpl, onSweepComplete: sweepDone });
  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  await swept;
  assert.equal(fsImpl.removals.filter((dir) => dir === 'C:\\tmp\\ae-opencode-old').length, 1);
  assert.equal(fsImpl.syncRemovals.some((dir) => dir.startsWith('C:\\tmp\\ae-opencode-')), false);
});

test('OpenCode startup fails promptly when serve exits during MCP readiness', async () => {
  const base = makeFetch();
  const fetchImpl = async (url, options = {}) => {
    if (new URL(url).pathname === '/mcp') return jsonResponse({ error: 'starting' }, false, 503);
    return base.fetchImpl(url, options);
  };
  const h = makeBackend({
    fetchImpl,
    readyTimeoutMs: 1000,
    probeTimeoutMs: 2000,
    readyPollMs: 0,
    sleepImpl: () => new Promise((resolve) => setTimeout(resolve, 1)),
  });
  const probe = h.backend.probeAccount();
  for (let index = 0; index < 20 && !h.spawned.procs[0]; index += 1) await flush();
  assert.ok(h.spawned.procs[0]);
  h.spawned.procs[0].exit(1);
  const result = await Promise.race([
    probe,
    new Promise((resolve) => setTimeout(() => resolve('slow'), 200)),
  ]);
  assert.notEqual(result, 'slow');
  assert.equal(result.loggedIn, false);
});

test('OpenCode sweep skips an instance owned by another live panel', async () => {
  const fsImpl = makeSweepFs({ owner: 'ae-mcp-panel', ownerPid: 5200, pid: 6200 });
  const aliveRequests = [];
  let sweepDone;
  const swept = new Promise((resolve) => { sweepDone = resolve; });
  const h = makeBackend({
    fsImpl,
    processAlive: async (request) => { aliveRequests.push(request); return true; },
    onSweepComplete: sweepDone,
  });
  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  await swept;
  assert.deepEqual(aliveRequests, [{ pid: 5200 }]);
  assert.equal(h.terminated.length, 0);
  assert.equal(fsImpl.removals.includes('C:\\tmp\\ae-opencode-old'), false);
});

test('OpenCode sweep terminates an instance owned by the same panel process', async () => {
  const fsImpl = makeSweepFs({ owner: 'ae-mcp-panel', ownerPid: 4100, pid: 6201 });
  let sweepDone;
  const swept = new Promise((resolve) => { sweepDone = resolve; });
  const h = makeBackend({ fsImpl, onSweepComplete: sweepDone });
  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  await swept;
  assert.deepEqual(h.terminated, [{ pid: 6201, executableName: 'opencode' }]);
  assert.equal(fsImpl.removals.filter((dir) => dir === 'C:\\tmp\\ae-opencode-old').length, 1);
});

test('OpenCode sweep terminates an instance whose owner process is gone', async () => {
  const fsImpl = makeSweepFs({ owner: 'ae-mcp-panel', ownerPid: 5300, pid: 6202 });
  const aliveRequests = [];
  let sweepDone;
  const swept = new Promise((resolve) => { sweepDone = resolve; });
  const h = makeBackend({
    fsImpl,
    processAlive: async (request) => { aliveRequests.push(request); return false; },
    onSweepComplete: sweepDone,
  });
  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  await swept;
  assert.deepEqual(aliveRequests, [{ pid: 5300 }]);
  assert.deepEqual(h.terminated, [{ pid: 6202, executableName: 'opencode' }]);
  assert.equal(fsImpl.removals.filter((dir) => dir === 'C:\\tmp\\ae-opencode-old').length, 1);
});

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
  assert.deepEqual(events.find((event) => event.type === 'turn-accepted'), {
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
  assert.equal(spawned.calls[0].options.cwd, 'C:\\Users\\test\\.ae-mcp\\opencode\\workspace');
  assert.equal(spawned.calls[0].options.env.XDG_CONFIG_HOME, 'C:\\Users\\test\\.ae-mcp\\opencode\\home-11488');
  assert.equal(fsImpl.dirs.some((entry) => (
    entry.dir === 'C:\\Users\\test\\.ae-mcp\\opencode\\workspace'
      && entry.options.recursive === true
  )), true);
  assert.equal(fsImpl.dirs.some((entry) => (
    entry.dir === 'C:\\Users\\test\\.ae-mcp\\opencode\\home-11488\\opencode'
      && entry.options.recursive === true
  )), true);

  const configWrite = fsImpl.writes.find((write) => write.file.endsWith('opencode\\opencode.json'));
  assert.equal(configWrite.file, 'C:\\Users\\test\\.ae-mcp\\opencode\\home-11488\\opencode\\opencode.json');
  assert.deepEqual(JSON.parse(configWrite.text).mcp.ae, {
    type: 'remote',
    url: 'http://127.0.0.1:11488/mcp/c/opencode-default-token',
    enabled: true,
  });
  const markerWrite = fsImpl.writes.find((write) => write.file.endsWith('instance.json'));
  assert.equal(markerWrite.file, 'C:\\Users\\test\\.ae-mcp\\opencode\\home-11488\\instance.json');
  assert.deepEqual(JSON.parse(markerWrite.text), {
    owner: 'ae-mcp-panel',
    ownerPid: 4100,
    pid: 7001,
    port: 4567,
    startedAt: JSON.parse(markerWrite.text).startedAt,
  });
  assert.equal(Number.isNaN(Date.parse(JSON.parse(markerWrite.text).startedAt)), false);

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

test('OpenCode sweeps marked and unmarked stale homes while preserving the selected current home', async () => {
  const root = 'C:\\tmp';
  const markedHome = root + '\\ae-opencode-marked';
  const plainHome = root + '\\ae-opencode-plain';
  const currentHome = root + '\\ae-opencode-current';
  const fsImpl = makeFs({
    entries: ['other', 'ae-opencode-marked', 'ae-opencode-plain', 'ae-opencode-current'],
    files: {
      [markedHome + '\\instance.json']: JSON.stringify({
        owner: 'ae-mcp-panel', pid: 41, port: 4001, startedAt: '2026-08-22T00:00:00.000Z',
      }),
    },
  });
  let sweepDone;
  const swept = new Promise((resolve) => { sweepDone = resolve; });
  const h = makeBackend({ fsImpl, onSweepComplete: sweepDone });

  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  await swept;
  assert.deepEqual(h.terminated, [{ pid: 41, executableName: 'opencode' }]);
  assert.ok(fsImpl.removals.includes(markedHome));
  assert.ok(fsImpl.removals.includes(plainHome));
  assert.equal(fsImpl.removals.includes(currentHome), true);
  h.backend.reset();
});

test('OpenCode ignores stale-home removal failures and still starts the server', async () => {
  const staleHome = 'C:\\tmp\\ae-opencode-busy';
  const fsImpl = makeFs({
    entries: ['ae-opencode-busy'],
    throwOnRemove: [staleHome],
  });
  const h = makeBackend({ fsImpl });

  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  assert.equal(h.spawned.calls.length, 1);
  assert.ok(fsImpl.removals.includes(staleHome));
  h.backend.reset();
});

test('OpenCode stale sweeps bound process termination and directory removal work', async () => {
  const removableEntries = Array.from({ length: 70 }, (_value, index) => (
    'ae-opencode-plain-' + index
  ));
  const removableFs = makeFs({ entries: removableEntries });
  let removableSweepDone;
  const removableSwept = new Promise((resolve) => { removableSweepDone = resolve; });
  const removable = makeBackend({ fsImpl: removableFs, onSweepComplete: removableSweepDone });
  await removable.backend.probeAccount();
  await removableSwept;
  assert.equal(removableFs.removals.length, 64);
  removable.backend.reset();

  const markedEntries = Array.from({ length: 12 }, (_value, index) => (
    'ae-opencode-marked-' + index
  ));
  const markedFiles = Object.fromEntries(markedEntries.map((name, index) => [
    'C:\\tmp\\' + name + '\\instance.json',
    JSON.stringify({ owner: 'ae-mcp-panel', pid: 100 + index }),
  ]));
  const markedFs = makeFs({ entries: markedEntries, files: markedFiles });
  let markedSweepDone;
  const markedSwept = new Promise((resolve) => { markedSweepDone = resolve; });
  const marked = makeBackend({ fsImpl: markedFs, onSweepComplete: markedSweepDone });
  await marked.backend.probeAccount();
  await markedSwept;
  assert.equal(marked.terminated.length, 8);
  assert.equal(markedFs.removals.length, 8);
  marked.backend.reset();
});

test('OpenCode cancels an old starting generation without letting its exit clear the replacement', async () => {
  const base = makeFetch();
  let resolveFirstMcp;
  let holdFirstMcp = true;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/mcp' && holdFirstMcp) {
      holdFirstMcp = false;
      return new Promise((resolve) => { resolveFirstMcp = resolve; });
    }
    return base.fetchImpl(url, options);
  };
  const h = makeBackend({ fetchImpl });
  const firstProbe = h.backend.probeAccount();
  for (let index = 0; index < 30 && !resolveFirstMcp; index += 1) await flush();
  assert.equal(typeof resolveFirstMcp, 'function');
  const oldProc = h.spawned.procs[0];
  const marker = 'C:\\Users\\test\\.ae-mcp\\opencode\\home-11488\\instance.json';

  h.backend.reset();
  const secondProbe = await h.backend.probeAccount();
  assert.deepEqual(secondProbe, { loggedIn: true });
  assert.equal(h.spawned.calls.length, 2);
  resolveFirstMcp(jsonResponse({ ae: { status: 'connected' } }));
  assert.equal((await firstProbe).loggedIn, false);
  assert.equal(oldProc.killed, true);
  assert.ok(h.fsImpl.removals.includes(marker));

  oldProc.exit(0);
  const pending = h.backend.sendUser({ turnId: 'turn-after-cancel', text: 'hello', attachments: [] });
  for (let index = 0; index < 30
    && !base.calls.some((call) => call.path === '/session/session_1/message'); index += 1) {
    await flush();
  }
  assert.equal(h.spawned.calls.length, 2);
  base.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await pending;
});

test('OpenCode probe has a total timeout, aborts provider fetch, and resets idle runtime', async () => {
  const base = makeFetch();
  let providerSignal = null;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/config/providers') {
      providerSignal = options.signal;
      return new Promise(() => {});
    }
    return base.fetchImpl(url, options);
  };
  const h = makeBackend({
    fetchImpl,
    readyTimeoutMs: 5,
    probeTimeoutMs: 15,
  });

  const result = await h.backend.probeAccount();

  assert.deepEqual(result, {
    loggedIn: false,
    code: 'PROBE_TIMEOUT',
    detail: 'OpenCode probe timed out after 15ms',
  });
  assert.equal(providerSignal?.aborted, true);
  assert.equal(h.spawned.procs[0].killed, true);
});

test('OpenCode reports cold-start stages before model output and omits spawn on a warm turn', async () => {
  const h = makeBackend();
  const first = h.backend.sendUser({ turnId: 'turn-progress-1', text: 'hello', attachments: [] });
  for (let index = 0; index < 30
    && !h.fetched.calls.some((call) => call.path === '/session/session_1/message'); index += 1) {
    await flush();
  }
  const coldStages = h.events.filter((event) => event.type === 'turn-progress');
  assert.deepEqual(coldStages.map((event) => event.stage), ['spawn', 'session', 'dispatch']);
  assert.ok(coldStages.every((event) => event.turnId === 'turn-progress-1'));
  const acceptedIndex = h.events.findIndex((event) => event.type === 'turn-accepted');
  assert.ok(h.events.indexOf(coldStages[0]) < acceptedIndex);
  assert.ok(h.events.indexOf(coldStages[1]) < acceptedIndex);
  assert.ok(h.events.indexOf(coldStages[2]) > acceptedIndex);
  h.fetched.sse.push({
    type: 'message.part.delta',
    properties: { sessionID: 'session_1', field: 'text', delta: 'hello' },
  });
  h.fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await first;
  const textIndex = h.events.findIndex((event) => event.type === 'text-delta');
  assert.ok(coldStages.every((event) => h.events.indexOf(event) < textIndex));

  const boundary = h.events.length;
  const second = h.backend.sendUser({ turnId: 'turn-progress-2', text: 'again', attachments: [] });
  for (let index = 0; index < 30
    && h.fetched.calls.filter((call) => call.path === '/session/session_1/message').length < 2; index += 1) {
    await flush();
  }
  assert.deepEqual(
    h.events.slice(boundary).filter((event) => event.type === 'turn-progress').map((event) => event.stage),
    ['dispatch'],
  );
  h.fetched.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await second;
  assert.equal(h.spawned.calls.length, 1);
});

test('createOpenCodeBackend writes only a per-conversation remote MCP URL', async () => {
  const url = 'http://127.0.0.1:11488/mcp/c/opencode-token';
  const { backend, fetched, fsImpl } = makeBackend({
    getMcpSpec: async () => ({ kind: 'http', url, name: 'ae' }),
  });
  const pending = backend.sendUser('http mcp');
  await flush();

  const config = fsImpl.writes.find((write) => write.file.endsWith('opencode\\opencode.json'));
  assert.deepEqual(JSON.parse(config.text).mcp.ae, {
    type: 'remote',
    url,
    enabled: true,
  });
  assert.match(JSON.parse(config.text).mcp.ae.url, /\/mcp\/c\//);
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

  const config = JSON.parse(fsImpl.writes.find((write) => (
    write.file.endsWith('opencode\\opencode.json')
  )).text);
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

  assert.deepEqual(events.filter((event) => (
    event.type !== 'session-ref' && event.type !== 'turn-progress'
  )), [
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

test('OpenCode readiness request timeout cannot be shorter than its poll interval', () => {
  assert.throws(() => makeBackend({
    readyRequestTimeoutMs: 10,
    readyPollMs: 20,
  }), /request timeout must be at least the poll interval/i);
});

test('OpenCode readiness retries after the first MCP request is accepted but never answered', async () => {
  const base = makeFetch();
  const signals = [];
  let attempts = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/mcp') return base.fetchImpl(url, options);
    attempts += 1;
    signals.push(options.signal);
    if (attempts > 1) return jsonResponse({ ae: { status: 'connected' } });
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('readiness request aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  const h = makeBackend({
    fetchImpl,
    readyRequestTimeoutMs: 20,
    readyPollMs: 1,
    readyTimeoutMs: 2000,
    probeTimeoutMs: 3000,
  });
  const startedAt = Date.now();

  assert.deepEqual(await h.backend.probeAccount(), { loggedIn: true });
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(h.spawned.calls.length, 1);
  assert.equal(attempts, 2);
  assert.equal(signals.every((signal) => signal && typeof signal.aborted === 'boolean'), true);
  assert.equal(signals[0].aborted, true);
});

test('OpenCode readiness aborts every hung MCP request until the total deadline', async () => {
  const base = makeFetch();
  const signals = [];
  let attempts = 0;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/mcp') return base.fetchImpl(url, options);
    attempts += 1;
    signals.push(options.signal);
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('readiness request aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    });
  };
  const h = makeBackend({
    fetchImpl,
    readyRequestTimeoutMs: 20,
    readyPollMs: 1,
    readyTimeoutMs: 80,
  });
  const startedAt = Date.now();
  await h.backend.sendUser({ turnId: 'turn-hung-readiness', text: 'hello', attachments: [] });

  const error = h.events.find((event) => event.type === 'error');
  assert.equal(error.code, 'MCP_UNREACHABLE');
  assert.ok(Date.now() - startedAt < 500);
  assert.ok(attempts >= 2);
  assert.equal(signals.length, attempts);
  assert.equal(signals.every((signal) => signal && signal.aborted === true), true);
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

test('OpenCode adopts an existing session without creating a new one', async () => {
  const h = makeBackend();
  h.backend.adoptSessionRef({ kind: 'opencode-session', id: 'session_saved' });
  h.backend.sendUser({ turnId: 'turn-adopt', text: 'continue', attachments: [] });
  await flush();
  assert.equal(h.fetched.calls.some((call) => call.method === 'POST' && call.path === '/session'), false);
  assert.equal(h.fetched.calls.some((call) => call.path === '/session/session_saved/message'), true);
  assert.deepEqual(h.backend.getSessionRef(), { kind: 'opencode-session', id: 'session_saved' });
  h.backend.reset();
});

test('OpenCode recreates an adopted session once after a message 503', async () => {
  const base = makeFetch();
  const calls = [];
  let unavailable = true;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ method: options.method || 'GET', path: parsed.pathname });
    if (parsed.pathname === '/session/session_legacy/message' && unavailable) {
      unavailable = false;
      return { ok: false, status: 503, text: async () => '' };
    }
    return base.fetchImpl(url, options);
  };
  const h = makeBackend({ fetchImpl });
  h.backend.adoptSessionRef({ kind: 'opencode-session', id: 'session_legacy' });
  const run = h.backend.sendUser({ turnId: 'turn-rebuild-503', text: 'continue', attachments: [] });
  for (let index = 0; index < 30
    && !calls.some((call) => call.path === '/session/session_1/message'); index += 1) {
    await flush();
  }

  assert.equal(calls.filter((call) => call.path === '/session/session_legacy/message').length, 1);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/session').length, 1);
  assert.equal(calls.filter((call) => call.path === '/session/session_1/message').length, 1);
  assert.equal(h.events.some((event) => (
    event.type === 'session-ref' && event.ref.id === 'session_1'
  )), true);
  base.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await run;
});

test('OpenCode does not rebuild a new session after a non-adopted message 503', async () => {
  const base = makeFetch();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ method: options.method || 'GET', path: parsed.pathname });
    if (parsed.pathname === '/session/session_1/message') {
      return { ok: false, status: 503, text: async () => '' };
    }
    return base.fetchImpl(url, options);
  };
  const h = makeBackend({ fetchImpl });
  await h.backend.sendUser({ turnId: 'turn-no-rebuild-503', text: 'start', attachments: [] });

  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/session').length, 1);
  assert.equal(calls.filter((call) => call.path === '/session/session_1/message').length, 1);
  assert.equal(h.events.find((event) => event.type === 'error')?.code, 'UPSTREAM_HTTP_503');
});

test('OpenCode recreates an adopted session once after a message 404', async () => {
  const base = makeFetch();
  const calls = [];
  let missing = true;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ method: options.method || 'GET', path: parsed.pathname });
    if (parsed.pathname === '/session/session_missing/message' && missing) {
      missing = false;
      return jsonResponse({ error: 'missing' }, false, 404);
    }
    return base.fetchImpl(url, options);
  };
  const h = makeBackend({ fetchImpl });
  h.backend.adoptSessionRef({ kind: 'opencode-session', id: 'session_missing' });
  const run = h.backend.sendUser({ turnId: 'turn-rebuild', text: 'continue', attachments: [] });
  await flush();
  assert.equal(calls.filter((call) => call.path === '/session/session_missing/message').length, 1);
  assert.equal(calls.filter((call) => call.method === 'POST' && call.path === '/session').length, 1);
  assert.ok(h.events.some((event) => event.type === 'session-ref' && event.ref.id === 'session_1'));
  base.sse.push({
    type: 'session.status',
    properties: { sessionID: 'session_1', status: { type: 'idle' } },
  });
  await run;
});

test('OpenCode deleteSessionRef deletes only while its server URL is live', async () => {
  const stopped = makeBackend();
  assert.deepEqual(await stopped.backend.deleteSessionRef({ kind: 'opencode-session', id: 'session_1' }), {
    ok: false,
    skipped: true,
    detail: 'opencode server not running',
  });

  const live = makeBackend();
  await live.backend.probeAccount();
  assert.deepEqual(await live.backend.deleteSessionRef({ kind: 'opencode-session', id: 'session_1' }), { ok: true });
  assert.ok(live.fetched.calls.some((call) => call.method === 'DELETE' && call.path === '/session/session_1'));
  live.backend.reset();
});
