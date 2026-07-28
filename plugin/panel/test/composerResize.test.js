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
  createComposerDragSession,
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

test('a measured panel shorter than fixed footer chrome clamps to the minimum', () => {
  const availableHeight = composerAvailableHeight({
    containerHeight: 80,
    footerHeight: 160,
    composerHeight: 72,
  });
  assert.equal(availableHeight, 0);
  assert.equal(composerMaxHeight(availableHeight), 72);

  const measured = reduceComposerHeight(
    { height: 300, maxHeight: FALLBACK_MAX_HEIGHT },
    { type: 'measure', availableHeight },
  );
  assert.deepEqual(measured, { height: 72, maxHeight: 72 });
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

test('drag session reports direction and stops after mouseup', () => {
  const requests = [];
  const session = createComposerDragSession({
    startY: 300,
    startHeight: 96,
    onRequest: (height) => requests.push(height),
  });
  assert.equal(session.move({ clientY: 250 }), true);
  assert.equal(session.move({ clientY: 340 }), true);
  assert.equal(session.move({}), false);
  assert.deepEqual(requests, [146, 56]);
  assert.equal(session.finish(), true);
  assert.equal(session.finish(), false);
  assert.equal(session.move({ clientY: 200 }), false);
  session.cancel();
});

test('drag session cancellation is idempotent', () => {
  const session = createComposerDragSession({
    startY: 100,
    startHeight: 96,
    onRequest() {},
  });
  assert.doesNotThrow(() => session.cancel());
  assert.doesNotThrow(() => session.cancel());
  assert.equal(session.move({ clientY: 90 }), false);
});
