import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/screens/SettingsScreen.jsx', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/app/App.jsx', import.meta.url), 'utf8');

test('Settings renders MCP session identity, source, recency, and block control', () => {
  assert.match(source, /mcpSessions/);
  assert.match(source, /session\.clientInfo/);
  assert.match(source, /session\.sessionId/);
  assert.match(source, /session\.lastActivityAt/);
  assert.match(source, /sessionSourcePanel/);
  assert.match(source, /sessionSourceExternal/);
  assert.match(source, /onBlockMcpClient/);
  assert.match(source, /onBlock\(info\.name, value\)/);
});

test('App refreshes MCP sessions and delegates block/unblock to the host', () => {
  assert.match(appSource, /h\.getMcpSessions\(\)/);
  assert.match(appSource, /onBlockMcpClient=\{/);
  assert.match(appSource, /h\.setClientBlocked\(name, v\)/);
});
