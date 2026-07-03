import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCodexCliConfig, resolveCodexProviderApiKey } from '../src/cep/codexConfig.js';

function fakeFs(files) {
  return {
    readFileSync(path) {
      if (Object.prototype.hasOwnProperty.call(files, path)) return files[path];
      const err = new Error('ENOENT: ' + path);
      err.code = 'ENOENT';
      throw err;
    },
  };
}

test('readCodexCliConfig returns null when config.toml is missing', () => {
  const fsImpl = fakeFs({});
  assert.equal(readCodexCliConfig({ env: { USERPROFILE: 'C:\\Users\\test' }, fsImpl }), null);
});

test('readCodexCliConfig returns null when home dir cannot be resolved', () => {
  const fsImpl = fakeFs({ 'C:\\Users\\test\\.codex\\config.toml': 'model = "gpt-5.5"' });
  assert.equal(readCodexCliConfig({ env: {}, fsImpl }), null);
});

test('readCodexCliConfig parses top-level model/model_provider and matching provider section', () => {
  const toml = [
    'model = "gpt-5.5"',
    'model_provider = "mediastorm_glm"',
    '',
    '[model_providers.mediastorm_glm]',
    'name = "MediaStorm GLM"',
    'base_url = "https://api.example.com/v1"',
    'env_key = "MEDIASTORM_GLM_API_KEY"',
    'wire_api = "responses"',
  ].join('\n');
  const fsImpl = fakeFs({ 'C:\\Users\\test\\.codex\\config.toml': toml });
  const result = readCodexCliConfig({ env: { USERPROFILE: 'C:\\Users\\test' }, fsImpl });
  assert.deepEqual(result, {
    model: 'gpt-5.5',
    providerId: 'mediastorm_glm',
    provider: {
      name: 'MediaStorm GLM',
      baseUrl: 'https://api.example.com/v1',
      envKey: 'MEDIASTORM_GLM_API_KEY',
      wireApi: 'responses',
    },
  });
});

test('readCodexCliConfig omits provider when the referenced section is missing', () => {
  const toml = 'model = "gpt-5.5"\nmodel_provider = "ghost"\n';
  const fsImpl = fakeFs({ 'C:\\Users\\test\\.codex\\config.toml': toml });
  const result = readCodexCliConfig({ env: { USERPROFILE: 'C:\\Users\\test' }, fsImpl });
  assert.deepEqual(result, { model: 'gpt-5.5', providerId: 'ghost', provider: null });
});

test('readCodexCliConfig ignores comments and unrelated sections', () => {
  const toml = [
    '# top comment',
    'model = "gpt-5.5" # inline-ish comment on its own is fine to ignore if simple',
    'model_provider = "mediastorm_glm"',
    '',
    '[some_other_section]',
    'foo = "bar"',
    '',
    '[model_providers.mediastorm_glm]',
    'base_url = "https://api.example.com/v1"',
    'env_key = "MEDIASTORM_GLM_API_KEY"',
    'wire_api = "responses"',
  ].join('\n');
  const fsImpl = fakeFs({ 'C:\\Users\\test\\.codex\\config.toml': toml });
  const result = readCodexCliConfig({ env: { USERPROFILE: 'C:\\Users\\test' }, fsImpl });
  assert.equal(result.providerId, 'mediastorm_glm');
  assert.equal(result.provider.baseUrl, 'https://api.example.com/v1');
});

test('readCodexCliConfig returns null on malformed/unparseable content', () => {
  // Not TOML-shaped enough to reasonably parse; simulate a thrown error by
  // making readFileSync return non-string content that breaks parsing logic
  // — the parser must guard this and return null rather than throw.
  const fsImpl = { readFileSync: () => { throw new Error('boom'); } };
  assert.equal(readCodexCliConfig({ env: { USERPROFILE: 'C:\\Users\\test' }, fsImpl }), null);
});

test('readCodexCliConfig returns null when there is no model_provider and no model', () => {
  const toml = '[some_other_section]\nfoo = "bar"\n';
  const fsImpl = fakeFs({ 'C:\\Users\\test\\.codex\\config.toml': toml });
  assert.equal(readCodexCliConfig({ env: { USERPROFILE: 'C:\\Users\\test' }, fsImpl }), null);
});

test('resolveCodexProviderApiKey prefers env var, then stored key, then empty', () => {
  const provider = { envKey: 'MEDIASTORM_GLM_API_KEY' };
  assert.equal(resolveCodexProviderApiKey({ provider, env: { MEDIASTORM_GLM_API_KEY: 'from-env' }, storedKey: 'from-store' }), 'from-env');
  assert.equal(resolveCodexProviderApiKey({ provider, env: {}, storedKey: 'from-store' }), 'from-store');
  assert.equal(resolveCodexProviderApiKey({ provider, env: {}, storedKey: '' }), '');
  assert.equal(resolveCodexProviderApiKey({ provider: null, env: { MEDIASTORM_GLM_API_KEY: 'x' }, storedKey: 'from-store' }), 'from-store');
});
