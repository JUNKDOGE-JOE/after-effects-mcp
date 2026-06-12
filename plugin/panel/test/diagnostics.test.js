import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics } from '../src/cep/diagnostics.js';

const TOKEN = 'a'.repeat(64);

function makeDeps({ token = TOKEN, lastHealthAt = Date.now(), lastClientSeenAt = null, execResult = 'pong' } = {}) {
  const calls = [];
  return {
    calls,
    getHost: () => ({
      getConnectionInfo: () => ({ lastHealthAt, lastClientSeenAt }),
    }),
    fs: {
      existsSync: () => token !== null,
      readFileSync: () => token,
    },
    os: {
      homedir: () => '/home/tester',
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
    execFileImpl: (file, args, opts, cb) => cb(null, file + ' version', ''),
  };
}

test('runDiagnostics returns all green checks with injected dependencies', async () => {
  const deps = makeDeps();
  const items = await runDiagnostics({ ...deps, port: 11488 });
  assert.deepEqual(items.map((i) => i.id), ['host-listening', 'token-file', 'python-seen', 'ae-project', 'extendscript-ping', 'uv', 'node', 'claude']);
  assert.deepEqual(items.map((i) => i.ok), [true, true, true, true, true, true, true, true]);
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

test('runDiagnostics appends uv node and claude presence checks', async () => {
  const execFileImpl = (file, args, opts, cb) => {
    if (file === 'uv') return cb(null, 'uv 0.7.2', '');
    if (file === 'node') return cb(null, 'v24.14.0', '');
    return cb(new Error('not found'), '', '');
  };
  const items = await runDiagnostics({ ...makeDeps(), port: 11488, execFileImpl });
  assert.deepEqual(items.map((i) => i.id), [
    'host-listening',
    'token-file',
    'python-seen',
    'ae-project',
    'extendscript-ping',
    'uv',
    'node',
    'claude',
  ]);
  assert.deepEqual(items.slice(-3).map((i) => i.ok), [true, true, false]);
  assert.equal(items.find((i) => i.id === 'uv').detail, 'uv 0.7.2');
  assert.equal(items.find((i) => i.id === 'node').detail, 'v24.14.0');
  assert.match(items.find((i) => i.id === 'claude').detail, /Install Claude Code/);
});
