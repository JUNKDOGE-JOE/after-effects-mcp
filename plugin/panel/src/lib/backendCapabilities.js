// Backend capability descriptors. UI (chips + settings) renders only from
// these, with no hardcoded model ids or tier names elsewhere.
export const CLAUDE_PRICE_USD_PER_MTOK = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

export const CLAUDE_MODELS = [
  {
    id: 'claude-fable-5', label: 'Fable 5',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true,
  },
  {
    id: 'claude-opus-4-8', label: 'Opus 4.8',
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true,
  },
  {
    id: 'claude-sonnet-5', label: 'Sonnet 5',
    effortLevels: ['low', 'medium', 'high', 'xhigh'], adaptive: true,
  },
  {
    id: 'claude-sonnet-4-6', label: 'Sonnet 4.6',
    effortLevels: ['low', 'medium', 'high', 'max'], adaptive: true,
  },
  {
    id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',
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

const TIER_ORDER = [1, 3, 5, 10];

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
    defaultModelId: 'claude-sonnet-5',
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

export function codexStaticDescriptor() {
  return {
    id: 'codex',
    label: 'Codex',
    models: [
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
    ],
    defaultModelId: 'gpt-5.5',
    defaultEffort: 'medium',
    supportsFast: (modelId) => modelId === 'gpt-5.5',
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: true,
  };
}

export function mergeCodexOfficialLoginModels(descriptor) {
  const models = Array.isArray(descriptor?.models) ? descriptor.models : [];
  const present = new Set(models.map((model) => model?.id).filter(Boolean));
  const missing = codexOfficialLogin56Models().filter((model) => !present.has(model.id));
  const supportsFast = typeof descriptor?.supportsFast === 'function'
    ? descriptor.supportsFast
    : () => false;
  return {
    ...descriptor,
    models: missing.length ? [...models, ...missing] : models,
    supportsFast: (modelId) => CODEX_OFFICIAL_LOGIN_56_MODEL_IDS.has(String(modelId || ''))
      || supportsFast(modelId),
  };
}

function modelListArray(modelListResult) {
  if (Array.isArray(modelListResult)) return modelListResult;
  if (Array.isArray(modelListResult?.models)) return modelListResult.models;
  // Codex app-server 0.149 returns model/list as { data: [...] }.
  return Array.isArray(modelListResult?.data) ? modelListResult.data : [];
}

export function codexDescriptorFromModels(modelListResult) {
  const rawModels = modelListArray(modelListResult).filter((model) => model?.hidden !== true);
  if (!rawModels.length) return codexStaticDescriptor();

  const fastModels = new Set();
  const models = rawModels.map((model) => {
    const id = String(model.id || '');
    if (Array.isArray(model.additionalSpeedTiers)
        && model.additionalSpeedTiers.includes('fast')) {
      fastModels.add(id);
    }
    return {
      id,
      label: model.displayName || model.display_name || id,
      effortLevels: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.map((effort) => effort?.reasoningEffort)
          .filter(Boolean)
        : [],
      cost: 2,
      adaptive: false,
    };
  }).filter((model) => model.id);

  if (!models.length) return codexStaticDescriptor();
  const defaultRaw = rawModels.find((model) => model?.isDefault === true) || rawModels[0];
  const defaultModelId = defaultRaw?.id ? String(defaultRaw.id) : models[0].id;
  const defaultEffort = defaultRaw?.defaultReasoningEffort
    || models.find((model) => model.id === defaultModelId)?.effortLevels[0]
    || 'medium';
  return {
    id: 'codex',
    label: 'Codex',
    models,
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
