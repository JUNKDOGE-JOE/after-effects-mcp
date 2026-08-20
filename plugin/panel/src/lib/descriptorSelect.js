// Select the composer descriptor from the effective backend and per-channel
// model facts. Kept pure so it can be tested outside React.
import {
  codexStaticDescriptor,
  codexDescriptorFromModels,
  mergeCodexOfficialLoginModels,
  openCodeDescriptorFromModels,
} from './backendCapabilities.js';

export function selectDescriptor({
  effectiveBackend = 'none',
  backendPref = 'subscription',
  baseDescriptor,
  codexCachedModels = null,
  openCodeProviders = [],
}) {
  if (backendPref === 'codex' || effectiveBackend === 'codex') {
    if (codexCachedModels) {
      return mergeCodexOfficialLoginModels(
        codexDescriptorFromModels({ models: codexCachedModels }),
      );
    }
    return mergeCodexOfficialLoginModels(baseDescriptor || codexStaticDescriptor());
  }
  if (backendPref === 'opencode' || effectiveBackend === 'opencode') {
    const providers = {};
    for (const provider of openCodeProviders || []) {
      if (!provider || provider.needsApiKey === true) continue;
      providers[provider.id] = {
        id: provider.id,
        name: provider.name,
        models: Object.fromEntries(
          (provider.modelIds || []).map((modelId) => [modelId, { name: modelId }]),
        ),
      };
    }
    return Object.keys(providers).length
      ? openCodeDescriptorFromModels(providers)
      : baseDescriptor;
  }
  return baseDescriptor;
}

// A persisted model id can outlive its provider catalog and otherwise outrank
// a freshly computed descriptor's default model. Reset to the descriptor's
// default when the stored model is not still selectable.
export function reconcileModelPref(model, descriptor, { providerFactsPending = false } = {}) {
  if (providerFactsPending) return model;
  const models = Array.isArray(descriptor?.models) ? descriptor.models : [];
  if (!models.length) return model;
  const current = String(model || '').trim();
  if (current && models.some((item) => item.id === current)) return current;
  return descriptor.defaultModelId;
}
