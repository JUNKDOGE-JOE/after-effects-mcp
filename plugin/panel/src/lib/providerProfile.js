import { parseProviderSecretReference } from '../cep/platform/secret-reference.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CODEX_PROVIDER_ID = 'ae_mcp_custom';
const DEFAULT_CODEX_WIRE_API = 'responses';
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
const DIALECT_DETECTED_KEYS = ['authProfileRevision', 'baseUrl', 'detectedAt', 'evidence', 'wireApi'];
const PROBED_MODEL_KEYS = ['id', 'label'];
const PROVIDER_SCOPES = new Set(['probe', 'model']);
const PROVIDER_PROTOCOLS = new Set(['openai-compatible', 'anthropic']);
const WIRE_APIS = new Set(['responses', 'chat']);
const DIALECT_SOURCES = new Set(['manual', 'legacy-v0.9', 'ccswitch-import']);
const DIALECT_EVIDENCE = new Set([
  'models-capability',
  'responses-success-schema',
  'responses-missing-input',
  'chat-success-schema',
  'chat-missing-messages',
]);
const SENSITIVE_HEADER_NAME = /(?:^|[-_])(?:authorization|api[-_]?key|token|secret|password)(?:$|[-_])/i;
const SECRET_LIKE_LITERAL = /^(?:Bearer\s+\S+|Basic\s+\S+|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function firstValue(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
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
  if (
    valueRef.kind === 'literal'
    && (SENSITIVE_HEADER_NAME.test(name.toLowerCase()) || SECRET_LIKE_LITERAL.test(valueRef.value))
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

  let detected = null;
  if (value.detected !== null) {
    requireExactObject(value.detected, DIALECT_DETECTED_KEYS);
    if (!WIRE_APIS.has(value.detected.wireApi) || !DIALECT_EVIDENCE.has(value.detected.evidence)) {
      throw providerProfileError();
    }
    detected = {
      wireApi: value.detected.wireApi,
      baseUrl: normalizeBaseUrl(requireText(value.detected.baseUrl)),
      authProfileRevision: requireRevision(value.detected.authProfileRevision),
      detectedAt: requireTimestamp(value.detected.detectedAt),
      evidence: value.detected.evidence,
    };
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
    baseUrl: normalizeBaseUrl(requireText(input.baseUrl)),
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

function normalizeProviderId(value) {
  const raw = String(value || '').trim() || DEFAULT_CODEX_PROVIDER_ID;
  const safe = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || DEFAULT_CODEX_PROVIDER_ID;
  return RESERVED_CODEX_PROVIDER_IDS.has(safe) ? safe + '-custom' : safe;
}

function normalizeCodexWireApi() {
  return DEFAULT_CODEX_WIRE_API;
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

export function normalizeProviderProfile(input = {}, env = {}) {
  const codexBaseUrl = normalizeBaseUrl(firstValue(input.codexBaseUrl, env.AE_MCP_CODEX_BASE_URL));
  const anthropicBaseUrl = normalizeBaseUrl(firstValue(input.anthropicBaseUrl, env.AE_MCP_ANTHROPIC_BASE_URL));
  return {
    codexApiKey: firstValue(input.codexApiKey, env.AE_MCP_CODEX_API_KEY),
    codexBaseUrl,
    codexProviderId: normalizeProviderId(firstValue(input.codexProviderId, env.AE_MCP_CODEX_PROVIDER_ID)),
    codexWireApi: normalizeCodexWireApi(),
    anthropicBaseUrl,
  };
}

export function codexAppServerArgs(profile = {}) {
  const normalized = normalizeProviderProfile(profile);
  if (!normalized.codexBaseUrl) return ['app-server'];
  const provider = normalized.codexProviderId;
  return [
    'app-server',
    '-c', `model_provider=${tomlString(provider)}`,
    '-c', `model_providers.${provider}.name="AE MCP Custom"`,
    '-c', `model_providers.${provider}.base_url=${tomlString(normalized.codexBaseUrl)}`,
    '-c', `model_providers.${provider}.env_key="AE_MCP_CODEX_API_KEY"`,
    '-c', `model_providers.${provider}.wire_api=${tomlString(normalized.codexWireApi)}`,
    '-c', `model_providers.${provider}.requires_openai_auth=false`,
  ];
}

export function codexSpawnEnv(profile = {}, baseEnv = {}) {
  const normalized = normalizeProviderProfile(profile, baseEnv);
  const env = { ...(baseEnv || {}) };
  if (normalized.codexApiKey) env.AE_MCP_CODEX_API_KEY = normalized.codexApiKey;
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
