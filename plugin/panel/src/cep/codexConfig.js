// Spec A extension: inherit Codex CLI's ~/.codex/config.toml custom
// model_provider, mirroring the pattern already used for ZCode CLI
// inheritance (zcodeBackend.js) and Claude settings import
// (claudeSettingsImport.js).
//
// Minimal hand-rolled TOML parser — intentionally NOT a general-purpose
// TOML implementation. See module-level comment blocks near the parser for
// exactly what is (and is not) supported.

function stripInlineComment(line) {
  // Simple heuristic: a `#` that appears after the value's closing quote (or
  // anywhere outside of an open string) starts a comment. We don't attempt
  // full string-aware scanning beyond tracking whether we're inside a
  // double-quoted string, which covers this config shape.
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') inString = !inString;
    else if (ch === '#' && !inString) return line.slice(0, i);
  }
  return line;
}

function unquote(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// Supports ONLY:
//   - top-level `key = "value"` (or unquoted/bare value) pairs before any
//     section header
//   - `[section.dotted.path]` headers, most importantly `[model_providers.X]`
//   - `key = "value"` pairs within a section, attributed to that section
//   - `#` line comments and same-line trailing comments (best-effort, not
//     string-aware beyond simple double/single quote tracking)
// Does NOT support: arrays, inline tables, multi-line strings/literals,
// escaped-quote edge cases beyond a naive backslash check, dotted keys
// within a single line (`a.b = 1`), or non-TOML-standard shapes.
import { createPlatformAdapter } from './platform/index.js';
function parseToml(text) {
  const root = {};
  const sections = {};
  let current = root;
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const noComment = stripInlineComment(rawLine).trim();
    if (!noComment) continue;
    const sectionMatch = noComment.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      sections[name] = sections[name] || {};
      current = sections[name];
      continue;
    }
    const kvMatch = noComment.match(/^([^=]+)=(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1].trim();
    if (!key) continue;
    current[key] = unquote(kvMatch[2]);
  }
  return { root, sections };
}

export function readCodexCliConfig({ platform, fsImpl } = {}) {
  const adapter = platform || createPlatformAdapter();
  const home = adapter.paths.home;
  if (!home) return null;
  const fs = fsImpl || adapter.fs;
  if (!fs) return null;
  let text;
  try {
    text = fs.readFileSync(adapter.paths.join([home, '.codex', 'config.toml']), 'utf8');
  } catch (e) {
    return null;
  }
  let parsed;
  try {
    parsed = parseToml(text);
  } catch (e) {
    return null;
  }
  const model = String(parsed.root.model || '').trim();
  const providerId = String(parsed.root.model_provider || '').trim();
  if (!model && !providerId) return null;
  const result = { model, providerId, provider: null };
  if (providerId) {
    const section = parsed.sections['model_providers.' + providerId];
    if (section) {
      result.provider = {
        name: String(section.name || '').trim(),
        baseUrl: String(section.base_url || '').trim(),
        envKey: String(section.env_key || '').trim(),
        wireApi: String(section.wire_api || '').trim(),
      };
    }
  }
  return result;
}

export function resolveCodexProviderApiKey({ provider, env = {}, storedKey = '' } = {}) {
  const envKey = provider && String(provider.envKey || '').trim();
  if (envKey && env[envKey]) return String(env[envKey]);
  if (storedKey) return String(storedKey);
  return '';
}
