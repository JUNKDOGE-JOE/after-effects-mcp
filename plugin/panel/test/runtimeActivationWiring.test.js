import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

test('runtime activation retries transient lock failures and resynchronizes after recovery paths', () => {
  const app = source('../src/app/App.jsx');
  const wizard = source('../src/app/wizardWiring.js');

  assert.match(app, /error\.code === 'RUNTIME_MANAGER_LOCKED'/);
  assert.match(app, /setTimeout\(activate, 1000\)/);
  assert.match(app, /runtimeManager && spec\.runtime/);
  assert.match(app, /item\.id === 'node' && item\.ok && item\.runtime/);
  assert.match(app, /onRuntimeReady: markRuntimeReady/);
  assert.match(wizard, /result\.ok && result\.runtime && onRuntimeReady/);
  assert.match(wizard, /onRuntimeReady\(repaired\)/);
});

test('every MCP configuration copy surface is disabled until runtime activation succeeds', () => {
  const app = source('../src/app/App.jsx');
  const settings = source('../src/screens/SettingsScreen.jsx');
  const drawer = source('../src/screens/ConnectionDrawer.jsx');

  assert.match(app, /copyReady=\{runtimeReady\}/);
  assert.match(settings, /copyDisabled=\{!mcpReady\}/);
  assert.match(settings, /disabled=\{copyDisabled\}/);
  assert.match(drawer, /disabled=\{!copyReady\}/);
});
