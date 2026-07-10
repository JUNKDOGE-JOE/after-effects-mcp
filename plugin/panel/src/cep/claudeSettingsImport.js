// Spec B3: one-click inherit of Claude Code's third-party endpoint config.
// Only reads the documented env block of ~/.claude/settings.json; the
// Claude-3p host-creds file is intentionally NOT read (internal format).
import { createPlatformAdapter } from './platform/index.js';

export function readClaudeSettingsEnv({ platform, fsImpl } = {}) {
  const adapter = platform || createPlatformAdapter();
  const home = adapter.paths.home;
  if (!home) return null;
  const fs = fsImpl || adapter.fs;
  if (!fs) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(adapter.paths.join([home, '.claude', 'settings.json']), 'utf8'));
  } catch (e) {
    return null;
  }
  const settingsEnv = parsed && parsed.env && typeof parsed.env === 'object' ? parsed.env : {};
  const baseUrl = String(settingsEnv.ANTHROPIC_BASE_URL || '').trim();
  const authToken = String(settingsEnv.ANTHROPIC_AUTH_TOKEN || '').trim();
  if (!baseUrl && !authToken) return null;
  return { baseUrl, authToken };
}
