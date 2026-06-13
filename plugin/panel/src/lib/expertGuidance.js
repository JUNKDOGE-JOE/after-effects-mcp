// Pure localStorage helpers for the "AE expert anti-error guidance" toggle.
// Kept out of App.jsx so `node --test` (which cannot parse JSX) can import them.
// Semantics mirror the server default: the key being absent means ON; only the
// literal '0' disables the guidance.
const EXPERT_GUIDANCE_KEY = 'ae-mcp.expertGuidance';

export function loadExpertGuidance(storage) {
  try {
    return storage.getItem(EXPERT_GUIDANCE_KEY) !== '0';
  } catch (e) {
    return true; // default ON when storage is unavailable
  }
}

export function saveExpertGuidance(storage, on) {
  try {
    storage.setItem(EXPERT_GUIDANCE_KEY, on ? '1' : '0');
  } catch (e) {
    /* best-effort persistence */
  }
}
