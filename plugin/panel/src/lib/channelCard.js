// Presentation logic for channel cards (spec A: status dot + source badge +
// fixHint). Kept out of JSX so node --test covers it.
export function channelDot(probe) {
  if (!probe || probe.checking) return 'neutral';
  return probe.ok ? 'ok' : 'warn';
}

export function channelTexts(probe, lang = 'zh') {
  const pick = (obj) => (obj ? (obj[lang] || obj.zh || '') : '');
  return {
    source: pick(probe && probe.source),
    detail: (probe && probe.detail) || '',
    fixHint: probe && !probe.ok && !probe.checking ? pick(probe.fixHint) : '',
  };
}

export function lockLabel(channel, lockedChannel, lang = 'zh') {
  const locked = channel === lockedChannel;
  if (lang === 'en') return locked ? 'Locked' : 'Lock';
  return locked ? '已锁定' : '锁定';
}
