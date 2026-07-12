import { probeProviderModels } from '../cep/modelProbe.js';
import { probeProviderCapabilities } from '../cep/providerDetect.js';
import {
  normalizeProviderEntryV3,
  unknownProviderProtocolCapability,
  unknownProviderAgentFeatures,
} from '../lib/providerProfile.js';

const MODEL_LIST_TTL_MS = 3_600_000;
const DEFAULT_CAPABILITY_TTL_MS = 86_400_000;
const PROBE_REQUEST_TIMEOUT_MS = 30_000;
const PROTOCOLS = ['responses', 'chat', 'messages'];
const SUPPORTED_EVIDENCE = Object.freeze({
  responses: new Set(['responses-success-schema', 'responses-incomplete-schema']),
  chat: new Set(['chat-success-schema', 'chat-length-schema']),
  messages: new Set(['messages-success-schema', 'messages-max-tokens-schema']),
});
const AGENT_FEATURE_KEYS = Object.freeze([
  'compact',
  'continuation',
  'countTokens',
  'namespaceTools',
  'reasoningReplay',
  'stream',
  'terminal',
  'tools',
]);
const AGENT_FEATURE_STATUSES = new Set(['unknown', 'supported', 'unsupported']);
const APPLICABLE_AGENT_FEATURES = Object.freeze({
  responses: new Set(['compact', 'continuation', 'namespaceTools', 'stream', 'terminal', 'tools']),
  chat: new Set(['stream', 'terminal', 'tools']),
  messages: new Set(['countTokens', 'stream', 'terminal', 'tools']),
});

function storeConflict() {
  const error = new Error('Provider store revision conflict');
  error.code = 'PROVIDER_STORE_CONFLICT';
  return error;
}

function persistEntry(entry, store, expectedRevision) {
  if (!store) return { entry, stateRevision: null };
  return store.upsert(entry, { expectedRevision });
}

function effectiveProbeApiRoot(provider) {
  return provider?.modelList?.status === 'supported'
    && typeof provider.modelList.apiRoot === 'string'
    && provider.modelList.apiRoot.trim()
    ? provider.modelList.apiRoot
    : provider.baseUrl;
}

function profileAdapter(provider) {
  return {
    ...provider,
    baseUrl: effectiveProbeApiRoot(provider),
    protocol: provider.probePreference === 'messages' ? 'anthropic' : 'openai-compatible',
    authProfileRevision: provider.requestProfileRevision,
  };
}

function wrappedResolver(provider, resolveRequestProfile) {
  return async (_adapter, options) => {
    const apiRoot = options?.apiRoot || effectiveProbeApiRoot(provider);
    const profile = await resolveRequestProfile(provider, {
      ...options,
      apiRoot,
    });
    return {
      ...profile,
      baseUrl: apiRoot,
      authProfileRevision: provider.requestProfileRevision,
    };
  };
}

function safeExpiry(checkedAt, maxAgeMs) {
  const age = Number.isFinite(maxAgeMs) && maxAgeMs > 0
    ? maxAgeMs
    : DEFAULT_CAPABILITY_TTL_MS;
  return Math.min(Number.MAX_SAFE_INTEGER, checkedAt + age);
}

function metadataStringList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))].sort();
}

function modelMetadata(value) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const task = typeof metadata.task === 'string' && metadata.task.trim()
    ? metadata.task.trim()
    : null;
  return {
    task,
    inputModalities: metadataStringList(metadata.inputModalities),
    outputModalities: metadataStringList(metadata.outputModalities),
    capabilities: metadataStringList(metadata.capabilities),
  };
}

function modelInventory(models, inventory) {
  const records = new Map();
  const ingest = (raw, preferMetadata) => {
    const id = String(raw?.id || '').trim();
    const label = String(raw?.label || id).trim();
    if (!id || !label) return;
    const previous = records.get(id);
    records.set(id, {
      id,
      label: label || previous?.label || id,
      metadata: preferMetadata || !previous
        ? modelMetadata(raw.metadata)
        : previous.metadata,
    });
  };
  for (const raw of Array.isArray(models) ? models : []) ingest(raw, false);
  for (const raw of Array.isArray(inventory) ? inventory : []) ingest(raw, true);
  const output = Array.from(records.values());
  output.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return output;
}

