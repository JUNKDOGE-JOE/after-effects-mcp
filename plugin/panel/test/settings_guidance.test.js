import { test } from 'node:test';
import assert from 'node:assert/strict';
// App.jsx pulls in React + CEP globals and contains JSX that `node --test`
// cannot parse, so the localStorage helpers live in a tiny pure lib module
// (re-exported from App.jsx for app code). Import them from the lib here.
import { loadExpertGuidance, saveExpertGuidance } from '../src/lib/expertGuidance.js';

function mem() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
  };
}

test('expert guidance defaults ON when unset', () => {
  assert.equal(loadExpertGuidance(mem()), true);
});

test('expert guidance round-trips OFF', () => {
  const s = mem();
  saveExpertGuidance(s, false);
  assert.equal(loadExpertGuidance(s), false);
});

test('expert guidance round-trips ON', () => {
  const s = mem();
  saveExpertGuidance(s, true);
  assert.equal(loadExpertGuidance(s), true);
});

test('only the literal "0" disables; other truthy strings stay ON', () => {
  const s = mem();
  s.setItem('ae-mcp.expertGuidance', '1');
  assert.equal(loadExpertGuidance(s), true);
});

test('loadExpertGuidance defaults ON when storage throws', () => {
  const throwing = { getItem() { throw new Error('no storage'); } };
  assert.equal(loadExpertGuidance(throwing), true);
});

test('saveExpertGuidance swallows storage errors', () => {
  const throwing = { setItem() { throw new Error('no storage'); } };
  assert.doesNotThrow(() => saveExpertGuidance(throwing, false));
});
