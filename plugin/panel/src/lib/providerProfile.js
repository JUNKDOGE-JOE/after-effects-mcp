import { parseProviderSecretReference } from '../cep/platform/secret-reference.js';
import {
  isCredentialShapedProviderLiteral,
  isReservedProviderExtraHeaderName,
  isSensitiveProviderHeaderName,
} from './providerHeaderPolicy.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CODEX_PROVIDER_ID = 'ae_mcp_custom';
export const CODEX_PROVIDER_API_KEY_ENV = 'AE_MCP_CODEX_API_KEY';
export const PROVIDER_DIALECT_MAX_AGE_MS = 86_400_000;
const RESERVED_CODEX_PROVIDER_IDS = new Set(['openai', 'amazon-bedrock', 'ollama', 'lmstudio']);
const PROVIDER_ENTRY_KEYS = [
  'allowInsecureHttp',
  'auth',
  'authProfileRevision',
  'baseUrl',
  'credentialId',
  'dialect',
  'headers',
  'id',
  'name',
  'probedAt',
  'probedModels',
  'protocol',
];
const AUTH_KEYS = ['model', 'probe'];
const HEADER_KEYS = ['id', 'name', 'scopes', 'valueRef'];
const SECRET_VALUE_REF_KEYS = ['kind', 'reference', 'revision'];
const LITERAL_VALUE_REF_KEYS = ['kind', 'value'];
const DIALECT_KEYS = ['detected', 'override'];
const DIALECT_OVERRIDE_KEYS = ['source', 'updatedAt', 'wireApi'];
const LEGACY_DIALECT_DETECTED_KEYS = ['authProfileRevision', 'baseUrl', 'detectedAt', 'evidence', 'wireApi'];
const DIALECT_DETECTED_KEYS = ['authProfileRevision', 'baseUrl', 'detectedAt', 'evidence', 'modelId', 'wireApi'];
const PROBED_MODEL_KEYS = ['id', 'label'];
const PROVIDER_SCOPES = new Set(['probe', 'model']);
const PROVIDER_PROTOCOLS = new Set(['openai-compatible', 'anthropic']);
const WIRE_APIS = new Set(['responses', 'chat']);
const PROVIDER_WIRE_PROTOCOLS_V3 = new Set(['responses', 'chat', 'messages']);
const PROVIDER_CLIENTS_V3 = new Set(['codex', 'claude-code']);
const PROVIDER_AUTH_SCHEMES_V3 = new Set(['none', 'bearer', 'x-api-key', 'custom']);
const PROVIDER_PREFERRED_AUTH_SCHEMES_V3 = new Set(['auto', ...PROVIDER_AUTH_SCHEMES_V3]);
const PROVIDER_CAPABILITY_STATUSES_V3 = new Set(['unknown', 'supported', 'unsupported']);
const PROVIDER_CAPABILITY_UNSUPPORTED_EVIDENCE_V3 = new Set([
  'endpoint-unsupported',
  'model-protocol-unsupported',
  'conversion-unsupported',
]);
const PROVIDER_CAPABILITY_SUPPORTED_EVIDENCE_V3 = Object.freeze({
  responses: new Set(['responses-success-schema', 'responses-incomplete-schema']),
  chat: new Set(['chat-success-schema', 'chat-length-schema']),
  messages: new Set(['messages-success-schema', 'messages-max-tokens-schema']),
});
const PROVIDER_ENTRY_KEYS_V3 = [
  'allowInsecureHttp',
  'baseUrl',
  'credential',
  'credentialId',
  'headers',
  'id',
  'modelCapabilities',
  'modelList',
  'name',
  'probeAuthOverride',
  'probePreference',
  'requestProfileRevision',
  'routeOverrides',
];
const PROVIDER_CREDENTIAL_KEYS_V3 = ['preferredAuth', 'valueRef'];
const PROVIDER_AUTH_CHOICE_KEYS_V3 = ['headerName', 'scheme'];
const PROVIDER_MODEL_LIST_KEYS_V3 = [
  'apiRoot',
  'auth',
  'checkedAt',
  'models',
  'requestProfileRevision',
  'revision',
  'status',
  'validUntil',
];
const PROVIDER_MODEL_CAPABILITY_KEYS_V3 = ['chat', 'messages', 'modelId', 'responses'];
const PROVIDER_PROTOCOL_CAPABILITY_KEYS_V3 = [
  'agentFeatures',
  'apiRoot',
  'auth',
  'checkedAt',
  'compatibility',
  'evidence',
  'modelListRevision',
  'requestProfileRevision',
  'status',
  'validUntil',
];
const PROVIDER_AGENT_FEATURE_KEYS_V3 = [
  'compact',
  'continuation',
  'countTokens',
  'namespaceTools',
  'reasoningReplay',
  'stream',
  'terminal',
  'tools',
];
const PROVIDER_AGENT_FEATURE_STATUSES_V3 = new Set(['unknown', 'supported', 'unsupported']);
const PROVIDER_COMPATIBILITY_KEYS_V3 = ['instructionMode', 'tokenField'];
const PROVIDER_ROUTE_OVERRIDE_KEYS_V3 = ['client', 'modelId', 'protocol', 'updatedAt'];
const PROVIDER_MODEL_LIST_MODEL_KEYS_V3 = ['id', 'label', 'metadata'];
const PROVIDER_MODEL_METADATA_KEYS_V3 = [
  'capabilities',
  'inputModalities',
  'outputModalities',
  'task',
];
const DIALECT_SOURCES = new Set(['manual', 'legacy-v0.9', 'ccswitch-import']);
const VERIFIED_DIALECT_EVIDENCE = Object.freeze({
  responses: 'responses-success-schema',
  chat: 'chat-success-schema',
});
const LEGACY_DIALECT_EVIDENCE = new Set([
  'models-capability',
  'responses-success-schema',
  'responses-missing-input',
  'chat-success-schema',
  'chat-missing-messages',
  'chat-missing-messages-500-compat',
]);
const SECRET_LIKE_PATH_LITERAL = /(?:Bearer\s+\S{8,}|Basic\s+\S{8,}|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})/i;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_PERCENT_DECODE_LAYERS = 3;
const CREDENTIAL_PATH_LABELS = new Set([
  'accesstoken',
  'apikey',
  'authtoken',
  'clientsecret',
  'credential',
  'credentials',
  'passwd',
  'password',
  'xapikey',
]);

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function isLoopbackProviderHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = mapped ? mapped[1] : host;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4);
}

