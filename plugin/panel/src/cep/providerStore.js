// Unified custom-provider store: ~/.ae-mcp/providers.json (spec A2).
// Entry: {id, name, protocol: 'anthropic'|'openai-compatible', baseUrl,
// apiKey, probedModels: [{id,label}], probedAt: ms, dialect?}. Atomic
// write + chmod 600 mirrors apiKey.js.
// providers.json consolidates multiple provider keys in one file by design
// (spec A2); chmod 600 is best-effort on Windows -- the single-file blast
// radius is accepted in exchange for unified management and migration.
const PROTOCOLS = new Set(['anthropic', 'openai-compatible']);
const DIALECT_WIRE_APIS = new Set(['responses', 'chat']);
const DIALECT_AUTH_SCHEMES = new Set(['bearer', 'x-api-key', 'none']);
const DIALECT_SOURCES = new Set(['ccswitch-import', 'detected', 'manual']);
const FILE_NAME = 'providers.json';

function cepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) return globalThis.window.cep_node.require;
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  return null;
}

function defaultDeps() {
  const req = cepRequire();
  if (!req) throw new Error('CEP Node require is unavailable');
  return {
    fs: req('fs'),
    os: req('os'),
    path: req('path'),
    pid: req('process') && req('process').pid,
  };
}

export function normalizeProviderEntry(input = {}) {
  const id = String(input.id || '').trim();
  if (!id) throw new Error('Provider entry needs an id');
  const protocol = String(input.protocol || 'openai-compatible');
  if (!PROTOCOLS.has(protocol)) throw new Error('Unsupported provider protocol: ' + protocol);
  const entry = {
    id,
    name: String(input.name || '').trim() || id,
    protocol,
    baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(input.apiKey || '').trim(),
    probedModels: Array.isArray(input.probedModels) ? input.probedModels : [],
    probedAt: Number(input.probedAt) || 0,
  };
  const dialect = input.dialect && typeof input.dialect === 'object' ? input.dialect : null;
  const wireApi = dialect ? String(dialect.wireApi || '').trim() : '';
  const authScheme = dialect ? String(dialect.authScheme || '').trim() : '';
  if (DIALECT_WIRE_APIS.has(wireApi) && DIALECT_AUTH_SCHEMES.has(authScheme)) {
    const source = String(dialect.source || '').trim();
    entry.dialect = {
      wireApi,
      authScheme,
      source: DIALECT_SOURCES.has(source) ? source : 'manual',
      updatedAt: typeof dialect.updatedAt === 'number' && Number.isFinite(dialect.updatedAt) ? dialect.updatedAt : 0,
    };
  }
  return entry;
}

export function createProviderStore(deps = defaultDeps()) {
  const { fs, os, path } = deps;

  function dir() { return path.join(os.homedir(), '.ae-mcp'); }
  function filePath() { return path.join(dir(), FILE_NAME); }

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.providers)) {
        return { version: 1, migratedLegacy: false, providers: [] };
      }
      return { version: 1, migratedLegacy: parsed.migratedLegacy === true, providers: parsed.providers };
    } catch (e) {
      return { version: 1, migratedLegacy: false, providers: [] };
    }
  }

  function writeState(state) {
    const d = dir();
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    const pid = deps.pid || 0;
    const tmp = path.join(d, FILE_NAME + '.' + pid + '.' + Date.now() + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    try { fs.chmodSync(tmp, 0o600); } catch (e) { /* best effort on Windows */ }
    fs.renameSync(tmp, filePath());
    return state;
  }

  function list() { return readState().providers.map((p) => normalizeProviderEntry(p)); }
  function get(id) { return list().find((p) => p.id === String(id || '').trim()) || null; }

  function upsert(entry) {
    const next = normalizeProviderEntry(entry);
    const state = readState();
    const idx = state.providers.findIndex((p) => p && p.id === next.id);
    if (idx === -1) state.providers.push(next);
    else state.providers[idx] = next;
    writeState(state);
    return next;
  }

  function remove(id) {
    const state = readState();
    state.providers = state.providers.filter((p) => p && p.id !== String(id || '').trim());
    writeState(state);
  }

  function migrateLegacy({ readKey, readPref, markDone = true } = {}) {
    const state = readState();
    if (state.migratedLegacy) return { migrated: [] };
    const migrated = [];
    const anthropicKey = readKey ? String(readKey('anthropic') || '') : '';
    const anthropicBase = readPref ? String(readPref('ae_mcp_anthropic_base_url') || '') : '';
    if (anthropicKey || anthropicBase) {
      migrated.push(upsert({
        id: 'legacy-anthropic',
        name: 'Claude API (migrated)',
        protocol: 'anthropic',
        baseUrl: anthropicBase || 'https://api.anthropic.com',
        apiKey: anthropicKey,
      }));
    }
    const codexKey = readKey ? String(readKey('codex') || '') : '';
    const codexBase = readPref ? String(readPref('ae_mcp_codex_base_url') || '') : '';
    if (codexKey || codexBase) {
      migrated.push(upsert({
        id: 'legacy-codex',
        name: 'Codex custom (migrated)',
        protocol: 'openai-compatible',
        baseUrl: codexBase,
        apiKey: codexKey,
      }));
    }
    if (markDone) {
      const after = readState();
      after.migratedLegacy = true;
      writeState(after);
    }
    return { migrated };
  }

  return { filePath, list, get, upsert, remove, migrateLegacy };
}
