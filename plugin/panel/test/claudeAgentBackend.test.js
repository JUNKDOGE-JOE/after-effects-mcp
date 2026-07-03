import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAgentBackend, resolveSystemNode } from '../src/cep/claudeAgentBackend.js';

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

function makeBackend(options = {}) {
  const events = [];
  const spawned = makeSpawn();
  const backend = createClaudeAgentBackend({
    resolveNode: async () => ({ ok: true, nodePath: 'C:\\Node\\node.exe', version: 'v22.1.0' }),
    sidecarPath: 'C:\\ae-mcp\\agent-sidecar.mjs',
    getMcpSpec: async () => ({ command: 'ae-mcp', args: ['--stdio'], env: { A: 'B' } }),
    getToolMeta: async () => ({ allowedTools: ['ae.overview'], annotations: { 'ae.overview': { readOnlyHint: true } } }),
    getModel: () => 'claude-test',
    getPermissionMode: () => 'manual',
    onEvent: (evt) => events.push(evt),
    spawnImpl: spawned.spawn,
    env: { PATH: 'C:\\Node', ANTHROPIC_API_KEY: 'sk-test' },
    ...options,
  });
  return { backend, events, spawned };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function parseWrites(proc) {
  return proc.writes.map((line) => JSON.parse(line));
}

test('createClaudeAgentBackend writes user only after ready handshake', async () => {
  const { backend, spawned } = makeBackend();

  const pending = backend.sendUser('hello');
  await flush();

  assert.equal(spawned.calls.length, 1);
  assert.deepEqual(spawned.procs[0].writes, []);

  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();

  assert.deepEqual(parseWrites(spawned.procs[0]), [
    { t: 'user', text: 'hello', permissionMode: 'manual', model: 'claude-test' },
  ]);

  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await pending;
});

test('createClaudeAgentBackend passes effort and thinking when getters are provided', async () => {
  const { backend, spawned } = makeBackend({
    getEffort: () => 'low',
    getThinking: () => 'adaptive',
  });

  const pending = backend.sendUser('hello');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();

  assert.deepEqual(parseWrites(spawned.procs[0]), [
    { t: 'user', text: 'hello', permissionMode: 'manual', model: 'claude-test', effort: 'low', thinking: 'adaptive' },
  ]);

  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await pending;
});

test('createClaudeAgentBackend omits effort and thinking without getters', async () => {
  const { backend, spawned } = makeBackend();

  const pending = backend.sendUser('hello');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();

  const message = parseWrites(spawned.procs[0])[0];
  assert.equal(Object.hasOwn(message, 'effort'), false);
  assert.equal(Object.hasOwn(message, 'thinking'), false);

  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await pending;
});

test('createClaudeAgentBackend strips Anthropic key and passes sidecar args', async () => {
  const mcpSpec = { command: 'ae-mcp', args: ['--stdio'], env: { X: 'Y' } };
  const meta = { allowedTools: ['ae.one', 'ae.two'], annotations: { 'ae.two': { destructiveHint: true } } };
  const { backend, spawned } = makeBackend({
    getMcpSpec: async () => mcpSpec,
    getToolMeta: async () => meta,
    getModel: () => 'claude-4',
    lang: 'en',
  });

  const pending = backend.sendUser('inspect args');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();

  const call = spawned.calls[0];
  assert.equal(call.command, 'C:\\Node\\node.exe');
  assert.equal(call.options.stdio, 'pipe');
  assert.equal(call.options.windowsHide, true);
  assert.equal(Object.hasOwn(call.options.env, 'ANTHROPIC_API_KEY'), false);
  assert.equal(call.options.env.PATH, 'C:\\Node');
  assert.equal(call.args[0], 'C:\\ae-mcp\\agent-sidecar.mjs');

  const argValue = (flag) => call.args[call.args.indexOf(flag) + 1];
  assert.deepEqual(JSON.parse(argValue('--mcp')), mcpSpec);
  assert.deepEqual(JSON.parse(argValue('--allowed-tools')), meta.allowedTools);
  assert.deepEqual(JSON.parse(argValue('--annotations')), meta.annotations);
  assert.equal(argValue('--model'), 'claude-4');
  assert.equal(argValue('--lang'), 'en');

  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await pending;
});

test('createClaudeAgentBackend forwards all sidecar event shapes unchanged', async () => {
  const { backend, events, spawned } = makeBackend();
  const pending = backend.sendUser('events');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });

  const sidecarEvents = [
    { type: 'turn-start' },
    { type: 'text-delta', text: 'hi' },
    { type: 'tool-start', toolUseId: 'u1', name: 'ae.tool', input: { x: 1 } },
    { type: 'approval-required', toolUseId: 'u1', name: 'ae.tool', input: { x: 1 }, risk: 'write' },
    { type: 'tool-denied', toolUseId: 'u1' },
    { type: 'tool-result', toolUseId: 'u1', ok: true, text: 'ok', durationMs: 12 },
    { type: 'turn-end', stopReason: 'end_turn' },
    { type: 'error', kind: 'mcp', message: 'late error' },
  ];
  for (const event of sidecarEvents) spawned.procs[0].pushStdout({ t: 'event', event });

  await pending;
  assert.deepEqual(events, sidecarEvents);
});

