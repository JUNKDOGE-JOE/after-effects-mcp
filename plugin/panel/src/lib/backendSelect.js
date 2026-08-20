import { REAL_BACKENDS } from '../cep/backends/index.js';

const DEFAULT_CHANNEL = { claude: 'subscription', codex: 'cli', zcode: 'cli-config' };

// Channels are chosen by the user, never auto-picked (#229): the effective
// channel is exactly the enabled one. A broken choice surfaces its own
// fixHint instead of silently falling back to a sibling channel, and only
// the enabled channel's probe state gates sending.
export function pickBackend({ pref, channels = {}, channelChoices = {} }) {
  const group = pref === 'codex' || pref === 'zcode' ? pref : 'claude';
  const list = channels[group] || [];
  const wanted = channelChoices[group] || DEFAULT_CHANNEL[group];
  const chosen = list.find((c) => c && c.channel === wanted) || list[0] || null;
  if (chosen && chosen.checking) {
    return { backend: 'none', reason: group + '-probing', channel: null, fixHint: null };
  }
  if (group === 'codex' && chosen?.channel === 'custom' && chosen.canPreflight === true && !chosen.ok) {
    return { backend: 'codex', reason: 'provider-preflight', channel: 'custom', fixHint: null };
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
    if (chosen.channel === 'api') {
      // The Claude CLI receives only a loopback route token; upstream Provider
      // credentials stay in the panel-owned route.
      return { backend: 'claude-api', reason: 'ok', channel: 'api', fixHint: null };
    }
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
