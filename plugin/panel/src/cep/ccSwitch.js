// Optional cc-switch inheritance (spec A2): detect-only, never a wizard
// dependency. Third-party format is unstable -> tolerant field mapping.
const CONFIG_NAMES = ['config.json', 'providers.json'];
import { createPlatformAdapter } from './platform/index.js';

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

export function detectCcSwitch({ platform, fsImpl } = {}) {
  const adapter = platform || createPlatformAdapter();
  const fs = fsImpl || adapter.fs;
  if (!fs) return null;
  for (const dir of candidateDirs(adapter)) {
    for (const name of CONFIG_NAMES) {
      const file = adapter.paths.join([dir, name]);
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