test('createClaudeAgentBackend approve and stop write protocol lines', async () => {
  const { backend, spawned } = makeBackend();
  const pending = backend.sendUser('need tool');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();

  backend.approve('u1', 'allow-session');
  backend.stop();

  assert.deepEqual(parseWrites(spawned.procs[0]), [
    { t: 'user', text: 'need tool', permissionMode: 'manual', model: 'claude-test' },
    { t: 'approve', id: 'u1', decision: 'allow-session' },
    { t: 'stop' },
  ]);

  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'error', kind: 'aborted', message: 'aborted' } });
  await pending;
});

test('createClaudeAgentBackend reports missing system Node without spawning', async () => {
  const events = [];
  const spawned = makeSpawn();
  const backend = createClaudeAgentBackend({
    resolveNode: async () => ({ ok: false, detail: 'not found' }),
    sidecarPath: 'C:\\sidecar.mjs',
    getMcpSpec: async () => ({}),
    getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
    getModel: () => 'claude-test',
    getPermissionMode: () => 'manual',
    onEvent: (evt) => events.push(evt),
    spawnImpl: spawned.spawn,
    lang: 'en',
  });

  await backend.sendUser('hello');

  assert.equal(spawned.calls.length, 0);
  assert.deepEqual(events, [{
    type: 'error',
    kind: 'mcp',
    message: 'Embedded chat needs system Node 18+. Install Node.js LTS and retry.',
  }]);
});

test('createClaudeAgentBackend sendUser promise resolves on turn-end or error', async () => {
  const first = makeBackend();
  let resolved = false;
  const pending = first.backend.sendUser('first').then(() => {
    resolved = true;
  });
  await flush();
  first.spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();
  assert.equal(resolved, false);
  first.spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await pending;
  assert.equal(resolved, true);

  const second = makeBackend();
  const errorPending = second.backend.sendUser('second');
  await flush();
  second.spawned.procs[0].pushStdout({ t: 'ready' });
  second.spawned.procs[0].pushStdout({ t: 'event', event: { type: 'error', kind: 'mcp', message: 'failed' } });
  await errorPending;
});

test('createClaudeAgentBackend reuses a ready process for a second turn', async () => {
  const { backend, spawned } = makeBackend();

  const first = backend.sendUser('one');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();
  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await first;

  const second = backend.sendUser('two');
  await flush();

  assert.equal(spawned.calls.length, 1);
  assert.deepEqual(parseWrites(spawned.procs[0]), [
    { t: 'user', text: 'one', permissionMode: 'manual', model: 'claude-test' },
    { t: 'user', text: 'two', permissionMode: 'manual', model: 'claude-test' },
  ]);

  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await second;
});

test('createClaudeAgentBackend reset kills sidecar and next send respawns', async () => {
  const { backend, spawned } = makeBackend();

  const first = backend.sendUser('one');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();
  backend.reset();

  assert.equal(spawned.procs[0].killed, true);
  await first;

  const second = backend.sendUser('two');
  await flush();
  assert.equal(spawned.calls.length, 2);
  spawned.procs[1].pushStdout({ t: 'ready' });
  spawned.procs[1].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await second;
});

test('createClaudeAgentBackend reports unexpected exit during active turn', async () => {
  const { backend, events, spawned } = makeBackend();

  const pending = backend.sendUser('crash');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  spawned.procs[0].pushStderr('tail detail');
  spawned.procs[0].exit(7);
  await pending;

  const event = events.find((evt) => evt.type === 'error');
  assert.equal(event.kind, 'mcp');
  assert.match(event.message, /sidecar exited: 7 tail detail/);
});

test('createClaudeAgentBackend reports exactly one immediate error when sidecar exits before ready', async () => {
  const { backend, events, spawned } = makeBackend();
  const startedAt = Date.now();

  const pending = backend.sendUser('boot crash');
  await flush();
  spawned.procs[0].pushStderr('startup failure');
  spawned.procs[0].exit(9);
  await pending;

  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].kind, 'mcp');
  assert.match(events[0].message, /sidecar exited: 9 startup failure/);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 1);
});

