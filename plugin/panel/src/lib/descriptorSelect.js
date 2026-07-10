// Pure descriptor selection (spec A2/D): given the EFFECTIVE backend from
// pickBackend (not the raw pref -- backendPref never equals 'byok') and the
// per-channel provider/model facts, pick the composer descriptor. Kept as a
// lib pure function so the branch logic is unit-testable outside React.
import {
  byokStaticDescriptor,
  mergeByokModels,
  codexStaticDescriptor,
  codexDescriptorFromModels,
  descriptorWithCustomModel,
  descriptorFromProbedModels,
  zcodeDescriptorFromModels,
  zcodeDescriptorFromProbedModels,
} from './backendCapabilities.js';

// effectiveBackend 'byok' = API channel chosen but Node runtime broken; the
// fetch-based loop serves the same API channel, so it shares the branch.
export function isClaudeApiBackend(effectiveBackend) {
  return effectiveBackend === 'claude-api' || effectiveBackend === 'byok';
}

export function selectDescriptor({
  effectiveBackend = 'none',
  effectiveChannel = null,
  backendPref = 'subscription',
  baseDescriptor,
  customModel = '',
  claudeApiProvider = null,
  codexCustomProvider = null,
  customProviderCredentialResolverReady = false,
  byokApiModels = null,
  codexCachedModels = null,
  zcodeSessionModels = null,
  zcodeProbedModels = null,
}) {
  const claudeApi = isClaudeApiBackend(effectiveBackend);
  const customId = (claudeApi || backendPref === 'codex') ? String(customModel || '').trim() : '';
  if (claudeApi) {
    if (claudeApiProvider && claudeApiProvider.probedModels && claudeApiProvider.probedModels.length) {
      return descriptorWithCustomModel(descriptorFromProbedModels(byokStaticDescriptor(), claudeApiProvider.probedModels), customId);
    }
    if (byokApiModels) {
      return descriptorWithCustomModel(mergeByokModels(byokStaticDescriptor(), byokApiModels), customId);
    }
    return baseDescriptor;
  }
  if (backendPref === 'codex') {
    const customProviderFactsAllowed = effectiveChannel === 'custom'
      && customProviderCredentialResolverReady === true;
    if (customProviderFactsAllowed
        && codexCustomProvider
        && codexCustomProvider.probedModels
        && codexCustomProvider.probedModels.length) {
      return descriptorWithCustomModel(descriptorFromProbedModels(codexStaticDescriptor(), codexCustomProvider.probedModels), customId);
    }
    if (codexCachedModels) {
      return descriptorWithCustomModel(codexDescriptorFromModels({ models: codexCachedModels }), customId);
    }
    return baseDescriptor;
  }
  // ZCode: the live model list only becomes known after session/create
  // returns settings.model.available (see zcodeBackend.js's
  // 'zcode-session-created' event). Session data wins when it actually
  // enumerates a choice (>1 model). Custom openai-compatible providers have
  // no session-side enumeration: probeAccount's session/create on panel load
  // returns a TRUTHY result whose available list is empty or only names the
  // current model, and that thin result must NOT mask the probe-driven
  // fallback (zcodeProbedModels, /v1/models via App.jsx) — that truthiness
  // gate was the "still locked with a fresh 16-model cache" bug. Precedence:
  // rich session list > probed models > thin session list > baseDescriptor.
  // Gated on backendPref (not just effectiveBackend) so probing states
  // ('zcode-probing' etc, where effectiveBackend may read as 'none') still
  // pick up data as soon as it's available.
  if (backendPref === 'zcode' || effectiveBackend === 'zcode') {
    // Count the RAW enumeration, not the derived descriptor's models:
    // zcodeDescriptorFromModels substitutes the static 2-model builtin list
    // when available is empty, which must not pass for a real enumeration.
    const available = zcodeSessionModels && zcodeSessionModels.settings && zcodeSessionModels.settings.model && Array.isArray(zcodeSessionModels.settings.model.available)
      ? zcodeSessionModels.settings.model.available
      : [];
    if (available.length > 1) return zcodeDescriptorFromModels(zcodeSessionModels);
    if (zcodeProbedModels) {
      const probed = zcodeDescriptorFromProbedModels(zcodeProbedModels);
      if (probed) return probed;
    }
    if (zcodeSessionModels) return zcodeDescriptorFromModels(zcodeSessionModels);
    return baseDescriptor;
  }
  return baseDescriptor;
}

// Bug 2: a stale localStorage model id (e.g. a pre-migration hardcoded
// 'glm-5.2') can silently outrank a freshly-computed descriptor's
// defaultModelId when the stored id isn't among the descriptor's current
// models. Reset to defaultModelId in that case. Custom model ids (isCustom)
// are exempt: they are intentionally NOT part of the curated list.
export function reconcileModelPref(model, descriptor, { isCustom = false } = {}) {
  if (isCustom) return model;
  const models = (descriptor && Array.isArray(descriptor.models)) ? descriptor.models : [];
  if (!models.length) return model;
  const trimmed = String(model || '').trim();
  if (trimmed && models.some((m) => m.id === trimmed)) return trimmed;
  return descriptor.defaultModelId;
}
