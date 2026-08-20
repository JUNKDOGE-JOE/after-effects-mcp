import { REAL_BACKENDS } from '../cep/backends/index.js';

const DEFAULT_CHANNEL = { claude: 'subscription', codex: 'cli', opencode: 'provider' };

// Channels are chosen by the user, never auto-picked (#229): the effective
// channel is exactly the enabled one. A broken choice surfaces its own
// fixHint instead of silently falling back to a sibling channel, and only
// the enabled channel's probe state gates sending.
export function pickBackend({ pref, channels = {}, channelChoices = {} }) {
  const group = ['codex', 'opencode'].includes(pref) ? pref : 'claude';
  const list = channels[group] || [];
  const wanted = channelChoices[group] || DEFAULT_CHANNEL[group];
  const chosen = list.find((c) => c && c.channel === wanted) || list[0] || null;
  if (chosen && chosen.checking) {
    return { backend: 'none', reason: group + '-probing', channel: null, fixHint: null };
  }
  if (!chosen || !chosen.ok) {
    return {
      backend: 'none',
      reason: group + '-no-channel',
      channel: chosen ? chosen.channel : null,
      fixHint: chosen ? chosen.fixHint || null : null,
    };
  }
  if (group === 'claude') {
    return { backend: 'subscription', reason: 'ok', channel: 'subscription', fixHint: null };
  }
  return { backend: group, reason: 'ok', channel: chosen.channel, fixHint: null };
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
