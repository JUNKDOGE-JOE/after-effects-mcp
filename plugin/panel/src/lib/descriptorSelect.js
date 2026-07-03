// Pure descriptor selection (spec A2/D): given the EFFECTIVE backend from
// pickBackend (not the raw pref -- backendPref never equals 'byok') and the
// per-channel provider/model facts, pick the composer descriptor. Kept as a
// lib pure function so the branch logic is unit-testable outside React.
import {
  byokStaticDescriptor,
  mergeByokModels,
  codexStaticDescriptor,
  codexDescriptorFromModels,
  openCodeDescriptorFromModels,
  descriptorWithCustomModel,
  descriptorFromProbedModels,
} from './backendCapabilities.js';

// effectiveBackend 'byok' = API channel chosen but Node runtime broken; the
// fetch-based loop serves the same API channel, so it shares the branch.
export function isClaudeApiBackend(effectiveBackend) {
  return effectiveBackend === 'claude-api' || effectiveBackend === 'byok';
}

export function selectDescriptor({
  effectiveBackend = 'none',
  backendPref = 'subscription',
  baseDescriptor,
  customModel = '',
  claudeApiProvider = null,
  codexCustomProvider = null,
  byokApiModels = null,
  codexCachedModels = null,
  openCodeCachedModels = null,
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
    if (codexCustomProvider && codexCustomProvider.probedModels && codexCustomProvider.probedModels.length) {
      return descriptorWithCustomModel(descriptorFromProbedModels(codexStaticDescriptor(), codexCustomProvider.probedModels), customId);
    }
    if (codexCachedModels) {
      return descriptorWithCustomModel(codexDescriptorFromModels({ models: codexCachedModels }), customId);
    }
    return baseDescriptor;
  }
  if (backendPref === 'opencode' && openCodeCachedModels) {
    return openCodeDescriptorFromModels(openCodeCachedModels);
  }
  return baseDescriptor;
}
