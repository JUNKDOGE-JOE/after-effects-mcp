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

function makeBackend() {
  const spawned = [];
  const mkdirs = [];
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
    resolveExecutable: async () => ({
      ok: true,
      id: 'codex',
      path: 'C:\\Tools\\codex.exe',
      displayPath: 'C:\\Tools\\codex.cmd',
      argsPrefix: [],
      source: 'path',
      version: '1.0.0',
      arch: 'x64',
    }),
    spawn(executable, args, options) {
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
    getMcpSpec: async () => ({
      kind: 'http',
      url: 'http://127.0.0.1:11488/mcp/c/codex-token',
      name: 'ae',
    }),
    getToolMeta: async () => ({ allowedTools: [], annotations: {} }),
    env: { AE_MCP_PANEL_EXT_ROOT: 'C:\\Repo\\plugin\\panel' },
  });
  return { backend, platform, spawned, mkdirs };
}

async function startTurn(backend, spawned) {
  const pending = backend.sendUser('hello');
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
  assert.equal(spawned[0].options.env.CODEX_HOME, 'C:\\Users\\test\\.ae-mcp\\codex-home');
  assert.equal(mkdirs.length, 1);
});
