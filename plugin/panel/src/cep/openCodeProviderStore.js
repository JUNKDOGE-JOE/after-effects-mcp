import { createPlatformAdapter } from './platform/index.js';

const CONFIG_FILE = 'opencode-providers.json';
const AUTH_FILE = 'auth.json';
const VERSION = 1;

function storeError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function slug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeOpenCodeProviderId(value) {
  const raw = String(value || '').trim();
  const normalized = slug(raw.startsWith('aemcp-') ? raw.slice('aemcp-'.length) : raw);
  if (!normalized) throw storeError('OPENCODE_PROVIDER_INVALID', 'Provider name is required');
  return `aemcp-${normalized}`;
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw storeError('OPENCODE_PROVIDER_INVALID', 'Provider base URL is invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw storeError('OPENCODE_PROVIDER_INVALID', 'Provider base URL must use HTTP or HTTPS');
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeModelIds(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  const models = values.map((item) => String(item || '').trim()).filter(Boolean);
  if (!models.length) throw storeError('OPENCODE_PROVIDER_INVALID', 'At least one model is required');
  return Array.from(new Set(models)).sort();
}

function normalizeProvider(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw storeError('OPENCODE_PROVIDER_INVALID', 'Provider definition is invalid');
  }
  const id = normalizeOpenCodeProviderId(value.id || value.name);
  const name = String(value.name || '').trim();
  if (!name) throw storeError('OPENCODE_PROVIDER_INVALID', 'Provider name is required');
  if (value.allowInsecureHttp !== true && normalizeBaseUrl(value.baseUrl).startsWith('http:')) {
    throw storeError('OPENCODE_PROVIDER_INVALID', 'Insecure provider HTTP requires confirmation');
  }
  return {
    id,
    name,
    baseUrl: normalizeBaseUrl(value.baseUrl),
    allowInsecureHttp: value.allowInsecureHttp === true,
    modelIds: normalizeModelIds(value.modelIds || value.modelId),
    needsApiKey: value.needsApiKey === true,
  };
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.version !== VERSION || !Array.isArray(value.providers)) {
    throw storeError('OPENCODE_PROVIDER_STORE_INVALID', 'OpenCode provider store is invalid');
  }
  const providers = value.providers.map(normalizeProvider);
  const ids = new Set();
  for (const provider of providers) {
    if (ids.has(provider.id)) {
      throw storeError('OPENCODE_PROVIDER_STORE_INVALID', 'OpenCode provider IDs must be unique');
    }
    ids.add(provider.id);
  }
  return { version: VERSION, providers };
}

function emptyState() {
  return { version: VERSION, providers: [] };
}

function parseJsonFile(fs, file, missingValue, code) {
  try {
    return JSON.parse(String(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT' || !fs.existsSync(file)) return missingValue;
    throw storeError(code, error?.message || code);
  }
}

function writeAtomic(fs, file, value, tempSuffix) {
  const directory = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
  const temp = `${file}.${tempSuffix}.tmp`;
  try {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try { fs.chmodSync(temp, 0o600); } catch { /* best effort on Windows */ }
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort on Windows */ }
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw storeError(
      'OPENCODE_PROVIDER_STORE_UNAVAILABLE',
      error?.message || 'OpenCode provider store is unavailable',
    );
  }
}

function authPath(adapter) {
  const dataHome = String(adapter.env?.XDG_DATA_HOME || '').trim();
  const root = dataHome ? adapter.paths.resolve([dataHome])
    : adapter.paths.join([adapter.paths.home, '.local', 'share']);
  return adapter.paths.join([root, 'opencode', AUTH_FILE]);
}

function normalizeAuth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw storeError('OPENCODE_AUTH_INVALID', 'OpenCode auth.json is invalid');
  }
  return value;
}

function legacyProviderDraft(provider) {
  const name = String(provider?.name || provider?.id || '').trim();
  const baseUrl = String(provider?.baseUrl || '').trim();
  if (!name || !baseUrl) return null;
  const models = Array.isArray(provider?.modelList?.models)
    ? provider.modelList.models.map((model) => model?.id)
    : Array.isArray(provider?.probedModels) ? provider.probedModels.map((model) => model?.id) : [];
  return {
    id: provider.id || name,
    name,
    baseUrl,
    allowInsecureHttp: provider.allowInsecureHttp === true,
    modelIds: models.length ? models : ['model-required'],
    needsApiKey: true,
  };
}

