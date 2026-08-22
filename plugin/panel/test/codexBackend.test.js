import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexBackend, resolveCodexCli } from '../src/cep/codexBackend.js';

function createProcess() {
  const stdout = [];
  const stderr = [];
  const exits = [];
  const errors = [];
  const writes = [];
  return {
    stdin: { write: (line) => writes.push(line) },
    stdout: { on: (event, handler) => event === 'data' && stdout.push(handler) },
    stderr: { on: (event, handler) => event === 'data' && stderr.push(handler) },
    on(event, handler) {
      if (event === 'exit') exits.push(handler);
      if (event === 'error') errors.push(handler);
    },
    kill() {},
    writes,
    emit(message) {
      for (const handler of stdout) handler(`${JSON.stringify(message)}\n`);
    },
    emitStderr(message) {
      for (const handler of stderr) handler(message);
    },
    exit(code = 0, signal = null) {
      for (const handler of exits) handler(code, signal);
    },
    error(error) {
      for (const handler of errors) handler(error);
    },
  };
}

function parseWrites(proc) {
  return proc.writes.map((line) => JSON.parse(line));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeBackend(overrides = {}) {
  const spawned = [];
  const mkdirs = [];
  const events = [];
  const platform = {
    id: 'windows-x64',
    paths: {
      tempRoot: 'C:\\tmp',
      configRoot: 'C:\\Users\\test\\.ae-mcp',
      join: (parts) => parts.join('\\'),
      dirname: (value) => value.replace(/[\\/][^\\/]+$/, ''),
    },
    fs: { mkdirSync: (path, options) => mkdirs.push({ path, options }) },
    completeSpawnEnv: (base = {}, additions = {}) => ({
      ...base,
      USERPROFILE: base.USERPROFILE || 'C:\\Users\\test',
      HOME: base.HOME || 'C:\\Users\\test',
      APPDATA: base.APPDATA || 'C:\\Users\\test\\AppData\\Roaming',
      ...additions,
    }),
    resolveExecutable: overrides.resolveExecutable || (async () => ({
      ok: true,
      id: 'codex',
      path: 'C:\\Tools\\codex.exe',
      displayPath: 'C:\\Tools\\codex.cmd',
      argsPrefix: [],
      source: 'path',
      version: '1.0.0',
      arch: 'x64',
    })),
    spawn(executable, args, options) {
      if (overrides.spawnError) throw overrides.spawnError;
      const proc = createProcess();
      spawned.push({ executable, args, options, proc });
      return proc;
    },
  };
  const backend = createCodexBackend({
    platform,
    getModel: () => 'gpt-5.5',
    getEffort: () => 'high',
    getFast: () => true,
    getPermissionMode: () => 'manual',
    getMcpSpec: overrides.getMcpSpec || (async () => ({
      kind: 'http',
      url: 'http://127.0.0.1:11488/mcp/c/codex-token',
      name: 'ae',
    })),
    getToolMeta: overrides.getToolMeta || (async () => ({ allowedTools: [], annotations: {} })),
    resolveCli: overrides.resolveCli,
    getLang: overrides.getLang,
    rpcTimeoutMs: overrides.rpcTimeoutMs,
    turnTimeoutMs: overrides.turnTimeoutMs,
    env: { AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel' },
    onEvent: (event) => events.push(event),
  });
  return { backend, platform, spawned, mkdirs, events };
}

async function startTurn(backend, spawned) {
  const pending = backend.sendUser({ turnId: 'turn_1', text: 'hello', attachments: [] });
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  assert.equal(initialize.method, 'initialize');
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const thread = parseWrites(proc)[1];
  assert.equal(thread.method, 'thread/start');
  proc.emit({ id: thread.id, result: { threadId: 'thread_1' } });
  await flush();
  const turn = parseWrites(proc)[2];
  assert.equal(turn.method, 'turn/start');
  return { pending, proc, thread, turn };
}

test('resolveCodexCli exposes the CLI shim for diagnostics', async () => {
  const result = await resolveCodexCli({
    env: { AE_MCP_CODEX_CLI: 'C:\\Custom\\codex.cmd' },
    platform: {
      id: 'windows-x64',
      resolveExecutable: async (_id, { env }) => ({
        ok: true,
        path: 'C:\\Node\\node.exe',
        displayPath: env.AE_MCP_CODEX_CLI,
        version: '1.2.3',
      }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.cliPath, 'C:\\Custom\\codex.cmd');
  assert.equal(result.version, '1.2.3');
});

test('Codex starts its CLI app-server with an isolated pre-created CODEX_HOME', async () => {
  const { backend, spawned, mkdirs } = makeBackend();
  try {
    const { thread, turn } = await startTurn(backend, spawned);
    assert.deepEqual(spawned[0].args, [
      'app-server',
      '-c',
      'features.default_mode_request_user_input=true',
    ]);
    assert.equal(spawned[0].options.env.CODEX_HOME, 'C:\\Users\\test\\.ae-mcp\\codex-home');
    assert.ok(mkdirs.length >= 1);
    assert.ok(mkdirs.every(({ path, options }) => (
      path === 'C:\\Users\\test\\.ae-mcp\\codex-home' && options.recursive === true
    )));
    assert.deepEqual(thread.params.config.mcp_servers.ae, {
      url: 'http://127.0.0.1:11488/mcp/c/codex-token',
    });
    assert.equal(thread.params.cwd, 'C:\\Repo\\plugin');
    assert.deepEqual(turn.params.input, [{ type: 'text', text: 'hello' }]);
  } finally {
    backend.reset();
  }
});

test('Codex account probes use the same isolated CLI environment', async () => {
  const { backend, spawned, mkdirs } = makeBackend();
  const pending = backend.probeAccount();
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const account = parseWrites(proc)[1];
  assert.equal(account.method, 'account/read');
  proc.emit({
    id: account.id,
    result: { account: { email: 'user@example.test', planType: 'plus' } },
  });
  await flush();
  const models = parseWrites(proc)[2];
  assert.equal(models.method, 'model/list');
  proc.emit({ id: models.id, result: { models: [{ id: 'gpt-5.5' }] } });

  const result = await pending;
  assert.equal(result.loggedIn, true);
  assert.deepEqual(result.models, [{ id: 'gpt-5.5' }]);
  assert.equal(result.codexHome, 'C:\\Users\\test\\.ae-mcp\\codex-home');
  assert.equal(result.platformId, 'windows-x64');
  assert.equal(spawned[0].options.env.CODEX_HOME, 'C:\\Users\\test\\.ae-mcp\\codex-home');
  assert.equal(mkdirs.length, 1);
});

test('Codex account probes return isolated-home diagnostics when login is required', async () => {
  const { backend, spawned } = makeBackend();
  const pending = backend.probeAccount();
  await flush();
  const proc = spawned[0].proc;
  const initialize = parseWrites(proc)[0];
  proc.emit({ id: initialize.id, result: {} });
  await flush();
  const account = parseWrites(proc)[1];
  proc.emit({
    id: account.id,
    result: { account: null, requiresOpenaiAuth: true },
  });
  await flush();
  const models = parseWrites(proc)[2];
  proc.emit({ id: models.id, result: { models: [] } });

  const result = await pending;
  assert.equal(result.loggedIn, false);
  assert.equal(result.runtimeOk, true);
  assert.equal(result.detail, 'OpenAI auth required');
  assert.equal(result.codexHome, 'C:\\Users\\test\\.ae-mcp\\codex-home');
  assert.equal(result.platformId, 'windows-x64');
});

test('Codex account probe failures retain isolated-home diagnostics', async () => {
  const { backend } = makeBackend({
    resolveCli: async () => ({ ok: false, code: 'NOT_FOUND' }),
  });
  const result = await backend.probeAccount();
  assert.equal(result.loggedIn, false);
  assert.equal(result.runtimeOk, false);
  assert.equal(result.codexHome, 'C:\\Users\\test\\.ae-mcp\\codex-home');
  assert.equal(result.platformId, 'windows-x64');
});

test('Codex keeps JSON-RPC code and data in TURN_START_FAILED detail', async () => {
  const { backend, spawned, events } = makeBackend();
  try {
    const { pending, proc, turn } = await startTurn(backend, spawned);
    proc.emit({
      id: turn.id,
      error: { code: -32001, message: 'turn rejected', data: { reason: 'policy' } },
    });
    await pending;
    const error = events.find((event) => event.type === 'error');
    assert.equal(error.code, 'TURN_START_FAILED');
    assert.equal(error.detail.jsonRpcCode, -32001);
    assert.deepEqual(error.detail.jsonRpcData, { reason: 'policy' });
    assert.equal(error.dispatchState, 'uncertain');
  } finally {
    backend.reset();
  }
});

test('Codex initialize timeout reports RPC_TIMEOUT with the method', async () => {
  const { backend, events } = makeBackend({ rpcTimeoutMs: 5 });
  try {
    await backend.sendUser({ turnId: 'turn-timeout', text: 'hello', attachments: [] });
    const error = events.find((event) => event.type === 'error');
    assert.equal(error.code, 'RPC_TIMEOUT');
    assert.equal(error.detail.method, 'initialize');
    assert.equal(error.dispatchState, 'not-started');
  } finally {
    backend.reset();
  }
});

test('Codex relay status text becomes an URL-free upstream HTTP category', async () => {
  const { backend, spawned, events } = makeBackend();
  try {
    const { pending, proc, turn } = await startTurn(backend, spawned);
    proc.emit({
      id: turn.id,
      error: {
        code: -32000,
        message: 'unexpected status 502, url: https://relay.example/v1/messages?key=SECRET',
      },
    });
    await pending;
    const error = events.find((event) => event.type === 'error');
    assert.equal(error.code, 'UPSTREAM_HTTP_502');
    assert.equal(error.detail.httpStatus, 502);
    assert.match(error.detail.upstreamMessage, /unexpected status 502/);
    assert.equal(error.message.includes('https://'), false);
  } finally {
    backend.reset();
  }
});

test('Codex reads getLang for each resolution failure without rebuilding the backend', async () => {
  let currentLang = 'en';
  const h = makeBackend({
    getLang: () => currentLang,
    resolveCli: async () => ({ ok: false, code: 'NOT_FOUND' }),
  });

  await h.backend.sendUser({ turnId: 'turn-en', text: 'hello', attachments: [] });
  currentLang = 'zh';
  await h.backend.sendUser({ turnId: 'turn-zh', text: 'hello', attachments: [] });

  const errors = h.events.filter((event) => event.type === 'error');
  assert.match(errors[0].message, /not found/i);
  assert.match(errors[1].message, /未找到/);
  assert.equal(h.spawned.length, 0);
});

test('Codex maps all app-server cancellation spellings to CANCELLED', async () => {
  for (const status of ['cancelled', 'canceled', 'interrupted']) {
    const { backend, spawned, events } = makeBackend();
    try {
      const { pending, proc } = await startTurn(backend, spawned);
      proc.emit({ method: 'turn/completed', params: { turn: { status } } });
      await pending;
      assert.equal(events.find((event) => event.type === 'error')?.code, 'CANCELLED');
    } finally {
      backend.reset();
    }
  }
});

test('Codex distinguishes CLI resolution, spawn, and unauthenticated exits', async () => {
  const missing = makeBackend({
    resolveCli: async () => ({
      ok: false,
      code: 'ARCH_MISMATCH',
      resolution: {
        code: 'ARCH_MISMATCH',
        attempts: [{ path: 'C:\\Tools\\codex.exe', source: 'path', detail: 'architecture arm64' }],
      },
    }),
  });
  await missing.backend.sendUser({ turnId: 'turn-arch', text: 'hello', attachments: [] });
  assert.equal(missing.events.find((event) => event.type === 'error')?.code, 'CLI_ARCH_MISMATCH');

  const spawnFailure = new Error('spawn EACCES');
  spawnFailure.code = 'EACCES';
  const spawning = makeBackend({ spawnError: spawnFailure });
  await spawning.backend.sendUser({ turnId: 'turn-spawn', text: 'hello', attachments: [] });
  assert.equal(spawning.events.find((event) => event.type === 'error')?.code, 'SPAWN_FAILED');

  const exiting = makeBackend();
  const { pending, proc } = await startTurn(exiting.backend, exiting.spawned);
  proc.emitStderr('Not logged in. Run login first.');
  proc.exit(1);
  await pending;
  const authError = exiting.events.find((event) => event.type === 'error');
  assert.equal(authError?.code, 'AUTH_REQUIRED');
  assert.equal(authError?.detail.codexHome, 'C:\\Users\\test\\.ae-mcp\\codex-home');
});
