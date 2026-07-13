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

test('provider manager keeps one automatic API key primary and v3 overrides folded', () => {
  const manager = source('../src/components/settings/ProviderManagerSection.jsx');
  for (const pattern of [
    /draft\.modelAuthKind/,
    /draft\.modelAuthHeaderName/,
    /addHeader/,
    /valueKind/,
    /scopes/,
    /scopeProbe/,
    /scopeModel/,
    /probePreference/,
  ]) assert.match(manager, pattern);
  assert.match(manager, /isSensitiveProviderHeaderName\(header\.name\)/);
  assert.match(manager, /isSensitiveProviderHeaderName\(value\)[\s\S]*valueKind:\s*'secret'/);
  assert.match(manager, /name:\s*'',\s*scopes:\s*\['model'\],\s*valueKind:\s*'secret'/);
  assert.match(manager, /label=\{t\.apiKey\}/);
  assert.match(manager, /value:\s*'auto',\s*label:\s*t\.auto/);
  assert.doesNotMatch(manager, /<Field\s+label=\{t\.protocol\}/);
  assert.doesNotMatch(manager, /draft\.dialectOverride|draft\.probeAuth/);
  const apiKeyInput = manager.indexOf('<SecretInput name="modelAuthSecret"');
  const advancedStart = manager.indexOf('data-provider-advanced-auth');
  const advancedEnd = manager.indexOf('</details>', advancedStart);
  assert.ok(apiKeyInput >= 0 && advancedStart > apiKeyInput);
  assert.ok(advancedEnd > advancedStart);
  const primaryForm = manager.slice(0, advancedStart);
  const advancedAuth = manager.slice(advancedStart, advancedEnd);
  assert.doesNotMatch(primaryForm, /<Select value=\{draft\.modelAuthKind\}/);
  for (const pattern of [
    /<Select value=\{draft\.modelAuthKind\}/,
    /draft\.modelAuthHeaderName/,
    /draft\.probePreference/,
    /addHeader/,
  ]) assert.match(advancedAuth, pattern);
  assert.match(manager, /\['codex',\s*'claude-code'\]/);
  assert.match(manager, /providerClientRouteBadge\s*\(\s*provider\s*,\s*\{\s*client,\s*modelId:\s*currentModelId,\s*lang\s*\}\s*\)/);
  assert.match(manager, /onProbe\s*\(\s*provider\s*,\s*\{\s*forceDetect:\s*true\s*,\s*modelId:\s*currentModelId\s*\}\s*\)/);
  assert.match(manager, /Array\.isArray\(provider\.modelCapabilities\)/);
  assert.doesNotMatch(manager, /provider\.probedModels\.some/);
});

