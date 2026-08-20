import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDiagnostics } from '../src/cep/diagnostics.js';

const TOKEN = 'a'.repeat(64);

function makeDeps({
  token = TOKEN,
  sessionAt = Date.now(),
  execResult = 'pong',
  resolutions = {},
} = {}) {
  const calls = [];
  const fs = {
    existsSync: () => token !== null,
    readFileSync: () => token,
  };
  const defaults = {
    claude: {
      ok: true,
      path: '/Users/tester/.local/bin/claude',
      source: 'path',
      version: '2.1.0',
    },
    codex: {
      ok: true,
      path: '/Users/tester/.local/bin/codex',
      source: 'path',
      version: '1.2.0',
    },
    opencode: {
      ok: true,
      path: '/Users/tester/.local/bin/opencode',
      source: 'path',
      version: '1.0.0',
    },
  };
  return {
    calls,
    getHost: () => ({
      getMcpSessions: () => sessionAt
        ? [{ sessionId: 'session-1', lastActivityAt: sessionAt }]
        : [],
    }),
    fs,
    platform: {
      fs,
      paths: {
        configRoot: '/Users/tester/.ae-mcp',
        join: (parts) => parts.join('/'),
      },
      resolveExecutable: async (id) => ({
        id,
        argsPrefix: [],
        ...(resolutions[id] || defaults[id] || {
          ok: false,
          code: 'NOT_FOUND',
          attempts: [],
        }),
      }),
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (!options.method) {
        return {
          ok: true,
          json: async () => ({ ok: true, pluginVersion: '0.9.6', port: 11488 }),
        };
      }
      const body = JSON.parse(options.body);
      if (body.code === '"pong"') {
        return { ok: true, json: async () => ({ ok: true, result: execResult }) };
      }
      return { ok: true, json: async () => ({ ok: true, result: 'unsaved' }) };
    },
  };
}

test('runDiagnostics checks host, MCP session, AE, and the three optional CLIs', async () => {
  const deps = makeDeps();
  const items = await runDiagnostics({ ...deps, port: 11488 });
  assert.deepEqual(items.map((item) => item.id), [
    'host-listening',
    'token-file',
    'mcp-session',
    'ae-project',
    'extendscript-ping',
    'claude',
    'codex',
    'opencode',
  ]);
  assert.ok(items.every((item) => item.ok));
  assert.match(items[0].detail, /0\.9\.6/);
  assert.match(items[3].detail, /unsaved/);
  assert.equal(deps.calls[1].options.headers['x-ae-mcp-token'], TOKEN);
  assert.doesNotMatch(JSON.stringify(items), /offline service|repair-service/i);
});

test('runDiagnostics reports missing token and stale MCP activity independently', async () => {
  const stale = Date.now() - (11 * 60 * 1000);
  const items = await runDiagnostics({
    ...makeDeps({ token: null, sessionAt: stale }),
    port: 11488,
  });
  assert.equal(items.find((item) => item.id === 'token-file').ok, false);
  const session = items.find((item) => item.id === 'mcp-session');
  assert.equal(session.ok, false);
  assert.match(session.fixHint.zh, /MCP/);
  assert.match(session.fixHint.en, /MCP/);
});

test('runDiagnostics exec probes identify as the panel-internal client', async () => {
  const deps = makeDeps();
  await runDiagnostics({ ...deps, port: 11488 });
  const execCalls = deps.calls.filter((call) => call.url.endsWith('/exec'));
  assert.equal(execCalls.length, 2);
  for (const call of execCalls) {
    assert.equal(
      call.options.headers['x-ae-mcp-client'],
      'panel-diagnostics/internal',
    );
  }
});

test('missing optional CLIs use channel-specific hints and actions', async () => {
  const items = await runDiagnostics({
    ...makeDeps({
      resolutions: {
        claude: { ok: false, code: 'NOT_FOUND' },
        opencode: { ok: false, code: 'NOT_FOUND' },
      },
    }),
    port: 11488,
  });
  assert.deepEqual(
    items.find((item) => item.id === 'claude').action,
    { kind: 'open-login-terminal', tool: 'claude' },
  );
  assert.equal(items.find((item) => item.id === 'opencode').action, undefined);
  assert.match(items.find((item) => item.id === 'opencode').fixHint.en, /opencode/);
});
