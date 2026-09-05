// Backend capability descriptors. UI (chips + settings) renders only from
// these, with no hardcoded model ids or tier names elsewhere.
//
// Claude ids are the API aliases (no date suffixes); the CLI passes them
// through unchanged. Account access is still decided by the selected CLI.
export const CLAUDE_PRICE_USD_PER_MTOK = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export const CLAUDE_MODELS = [
  {
    id: 'claude-fable-5-1', label: 'Fable 5.1',
    minCliVersion: '2.1.251',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true,
  },
  {
    id: 'claude-opus-5', label: 'Opus 5',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true,
  },
  {
    id: 'claude-sonnet-5', label: 'Sonnet 5',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true,
  },
  {
    id: 'claude-haiku-4-5', label: 'Haiku 4.5',
    effortLevels: ['low', 'medium', 'high'], adaptive: false,
  },
];

export const APPROVAL_MODES = [
  {
    id: 'readonly', zh: '只读', en: 'Read-only',
    anchorZh: '仅放行只读工具 · dontAsk', anchorEn: 'read-only allowlist · dontAsk',
  },
  {
    id: 'manual', zh: '手动', en: 'Manual',
    anchorZh: '每个写操作弹卡 · canUseTool', anchorEn: 'every write asks · canUseTool',
  },
  {
    id: 'auto', zh: '自动', en: 'Auto',
    anchorZh: '仅破坏性弹卡 · 注解分级', anchorEn: 'destructive asks · annotations',
  },
  {
    id: 'none', zh: '免审', en: 'Bypass',
    anchorZh: '全放（仅 ae 工具）· dontAsk', anchorEn: 'allow all ae tools · dontAsk',
  },
];

// Input USD/MTok thresholds for the four $ tiers shown on model chips.
const TIER_ORDER = [1, 2, 5, 10];

export function costTier(modelId) {
  const price = CLAUDE_PRICE_USD_PER_MTOK[modelId];
  if (!price) return 2;
  const index = TIER_ORDER.indexOf(price.input);
  return index === -1 ? 2 : index + 1;
}

function withCost(models) {
  return models.map((model) => ({ ...model, cost: costTier(model.id) }));
}

export function claudeSubDescriptor() {
  return {
    id: 'claude-sub',
    label: '订阅',
    models: withCost(CLAUDE_MODELS),
    defaultModelId: 'claude-opus-5',
    defaultEffort: 'high',
    supportsFast: () => false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: true,
  };
}

const CODEX_OFFICIAL_LOGIN_56_MODELS = [
  {
    id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    cost: 2, adaptive: false,
  },
  {
    id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    cost: 2, adaptive: false,
  },
  {
    id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    cost: 2, adaptive: false,
  },
];
const CODEX_OFFICIAL_LOGIN_56_MODEL_IDS = new Set(
  CODEX_OFFICIAL_LOGIN_56_MODELS.map((model) => model.id),
);

function codexOfficialLogin56Models() {
  return CODEX_OFFICIAL_LOGIN_56_MODELS.map((model) => ({
    ...model,
    effortLevels: [...model.effortLevels],
  }));
}

// Offline fallback used until model/list answers. Mirrors the inventory
// codex-cli 0.144.1 reports for an official login (checked 2026-09-02); live
// model/list data always replaces it.
const CODEX_STATIC_EXTRA_MODELS = [
  {
    id: 'gpt-5.5', label: 'GPT-5.5',
    effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 2, adaptive: false,
  },
  {
    id: 'gpt-5.4', label: 'GPT-5.4',
    effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 2, adaptive: false,
  },
  {
    id: 'gpt-5.4-mini', label: 'GPT-5.4 mini',
    effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 1, adaptive: false,
  },
  {
    id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark',
    effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 1, adaptive: false,
  },
];
const CODEX_STATIC_FAST_MODEL_IDS = new Set([
  ...CODEX_OFFICIAL_LOGIN_56_MODEL_IDS,
  'gpt-5.5',
  'gpt-5.4',
]);

export function codexStaticDescriptor() {
  return {
    id: 'codex',
    label: 'Codex',
    models: [
      ...codexOfficialLogin56Models(),
      ...CODEX_STATIC_EXTRA_MODELS.map((model) => ({
        ...model,
        effortLevels: [...model.effortLevels],
      })),
    ],
    defaultModelId: 'gpt-5.6-sol',
    defaultEffort: 'medium',
    supportsFast: (modelId) => CODEX_STATIC_FAST_MODEL_IDS.has(String(modelId || '')),
    catalogVerified: false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: true,
  };
}

function modelListArray(modelListResult) {
  if (Array.isArray(modelListResult)) return modelListResult;
  if (Array.isArray(modelListResult?.models)) return modelListResult.models;
  // Codex app-server 0.149 returns model/list as { data: [...] }.
  return Array.isArray(modelListResult?.data) ? modelListResult.data : [];
}

