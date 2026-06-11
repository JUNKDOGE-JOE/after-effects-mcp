import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics } from '../src/cep/diagnostics.js';

const TOKEN = 'a'.repeat(64);

function makeDeps({ token = TOKEN, lastHealthAt = Date.now(), execResult = 'pong' } = {}) {
  const calls = [];
  return {
    calls,
    getHost: () => ({
      getConnectionInfo: () => ({ lastHealthAt }),
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
  };
}

test('runDiagnostics returns all green checks with injected dependencies', async () => {
  const deps = makeDeps();
  const items = await runDiagnostics({ ...deps, port: 11488 });
  assert.deepEqual(items.map((i) => i.id), ['host-listening', 'token-file', 'python-seen', 'ae-project', 'extendscript-ping']);
  assert.deepEqual(items.map((i) => i.ok), [true, true, true, true, true]);
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

test('runDiagnostics reports python not seen recently', async () => {
  const stale = Date.now() - (11 * 60 * 1000);
  const items = await runDiagnostics({ ...makeDeps({ lastHealthAt: stale }), port: 11488 });
  const python = items.find((i) => i.id === 'python-seen');
  assert.equal(python.ok, false);
  assert.match(python.fixHint.zh, /AI 客户端/);
  assert.match(python.fixHint.en, /AI client/);
});
