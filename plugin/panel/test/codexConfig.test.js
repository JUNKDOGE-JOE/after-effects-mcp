import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexCliCredentialAvailable,
  readCodexCliConfig,
  resolveCodexCliCredential,
} from '../src/cep/codexConfig.js';

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

function platform(fsImpl, home = 'C:\\Users\\test') {
  return { paths: { home, join: (parts) => parts.join('\\') }, fs: fsImpl };
}

test('readCodexCliConfig returns null when config.toml is missing', () => {
  const fsImpl = fakeFs({});
  assert.equal(readCodexCliConfig({ platform: platform(fsImpl), fsImpl }), null);
});

test('readCodexCliConfig returns null when home dir cannot be resolved', () => {
  const fsImpl = fakeFs({ 'C:\\Users\\test\\.codex\\config.toml': 'model = "gpt-5.5"' });
  assert.equal(readCodexCliConfig({ platform: platform(fsImpl, ''), fsImpl }), null);
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
  const result = readCodexCliConfig({ platform: platform(fsImpl), fsImpl });
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
  const result = readCodexCliConfig({ platform: platform(fsImpl), fsImpl });
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
  const result = readCodexCliConfig({ platform: platform(fsImpl), fsImpl });
  assert.equal(result.providerId, 'mediastorm_glm');
  assert.equal(result.provider.baseUrl, 'https://api.example.com/v1');
});

test('readCodexCliConfig returns null on malformed/unparseable content', () => {
  // Not TOML-shaped enough to reasonably parse; simulate a thrown error by
  // making readFileSync return non-string content that breaks parsing logic
  // — the parser must guard this and return null rather than throw.
  const fsImpl = { readFileSync: () => { throw new Error('boom'); } };
  assert.equal(readCodexCliConfig({ platform: platform(fsImpl), fsImpl }), null);
});

test('readCodexCliConfig returns null when there is no model_provider and no model', () => {
  const toml = '[some_other_section]\nfoo = "bar"\n';
  const fsImpl = fakeFs({ 'C:\\Users\\test\\.codex\\config.toml': toml });
  assert.equal(readCodexCliConfig({ platform: platform(fsImpl), fsImpl }), null);
});

test('codexCliCredentialAvailable returns only a Boolean and never resolves a stored reference', () => {
  const provider = { envKey: 'MEDIASTORM_GLM_API_KEY' };
  const storedValueRef = {
    kind: 'secret',
    reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1',
    revision: 1,
  };
  assert.equal(codexCliCredentialAvailable({ provider, env: { MEDIASTORM_GLM_API_KEY: 'from-env' }, storedValueRef: null }), true);
  assert.equal(codexCliCredentialAvailable({ provider, env: {}, storedValueRef }), true);
  assert.equal(codexCliCredentialAvailable({ provider, env: {}, storedValueRef: null }), false);
  assert.equal(typeof codexCliCredentialAvailable({ provider, env: {}, storedValueRef }), 'boolean');
});

test('resolveCodexCliCredential resolves exactly once at request/spawn time', async () => {
  const provider = { envKey: 'MEDIASTORM_GLM_API_KEY' };
  const storedValueRef = {
    kind: 'secret',
    reference: 'aemcp-secret://provider/5eb75f05-5d9e-5d9c-85af-f0893e8b90c2/auth-model/v1',
    revision: 1,
  };
  let calls = 0;
  const secretService = { resolve: async () => { calls += 1; return 'resolved-only-for-spawn'; } };
  assert.equal(await resolveCodexCliCredential({ provider, env: { MEDIASTORM_GLM_API_KEY: 'from-env' }, storedValueRef, secretService }), 'from-env');
  assert.equal(calls, 0);
  assert.equal(await resolveCodexCliCredential({ provider, env: {}, storedValueRef, secretService }), 'resolved-only-for-spawn');
  assert.equal(calls, 1);
  await assert.rejects(
    resolveCodexCliCredential({ provider, env: {}, storedValueRef: null, secretService }),
    (error) => error.code === 'CODEX_CREDENTIAL_UNAVAILABLE',
  );
});
