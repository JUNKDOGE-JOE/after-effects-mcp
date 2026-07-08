import { REAL_BACKENDS } from '../cep/backends/index.js';
import { pickChannel } from './channels.js';

// Spec D: one selection algorithm for all backends, fed by uniform channel
// probe arrays. `pref` is the 3-way backend choice (subscription|codex|zcode);
// channels = { claude: [...], codex: [...], zcode: [...] }.
export function pickBackend({ pref, channels = {}, lockedChannel = '', nodeOk = true, apiProvider = null }) {
  const group = pref === 'codex' || pref === 'zcode' ? pref : 'claude';
  const list = channels[group] || [];
  if (list.some((c) => c && c.checking)) {
    return { backend: 'none', reason: group + '-probing', channel: null, fixHint: null };
  }
  const chosen = pickChannel(list, lockedChannel);
  if (!chosen || !chosen.ok) {
    const hintSource = chosen || list.find((c) => c && !c.ok) || list[0] || null;
    return {
      backend: 'none',
      reason: group + '-no-channel',
      channel: chosen ? chosen.channel : null,
      fixHint: hintSource ? hintSource.fixHint || null : null,
    };
  }
  if (group === 'claude') {
    if (chosen.channel === 'api') {
      const canUseAgentSdk = nodeOk && isOfficialAnthropicProvider(apiProvider);
      return { backend: canUseAgentSdk ? 'claude-api' : 'byok', reason: 'ok', channel: 'api', fixHint: null };
    }
    return { backend: 'subscription', reason: 'ok', channel: 'subscription', fixHint: null };
  }
  return { backend: group, reason: 'ok', channel: chosen.channel, fixHint: null };
}

function isOfficialAnthropicProvider(provider) {
  const baseUrl = provider && provider.baseUrl ? String(provider.baseUrl) : 'https://api.anthropic.com';
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.anthropic.com';
  } catch (e) {
    return /(^|\/)api\.anthropic\.com(\/|$)/i.test(baseUrl);
  }
}
export function deriveToolMeta(tools) {
  const allowedTools = [];
  const annotations = {};

  for (const tool of tools || []) {
    const name = 'mcp__ae__' + tool.name;
    const ann = (tool && tool.annotations) || {};
    const readOnly = ann.readOnlyHint === true;
    const destructive = ann.destructiveHint === true;
    if (readOnly) allowedTools.push(name);
    annotations[name] = { readOnly, destructive };
  }

  return { allowedTools, annotations };
}

export function shouldResetOnBackendChange(prevReal, next) {
  if (!REAL_BACKENDS.includes(next)) return { reset: false, nextReal: prevReal || null };
  if (!prevReal) return { reset: false, nextReal: next };
  if (prevReal === next) return { reset: false, nextReal: prevReal };
  return { reset: true, nextReal: next };
}

