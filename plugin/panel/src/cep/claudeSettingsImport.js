// Claude settings import follows the same preview-then-read contract as
// cc-switch. The preview contains only availability/base URL/source digest.
import { sha256Text } from './ccSwitch.js';

function settingsFile(env = {}) {
  const home = String(env.HOME || env.USERPROFILE || '').replace(/[\\/]+$/, '');
  if (!home) return '';
  const separator = home.includes('\\') ? '\\' : '/';
  return [home, '.claude', 'settings.json'].join(separator);
}

function parseSettings(text) {
  const parsed = JSON.parse(text);
  const settingsEnv = parsed?.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)
    ? parsed.env
    : {};
  const baseUrl = String(settingsEnv.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').trim();
  const secret = String(settingsEnv.ANTHROPIC_AUTH_TOKEN || '').trim();
  if (!secret) return null;
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null;
  const sensitiveName = /(?:^|[-_])(?:authorization|api[-_]?key|token|secret|password|auth)(?:$|[-_])/i;
  for (const name of url.searchParams.keys()) {
    if (sensitiveName.test(name)) return null;
  }
  return { baseUrl, secret };
}

function sourceChanged() {
  const error = new Error('Provider import source changed');
  error.code = 'provider_import_source_changed';
  return error;
}

export function inspectClaudeSettingsEnv({ env = {}, fsImpl } = {}) {
  const file = settingsFile(env);
  if (!file || !fsImpl?.readFileSync) return null;
  try {
    const text = String(fsImpl.readFileSync(file, 'utf8'));
    const settings = parseSettings(text);
    if (!settings) return null;
    return { available: true, baseUrl: settings.baseUrl, sourceRevision: sha256Text(text) };
  } catch {
    return null;
  }
}

export function readClaudeSettingsProviderDraft({ env = {}, expectedSourceRevision, fsImpl } = {}) {
  const file = settingsFile(env);
  if (!file || !expectedSourceRevision || !fsImpl?.readFileSync) throw sourceChanged();
  let text;
  try { text = String(fsImpl.readFileSync(file, 'utf8')); } catch { throw sourceChanged(); }
  if (sha256Text(text) !== expectedSourceRevision) throw sourceChanged();
  let settings;
  try { settings = parseSettings(text); } catch { throw sourceChanged(); }
  if (!settings) return null;
  return {
    name: 'Claude Code config',
    protocol: 'anthropic',
    baseUrl: settings.baseUrl,
    modelAuthKind: 'bearer',
    modelAuthSecret: settings.secret,
  };
}