function authChoice(provider, scheme, scope) {
  if (!['none', 'bearer', 'x-api-key', 'custom'].includes(scheme)) return null;
  let headerName = null;
  if (scheme === 'custom') {
    const policy = scope === 'probe' && provider.probeAuthOverride
      ? provider.probeAuthOverride
      : provider.credential.preferredAuth;
    const configuredScheme = policy.kind || policy.scheme;
    headerName = configuredScheme === 'custom' ? policy.headerName : null;
    if (!headerName) return null;
  }
  return { scheme, headerName };
}

function apiRootForProvider(provider, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const apiRoot = new URL(value.trim());
    return apiRoot.origin === new URL(provider.baseUrl).origin
      ? apiRoot.toString().replace(/\/$/, '')
      : null;
  } catch {
    return null;
  }
}

function modelListFromProbe(provider, result, checkedAt) {
  if (!result?.ok || !result.apiRoot || !result.authScheme || checkedAt <= 0) return null;
  const auth = authChoice(provider, result.authScheme, 'probe');
  const apiRoot = apiRootForProvider(provider, result.apiRoot);
  const models = modelInventory(result.models, result.inventory);
  if (!apiRoot || !auth || models.length === 0) return null;
  const identity = JSON.stringify({ apiRoot, auth, models });
  const currentIdentity = provider.modelList.status === 'supported'
    ? JSON.stringify({
      apiRoot: provider.modelList.apiRoot,
      auth: provider.modelList.auth,
      models: provider.modelList.models,
    })
    : '';
  const revision = identity === currentIdentity && provider.modelList.revision > 0
    ? provider.modelList.revision
    : provider.modelList.revision + 1;
  return {
    revision,
    status: 'supported',
    apiRoot,
    auth,
    models,
    checkedAt,
    validUntil: safeExpiry(checkedAt, MODEL_LIST_TTL_MS),
    requestProfileRevision: provider.requestProfileRevision,
  };
}

function modelListProbeFromMatrix(matrix) {
  const probe = matrix?.modelListProbe;
  if (!probe || probe.status !== 'supported') return null;
  return {
    ok: true,
    apiRoot: probe.apiRoot,
    authScheme: probe.authScheme,
    models: probe.models,
    inventory: probe.inventory,
  };
}

function compatibility(protocol, raw) {
  if (protocol === 'responses') {
    return { instructionMode: 'responses-instructions', tokenField: 'max_output_tokens' };
  }
  if (protocol === 'messages') {
    return { instructionMode: 'messages-system', tokenField: 'max_tokens' };
  }
  const instructionRole = raw?.compatibility?.instructionRole;
  const tokenField = raw?.compatibility?.tokenField;
  if (!['developer', 'system'].includes(instructionRole)
      || !['max_tokens', 'max_completion_tokens'].includes(tokenField)) {
    return null;
  }
  return { instructionMode: `chat-${instructionRole}`, tokenField };
}

function exactFeatureObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === AGENT_FEATURE_KEYS.length
    && keys.every((key, index) => key === AGENT_FEATURE_KEYS[index]);
}

function featureEvidenceStem(protocol, feature) {
  if (feature === 'stream' || feature === 'terminal') return `${protocol}-stream`;
  if (feature === 'tools') return `${protocol}-tool`;
  if (feature === 'namespaceTools') return `${protocol}-namespace-tools`;
  if (feature === 'countTokens') return `${protocol}-count-tokens`;
  if (feature === 'reasoningReplay') return `${protocol}-reasoning-replay`;
  return `${protocol}-${feature}`;
}