test('Settings offers every v3 Provider to both Claude and Codex selectors', () => {
  const settings = source('../src/screens/SettingsScreen.jsx');
  assert.equal((settings.match(/\.\.\.providers\.map\(\(p\)\s*=>/g) || []).length, 2);
  assert.doesNotMatch(settings, /providers\.filter\(\(p\)\s*=>\s*p\.protocol/);
  assert.match(settings, /同一个 Provider 可同时用于 Claude 和 Codex/);
});

test('App routes provider probing through the v3 profile resolver and CAS flow', () => {
  const app = source('../src/app/App.jsx');
  assert.match(app, /runProviderManagerProbe\s*\(\s*provider\s*,\s*\{/);
  assert.match(app, /store:\s*providerStore/);
  assert.match(app, /resolveProviderRequestProfile\s*\(\s*entry\s*,\s*\{/);
  assert.match(app, /forceDetect:\s*options\.forceDetect\s*===\s*true/);
  assert.match(app, /modelId:\s*options\.modelId/);
  assert.doesNotMatch(app, /function\s+probeApiKeyFromProfile/);
  assert.match(app, /provider\.credential\.valueRef/);
  assert.match(app, /provider\.probeAuthOverride\?\.valueRef/);
  assert.match(app, /provider\.auth\?\.model\?\.valueRef/);
  assert.match(app, /provider\.auth\?\.probe\?\.valueRef/);
});

test('App requires authenticated helper capabilities before migration and preserves providers on repairable failure', () => {
  const app = source('../src/app/App.jsx');
  const settings = source('../src/screens/SettingsScreen.jsx');
  const initStart = app.indexOf("setProviderInit({ state: 'checking', error: '' })");
  const init = app.slice(initStart, app.indexOf('// Keep connection info fresh', initStart));
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
  assert.ok(init.indexOf('migrateProviderStoreSecrets') < init.indexOf('migrateProviderStoreV2ToV3'));
  assert.ok(init.indexOf('migrateProviderStoreV2ToV3') < init.indexOf('drainPendingProviderSecretDeletes'));
  assert.ok(init.indexOf('migrateProviderStoreSecrets') < init.indexOf('drainPendingProviderSecretDeletes'));
  assert.match(init, /needsSecretMigration\(\)\s*\|\|\s*providerStore\.needsSchemaMigration\(\)/);
  assert.match(init, /if\s*\(providerStore\.needsSchemaMigration\(\)\)\s*\{\s*await migrateProviderStoreV2ToV3/);
  assert.match(init, /providerSecretService\.resolve/);
  assert.match(init, /finally\s*\{[^}]*resolved[^}]*=\s*null/s);
  assert.match(init, /assertProviderStateCredentialFree\s*\(/);
  assert.doesNotMatch(init, /catch[\s\S]*setProviders\(providerStore\.list\(\)\)/);
  assert.match(app, /onImportClaudeSettings=\{async[\s\S]*providerInit\.state\s*!==\s*'ready'/);
  assert.match(app, /providerInit=\{providerInit\}/);
  assert.match(settings, /providerInit/);
  assert.match(settings, /repair|修复/i);
});

test('Codex app-server profile follows effective.channel and cannot inherit a closed custom-provider gate', () => {
  const app = source('../src/app/App.jsx');
  assert.match(app, /codexRuntimeProviderProfile\s*\(\s*\{[\s\S]*effectiveChannel:\s*effective\.channel/);
  assert.match(app, /const codexProviderCredentialResolverReady\s*=\s*providerInit\.state\s*===\s*'ready'/);
  assert.match(app, /customProviderCredentialResolverReady:\s*codexProviderCredentialResolverReady/);
  assert.match(app, /modelId:\s*effectiveModel/);
  assert.doesNotMatch(app, /customProviderDialect|codexCustomProviderDialect/);
  assert.match(app, /resolveRequestProfile:\s*\(provider,\s*details\)\s*=>\s*resolveProviderRequestProfile\(provider,\s*\{[\s\S]*\.\.\.details/);
  assert.match(app, /getProviderCandidate:\s*\(\)\s*=>\s*runtimeRef\.current\.providerCandidate/);
  assert.match(app, /providerCandidate:\s*effective\.channel\s*===\s*'custom'[\s\S]*modelId:\s*effectiveModel/);
  assert.match(app, /const recoverRuntimeProvider\s*=\s*React\.useCallback\(async\s*\(provider,\s*_failureFacts,\s*requestedModelId\)[\s\S]*runProviderManagerProbe\s*\(provider,[\s\S]*forceDetect:\s*true,[\s\S]*modelId/);
  assert.match(app, /onProviderProfileRecovered:\s*refreshRuntimeProviders/);
  assert.match(app, /previousCodexProviderProfileRef\.current\s*===\s*providerProfile/);
  assert.match(app, /previousCodexProviderProfileRef\.current\s*=\s*providerProfile;\s*codexBackend\.reset\(\)/);
  assert.doesNotMatch(app, /codexBaseUrl:\s*codexCustomProvider\s*\?/);
  assert.doesNotMatch(app, /if\s*\(codexCustomProvider\s*&&\s*codexCustomProvider\.baseUrl\)\s*return undefined/);
  assert.match(app, /const facts\s*=\s*\{[\s\S]*effectiveChannel:\s*effective\.channel/);
  assert.match(app, /const facts\s*=\s*\{[\s\S]*customProviderCredentialResolverReady:\s*codexProviderCredentialResolverReady/);
  assert.match(app, /onCodexProviderChange=\{\(id\)\s*=>\s*\{[\s\S]*syncCodexProviderChannelLock\(id\)/);
  assert.match(app, /onLockChannel=\{\(channel\)\s*=>\s*\{[\s\S]*codexProviderChannelLock\(channel,\s*codexProviderId\)/);
});

test('provider initialization retains the last provider list and renders distinct actionable failure classes', () => {
  const app = source('../src/app/App.jsx');
  const settings = source('../src/screens/SettingsScreen.jsx');
  const initStart = app.indexOf("setProviderInit({ state: 'checking', error: '' })");
  const init = app.slice(initStart, app.indexOf('// Keep connection info fresh', initStart));
  assert.match(init, /providerInitFailure\s*\(\s*error\s*\)/);
  assert.match(init, /assertProviderStateCredentialFree\s*\(/);
  assert.ok(init.indexOf('assertProviderStateCredentialFree') < init.indexOf('setProviders(providerState.providers)'));
  assert.doesNotMatch(init, /setProviders\s*\(\s*providerStore\.list\s*\(\s*\)\s*\)/);
  assert.doesNotMatch(init, /catch\s*\{\s*setProviders\s*\(\s*\[\s*\]\s*\)/);
  for (const code of [
    'PLATFORM_HELPER_START_FAILED',
    'PLATFORM_HELPER_REPAIR_REQUIRED',
    'PROVIDER_STORE_CORRUPT',
    'PROVIDER_MIGRATION_CONFLICT',
    'PROVIDER_SECRET_MISMATCH',
  ]) assert.match(settings, new RegExp(code));
});

test('startup discards unversioned Codex and ZCode model caches', () => {
  const app = source('../src/app/App.jsx');
  assert.doesNotMatch(app, /readCachedCodexModels|writeCachedCodexModels/);
  assert.doesNotMatch(app, /readCachedZcodeProbedModels|writeCachedZcodeProbedModels/);
  assert.match(app, /localStorage\.removeItem\s*\(\s*CODEX_MODELS_CACHE_KEY\s*\)/);
  assert.match(app, /localStorage\.removeItem\s*\(\s*ZCODE_PROBED_MODELS_CACHE_KEY\s*\)/);
  assert.match(app, /\[codexModels,\s*setCodexModels\]\s*=\s*React\.useState\(null\)/);
  assert.match(app, /\[zcodeProbedModels,\s*setZcodeProbedModels\]\s*=\s*React\.useState\(null\)/);
});

test('ChatScreen directs users to Provider Manager and the credential helper instead of pasting a key', () => {
  const chat = source('../src/screens/ChatScreen.jsx');
  assert.doesNotMatch(chat, /粘贴[^\n]*API Key|Paste[^\n]*API Key/i);
  assert.match(chat, /Provider 管理/);
  assert.match(chat, /Provider Manager/);
  assert.match(chat, /系统凭据|credential (?:store|helper)/i);
});
