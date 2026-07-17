import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics } from '../src/cep/diagnostics.js';

const TOKEN = 'a'.repeat(64);

function makeDeps({ token = TOKEN, lastHealthAt = Date.now(), lastClientSeenAt = null, execResult = 'pong', resolutions = {} } = {}) {
  const calls = [];
  const fs = {
    existsSync: () => token !== null,
    readFileSync: () => token,
  };
  const defaults = {
    'ae-mcp': { ok: true, path: '/Users/tester/.ae-mcp/bin/ae-mcp', source: 'runtime', version: null },
    node: { ok: true, path: '/Users/tester/.ae-mcp/runtime/current/bin/node', source: 'runtime', version: '24.17.0' },
    claude: { ok: true, path: '/Users/tester/.local/bin/claude', source: 'path', version: '2.1.0' },
    codex: { ok: true, path: '/Users/tester/.local/bin/codex', source: 'path', version: '1.2.0' },
  };
  return {
    calls,
    getHost: () => ({
      getConnectionInfo: () => ({ lastHealthAt, lastClientSeenAt }),
    }),
    fs,
    platform: {
      id: 'macos-arm64',
      fs,
      paths: { configRoot: '/Users/tester/.ae-mcp', join: (parts) => parts.join('/') },
      resolveExecutable: async (id) => ({ id, argsPrefix: [], arch: 'arm64', ...(resolutions[id] || defaults[id] || { ok: false, code: 'NOT_FOUND', attempts: [] }) }),
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (!options.method) {
        return { ok: true, json: async () => ({ ok: true, pluginVersion: '0.3.2' }) };
      }
      const body = JSON.parse(options.body);
      if (body.code === '"pong"') {
        return { ok: true, json: async () => ({ ok: true, result: execResult }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: 'unsaved' }) };
    },
  };
}

test('runDiagnostics returns all green checks with injected dependencies', async () => {
  const deps = makeDeps();
  const items = await runDiagnostics({ ...deps, port: 11488 });
  assert.deepEqual(items.map((i) => i.id), ['host-listening', 'token-file', 'python-seen', 'ae-project', 'extendscript-ping', 'ae-mcp', 'node', 'claude', 'codex']);
  assert.deepEqual(items.map((i) => i.ok), [true, true, true, true, true, true, true, true, true]);
  assert.match(items[0].detail, /0\.3\.2/);
  assert.match(items[3].detail, /unsaved/);
  assert.equal(deps.calls[1].options.headers['x-ae-mcp-token'], TOKEN);
});

test('runDiagnostics reports a missing token file', async () => {
  const items = await runDiagnostics({ ...makeDeps({ token: null }), port: 11488 });
  const token = items.find((i) => i.id === 'token-file');
  assert.equal(token.ok, false);
  assert.equal(typeof token.fixHint.zh, 'string');
  assert.equal(typeof token.fixHint.en, 'string');
});

test('runDiagnostics accepts recent client seen as python activity', async () => {
  const stale = Date.now() - (11 * 60 * 1000);
  const items = await runDiagnostics({ ...makeDeps({ lastHealthAt: stale, lastClientSeenAt: Date.now() }), port: 11488 });
  const python = items.find((i) => i.id === 'python-seen');
  assert.equal(python.ok, true);
});

test('runDiagnostics reports python not seen recently when both signals are stale', async () => {
  const stale = Date.now() - (11 * 60 * 1000);
  const items = await runDiagnostics({ ...makeDeps({ lastHealthAt: stale, lastClientSeenAt: stale }), port: 11488 });
  const python = items.find((i) => i.id === 'python-seen');
  assert.equal(python.ok, false);
  assert.match(python.fixHint.zh, /AI 客户端/);
  assert.match(python.fixHint.en, /AI client/);
});

test('runDiagnostics exec probes identify as panel-internal client', async () => {
  const deps = makeDeps();
  await runDiagnostics({ ...deps, port: 11488 });
  const execCalls = deps.calls.filter((c) => c.url.endsWith('/exec'));
  assert.equal(execCalls.length, 2);
  for (const c of execCalls) {
    assert.equal(c.options.headers['x-ae-mcp-client'], 'panel-diagnostics/internal');
  }
});

test('runDiagnostics reports bundled runtime and optional CLI resolutions with structured actions', async () => {
  const items = await runDiagnostics({
    ...makeDeps({ resolutions: { claude: { ok: false, code: 'NOT_FOUND', attempts: [] } } }),
    port: 11488,
  });
  assert.deepEqual(items.map((i) => i.id), [
    'host-listening',
    'token-file',
    'python-seen',
    'ae-project',
    'extendscript-ping',
    'ae-mcp',
    'node',
    'claude',
    'codex',
  ]);
  assert.deepEqual(items.slice(-4).map((i) => i.ok), [true, true, false, true]);
  assert.equal(items.find((i) => i.id === 'node').detail, '24.17.0 · /Users/tester/.ae-mcp/runtime/current/bin/node');
  assert.deepEqual(items.find((i) => i.id === 'ae-mcp').action, { kind: 'repair-runtime' });
  assert.deepEqual(items.find((i) => i.id === 'claude').action, { kind: 'open-login-terminal', tool: 'claude' });
  assert.doesNotMatch(JSON.stringify(items), /winget|PowerShell|npm install|\buv\b/i);
});

test('runDiagnostics reports RuntimeManager provenance and corruption diagnostics', async () => {
  const deps = makeDeps();
  const runtimeManager = {
    async inspect() {
      return {
        ok: true,
        current: {
          ok: true,
          record: { version: '0.9.3', sourceCommitSha: 'a'.repeat(40) },
        },
        launcher: { ok: true, path: '/Users/tester/.ae-mcp/bin/ae-mcp' },
      };
    },
  };
  const healthy = await runDiagnostics({ ...deps, port: 11488, runtimeManager });
  const runtime = healthy.find((item) => item.id === 'ae-mcp');
  assert.equal(runtime.ok, true);
  assert.match(runtime.detail, /0\.9\.3.*[a-f0-9]{40}/);

  runtimeManager.inspect = async () => ({
    ok: false,
    current: { ok: false, code: 'RUNTIME_HASH_MISMATCH' },
    launcher: { ok: true, path: '/Users/tester/.ae-mcp/bin/ae-mcp' },
  });
  const corrupt = await runDiagnostics({ ...deps, port: 11488, runtimeManager });
  assert.equal(corrupt.find((item) => item.id === 'ae-mcp').ok, false);
  assert.match(corrupt.find((item) => item.id === 'ae-mcp').detail, /RUNTIME_HASH_MISMATCH/);
});
