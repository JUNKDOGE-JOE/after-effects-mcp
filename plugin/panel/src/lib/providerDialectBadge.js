export const DEFAULT_DIALECT_SOURCE_LABELS = {
  'ccswitch-import': { zh: '来自 cc-switch', en: 'from cc-switch' },
  detected: { zh: '自动检测', en: 'auto-detected' },
  manual: { zh: '手动设置', en: 'manual' },
};

export function providerDialectBadge(dialect, lang = 'zh', sourceLabels = DEFAULT_DIALECT_SOURCE_LABELS) {
  if (!dialect || typeof dialect !== 'object') return null;
  const wireApi = String(dialect.wireApi || '').trim();
  const authScheme = String(dialect.authScheme || '').trim();
  if (!wireApi || !authScheme) return null;
  const source = sourceLabels[dialect.source] || sourceLabels.manual || DEFAULT_DIALECT_SOURCE_LABELS.manual;
  return {
    label: wireApi + ' · ' + authScheme,
    title: source[lang] || source.zh || source.en || '',
  };
}
