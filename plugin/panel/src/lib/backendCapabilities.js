// Backend capability descriptors. UI (chips + settings) renders ONLY from
// these - no hardcoded model ids or tier names anywhere else.
// Capability facts backed by official docs and observed backend behavior:
// - subscription has NO plan-availability API; curated list + friendly
//   open-turn error is the only honest shape.
// - effort levels: low/medium/high/xhigh/max; Sonnet 5 supports xhigh;
//   Sonnet 4.6 has no xhigh; Haiku hides unsupported tiers.
// - fast mode: direct API only (BYOK), Opus 4.x only, 3x price.
import { readZcodeDesktopModel } from '../cep/zcodeBackend.js';

export const CLAUDE_PRICE_USD_PER_MTOK = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

// adaptive: whether the model takes thinking {type:'adaptive'}. Haiku accepts
// effort, but adaptive thinking stays off so effort and adaptive decouple.
export const CLAUDE_MODELS = [
  { id: 'claude-fable-5', label: 'Fable 5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], adaptive: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', effortLevels: ['low', 'medium', 'high', 'xhigh'], adaptive: true },
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
    defaultModelId: 'claude-sonnet-5',
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

export function descriptorWithCustomModel(descriptor, modelId) {
  const id = String(modelId || '').trim();
  if (!id) return descriptor;
  const existing = descriptor.models.find((m) => m.id === id);
  const custom = existing || { id, label: id, effortLevels: [], cost: 2, adaptive: false };
  const rest = descriptor.models.filter((m) => m.id !== id);
  return {
    ...descriptor,
    models: [custom, ...rest],
    defaultModelId: id,
  };
}

export function codexStaticDescriptor() {
  const models = [
    { id: 'gpt-5.5', label: 'GPT-5.5', effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 2, adaptive: false },
    { id: 'gpt-5.4', label: 'GPT-5.4', effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 2, adaptive: false },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', effortLevels: ['low', 'medium', 'high', 'xhigh'], cost: 1, adaptive: false },
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

export function openCodeStaticDescriptor() {
  const models = [
    { id: 'north-mini-code-free', label: 'North Mini Code Free', effortLevels: [], cost: 1, adaptive: false },
  ];
  return {
    id: 'opencode',
    label: 'OpenCode',
    models,
    defaultModelId: 'north-mini-code-free',
    defaultEffort: null,
    supportsFast: () => false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: true,
  };
}

function providerEntries(providerResult) {
  if (Array.isArray(providerResult)) return providerResult.map((p) => [p && (p.id || p.providerID || p.providerId || p.name), p]);
  if (providerResult && Array.isArray(providerResult.providers)) {
    return providerResult.providers.map((p) => [p && (p.id || p.providerID || p.providerId || p.name), p]);
  }
  if (providerResult && typeof providerResult === 'object') return Object.entries(providerResult);
  return [];
}

function modelEntries(provider) {
  const models = provider && provider.models;
  if (Array.isArray(models)) return models.map((m) => [m && (m.id || m.modelID || m.modelId || m.name), m]);
  if (models && typeof models === 'object') return Object.entries(models);
  return [];
}

export function openCodeDescriptorFromModels(providerResult) {
  const models = [];
  for (const [providerKey, provider] of providerEntries(providerResult)) {
    const providerID = String((provider && (provider.id || provider.providerID || provider.providerId)) || providerKey || 'opencode');
    for (const [modelKey, raw] of modelEntries(provider)) {
      const modelId = String((raw && (raw.id || raw.modelID || raw.modelId)) || modelKey || '');
      if (!modelId) continue;
      models.push({
        id: providerID === 'opencode' ? modelId : providerID + '/' + modelId,
        label: (raw && (raw.name || raw.displayName || raw.display_name)) || modelId,
        effortLevels: [],
        cost: String(modelId).endsWith('-free') ? 1 : 2,
        adaptive: false,
      });
    }
  }

  if (!models.length) return openCodeStaticDescriptor();
  const defaultModel = models.find((m) => m.id === 'north-mini-code-free') || models.find((m) => String(m.id).endsWith('/north-mini-code-free')) || models[0];
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

// ZCode's app-server needs an explicit provider/model ref before it can create
// an embedded session. The desktop app stores the current builtin provider
// under ~/.zcode/v2/config.json; zcodeBackend reads it at runtime and this
// descriptor mirrors the common built-in plan fallback.
// Models come from session/create's settings.model.available:
// {label, ref:{modelId, providerId}, contextWindow}.
const ZCODE_EFFORT_LEVELS = ['nothink', 'high', 'max'];

export function zcodeStaticDescriptor() {
  const models = [
    { id: 'builtin:bigmodel-start-plan/GLM-5.2', label: 'GLM-5.2', effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false },
    { id: 'builtin:bigmodel-start-plan/GLM-5-Turbo', label: 'GLM-5 Turbo', effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false },
  ];
  return {
    id: 'zcode',
    label: 'ZCode',
    models,
    defaultModelId: 'builtin:bigmodel-start-plan/GLM-5.2',
    defaultEffort: 'high',
    supportsFast: () => false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: false,
  };
}

// Bug fix: before session/create returns a real model list, the descriptor
// used to fall back to zcodeStaticDescriptor()'s hardcoded
// 'builtin:bigmodel-start-plan/GLM-5.2' defaultModelId. That builtin id is
// NOT what actually gets sent to the ZCode app-server (zcodeBackend's
// currentModelRef falls through to the CLI config / ZCODE_BUILTIN_DEFAULT_MODEL
// when no explicit ref is chosen), so the settings display and the real
// send-time model could disagree, and a stale/invalid stored pref would get
// reconciled to the wrong (builtin) model instead of the CLI-configured one.
//
// While CLI inheritance is active (~/.zcode/cli/config.json names a model
// whose provider exists in the merged config), the single source of truth
// for "what will actually be sent" IS that CLI-configured model. Build a
// descriptor around it so display and reconciliation agree with send-time
// behavior. Only fall back to the static/builtin descriptor when there is
// truly no CLI-configured model available.
export function zcodeDynamicDescriptor({ env, fsImpl, platform } = {}) {
  let cliModel = '';
  try { cliModel = String(readZcodeDesktopModel({ env, fsImpl, platform }) || '').trim(); } catch (e) { /* ignore unreadable CLI config */ }
  if (!cliModel) return zcodeStaticDescriptor();
  const label = cliModel.includes('/') ? cliModel.slice(cliModel.indexOf('/') + 1) : cliModel;
  return {
    id: 'zcode',
    label: 'ZCode',
    models: [{ id: cliModel, label, effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false }],
    defaultModelId: cliModel,
    defaultEffort: 'high',
    supportsFast: () => false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: false,
  };
}

export function zcodeDescriptorFromModels(sessionCreateResult) {
  const available = sessionCreateResult && sessionCreateResult.settings && sessionCreateResult.settings.model && Array.isArray(sessionCreateResult.settings.model.available)
    ? sessionCreateResult.settings.model.available
    : [];
  const current = sessionCreateResult && sessionCreateResult.settings && sessionCreateResult.settings.model && sessionCreateResult.settings.model.current;
  const models = available.map((m) => {
    const ref = m.ref || {};
    const id = ref.modelId || m.label || '';
    const providerId = ref.providerId || '';
    return {
      id: providerId ? providerId + '/' + id : id,
      label: m.label || id,
      effortLevels: ZCODE_EFFORT_LEVELS,
      cost: 2,
      adaptive: false,
    };
  }).filter((m) => m.id);
  if (!models.length) return zcodeStaticDescriptor();
  const defaultId = current ? (current.providerId ? current.providerId + '/' + current.modelId : current.modelId) : models[0].id;
  return {
    id: 'zcode',
    label: 'ZCode',
    models,
    defaultModelId: models.some((m) => m.id === defaultId) ? defaultId : models[0].id,
    defaultEffort: 'medium',
    supportsFast: () => false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: false,
  };
}

// Probe-driven ZCode descriptor: when session/create's settings.model.available
// is empty (true for custom openai-compatible providers with no session-side
// enumeration), fall back to actively probing the CLI-configured provider's
// /v1/models endpoint (see cep/modelProbe.js's probeProviderModels, wired in
// App.jsx). The CLI-configured model (the one actually sent on the wire, per
// zcodeDynamicDescriptor's comment above) is pinned first and marked default;
// duplicate ids from the probe are dropped in favor of that pinned entry.
export function zcodeDescriptorFromProbedModels({ cliModel, providerId, probedModels } = {}) {
  const cli = String(cliModel || '').trim();
  if (!cli || !Array.isArray(probedModels) || !probedModels.length) return null;

  const pid = String(providerId || '').trim();
  const cliLabel = cli.includes('/') ? cli.slice(cli.indexOf('/') + 1) : cli;
  const rest = probedModels
    .map((m) => {
      const rawId = String((m && m.id) || '').trim();
      if (!rawId) return null;
      const id = pid ? pid + '/' + rawId : rawId;
      if (id === cli) return null;
      return { id, label: (m && m.label) || rawId, effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false };
    })
    .filter(Boolean);

  const models = [
    { id: cli, label: cliLabel, effortLevels: ZCODE_EFFORT_LEVELS, cost: 2, adaptive: false },
    ...rest,
  ];

  return {
    id: 'zcode',
    label: 'ZCode',
    models,
    defaultModelId: cli,
    defaultEffort: 'high',
    supportsFast: () => false,
    approvalModes: APPROVAL_MODES,
    perTurnModelSwitch: false,
  };
}

// Spec A2: custom-provider channels list what /v1/models actually returned;
// curated metadata (effort levels, cost) is reused when ids overlap. An
// empty/failed probe keeps the descriptor unchanged so the manual custom
// model id path still works.
export function descriptorFromProbedModels(descriptor, probedModels) {
  if (!Array.isArray(probedModels) || !probedModels.length) return descriptor;
  const curated = new Map(descriptor.models.map((m) => [m.id, m]));
  const models = probedModels.map((m) => {
    const known = curated.get(m.id);
    if (known) return known;
    return { id: m.id, label: m.label || m.id, effortLevels: [], cost: costTier(m.id), adaptive: false };
  });
  return { ...descriptor, models, defaultModelId: models[0].id };
}
