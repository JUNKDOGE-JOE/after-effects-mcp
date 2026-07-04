import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeChannelEnv } from '../src/lib/claudeChannel.js';

test('subscription channel strips ANTHROPIC_API_KEY and inherited base URL/token', () => {
  const env = claudeChannelEnv(
    { PATH: 'x', ANTHROPIC_API_KEY: 'leak', ANTHROPIC_BASE_URL: 'https://other', ANTHROPIC_AUTH_TOKEN: 'other-tok' },
    { channel: 'subscription' }
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, 'x');
});

test('api channel injects provider base URL + auth token and still drops API key', () => {
  const env = claudeChannelEnv(
    { PATH: 'x', ANTHROPIC_API_KEY: 'leak' },
    { channel: 'api', provider: { baseUrl: 'https://relay.example/anthropic', apiKey: 'sk-relay' } }
  );
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://relay.example/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-relay');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('api channel without a usable provider behaves like subscription', () => {
  const env = claudeChannelEnv({ ANTHROPIC_BASE_URL: 'https://stale' }, { channel: 'api', provider: null });
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});
