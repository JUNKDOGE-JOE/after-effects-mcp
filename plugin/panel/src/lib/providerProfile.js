import { parseProviderSecretReference } from '../cep/platform/secret-reference.js';

const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CODEX_PROVIDER_ID = 'ae_mcp_custom';
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
const SECRET_LIKE_PATH_LITERAL = /(?:Bearer\s+\S{8,}|Basic\s+\S{8,}|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})/i;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_PERCENT_DECODE_LAYERS = 3;

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
    if (SECRET_LIKE_PATH_LITERAL.test(current)) return true;
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
      baseUrl: validateProviderBaseUrl(requireText(value.detected.baseUrl)),
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

export function effectiveProviderDialect(provider, {
  now = Date.now,
  maxAgeMs = PROVIDER_DIALECT_MAX_AGE_MS,
} = {}) {
  if (!provider || provider.protocol !== 'openai-compatible') return null;
  const state = provider.dialect;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const override = state.override;
  if (override && WIRE_APIS.has(override.wireApi)) return override.wireApi;

  const detected = state.detected;
  if (!detected || !WIRE_APIS.has(detected.wireApi)) return null;
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
} = {}) {
  if (
    effectiveChannel !== 'custom'
    || customProviderCredentialResolverReady !== true
    || !customProvider
    || customProvider.protocol !== 'openai-compatible'
  ) {
    return null;
  }
  const normalized = normalizeProviderEntryV2(customProvider);
  const dialect = effectiveProviderDialect(normalized);
  return dialect ? { provider: normalized, dialect } : null;
}

function normalizeCodexRuntimeConfig(runtimeConfig) {
  if (!runtimeConfig || !runtimeConfig.baseUrl) return null;
  if (!Array.isArray(runtimeConfig.envHeaders) || runtimeConfig.envHeaders.length > 64) {
    throw providerProfileError();
  }
  const names = new Set();
  const envNames = new Set();
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
    envHeaders,
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
  for (const header of runtime.envHeaders) {
    args.push('-c', `model_providers.${provider}.env_http_headers.${tomlString(header.name)}=${tomlString(header.envName)}`);
  }
  args.push(
    '-c', `model_providers.${provider}.wire_api="responses"`,
    '-c', `model_providers.${provider}.requires_openai_auth=false`,
  );
  return args;
}

export function codexSpawnEnv(runtimeConfig = null, baseEnv = {}) {
  const runtime = normalizeCodexRuntimeConfig(runtimeConfig);
  const env = { ...(baseEnv || {}) };
  if (!runtime) return env;
  delete env.AE_MCP_CODEX_API_KEY;
  for (const key of Object.keys(env)) {
    if (/^AE_MCP_PROVIDER_HEADER_[0-9]{2}$/.test(key)) delete env[key];
  }
  for (const header of runtime.envHeaders) {
    if (header.value === undefined) throw providerProfileError();
    env[header.envName] = header.value;
  }
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
