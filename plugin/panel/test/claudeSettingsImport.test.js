import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeSettingsEnv } from '../src/cep/claudeSettingsImport.js';

function fakeFs(files) {
  return {
    readFileSync(p) {
      if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return files[p];
    },
  };
}

test('reads ANTHROPIC_BASE_URL/AUTH_TOKEN from ~/.claude/settings.json env block', () => {
  const files = {
    'C:\\Users\\me\\.claude\\settings.json': JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://relay.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-relay' },
    }),
  };
  assert.deepEqual(
    readClaudeSettingsEnv({ env: { USERPROFILE: 'C:\\Users\\me' }, fsImpl: fakeFs(files) }),
    { baseUrl: 'https://relay.example/anthropic', authToken: 'sk-relay' }
  );
});

test('returns null for missing file, bad JSON, or no relevant env keys', () => {
  assert.equal(readClaudeSettingsEnv({ env: { USERPROFILE: 'C:\\Users\\me' }, fsImpl: fakeFs({}) }), null);
  assert.equal(readClaudeSettingsEnv({ env: { USERPROFILE: 'C:\\Users\\me' }, fsImpl: fakeFs({ 'C:\\Users\\me\\.claude\\settings.json': '{oops' }) }), null);
  assert.equal(readClaudeSettingsEnv({ env: { USERPROFILE: 'C:\\Users\\me' }, fsImpl: fakeFs({ 'C:\\Users\\me\\.claude\\settings.json': JSON.stringify({ env: { OTHER: '1' } }) }) }), null);
  assert.equal(readClaudeSettingsEnv({ env: {}, fsImpl: fakeFs({}) }), null);
});
