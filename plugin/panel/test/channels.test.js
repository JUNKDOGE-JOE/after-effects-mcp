import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claudeChannels,
  codexChannels,
  migrateBackendPref,
  openCodeChannels,
} from '../src/lib/channels.js';

test('Claude and Codex expose one CLI-owned channel each', () => {
  assert.deepEqual(
    claudeChannels({ probe: { loggedIn: true } }).map((item) => item.channel),
    ['subscription'],
  );
  assert.deepEqual(
    codexChannels({ codexProbe: { loggedIn: true } }).map((item) => item.channel),
    ['cli'],
  );
});

test('OpenCode needs a configured provider and healthy CLI probe', () => {
  const channels = openCodeChannels({
    probe: { loggedIn: true },
    providers: [{ id: 'aemcp-example', needsApiKey: false }],
  });
  assert.equal(channels[0].ok, true);
});

test('unknown persisted backend choices reset to subscription', () => {
  const values = new Map([['ae_mcp_backend', 'legacy-provider']]);
  const storage = {
    getItem: (key) => values.get(key) || '',
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const migrated = migrateBackendPref(storage);
  assert.equal(migrated.pref, 'subscription');
  assert.equal(values.get('ae_mcp_backend'), 'subscription');
});
