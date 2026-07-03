import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickBackend, deriveToolMeta, shouldResetOnBackendChange } from '../src/lib/backendSelect.js';

test('pickBackend follows subscription and BYOK selection rules', () => {
  const cases = [
    [{ pref: 'byok', probe: null, hasApiKey: true }, { backend: 'byok', reason: 'ok' }],
    [{ pref: 'byok', probe: null, hasApiKey: false }, { backend: 'none', reason: 'no-key' }],
    [{ pref: 'subscription', probe: null, hasApiKey: true }, { backend: 'none', reason: 'probing' }],
    [{ pref: 'subscription', probe: null, hasApiKey: false }, { backend: 'none', reason: 'probing' }],
    [{ pref: 'subscription', probe: { nodeOk: false, loggedIn: false }, hasApiKey: true }, { backend: 'byok', reason: 'no-node' }],
    [{ pref: 'subscription', probe: { nodeOk: false, loggedIn: false }, hasApiKey: false }, { backend: 'none', reason: 'no-node' }],
    [{ pref: 'subscription', probe: { nodeOk: true, loggedIn: false }, hasApiKey: true }, { backend: 'byok', reason: 'not-logged-in' }],
    [{ pref: 'subscription', probe: { nodeOk: true, loggedIn: false }, hasApiKey: false }, { backend: 'none', reason: 'not-logged-in' }],
    [{ pref: 'subscription', probe: { nodeOk: true, loggedIn: true }, hasApiKey: false }, { backend: 'subscription', reason: 'ok' }],
    [{ pref: 'codex', probe: { nodeOk: true, loggedIn: true }, codexProbe: null, hasApiKey: true }, { backend: 'none', reason: 'codex-probing' }],
    [{ pref: 'codex', probe: { nodeOk: true, loggedIn: true }, codexProbe: { loggedIn: false }, hasApiKey: true }, { backend: 'none', reason: 'codex-not-logged-in' }],
    [{ pref: 'codex', probe: { nodeOk: true, loggedIn: true }, codexProbe: { loggedIn: true }, hasApiKey: false }, { backend: 'codex', reason: 'ok' }],
    [{ pref: 'codex', probe: { nodeOk: true, loggedIn: true }, codexProbe: { loggedIn: false, runtimeOk: true }, hasCodexCustomProvider: true }, { backend: 'codex', reason: 'ok' }],
    [{ pref: 'codex', probe: { nodeOk: true, loggedIn: true }, codexProbe: { loggedIn: false, runtimeOk: false }, hasCodexCustomProvider: true }, { backend: 'none', reason: 'codex-runtime-unavailable' }],
    [{ pref: 'zcode', probe: { nodeOk: true, loggedIn: true }, zcodeProbe: null, hasApiKey: true }, { backend: 'none', reason: 'zcode-probing' }],
    [{ pref: 'zcode', probe: { nodeOk: true, loggedIn: true }, zcodeProbe: { loggedIn: false }, hasApiKey: true }, { backend: 'none', reason: 'zcode-not-logged-in' }],
    [{ pref: 'zcode', probe: { nodeOk: true, loggedIn: true }, zcodeProbe: { loggedIn: true, runtimeOk: false }, hasApiKey: true }, { backend: 'none', reason: 'zcode-runtime-unavailable' }],
    [{ pref: 'zcode', probe: { nodeOk: true, loggedIn: true }, zcodeProbe: { loggedIn: true, runtimeOk: true }, hasApiKey: false }, { backend: 'zcode', reason: 'ok' }],
  ];

  for (const [input, expected] of cases) {
    assert.deepEqual(pickBackend(input), expected);
  }
});

test('deriveToolMeta maps AE tools for Claude Agent SDK metadata', () => {
  const meta = deriveToolMeta([
    { name: 'overview', annotations: { readOnlyHint: true } },
    { name: 'deleteLayer', annotations: { destructiveHint: true } },
    { name: 'newText' },
  ]);

  assert.deepEqual(meta.allowedTools, ['mcp__ae__overview']);
  assert.deepEqual(meta.annotations, {
    mcp__ae__overview: { readOnly: true, destructive: false },
    mcp__ae__deleteLayer: { readOnly: false, destructive: true },
    mcp__ae__newText: { readOnly: false, destructive: false },
  });
});

test('shouldResetOnBackendChange ignores none and resets only on real backend changes', () => {
  const run = (sequence) => {
    let prevReal = null;
    const resets = [];
    for (const next of sequence) {
      const decision = shouldResetOnBackendChange(prevReal, next);
      if (decision.nextReal) prevReal = decision.nextReal;
      if (decision.reset) resets.push(next);
    }
    return resets;
  };

  assert.deepEqual(run(['subscription', 'none', 'subscription']), []);
  assert.deepEqual(run(['subscription', 'none', 'byok']), ['byok']);
  assert.deepEqual(run(['subscription', 'none', 'codex']), ['codex']);
  assert.deepEqual(run(['codex', 'none', 'codex']), []);
  assert.deepEqual(run(['codex', 'byok']), ['byok']);
  assert.deepEqual(run(['none', 'subscription']), []);
  assert.deepEqual(run(['none', 'byok', 'subscription']), ['subscription']);
});
