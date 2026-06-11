import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCepPath, isValidPort, buildMcpConfig, loadSavedPort, savePort } from '../src/cep/hostBridge.js';

test('normalizeCepPath strips file scheme and windows leading slash', () => {
  assert.equal(normalizeCepPath('file:///C:/x/y'), 'C:/x/y');
  assert.equal(normalizeCepPath('file://C:\\x'), 'C:\\x');
});

test('isValidPort bounds', () => {
  assert.equal(isValidPort(11488), true);
  assert.equal(isValidPort(80), false);
  assert.equal(isValidPort(NaN), false);
});

test('buildMcpConfig matches the real shape - no --port args, no token', () => {
  const c = buildMcpConfig(11488);
  assert.deepEqual(c.mcpServers.ae, {
    command: 'ae-mcp',
    env: { AE_MCP_BACKEND: 'ae-mcp', AE_MCP_PLUGIN_URL: 'http://127.0.0.1:11488' },
  });
  assert.equal(JSON.stringify(c).includes('token'), false);
});

test('port persistence round-trip with fake storage', () => {
  const mem = new Map();
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v) };
  assert.equal(loadSavedPort(storage), null);
  savePort(storage, 12000);
  assert.equal(loadSavedPort(storage), 12000);
});
