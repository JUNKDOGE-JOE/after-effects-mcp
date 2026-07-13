import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeChannelEnv } from '../src/lib/claudeChannel.js';

test('subscription channel strips every provider credential variable', () => {
  const env = claudeChannelEnv({
    PATH: 'x',
    ANTHROPIC_API_KEY: 'leak',
    ANTHROPIC_BASE_URL: 'https://other',
    ANTHROPIC_AUTH_TOKEN: 'other-token',
  }, { channel: 'subscription' });

  assert.deepEqual(env, { PATH: 'x' });
});

test('api channel injects only an explicit normalized local route profile', () => {
  const env = claudeChannelEnv({
    PATH: 'x',
    ANTHROPIC_API_KEY: 'leak',
    ANTHROPIC_BASE_URL: 'https://upstream.example/v1',
    ANTHROPIC_AUTH_TOKEN: 'upstream-token',
  }, {
    channel: 'api',
    localRoute: {
      origin: 'http://127.0.0.1:43123/',
      routeToken: 'local-route-token',
    },
  });

  assert.deepEqual(env, {
    PATH: 'x',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:43123',
    ANTHROPIC_AUTH_TOKEN: 'local-route-token',
  });
});

test('credential sanitization removes every Windows case variant before route injection', () => {
  const inherited = {
    Path: 'C:\\bin',
    anthropic_api_key: 'lower-key',
    Anthropic_Base_Url: 'https://stale.example',
    ANTHROPIC_auth_TOKEN: 'stale-token',
  };
  assert.deepEqual(claudeChannelEnv(inherited, { channel: 'subscription' }), { Path: 'C:\\bin' });
  assert.deepEqual(claudeChannelEnv(inherited, {
    channel: 'api',
    localRoute: { origin: 'http://[::1]:43124', routeToken: 'new-route-token' },
  }), {
    Path: 'C:\\bin',
    ANTHROPIC_BASE_URL: 'http://[::1]:43124',
    ANTHROPIC_AUTH_TOKEN: 'new-route-token',
  });
});

test('api channel rejects missing, remote, versioned, or extended local route profiles', () => {
  assert.throws(
    () => claudeChannelEnv({}, { channel: 'api' }),
    (error) => error.code === 'CLAUDE_AGENT_LOCAL_ROUTE_REQUIRED',
  );
  for (const localRoute of [
    { origin: 'https://relay.example', routeToken: 'token' },
    { origin: 'http://127.0.0.1:43123/v1', routeToken: 'token' },
    { origin: 'http://127.0.0.1:43123', routeToken: ' token ' },
    { origin: 'http://127.0.0.1:43123', routeToken: 'token', extraHeaders: [] },
  ]) {
    assert.throws(
      () => claudeChannelEnv({}, { channel: 'api', localRoute }),
      (error) => error.code === 'CLAUDE_AGENT_LOCAL_ROUTE_INVALID',
    );
  }
});

test('api channel explicitly rejects legacy upstream request profiles', () => {
  assert.throws(
    () => claudeChannelEnv({}, {
      channel: 'api',
      requestProfile: {
        baseUrl: 'https://api.anthropic.com',
        auth: { kind: 'header', name: 'x-api-key', value: 'upstream-secret' },
        extraHeaders: [],
      },
    }),
    (error) => error.code === 'CLAUDE_AGENT_UPSTREAM_PROFILE_FORBIDDEN',
  );
});
