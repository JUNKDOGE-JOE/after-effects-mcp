export const OPEN_CODE_DEFAULT_CONTEXT_WINDOW = 128000;
export const OPEN_CODE_CONTEXT_WINDOW_MIN = 32000;
export const OPEN_CODE_CONTEXT_WINDOW_MAX = 2000000;
export const OPEN_CODE_CONTEXT_WINDOW_PRESETS = Object.freeze([
  32000,
  64000,
  OPEN_CODE_DEFAULT_CONTEXT_WINDOW,
  200000,
]);

export function normalizeOpenCodeContextWindow(value, {
  fallback = OPEN_CODE_DEFAULT_CONTEXT_WINDOW,
} = {}) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback
    : Number(value);
  if (!Number.isSafeInteger(candidate)
      || candidate < OPEN_CODE_CONTEXT_WINDOW_MIN
      || candidate > OPEN_CODE_CONTEXT_WINDOW_MAX) {
    throw new RangeError(
      `Context window must be an integer from ${OPEN_CODE_CONTEXT_WINDOW_MIN} to ${OPEN_CODE_CONTEXT_WINDOW_MAX} tokens`,
    );
  }
  return candidate;
}

// Reserve at most one quarter of the context for a response. Advertising a
// 32K output limit on a 32K context makes OpenCode consider every request
// already full and compact continuously.
export function openCodeOutputLimit(contextWindow) {
  const context = normalizeOpenCodeContextWindow(contextWindow);
  return Math.min(32000, Math.max(4000, Math.floor(context / 4)));
}

export function openCodeContextPresetValue(value) {
  return typeof value === 'number' && OPEN_CODE_CONTEXT_WINDOW_PRESETS.includes(value)
    ? String(value)
    : 'custom';
}
