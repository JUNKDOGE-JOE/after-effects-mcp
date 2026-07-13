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
    calls.push({ command, args, options: structuredClone(options), proc });
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
    resolveCapability: async () => ({
      ok: true,
      upstreamProtocol: 'messages',
      clientProtocol: 'messages',
      conversion: 'native',
    }),
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function parseWrites(proc) {
  return proc.writes.map((line) => JSON.parse(line));
}

function makeApiProvider(overrides = {}) {
  return {
    id: 'provider-1',
    baseUrl: 'https://provider.example/root',
    requestProfileRevision: 1,
    modelList: { revision: 1 },
    ...overrides,
  };
}

function makeProviderRouteFactory({
  origin = 'http://127.0.0.1:43123',
  routeToken = 'local-route-token',
  startError = null,
} = {}) {
  const calls = [];
  const routes = [];
  const create = (options) => {
    const route = {
      startCalls: 0,
      closeCalls: 0,
      async start() {
        this.startCalls += 1;
        if (startError) throw startError;
        return { origin, routeToken };
      },
      async close() {
        this.closeCalls += 1;
      },
    };
    calls.push(options);
    routes.push(route);
    return route;
  };
  return { create, calls, routes };
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
    message: 'The embedded chat runtime is missing or damaged. Repair the offline runtime in Settings.',
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

test('resolveSystemNode delegates bundled-runtime-first resolution to the platform adapter', async () => {
  const calls = [];
  const executable = { ok: true, id: 'node', path: '/Users/a/.ae-mcp/runtime/current/bin/node', argsPrefix: [], source: 'runtime', version: '24.17.0', arch: 'arm64' };
  const result = await resolveSystemNode({
    platform: { id: 'macos-arm64', resolveExecutable: async (id, options) => { calls.push({ id, options }); return executable; } },
  });

  assert.equal(result.ok, true);
  assert.equal(result.nodePath, executable.path);
  assert.equal(result.executable, executable);
  assert.deepEqual(calls, [{ id: 'node', options: { minimumVersion: '18.0.0', requiredArch: 'arm64' } }]);
});

test('resolveSystemNode returns the structured adapter failure', async () => {
  const result = await resolveSystemNode({
    platform: { resolveExecutable: async () => ({ ok: false, id: 'node', code: 'VERSION_TOO_OLD', attempts: [] }) },
  });

  assert.equal(result.ok, false);
  assert.match(result.detail, /VERSION_TOO_OLD/);
});

test('api channel exposes only the loopback route token to the sidecar', async () => {
  const provider = makeApiProvider();
  const routeFactory = makeProviderRouteFactory();
  const capabilityResolver = async () => ({
    ok: true,
    upstreamProtocol: 'messages',
    clientProtocol: 'messages',
    conversion: 'native',
  });
  const upstreamSecret = 'upstream-secret-never-spawned';
  let providerCalls = 0;
  let profileCalls = 0;
  const resolveRequestProfile = async () => {
    profileCalls += 1;
    return {
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      auth: { kind: 'header', name: 'x-api-key', value: upstreamSecret },
    };
  };
  const { backend, events, spawned } = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => {
      providerCalls += 1;
      return provider;
    },
    resolveRequestProfile,
    resolveCapability: capabilityResolver,
    createProviderRoute: routeFactory.create,
    env: {
      PATH: 'C:\\bin',
      ANTHROPIC_API_KEY: upstreamSecret,
      ANTHROPIC_AUTH_TOKEN: 'stale-token',
      ANTHROPIC_BASE_URL: 'https://stale.example/v1',
    },
  });

  const run = backend.sendUser('hi');
  await flush();
  const proc = spawned.procs[0];
  proc.pushStdout({ t: 'ready' });
  await flush();

  const call = spawned.calls[0];
  assert.equal(providerCalls, 1);
  assert.equal(profileCalls, 0);
  assert.equal(routeFactory.calls[0].provider, provider);
  assert.equal(routeFactory.calls[0].resolveRequestProfile, resolveRequestProfile);
  assert.equal(routeFactory.calls[0].resolveCapability, capabilityResolver);
  assert.equal(call.options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:43123');
  assert.equal(call.options.env.ANTHROPIC_AUTH_TOKEN, 'local-route-token');
  assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(JSON.stringify(call.options.env).includes(upstreamSecret), false);
  assert.equal(call.args[call.args.indexOf('--channel') + 1], 'api');

  proc.pushStderr('provider debug ' + upstreamSecret);
  proc.pushStdout({
    t: 'event',
    event: { type: 'error', kind: 'provider', message: upstreamSecret },
  });
  await run;
  assert.equal(JSON.stringify(events).includes(upstreamSecret), false);
  assert.equal(backend.getStderrTail().includes(upstreamSecret), false);

  const second = backend.sendUser('same provider');
  await flush();
  assert.equal(providerCalls, 2);
  assert.equal(spawned.calls.length, 1);
  assert.equal(routeFactory.routes.length, 1);
  proc.pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await second;

  backend.reset();
  await flush();
  assert.equal(proc.killed, true);
  assert.equal(routeFactory.routes[0].closeCalls, 1);
});

