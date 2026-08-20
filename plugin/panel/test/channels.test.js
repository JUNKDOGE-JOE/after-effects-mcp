import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  claudeChannels,
  codexChannels,
  migrateBackendPref,
  openCodeChannels,
} from '../src/lib/channels.js';

test('Claude and Codex expose only their CLI-owned channels', () => {
  const claude = claudeChannels({ probe: { cliOk: true, loggedIn: true } });
  assert.deepEqual(claude.map((channel) => channel.channel), ['subscription']);
  assert.equal(claude[0].ok, true);

  const codex = codexChannels({
    codexProbe: { loggedIn: true, runtimeOk: true },
    cliConfig: { providerId: 'local', provider: { baseUrl: 'https://relay.example' } },
    cliCredentialAvailable: true,
  });
  assert.deepEqual(codex.map((channel) => channel.channel), ['cli', 'cli-config']);
  assert.equal(codex.every((channel) => channel.channel !== 'custom'), true);
});

test('OpenCode provider channel requires a re-entered key and a healthy probe', () => {
  const legacy = openCodeChannels({
    probe: { loggedIn: true },
    providers: [{ id: 'aemcp-relay', needsApiKey: true }],
  })[0];
  assert.equal(legacy.ok, false);
  assert.match(legacy.fixHint.zh, /重新填写 key/);

  const ready = openCodeChannels({
    probe: { loggedIn: true, detail: 'OpenCode 1.17.4' },
    providers: [{ id: 'aemcp-relay', needsApiKey: false }],
  })[0];
  assert.equal(ready.channel, 'provider');
  assert.equal(ready.ok, true);
  assert.equal(ready.detail, 'OpenCode 1.17.4');
});

test('legacy custom backend choices migrate to the OpenCode path without enabling API routes', () => {
  const values = new Map([
    ['ae_mcp_backend', 'byok'],
    ['ae_mcp_channel_lock', 'api'],
    ['ae_mcp_channel_codex', 'custom'],
  ]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.deepEqual(migrateBackendPref(storage), {
    pref: 'subscription',
    channelChoices: { claude: 'subscription', codex: 'cli', opencode: 'provider' },
  });
  assert.equal(values.get('ae_mcp_channel_lock'), undefined);
  assert.equal(values.get('ae_mcp_channel_codex'), 'cli');
  assert.equal(values.get('ae_mcp_channel_opencode'), 'provider');
});
