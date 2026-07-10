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

function platform(fsImpl, home = 'C:\\Users\\me') {
  return { paths: { home, join: (parts) => parts.join('\\') }, fs: fsImpl };
}

test('reads ANTHROPIC_BASE_URL/AUTH_TOKEN from ~/.claude/settings.json env block', () => {
  const files = {
    'C:\\Users\\me\\.claude\\settings.json': JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://relay.example/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-relay' },
    }),
  };
  assert.deepEqual(
    readClaudeSettingsEnv({ platform: platform(fakeFs(files)), fsImpl: fakeFs(files) }),
    { baseUrl: 'https://relay.example/anthropic', authToken: 'sk-relay' }
  );
});

test('returns null for missing file, bad JSON, or no relevant env keys', () => {
  assert.equal(readClaudeSettingsEnv({ platform: platform(fakeFs({})), fsImpl: fakeFs({}) }), null);
  const badFs = fakeFs({ 'C:\\Users\\me\\.claude\\settings.json': '{oops' });
  assert.equal(readClaudeSettingsEnv({ platform: platform(badFs), fsImpl: badFs }), null);
  const emptyFs = fakeFs({ 'C:\\Users\\me\\.claude\\settings.json': JSON.stringify({ env: { OTHER: '1' } }) });
  assert.equal(readClaudeSettingsEnv({ platform: platform(emptyFs), fsImpl: emptyFs }), null);
  assert.equal(readClaudeSettingsEnv({ platform: platform(fakeFs({}), ''), fsImpl: fakeFs({}) }), null);
});
