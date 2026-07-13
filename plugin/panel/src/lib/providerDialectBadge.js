import { effectiveProviderDialect } from './providerProfile.js';
import { providerRouteLabel, selectProviderRoute } from './providerRouteSelection.js';

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
  const source = provider.dialect?.override?.source === 'manual' ? 'manual' : 'detected';
  return {
    label: wireApi,
    title: translatedLabel(source, lang, sourceLabels),
  };
}

const CLIENT_LABELS = Object.freeze({
  codex: 'Codex',
  'claude-code': 'Claude',
});

export function providerClientRouteBadge(provider, {
  client,
  modelId,
  lang = 'zh',
  now,
} = {}) {
  const clientLabel = CLIENT_LABELS[client];
  if (!clientLabel) return null;
  const selectedModelId = String(modelId || '').trim();
  if (!selectedModelId) {
    return {
      label: `${clientLabel} · ${lang === 'en' ? 'select model' : '请选模型'}`,
      title: lang === 'en'
        ? 'Select a model to inspect its Provider route.'
        : '选择模型后可查看该 Provider 的逐模型选路。',
      status: 'warn',
    };
  }
  const route = selectProviderRoute(provider, {
    client,
    modelId: selectedModelId,
    feature: 'generate',
    now,
  });
  if (route.ok) {
    return {
      label: `${clientLabel} · ${providerRouteLabel(route, lang)}`,
      title: lang === 'en'
        ? `Current route for ${selectedModelId}`
        : `${selectedModelId} 的当前选路`,
      status: 'neutral',
    };
  }
  if (route.reasonCode === 'needs-probe') {
    return {
      label: `${clientLabel} · ${lang === 'en' ? 'probe required' : '需探测'}`,
      title: lang === 'en'
        ? `Probe ${selectedModelId} before selecting a protocol route.`
        : `需先探测 ${selectedModelId} 的协议与 Agent 特性。`,
      status: 'warn',
    };
  }
  return {
    label: `${clientLabel} · ${lang === 'en' ? 'unavailable' : '不可用'}`,
    title: lang === 'en'
      ? `No verified route is available for ${selectedModelId}.`
      : `${selectedModelId} 暂无已验证的可用选路。`,
    status: 'error',
  };
}
