import React from 'react';
import { LangProvider, useLang } from './i18n';
import { StatusBar } from '../components/shell/StatusBar';
import { TabBar } from '../components/shell/TabBar';
import { EmptyState } from '../components/shell/EmptyState';
import { ConfirmDialog } from '../components/shell/ConfirmDialog';
import { SettingsScreen } from '../screens/SettingsScreen';
import { ActivityScreen } from '../screens/ActivityScreen';
import { WizardScreen } from '../screens/WizardScreen';
import { ConnectionDrawer } from '../screens/ConnectionDrawer';
import { ChatScreen } from '../screens/ChatScreen';
import { createAgentLoop } from '../lib/agentLoop';
import { revertToPreviousCheckpoint } from '../lib/activityModel';
import { pickBackend, deriveToolMeta, shouldResetOnBackendChange } from '../lib/backendSelect';
import { createMcpClient, resolveMcpCommand } from '../cep/mcpClient';
import { createApiKeyStore } from '../cep/apiKey';
import { probeClaudeLogin, resolveSidecarPath } from '../cep/claudeAuth';
import { createClaudeAgentBackend, resolveSystemNode } from '../cep/claudeAgentBackend';
import { createCodexBackend } from '../cep/codexBackend';
import { createOpenCodeBackend } from '../cep/openCodeBackend';
import { createZcodeBackend, summarizeZcodeConfig } from '../cep/zcodeBackend';
import { claudeChannels, codexChannels, zcodeChannels, migrateBackendPref } from '../lib/channels.js';
import { createProviderStore } from '../cep/providerStore';
import { ProviderManagerSection } from '../components/settings/ProviderManagerSection';
import { probeProviderModels } from '../cep/modelProbe';
import { detectCcSwitch } from '../cep/ccSwitch';
import { readClaudeSettingsEnv } from '../cep/claudeSettingsImport';
import { reduceEvent } from '../lib/chatEntries';
import { DEFAULT_MODEL, FALLBACK_MODEL } from '../lib/anthropic';
import { descriptorWithCustomModel } from '../lib/backendCapabilities';
import { selectDescriptor, isClaudeApiBackend, reconcileModelPref } from '../lib/descriptorSelect';
import { readCachedZcodeProbedModels, writeCachedZcodeProbedModels } from '../lib/zcodeModelCache';
import { baseDescriptorFor } from '../cep/backends/index.js';
import { cachedByokModels } from '../cep/modelsApi';
import { costBadge } from '../lib/composerOptions';
import { anthropicEndpoint, normalizeProviderProfile } from '../lib/providerProfile.js';
import { useActivity } from '../cep/useActivity';
import { isWizardDone, markWizardDone, clearWizardDone } from '../cep/firstRun';
import { useWizardWiring } from './wizardWiring';
import { runDiagnostics } from '../cep/diagnostics';
import { copyText } from '../lib/clipboard';
import { copyWizardConfig } from '../lib/wizardCopy.js';
import { createHostController, loadSavedPort, savePort, DEFAULT_PORT, buildMcpConfig, isValidPort } from '../cep/hostBridge';
import { loadExpertGuidance, saveExpertGuidance } from '../lib/expertGuidance.js';
import pkg from '../../package.json';
import { buildLogExport, exportFileName, keepLogLine } from '../lib/logExport.js';
import { writeLogExport, revealInExplorer } from '../cep/logExportFs.js';

// Re-export so app code has a single import surface; the helpers themselves live
// in lib/ so the test suite (node --test, which cannot parse JSX) can import them.
export { loadExpertGuidance, saveExpertGuidance };

const T = {
  zh: {
    connected: '服务运行中',
    starting: '正在启动...',
    error: '服务故障',
    paused: '已暂停 — AI 操作已被拦截',
    pauseAll: '暂停所有 AI 操作',
    resume: '恢复',
    chat: '对话',
    activity: '活动',
    settings: '设置',
    chatEmptyT: '内嵌对话即将开放',
    chatEmptyB: 'P5 上线。现在可通过 Claude Desktop 等客户端连接使用。',
    actEmptyT: '还没有操作记录',
    actEmptyB: 'AI 客户端执行的每个 AE 操作都会出现在这里。',
    regenTitle: '重新生成访问 Token？',
    regenBody: '所有已连接的 AI 客户端会立即失去访问权限，需要重启它们才能重新连接。',
    regenConfirm: '重新生成',
    cancel: '取消',
    pausedHint: '已暂停 — 恢复后才能发送',
    goSettings: '去设置',
  },
  en: {
    connected: 'Service running',
    starting: 'Starting...',
    error: 'Service error',
    paused: 'Paused — AI actions are blocked',
    pauseAll: 'Pause all AI actions',
    resume: 'Resume',
    chat: 'Chat',
    activity: 'Activity',
    settings: 'Settings',
    chatEmptyT: 'Built-in chat coming soon',
    chatEmptyB: 'Lands in P5. Connect via Claude Desktop etc. for now.',
    actEmptyT: 'No activity yet',
    actEmptyB: 'Every AE operation by an AI client will appear here.',
    regenTitle: 'Regenerate access token?',
    regenBody: 'Every connected AI client loses access immediately and must be restarted to reconnect.',
    regenConfirm: 'Regenerate',
    cancel: 'Cancel',
    pausedHint: 'Paused — resume to send',
    goSettings: 'Open Settings',
  },
};

