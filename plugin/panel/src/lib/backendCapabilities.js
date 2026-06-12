// Backend capability descriptors. UI (chips + settings) renders ONLY from
// these - no hardcoded model ids or tier names anywhere else.
// Facts (verified 2026-06-12 against official docs):
// - subscription has NO plan-availability API; curated list + friendly
//   open-turn error is the only honest shape.
// - effort levels: low/medium/high/xhigh/max; xhigh is Fable/Opus 4.8 only;
//   Sonnet 4.6 has no xhigh; Haiku support unverified -> empty (chip hidden).
// - fast mode: direct API only (BYOK), Opus 4.x only, 3x price.

export const CLAUDE_PRICE_USD_PER_MTOK = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

// adaptive: whether the model takes thinking {type:'adaptive'}. Haiku accepts
// effort (live-probed 2026-06-12, effort:'high' turns succeed) but its
// adaptive-thinking support is unverified, so effort and adaptive decouple.
export const CLAUDE_MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', effortLevels: ['low', 'medium', 'high', 'max'], adaptive: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', effortLevels: ['low', 'medium', 'high'], adaptive: false },
];

export const APPROVAL_MODES = [
  { id: 'readonly', zh: '只读', en: 'Read-only', anchorZh: '仅放行只读工具 · dontAsk', anchorEn: 'read-only allowlist · dontAsk' },
  { id: 'manual', zh: '手动', en: 'Manual', anchorZh: '每个写操作弹卡 · canUseTool', anchorEn: 'every write asks · canUseTool' },
  { id: 'auto', zh: '自动', en: 'Auto', anchorZh: '仅破坏性弹卡 · 注解分级', anchorEn: 'destructive asks · annotations' },
  { id: 'none', zh: '免审', en: 'Bypass', anchorZh: '全放（仅 ae 工具）· dontAsk', anchorEn: 'allow all ae tools · dontAsk' },
];

const TIER_ORDER = [1, 3, 5, 10];

export function costTier(modelId) {
  const price = CLAUDE_PRICE_USD_PER_MTOK[modelId];
  if (!price) return 2;
  const idx = TIER_ORDER.indexOf(price.input);
  return idx === -1 ? 2 : idx + 1;
}

function withCost(models) {
  return models.map((m) => ({ ...m, cost: costTier(m.id) }));
}

export function claudeSubDescriptor() {
  return {
    id: 'claude-sub',
    label: '订阅',
    models: withCost(CLAUDE_MODELS),
    defaultModelId: 'claude-sonnet-4-6',
    defaultEffort: 'high',
    supportsFast: () => false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: true,
  };
}

export function byokStaticDescriptor() {
  return {
    ...claudeSubDescriptor(),
    id: 'byok',
    label: 'BYOK',
    supportsFast: (modelId) => /claude-opus-4-(6|7|8)/.test(String(modelId || '')),
  };
}

export function mergeByokModels(descriptor, apiModels) {
  if (!apiModels) return descriptor;
  const curated = new Map(descriptor.models.map((m) => [m.id, m]));
  const models = apiModels.map((m) => {
    const known = curated.get(m.id);
    if (known) return known;
    return { id: m.id, label: m.display_name || m.id, effortLevels: [], cost: costTier(m.id) };
  });
  return { ...descriptor, models };
}

export function codexStaticDescriptor() {
  const models = [
    { id: 'gpt-5.5', label: 'GPT-5.5', effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 2, adaptive: false },
    { id: 'gpt-5.4', label: 'GPT-5.4', effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 2, adaptive: false },
  ];
  return {
    id: 'codex',
    label: 'Codex',
    models,
    defaultModelId: 'gpt-5.5',
    defaultEffort: 'medium',
    supportsFast: (modelId) => modelId === 'gpt-5.5',
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: true,
  };
}

function modelListArray(modelListResult) {
  if (Array.isArray(modelListResult)) return modelListResult;
  if (modelListResult && Array.isArray(modelListResult.models)) return modelListResult.models;
  return [];
}

export function codexDescriptorFromModels(modelListResult) {
  const rawModels = modelListArray(modelListResult).filter((m) => m && m.hidden !== true);
  if (!rawModels.length) return codexStaticDescriptor();

  const fastModels = new Set();
  const models = rawModels.map((m) => {
    const id = String(m.id || '');
    if (Array.isArray(m.additionalSpeedTiers) && m.additionalSpeedTiers.includes('fast')) fastModels.add(id);
    return {
      id,
      label: m.displayName || m.display_name || id,
      effortLevels: Array.isArray(m.supportedReasoningEfforts)
        ? m.supportedReasoningEfforts.map((e) => e && e.reasoningEffort).filter(Boolean)
        : [],
      cost: 2,
      adaptive: false,
    };
  }).filter((m) => m.id);

  if (!models.length) return codexStaticDescriptor();
  const defaultRaw = rawModels.find((m) => m && m.hidden !== true && m.isDefault === true) || rawModels[0];
  const defaultModelId = defaultRaw && defaultRaw.id ? String(defaultRaw.id) : models[0].id;
  const defaultEffort = defaultRaw && defaultRaw.defaultReasoningEffort
    ? defaultRaw.defaultReasoningEffort
    : (models.find((m) => m.id === defaultModelId)?.effortLevels[0] || 'medium');

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
