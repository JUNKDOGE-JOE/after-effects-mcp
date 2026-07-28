import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSER_DEFAULT_HEIGHT,
  COMPOSER_KEYBOARD_STEP,
  FALLBACK_MAX_HEIGHT,
  clampComposerHeight,
  composerAvailableHeight,
  composerKeyboardRequest,
  composerMaxHeight,
  createComposerHeightState,
  createComposerPointerSession,
  reduceComposerHeight,
} from '../src/lib/composerResize.js';

test('composer bounds preserve the transcript in compact and tall panels', () => {
  assert.equal(composerMaxHeight(null), FALLBACK_MAX_HEIGHT);
  assert.equal(composerMaxHeight(160), 72);
  assert.equal(composerMaxHeight(200), 80);
  assert.equal(composerMaxHeight(800), 480);
  assert.equal(clampComposerHeight(Number.NaN, 480), COMPOSER_DEFAULT_HEIGHT);
  assert.equal(clampComposerHeight(20, 480), 72);
  assert.equal(clampComposerHeight(900, 480), 480);
});

test('footer chrome is removed from the shared transcript and input allocation', () => {
  assert.equal(composerAvailableHeight({
    containerHeight: 400,
    footerHeight: 160,
    composerHeight: 96,
  }), 336);
  assert.equal(composerAvailableHeight({
    containerHeight: 0,
    footerHeight: 160,
    composerHeight: 96,
  }), null);
});

test('session reducer clamps on shrink and does not resurrect an old height', () => {
  let state = createComposerHeightState();
  assert.deepEqual(state, { height: 96, maxHeight: 320 });
  state = reduceComposerHeight(state, { type: 'request', height: 300 });
  assert.equal(state.height, 300);
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 200 });
  assert.deepEqual(state, { height: 80, maxHeight: 80 });
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 800 });
  assert.deepEqual(state, { height: 80, maxHeight: 480 });
  state = reduceComposerHeight(state, { type: 'reset' });
  assert.equal(state.height, COMPOSER_DEFAULT_HEIGHT);
  assert.equal(createComposerHeightState().height, COMPOSER_DEFAULT_HEIGHT);
});

test('only shifted vertical arrows request one keyboard step', () => {
  assert.equal(
    composerKeyboardRequest({ key: 'ArrowUp', shiftKey: true }, 96),
    96 + COMPOSER_KEYBOARD_STEP,
  );
  assert.equal(
    composerKeyboardRequest({ key: 'ArrowDown', shiftKey: true }, 96),
    96 - COMPOSER_KEYBOARD_STEP,
  );
  assert.equal(composerKeyboardRequest({ key: 'ArrowUp', shiftKey: false }, 96), null);
  assert.equal(composerKeyboardRequest({ key: 'Enter', shiftKey: true }, 96), null);
});

test('pointer session captures, reports direction, ignores other pointers, and cleans up', () => {
  const captured = new Set();
  const released = [];
  const target = {
    setPointerCapture(pointerId) { captured.add(pointerId); },
    hasPointerCapture(pointerId) { return captured.has(pointerId); },
    releasePointerCapture(pointerId) {
      captured.delete(pointerId);
      released.push(pointerId);
    },
  };
  const requests = [];
  const session = createComposerPointerSession({
    target,
    pointerId: 7,
    startY: 300,
    startHeight: 96,
    onRequest: (height) => requests.push(height),
  });
  assert.equal(captured.has(7), true);
  assert.equal(session.move({ pointerId: 8, clientY: 200 }), false);
  assert.equal(session.move({ pointerId: 7, clientY: 250 }), true);
  assert.equal(session.move({ pointerId: 7, clientY: 340 }), true);
  assert.deepEqual(requests, [146, 56]);
  assert.equal(session.finish({ pointerId: 7 }, true), true);
  assert.deepEqual(released, [7]);
  assert.equal(session.move({ pointerId: 7, clientY: 200 }), false);
  session.cancel();
  assert.deepEqual(released, [7]);
});

test('lost capture ends a drag without attempting a second release', () => {
  const target = {
    setPointerCapture() {},
    hasPointerCapture() { return true; },
    releasePointerCapture() { throw new Error('must not release after lost capture'); },
  };
  const session = createComposerPointerSession({
    target,
    pointerId: 4,
    startY: 100,
    startHeight: 96,
    onRequest() {},
  });
  assert.equal(session.finish({ pointerId: 4 }, false), true);
  assert.equal(session.move({ pointerId: 4, clientY: 90 }), false);
});

test('unmount cleanup tolerates capture disappearing during release', () => {
  const target = {
    setPointerCapture() {},
    hasPointerCapture() { return true; },
    releasePointerCapture() { throw new Error('capture already gone'); },
  };
  const session = createComposerPointerSession({
    target,
    pointerId: 9,
    startY: 100,
    startHeight: 96,
    onRequest() {},
  });
  assert.doesNotThrow(() => session.cancel());
});