test('api channel redacts reflected Provider credentials split across sidecar deltas', async () => {
  const secret = 'opaque-provider-credential';
  const routeFactory = makeProviderRouteFactory();
  const { backend, events, spawned } = makeBackend({
    getChannel: () => 'api',
    getProviderSensitiveValues: () => [secret],
    resolveApiProvider: async () => makeApiProvider(),
    resolveRequestProfile: async () => ({
      providerId: 'provider-1',
      baseUrl: 'https://provider.example/root',
      auth: { kind: 'header', name: 'x-api-key', value: secret },
    }),
    createProviderRoute: routeFactory.create,
  });
  const run = backend.sendUser('safe text');
  await flush();
  const proc = spawned.procs[0];
  proc.pushStdout({ t: 'ready' });
  await flush();
  proc.pushStdout({ t: 'event', event: { type: 'text-delta', text: 'opaque-provider-' } });
  proc.pushStdout({ t: 'event', event: { type: 'text-delta', text: 'credential' } });
  proc.pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await run;

  const rendered = JSON.stringify({ events, messages: backend.getMessages() });
  assert.equal(rendered.includes(secret), false);
  assert.match(rendered, /\[redacted\]/);
});

test('api needs-probe route recovers once before spawn and uses the recovered provider identity', async () => {
  const candidate = makeApiProvider();
  const recovered = makeApiProvider({
    requestProfileRevision: 2,
    modelList: { revision: 2 },
  });
  const routeFactory = makeProviderRouteFactory();
  const selectionCalls = [];
  const recoveryCalls = [];
  let profileCalls = 0;
  let refreshed = 0;
  const { backend, events, spawned } = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => candidate,
    resolveCapability: async (details) => {
      selectionCalls.push(details);
      return details.provider === candidate
        ? { ok: false, reasonCode: 'needs-probe', upstreamProtocol: 'messages' }
        : { ok: true, reasonCode: 'selected', upstreamProtocol: 'messages', clientProtocol: 'messages' };
    },
    recoverProviderProfile: async (provider, facts, modelId) => {
      recoveryCalls.push({ provider, facts, modelId });
      return { provider: recovered, modelId };
    },
    onProviderProfileRecovered: () => { refreshed += 1; },
    resolveRequestProfile: async () => {
      profileCalls += 1;
      return { auth: { kind: 'header', name: 'x-api-key', value: 'route-only-secret' } };
    },
    createProviderRoute: routeFactory.create,
  });

  const first = backend.sendUser('preflight');
  await flush();
  assert.equal(spawned.calls.length, 1);
  assert.equal(routeFactory.calls[0].provider, recovered);
  assert.equal(profileCalls, 0);
  assert.deepEqual(recoveryCalls, [{
    provider: candidate,
    facts: { status: null, code: 'provider_preflight_required' },
    modelId: 'claude-test',
  }]);
  assert.equal(selectionCalls.length, 2);
  assert.equal(selectionCalls[0].clientProtocol, 'messages');
  assert.equal(selectionCalls[0].feature, 'generate');
  assert.equal(refreshed, 1);
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();
  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await first;

  const second = backend.sendUser('same session');
  await flush();
  assert.equal(recoveryCalls.length, 1);
  assert.equal(selectionCalls.length, 2);
  assert.equal(spawned.calls.length, 1);
  assert.equal(routeFactory.routes.length, 1);
  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await second;
  assert.equal(events.some((event) => event.type === 'error'), false);
  backend.reset();
});

