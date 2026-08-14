// The composer is three stacked rows -- attachment pond, chips/status, textarea.
// The first two plus padding and gaps occupy about 64px, so a 72px floor left
// the textarea roughly 8px tall: present, and impossible to type in. 96 is the
// smallest height that leaves the textarea a full line. That makes the floor
// equal to the default, so the composer can be dragged taller, never shorter.
export const COMPOSER_MIN_HEIGHT = 96;
export const COMPOSER_DEFAULT_HEIGHT = 96;
export const COMPOSER_KEYBOARD_STEP = 24;
export const MIN_TRANSCRIPT_HEIGHT = 120;
export const MAX_COMPOSER_RATIO = 0.6;
export const FALLBACK_MAX_HEIGHT = 320;

// Below this the layout cannot seat a usable composer and a readable transcript
// at the same time. The CSXS manifest's MinSize keeps the panel above it, so a
// measurement under this is not a small panel -- it is a measurement taken
// before layout settled. Believing one is what used to pin the composer shut.
export const MIN_LAYOUT_HEIGHT = MIN_TRANSCRIPT_HEIGHT + COMPOSER_MIN_HEIGHT;

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

export function composerMaxHeight(availableHeight) {
  if (!Number.isFinite(availableHeight)) return FALLBACK_MAX_HEIGHT;
  if (availableHeight <= 0) return COMPOSER_MIN_HEIGHT;
  return Math.max(
    COMPOSER_MIN_HEIGHT,
    Math.min(
      availableHeight - MIN_TRANSCRIPT_HEIGHT,
      Math.floor(availableHeight * MAX_COMPOSER_RATIO),
    ),
  );
}

export function clampComposerHeight(height, maxHeight) {
  const legalMax = Math.max(
    COMPOSER_MIN_HEIGHT,
    finitePositive(maxHeight) ? maxHeight : FALLBACK_MAX_HEIGHT,
  );
  const requested = Number.isFinite(height) ? height : COMPOSER_DEFAULT_HEIGHT;
  return Math.min(Math.max(requested, COMPOSER_MIN_HEIGHT), legalMax);
}

export function composerAvailableHeight({
  containerHeight,
  footerHeight,
  composerHeight,
}) {
  if (![containerHeight, footerHeight, composerHeight].every(Number.isFinite)) return null;
  if (containerHeight <= 0 || footerHeight < 0 || composerHeight <= 0) return null;
  const fixedFooterHeight = Math.max(0, footerHeight - composerHeight);
  const availableHeight = containerHeight - fixedFooterHeight;
  return Math.max(0, availableHeight);
}

export function createComposerHeightState(availableHeight) {
  const maxHeight = composerMaxHeight(availableHeight);
  return {
    height: clampComposerHeight(COMPOSER_DEFAULT_HEIGHT, maxHeight),
    maxHeight,
  };
}

// A measured shrink is honoured and does not spring back when the panel grows
// again -- resurrecting a height the user last saw at a different size is worse
// than leaving it where they left it. That only holds for measurements the
// layout could actually produce, though. Anything under MIN_LAYOUT_HEIGHT is
// startup noise, and clamping to it is permanent precisely because of the
// no-resurrect rule, so those are dropped before they can reach state.
export function isMeasurableLayout(availableHeight) {
  return Number.isFinite(availableHeight) && availableHeight >= MIN_LAYOUT_HEIGHT;
}

export function reduceComposerHeight(state, action) {
  if (action?.type === 'measure') {
    if (!isMeasurableLayout(action.availableHeight)) return state;
    const maxHeight = composerMaxHeight(action.availableHeight);
    return { height: clampComposerHeight(state.height, maxHeight), maxHeight };
  }
  if (action?.type === 'request') {
    return {
      height: clampComposerHeight(action.height, state.maxHeight),
      maxHeight: state.maxHeight,
    };
  }
  if (action?.type === 'reset') {
    return {
      height: clampComposerHeight(COMPOSER_DEFAULT_HEIGHT, state.maxHeight),
      maxHeight: state.maxHeight,
    };
  }
  return state;
}

export function composerKeyboardRequest(eventLike, currentHeight) {
  if (eventLike?.shiftKey !== true) return null;
  if (eventLike.key === 'ArrowUp') return currentHeight + COMPOSER_KEYBOARD_STEP;
  if (eventLike.key === 'ArrowDown') return currentHeight - COMPOSER_KEYBOARD_STEP;
  return null;
}

export function createComposerDragSession({
  startY,
  startHeight,
  onRequest,
}) {
  let active = true;

  function move(eventLike) {
    if (!active || !Number.isFinite(eventLike?.clientY)) return false;
    onRequest(startHeight + (startY - eventLike.clientY));
    return true;
  }

  function finish() {
    if (!active) return false;
    active = false;
    return true;
  }

  function cancel() {
    if (!active) return;
    active = false;
  }

  return Object.freeze({ move, finish, cancel });
}