function validAgentFeatureEvidence(protocol, feature, status, evidence) {
  if (typeof evidence !== 'string' || !evidence) return false;
  if (status === 'unknown') {
    if (evidence === 'not-probed') return true;
    const stem = featureEvidenceStem(protocol, feature);
    return [`${stem}-network`, `${stem}-authentication`, `${stem}-transient`].includes(evidence);
  }
  if (!APPLICABLE_AGENT_FEATURES[protocol].has(feature)) return false;
  const stem = featureEvidenceStem(protocol, feature);
  if (status === 'unsupported') {
    return evidence === `${stem}-rejected`
      || ((feature === 'stream' || feature === 'terminal')
        && evidence === `${protocol}-stream-terminal-invalid`);
  }
  if (feature === 'stream' || feature === 'terminal') {
    return evidence === `${protocol}-stream-terminal-valid`;
  }
  if (feature === 'tools') return evidence === `${protocol}-tool-call-valid`;
  return evidence === `${stem}-valid`;
}

function mappedAgentFeatures(protocol, raw) {
  if (!exactFeatureObject(raw?.agentFeatures)
      || !exactFeatureObject(raw?.agentFeatureEvidence)) return null;
  const output = {};
  for (const feature of AGENT_FEATURE_KEYS) {
    const status = raw.agentFeatures[feature];
    const evidence = raw.agentFeatureEvidence[feature];
    if (!AGENT_FEATURE_STATUSES.has(status)
        || !validAgentFeatureEvidence(protocol, feature, status, evidence)) return null;
    output[feature] = status;
  }
  if (output.stream !== output.terminal
      || raw.agentFeatureEvidence.stream !== raw.agentFeatureEvidence.terminal) return null;
  return output;
}

function priorCapability(provider, modelId, protocol, modelListRevision, observedAt) {
  const prior = provider.modelCapabilities.find((entry) => entry.modelId === modelId)?.[protocol];
  if (!prior || prior.status === 'unknown') return null;
  if (prior.requestProfileRevision !== provider.requestProfileRevision
      || prior.modelListRevision !== modelListRevision
      || prior.checkedAt > observedAt
      || (prior.validUntil !== null && prior.validUntil < observedAt)) {
    return null;
  }
  return prior;
}

function stableUnsupportedEvidence(errorClass) {
  if (errorClass === 'endpoint-unsupported') return 'endpoint-unsupported';
  if (errorClass === 'protocol-unsupported' || errorClass === 'model-unsupported') {
    return 'model-protocol-unsupported';
  }
  return null;
}

function mappedCapability(provider, modelId, protocol, raw, modelListRevision, observedAt) {
  const prior = priorCapability(provider, modelId, protocol, modelListRevision, observedAt);
  if (!raw || typeof raw !== 'object') {
    return prior || unknownProviderProtocolCapability({
      requestProfileRevision: provider.requestProfileRevision,
      modelListRevision,
    });
  }
  const auth = authChoice(provider, raw.authScheme, 'model');
  const apiRoot = apiRootForProvider(provider, raw.apiRoot);
  if (raw.support === 'supported') {
    const requestCompatibility = compatibility(protocol, raw);
    const evidence = typeof raw.schema?.evidence === 'string' ? raw.schema.evidence : null;
    const agentFeatures = mappedAgentFeatures(protocol, raw);
    const effectiveAgentFeatures = agentFeatures && prior?.status === 'supported'
      ? Object.fromEntries(AGENT_FEATURE_KEYS.map((feature) => [
        feature,
        agentFeatures[feature] === 'unknown'
          ? prior.agentFeatures[feature]
          : agentFeatures[feature],
      ]))
      : agentFeatures;
    const maxAgeMs = raw.ttl?.maxAgeMs;
    if (apiRoot && auth && requestCompatibility && effectiveAgentFeatures
        && SUPPORTED_EVIDENCE[protocol].has(evidence)
        && Number.isFinite(maxAgeMs) && maxAgeMs > 0) {
      return {
        status: 'supported',
        apiRoot,
        auth,
        compatibility: requestCompatibility,
        agentFeatures: effectiveAgentFeatures,
        checkedAt: observedAt,
        validUntil: safeExpiry(observedAt, maxAgeMs),
        requestProfileRevision: provider.requestProfileRevision,
        modelListRevision,
        evidence,
      };
    }
    return null;
  }
  if (raw.support === 'unsupported' && raw.ttl?.class === 'unsupported') {
    const evidence = stableUnsupportedEvidence(raw.errorClass);
    const agentFeatures = mappedAgentFeatures(protocol, raw);
    if (apiRoot && auth && evidence && agentFeatures) {
      return {
        status: 'unsupported',
        apiRoot,
        auth,
        compatibility: null,
        agentFeatures: unknownProviderAgentFeatures(),
        checkedAt: observedAt,
        validUntil: null,
        requestProfileRevision: provider.requestProfileRevision,
        modelListRevision,
        evidence,
      };
    }
    return null;
  }
  return prior || unknownProviderProtocolCapability({
    requestProfileRevision: provider.requestProfileRevision,
    modelListRevision,
  });
}

