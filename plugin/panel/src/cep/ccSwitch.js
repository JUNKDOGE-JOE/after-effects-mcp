// Optional cc-switch inheritance (spec A2): detect-only, never a wizard
// dependency. Third-party format is unstable -> tolerant field mapping.
const CONFIG_NAMES = ['config.json', 'providers.json'];
const API_FORMAT_TO_WIRE_API = {
  openai_responses: 'responses',
  openai_chat: 'chat',
};

function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

function candidateDirs(env = {}) {
  const home = String(env.USERPROFILE || env.HOME || '').replace(/[\/]+$/, '');
  const appData = String(env.APPDATA || (home ? home + '\\AppData\\Roaming' : '')).replace(/[\/]+$/, '');
  const dirs = [];
  if (home) {
    dirs.push(home + '\\.cc-switch');
    dirs.push(home + '\\.config\\cc-switch');
  }
  if (appData) dirs.push(appData + '\\cc-switch');
  return dirs;
}

function rawProviders(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed.providers)) return parsed.providers;
  if (Array.isArray(parsed.profiles)) return parsed.profiles;
  if (parsed.providers && typeof parsed.providers === 'object') return Object.values(parsed.providers);
  return [];
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function wireApiFromApiFormat(value) {
  return API_FORMAT_TO_WIRE_API[String(value || '').trim().toLowerCase()] || '';
}

function wireApiFromConfig(config) {
  if (typeof config !== 'string') return '';
  const match = config.match(/(?:^|\n)\s*wire_api\s*=\s*["'](responses|chat)["']/i);
  return match ? match[1].toLowerCase() : '';
}

function inferWireApi(p, settingsConfig) {
  const meta = objectValue(p.meta);
  return wireApiFromApiFormat(meta.apiFormat || meta.api_format)
    || wireApiFromApiFormat(p.apiFormat || p.api_format)
    || wireApiFromConfig(settingsConfig.config);
}

function authSchemeFromApiKeyField(value) {
  const field = String(value || '').trim();
  if (field === 'ANTHROPIC_API_KEY') return 'x-api-key';
  if (/x[-_]?api[-_]?key/i.test(field)) return 'x-api-key';
  return '';
}

function inferAuthScheme(p, settingsConfig) {
  const meta = objectValue(p.meta);
  const fromApiKeyField = authSchemeFromApiKeyField(meta.apiKeyField || meta.api_key_field);
  if (fromApiKeyField) return fromApiKeyField;
  const env = objectValue(settingsConfig.env);
  const auth = objectValue(settingsConfig.auth);
  if (hasOwn(env, 'ANTHROPIC_AUTH_TOKEN')) return 'bearer';
  if (hasOwn(env, 'ANTHROPIC_API_KEY')) return 'x-api-key';
  if (hasOwn(auth, 'OPENAI_API_KEY') || hasOwn(env, 'OPENAI_API_KEY')) return 'bearer';
  return '';
}

function inferDialect(p, now) {
  const settingsConfig = objectValue(p.settingsConfig || p.settings_config);
  const wireApi = inferWireApi(p, settingsConfig);
  const authScheme = inferAuthScheme(p, settingsConfig);
  if (!wireApi || !authScheme) return null;
  return { wireApi, authScheme, source: 'ccswitch-import', updatedAt: now() };
}

export function ccSwitchProviderEntries(list, { now = Date.now } = {}) {
  return (Array.isArray(list) ? list : [])
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const name = String(p.name || p.title || p.id || '').trim();
      const baseUrl = String(p.baseUrl || p.base_url || p.url || '').trim();
      const apiKey = String(p.apiKey || p.api_key || p.key || p.token || '').trim();
      if (!name || !baseUrl) return null;
      const protocol = /anthropic/i.test(String(p.type || p.protocol || p.kind || '')) ? 'anthropic' : 'openai-compatible';
      const entry = { id: 'ccswitch-' + name.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase(), name, protocol, baseUrl, apiKey };
      const dialect = inferDialect(p, now);
      if (dialect) entry.dialect = dialect;
      return entry;
    })
    .filter(Boolean);
}

export function detectCcSwitch({ env = {}, fsImpl } = {}) {
  let fs;
  try { fs = fsImpl || getCepRequire()('fs'); } catch (e) { return null; }
  for (const dir of candidateDirs(env)) {
    for (const name of CONFIG_NAMES) {
      const file = dir + '\\' + name;
      try {
        if (!fs.existsSync(file)) continue;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const providers = ccSwitchProviderEntries(rawProviders(parsed));
        if (providers.length) return { dir, file, providers };
      } catch (e) { /* unreadable candidate -> keep scanning */ }
    }
  }
  return null;
}
