// Cache for probe-driven ZCode model discovery (spec: custom openai-compatible
// providers where session/create's settings.model.available comes back
// empty). Probing /v1/models on every session/create is wasteful and adds
// latency, so the result is cached in localStorage with a 1 hour TTL.
export const ZCODE_PROBED_MODELS_CACHE_KEY = 'ae_mcp_zcode_probed_models';
export const ZCODE_PROBED_MODELS_CACHE_MS = 60 * 60 * 1000; // 1 hour

export function readCachedZcodeProbedModels(storage) {
  try {
    const raw = storage.getItem(ZCODE_PROBED_MODELS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.probedModels)) return null;
    if (Date.now() - Number(parsed.probedAt || 0) > ZCODE_PROBED_MODELS_CACHE_MS) return null;
    return { cliModel: String(parsed.cliModel || ''), providerId: String(parsed.providerId || ''), probedModels: parsed.probedModels };
  } catch (e) {
    return null;
  }
}

export function writeCachedZcodeProbedModels(storage, { cliModel, providerId, probedModels } = {}) {
  try {
    storage.setItem(ZCODE_PROBED_MODELS_CACHE_KEY, JSON.stringify({
      cliModel: String(cliModel || ''),
      providerId: String(providerId || ''),
      probedModels: Array.isArray(probedModels) ? probedModels : [],
      probedAt: Date.now(),
    }));
  } catch (e) {
    // best-effort
  }
}