function entryWithMatrix(provider, matrix) {
  const observedAt = matrix.observedAt;
  if (!Number.isFinite(observedAt) || observedAt <= 0) return null;
  const probedModelList = modelListFromProbe(
    provider,
    modelListProbeFromMatrix(matrix),
    observedAt,
  );
  const modelList = probedModelList || provider.modelList;
  const modelId = String(matrix.modelId || '').trim();
  if (!modelId || !matrix.capabilities || typeof matrix.capabilities !== 'object') return null;
  const mapped = {
    modelId,
    responses: mappedCapability(
      provider, modelId, 'responses', matrix.capabilities.responses, modelList.revision, observedAt,
    ),
    chat: mappedCapability(
      provider, modelId, 'chat', matrix.capabilities.chat, modelList.revision, observedAt,
    ),
    messages: mappedCapability(
      provider, modelId, 'messages', matrix.capabilities.messages, modelList.revision, observedAt,
    ),
  };
  if (PROTOCOLS.some((protocol) => mapped[protocol] === null)) return null;
  const record = mapped;
  const previous = provider.modelCapabilities.find((entry) => entry.modelId === modelId) || null;
  const hasKnowledge = PROTOCOLS.some((protocol) => record[protocol].status !== 'unknown');
  const modelCapabilities = previous || hasKnowledge
    ? [
      ...provider.modelCapabilities.filter((entry) => entry.modelId !== modelId),
      record,
    ]
    : provider.modelCapabilities;
  return normalizeProviderEntryV3({
    ...provider,
    modelList,
    modelCapabilities,
  });
}

function probeFailureReason(result) {
  if (result?.status === 401 || result?.status === 403) return 'authentication';
  if (!result?.status) return 'network';
  return 'path-unsupported';
}

function retryableCapabilityMatrix(matrix) {
  if (!matrix || !matrix.capabilities || typeof matrix.capabilities !== 'object') {
    return false;
  }
  const retryableClasses = new Set(['network', 'rate-limited', 'upstream-transient']);
  return PROTOCOLS.some((protocol) => {
    const capability = matrix.capabilities[protocol];
    if (capability?.support === 'transient' && retryableClasses.has(capability.errorClass)) return true;
    if (capability?.support !== 'supported') return false;
    return ['stream', 'terminal', 'tools'].some((feature) => (
      capability.agentFeatures?.[feature] === 'unknown'
      && /-(?:network|transient)$/.test(String(capability.agentFeatureEvidence?.[feature] || ''))
    ));
  });
}

function generateCapabilityAvailable(record) {
  return PROTOCOLS.some((protocol) => {
    const capability = record?.[protocol];
    return (capability?.support || capability?.status) === 'supported'
      && ['stream', 'terminal', 'tools'].every(
        (feature) => capability.agentFeatures?.[feature] === 'supported',
      );
  });
}

