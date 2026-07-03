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

const LOCK_TEXTS = {
  locked: { zh: '已锁定', en: 'Locked' },
  unlocked: { zh: '锁定', en: 'Lock' },
};

export function lockLabel(channel, lockedChannel, lang = 'zh') {
  const texts = channel === lockedChannel ? LOCK_TEXTS.locked : LOCK_TEXTS.unlocked;
  return texts[lang] || texts.zh;
}
