const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CODEX_PROVIDER_ID = 'ae_mcp_custom';
const DEFAULT_CODEX_WIRE_API = 'responses';
const RESERVED_CODEX_PROVIDER_IDS = new Set(['openai', 'amazon-bedrock', 'ollama', 'lmstudio']);

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
