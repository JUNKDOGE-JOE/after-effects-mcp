import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeChannelEnv } from '../src/lib/claudeChannel.js';

test('Claude subscription channel strips every custom Anthropic endpoint variable', () => {
  assert.deepEqual(claudeChannelEnv({
    ANTHROPIC_API_KEY: 'key',
    ANTHROPIC_BASE_URL: 'https://provider.test',
    ANTHROPIC_AUTH_TOKEN: 'token',
    Path: 'C:\\bin',
  }), { Path: 'C:\\bin' });
});
