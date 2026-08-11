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
// Quote the provider dropdown's REAL first-option label (SettingsScreen
// t.providerNone) — a paraphrase sends users hunting for an option that
// doesn't exist (live finding, 2026-08-11).
const PINNED_HINT = {
  zh: '已由自定义 provider 钉住：在下方下拉框选「（未选择 provider）」后自动解锁。',
  en: 'Pinned by the custom provider: pick "(no provider selected)" in the dropdown below to unlock.',
};

export function lockLabel(channel, lockedChannel, lang = 'zh') {
  const texts = channel === lockedChannel ? LOCK_TEXTS.locked : LOCK_TEXTS.unlocked;
  return texts[lang] || texts.zh;
}

// #224: while a provider selection pins the group's lock, every lock toggle in
// the group is ineffective (the App handler re-pins on any click), so all of
// them disable; the pinned row also explains the way out.
export function lockButtonState(channel, { lockedChannel = '', pinnedChannel = '' } = {}, lang = 'zh') {
  const pinnedGroup = Boolean(pinnedChannel);
  const pinned = pinnedGroup && channel === pinnedChannel;
  const texts = pinned || channel === lockedChannel ? LOCK_TEXTS.locked : LOCK_TEXTS.unlocked;
  return {
    label: texts[lang] || texts.zh,
    disabled: pinnedGroup,
    hint: pinned ? (PINNED_HINT[lang] || PINNED_HINT.zh) : '',
  };
}
