// cc-switch import is preview-then-read: previews contain no secret or secret
// reference, and confirmation re-reads the exact SHA-256 revision.
import { createPlatformAdapter } from './platform/index.js';

const CONFIG_NAMES = ['config.json', 'providers.json'];
const API_FORMAT_TO_WIRE_API = {
  openai_responses: 'responses',
  'openai-responses': 'responses',
  responses: 'responses',
  openai_chat: 'chat',
  'openai-chat': 'chat',
  chat: 'chat',
  'chat-completions': 'chat',
  chat_completions: 'chat',
};

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

// Synchronous SHA-256 keeps the inspect/read APIs synchronous in CEP and does
// not depend on a Node global existing in the browser bundle.
export function sha256Text(text) {
  const bytes = typeof TextEncoder === 'function'
    ? new TextEncoder().encode(String(text))
    : Uint8Array.from(unescape(encodeURIComponent(String(text))), (char) => char.charCodeAt(0));
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high);
  view.setUint32(paddedLength - 4, low);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + constants[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function candidateDirs(platform) {
  const home = platform.paths.home;
  const completed = platform.completeSpawnEnv ? platform.completeSpawnEnv() : {};
  const appData = completed.APPDATA || platform.paths.join([home, 'AppData', 'Roaming']);
  const dirs = [];
  if (home) {
    dirs.push(platform.paths.join([home, '.cc-switch']));
    dirs.push(platform.paths.join([home, '.config', 'cc-switch']));
  }
  if (appData) dirs.push(platform.paths.join([appData, 'cc-switch']));
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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function wireApiFromValue(value) {
  return API_FORMAT_TO_WIRE_API[String(value || '').trim().toLowerCase()] || '';
}

function wireApiFromConfig(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(/(?:^|\n)\s*wire_api\s*=\s*["'](responses|chat)["']/i);
  return match ? match[1].toLowerCase() : '';
}

function dialectHint(provider) {
  const meta = objectValue(provider?.meta);
  const settingsConfig = objectValue(provider?.settingsConfig || provider?.settings_config);
  const dialect = objectValue(provider?.dialect);
  return wireApiFromValue(meta.apiFormat || meta.api_format)
    || wireApiFromValue(provider?.apiFormat || provider?.api_format)
    || wireApiFromConfig(settingsConfig.config)
    || wireApiFromValue(provider?.wireApi || provider?.wire_api || dialect.wireApi || dialect.wire_api)
    || null;
}

function authSchemeFromValue(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'none' || text === 'no-auth' || text === 'no_auth') return 'none';
  if (text === 'bearer' || text === 'authorization' || text === 'openai_api_key') return 'bearer';
  if (text === 'x-api-key' || text === 'x_api_key' || text === 'anthropic_api_key') return 'x-api-key';
  return '';
}

function authSchemeFromKeyField(value) {
  const field = String(value || '').trim();
  const direct = authSchemeFromValue(field);
  if (direct) return direct;
  if (/x[-_]?api[-_]?key/i.test(field) || field === 'ANTHROPIC_API_KEY') return 'x-api-key';
  if (/authorization/i.test(field) || field === 'OPENAI_API_KEY' || field === 'ANTHROPIC_AUTH_TOKEN') return 'bearer';
  return '';
}

function authHint(provider) {
  const meta = objectValue(provider?.meta);
  const settingsConfig = objectValue(provider?.settingsConfig || provider?.settings_config);
  const auth = objectValue(settingsConfig.auth);
  const env = objectValue(settingsConfig.env);
  const explicit = authSchemeFromValue(
    provider?.authScheme
    || provider?.auth_scheme
    || meta.authScheme
    || meta.auth_scheme
    || auth.type
    || auth.scheme,
  );
  if (explicit) return explicit;
  const keyField = authSchemeFromKeyField(meta.apiKeyField || meta.api_key_field);
  if (keyField) return keyField;
  if (hasOwn(auth, 'OPENAI_API_KEY') || hasOwn(env, 'OPENAI_API_KEY')) return 'bearer';
  if (hasOwn(auth, 'ANTHROPIC_AUTH_TOKEN') || hasOwn(env, 'ANTHROPIC_AUTH_TOKEN')) return 'bearer';
  if (hasOwn(auth, 'ANTHROPIC_API_KEY') || hasOwn(env, 'ANTHROPIC_API_KEY')) return 'x-api-key';
  return null;
}

function safeBaseUrl(value) {
  const text = String(value || '').trim();
  let url;
  try { url = new URL(text); } catch { return ''; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return '';
  const sensitiveName = /(?:^|[-_])(?:authorization|api[-_]?key|token|secret|password|auth)(?:$|[-_])/i;
  for (const name of url.searchParams.keys()) {
    if (sensitiveName.test(name)) return '';
  }
  return text;
}

function previewEntry(provider) {
  if (!provider || typeof provider !== 'object') return null;
  const name = String(provider.name || provider.title || provider.id || '').trim();
  const baseUrl = safeBaseUrl(provider.baseUrl || provider.base_url || provider.url || '');
  if (!name || !baseUrl) return null;
  const protocol = /anthropic/i.test(String(provider.type || provider.protocol || provider.kind || ''))
    ? 'anthropic'
    : 'openai-compatible';
  return {
    candidateId: `ccswitch-${name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`,
    name,
    protocol,
    baseUrl,
    dialectHint: protocol === 'openai-compatible' ? dialectHint(provider) : null,
    authHint: protocol === 'openai-compatible' ? authHint(provider) : null,
  };
}

export function ccSwitchProviderEntries(list) {
  return (Array.isArray(list) ? list : []).map(previewEntry).filter(Boolean);
}

function importChanged() {
  const error = new Error('Provider import source changed');
  error.code = 'provider_import_source_changed';
  return error;
}

export function detectCcSwitch({ platform, fsImpl } = {}) {
  const adapter = platform || createPlatformAdapter();
  const fs = fsImpl || adapter.fs;
  if (!fs) return null;
  for (const dir of candidateDirs(adapter)) {
    for (const name of CONFIG_NAMES) {
      const file = adapter.paths.join([dir, name]);
      try {
        if (fs.existsSync && !fs.existsSync(file)) continue;
        const text = String(fs.readFileSync(file, 'utf8'));
        const providers = ccSwitchProviderEntries(rawProviders(JSON.parse(text)));
        if (providers.length) return { dir, file, sourceRevision: sha256Text(text), providers };
      } catch {
        // Unreadable/corrupt candidates do not suppress later candidates.
      }
    }
  }
  return null;
}

export function readCcSwitchProviderDrafts({ file, expectedSourceRevision, fsImpl } = {}) {
  if (!file || !expectedSourceRevision || !fsImpl?.readFileSync) throw importChanged();
  let text;
  try { text = String(fsImpl.readFileSync(file, 'utf8')); } catch { throw importChanged(); }
  if (sha256Text(text) !== expectedSourceRevision) throw importChanged();
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw importChanged(); }
  return rawProviders(parsed).map((provider) => {
    const preview = previewEntry(provider);
    if (!preview) return null;
    return {
      ...preview,
      modelAuthKind: preview.authHint || 'bearer',
      modelAuthSecret: String(provider.apiKey || provider.api_key || provider.key || provider.token || '').trim(),
    };
  }).filter(Boolean);
}
