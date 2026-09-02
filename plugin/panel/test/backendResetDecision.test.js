import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideBackendReset } from '../src/lib/backendResetDecision.js';

test('same-backend probe jitter does not reset the active backend', () => {
  const pending = decideBackendReset({
    lastReal: 'codex',
    effective: 'none',
    selectedPref: 'codex',
    pendingSessionLoad: null,
  });
  assert.deepEqual(pending, { reset: false, nextReal: 'codex' });
  assert.deepEqual(decideBackendReset({
    lastReal: pending.nextReal,
    effective: 'codex',
    selectedPref: 'codex',
    pendingSessionLoad: null,
  }), { reset: false, nextReal: 'codex' });
});

test('a genuine backend change resets after the target probe succeeds', () => {
  const pending = decideBackendReset({
    lastReal: 'codex',
    effective: 'none',
    selectedPref: 'opencode',
    pendingSessionLoad: null,
  });
  assert.deepEqual(pending, { reset: false, nextReal: 'codex' });
  assert.deepEqual(decideBackendReset({
    lastReal: pending.nextReal,
    effective: 'opencode',
    selectedPref: 'opencode',
    pendingSessionLoad: null,
  }), { reset: true, nextReal: 'opencode' });
});

test('a session target waiting for its probe advances the real backend without resetting', () => {
  const pending = decideBackendReset({
    lastReal: 'subscription',
    effective: 'none',
    selectedPref: 'codex',
    pendingSessionLoad: 'chat-codex',
  });
  assert.deepEqual(pending, { reset: false, nextReal: 'codex' });
  assert.deepEqual(decideBackendReset({
    lastReal: pending.nextReal,
    effective: 'codex',
    selectedPref: 'codex',
    pendingSessionLoad: 'chat-codex',
  }), { reset: false, nextReal: 'codex' });
});

test('a pending session load suppresses reset and therefore cannot create a replacement session', () => {
  assert.deepEqual(decideBackendReset({
    lastReal: 'subscription',
    effective: 'codex',
    selectedPref: 'codex',
    pendingSessionLoad: 'chat-codex',
  }), { reset: false, nextReal: 'codex' });
});
