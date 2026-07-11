import { effectiveProviderDialect } from './providerProfile.js';

export const DEFAULT_DIALECT_SOURCE_LABELS = {
  'ccswitch-import': { zh: '来自 cc-switch', en: 'from cc-switch' },
  'legacy-v0.9': { zh: '旧版设置', en: 'legacy setting' },
  detected: { zh: '自动检测', en: 'auto-detected' },
  manual: { zh: '手动设置', en: 'manual' },
  unconfirmed: { zh: '未确认', en: 'unconfirmed' },
};

function translatedLabel(source, lang, sourceLabels) {
  const labels = sourceLabels || DEFAULT_DIALECT_SOURCE_LABELS;
  const entry = labels[source] || DEFAULT_DIALECT_SOURCE_LABELS[source];
  return entry?.[lang] || entry?.zh || entry?.en || '';
}

export function providerDialectBadge(
  provider,
  lang = 'zh',
  sourceLabels = DEFAULT_DIALECT_SOURCE_LABELS,
  options = {},
) {
  if (!provider || provider.protocol !== 'openai-compatible') return null;
  const wireApi = effectiveProviderDialect(provider, options);
  if (!wireApi) {
    return {
      label: 'unconfirmed',
      title: translatedLabel('unconfirmed', lang, sourceLabels),
    };
  }
  const source = provider.dialect?.override ? provider.dialect.override.source : 'detected';
  return {
    label: wireApi,
    title: translatedLabel(source, lang, sourceLabels),
  };
}
