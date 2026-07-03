import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicEndpoint,
  codexAppServerArgs,
  codexSpawnEnv,
  ensureUserEnv,
  normalizeProviderProfile,
} from '../src/lib/providerProfile.js';

test('codexAppServerArgs keeps official Codex login path when no custom base URL is configured', () => {
  assert.deepEqual(codexAppServerArgs(normalizeProviderProfile({})), ['app-server']);
});

test('codexAppServerArgs builds explicit custom provider config for app-server', () => {
  const profile = normalizeProviderProfile({
    codexBaseUrl: ' https://proxy.example/openai/ ',
    codexApiKey: ' sk-proxy ',
    codexProviderId: 'my-provider',
    codexWireApi: 'chat',
  });

  assert.deepEqual(codexAppServerArgs(profile), [
    'app-server',
    '-c', 'model_provider="my-provider"',
    '-c', 'model_providers.my-provider.name="AE MCP Custom"',
    '-c', 'model_providers.my-provider.base_url="https://proxy.example/openai"',
    '-c', 'model_providers.my-provider.env_key="AE_MCP_CODEX_API_KEY"',
    '-c', 'model_providers.my-provider.wire_api="responses"',
    '-c', 'model_providers.my-provider.requires_openai_auth=false',
  ]);
  assert.equal(codexSpawnEnv(profile, { PATH: 'C:\\Node' }).AE_MCP_CODEX_API_KEY, 'sk-proxy');
});

test('anthropicEndpoint appends API paths without dropping a proxy prefix', () => {
  assert.equal(
    anthropicEndpoint('https://proxy.example/anthropic/', '/v1/messages'),
    'https://proxy.example/anthropic/v1/messages'
  );
});

test('ensureUserEnv fills USERPROFILE/HOME/APPDATA from whichever anchor exists', () => {
  const fromHome = ensureUserEnv({ HOME: 'C:\\Users\\me\\' });
  assert.equal(fromHome.USERPROFILE, 'C:\\Users\\me');
  assert.equal(fromHome.HOME, 'C:\\Users\\me\\');
  assert.equal(fromHome.APPDATA, 'C:\\Users\\me\\AppData\\Roaming');

  const fromHomedir = ensureUserEnv({}, { homedir: 'C:\\Users\\me' });
  assert.equal(fromHomedir.USERPROFILE, 'C:\\Users\\me');
  assert.equal(fromHomedir.HOME, 'C:\\Users\\me');

  const untouched = ensureUserEnv({ USERPROFILE: 'C:\\U', HOME: 'C:\\U', APPDATA: 'C:\\A' });
  assert.equal(untouched.APPDATA, 'C:\\A');

  assert.deepEqual(ensureUserEnv({ PATH: 'x' }), { PATH: 'x' });
});
