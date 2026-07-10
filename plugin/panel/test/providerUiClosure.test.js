import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

test('provider secrets stay uncontrolled and App reads them locally from the submit event', () => {
  const manager = source('../src/components/settings/ProviderManagerSection.jsx');
  const app = source('../src/app/App.jsx');
  assert.doesNotMatch(manager, /new FormData\s*\(/);
  assert.doesNotMatch(manager, /modelAuthSecret\s*:\s*String\s*\(form\./);
  assert.match(manager, /onUpsert\s*\(\s*event\s*,\s*draftToEntry\(draft\)\s*\)/);
  assert.match(app, /onUpsert=\{async\s*\(event,\s*draft\)/);
  assert.match(app, /new FormData\s*\(\s*event\.currentTarget\s*\)/);
  assert.doesNotMatch(app, /use(?:State|Ref)\([^\n]*(?:modelAuthSecret|probeAuthSecret|headerSecret)/);
});

test('provider manager exposes model/probe auth, custom headers, scoped extra headers, and dialect override', () => {
  const manager = source('../src/components/settings/ProviderManagerSection.jsx');
  for (const pattern of [
    /draft\.modelAuthKind/,
    /draft\.modelAuthHeaderName/,
    /draft\.probeAuthMode/,
    /draft\.probeAuthKind/,
    /draft\.probeAuthHeaderName/,
    /<SecretInput\s+name="probeAuthSecret"/,
    /addHeader/,
    /valueKind/,
    /scopes/,
    /scopeProbe/,
    /scopeModel/,
    /dialectOverride/,
  ]) assert.match(manager, pattern);
});

test('App requires authenticated helper capabilities before migration and preserves providers on repairable failure', () => {
  const app = source('../src/app/App.jsx');
  const settings = source('../src/screens/SettingsScreen.jsx');
  const init = app.slice(app.indexOf("if (status.state !== 'ok')"));
  assert.match(init, /await\s+host\.capabilities\s*\(/);
  for (const pattern of [
    /protocolVersion/,
    /authenticatedCaller/,
    /secretBackend/,
    /secret\.get/,
    /secret\.set/,
    /secret\.delete/,
  ]) assert.match(app, pattern);
  assert.ok(init.indexOf('host.capabilities') < init.indexOf('migrateProviderStoreSecrets'));
  assert.ok(init.indexOf('migrateProviderStoreSecrets') < init.indexOf('drainPendingProviderSecretDeletes'));
  assert.match(init, /providerSecretService\.resolve/);
  assert.match(init, /finally\s*\{[^}]*resolved[^}]*=\s*null/s);
  assert.match(init, /catch[\s\S]*setProviders\(providerStore\.list\(\)\)/);
  assert.match(app, /onImportClaudeSettings=\{async[\s\S]*providerInit\.state\s*!==\s*'ready'/);
  assert.match(app, /providerInit=\{providerInit\}/);
  assert.match(settings, /providerInit/);
  assert.match(settings, /repair|修复/i);
});

test('Codex app-server profile follows effective.channel and cannot inherit a closed custom-provider gate', () => {
  const app = source('../src/app/App.jsx');
  assert.match(app, /codexRuntimeProviderProfile\s*\(\s*\{[\s\S]*effectiveChannel:\s*effective\.channel/);
  assert.match(app, /customProviderCredentialResolverReady:\s*false/);
  assert.doesNotMatch(app, /codexBaseUrl:\s*codexCustomProvider\s*\?/);
  assert.doesNotMatch(app, /if\s*\(codexCustomProvider\s*&&\s*codexCustomProvider\.baseUrl\)\s*return undefined/);
  assert.match(app, /const facts\s*=\s*\{[\s\S]*effectiveChannel:\s*effective\.channel/);
  assert.match(app, /const facts\s*=\s*\{[\s\S]*customProviderCredentialResolverReady:\s*false/);
});

test('provider initialization retains the last provider list and renders distinct actionable failure classes', () => {
  const app = source('../src/app/App.jsx');
  const settings = source('../src/screens/SettingsScreen.jsx');
  const init = app.slice(app.indexOf("if (status.state !== 'ok')"));
  assert.match(init, /providerInitFailure\s*\(\s*error\s*\)/);
  assert.doesNotMatch(init, /catch\s*\{\s*setProviders\s*\(\s*\[\s*\]\s*\)/);
  for (const code of [
    'PLATFORM_HELPER_REPAIR_REQUIRED',
    'PROVIDER_STORE_CORRUPT',
    'PROVIDER_MIGRATION_CONFLICT',
    'PROVIDER_SECRET_MISMATCH',
  ]) assert.match(settings, new RegExp(code));
});

test('ChatScreen directs users to Provider Manager and the credential helper instead of pasting a key', () => {
  const chat = source('../src/screens/ChatScreen.jsx');
  assert.doesNotMatch(chat, /粘贴[^\n]*API Key|Paste[^\n]*API Key/i);
  assert.match(chat, /Provider 管理/);
  assert.match(chat, /Provider Manager/);
  assert.match(chat, /系统凭据|credential (?:store|helper)/i);
});