export function codexDescriptorFromModels(modelListResult) {
  const rawModels = modelListArray(modelListResult).filter((model) => model?.id && model.hidden !== true);

  const fastModels = new Set();
  const models = rawModels.map((model) => {
    const id = String(model.id || '');
    if ((Array.isArray(model.additionalSpeedTiers) && model.additionalSpeedTiers.includes('fast'))
        || (Array.isArray(model.serviceTiers) && model.serviceTiers.some((tier) => tier?.id === 'priority'))) {
      fastModels.add(id);
    }
    return {
      id,
      label: model.displayName || model.display_name || id,
      effortLevels: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.map((effort) => effort?.reasoningEffort)
          .filter(Boolean)
        : [],
      defaultEffort: model.defaultReasoningEffort,
      cost: 2,
      adaptive: false,
    };
  }).filter((model) => model.id);

  const defaultRaw = rawModels.find((model) => model.id === 'gpt-6-astra')
    || rawModels.find((model) => model.isDefault === true) || rawModels[0];
  const defaultModelId = defaultRaw?.id ? String(defaultRaw.id) : '';
  const defaultEffort = defaultRaw?.defaultReasoningEffort
    || models.find((model) => model.id === defaultModelId)?.effortLevels[0]
    || 'medium';
  return {
    id: 'codex',
    label: 'Codex',
    models,
    catalogVerified: true,
    defaultModelId,
    defaultEffort,
    supportsFast: (modelId) => fastModels.has(String(modelId || '')),
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: true,
  };
}

export function openCodeStaticDescriptor() {
  return {
    id: 'opencode',
    label: 'OpenCode',
    models: [
      {
        id: 'hy3-free', label: 'HY 3 Free',
        effortLevels: [], cost: 1, adaptive: false,
      },
    ],
    defaultModelId: 'hy3-free',
    defaultEffort: null,
    supportsFast: () => false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: true,
  };
}

function providerEntries(providerResult) {
  if (Array.isArray(providerResult)) {
    return providerResult.map((provider) => [
      provider?.id || provider?.providerID || provider?.providerId || provider?.name,
      provider,
    ]);
  }
  if (Array.isArray(providerResult?.providers)) {
    return providerResult.providers.map((provider) => [
      provider?.id || provider?.providerID || provider?.providerId || provider?.name,
      provider,
    ]);
  }
  return providerResult && typeof providerResult === 'object'
    ? Object.entries(providerResult)
    : [];
}

function modelEntries(provider) {
  if (Array.isArray(provider?.models)) {
    return provider.models.map((model) => [
      model?.id || model?.modelID || model?.modelId || model?.name,
      model,
    ]);
  }
  return provider?.models && typeof provider.models === 'object'
    ? Object.entries(provider.models)
    : [];
}

export function openCodeDescriptorFromModels(providerResult) {
  const models = [];
  for (const [providerKey, provider] of providerEntries(providerResult)) {
    const providerId = String(
      provider?.id || provider?.providerID || provider?.providerId || providerKey || 'opencode',
    );
    for (const [modelKey, raw] of modelEntries(provider)) {
      const modelId = String(raw?.id || raw?.modelID || raw?.modelId || modelKey || '');
      if (!modelId) continue;
      models.push({
        id: providerId === 'opencode' ? modelId : `${providerId}/${modelId}`,
        label: raw?.name || raw?.displayName || raw?.display_name || modelId,
        effortLevels: [],
        cost: modelId.endsWith('-free') ? 1 : 2,
        adaptive: false,
      });
    }
  }
  if (!models.length) return openCodeStaticDescriptor();
  const defaultModel = models.find((model) => model.id === 'hy3-free')
    || models.find((model) => model.id.endsWith('/hy3-free'))
    || models[0];
  return {
    id: 'opencode',
    label: 'OpenCode',
    models,
    defaultModelId: defaultModel.id,
    defaultEffort: null,
    supportsFast: () => false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: true,
  };
}

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function resolveEffectiveEffort({ requested, model, defaultEffort }) {
  const levels = Array.isArray(model?.effortLevels) ? model.effortLevels : [];
  if (!levels.length) return null;
  if (requested && levels.includes(requested)) return requested;
  if (requested && EFFORT_ORDER.includes(requested)) {
    const ranked = levels
      .filter((level) => EFFORT_ORDER.includes(level))
      .sort((left, right) => EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right));
    const atOrBelow = ranked.filter(
      (level) => EFFORT_ORDER.indexOf(level) <= EFFORT_ORDER.indexOf(requested),
    );
    if (atOrBelow.length) return atOrBelow[atOrBelow.length - 1];
    if (ranked.length) return ranked[0];
  }
  if (defaultEffort && levels.includes(defaultEffort)) return defaultEffort;
  return levels[0];
}
