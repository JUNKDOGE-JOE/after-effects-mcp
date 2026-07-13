import {
  effectiveProviderDialect as selectEffectiveProviderDialect,
  normalizeBaseUrl,
} from '../lib/providerProfile.js';
import { probeProviderCapabilities } from './providerCapabilityProbe.js';

export const effectiveProviderDialect = selectEffectiveProviderDialect;
export { probeProviderCapabilities } from './providerCapabilityProbe.js';

function legacyFailure(matrix) {
  const legacy = [matrix.capabilities?.responses, matrix.capabilities?.chat].filter(Boolean);
  if (legacy.length === 2 && legacy.every((capability) => capability.support === 'authentication')) {
    return { reason: 'authentication', detail: 'Provider rejected the resolved model profile' };
  }
  if (legacy.some((capability) => capability.support === 'transient')) {
    return { reason: 'network', detail: 'Network or transient error while probing provider wire API' };
  }
  return {
    reason: 'dialect-incompatible',
    detail: 'Provider did not expose a verified Responses or Chat API',
  };
}

export async function detectProviderDialect(options = {}) {
  if (options.provider?.protocol !== 'openai-compatible') {
    return {
      ok: false,
      reason: 'configuration',
      detail: 'Provider dialect detection is not configured',
      preferredProtocol: null,
      preferredProtocolEvidence: 'none-supported',
      models: [],
      inventory: [],
      tried: [],
    };
  }
  const matrix = await probeProviderCapabilities(options);
  if (!matrix.capabilities) return matrix;
  const selected = matrix.capabilities.responses?.support === 'supported'
    ? matrix.capabilities.responses
    : matrix.capabilities.chat?.support === 'supported'
      ? matrix.capabilities.chat
      : null;
  if (!selected) {
    const failure = legacyFailure(matrix);
    return { ...matrix, ok: false, ...failure };
  }
  const modelId = String(options.modelId || '').trim();
  const wireApi = selected.protocol;
  return {
    ...matrix,
    ok: true,
    dialect: {
      modelId,
      wireApi,
      baseUrl: normalizeBaseUrl(options.provider?.baseUrl),
      authProfileRevision: options.provider?.authProfileRevision,
      detectedAt: matrix.observedAt,
      evidence: wireApi === 'responses' ? 'responses-success-schema' : 'chat-success-schema',
    },
  };
}