test('api stable unavailable route emits a model error before route creation or spawn', async () => {
  const routeFactory = makeProviderRouteFactory();
  let recoveryCalls = 0;
  let profileCalls = 0;
  const { backend, events, spawned } = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => makeApiProvider(),
    resolveCapability: async () => ({ ok: false, reasonCode: 'unavailable' }),
    recoverProviderProfile: async () => { recoveryCalls += 1; return null; },
    resolveRequestProfile: async () => { profileCalls += 1; return { auth: { kind: 'none' } }; },
    createProviderRoute: routeFactory.create,
  });

  await backend.sendUser('unavailable');

  assert.equal(recoveryCalls, 0);
  assert.equal(profileCalls, 0);
  assert.equal(routeFactory.routes.length, 0);
  assert.equal(spawned.calls.length, 0);
  assert.deepEqual(events.filter((event) => event.type === 'error'), [{
    type: 'error',
    kind: 'model',
    code: 'provider_route_unavailable',
    message: 'Custom provider has no verified Claude route for model claude-test',
  }]);
});

test('api preflight reselects once and fails closed when the recovered route is still unverified', async () => {
  const routeFactory = makeProviderRouteFactory();
  const recovered = makeApiProvider({ requestProfileRevision: 2, modelList: { revision: 2 } });
  let selectionCalls = 0;
  let recoveryCalls = 0;
  let profileCalls = 0;
  const { backend, events, spawned } = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => makeApiProvider(),
    resolveCapability: async () => {
      selectionCalls += 1;
      return { ok: false, reasonCode: 'needs-probe', upstreamProtocol: 'messages' };
    },
    recoverProviderProfile: async () => {
      recoveryCalls += 1;
      return recovered;
    },
    resolveRequestProfile: async () => { profileCalls += 1; return { auth: { kind: 'none' } }; },
    createProviderRoute: routeFactory.create,
  });

  await backend.sendUser('still unverified');

  assert.equal(selectionCalls, 2);
  assert.equal(recoveryCalls, 1);
  assert.equal(profileCalls, 0);
  assert.equal(routeFactory.routes.length, 0);
  assert.equal(spawned.calls.length, 0);
  assert.deepEqual(events.filter((event) => event.type === 'error'), [{
    type: 'error',
    kind: 'model',
    code: 'provider_preflight_failed',
    message: 'Custom provider did not expose a verified API for model claude-test',
  }]);
});

test('reset prevents a late api preflight recovery from creating a route or sidecar', async () => {
  const pendingRecovery = deferred();
  const routeFactory = makeProviderRouteFactory();
  const recovered = makeApiProvider({ requestProfileRevision: 2, modelList: { revision: 2 } });
  let recoveryCalls = 0;
  let refreshed = 0;
  const { backend, events, spawned } = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => makeApiProvider(),
    resolveCapability: async ({ provider }) => (
      provider === recovered
        ? { ok: true, reasonCode: 'selected', upstreamProtocol: 'messages', clientProtocol: 'messages' }
        : { ok: false, reasonCode: 'needs-probe', upstreamProtocol: 'messages' }
    ),
    recoverProviderProfile: async () => {
      recoveryCalls += 1;
      return pendingRecovery.promise;
    },
    onProviderProfileRecovered: () => { refreshed += 1; },
    resolveRequestProfile: async () => { throw new Error('resolver must not run'); },
    createProviderRoute: routeFactory.create,
  });

  const run = backend.sendUser('cancel preflight');
  for (let index = 0; index < 10 && recoveryCalls === 0; index += 1) await flush();
  assert.equal(recoveryCalls, 1);
  backend.reset();
  pendingRecovery.resolve(recovered);
  await run;
  await flush();

  assert.equal(refreshed, 0);
  assert.equal(routeFactory.routes.length, 0);
  assert.equal(spawned.calls.length, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(backend.getMessages(), []);
});

