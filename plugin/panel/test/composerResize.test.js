import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPOSER_DEFAULT_HEIGHT,
  COMPOSER_KEYBOARD_STEP,
  COMPOSER_MIN_HEIGHT,
  FALLBACK_MAX_HEIGHT,
  MIN_LAYOUT_HEIGHT,
  MIN_TRANSCRIPT_HEIGHT,
  clampComposerHeight,
  composerAvailableHeight,
  composerKeyboardRequest,
  composerMaxHeight,
  createComposerHeightState,
  createComposerDragSession,
  isMeasurableLayout,
  reduceComposerHeight,
} from '../src/lib/composerResize.js';

test('composer bounds preserve the transcript in compact and tall panels', () => {
  assert.equal(composerMaxHeight(null), FALLBACK_MAX_HEIGHT);
  assert.equal(composerMaxHeight(MIN_LAYOUT_HEIGHT), COMPOSER_MIN_HEIGHT);
  assert.equal(composerMaxHeight(400), 240);
  assert.equal(composerMaxHeight(800), 480);
  assert.equal(clampComposerHeight(Number.NaN, 480), COMPOSER_DEFAULT_HEIGHT);
  assert.equal(clampComposerHeight(20, 480), COMPOSER_MIN_HEIGHT);
  assert.equal(clampComposerHeight(900, 480), 480);
});

test('the floor seats a full textarea line and equals the default', () => {
  // Regression for the ~8px composer: 72px could not hold the third row, and
  // a floor below the default would let the panel re-open at an unusable size.
  assert.equal(COMPOSER_MIN_HEIGHT, 96);
  assert.equal(COMPOSER_DEFAULT_HEIGHT, COMPOSER_MIN_HEIGHT);
  assert.equal(MIN_LAYOUT_HEIGHT, MIN_TRANSCRIPT_HEIGHT + COMPOSER_MIN_HEIGHT);
});

test('measurements the settled layout cannot produce are dropped, not clamped to', () => {
  // Taken while the footer is still taller than the container, which happens on
  // mount before layout settles. Acting on it is what pinned the composer shut.
  const availableHeight = composerAvailableHeight({
    containerHeight: 80,
    footerHeight: 160,
    composerHeight: 96,
  });
  // Small and positive, which is the dangerous shape: it looks like a real
  // measurement, so every guard that only rejects zero and NaN lets it through.
  assert.equal(availableHeight, 16);
  assert.equal(isMeasurableLayout(availableHeight), false);
  assert.equal(isMeasurableLayout(MIN_LAYOUT_HEIGHT - 1), false);
  assert.equal(isMeasurableLayout(MIN_LAYOUT_HEIGHT), true);
  assert.equal(isMeasurableLayout(null), false);

  const before = { height: 300, maxHeight: FALLBACK_MAX_HEIGHT };
  assert.equal(
    reduceComposerHeight(before, { type: 'measure', availableHeight }),
    before,
  );
});

test('a degenerate startup measurement does not latch the composer shut', () => {
  // The reported failure: mount measures before layout settles, the composer
  // clamps to the floor, and every later measurement re-clamps that floor
  // because a shrink is never resurrected. It must never reach state at all.
  let state = createComposerHeightState();
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 30 });
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: null });
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 800 });
  assert.deepEqual(state, { height: COMPOSER_DEFAULT_HEIGHT, maxHeight: 480 });
});

test('a height the user dragged to survives a transient bad measurement', () => {
  let state = createComposerHeightState(800);
  state = reduceComposerHeight(state, { type: 'request', height: 300 });
  assert.equal(state.height, 300);
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 12 });
  assert.equal(state.height, 300);
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 800 });
  assert.equal(state.height, 300);
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
  // A real shrink -- the user dragged the panel smaller, not a startup artifact.
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 400 });
  assert.deepEqual(state, { height: 240, maxHeight: 240 });
  state = reduceComposerHeight(state, { type: 'measure', availableHeight: 800 });
  assert.deepEqual(state, { height: 240, maxHeight: 480 });
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
