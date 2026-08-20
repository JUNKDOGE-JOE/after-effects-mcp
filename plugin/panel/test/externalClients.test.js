import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTERNAL_CLIENTS,
  expertGuidanceEnv,
  externalClientConfigText,
  httpConfigFor,
} from '../src/cep/externalClients.js';

test('external client registry contains only supported HTTP and shim clients', () => {
  assert.deepEqual(EXTERNAL_CLIENTS.map((client) => client.id), [
    'claude-desktop',
    'claude-code',
    'cursor',
  ]);
  assert.deepEqual(EXTERNAL_CLIENTS.map((client) => client.kind), [
    'mcp-shim',
    'mcp-http',
    'mcp-http',
  ]);
  for (const client of EXTERNAL_CLIENTS) {
    assert.ok(client.name);
    assert.ok(client.installHint);
    assert.ok(client.loginHint);
    assert.ok(client.docsUrl);
  }
});

test('httpConfigFor emits URL-native configs and the Claude Desktop Node shim', () => {
  const url = 'http://127.0.0.1:12000/mcp';
  assert.deepEqual(httpConfigFor('claude-desktop', 12000, 'C:/Program Files/ae-mcp'), {
    mcpServers: {
      ae: {
        command: 'node',
        args: ['C:/Program Files/ae-mcp/host/stdio-shim.js'],
        env: { AE_MCP_HTTP_URL: url },
      },
    },
  });
  assert.equal(
    httpConfigFor('claude-code', 12000),
    `claude mcp add --transport http ae ${url}`,
  );
  assert.deepEqual(httpConfigFor('cursor', 12000), {
    mcpServers: { ae: { url } },
  });
});

test('externalClientConfigText no longer accepts an engine or stdio command branch', () => {
  const client = EXTERNAL_CLIENTS.find((item) => item.id === 'claude-desktop');
  const text = externalClientConfigText({
    client,
    engine: 'python',
    command: 'retired-ae-mcp',
    port: 11488,
    extensionRoot: '/opt/ae-mcp',
  });
  assert.match(text, /"command": "node"/);
  assert.match(text, /stdio-shim\.js/);
  assert.doesNotMatch(text, /retired-ae-mcp/);
});

test('expertGuidanceEnv remains available to the legacy ZCode provider route', () => {
  assert.deepEqual(expertGuidanceEnv(true), {});
  assert.deepEqual(expertGuidanceEnv(false), { AE_MCP_EXPERT_GUIDANCE: '0' });
});
