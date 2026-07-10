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

test('api channel injects a resolved compatible request profile and still drops API key', () => {
  const env = claudeChannelEnv(
    { PATH: 'x', ANTHROPIC_API_KEY: 'leak' },
    { channel: 'api', requestProfile: { baseUrl: 'https://api.anthropic.com', auth: { kind: 'header', name: 'x-api-key', value: 'resolved-for-spawn' }, extraHeaders: [] } }
  );
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'resolved-for-spawn');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test('api channel without a usable profile behaves like subscription', () => {
  const env = claudeChannelEnv({ ANTHROPIC_BASE_URL: 'https://stale' }, { channel: 'api', requestProfile: null });
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
});

test('credential channel sanitization removes every Windows case variant before injection', () => {
  const inherited = {
    Path: 'C:\\bin',
    anthropic_api_key: 'lower-key',
    Anthropic_Base_Url: 'https://stale.example',
    ANTHROPIC_auth_TOKEN: 'stale-token',
  };
  const subscription = claudeChannelEnv(inherited, { channel: 'subscription' });
  assert.deepEqual(Object.keys(subscription), ['Path']);

  const api = claudeChannelEnv(inherited, {
    channel: 'api',
    requestProfile: { baseUrl: 'https://api.anthropic.com', auth: { kind: 'header', name: 'Authorization', value: 'Bearer new-token' }, extraHeaders: [] },
  });
  assert.deepEqual(api, {
    Path: 'C:\\bin',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: 'new-token',
  });
});

test('custom auth or extra headers are rejected for Agent SDK spawn', () => {
  assert.throws(
    () => claudeChannelEnv({}, { channel: 'api', requestProfile: { baseUrl: 'https://api.anthropic.com', auth: { kind: 'header', name: 'x-custom', value: 'secret' }, extraHeaders: [] } }),
    (error) => error.code === 'CLAUDE_AGENT_PROVIDER_UNSUPPORTED',
  );
  assert.throws(
    () => claudeChannelEnv({}, { channel: 'api', requestProfile: { baseUrl: 'https://api.anthropic.com', auth: { kind: 'header', name: 'x-api-key', value: 'secret' }, extraHeaders: [{ name: 'x-feature', value: 'on', source: 'literal' }] } }),
    (error) => error.code === 'CLAUDE_AGENT_PROVIDER_UNSUPPORTED',
  );
});