export async function runProviderManagerProbe(provider, {
  store = null,
  modelId,
  forceDetect = false,
  resolveRequestProfile,
  probeProviderModelsImpl = probeProviderModels,
  probeProviderCapabilitiesImpl = probeProviderCapabilities,
  now = Date.now,
} = {}) {
  const normalized = normalizeProviderEntryV3(provider);
  const selectedModelId = typeof modelId === 'string' ? modelId.trim() : '';
  if (forceDetect === true && !selectedModelId) {
    return {
      ok: false,
      reason: 'configuration',
      detail: 'Provider capability detection needs a model id',
    };
  }
  if (typeof resolveRequestProfile !== 'function') {
    return { ok: false, reason: 'configuration', detail: 'Provider request profile resolver is unavailable' };
  }
  if (store && (
    typeof store.readState !== 'function'
    || typeof store.get !== 'function'
    || typeof store.upsert !== 'function'
  )) {
    return { ok: false, reason: 'configuration', detail: 'Provider store is unavailable' };
  }
  const expectedRevision = store ? store.readState().revision : undefined;
  if (store) {
    const current = store.get(normalized.id);
    if (!current || JSON.stringify(normalizeProviderEntryV3(current)) !== JSON.stringify(normalized)) {
      throw storeConflict();
    }
  }

  if (!selectedModelId) {
    let requestProfile = null;
    try {
      requestProfile = await resolveRequestProfile(normalized, { scope: 'probe' });
      const result = await probeProviderModelsImpl({
        requestProfile,
        protocol: normalized.probePreference === 'messages' ? 'anthropic' : 'openai-compatible',
      });
      if (!result?.ok) {
        return {
          ok: false,
          reason: probeFailureReason(result),
          detail: result?.detail || 'Provider model probe failed',
          result,
        };
      }
      const checkedAt = typeof now === 'function' ? now() : Date.now();
      const modelList = modelListFromProbe(normalized, result, checkedAt);
      if (!modelList) {
        return { ok: false, reason: 'configuration', detail: 'Provider model probe result is invalid', result };
      }
      const entry = normalizeProviderEntryV3({ ...normalized, modelList });
      const persisted = persistEntry(entry, store, expectedRevision);
      return { ok: true, entry: persisted.entry, stateRevision: persisted.stateRevision, result };
    } finally {
      requestProfile = null;
    }
  }

  const probeOptions = {
    provider: profileAdapter(normalized),
    modelId: selectedModelId,
    resolveRequestProfile: wrappedResolver(normalized, resolveRequestProfile),
    timeoutMs: PROBE_REQUEST_TIMEOUT_MS,
    now,
  };
  let matrix = await probeProviderCapabilitiesImpl(probeOptions);
  let matrixAttempts = 1;
  while (
    matrixAttempts < 3
    && String(matrix?.modelId || '').trim() === selectedModelId
    && retryableCapabilityMatrix(matrix)
  ) {
    matrix = await probeProviderCapabilitiesImpl(probeOptions);
    matrixAttempts += 1;
  }
  if (String(matrix?.modelId || '').trim() !== selectedModelId) {
    return {
      ok: false,
      reason: 'configuration',
      detail: 'Provider capability detection returned a different model id',
      result: matrix,
    };
  }
  const entry = entryWithMatrix(normalized, matrix);
  if (!entry) {
    return {
      ok: false,
      reason: matrix?.reason || 'configuration',
      detail: matrix?.detail || 'Provider capability detection failed',
      result: matrix,
    };
  }
  const changed = JSON.stringify(entry) !== JSON.stringify(normalized);
  const persisted = changed
    ? persistEntry(entry, store, expectedRevision)
    : { entry, stateRevision: null };
  const ready = generateCapabilityAvailable(
    entry.modelCapabilities.find((record) => record.modelId === selectedModelId),
  );
  return {
    ok: ready,
    ...(!ready ? {
      reason: matrix.reason || 'capability-incompatible',
      detail: matrix.detail || 'Provider did not expose a verified agent-ready protocol',
    } : {}),
    entry: persisted.entry,
    stateRevision: persisted.stateRevision,
    result: matrix,
    capabilities: matrix.capabilities,
    preferredProtocol: matrix.preferredProtocol || null,
  };
}
