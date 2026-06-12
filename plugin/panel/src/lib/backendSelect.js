export function pickBackend({ pref, probe, hasApiKey }) {
  if (pref === 'byok') {
    return hasApiKey ? { backend: 'byok', reason: 'ok' } : { backend: 'none', reason: 'no-key' };
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
  if (next !== 'subscription' && next !== 'byok') return { reset: false, nextReal: prevReal || null };
  if (!prevReal) return { reset: false, nextReal: next };
  if (prevReal === next) return { reset: false, nextReal: prevReal };
  return { reset: true, nextReal: next };
}
