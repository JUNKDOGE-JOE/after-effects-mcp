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

test('Codex exposes failed probe detail instead of only successful identity fields', () => {
  const channels = codexChannels({
    codexProbe: { loggedIn: false, detail: 'probe timeout: account/read' },
  });
  assert.equal(channels[0].detail, 'probe timeout: account/read');
});

test('Claude probe timeout guidance is different from not-logged-in guidance', () => {
  const timeout = claudeChannels({
    probe: { loggedIn: false, cliOk: true, reason: 'probe-timeout' },
  })[0].fixHint;
  const loggedOut = claudeChannels({
    probe: { loggedIn: false, cliOk: true, reason: 'not-logged-in' },
  })[0].fixHint;
  assert.notEqual(timeout.zh, loggedOut.zh);
  assert.notEqual(timeout.en, loggedOut.en);
  assert.match(timeout.zh, /诊断/);
  assert.match(timeout.en, /Diagnostics/);
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
