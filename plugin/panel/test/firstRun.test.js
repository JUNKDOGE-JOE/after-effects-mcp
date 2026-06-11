import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWizardDone, markWizardDone } from '../src/cep/firstRun.js';

test('isWizardDone returns false when storage has no marker', () => {
  const storage = { getItem: () => null };
  assert.equal(isWizardDone(storage), false);
});

test('markWizardDone stores the wizard marker', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k), setItem: (k, v) => mem.set(k, v) };
  markWizardDone(storage);
  assert.equal(isWizardDone(storage), true);
});
