// Optional cc-switch inheritance (spec A2): detect-only, never a wizard
// dependency. Third-party format is unstable -> tolerant field mapping.
const CONFIG_NAMES = ['config.json', 'providers.json'];

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

export function ccSwitchProviderEntries(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => {
      if (!p || typeof p !== 'object') return null;
      const name = String(p.name || p.title || p.id || '').trim();
      const baseUrl = String(p.baseUrl || p.base_url || p.url || '').trim();
      const apiKey = String(p.apiKey || p.api_key || p.key || p.token || '').trim();
      if (!name || !baseUrl) return null;
      const protocol = /anthropic/i.test(String(p.type || p.protocol || p.kind || '')) ? 'anthropic' : 'openai-compatible';
      return { id: 'ccswitch-' + name.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase(), name, protocol, baseUrl, apiKey };
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