export function openCodeProviderDefinitions(providers) {
  const definitions = {};
  for (const raw of providers || []) {
    const provider = normalizeProvider(raw);
    if (provider.needsApiKey) continue;
    definitions[provider.id] = {
      npm: '@ai-sdk/anthropic',
      name: provider.name,
      options: { baseURL: provider.baseUrl },
      models: Object.fromEntries(provider.modelIds.map((id) => [id, { name: id }])),
    };
  }
  return definitions;
}

export function createOpenCodeProviderStore({ platform, fsImpl, tempSuffix } = {}) {
  const adapter = platform || createPlatformAdapter();
  const fs = fsImpl || adapter.fs;
  if (!adapter?.paths?.join || !adapter?.paths?.home || !fs) {
    throw new TypeError('A platform adapter with file access is required');
  }
  let nonce = 0;
  const nextSuffix = () => tempSuffix || `${Date.now()}-${nonce += 1}`;
  const file = adapter.paths.join([adapter.paths.configRoot, CONFIG_FILE]);
  const authFile = authPath(adapter);

  function readState() {
    return normalizeState(parseJsonFile(fs, file, emptyState(), 'OPENCODE_PROVIDER_STORE_UNAVAILABLE'));
  }

  function list() {
    return clone(readState().providers);
  }

  function auth() {
    return normalizeAuth(parseJsonFile(fs, authFile, {}, 'OPENCODE_AUTH_UNAVAILABLE'));
  }

  function hasApiKey(providerId) {
    const entry = auth()[normalizeOpenCodeProviderId(providerId)];
    return entry?.type === 'api' && typeof entry.key === 'string' && entry.key.length > 0;
  }

  function writeAuthKey(providerId, key) {
    const value = String(key || '');
    if (!value) throw storeError('OPENCODE_API_KEY_REQUIRED', 'An API key is required');
    const current = auth();
    current[normalizeOpenCodeProviderId(providerId)] = { type: 'api', key: value };
    writeAtomic(fs, authFile, current, nextSuffix());
  }

  function save(draft, { apiKey = '', currentId = '' } = {}) {
    const current = readState();
    const wantedId = String(currentId || draft?.id || draft?.name || '').trim();
    const id = wantedId.startsWith('aemcp-') ? wantedId : normalizeOpenCodeProviderId(wantedId);
    const provider = normalizeProvider({ ...draft, id, needsApiKey: false });
    const previous = current.providers.find((entry) => entry.id === id) || null;
    const key = String(apiKey || '');
    if (key) writeAuthKey(provider.id, key);
    else if ((previous?.needsApiKey || !previous) && !hasApiKey(provider.id)) {
      throw storeError('OPENCODE_API_KEY_REQUIRED', 'Re-enter this provider API key');
    }
    const index = current.providers.findIndex((entry) => entry.id === provider.id);
    if (index === -1) current.providers.push(provider);
    else current.providers[index] = provider;
    writeAtomic(fs, file, current, nextSuffix());
    return clone(provider);
  }

  function remove(providerId) {
    const id = normalizeOpenCodeProviderId(providerId);
    const current = readState();
    const providers = current.providers.filter((provider) => provider.id !== id);
    if (providers.length === current.providers.length) return false;
    current.providers = providers;
    writeAtomic(fs, file, current, nextSuffix());
    return true;
  }

  function importLegacyProviders(legacyProviders) {
    const current = readState();
    if (current.providers.length) return list();
    const providers = (legacyProviders || []).map(legacyProviderDraft).filter(Boolean).map(normalizeProvider);
    if (!providers.length) return [];
    current.providers = providers;
    writeAtomic(fs, file, current, nextSuffix());
    return clone(providers);
  }

  return Object.freeze({
    authFilePath: () => authFile,
    filePath: () => file,
    hasApiKey,
    importLegacyProviders,
    list,
    remove,
    save,
  });
}