test('api provider resolution failure destroys the old route without exposing its error', async () => {
  const routeFactory = makeProviderRouteFactory();
  const secret = 'credential-resolution-secret';
  let failResolution = false;
  const { backend, events, spawned } = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => {
      if (failResolution) throw new Error(secret);
      return makeApiProvider();
    },
    resolveRequestProfile: async () => ({ auth: { kind: 'none' } }),
    createProviderRoute: routeFactory.create,
  });

  const first = backend.sendUser('first');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();
  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await first;

  failResolution = true;
  await backend.sendUser('must not reach old route');
  assert.equal(spawned.procs[0].killed, true);
  assert.equal(routeFactory.routes[0].closeCalls, 1);
  assert.deepEqual(backend.getMessages(), []);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test('reset during provider resolution cannot tear down a newer send', async () => {
  const routeFactory = makeProviderRouteFactory();
  const provider = makeApiProvider();
  let releaseFirst;
  const firstProvider = new Promise((resolve) => { releaseFirst = resolve; });
  let providerCalls = 0;
  const { backend, spawned } = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => {
      providerCalls += 1;
      return providerCalls === 1 ? firstProvider : provider;
    },
    resolveRequestProfile: async () => ({ auth: { kind: 'none' } }),
    createProviderRoute: routeFactory.create,
  });

  const stale = backend.sendUser('stale');
  await flush();
  backend.reset();
  const current = backend.sendUser('current');
  await flush();
  assert.equal(spawned.calls.length, 1);
  assert.equal(routeFactory.routes.length, 1);

  releaseFirst(provider);
  await flush();
  assert.equal(spawned.calls.length, 1);
  assert.equal(spawned.procs[0].killed, false);
  assert.equal(routeFactory.routes[0].closeCalls, 0);

  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();
  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await Promise.all([stale, current]);
  backend.reset();
});

test('api provider identity fields and model changes replace the sidecar route session', async () => {
  let provider = makeApiProvider();
  let model = 'claude-test';
  const routeFactory = makeProviderRouteFactory();
  const { backend, spawned } = makeBackend({
    getChannel: () => 'api',
    getModel: () => model,
    resolveApiProvider: async () => provider,
    resolveRequestProfile: async () => ({
      providerId: provider.id,
      baseUrl: provider.baseUrl,
      auth: { kind: 'none' },
    }),
    createProviderRoute: routeFactory.create,
  });

  async function completeTurn(index, text) {
    const run = backend.sendUser(text);
    await flush();
    const proc = spawned.procs[index];
    assert.ok(proc);
    proc.pushStdout({ t: 'ready' });
    await flush();
    assert.deepEqual(backend.getMessages(), [{ role: 'user', text }]);
    proc.pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
    await run;
    return proc;
  }

  let previousProc = await completeTurn(0, 'turn-0');
  const mutations = [
    () => { provider = { ...provider, id: 'provider-2' }; },
    () => { provider = { ...provider, baseUrl: 'https://provider-two.example/root' }; },
    () => { provider = { ...provider, requestProfileRevision: 2 }; },
    () => { provider = { ...provider, modelList: { ...provider.modelList, revision: 2 } }; },
    () => { model = 'claude-next'; },
  ];

  for (let index = 0; index < mutations.length; index += 1) {
    mutations[index]();
    const nextProc = await completeTurn(index + 1, `turn-${index + 1}`);
    assert.equal(previousProc.killed, true);
    assert.equal(routeFactory.routes[index].closeCalls, 1);
    previousProc = nextProc;
  }

  assert.equal(spawned.calls.length, 6);
  assert.equal(routeFactory.routes.length, 6);
  backend.reset();
  await flush();
  assert.equal(routeFactory.routes[5].closeCalls, 1);
});