function decodePercentRuns(value) {
  return String(value).replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
}

function pathContainsCredential(value) {
  let current = String(value || '');
  for (let layer = 0; layer <= MAX_PERCENT_DECODE_LAYERS; layer += 1) {
    if (SECRET_LIKE_PATH_LITERAL.test(current) || isCredentialShapedProviderLiteral(current)) return true;
    const segments = current.split('/').filter(Boolean);
    for (let index = 0; index + 1 < segments.length; index += 1) {
      const label = segments[index].toLowerCase().replace(/[^a-z0-9]/g, '');
      const candidate = segments[index + 1];
      if (CREDENTIAL_PATH_LABELS.has(label) && !/^v\d+(?:\.\d+)*$/i.test(candidate)) return true;
    }
    const decoded = decodePercentRuns(current);
    if (decoded === current) break;
    current = decoded;
  }
  return false;
}

export function validateProviderBaseUrl(value, {
  allowInsecureHttp = false,
  requireTransportApproval = false,
} = {}) {
  const raw = String(value || '').trim();
  let url;
  try { url = new URL(raw); } catch { throw providerProfileError(); }
  const schemeMarker = raw.indexOf('://');
  let hasRawUserInfo = true;
  if (schemeMarker >= 0) {
    const authorityStart = schemeMarker + 3;
    const delimiters = ['/', '?', '#']
      .map((delimiter) => raw.indexOf(delimiter, authorityStart))
      .filter((index) => index >= 0);
    const authorityEnd = delimiters.length ? Math.min(...delimiters) : raw.length;
    hasRawUserInfo = raw.slice(authorityStart, authorityEnd).includes('@');
  }
  if (
    !['http:', 'https:'].includes(url.protocol)
    || schemeMarker < 0
    || raw.includes('?')
    || raw.includes('#')
    || hasRawUserInfo
    || url.username
    || url.password
    || url.hash
    || url.search
    || pathContainsCredential(url.pathname)
  ) {
    throw providerProfileError();
  }
  if (
    requireTransportApproval
    && url.protocol === 'http:'
    && !isLoopbackProviderHostname(url.hostname)
    && allowInsecureHttp !== true
  ) {
    throw providerProfileError('provider_insecure_http_forbidden');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function providerProfileError(code = 'provider_profile_invalid') {
  const error = new Error(
    code === 'provider_header_secret_reference_required'
      ? 'Provider header requires a secret reference'
      : 'Provider profile is invalid',
  );
  error.code = code;
  return error;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function requireExactObject(value, expected) {
  if (!hasExactKeys(value, expected)) throw providerProfileError();
  return value;
}

function requireText(value) {
  if (typeof value !== 'string') throw providerProfileError();
  const text = value.trim();
  if (!text) throw providerProfileError();
  return text;
}

function requireTimestamp(value) {
  if (!Number.isFinite(value) || value < 0) throw providerProfileError();
  return value;
}

function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw providerProfileError();
  return value;
}

function hasVerifiedDialectEvidence(entry) {
  return VERIFIED_DIALECT_EVIDENCE[entry?.wireApi] === entry?.evidence;
}

function normalizeCredentialId(value) {
  if (typeof value !== 'string') throw providerProfileError();
  try {
    return parseProviderSecretReference(`aemcp-secret://provider/${value}/a/v1`).providerId;
  } catch {
    throw providerProfileError();
  }
}

function normalizeSecretValueRef(value, credentialId) {
  requireExactObject(value, SECRET_VALUE_REF_KEYS);
  if (value.kind !== 'secret') throw providerProfileError();
  let parsed;
  try {
    parsed = parseProviderSecretReference(value.reference);
  } catch {
    throw providerProfileError();
  }
  if (parsed.providerId !== credentialId) throw providerProfileError();
  return {
    kind: 'secret',
    reference: value.reference,
    revision: requireRevision(value.revision),
  };
}

function normalizeHeaderName(value) {
  const name = requireText(value);
  if (!HEADER_NAME.test(name)) throw providerProfileError();
  return name;
}

function normalizeAuthPolicy(value, credentialId, allowInherit = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerProfileError();
  if (allowInherit && value.kind === 'inherit-model') {
    requireExactObject(value, ['kind']);
    return { kind: 'inherit-model' };
  }
  if (value.kind === 'none') {
    requireExactObject(value, ['kind']);
    return { kind: 'none' };
  }
  if (value.kind === 'bearer' || value.kind === 'x-api-key') {
    requireExactObject(value, ['kind', 'valueRef']);
    return {
      kind: value.kind,
      valueRef: normalizeSecretValueRef(value.valueRef, credentialId),
    };
  }
  if (value.kind === 'custom') {
    requireExactObject(value, ['headerName', 'kind', 'valueRef']);
    return {
      kind: 'custom',
      headerName: normalizeHeaderName(value.headerName),
      valueRef: normalizeSecretValueRef(value.valueRef, credentialId),
    };
  }
  throw providerProfileError();
}

function normalizeHeaderValueRef(value, credentialId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerProfileError();
  if (value.kind === 'literal') {
    requireExactObject(value, LITERAL_VALUE_REF_KEYS);
    if (typeof value.value !== 'string') throw providerProfileError();
    return { kind: 'literal', value: value.value };
  }
  return normalizeSecretValueRef(value, credentialId);
}

function normalizeExtraHeader(value, credentialId) {
  requireExactObject(value, HEADER_KEYS);
  const id = requireText(value.id);
  const name = normalizeHeaderName(value.name);
  if (!Array.isArray(value.scopes) || value.scopes.length === 0) throw providerProfileError();
  const scopes = value.scopes.map((scope) => {
    if (typeof scope !== 'string' || !PROVIDER_SCOPES.has(scope)) throw providerProfileError();
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) throw providerProfileError();
  const valueRef = normalizeHeaderValueRef(value.valueRef, credentialId);
  if (isReservedProviderExtraHeaderName(name)) {
    throw providerProfileError('provider_header_forbidden');
  }
  if (
    valueRef.kind === 'literal'
    && (isSensitiveProviderHeaderName(name) || isCredentialShapedProviderLiteral(valueRef.value))
  ) {
    throw providerProfileError('provider_header_secret_reference_required');
  }
  return { id, name, scopes, valueRef };
}

function normalizeDialect(value) {
  requireExactObject(value, DIALECT_KEYS);
  let override = null;
  if (value.override !== null) {
    requireExactObject(value.override, DIALECT_OVERRIDE_KEYS);
    if (!WIRE_APIS.has(value.override.wireApi) || !DIALECT_SOURCES.has(value.override.source)) {
      throw providerProfileError();
    }
    override = {
      wireApi: value.override.wireApi,
      source: value.override.source,
      updatedAt: requireTimestamp(value.override.updatedAt),
    };
  }

  const normalizeDetected = (entry, { includeModelId = true } = {}) => {
    const keys = includeModelId ? DIALECT_DETECTED_KEYS : LEGACY_DIALECT_DETECTED_KEYS;
    requireExactObject(entry, keys);
    if (
      !WIRE_APIS.has(entry.wireApi)
      || (includeModelId
        ? !hasVerifiedDialectEvidence(entry)
        : !LEGACY_DIALECT_EVIDENCE.has(entry.evidence))
    ) {
      throw providerProfileError();
    }
    return {
      ...(includeModelId ? { modelId: requireText(entry.modelId) } : {}),
      wireApi: entry.wireApi,
      baseUrl: validateProviderBaseUrl(requireText(entry.baseUrl)),
      authProfileRevision: requireRevision(entry.authProfileRevision),
      detectedAt: requireTimestamp(entry.detectedAt),
      evidence: entry.evidence,
    };
  };

  let detected = [];
  if (Array.isArray(value.detected)) {
    detected = value.detected.map((entry) => normalizeDetected(entry));
    const modelIds = new Set();
    for (const entry of detected) {
      if (modelIds.has(entry.modelId)) throw providerProfileError();
      modelIds.add(entry.modelId);
    }
    detected.sort((left, right) => (left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0));
  } else if (value.detected !== null) {
    normalizeDetected(value.detected, { includeModelId: false });
  }
  return { override, detected };
}

function normalizeProbedModel(value) {
  requireExactObject(value, PROBED_MODEL_KEYS);
  return { id: requireText(value.id), label: requireText(value.label) };
}

export function normalizeProviderEntryV2(input) {
  requireExactObject(input, PROVIDER_ENTRY_KEYS);
  const id = requireText(input.id);
  const credentialId = normalizeCredentialId(input.credentialId);
  if (!PROVIDER_PROTOCOLS.has(input.protocol)) throw providerProfileError();
  if (typeof input.allowInsecureHttp !== 'boolean') throw providerProfileError();
  requireExactObject(input.auth, AUTH_KEYS);
  if (!Array.isArray(input.headers) || !Array.isArray(input.probedModels)) throw providerProfileError();

  return {
    id,
    credentialId,
    name: requireText(input.name),
    protocol: input.protocol,
    baseUrl: validateProviderBaseUrl(requireText(input.baseUrl), {
      allowInsecureHttp: input.allowInsecureHttp,
      requireTransportApproval: true,
    }),
    allowInsecureHttp: input.allowInsecureHttp,
    authProfileRevision: requireRevision(input.authProfileRevision),
    auth: {
      model: normalizeAuthPolicy(input.auth.model, credentialId),
      probe: normalizeAuthPolicy(input.auth.probe, credentialId, true),
    },
    headers: input.headers.map((header) => normalizeExtraHeader(header, credentialId)),
    dialect: normalizeDialect(input.dialect),
    probedModels: input.probedModels.map(normalizeProbedModel),
    probedAt: requireTimestamp(input.probedAt),
  };
}

function requireNonnegativeRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw providerProfileError();
  return value;
}

function normalizeAuthChoiceV3(value, { allowAuto = false } = {}) {
  requireExactObject(value, PROVIDER_AUTH_CHOICE_KEYS_V3);
  const allowed = allowAuto ? PROVIDER_PREFERRED_AUTH_SCHEMES_V3 : PROVIDER_AUTH_SCHEMES_V3;
  if (!allowed.has(value.scheme)) throw providerProfileError();
  const headerName = value.headerName === null ? null : normalizeHeaderName(value.headerName);
  if ((value.scheme === 'custom') !== (headerName !== null)) throw providerProfileError();
  return { scheme: value.scheme, headerName };
}

function authChoiceMatchesPreference(choice, preferred) {
  if (preferred.scheme === 'auto') return true;
  if (preferred.scheme === 'none') return choice.scheme === 'none';
  if (preferred.scheme === 'custom') {
    return choice.scheme === 'custom'
      && String(choice.headerName || '').toLowerCase() === String(preferred.headerName || '').toLowerCase();
  }
  return choice.scheme === 'bearer' || choice.scheme === 'x-api-key';
}

function normalizeCredentialV3(value, credentialId) {
  requireExactObject(value, PROVIDER_CREDENTIAL_KEYS_V3);
  const valueRef = value.valueRef === null
    ? null
    : normalizeSecretValueRef(value.valueRef, credentialId);
  const preferredAuth = normalizeAuthChoiceV3(value.preferredAuth, { allowAuto: true });
  if (preferredAuth.scheme === 'none' && valueRef !== null) throw providerProfileError();
  if (!['auto', 'none'].includes(preferredAuth.scheme) && valueRef === null) throw providerProfileError();
  return { valueRef, preferredAuth };
}

function normalizeProbeAuthOverrideV3(value, credentialId) {
  if (value === null) return null;
  const normalized = normalizeAuthPolicy(value, credentialId);
  if (normalized.kind === 'inherit-model') throw providerProfileError();
  return normalized;
}

function authChoiceFromPolicyV3(policy) {
  if (!policy || policy.kind === 'none') return { scheme: 'none', headerName: null };
  return {
    scheme: policy.kind,
    headerName: policy.kind === 'custom' ? policy.headerName : null,
  };
}

function normalizeApiRootV3(value, { baseUrl, allowInsecureHttp }) {
  if (value === null) return null;
  const apiRoot = validateProviderBaseUrl(requireText(value), {
    allowInsecureHttp,
    requireTransportApproval: true,
  });
  if (new URL(apiRoot).origin !== new URL(baseUrl).origin) throw providerProfileError();
  return apiRoot;
}

function normalizeMetadataStringListV3(value) {
  if (!Array.isArray(value)) throw providerProfileError();
  const output = value.map((entry) => requireText(entry));
  if (new Set(output).size !== output.length) throw providerProfileError();
  output.sort();
  return output;
}

function normalizeModelMetadataV3(value) {
  requireExactObject(value, PROVIDER_MODEL_METADATA_KEYS_V3);
  return {
    task: value.task === null ? null : requireText(value.task),
    inputModalities: normalizeMetadataStringListV3(value.inputModalities),
    outputModalities: normalizeMetadataStringListV3(value.outputModalities),
    capabilities: normalizeMetadataStringListV3(value.capabilities),
  };
}

function normalizeModelListEntryV3(value) {
  requireExactObject(value, PROVIDER_MODEL_LIST_MODEL_KEYS_V3);
  return {
    id: requireText(value.id),
    label: requireText(value.label),
    metadata: normalizeModelMetadataV3(value.metadata),
  };
}

function normalizeModelsV3(value) {
  if (!Array.isArray(value)) throw providerProfileError();
  const models = value.map(normalizeModelListEntryV3);
  const ids = new Set();
  for (const model of models) {
    if (ids.has(model.id)) throw providerProfileError();
    ids.add(model.id);
  }
  models.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return models;
}

export function unknownProviderAgentFeatures() {
  return {
    compact: 'unknown',
    continuation: 'unknown',
    countTokens: 'unknown',
    namespaceTools: 'unknown',
    reasoningReplay: 'unknown',
    stream: 'unknown',
    terminal: 'unknown',
    tools: 'unknown',
  };
}

function normalizeAgentFeaturesV3(value, protocolStatus) {
  requireExactObject(value, PROVIDER_AGENT_FEATURE_KEYS_V3);
  const output = {};
  for (const key of PROVIDER_AGENT_FEATURE_KEYS_V3) {
    if (!PROVIDER_AGENT_FEATURE_STATUSES_V3.has(value[key])) throw providerProfileError();
    output[key] = value[key];
  }
  if (protocolStatus === 'unknown' && Object.values(output).some((status) => status !== 'unknown')) {
    throw providerProfileError();
  }
  if (protocolStatus === 'unsupported' && Object.values(output).some((status) => status === 'supported')) {
    throw providerProfileError();
  }
  return output;
}

export function unknownProviderProtocolCapability({
  requestProfileRevision,
  modelListRevision,
} = {}) {
  return {
    status: 'unknown',
    apiRoot: null,
    auth: null,
    compatibility: null,
    agentFeatures: unknownProviderAgentFeatures(),
    checkedAt: 0,
    validUntil: 0,
    requestProfileRevision: requireRevision(requestProfileRevision),
    modelListRevision: requireNonnegativeRevision(modelListRevision),
    evidence: null,
  };
}

function normalizeModelListV3(value, provider) {
  requireExactObject(value, PROVIDER_MODEL_LIST_KEYS_V3);
  if (value.status !== 'unknown' && value.status !== 'supported') throw providerProfileError();
  const revision = requireNonnegativeRevision(value.revision);
  const requestProfileRevision = requireRevision(value.requestProfileRevision);
  const checkedAt = requireTimestamp(value.checkedAt);
  const validUntil = requireTimestamp(value.validUntil);
  const models = normalizeModelsV3(value.models);
  const apiRoot = normalizeApiRootV3(value.apiRoot, provider);
  const auth = value.auth === null ? null : normalizeAuthChoiceV3(value.auth);

  if (value.status === 'unknown') {
    if (
      apiRoot !== null
      || auth !== null
      || checkedAt !== 0
      || validUntil !== 0
      || models.length !== 0
    ) {
      throw providerProfileError();
    }
  } else {
    if (
      revision <= 0
      || apiRoot === null
      || auth === null
      || checkedAt <= 0
      || validUntil < checkedAt
      || models.length === 0
    ) {
      throw providerProfileError();
    }
    const configuredProbeAuth = provider.probeAuthOverride
      ? authChoiceFromPolicyV3(provider.probeAuthOverride)
      : provider.credential.preferredAuth;
    if (!authChoiceMatchesPreference(auth, configuredProbeAuth)) throw providerProfileError();
    if (
      auth.scheme !== 'none'
      && provider.probeAuthOverride === null
      && provider.credential.valueRef === null
    ) {
      throw providerProfileError();
    }
  }
  return {
    revision,
    status: value.status,
    apiRoot,
    auth,
    models,
    checkedAt,
    validUntil,
    requestProfileRevision,
  };
}

function normalizeCompatibilityV3(value, protocol) {
  requireExactObject(value, PROVIDER_COMPATIBILITY_KEYS_V3);
  const instructionMode = value.instructionMode;
  const tokenField = value.tokenField;
  const valid = protocol === 'responses'
    ? instructionMode === 'responses-instructions' && tokenField === 'max_output_tokens'
    : protocol === 'chat'
      ? ['chat-developer', 'chat-system'].includes(instructionMode)
        && ['max_tokens', 'max_completion_tokens'].includes(tokenField)
      : instructionMode === 'messages-system' && tokenField === 'max_tokens';
  if (!valid) throw providerProfileError();
  return { instructionMode, tokenField };
}

function normalizeProtocolCapabilityV3(value, protocol, provider) {
  requireExactObject(value, PROVIDER_PROTOCOL_CAPABILITY_KEYS_V3);
  if (!PROVIDER_CAPABILITY_STATUSES_V3.has(value.status)) throw providerProfileError();
  const agentFeatures = normalizeAgentFeaturesV3(value.agentFeatures, value.status);
  const apiRoot = normalizeApiRootV3(value.apiRoot, provider);
  const auth = value.auth === null ? null : normalizeAuthChoiceV3(value.auth);
  const compatibility = value.compatibility === null
    ? null
    : normalizeCompatibilityV3(value.compatibility, protocol);
  const checkedAt = requireTimestamp(value.checkedAt);
  const validUntil = value.validUntil === null ? null : requireTimestamp(value.validUntil);
  const requestProfileRevision = requireRevision(value.requestProfileRevision);
  const modelListRevision = requireNonnegativeRevision(value.modelListRevision);
  const evidence = value.evidence === null ? null : requireText(value.evidence);

  if (value.status === 'unknown') {
    if (
      apiRoot !== null
      || auth !== null
      || compatibility !== null
      || evidence !== null
      || checkedAt !== 0
      || validUntil !== 0
    ) {
      throw providerProfileError();
    }
  } else {
    if (
      apiRoot === null
      || auth === null
      || checkedAt <= 0
      || (value.status === 'supported' && (validUntil === null || validUntil < checkedAt))
      || (value.status === 'unsupported' && validUntil !== null)
      || (provider.credential.valueRef === null && auth.scheme !== 'none')
    ) {
      throw providerProfileError();
    }
    if (!authChoiceMatchesPreference(auth, provider.credential.preferredAuth)) {
      throw providerProfileError();
    }
    if (value.status === 'supported') {
      if (
        compatibility === null
        || !PROVIDER_CAPABILITY_SUPPORTED_EVIDENCE_V3[protocol].has(evidence)
      ) {
        throw providerProfileError();
      }
    } else if (
      compatibility !== null
      || !PROVIDER_CAPABILITY_UNSUPPORTED_EVIDENCE_V3.has(evidence)
    ) {
      throw providerProfileError();
    }
  }
  return {
    status: value.status,
    apiRoot,
    auth,
    compatibility,
    agentFeatures,
    checkedAt,
    validUntil,
    requestProfileRevision,
    modelListRevision,
    evidence,
  };
}

function normalizeModelCapabilityV3(value, provider) {
  requireExactObject(value, PROVIDER_MODEL_CAPABILITY_KEYS_V3);
  return {
    modelId: requireText(value.modelId),
    responses: normalizeProtocolCapabilityV3(value.responses, 'responses', provider),
    chat: normalizeProtocolCapabilityV3(value.chat, 'chat', provider),
    messages: normalizeProtocolCapabilityV3(value.messages, 'messages', provider),
  };
}

function normalizeRouteOverrideV3(value) {
  requireExactObject(value, PROVIDER_ROUTE_OVERRIDE_KEYS_V3);
  if (!PROVIDER_CLIENTS_V3.has(value.client) || !PROVIDER_WIRE_PROTOCOLS_V3.has(value.protocol)) {
    throw providerProfileError();
  }
  const updatedAt = requireTimestamp(value.updatedAt);
  if (updatedAt <= 0) throw providerProfileError();
  return {
    client: value.client,
    modelId: requireText(value.modelId),
    protocol: value.protocol,
    updatedAt,
  };
}

export function normalizeProviderEntryV3(input) {
  requireExactObject(input, PROVIDER_ENTRY_KEYS_V3);
  const id = requireText(input.id);
  const credentialId = normalizeCredentialId(input.credentialId);
  const baseUrl = validateProviderBaseUrl(requireText(input.baseUrl), {
    allowInsecureHttp: input.allowInsecureHttp,
    requireTransportApproval: true,
  });
  if (typeof input.allowInsecureHttp !== 'boolean') throw providerProfileError();
  if (!Array.isArray(input.headers) || !Array.isArray(input.modelCapabilities)
      || !Array.isArray(input.routeOverrides)) {
    throw providerProfileError();
  }
  if (input.probePreference !== null && !PROVIDER_WIRE_PROTOCOLS_V3.has(input.probePreference)) {
    throw providerProfileError();
  }
  const credential = normalizeCredentialV3(input.credential, credentialId);
  const probeAuthOverride = normalizeProbeAuthOverrideV3(input.probeAuthOverride, credentialId);
  const provider = {
    id,
    credentialId,
    name: requireText(input.name),
    baseUrl,
    allowInsecureHttp: input.allowInsecureHttp,
    requestProfileRevision: requireRevision(input.requestProfileRevision),
    credential,
    probeAuthOverride,
    headers: input.headers.map((header) => normalizeExtraHeader(header, credentialId)),
    probePreference: input.probePreference,
  };
  const modelList = normalizeModelListV3(input.modelList, provider);
  const modelCapabilities = input.modelCapabilities.map((entry) => normalizeModelCapabilityV3(entry, provider));
  const modelIds = new Set();
  for (const entry of modelCapabilities) {
    if (modelIds.has(entry.modelId)) throw providerProfileError();
    modelIds.add(entry.modelId);
  }
  modelCapabilities.sort((left, right) => (
    left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0
  ));
  const routeOverrides = input.routeOverrides.map(normalizeRouteOverrideV3);
  const overrideKeys = new Set();
  for (const entry of routeOverrides) {
    const key = `${entry.client}\u0000${entry.modelId}`;
    if (overrideKeys.has(key)) throw providerProfileError();
    overrideKeys.add(key);
  }
  routeOverrides.sort((left, right) => (
    left.client < right.client ? -1
      : left.client > right.client ? 1
        : left.modelId < right.modelId ? -1
          : left.modelId > right.modelId ? 1 : 0
  ));
  return {
    ...provider,
    modelList,
    modelCapabilities,
    routeOverrides,
  };
}

export function providerCapabilityForModel(provider, {
  modelId = '',
  protocol = '',
  now = Date.now,
} = {}) {
  if (!PROVIDER_WIRE_PROTOCOLS_V3.has(protocol)) return null;
  let normalized;
  try { normalized = normalizeProviderEntryV3(provider); } catch { return null; }
  const selectedModelId = String(modelId || '').trim();
  if (!selectedModelId) return null;
  const model = normalized.modelCapabilities.find((entry) => entry.modelId === selectedModelId);
  const capability = model?.[protocol];
  if (!capability || capability.status === 'unknown') return null;
  if (
    capability.requestProfileRevision !== normalized.requestProfileRevision
    || capability.modelListRevision !== normalized.modelList.revision
  ) {
    return null;
  }
  let currentTime;
  try { currentTime = typeof now === 'function' ? now() : Date.now(); } catch { return null; }
  if (
    !Number.isFinite(currentTime)
    || capability.checkedAt > currentTime
    || (capability.validUntil !== null && capability.validUntil < currentTime)
  ) {
    return null;
  }
  return capability;
}

export function effectiveProviderCapability(provider, options = {}) {
  const capability = providerCapabilityForModel(provider, options);
  return capability?.status === 'supported' ? capability : null;
}

export function providerRouteOverride(provider, { client = '', modelId = '' } = {}) {
  if (!PROVIDER_CLIENTS_V3.has(client)) return null;
  let normalized;
  try { normalized = normalizeProviderEntryV3(provider); } catch { return null; }
  const selectedModelId = String(modelId || '').trim();
  if (!selectedModelId) return null;
  return normalized.routeOverrides.find((entry) => (
    entry.client === client && entry.modelId === selectedModelId
  )) || null;
}

export function effectiveProviderDialect(provider, {
  modelId = '',
  now = Date.now,
  maxAgeMs = PROVIDER_DIALECT_MAX_AGE_MS,
} = {}) {
  if (!provider || provider.protocol !== 'openai-compatible') return null;
  const state = provider.dialect;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const override = state.override;
  if (override?.source === 'manual' && WIRE_APIS.has(override.wireApi)) return override.wireApi;

  const selectedModelId = String(modelId || '').trim();
  if (!selectedModelId || !Array.isArray(state.detected)) return null;
  const detected = state.detected.find((entry) => entry?.modelId === selectedModelId);
  if (!detected || !WIRE_APIS.has(detected.wireApi) || !hasVerifiedDialectEvidence(detected)) return null;
  if (normalizeBaseUrl(provider.baseUrl) !== normalizeBaseUrl(detected.baseUrl)) return null;
  if (provider.authProfileRevision !== detected.authProfileRevision) return null;

  const currentTime = typeof now === 'function' ? now() : Date.now();
  const ageLimit = Number.isFinite(maxAgeMs) && maxAgeMs >= 0
    ? maxAgeMs
    : PROVIDER_DIALECT_MAX_AGE_MS;
  if (!Number.isFinite(currentTime) || detected.detectedAt > currentTime) return null;
  if (currentTime - detected.detectedAt > ageLimit) return null;
  return detected.wireApi;
}

function normalizeProviderId(value) {
  const raw = String(value || '').trim() || DEFAULT_CODEX_PROVIDER_ID;
  const safe = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || DEFAULT_CODEX_PROVIDER_ID;
  return RESERVED_CODEX_PROVIDER_IDS.has(safe) ? safe + '-custom' : safe;
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

export function codexRuntimeProviderProfile({
  effectiveChannel,
  customProvider,
  customProviderCredentialResolverReady = false,
  modelId,
} = {}) {
  if (
    effectiveChannel !== 'custom'
    || customProviderCredentialResolverReady !== true
    || !customProvider
  ) {
    return null;
  }
  const selectedModelId = String(modelId || '').trim();
  if (!selectedModelId) return null;
  let normalized;
  try { normalized = normalizeProviderEntryV3(customProvider); } catch { return null; }
  return { provider: normalized, modelId: selectedModelId };
}

function normalizeCodexRuntimeConfig(runtimeConfig) {
  if (!runtimeConfig || !runtimeConfig.baseUrl) return null;
  if (runtimeConfig.chatCompatibility !== undefined && typeof runtimeConfig.chatCompatibility !== 'boolean') {
    throw providerProfileError();
  }
  if (!Array.isArray(runtimeConfig.envHeaders) || runtimeConfig.envHeaders.length > 64) {
    throw providerProfileError();
  }
  const names = new Set();
  const envNames = new Set();
  const apiKey = runtimeConfig.apiKey === undefined
    ? undefined
    : requireText(runtimeConfig.apiKey);
  const envHeaders = runtimeConfig.envHeaders.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw providerProfileError();
    const name = normalizeHeaderName(entry.name);
    const envName = requireText(entry.envName);
    if (!/^AE_MCP_PROVIDER_HEADER_[0-9]{2}$/.test(envName)) throw providerProfileError();
    const lower = name.toLowerCase();
    if (names.has(lower) || envNames.has(envName)) throw providerProfileError();
    names.add(lower);
    envNames.add(envName);
    return {
      name,
      envName,
      value: entry.value === undefined ? undefined : String(entry.value),
    };
  });
  return {
    providerId: normalizeProviderId(runtimeConfig.providerId),
    baseUrl: normalizeBaseUrl(requireText(runtimeConfig.baseUrl)),
    apiKey,
    envHeaders,
    chatCompatibility: runtimeConfig.chatCompatibility === true,
  };
}

export function codexAppServerArgs(runtimeConfig = null) {
  const runtime = normalizeCodexRuntimeConfig(runtimeConfig);
  if (!runtime) return ['app-server'];
  const provider = runtime.providerId;
  const args = [
    'app-server',
    '-c', `model_provider=${tomlString(provider)}`,
    '-c', `model_providers.${provider}.name="AE MCP Custom"`,
    '-c', `model_providers.${provider}.base_url=${tomlString(runtime.baseUrl)}`,
  ];
  if (runtime.apiKey !== undefined) {
    args.push('-c', `model_providers.${provider}.env_key=${tomlString(CODEX_PROVIDER_API_KEY_ENV)}`);
  }
  if (runtime.envHeaders.length > 0) {
    const table = runtime.envHeaders
      .map((header) => `${tomlString(header.name)} = ${tomlString(header.envName)}`)
      .join(', ');
    args.push('-c', `model_providers.${provider}.env_http_headers={ ${table} }`);
  }
  args.push(
    '-c', `model_providers.${provider}.wire_api="responses"`,
    '-c', `model_providers.${provider}.requires_openai_auth=false`,
    '-c', 'features.multi_agent=false',
    '-c', 'features.multi_agent_v2=false',
    '-c', 'features.multi_agent_v2.non_code_mode_only=false',
  );
  if (runtime.chatCompatibility) {
    args.push(
      '-c', 'web_search="disabled"',
      '-c', 'features.apps=false',
      '-c', 'features.plugins=false',
      '-c', 'features.remote_plugin=false',
    );
  }
  return args;
}

export function codexSpawnEnv(runtimeConfig = null, baseEnv = {}) {
  const runtime = normalizeCodexRuntimeConfig(runtimeConfig);
  const env = { ...(baseEnv || {}) };
  if (!runtime) return env;
  delete env[CODEX_PROVIDER_API_KEY_ENV];
  for (const key of Object.keys(env)) {
    if (/^AE_MCP_PROVIDER_HEADER_[0-9]{2}$/.test(key)) delete env[key];
  }
  for (const header of runtime.envHeaders) {
    if (header.value === undefined) throw providerProfileError();
    env[header.envName] = header.value;
  }
  if (runtime.apiKey !== undefined) env[CODEX_PROVIDER_API_KEY_ENV] = runtime.apiKey;
  return env;
}

export function anthropicEndpoint(baseUrl, apiPath) {
  const base = normalizeBaseUrl(baseUrl) || DEFAULT_ANTHROPIC_BASE_URL;
  const url = new URL(base);
  const prefix = url.pathname.replace(/\/+$/, '');
  const rawPath = String(apiPath || '');
  const queryIndex = rawPath.indexOf('?');
  const pathPart = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
  const searchPart = queryIndex === -1 ? '' : rawPath.slice(queryIndex);
  const suffix = pathPart.startsWith('/') ? pathPart : '/' + pathPart;
  url.pathname = (prefix === '/' ? '' : prefix) + suffix;
  url.search = searchPart;
  url.hash = '';
  return url.toString();
}

// Spec B2: the CEP env snapshot can miss USERPROFILE/HOME/APPDATA (they are
// whatever AE was launched with). codex app-server needs them to locate its
// login state, so fill them in before spawning.
export function ensureUserEnv(env = {}, { homedir = '', appData = '' } = {}) {
  const next = { ...env };
  const anchor = String(next.USERPROFILE || next.HOME || homedir || '').replace(/[\\/]+$/, '');
  if (!anchor) return next;
  if (!next.USERPROFILE) next.USERPROFILE = anchor;
  if (!next.HOME) next.HOME = anchor;
  if (!next.APPDATA) next.APPDATA = appData || anchor + '\\AppData\\Roaming';
  return next;
}
