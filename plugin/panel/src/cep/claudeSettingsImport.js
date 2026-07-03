// Spec B3: one-click inherit of Claude Code's third-party endpoint config.
// Only reads the documented env block of ~/.claude/settings.json; the
// Claude-3p host-creds file is intentionally NOT read (internal format).
function getCepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) {
    return globalThis.window.cep_node.require;
  }
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  throw new Error('CEP Node require is unavailable');
}

export function readClaudeSettingsEnv({ env = {}, fsImpl } = {}) {
  const home = env.USERPROFILE || env.HOME || (env.HOMEDRIVE && env.HOMEPATH ? env.HOMEDRIVE + env.HOMEPATH : '');
  if (!home) return null;
  let fs;
  try { fs = fsImpl || getCepRequire()('fs'); } catch (e) { return null; }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(String(home).replace(/[\\/]+$/, '') + '\\.claude\\settings.json', 'utf8'));
  } catch (e) {
    return null;
  }
  const settingsEnv = parsed && parsed.env && typeof parsed.env === 'object' ? parsed.env : {};
  const baseUrl = String(settingsEnv.ANTHROPIC_BASE_URL || '').trim();
  const authToken = String(settingsEnv.ANTHROPIC_AUTH_TOKEN || '').trim();
  if (!baseUrl && !authToken) return null;
  return { baseUrl, authToken };
}
