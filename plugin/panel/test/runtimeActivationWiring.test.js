import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

test('App MCP and wizard wiring no longer activate a Python runtime', () => {
  const app = source('../src/app/App.jsx');
  const wizard = source('../src/app/wizardWiring.js');

  assert.doesNotMatch(app, /createRuntimeManager|resolveMcpCommand|getPythonMcpSpec/);
  assert.doesNotMatch(app, /RUNTIME_MANAGER_LOCKED|runtimeActivation|runtimeReady/);
  assert.doesNotMatch(wizard, /runtimeManager|onRuntimeReady|\buv\b|aeMcp/);
  assert.match(wizard, /\.\.\.HOST_STEPS, \.\.\.CLI_STEPS, \.\.\.OPTIONAL_CLIENT_STEPS/);
});

test('MCP configuration copy surfaces depend only on host readiness', () => {
  const app = source('../src/app/App.jsx');
  const settings = source('../src/screens/SettingsScreen.jsx');
  const drawer = source('../src/screens/ConnectionDrawer.jsx');

  assert.match(app, /const externalMcpReady = status\.state === 'ok'/);
  assert.match(app, /copyReady=\{externalMcpReady\}/);
  assert.match(settings, /copyDisabled=\{!mcpReady\}/);
  assert.match(settings, /disabled=\{copyDisabled\}/);
  assert.match(drawer, /disabled=\{!copyReady\}/);
});

test('Tools UI uses only the folded host Tool Library operations', () => {
  const tools = source('../src/screens/ToolsScreen.jsx');

  for (const operation of [
    'index',
    'search',
    'inspect',
    'executeTool',
    'listSkills',
    'renderSkill',
    'executeSkill',
  ]) {
    assert.match(tools, new RegExp('api\\.' + operation + '\\b'));
  }
  assert.doesNotMatch(tools, /api\.(create|update|remove|importPackage|exportPackage)\b/);
});

test('Wizard UI is a three-step host, CLI, and external-client flow', () => {
  const wizard = source('../src/screens/WizardScreen.jsx');

  assert.match(wizard, /Step \$\{n\} of 3/);
  assert.match(wizard, /HOST_STEPS\.map/);
  assert.match(wizard, /CLI_STEPS\.map/);
  assert.match(wizard, /selectedClient\.id === 'claude-desktop'/);
  assert.doesNotMatch(wizard, /runtimeManager|pythonVersion|\buv\b|aeMcp/);
});
