import { REAL_BACKENDS } from '../cep/backends/index.js';

export function pickBackend({ pref, probe, hasApiKey, codexProbe, zcodeProbe }) {
  if (pref === 'byok') {
    return hasApiKey ? { backend: 'byok', reason: 'ok' } : { backend: 'none', reason: 'no-key' };
  }

  if (pref === 'codex') {
    if (codexProbe === null) return { backend: 'none', reason: 'codex-probing' };
    if (!codexProbe || !codexProbe.loggedIn) return { backend: 'none', reason: 'codex-not-logged-in' };
    return { backend: 'codex', reason: 'ok' };
  }

  if (pref === 'zcode') {
    if (zcodeProbe === null) return { backend: 'none', reason: 'zcode-probing' };
    if (!zcodeProbe || !zcodeProbe.loggedIn) return { backend: 'none', reason: 'zcode-not-logged-in' };
    return { backend: 'zcode', reason: 'ok' };
  }

  if (probe === null) return { backend: 'none', reason: 'probing' };
  if (!probe.nodeOk) return hasApiKey ? { backend: 'byok', reason: 'no-node' } : { backend: 'none', reason: 'no-node' };
  if (!probe.loggedIn) return hasApiKey ? { backend: 'byok', reason: 'not-logged-in' } : { backend: 'none', reason: 'not-logged-in' };
  return { backend: 'subscription', reason: 'ok' };
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