test('resolveSystemNode returns first Node 18+ candidate from where output', async () => {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    if (file === 'where') {
      callback(null, 'C:\\Old\\node.exe\r\nC:\\New\\node.exe\r\n');
      return;
    }
    if (file === 'C:\\Old\\node.exe') {
      callback(null, 'v17.9.1\n');
      return;
    }
    if (file === 'C:\\New\\node.exe') {
      callback(null, 'v22.2.0\n');
      return;
    }
    callback(null, 'v20.0.0\n');
  };

  const result = await resolveSystemNode({ execFileImpl, env: { PATH: 'x' } });

  assert.deepEqual(result, { ok: true, nodePath: 'C:\\New\\node.exe', version: 'v22.2.0' });
  assert.deepEqual(calls.map((call) => call.options.windowsHide), [true, true, true]);
});

test('resolveSystemNode returns ok false when every candidate is below Node 18', async () => {
  const execFileImpl = (file, args, options, callback) => {
    if (file === 'where') {
      callback(null, 'C:\\Old\\node.exe\r\n');
      return;
    }
    callback(null, 'v17.9.1\n');
  };

  const result = await resolveSystemNode({ execFileImpl, env: {} });

  assert.equal(result.ok, false);
  assert.match(result.detail, /Node 18/);
});

test('api channel spawns the sidecar with injected base URL/token and --channel api', async () => {
  const spawned = makeSpawn();
  const backend = createClaudeAgentBackend({
    resolveNode: async () => ({ ok: true, nodePath: 'C:\node.exe', version: 'v20.0.0' }),
    sidecarPath: 'C:\ext\sidecar\agent-sidecar.mjs',
    getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
    getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
    getModel: () => 'claude-sonnet-5',
    getPermissionMode: () => 'manual',
    getChannel: () => 'api',
    getApiProvider: () => ({ baseUrl: 'https://relay.example/anthropic', apiKey: 'sk-relay' }),
    spawnImpl: spawned.spawn,
    env: { PATH: 'C:\bin', ANTHROPIC_API_KEY: 'leak' },
  });
  const run = backend.sendUser('hi');
  await flush();
  const proc = spawned.procs[0];
  proc.pushStdout(JSON.stringify({ t: 'ready' }) + '\n');
  await flush();
  const call = spawned.calls[0];
  assert.equal(call.options.env.ANTHROPIC_BASE_URL, 'https://relay.example/anthropic');
  assert.equal(call.options.env.ANTHROPIC_AUTH_TOKEN, 'sk-relay');
  assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
  const flagIndex = call.args.indexOf('--channel');
  assert.ok(flagIndex > -1, '--channel flag passed to sidecar');
  assert.equal(call.args[flagIndex + 1], 'api');
  backend.reset();
  await run;
});

test('default subscription channel keeps current sanitize behavior and passes --channel subscription', async () => {
  const spawned = makeSpawn();
  const backend = createClaudeAgentBackend({
    resolveNode: async () => ({ ok: true, nodePath: 'C:\node.exe', version: 'v20.0.0' }),
    sidecarPath: 'C:\ext\sidecar\agent-sidecar.mjs',
    getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
    getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
    getModel: () => 'claude-sonnet-5',
    getPermissionMode: () => 'manual',
    spawnImpl: spawned.spawn,
    env: { PATH: 'C:\bin', ANTHROPIC_API_KEY: 'leak', ANTHROPIC_BASE_URL: 'https://stale' },
  });
  const run = backend.sendUser('hi');
  await flush();
  const proc = spawned.procs[0];
  proc.pushStdout(JSON.stringify({ t: 'ready' }) + '\n');
  await flush();
  const call = spawned.calls[0];
  assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.options.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(call.args[call.args.indexOf('--channel') + 1], 'subscription');
  backend.reset();
  await run;
});


test('getStderrTail exposes the sidecar stderr buffer for log export', async () => {
  const spawned = makeSpawn();
  const backend = createClaudeAgentBackend({
    resolveNode: async () => ({ ok: true, nodePath: 'C:\node.exe', version: 'v20.0.0' }),
    sidecarPath: 'C:\ext\sidecar\agent-sidecar.mjs',
    getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
    getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
    getModel: () => 'claude-sonnet-5',
    getPermissionMode: () => 'manual',
    spawnImpl: spawned.spawn,
    env: { PATH: 'C:\bin' },
  });
  assert.equal(backend.getStderrTail(), '');
  const run = backend.sendUser('hi');
  await flush();
  const proc = spawned.procs[0];
  proc.pushStderr('sidecar warn: something');
  proc.pushStdout(JSON.stringify({ t: 'ready' }) + '\n');
  await flush();
  assert.match(backend.getStderrTail(), /sidecar warn/);
  backend.reset();
  await run;
});
