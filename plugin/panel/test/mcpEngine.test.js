import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMcpSpec } from '../src/lib/mcpEngine.js';

test('getMcpSpec always returns the per-conversation host HTTP URL', async () => {
  const seen = [];
  const result = await getMcpSpec({
    port: 11488,
    label: 'chat-3',
    approvalTier: 'manual',
    expertGuidance: false,
    hostConversation: {
      ensureConversation(input) {
        seen.push(input);
        return { path: '/mcp/c/conversation-token' };
      },
    },
  });

  assert.deepEqual(seen, [{
    label: 'chat-3',
    approvalTier: 'manual',
    expertGuidance: false,
  }]);
  assert.deepEqual(result, {
    kind: 'http',
    url: 'http://127.0.0.1:11488/mcp/c/conversation-token',
    name: 'ae',
  });
});

test('getMcpSpec ignores retired engine and Python resolver inputs', async () => {
  let pythonCalls = 0;
  const result = await getMcpSpec({
    engine: 'python',
    port: 12000,
    resolvePythonSpec() {
      pythonCalls += 1;
      return { command: 'retired' };
    },
    hostConversation: {
      ensureConversation: () => ({ path: '/mcp/c/host-only' }),
    },
  });

  assert.equal(pythonCalls, 0);
  assert.equal(result.url, 'http://127.0.0.1:12000/mcp/c/host-only');
});

test('getMcpSpec reports a clear error when the host MCP server is unavailable', async () => {
  await assert.rejects(
    getMcpSpec({
      port: 11488,
      hostConversation: { ensureConversation: () => null },
    }),
    (error) => error.code === 'CEP_HOST_MCP_NOT_RUNNING'
      && error.message === 'CEP host MCP server is not running',
  );
});
