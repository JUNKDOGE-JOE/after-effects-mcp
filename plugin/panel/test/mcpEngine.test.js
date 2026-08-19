import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MCP_ENGINE_CEP_HOST,
  MCP_ENGINE_PREF_KEY,
  MCP_ENGINE_PYTHON,
  getMcpSpec,
  loadMcpEngine,
  saveMcpEngine,
} from '../src/lib/mcpEngine.js';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    value: (key) => values.get(key),
  };
}

test('MCP engine preference defaults invalid or missing values to python and round-trips cep-host', () => {
  const prefs = storage();
  assert.equal(loadMcpEngine(prefs), MCP_ENGINE_PYTHON);
  assert.equal(saveMcpEngine(prefs, MCP_ENGINE_CEP_HOST), MCP_ENGINE_CEP_HOST);
  assert.equal(prefs.value(MCP_ENGINE_PREF_KEY), MCP_ENGINE_CEP_HOST);
  assert.equal(loadMcpEngine(prefs), MCP_ENGINE_CEP_HOST);

  prefs.setItem(MCP_ENGINE_PREF_KEY, 'unsupported');
  assert.equal(loadMcpEngine(prefs), MCP_ENGINE_PYTHON);
});

test('getMcpSpec preserves the Python spec exactly in python mode', async () => {
  const expected = { command: 'ae-mcp', args: ['--stdio'], env: { A: 'B' } };
  let hostCalls = 0;
  const result = await getMcpSpec({
    engine: MCP_ENGINE_PYTHON,
    resolvePythonSpec: async () => expected,
    hostConversation: { ensureConversation: () => { hostCalls += 1; } },
  });

  assert.equal(result, expected);
  assert.equal(hostCalls, 0);
});

test('getMcpSpec returns a per-conversation HTTP spec in cep-host mode', async () => {
  const seen = [];
  const result = await getMcpSpec({
    engine: MCP_ENGINE_CEP_HOST,
    port: 11488,
    label: 'chat-3',
    approvalTier: 'manual',
    expertGuidance: false,
    hostConversation: {
      ensureConversation: (input) => {
        seen.push(input);
        return { path: '/mcp/c/conversation-token' };
      },
    },
  });

  assert.deepEqual(seen, [{ label: 'chat-3', approvalTier: 'manual', expertGuidance: false }]);
  assert.deepEqual(result, {
    kind: 'http',
    url: 'http://127.0.0.1:11488/mcp/c/conversation-token',
    name: 'ae',
  });
});

test('getMcpSpec reports a clear error when the CEP host MCP server is unavailable', async () => {
  await assert.rejects(
    getMcpSpec({
      engine: MCP_ENGINE_CEP_HOST,
      port: 11488,
      hostConversation: { ensureConversation: () => null },
    }),
    (error) => error.code === 'CEP_HOST_MCP_NOT_RUNNING'
      && error.message === 'CEP host MCP server is not running',
  );
});
