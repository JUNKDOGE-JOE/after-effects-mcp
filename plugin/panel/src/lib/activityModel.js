export function eventTitle(evt, lang) {
  const raw = evt.undoGroup || '';
  const m = /^MCP\s+([^:]+):?\s*(.*)$/.exec(raw);
  if (m) return m[2] ? `${m[1].trim()} · ${m[2].trim()}` : m[1].trim();
  if (raw) return raw;
  return lang === 'zh' ? '原始脚本' : 'Raw script';
}

export function eventOutcome(evt) {
  if (evt.denied === 'paused') return 'denied-paused';
  if (evt.denied === 'blocked') return 'denied-blocked';
  if (evt.denied) return 'denied';
  return evt.ok ? 'ok' : 'error';
}

export function filterEvents(events, { mode, query }) {
  let out = events;
  if (mode === 'failed') out = out.filter((e) => eventOutcome(e) !== 'ok');
  const q = (query || '').trim().toLowerCase();
  if (q) {
    out = out.filter((e) => [e.undoGroup, e.client, e.error].some((s) => s && String(s).toLowerCase().includes(q)));
  }
  return out;
}
