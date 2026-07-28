export const COMPOSER_MIN_HEIGHT = 72;
export const COMPOSER_DEFAULT_HEIGHT = 96;
export const COMPOSER_KEYBOARD_STEP = 24;
export const MIN_TRANSCRIPT_HEIGHT = 120;
export const MAX_COMPOSER_RATIO = 0.6;
export const FALLBACK_MAX_HEIGHT = 320;

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

export function composerMaxHeight(availableHeight) {
  if (!finitePositive(availableHeight)) return FALLBACK_MAX_HEIGHT;
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
  return availableHeight > 0 ? availableHeight : null;
}

export function createComposerHeightState(availableHeight) {
  const maxHeight = composerMaxHeight(availableHeight);
  return {
    height: clampComposerHeight(COMPOSER_DEFAULT_HEIGHT, maxHeight),
    maxHeight,
  };
}

export function reduceComposerHeight(state, action) {
  if (action?.type === 'measure') {
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