const pkgVersion = pkg.version;

function readPref(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v || fallback;
  } catch (e) { return fallback; }
}
function writePref(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* best-effort */ }
}

const CODEX_MODELS_CACHE_KEY = 'ae_mcp_codex_models';
const CODEX_MODELS_CACHE_MS = 24 * 60 * 60 * 1000;

function readCachedCodexModels(storage) {
  try {
    const raw = storage.getItem(CODEX_MODELS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.models)) return null;
    if (Date.now() - Number(parsed.ts || 0) > CODEX_MODELS_CACHE_MS) return null;
    return parsed.models;
  } catch (e) {
    return null;
  }
}

function writeCachedCodexModels(storage, models) {
  try {
    storage.setItem(CODEX_MODELS_CACHE_KEY, JSON.stringify({ ts: Date.now(), models }));
  } catch (e) {
    // best-effort
  }
}

async function validateAnthropicKey(key, baseUrl = '') {
  // /v1/models is not CORS-enabled for direct browser access (verified in AE:
  // the preflight fails), so validate against /v1/messages — the endpoint the
  // chat actually uses — with a 1-token haiku ping. 401/403 = invalid key.
  const r = await fetch(anthropicEndpoint(baseUrl, '/v1/messages'), {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: FALLBACK_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  // Return {ok,status} (not a bare bool) so Settings can tell a rejected key
  // (401→"invalid key") from a transient failure (network throw→"try again").
  // A 401 is auth-normalized to status 401 regardless of the real code.
  const ok = r.ok;
  return { ok, status: ok ? 200 : (r.status === 403 ? 401 : r.status) };
}

const CLIENT_NAMES = {
  builtin: { zh: '面板内置对话', en: 'Built-in chat' },
  'claude-desktop': { zh: 'Claude Desktop', en: 'Claude Desktop' },
  'claude-code': { zh: 'Claude Code', en: 'Claude Code' },
  cursor: { zh: 'Cursor', en: 'Cursor' },
};

function cepRequire(mod) {
  if (window.cep_node && window.cep_node.require) return window.cep_node.require(mod);
  if (window.require) return window.require(mod);
  return null;
}

function Shell({ cs }) {
  const { lang, setLang } = useLang();
  const t = T[lang];
  const [tab, setTab] = React.useState('chat');
  const [status, setStatus] = React.useState({ state: 'starting', port: DEFAULT_PORT, error: null });
  const [paused, setPaused] = React.useState(false);
  const [logs, setLogs] = React.useState([]);
  const ctrl = React.useRef(null);
  const getHost = React.useCallback(() => (ctrl.current ? ctrl.current.getHost() : null), []);

  // First-run wizard
  const [wizardDone, setWizardDone] = React.useState(() => isWizardDone(window.localStorage));
  const [wizStep, setWizStep] = React.useState(1);
  const [wizClient, setWizClient] = React.useState('claude-desktop');

  // Connection drawer + diagnostics
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [connInfo, setConnInfo] = React.useState(null);
  const [diagnostics, setDiagnostics] = React.useState(null);

  // Activity feed (in-process subscription)
  const { events, clear } = useActivity(getHost);

  // Settings: live client registry + token regeneration
  const [clients, setClients] = React.useState([]);
  const [confirmRegen, setConfirmRegen] = React.useState(false);
  const [tokenEpoch, setTokenEpoch] = React.useState(0);

  // Embedded chat: API key, model/permission prefs, entry feed, agent loop
  const keyStore = React.useMemo(() => {
    try { return createApiKeyStore(); } catch (e) { return null; }
  }, []);
  const [apiKey, setApiKey] = React.useState(() => {
    try { return keyStore ? keyStore.readKey() : ''; } catch (e) { return ''; }
  });
  const [anthropicBaseUrl, setAnthropicBaseUrl] = React.useState(() => readPref('ae_mcp_anthropic_base_url', ''));
  const [codexApiKey, setCodexApiKey] = React.useState(() => {
    try { return keyStore ? keyStore.readKey('codex') : ''; } catch (e) { return ''; }
  });
  const [codexBaseUrl, setCodexBaseUrl] = React.useState(() => readPref('ae_mcp_codex_base_url', ''));
  const [customModel, setCustomModel] = React.useState(() => readPref('ae_mcp_custom_model', ''));
  const [model, setModel] = React.useState(() => readPref('ae_mcp_model', DEFAULT_MODEL));
  const [logLevel, setLogLevel] = React.useState(() => readPref('ae_mcp_log_level', 'info'));
  const logLevelRef = React.useRef(logLevel);
  logLevelRef.current = logLevel;
  const [sessionModel, setSessionModel] = React.useState(null);
  const [sessionEffort, setSessionEffort] = React.useState(null);
  const [sessionFast, setSessionFast] = React.useState(null);
  const [permissionMode, setPermissionMode] = React.useState(() => readPref('ae_mcp_perm_mode', 'manual'));
  const backendMigration = React.useMemo(() => migrateBackendPref(window.localStorage), []);
  const [backendPref, setBackendPref] = React.useState(() => backendMigration.pref);
  const [channelLock, setChannelLock] = React.useState(() => backendMigration.lockedChannel);
  const providerStore = React.useMemo(() => {
    try {
      const store = createProviderStore();
      store.migrateLegacy({
        readKey: (name) => { try { return keyStore ? keyStore.readKey(name) : ''; } catch (e) { return ''; } },
        readPref: (key) => readPref(key, ''),
      });
      return store;
    } catch (e) { return null; }
  }, [keyStore]);
  const [providers, setProviders] = React.useState(() => (providerStore ? providerStore.list() : []));
  const [claudeProviderId, setClaudeProviderId] = React.useState(() => readPref('ae_mcp_claude_provider', ''));
  const [codexProviderId, setCodexProviderId] = React.useState(() => readPref('ae_mcp_codex_provider', ''));
  const [expertGuidance, setExpertGuidance] = React.useState(() => loadExpertGuidance(window.localStorage));
  const [probe, setProbe] = React.useState(null);
  const [codexProbe, setCodexProbe] = React.useState(null);
  const [codexModels, setCodexModels] = React.useState(() => readCachedCodexModels(window.localStorage));
  const [zcodeProbe, setZcodeProbe] = React.useState(null);
  // Populated from the 'zcode-session-created' chat event (session/create's
  // result), used by selectDescriptor to build a live model list for the
  // zcode backend. See zcodeDescriptorFromModels in backendCapabilities.js.
  const [zcodeSessionModels, setZcodeSessionModels] = React.useState(null);
  // Probe-driven fallback (spec A2 applied to zcode): when session/create's
  // settings.model.available is empty (custom openai-compatible providers
  // have no session-side model enumeration), actively probe the CLI provider's
  // /v1/models endpoint. Seeded from the 1h localStorage cache so a fresh
  // panel load doesn't need to re-probe immediately. See lib/zcodeModelCache.js.
  const [zcodeProbedModels, setZcodeProbedModels] = React.useState(() => readCachedZcodeProbedModels(window.localStorage));
  const [chatEntries, setChatEntries] = React.useState([]);
  const [chatStreaming, setChatStreaming] = React.useState(false);
  const [thinkingActive, setThinkingActive] = React.useState(false);
  const customModelForBackend = backendPref === 'codex' ? customModel : '';
  const baseDescriptor = React.useMemo(() => descriptorWithCustomModel(baseDescriptorFor(backendPref, (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {}), customModelForBackend), [backendPref, customModelForBackend]);
  const [descriptor, setDescriptor] = React.useState(() => baseDescriptor);
  const requestedModel = sessionModel || model;
  const effectiveModel = descriptor.models.some((m) => m.id === requestedModel)
    ? requestedModel
    : (descriptor.defaultModelId || (descriptor.models[0] && descriptor.models[0].id) || requestedModel);
  const modelMeta = descriptor.models.find((m) => m.id === effectiveModel) || descriptor.models[0] || {};
  const effectiveEffort = sessionEffort || (modelMeta.effortLevels && modelMeta.effortLevels.length ? descriptor.defaultEffort : null);
  const effectiveFast = Boolean(sessionFast && descriptor.supportsFast(effectiveModel));
  const claudeApiProvider = React.useMemo(() => {
    const fromStore = providers.find((p) => p.id === claudeProviderId) || null;
    if (fromStore && fromStore.baseUrl && fromStore.apiKey) return fromStore;
    if (apiKey) return { id: 'legacy-anthropic', name: 'Claude API', protocol: 'anthropic', baseUrl: anthropicBaseUrl || 'https://api.anthropic.com', apiKey, probedModels: [], probedAt: 0 };
    return fromStore;
  }, [providers, claudeProviderId, apiKey, anthropicBaseUrl]);
  const codexCustomProvider = React.useMemo(() => {
    const fromStore = providers.find((p) => p.id === codexProviderId) || null;
    if (fromStore && fromStore.baseUrl && fromStore.apiKey) return fromStore;
    if (codexBaseUrl) return { id: 'legacy-codex', name: 'Codex custom', protocol: 'openai-compatible', baseUrl: codexBaseUrl, apiKey: codexApiKey, probedModels: [], probedAt: 0 };
    return fromStore;
  }, [providers, codexProviderId, codexBaseUrl, codexApiKey]);

  const [providerProbing, setProviderProbing] = React.useState('');
  const [providerProbeErrors, setProviderProbeErrors] = React.useState({});
  const ccSwitchFound = React.useMemo(() => {
    try { return detectCcSwitch({ env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {} }); } catch (e) { return null; }
  }, []);
  const providerManager = (
    <ProviderManagerSection
      lang={lang}
      providers={providers}
      probing={providerProbing}
      probeErrors={providerProbeErrors}
      ccSwitch={ccSwitchFound}
      onImportCcSwitch={() => {
        if (!ccSwitchFound || !providerStore) return;
        for (const entry of ccSwitchFound.providers) providerStore.upsert(entry);
        setProviders(providerStore.list());
      }}
      onUpsert={(entry) => {
        if (!providerStore) return;
        const existing = providerStore.get(entry.id);
        providerStore.upsert({ ...entry, probedModels: existing ? existing.probedModels : [], probedAt: existing ? existing.probedAt : 0 });
        setProviders(providerStore.list());
      }}
      onRemove={(id) => {
        if (!providerStore) return;
        providerStore.remove(id);
        setProviders(providerStore.list());
        if (claudeProviderId === id) { setClaudeProviderId(''); writePref('ae_mcp_claude_provider', ''); }
        if (codexProviderId === id) { setCodexProviderId(''); writePref('ae_mcp_codex_provider', ''); }
      }}
      onProbe={async (p) => {
        setProviderProbing(p.id);
        const result = await probeProviderModels({ baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol });
        setProviderProbing('');
        if (result.ok && providerStore) {
          providerStore.upsert({ ...p, probedModels: result.models, probedAt: Date.now() });
          setProviders(providerStore.list());
          setProviderProbeErrors((errs) => ({ ...errs, [p.id]: '' }));
        } else {
          setProviderProbeErrors((errs) => ({ ...errs, [p.id]: result.detail || ('HTTP ' + result.status) }));
        }
      }}
    />
  );
  const zcodeConfigSummary = React.useMemo(() => {
    try { return summarizeZcodeConfig({ env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {}, storedKey: (() => { try { return keyStore ? keyStore.readKey('zcode') : ''; } catch (e) { return ''; } })() }); } catch (e) { return null; }
    // zcodeProbe in deps: re-summarize after each re-check so pasted keys reflect immediately.
  }, [keyStore, zcodeProbe]);
  const channels = React.useMemo(() => ({
    claude: claudeChannels({ probe, apiProvider: claudeApiProvider }),
    codex: codexChannels({ codexProbe, customProvider: codexCustomProvider }),
    zcode: zcodeChannels({ zcodeProbe, configSummary: zcodeConfigSummary }),
  }), [probe, claudeApiProvider, codexProbe, codexCustomProvider, zcodeProbe, zcodeConfigSummary]);
  const claudeSettingsHint = React.useMemo(() => {
    try { return readClaudeSettingsEnv({ env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {} }); } catch (e) { return null; }
  }, []);
  const providerProfile = React.useMemo(() => normalizeProviderProfile({
    anthropicBaseUrl: claudeApiProvider ? claudeApiProvider.baseUrl : anthropicBaseUrl,
    codexApiKey: codexCustomProvider ? codexCustomProvider.apiKey : codexApiKey,
    codexBaseUrl: codexCustomProvider ? codexCustomProvider.baseUrl : codexBaseUrl,
  }), [claudeApiProvider, anthropicBaseUrl, codexCustomProvider, codexApiKey, codexBaseUrl]);
  const runtimeRef = React.useRef({ apiKey, apiBaseUrl: providerProfile.anthropicBaseUrl, providerProfile, model: effectiveModel, permissionMode, effort: effectiveEffort, thinking: null, fast: effectiveFast, claudeChannel: 'subscription', claudeApiProvider: null });
  const extRoot = cs && cs.getSystemPath ? cs.getSystemPath('extension') : '';
  const sidecarPath = React.useMemo(() => resolveSidecarPath({ extRoot }), [extRoot]);
  const mcp = React.useMemo(() => createMcpClient({
    extRoot,
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
  }), [extRoot]);
  const handleChatEvent = React.useCallback((evt) => {
    if (evt.type === 'turn-start') setChatStreaming(true);
    if (evt.type === 'thinking') setThinkingActive(!!evt.active);
    if (evt.type === 'turn-end' || evt.type === 'error') {
      setChatStreaming(false);
      setThinkingActive(false);
    }
    if (evt.type === 'zcode-session-created') setZcodeSessionModels(evt.result || null);
    setChatEntries((entries) => reduceEvent(entries, evt));
  }, []);

  const byokLoop = React.useMemo(() => {
    return createAgentLoop({
      getApiKey: () => runtimeRef.current.apiKey,
      getApiBaseUrl: () => runtimeRef.current.apiBaseUrl,
      getModel: () => runtimeRef.current.model,
      getPermissionMode: () => runtimeRef.current.permissionMode,
      getEffort: () => runtimeRef.current.effort,
      getFast: () => runtimeRef.current.fast,
      mcp,
      lang,
      onEvent: handleChatEvent,
    });
    // lang only affects the system prompt of FUTURE turns; recreating the loop
    // on language switch would drop the conversation, so we intentionally bind
    // the initial value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcp, handleChatEvent]);

  // Same as the BYOK loop: lang only affects future system prompts, so avoid
  // recreating the backend and silently dropping its conversation on language switch.
  const claudeBackend = React.useMemo(() => createClaudeAgentBackend({
    resolveNode: resolveSystemNode,
    sidecarPath,
    getMcpSpec: () => resolveMcpCommand({ extRoot }),
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getThinking: () => runtimeRef.current.thinking,
    getChannel: () => runtimeRef.current.claudeChannel || 'subscription',
    getApiProvider: () => runtimeRef.current.claudeApiProvider || null,
    lang,
    onEvent: handleChatEvent,
  }), [extRoot, sidecarPath, mcp, handleChatEvent]);

  const codexBackend = React.useMemo(() => createCodexBackend({
    getMcpSpec: () => resolveMcpCommand({ extRoot }),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getFast: () => runtimeRef.current.fast,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    getServerInstructions: () => mcp.getServerInstructions(),
    getProviderProfile: () => runtimeRef.current.providerProfile,
    lang,
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, mcp, handleChatEvent]);

  const openCodeBackend = React.useMemo(() => createOpenCodeBackend({
    getMcpSpec: () => resolveMcpCommand({ extRoot }),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, mcp, handleChatEvent]);

  const zcodeBackend = React.useMemo(() => createZcodeBackend({
    getMcpSpec: () => resolveMcpCommand({ extRoot }),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    getServerInstructions: () => mcp.getServerInstructions(),
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, mcp, handleChatEvent]);

  const nodeOk = !(probe && probe.nodeOk === false);
  const effective = pickBackend({ pref: backendPref, channels, lockedChannel: channelLock, nodeOk });
  runtimeRef.current = {
    apiKey: claudeApiProvider ? claudeApiProvider.apiKey : apiKey,
    apiBaseUrl: providerProfile.anthropicBaseUrl,
    providerProfile,
    model: effectiveModel,
    permissionMode,
    effort: effectiveEffort,
    thinking: modelMeta.adaptive === true ? 'adaptive' : null,
    fast: effectiveFast,
    claudeChannel: effective.backend === 'claude-api' ? 'api' : 'subscription',
    claudeApiProvider,
  };
  // Map real-backend id -> instance.
  const backendInstances = { subscription: claudeBackend, 'claude-api': claudeBackend, byok: byokLoop, codex: codexBackend, opencode: openCodeBackend, zcode: zcodeBackend };
  const activeBackend = backendInstances[effective.backend] || byokLoop;

  // Descriptor selection is keyed on the EFFECTIVE backend from pickBackend,
  // not backendPref: 'byok' never appears as a pref (migrateBackendPref maps
  // it away), only as an effective backend when Node is broken.
  React.useEffect(() => {
    let alive = true;
    const facts = {
      effectiveBackend: effective.backend,
      backendPref,
      baseDescriptor,
      customModel,
      claudeApiProvider,
      codexCustomProvider,
      byokApiModels: null,
      codexCachedModels: codexModels || readCachedCodexModels(window.localStorage),
      zcodeSessionModels,
      zcodeProbedModels,
    };
    const nextDescriptor = selectDescriptor(facts);
    setDescriptor(nextDescriptor);
    // Bug 2: a stale localStorage model id (from an older backend/session)
    // can silently outrank the descriptor's current defaultModelId. Reset it
    // when the current model isn't in the new descriptor's model list, but
    // exempt the codex custom-model path (customModel is intentionally not
    // in the curated list there).
    const isCustomModelPath = backendPref === 'codex' && customModelForBackend && model === customModelForBackend;
    const reconciled = reconcileModelPref(model, nextDescriptor, { isCustom: isCustomModelPath });
    if (reconciled !== model) {
      setModel(reconciled);
      writePref('ae_mcp_model', reconciled);
    }
    const hasProbed = Boolean(claudeApiProvider && claudeApiProvider.probedModels && claudeApiProvider.probedModels.length);
    const claudeKey = claudeApiProvider ? claudeApiProvider.apiKey : apiKey;
    if (isClaudeApiBackend(effective.backend) && claudeKey && !hasProbed) {
      cachedByokModels({ apiKey: claudeKey, baseUrl: claudeApiProvider ? claudeApiProvider.baseUrl : anthropicBaseUrl }).then((list) => {
        if (alive) setDescriptor(selectDescriptor({ ...facts, byokApiModels: list }));
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [effective.backend, backendPref, baseDescriptor, customModel, claudeApiProvider, codexCustomProvider, codexModels, apiKey, anthropicBaseUrl, zcodeSessionModels, zcodeProbedModels]);
  const activeBackendRef = React.useRef(null);

  // Probe the CLI-configured zcode provider's /v1/models when session data
  // hasn't supplied a usable model list yet. Only runs for custom providers
  // that expose a baseUrl and a resolved API key (summarizeZcodeConfig gives
  // us both facts); a stale/expired cache entry re-triggers a fresh probe.
  React.useEffect(() => {
    if (backendPref !== 'zcode') return undefined;
    if (zcodeSessionModels) return undefined;
    const cli = zcodeConfigSummary && zcodeConfigSummary.cli;
    if (!cli || !cli.model || !cli.baseUrl || !cli.hasCredential) return undefined;
    const cached = readCachedZcodeProbedModels(window.localStorage);
    if (cached && cached.cliModel === cli.model) {
      if (cached !== zcodeProbedModels) setZcodeProbedModels(cached);
      return undefined;
    }
    let alive = true;
    const providerId = cli.providerId || '';
    const apiKeyValue = (() => { try { return keyStore ? keyStore.readKey('zcode') : ''; } catch (e) { return ''; } })();
    probeProviderModels({ baseUrl: cli.baseUrl, apiKey: apiKeyValue, protocol: cli.protocol }).then((result) => {
      if (!alive) return;
      if (result.ok && result.models && result.models.length) {
        const entry = { cliModel: cli.model, providerId, probedModels: result.models };
        writeCachedZcodeProbedModels(window.localStorage, entry);
        setZcodeProbedModels(entry);
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [backendPref, zcodeSessionModels, zcodeConfigSummary, keyStore]);

  const runClaudeProbe = React.useCallback(() => {
    let alive = true;
    setProbe(null);
    probeClaudeLogin({
      resolveNode: resolveSystemNode,
      sidecarPath,
    }).then((result) => {
      if (alive) setProbe(result);
    }).catch((e) => {
      if (alive) setProbe({ loggedIn: false, nodeOk: false, detail: e && e.message ? e.message : String(e) });
    });
    return () => { alive = false; };
  }, [sidecarPath]);

  React.useEffect(() => {
    if (backendPref !== 'subscription') return undefined;
    return runClaudeProbe();
  }, [backendPref, runClaudeProbe]);

  const runCodexProbe = React.useCallback(() => {
    let alive = true;
    setCodexProbe(null);
    codexBackend.probeAccount().then((result) => {
      if (!alive) return;
      setCodexProbe(result);
      if (result && Array.isArray(result.models)) {
        setCodexModels(result.models);
        writeCachedCodexModels(window.localStorage, result.models);
      }
    }).catch((e) => {
      if (alive) setCodexProbe({ loggedIn: false, detail: e && e.message ? e.message : String(e) });
    });
    return () => { alive = false; };
  }, [codexBackend]);

  React.useEffect(() => {
    if (backendPref !== 'codex') return undefined;
    return runCodexProbe();
  }, [backendPref, runCodexProbe]);

  const runZcodeProbe = React.useCallback(() => {
    let alive = true;
    setZcodeProbe(null);
    zcodeBackend.probeAccount().then((result) => {
      if (alive) setZcodeProbe(result);
    }).catch((e) => {
      if (alive) setZcodeProbe({ loggedIn: false, detail: e && e.message ? e.message : String(e) });
    });
    return () => { alive = false; };
  }, [zcodeBackend]);

  React.useEffect(() => {
    if (backendPref !== 'zcode') return undefined;
    return runZcodeProbe();
  }, [backendPref, runZcodeProbe]);

  // ZCode session/send does not carry thoughtLevel, so a mid-conversation effort
  // change is pushed via the dedicated session/setThoughtLevel method.
  React.useEffect(() => {
    if (effective.backend !== 'zcode' || !effectiveEffort) return;
    zcodeBackend.setThoughtLevel(effectiveEffort);
  }, [effective.backend, effectiveEffort, zcodeBackend]);

  React.useEffect(() => {
    const decision = shouldResetOnBackendChange(activeBackendRef.current, effective.backend);
    activeBackendRef.current = decision.nextReal;
    if (!decision.reset) return;
    byokLoop.reset();
    claudeBackend.reset();
    codexBackend.reset();
    openCodeBackend.reset();
    zcodeBackend.reset();
    setChatEntries([]);
    setChatStreaming(false);
    setSessionModel(null);
    setSessionEffort(null);
    setSessionFast(null);
    if (decision.nextReal !== 'zcode') setZcodeSessionModels(null);
  }, [effective.backend, byokLoop, claudeBackend, codexBackend, openCodeBackend, zcodeBackend]);

  const sendChat = (text) => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    setChatEntries((entries) => entries.concat({ id: `user-${Date.now()}`, type: 'user-text', text: trimmed }));
    activeBackend.sendUser(trimmed);
  };

  const newChatSession = () => {
    activeBackend.reset();
    setChatStreaming(false);
    setChatEntries([]);
  };

  // Note: the log-level filter is intentionally applied at append time only; existing buffered lines are unaffected by later level changes.
  const pushLog = React.useCallback((m) => {
    if (!keepLogLine(logLevelRef.current, m)) return;
    setLogs((xs) => [...xs.slice(-199), `[${new Date().toLocaleTimeString()}] ${m}`]);
  }, []);

  const exportLogs = React.useCallback(() => {
    try {
      const text = buildLogExport({
        panelLogs: logs,
        hostInfo: { hostVersion: (connInfo && connInfo.hostVersion) || '-', pythonVersion: (connInfo && connInfo.pythonVersion) || '-' },
        sidecarTail: claudeBackend.getStderrTail ? claudeBackend.getStderrTail() : '',
        version: pkgVersion,
      });
      const file = writeLogExport({ text, fileName: exportFileName() });
      revealInExplorer(file, undefined, (err) => pushLog('Log export reveal failed: ' + (err && err.message ? err.message : String(err))));
      pushLog('Log exported: ' + file);
    } catch (e) {
      pushLog('Log export failed: ' + (e && e.message ? e.message : String(e)));
    }
  }, [logs, connInfo, claudeBackend, pushLog]);

  const undoToPreviousCheckpoint = React.useCallback(async () => {
    try {
      await revertToPreviousCheckpoint(mcp);
      pushLog('Reverted to previous checkpoint');
    } catch (e) {
      pushLog('Checkpoint revert failed: ' + (e && e.message ? e.message : String(e)));
    }
  }, [mcp, pushLog]);

  React.useEffect(() => {
    const port = loadSavedPort(window.localStorage) || DEFAULT_PORT;
    ctrl.current = createHostController({
      cs,
      onStatus: (state, p, error) => {
        setStatus({ state, port: p, error: error || null });
        if (state === 'ok') {
          savePort(window.localStorage, p);
          pushLog('Host ready on 127.0.0.1:' + p);
        }
        if (state === 'error') pushLog('Error: ' + (error || 'unknown'));
      },
      onLog: pushLog,
    });
    ctrl.current.start(port);
  }, [cs, pushLog]);

  // Keep connection info fresh while the drawer is open.
  React.useEffect(() => {
    if (!drawerOpen) return undefined;
    const update = () => {
      const h = getHost();
      if (h && h.getConnectionInfo) setConnInfo(h.getConnectionInfo());
    };
    update();
    const i = setInterval(update, 3000);
    return () => clearInterval(i);
  }, [drawerOpen, getHost]);

  // Keep the client registry fresh while Settings is visible.
  React.useEffect(() => {
    if (tab !== 'settings') return undefined;
    const update = () => {
      const h = getHost();
      if (h && h.getClients) setClients(h.getClients());
      if (h && h.getConnectionInfo) setConnInfo(h.getConnectionInfo());
    };
    update();
    const i = setInterval(update, 4000);
    return () => clearInterval(i);
  }, [tab, getHost]);

  const runDiag = React.useCallback(async () => {
    setDiagnostics('running');
    try {
      const items = await runDiagnostics({
        getHost,
        port: status.port,
        fs: cepRequire('fs'),
        os: cepRequire('os'),
        fetchImpl: window.fetch.bind(window),
      });
      setDiagnostics(items);
    } catch (e) {
      setDiagnostics([{ id: 'host-listening', ok: false, detail: String(e && e.message), fixHint: { zh: '诊断执行失败，重启面板后重试。', en: 'Diagnostics failed to run; reload the panel and retry.' } }]);
    }
  }, [getHost, status.port]);

  const togglePause = () => {
    const host = getHost();
    if (!host || typeof host.setPaused !== 'function') {
      pushLog('Pause unavailable: host not running');
      return;
    }
    const next = !paused;
    host.setPaused(next);
    setPaused(next);
    pushLog(next ? 'Paused: /exec is blocked' : 'Resumed');
  };

  const applyPort = (p) => {
    const port = parseInt(p, 10);
    if (!isValidPort(port)) {
      setStatus((s) => ({ ...s, state: 'error', error: 'Invalid port' }));
      pushLog('Invalid port');
      return;
    }
    if (ctrl.current) ctrl.current.restart(port);
  };

  const finishWizard = () => {
    markWizardDone(window.localStorage);
    setWizardDone(true);
  };

  const mcpConfigStr = JSON.stringify(buildMcpConfig(status.port, expertGuidance), null, 2);
  const claudeStatus = probe === null ? { state: 'checking' }
    : probe.nodeOk === false ? { state: 'no-node', detail: probe.detail }
    : probe.loggedIn === false ? { state: 'not-logged-in', detail: probe.detail }
    : { state: 'ready', nodeVersion: probe.nodeVersion };
  const wizard = useWizardWiring({ extRoot, lang, claudeStatus, recheckLogin: runClaudeProbe });

  if (!wizardDone) {
    return (
      <WizardScreen
        step={wizStep}
        lang={lang}
        onLangChange={setLang}
        client={wizClient}
        onClient={setWizClient}
        clientName={(CLIENT_NAMES[wizClient] || CLIENT_NAMES['claude-desktop'])[lang]}
        mcpConfig={mcpConfigStr}
        port={status.port}
        expertGuidance={expertGuidance}
        channels={channels}
        activeChannel={effective.channel || ''}
        onNext={() => setWizStep((s) => Math.min(3, s + 1))}
        onBack={() => setWizStep((s) => Math.max(1, s - 1))}
        onCopy={(text) => copyWizardConfig(copyText, mcpConfigStr, text)}
        onDone={finishWizard}
        onSkip={finishWizard}
        {...wizard.props}
      />
    );
  }

  const statusForBar = paused ? 'paused' : status.state === 'ok' ? 'connected' : status.state === 'starting' ? 'waiting' : 'error';
  const tabs = [
    { id: 'chat', icon: 'message-square', label: t.chat },
    { id: 'activity', icon: 'list-checks', label: t.activity },
    { id: 'settings', icon: 'settings', label: t.settings },
  ];
  const backendDisabledHint = (effective.fixHint && (effective.fixHint[lang] || effective.fixHint.zh))
    || (effective.reason && effective.reason.endsWith('-probing')
      ? (lang === 'zh' ? '正在检测凭据通道…' : 'Checking credential channels…')
      : '');
  const composerDisabled = paused || effective.backend === 'none';
  const modelOptions = descriptor.models.map((m) => ({ value: m.id, label: `${m.label} ${costBadge(m.cost)}` }));

  return (
    <React.Fragment>
      <StatusBar
        status={statusForBar}
        label={paused ? t.paused : status.state === 'ok' ? `${t.connected} · 127.0.0.1:${status.port}` : status.state === 'error' ? `${t.error} · ${status.error || ''}` : t.starting}
        onStatusClick={() => { setDrawerOpen(true); }}
        onTogglePause={togglePause}
        onSettings={() => setTab('settings')}
        pauseTitle={t.pauseAll}
        resumeTitle={t.resume}
        settingsTitle={t.settings}
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {tab === 'chat' ? (
          <ChatScreen
            lang={lang}
            entries={chatEntries}
            streaming={chatStreaming}
            thinking={thinkingActive}
            composerDisabled={composerDisabled}
            disabledHint={paused ? t.pausedHint : composerDisabled ? backendDisabledHint : ''}
            noticeActionLabel={paused ? t.resume : t.goSettings}
            onNoticeAction={() => (paused ? togglePause() : setTab('settings'))}
            onSend={sendChat}
            onStop={() => activeBackend.stop()}
            onApprove={(id, decision) => activeBackend.approve(id, decision)}
            onNewSession={newChatSession}
            chipState={{
              descriptor,
              modelId: effectiveModel,
              effort: effectiveEffort,
              fast: effectiveFast,
              permissionMode,
            }}
            onChipModel={setSessionModel}
            onChipEffort={setSessionEffort}
            onChipFast={(v) => setSessionFast(Boolean(v))}
            onChipApproval={(m) => { setPermissionMode(m); writePref('ae_mcp_perm_mode', m); }}
          />
        ) : null}
        {tab === 'activity' ? (
          <ActivityScreen
            events={events}
            lang={lang}
            onClear={clear}
            onUndoCheckpoint={undoToPreviousCheckpoint}
            emptyTitle={t.actEmptyT}
            emptyCaption={t.actEmptyB}
          />
        ) : null}
        {tab === 'settings' ? (
          <SettingsScreen
            key={tokenEpoch}
            lang={lang}
            onLangChange={setLang}
            port={status.port}
            onApplyPort={applyPort}
            mcpConfig={mcpConfigStr}
            logs={logs}
            clients={clients}
            onBlockClient={(label, v) => {
              const h = getHost();
              if (h && h.setClientBlocked) {
                h.setClientBlocked(label, v);
                if (h.getClients) setClients(h.getClients());
                pushLog((v ? 'Blocked client: ' : 'Unblocked client: ') + label);
              }
            }}
            onRegenToken={() => setConfirmRegen(true)}
            hostVersion={(connInfo && connInfo.hostVersion) || '-'}
            pythonVersion={(connInfo && connInfo.pythonVersion) || '-'}
            channels={channels}
            activeChannel={effective.channel || ''}
            lockedChannel={channelLock}
            onLockChannel={(c) => { setChannelLock(c); writePref('ae_mcp_channel_lock', c); }}
            onRecheckBackend={() => {
              if (backendPref === 'codex') runCodexProbe();
              else if (backendPref === 'zcode') runZcodeProbe();
              else runClaudeProbe();
            }}
            recheckDisabled={backendPref === 'codex' ? codexProbe === null : backendPref === 'zcode' ? zcodeProbe === null : probe === null}
            providers={providers}
            providerManager={providerManager}
            claudeProviderId={claudeProviderId}
            onClaudeProviderChange={(id) => { setClaudeProviderId(id); writePref('ae_mcp_claude_provider', id); }}
            codexProviderId={codexProviderId}
            onCodexProviderChange={(id) => { setCodexProviderId(id); writePref('ae_mcp_codex_provider', id); setCodexProbe(null); codexBackend.reset(); }}
            claudeSettingsImportAvailable={Boolean(claudeSettingsHint)}
            onImportClaudeSettings={() => {
              if (!claudeSettingsHint || !providerStore) return;
              const entry = providerStore.upsert({ id: 'claude-settings-import', name: 'Claude Code 配置', protocol: 'anthropic', baseUrl: claudeSettingsHint.baseUrl, apiKey: claudeSettingsHint.authToken });
              setProviders(providerStore.list());
              setClaudeProviderId(entry.id);
              writePref('ae_mcp_claude_provider', entry.id);
            }}
            onSaveZcodeKey={(k) => {
              if (keyStore) keyStore.writeKey(k, 'zcode');
              setZcodeProbe(null);
              zcodeBackend.reset();
              runZcodeProbe();
            }}
            zcodeKeyStored={(() => { try { return Boolean(keyStore && keyStore.readKey('zcode')); } catch (e) { return false; } })()}
            model={effectiveModel}
            modelOptions={modelOptions}
            modelSwitchable={descriptor.perTurnModelSwitch !== false}
            onModelChange={(m) => { setModel(m); writePref('ae_mcp_model', m); }}
            customModel={customModel}
            onCustomModelChange={(m) => {
              setCustomModel(m);
              writePref('ae_mcp_custom_model', m);
              if (String(m || '').trim()) {
                setModel(String(m || '').trim());
                writePref('ae_mcp_model', String(m || '').trim());
              }
            }}
            backend={backendPref}
            onBackendChange={(m) => { setBackendPref(m); writePref('ae_mcp_backend', m); }}
            expertGuidance={expertGuidance}
            onExpertGuidance={(v) => { setExpertGuidance(v); saveExpertGuidance(window.localStorage, v); }}
            logLevel={logLevel}
            onLogLevel={(v) => { setLogLevel(v); writePref('ae_mcp_log_level', v); }}
            onExportLogs={exportLogs}
            onRerunWizard={() => {
              clearWizardDone(window.localStorage);
              setWizStep(1);
              setWizardDone(false);
            }}
          />
        ) : null}
      </div>
      <TabBar tabs={tabs} active={tab} onChange={setTab} />
      <ConnectionDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        lang={lang}
        info={connInfo || {}}
        diagnostics={Array.isArray(diagnostics) ? diagnostics : []}
        onDiagnose={runDiag}
        onCopyConfig={() => copyText(mcpConfigStr)}
        onRestart={() => applyPort(status.port)}
      />
      <ConfirmDialog
        open={confirmRegen}
        danger
        title={t.regenTitle}
        body={t.regenBody}
        confirmLabel={t.regenConfirm}
        cancelLabel={t.cancel}
        onCancel={() => setConfirmRegen(false)}
        onConfirm={() => {
          const h = getHost();
          if (h && h.regenerateToken) {
            h.regenerateToken((err) => {
              pushLog(err ? 'Token regeneration failed: ' + err.message : 'Token regenerated');
            });
          }
          setConfirmRegen(false);
          setTokenEpoch((n) => n + 1);
        }}
      />
    </React.Fragment>
  );
}

export function App({ cs }) {
  return <LangProvider><Shell cs={cs} /></LangProvider>;
}