test('switching from api to subscription closes the route and starts a clean session', async () => {
  let channel = 'api';
  const routeFactory = makeProviderRouteFactory();
  const { backend, spawned } = makeBackend({
    getChannel: () => channel,
    resolveApiProvider: async () => makeApiProvider(),
    resolveRequestProfile: async () => ({ auth: { kind: 'none' } }),
    createProviderRoute: routeFactory.create,
  });

  const first = backend.sendUser('api turn');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();
  spawned.procs[0].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await first;

  channel = 'subscription';
  const second = backend.sendUser('subscription turn');
  await flush();
  assert.equal(spawned.procs[0].killed, true);
  assert.equal(routeFactory.routes[0].closeCalls, 1);
  assert.equal(routeFactory.routes.length, 1);
  spawned.procs[1].pushStdout({ t: 'ready' });
  await flush();
  assert.equal(spawned.calls[1].options.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(spawned.calls[1].options.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.deepEqual(backend.getMessages(), [{ role: 'user', text: 'subscription turn' }]);
  spawned.procs[1].pushStdout({ t: 'event', event: { type: 'turn-end', stopReason: 'end_turn' } });
  await second;
  backend.reset();
});

test('api route closes when route start, sidecar spawn, or ready handshake fails', async () => {
  const routeFailure = makeProviderRouteFactory({ startError: new Error('route failed with secret') });
  const first = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => makeApiProvider(),
    resolveRequestProfile: async () => ({ auth: { kind: 'none' } }),
    createProviderRoute: routeFailure.create,
  });
  await first.backend.sendUser('route failure');
  assert.equal(first.spawned.calls.length, 0);
  assert.equal(routeFailure.routes[0].closeCalls, 1);
  assert.equal(JSON.stringify(first.events).includes('route failed with secret'), false);

  const spawnFailure = makeProviderRouteFactory();
  const second = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => makeApiProvider(),
    resolveRequestProfile: async () => ({ auth: { kind: 'none' } }),
    createProviderRoute: spawnFailure.create,
    spawnImpl: () => { throw new Error('spawn failed'); },
  });
  await second.backend.sendUser('spawn failure');
  assert.equal(spawnFailure.routes[0].closeCalls, 1);

  const readyFailure = makeProviderRouteFactory();
  const third = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => makeApiProvider(),
    resolveRequestProfile: async () => ({ auth: { kind: 'none' } }),
    createProviderRoute: readyFailure.create,
  });
  const readyRun = third.backend.sendUser('ready failure');
  await flush();
  third.spawned.procs[0].exit(9);
  await readyRun;
  assert.equal(readyFailure.routes[0].closeCalls, 1);
});

test('api sidecar exit closes its route and resolves the active turn', async () => {
  const routeFactory = makeProviderRouteFactory();
  const { backend, spawned } = makeBackend({
    getChannel: () => 'api',
    resolveApiProvider: async () => makeApiProvider(),
    resolveRequestProfile: async () => ({ auth: { kind: 'none' } }),
    createProviderRoute: routeFactory.create,
  });
  const run = backend.sendUser('exit');
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();
  spawned.procs[0].exit(7);
  await run;
  await flush();
  assert.equal(routeFactory.routes[0].closeCalls, 1);
});

test('stream EOF error event completes the active promise', async () => {
  const { backend, spawned } = makeBackend();
  let resolved = false;
  const run = backend.sendUser('eof').then(() => { resolved = true; });
  await flush();
  spawned.procs[0].pushStdout({ t: 'ready' });
  await flush();
  assert.equal(resolved, false);
  spawned.procs[0].pushStdout({
    t: 'event',
    event: {
      type: 'error',
      kind: 'mcp',
      message: 'stream disconnected before completion: stream closed before response.completed',
    },
  });
  await run;
  assert.equal(resolved, true);
  backend.reset();
});

test('default subscription channel keeps current sanitize behavior and passes --channel subscription', async () => {
  const spawned = makeSpawn();
  let providerCalls = 0;
  let routeCalls = 0;
  const backend = createClaudeAgentBackend({
    resolveNode: async () => ({ ok: true, nodePath: 'C:\node.exe', version: 'v20.0.0' }),
    sidecarPath: 'C:\ext\sidecar\agent-sidecar.mjs',
    getMcpSpec: async () => ({ command: 'uv', args: [], env: {} }),
    getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
    getModel: () => 'claude-sonnet-5',
    getPermissionMode: () => 'manual',
    resolveApiProvider: async () => { providerCalls += 1; throw new Error('must not resolve'); },
    createProviderRoute: () => { routeCalls += 1; throw new Error('must not create'); },
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
  assert.equal(providerCalls, 0);
  assert.equal(routeCalls, 0);
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
