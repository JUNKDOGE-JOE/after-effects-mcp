import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBeforeUnloadReset } from '../src/lib/backendLifecycle.js';

function makeTarget() {
  const listeners = new Map();
  const added = [];
  const removed = [];
  return {
    listeners,
    added,
    removed,
    addEventListener(type, listener) {
      added.push({ type, listener });
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      removed.push({ type, listener });
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
}

test('beforeunload resets the backend once and unregisters its listener', () => {
  const target = makeTarget();
  let resets = 0;
  const dispose = installBeforeUnloadReset(target, {
    reset() { resets += 1; },
  });

  assert.equal(target.added.length, 1);
  assert.equal(target.added[0].type, 'beforeunload');
  target.listeners.get('beforeunload')();

  assert.equal(resets, 1);
  assert.equal(target.listeners.has('beforeunload'), false);
  assert.equal(target.removed.length, 1);
  dispose();
  assert.equal(resets, 1);
});

test('React cleanup removes the listener and resets the backend once', () => {
  const target = makeTarget();
  let resets = 0;
  const dispose = installBeforeUnloadReset(target, {
    reset() { resets += 1; },
  });

  dispose();
  dispose();

  assert.equal(resets, 1);
  assert.equal(target.listeners.has('beforeunload'), false);
  assert.equal(target.removed.length, 1);
});

test('cleanup still resets when an event target is unavailable', () => {
  let resets = 0;
  const dispose = installBeforeUnloadReset(null, {
    reset() { resets += 1; },
  });

  dispose();
  assert.equal(resets, 1);
});
