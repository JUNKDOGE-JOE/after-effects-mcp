export const LEGACY_MODEL_PREF_KEY = 'ae_mcp_model';

const MODEL_PREF_KEYS = Object.freeze({
  subscription: 'ae_mcp_model_subscription',
  codex: 'ae_mcp_model_codex',
  opencode: 'ae_mcp_model_opencode',
});

export function modelPreferenceKey(channel) {
  return MODEL_PREF_KEYS[channel] || MODEL_PREF_KEYS.subscription;
}

function nonEmpty(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

export function resolveModelPreference({ channelValue, legacyValue, fallback } = {}) {
  const current = nonEmpty(channelValue);
  const legacy = nonEmpty(legacyValue);
  return {
    value: current || legacy || fallback,
    migrateLegacy: !current && Boolean(legacy),
  };
}
