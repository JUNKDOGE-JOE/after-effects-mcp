import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const app = () => readFileSync(new URL('../src/app/App.jsx', import.meta.url), 'utf8');
const settings = () => readFileSync(new URL('../src/screens/SettingsScreen.jsx', import.meta.url), 'utf8');

test('Provider Manager is OpenCode-only and has no platform helper entry point', () => {
  const source = app();
  assert.match(source, /createOpenCodeProviderStore/);
  assert.match(source, /<ProviderManagerSection[\s\S]*opencodeMode/);
  assert.doesNotMatch(source, /createHostSecretStore/);
  assert.doesNotMatch(source, /repairPlatformHelper/);
  assert.doesNotMatch(source, /createLegacyApiKeyStore/);
});

test('old provider definitions can be shown but their helper credential references are not migrated', () => {
  const source = app();
  assert.match(source, /legacyProviderStore \? legacyProviderStore\.list\(\) : \[\]/);
  assert.match(source, /openCodeProviderStore\.importLegacyProviders\(legacyProviders\)/);
  assert.doesNotMatch(source, /providerSecretService/);
  assert.doesNotMatch(source, /aemcp-secret:\/\/provider/);
});

test('saving a provider refreshes the OpenCode configuration process', () => {
  const source = app();
  assert.match(source, /openCodeProviderStore\.save\(draft, \{ apiKey, currentId: draft\.id \}\)/);
  assert.match(source, /openCodeBackend\.reset\(\);[\s\S]*runOpenCodeProbe\(\);/);
  assert.match(source, /getProviders: \(\) => providersRef\.current/);
});

test('Settings makes OpenCode selectable and removes custom Claude/Codex API routes', () => {
  const source = settings();
  assert.match(source, /value: 'opencode', label: t\.backendOpenCode/);
  assert.match(source, /backend === 'opencode'[\s\S]*channels\.opencode/);
  assert.doesNotMatch(source, /channel\.channel === 'api'/);
  assert.doesNotMatch(source, /channel\.channel === 'custom'/);
});

test('OpenCode remains the embedded backend with host-owned write approval', () => {
  const source = readFileSync(new URL('../src/cep/openCodeBackend.js', import.meta.url), 'utf8');
  assert.match(source, /permission: \{ '\*': 'allow' \}/);
  assert.match(source, /Host conversation approval/);
  assert.match(source, /openCodeProviderDefinitions\(getProviders\(\)\)/);
});
