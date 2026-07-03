export function costBadge(tier) {
  const n = Math.max(1, Math.min(4, Number(tier) || 2));
  return '$'.repeat(n);
}

function byLang(item, lang, zhKey, enKey) {
  return lang === 'en' ? item[enKey] : item[zhKey];
}

export function buildComposerChips({
  descriptor,
  modelId,
  effort,
  fast,
  permissionMode,
  lang = 'zh',
}) {
  const models = descriptor.models || [];
  const currentModel = models.find((m) => m.id === modelId) || models[0] || {};
  const effortLevels = Array.isArray(currentModel.effortLevels) ? currentModel.effortLevels : [];
  const approvals = descriptor.approvalModes || [];
  const currentApproval = approvals.find((m) => m.id === permissionMode) || approvals[0] || {};
  const modelSwitchable = descriptor.perTurnModelSwitch !== false;

  return {
    model: modelSwitchable ? {
      current: currentModel.label || currentModel.id || '',
      items: models.map((m) => ({ id: m.id, label: m.label || m.id, caption: costBadge(m.cost) })),
    } : null,
    effort: effortLevels.length ? {
      current: effort,
      items: effortLevels.map((id) => ({ id, label: id, caption: '' })),
    } : null,
    fast: descriptor.supportsFast && descriptor.supportsFast(currentModel.id) ? { active: Boolean(fast) } : null,
    approval: {
      current: byLang(currentApproval, lang, 'zh', 'en') || currentApproval.id || '',
      items: approvals.map((m) => ({
        id: m.id,
        label: byLang(m, lang, 'zh', 'en') || m.id,
        caption: byLang(m, lang, 'anchorZh', 'anchorEn') || '',
      })),
    },
  };
}
