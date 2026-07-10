import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectClaudeSettingsEnv, readClaudeSettingsProviderDraft } from '../src/cep/claudeSettingsImport.js';

function fakeFs(initial) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFileSync(path) {
      if (!files.has(path)) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
      return files.get(path);
    },
  };
}

const ENV = { USERPROFILE: 'C:\\Users\\me' };
const FILE = 'C:\\Users\\me\\.claude\\settings.json';

test('inspectClaudeSettingsEnv is a non-secret SHA-256 preview', () => {
  const fs = fakeFs({
    [FILE]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-claude-marker' } }),
  });
  const preview = inspectClaudeSettingsEnv({ env: ENV, fsImpl: fs });
  assert.deepEqual(Object.keys(preview).sort(), ['available', 'baseUrl', 'sourceRevision']);
  assert.equal(preview.available, true);
  assert.equal(preview.baseUrl, 'https://relay.example/anthropic');
  assert.match(preview.sourceRevision, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(preview).includes('sk-claude-marker'), false);
});

test('readClaudeSettingsProviderDraft re-reads by revision and returns an ephemeral draft', () => {
  const fs = fakeFs({
    [FILE]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-claude-marker' } }),
  });
  const preview = inspectClaudeSettingsEnv({ env: ENV, fsImpl: fs });
  assert.deepEqual(readClaudeSettingsProviderDraft({ env: ENV, expectedSourceRevision: preview.sourceRevision, fsImpl: fs }), {
    name: 'Claude Code config',
    protocol: 'anthropic',
    baseUrl: 'https://relay.example/anthropic',
    modelAuthKind: 'bearer',
    modelAuthSecret: 'sk-claude-marker',
  });
});

test('readClaudeSettingsProviderDraft rejects source changes before exposing new data', () => {
  const fs = fakeFs({
    [FILE]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: 'sk-old' } }),
  });
  const preview = inspectClaudeSettingsEnv({ env: ENV, fsImpl: fs });
  fs.files.set(FILE, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://changed.example', ANTHROPIC_AUTH_TOKEN: 'sk-new' } }));
  assert.throws(
    () => readClaudeSettingsProviderDraft({ env: ENV, expectedSourceRevision: preview.sourceRevision, fsImpl: fs }),
    (error) => error.code === 'provider_import_source_changed',
  );
});

test('Claude settings preview returns null for missing, corrupt, or irrelevant files', () => {
  assert.equal(inspectClaudeSettingsEnv({ env: ENV, fsImpl: fakeFs({}) }), null);
  assert.equal(inspectClaudeSettingsEnv({ env: ENV, fsImpl: fakeFs({ [FILE]: '{bad' }) }), null);
  assert.equal(inspectClaudeSettingsEnv({ env: ENV, fsImpl: fakeFs({ [FILE]: JSON.stringify({ env: { OTHER: '1' } }) }) }), null);
});

test('Claude settings preview rejects credential-bearing base URLs', () => {
  const userInfo = fakeFs({ [FILE]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://user:secret@relay.example', ANTHROPIC_AUTH_TOKEN: 'sk-marker' } }) });
  assert.equal(inspectClaudeSettingsEnv({ env: ENV, fsImpl: userInfo }), null);
  const querySecret = fakeFs({ [FILE]: JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://relay.example?vendor_token=secret', ANTHROPIC_AUTH_TOKEN: 'sk-marker' } }) });
  assert.equal(inspectClaudeSettingsEnv({ env: ENV, fsImpl: querySecret }), null);
});
