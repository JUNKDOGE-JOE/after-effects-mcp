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

const CHOICE_TEXTS = {
  active: { zh: '使用中', en: 'In use' },
  choose: { zh: '使用此通道', en: 'Use this channel' },
};

// #229: channels are explicitly enabled by the user — one active row per
// backend group, no auto-pick and no lock. The active row's control is a
// state marker; every other row offers to switch.
export function channelChoiceState(channel, selectedChannel, lang = 'zh') {
  const active = channel === selectedChannel;
  const texts = active ? CHOICE_TEXTS.active : CHOICE_TEXTS.choose;
  return { label: texts[lang] || texts.zh, active };
}
