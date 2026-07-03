import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND_EVENTS } from '../src/cep/backends/contract.js';
import { BACKENDS, REAL_BACKENDS, baseDescriptorFor } from '../src/cep/backends/index.js';

test('contract event vocabulary is the frozen canonical set', () => {
  assert.ok(Object.isFrozen(BACKEND_EVENTS));
  // v0.6.0 live-acceptance additions that every backend must speak.
  assert.ok(BACKEND_EVENTS.includes('tool-allowed'));
  assert.ok(BACKEND_EVENTS.includes('tool-denied'));
  assert.ok(BACKEND_EVENTS.includes('thinking'));
  for (const e of ['turn-start', 'text-delta', 'tool-start', 'tool-result', 'approval-required', 'turn-end', 'error']) {
    assert.ok(BACKEND_EVENTS.includes(e), 'missing ' + e);
  }
});

test('registry exposes the real embedded backends', () => {
  assert.deepEqual(REAL_BACKENDS, ['subscription', 'byok', 'claude-api', 'codex', 'opencode', 'zcode']);
  for (const id of REAL_BACKENDS) {
    assert.equal(BACKENDS[id].id, id);
    assert.equal(typeof BACKENDS[id].baseDescriptor, 'function');
  }
});

test('every registered backend yields a conformant descriptor', () => {
  // The descriptor contract a new backend (OpenCode, …) must satisfy so the
  // chips/settings render with zero hardcoding.
  const expectedModelSwitching = {
    subscription: true,
    byok: true,
    'claude-api': true,
    codex: true,
    opencode: true,
    zcode: false,
  };
  for (const id of REAL_BACKENDS) {
    const d = baseDescriptorFor(id);
    assert.ok(Array.isArray(d.models) && d.models.length > 0, id + ' models');
    assert.ok(d.defaultModelId, id + ' defaultModelId');
    assert.ok(Array.isArray(d.approvalModes) && d.approvalModes.length === 4, id + ' approvalModes');
    assert.equal(typeof d.supportsFast, 'function', id + ' supportsFast');
    assert.equal(typeof d.perTurnModelSwitch, 'boolean', id + ' perTurnModelSwitch');
    assert.equal(d.perTurnModelSwitch, expectedModelSwitching[id], id + ' perTurnModelSwitch');
    for (const m of d.models) {
      assert.ok(m.id && m.label, id + ' model id/label');
      assert.ok(Array.isArray(m.effortLevels), id + ' effortLevels');
    }
  }
});

test('baseDescriptorFor falls back to subscription for an unknown id', () => {
  const d = baseDescriptorFor('nope');
  assert.equal(d.id, 'claude-sub');
});
