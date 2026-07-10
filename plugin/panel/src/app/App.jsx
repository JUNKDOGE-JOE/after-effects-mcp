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
import { createProviderSecretService, resolveProviderRequestProfile } from '../cep/providerSecrets';
import { migrateProviderStoreSecrets } from '../cep/providerMigration';
import { createSecretMigrationRunner } from '../cep/platform/secret-migration';
import { deleteProviderProfile, drainPendingProviderSecretDeletes, importProviderDraft, saveProviderDraft } from './providerProfileFlow';
import { providerInitFailure } from './providerInitState';
import { ProviderManagerSection } from '../components/settings/ProviderManagerSection';
import { probeProviderModels } from '../cep/modelProbe';
import { detectCcSwitch, readCcSwitchProviderDrafts } from '../cep/ccSwitch';
import { inspectClaudeSettingsEnv, readClaudeSettingsProviderDraft } from '../cep/claudeSettingsImport';
import { codexCliCredentialAvailable, readCodexCliConfig, resolveCodexCliCredential } from '../cep/codexConfig';
import { reduceEvent } from '../lib/chatEntries';
import { DEFAULT_MODEL } from '../lib/anthropic';
import { descriptorWithCustomModel } from '../lib/backendCapabilities';
import { selectDescriptor, isClaudeApiBackend, reconcileModelPref } from '../lib/descriptorSelect';
import { readCachedZcodeProbedModels, writeCachedZcodeProbedModels } from '../lib/zcodeModelCache';
import { baseDescriptorFor } from '../cep/backends/index.js';
import { cachedByokModels } from '../cep/modelsApi';
import { costBadge } from '../lib/composerOptions';
import { codexRuntimeProviderProfile } from '../lib/providerProfile.js';
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
import { reconcileStableJsonValue } from '../lib/stableValue.js';
import { createPlatformAdapter } from '../cep/platform/index.js';
import { readCepSystemPath } from '../cep/platform/paths.js';

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

function randomProviderCredentialId() {
  const cryptoImpl = cepRequire('crypto');
  if (!cryptoImpl || typeof cryptoImpl.randomUUID !== 'function') throw new Error('Secure UUID generation is unavailable');
  return cryptoImpl.randomUUID();
}

function createProviderMigrationJournalStore(platform) {
  const fs = platform.fs;
  const root = platform.paths.migrationRoot;
  const file = platform.paths.join([root, 'provider-store-v1-to-v2.json']);
  return {
    async read(migrationId) {
      if (migrationId !== 'provider-store-v1-to-v2') {
        const error = new Error('Invalid provider migration id');
        error.code = 'INVALID_MIGRATION_JOURNAL';
        throw error;
      }
      try { return JSON.parse(String(fs.readFileSync(file, 'utf8'))); } catch (error) {
        if (error?.code === 'ENOENT' || !fs.existsSync(file)) return null;
        const invalid = new Error('Provider migration journal is invalid');
        invalid.code = 'INVALID_MIGRATION_JOURNAL';
        throw invalid;
      }
    },
    async writeAtomic(journal) {
      if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
      const tmp = platform.paths.join([root, `provider-store-v1-to-v2.${Date.now()}.tmp`]);
      try {
        fs.writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
        try { fs.chmodSync(tmp, 0o600); } catch { /* best effort on Windows */ }
        fs.renameSync(tmp, file);
      } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        const unavailable = new Error('Provider migration journal is unavailable');
        unavailable.code = 'INVALID_MIGRATION_JOURNAL';
        throw unavailable;
      }
    },
  };
}

function createHostSecretStore(host) {
  if (!host || typeof host.secretGet !== 'function' || typeof host.secretSet !== 'function' || typeof host.secretDelete !== 'function') {
    const error = new Error('Provider secret store is unavailable');
    error.code = 'SECRET_STORE_UNAVAILABLE';
    throw error;
  }
  return {
    get: (reference) => host.secretGet(reference),
    set: (input) => host.secretSet(input),
    delete: (input) => host.secretDelete(input),
  };
}

const PLATFORM_HELPER_METHODS = Object.freeze([
  'capabilities',
  'secret.get',
  'secret.set',
  'secret.delete',
  'window.find',
  'window.describe',
  'window.capture',
]);
const PLATFORM_CAPABILITY_KEYS = Object.freeze([
  'authenticatedCaller',
  'captureBackend',
  'helperVersion',
  'maxMessageBytes',
  'methods',
  'platform',
  'protocolVersion',
  'secretBackend',
]);

function requireProviderHelperCapabilities(value, platformId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerRuntimeUnavailableError();
  const keys = Object.keys(value).sort();
  if (keys.length !== PLATFORM_CAPABILITY_KEYS.length || !keys.every((key, index) => key === PLATFORM_CAPABILITY_KEYS[index])) {
    throw providerRuntimeUnavailableError();
  }
  const methods = Array.isArray(value.methods) ? value.methods : [];
  const methodSet = new Set(methods);
  if (
    value.protocolVersion !== 1
    || value.authenticatedCaller !== true
    || value.platform !== platformId
    || typeof value.helperVersion !== 'string'
    || !value.helperVersion.trim()
    || !['keychain', 'credential-manager'].includes(value.secretBackend)
    || !['screen-capture-kit', 'windows-graphics-capture'].includes(value.captureBackend)
    || value.maxMessageBytes !== 65536
    || methods.length !== PLATFORM_HELPER_METHODS.length
    || methodSet.size !== PLATFORM_HELPER_METHODS.length
    || !PLATFORM_HELPER_METHODS.every((method) => methodSet.has(method))
  ) {
    throw providerRuntimeUnavailableError();
  }
  return value;
}

function activeProviderSecretRefs(providers) {
  const byReference = new Map();
  const add = (ref) => {
    if (ref?.kind !== 'secret') return;
    const existing = byReference.get(ref.reference);
    if (existing !== undefined && existing !== ref.revision) {
      const error = new Error('Provider secret reference revisions conflict.');
      error.code = 'SECRET_CONFLICT';
      throw error;
    }
    byReference.set(ref.reference, ref.revision);
  };
  for (const provider of providers) {
    add(provider.auth?.model?.valueRef);
    add(provider.auth?.probe?.valueRef);
    for (const header of provider.headers || []) add(header.valueRef);
  }
  return Array.from(byReference, ([reference, revision]) => ({ kind: 'secret', reference, revision }));
}

function providerRuntimeUnavailableError() {
  const error = new Error('Repair the platform Helper and re-check provider credentials.');
  error.code = 'PLATFORM_HELPER_REPAIR_REQUIRED';
  return error;
}

function probeApiKeyFromProfile(profile) {
  if (profile?.extraHeaders?.length) throw new Error('Provider probe requires the v2 detector');
  if (profile?.auth?.kind === 'none') return '';
  if (profile?.auth?.kind !== 'header') throw new Error('Provider probe authentication is unsupported');
  if (String(profile.auth.name).toLowerCase() === 'authorization') {
    return String(profile.auth.value || '').replace(/^Bearer\s+/i, '');
  }
  if (String(profile.auth.name).toLowerCase() === 'x-api-key') return String(profile.auth.value || '');
  throw new Error('Provider probe requires the v2 detector');
}

function modelMetadataContainsCredential(models, credential) {
  let serialized;
  try { serialized = JSON.stringify(models); } catch { return true; }
  return serialized.includes('aemcp-secret://') || (credential ? serialized.includes(credential) : false);
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

  // Embedded chat: provider references, model/permission prefs, entry feed.
  // Resolved provider values exist only inside a request/probe/spawn call.
  const platform = React.useMemo(() => createPlatformAdapter(), []);
  const keyStore = React.useMemo(() => {
    try { return createApiKeyStore(); } catch (e) { return null; }
  }, []);
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
    try { return createProviderStore(); } catch (e) { return null; }
  }, []);
  const providerSecretService = React.useMemo(() => createProviderSecretService({
    getHost,
    randomBytes: (size) => cepRequire('crypto').randomBytes(size),
  }), [getHost]);
  const [providerInit, setProviderInit] = React.useState({ state: 'checking', error: '' });
  const [providers, setProviders] = React.useState([]);
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
    return providers.find((provider) => provider.id === claudeProviderId && provider.protocol === 'anthropic') || null;
  }, [providers, claudeProviderId]);
  const codexCustomProvider = React.useMemo(() => {
    return providers.find((provider) => provider.id === codexProviderId && provider.protocol === 'openai-compatible') || null;
  }, [providers, codexProviderId]);

  const [providerProbing, setProviderProbing] = React.useState('');
  const [providerProbeErrors, setProviderProbeErrors] = React.useState({});
  const ccSwitchFound = React.useMemo(() => {
    try { return detectCcSwitch({ platform, fsImpl: platform.fs }); } catch (e) { return null; }
  }, [platform]);
  const providerManager = (
    <ProviderManagerSection
      lang={lang}
      providers={providers}
      probing={providerProbing}
      probeErrors={providerProbeErrors}
      disabled={providerInit.state !== 'ready'}
      ccSwitch={ccSwitchFound}
      onImportCcSwitch={async () => {
        if (!ccSwitchFound || !providerStore) return;
        if (providerInit.state !== 'ready') throw providerRuntimeUnavailableError();
        let drafts = null;
        try {
          drafts = readCcSwitchProviderDrafts({
            file: ccSwitchFound.file,
            expectedSourceRevision: ccSwitchFound.sourceRevision,
            fsImpl: platform.fs,
          });
          for (let index = 0; index < drafts.length; index += 1) {
            let draft = drafts[index];
            try {
              await importProviderDraft({ candidate: draft, store: providerStore, secretService: providerSecretService, randomUUID: randomProviderCredentialId });
            } finally {
              drafts[index] = null;
              draft = null;
            }
          }
          setProviders(providerStore.list());
        } finally {
          drafts = null;
        }
      }}
      onUpsert={async (event, draft) => {
        if (!providerStore) return;
        if (providerInit.state !== 'ready') throw providerRuntimeUnavailableError();
        const formElement = event.currentTarget;
        const form = new FormData(event.currentTarget);
        let ephemeralDraft = {
          ...draft,
          modelAuthSecret: String(form.get('modelAuthSecret') || ''),
          probeAuthSecret: String(form.get('probeAuthSecret') || ''),
          headers: (draft.headers || []).map((header) => header.valueKind === 'secret'
            ? { ...header, secret: String(form.get(`headerSecret:${header.id}`) || '') }
            : { ...header }),
        };
        form.delete('modelAuthSecret');
        form.delete('probeAuthSecret');
        for (const header of draft.headers || []) form.delete(`headerSecret:${header.id}`);
        formElement?.reset?.();
        try {
          const existing = providerStore.get(draft.id);
          await saveProviderDraft({
            draft: ephemeralDraft,
            current: existing,
            store: providerStore,
            secretService: providerSecretService,
            confirmInsecureHttp: async ({ baseUrl }) => window.confirm(`Allow provider requests over insecure HTTP?\n${baseUrl}`),
            randomUUID: randomProviderCredentialId,
          });
          setProviders(providerStore.list());
        } finally {
          ephemeralDraft.modelAuthSecret = '';
          ephemeralDraft.probeAuthSecret = '';
          ephemeralDraft.headers.forEach((header) => { if (header.secret) header.secret = ''; });
          ephemeralDraft = null;
        }
      }}
      onRemove={async (provider) => {
        if (!providerStore) return;
        if (providerInit.state !== 'ready') throw providerRuntimeUnavailableError();
        await deleteProviderProfile({ provider, store: providerStore, secretService: providerSecretService });
        setProviders(providerStore.list());
        if (claudeProviderId === provider.id) { setClaudeProviderId(''); writePref('ae_mcp_claude_provider', ''); }
        if (codexProviderId === provider.id) { setCodexProviderId(''); writePref('ae_mcp_codex_provider', ''); }
      }}
      onProbe={async (provider) => {
        if (providerInit.state !== 'ready') throw providerRuntimeUnavailableError();
        setProviderProbing(provider.id);
        let requestProfile = null;
        let credential = '';
        try {
          requestProfile = await resolveProviderRequestProfile(provider, { scope: 'probe', secretService: providerSecretService });
          credential = probeApiKeyFromProfile(requestProfile);
          const result = await probeProviderModels({
            baseUrl: requestProfile.baseUrl,
            ['apiKey']: credential,
            protocol: provider.protocol,
            allowInsecureHttp: requestProfile.allowInsecureHttp === true,
          });
          if (result.ok && providerStore && !modelMetadataContainsCredential(result.models, credential)) {
            const current = providerStore.get(provider.id);
            if (current) providerStore.upsert({ ...current, probedModels: result.models, probedAt: Date.now() }, { expectedRevision: providerStore.readState().revision });
            setProviders(providerStore.list());
            setProviderProbeErrors((errors) => ({ ...errors, [provider.id]: '' }));
          } else {
            setProviderProbeErrors((errors) => ({ ...errors, [provider.id]: result.detail || (`HTTP ${result.status}`) }));
          }
        } catch (error) {
          setProviderProbeErrors((errors) => ({ ...errors, [provider.id]: error?.message || 'Provider probe failed' }));
        } finally {
          credential = '';
          requestProfile = null;
          setProviderProbing('');
        }
      }}
    />
  );
  const zcodeConfigSummary = React.useMemo(() => {
    try { return summarizeZcodeConfig({ env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {}, storedKey: (() => { try { return keyStore ? keyStore.readKey('zcode') : ''; } catch (e) { return ''; } })() }); } catch (e) { return null; }
    // zcodeProbe in deps: re-summarize after each re-check so pasted keys reflect immediately.
  }, [keyStore, zcodeProbe]);
  const codexCliConfigStableRef = React.useRef(null);
  // Spec A extension: inherit a custom model_provider declared in
  // ~/.codex/config.toml (mirrors zcodeConfigSummary above).
  const codexCliConfig = React.useMemo(() => {
    let next;
    try { next = readCodexCliConfig({ env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {} }); } catch (e) { next = null; }
    // Probe state re-reads config.toml, but equal content must not recreate
    // process-owning backends through referential churn.
    codexCliConfigStableRef.current = reconcileStableJsonValue(codexCliConfigStableRef.current, next);
    return codexCliConfigStableRef.current.value;
  }, [codexProbe]);
  const codexCliCredentialReady = React.useMemo(() => {
    const env = (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {};
    return codexCliCredentialAvailable({ provider: codexCliConfig && codexCliConfig.provider, env, storedValueRef: null });
  }, [codexCliConfig]);
  const channels = React.useMemo(() => ({
    claude: claudeChannels({ probe, apiProvider: claudeApiProvider, providerAvailable: providerInit.state === 'ready' && Boolean(claudeApiProvider), providerChecking: providerInit.state === 'checking' }),
    codex: codexChannels({ codexProbe, customProvider: codexCustomProvider, customProviderAvailable: providerInit.state === 'ready' && Boolean(codexCustomProvider), customProviderCredentialResolverReady: false, providerChecking: providerInit.state === 'checking', cliConfig: codexCliConfig, cliCredentialAvailable: codexCliCredentialReady }),
    zcode: zcodeChannels({ zcodeProbe, configSummary: zcodeConfigSummary }),
  }), [probe, claudeApiProvider, codexProbe, codexCustomProvider, zcodeProbe, zcodeConfigSummary, codexCliConfig, codexCliCredentialReady, providerInit.state]);
  const nodeOk = !(probe && probe.nodeOk === false);
  const effective = pickBackend({ pref: backendPref, channels, lockedChannel: channelLock, nodeOk });
  const claudeSettingsHint = React.useMemo(() => {
    try { return inspectClaudeSettingsEnv({ platform, fsImpl: platform.fs }); } catch (e) { return null; }
  }, [platform]);
  const providerProfile = React.useMemo(() => codexRuntimeProviderProfile({
    effectiveChannel: effective.channel,
    customProvider: codexCustomProvider,
    customProviderCredentialResolverReady: false,
  }), [effective.channel, codexCustomProvider]);
  const runtimeRef = React.useRef({ providerProfile, model: effectiveModel, permissionMode, effort: effectiveEffort, thinking: null, fast: effectiveFast, claudeChannel: 'subscription', claudeApiProvider: null });
  const extRoot = React.useMemo(() => readCepSystemPath({ cs, platform }), [cs, platform]);
  const sidecarPath = React.useMemo(() => resolveSidecarPath({ extRoot, platform }), [extRoot, platform]);
  const mcp = React.useMemo(() => createMcpClient({
    platform,
    extRoot,
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
  }), [extRoot, platform]);
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
      resolveRequestProfile: () => {
        const provider = runtimeRef.current.claudeApiProvider;
        if (!provider) throw new Error('Anthropic provider is unavailable');
        return resolveProviderRequestProfile(provider, { scope: 'model', secretService: providerSecretService });
      },
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
  }, [mcp, handleChatEvent, providerSecretService]);

  // Same as the BYOK loop: lang only affects future system prompts, so avoid
  // recreating the backend and silently dropping its conversation on language switch.
  const claudeBackend = React.useMemo(() => createClaudeAgentBackend({
    platform,
    resolveNode: resolveSystemNode,
    sidecarPath,
    getMcpSpec: () => resolveMcpCommand({ extRoot, platform }),
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getThinking: () => runtimeRef.current.thinking,
    getChannel: () => runtimeRef.current.claudeChannel || 'subscription',
    resolveApiProvider: () => {
      const provider = runtimeRef.current.claudeApiProvider;
      if (!provider) throw new Error('Anthropic provider is unavailable');
      return resolveProviderRequestProfile(provider, { scope: 'model', secretService: providerSecretService });
    },
    lang,
    onEvent: handleChatEvent,
  }), [extRoot, sidecarPath, mcp, handleChatEvent, platform, providerSecretService]);

  const codexBackend = React.useMemo(() => createCodexBackend({
    platform,
    getMcpSpec: () => resolveMcpCommand({ extRoot, platform }),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getFast: () => runtimeRef.current.fast,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    getServerInstructions: () => mcp.getServerInstructions(),
    getProviderProfile: () => runtimeRef.current.providerProfile,
    getCliConfigProvider: () => null,
    lang,
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, mcp, handleChatEvent, platform]);

  React.useEffect(() => () => {
    codexBackend.reset();
  }, [codexBackend]);

  const openCodeBackend = React.useMemo(() => createOpenCodeBackend({
    platform,
    getMcpSpec: () => resolveMcpCommand({ extRoot, platform }),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, mcp, handleChatEvent, platform]);

  const zcodeBackend = React.useMemo(() => createZcodeBackend({
    platform,
    getMcpSpec: () => resolveMcpCommand({ extRoot, platform }),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    getServerInstructions: () => mcp.getServerInstructions(),
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, mcp, handleChatEvent, platform]);

  React.useEffect(() => () => {
    zcodeBackend.reset();
  }, [zcodeBackend]);

  runtimeRef.current = {
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
      effectiveChannel: effective.channel,
      backendPref,
      baseDescriptor,
      customModel,
      claudeApiProvider,
      codexCustomProvider,
      customProviderCredentialResolverReady: false,
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
    if (isClaudeApiBackend(effective.backend) && claudeApiProvider && !hasProbed) {
      (async () => {
        let requestProfile = null;
        try {
          requestProfile = await resolveProviderRequestProfile(claudeApiProvider, { scope: 'probe', secretService: providerSecretService });
          const list = await cachedByokModels({
            providerId: claudeApiProvider.id,
            baseUrl: claudeApiProvider.baseUrl,
            authProfileRevision: claudeApiProvider.authProfileRevision,
            requestProfile,
          });
          if (alive) setDescriptor(selectDescriptor({ ...facts, byokApiModels: list }));
        } catch { /* cache/probe is best effort */ } finally {
          requestProfile = null;
        }
      })();
    }
    return () => { alive = false; };
  }, [effective.backend, effective.channel, backendPref, baseDescriptor, customModel, claudeApiProvider, codexCustomProvider, codexModels, zcodeSessionModels, zcodeProbedModels, providerSecretService]);
  const activeBackendRef = React.useRef(null);

  // Probe the CLI-configured zcode provider's /v1/models when session data
  // hasn't supplied a usable model list yet. Only runs for custom providers
  // that expose a baseUrl and a resolved API key (summarizeZcodeConfig gives
  // us both facts); a stale/expired cache entry re-triggers a fresh probe.
  React.useEffect(() => {
    if (backendPref !== 'zcode') return undefined;
    // Only a session result that actually enumerates a choice (>1 model)
    // makes probing unnecessary. probeAccount's session/create on custom
    // providers returns a truthy result whose available list is empty or
    // only names the current model — that must NOT suppress the probe.
    const sessionAvailable = zcodeSessionModels && zcodeSessionModels.settings && zcodeSessionModels.settings.model && Array.isArray(zcodeSessionModels.settings.model.available)
      ? zcodeSessionModels.settings.model.available
      : [];
    if (sessionAvailable.length > 1) return undefined;
    const cli = zcodeConfigSummary && zcodeConfigSummary.cli;
    if (!cli || !cli.model || !cli.baseUrl || !cli.hasCredential) return undefined;
    const cached = readCachedZcodeProbedModels(window.localStorage);
    if (cached && cached.cliModel === cli.model) {
      // Reference-compare fails (fresh object per read), so compare identity
      // facts to avoid a setState loop between this effect and the descriptor
      // effect (which now depends on zcodeSessionModels changes too).
      const same = zcodeProbedModels
        && zcodeProbedModels.cliModel === cached.cliModel
        && Array.isArray(zcodeProbedModels.probedModels)
        && zcodeProbedModels.probedModels.length === cached.probedModels.length;
      if (!same) setZcodeProbedModels(cached);
      return undefined;
    }
    let alive = true;
    const providerId = cli.providerId || '';
    const apiKeyValue = (() => { try { return keyStore ? keyStore.readKey('zcode') : ''; } catch (e) { return ''; } })();
    probeProviderModels({
      baseUrl: cli.baseUrl,
      ['apiKey']: apiKeyValue,
      protocol: cli.protocol,
      allowInsecureHttp: false,
    }).then((result) => {
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

  // Spec A extension: when the cli-config channel is active (custom provider
  // via inherited config.toml), probe its /v1/models the same way zcode's
  // cli-config channel does (same probeProviderModels entry point).
  React.useEffect(() => {
    if (backendPref !== 'codex') return undefined;
    if (!codexCliConfig || !codexCliConfig.provider || !codexCliCredentialReady) return undefined;
    if (effective.channel === 'custom' && codexCustomProvider && codexCustomProvider.baseUrl) return undefined;
    if (codexModels && codexModels.length > 1) return undefined;
    let alive = true;
    (async () => {
      let credential = '';
      try {
        credential = await resolveCodexCliCredential({
          provider: codexCliConfig.provider,
          env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {},
          storedValueRef: null,
          secretService: providerSecretService,
        });
        const result = await probeProviderModels({
          baseUrl: codexCliConfig.provider.baseUrl,
          ['apiKey']: credential,
          protocol: 'openai-compatible',
          allowInsecureHttp: false,
        });
        if (!alive) return;
        if (result.ok && result.models && result.models.length && !modelMetadataContainsCredential(result.models, credential)) {
          setCodexModels(result.models);
          writeCachedCodexModels(window.localStorage, result.models);
        }
      } catch { /* probe is best effort */ } finally {
        credential = '';
      }
    })();
    return () => { alive = false; };
  }, [backendPref, effective.channel, codexCliConfig, codexCliCredentialReady, codexCustomProvider, codexModels, providerSecretService]);

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
      platform,
      extensionRoot: extRoot,
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
  }, [cs, extRoot, platform, pushLog]);

  React.useEffect(() => {
    if (status.state !== 'ok') return undefined;
    let alive = true;
    setProviderInit({ state: 'checking', error: '' });
    (async () => {
      try {
        if (!providerStore) {
          const error = new Error('Provider store is unavailable');
          error.code = 'PROVIDER_STORE_UNAVAILABLE';
          throw error;
        }
        const host = getHost();
        if (!host || typeof host.capabilities !== 'function') throw providerRuntimeUnavailableError();
        const capabilities = await host.capabilities();
        requireProviderHelperCapabilities(capabilities, platform.id);
        const secretStore = createHostSecretStore(host);
        const runner = createSecretMigrationRunner({
          journalStore: createProviderMigrationJournalStore(platform),
          secretStore,
        });
        await migrateProviderStoreSecrets({
          store: providerStore,
          legacyKeyStore: {
            readKey: (name) => { try { return keyStore ? keyStore.readKey(name) : ''; } catch { return ''; } },
            async cleanupCommittedProviderSecrets() {
              if (!keyStore) return;
              keyStore.clearKey('anthropic');
              keyStore.clearKey('codex');
            },
          },
          runner,
          secretStore: host,
        });
        await drainPendingProviderSecretDeletes({ store: providerStore, secretService: providerSecretService });
        const providerState = providerStore.readState();
        for (const ref of activeProviderSecretRefs(providerState.providers)) {
          let resolved = null;
          try {
            resolved = await providerSecretService.resolve(ref);
            if (typeof resolved !== 'string') {
              const error = new Error('Provider secret resolution returned an invalid value.');
              error.code = 'SECRET_CONFLICT';
              throw error;
            }
          } finally {
            resolved = null;
          }
        }
        if (!alive) return;
        setProviders(providerState.providers);
        setProviderInit({ state: 'ready', error: '' });
      } catch (error) {
        if (!alive) return;
        try { if (providerStore) setProviders(providerStore.list()); } catch { /* retain last known list */ }
        setProviderInit(providerInitFailure(error));
      }
    })();
    return () => { alive = false; };
  }, [status.state, providerStore, providerSecretService, getHost, keyStore, platform]);

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
            providerInit={providerInit}
            claudeProviderId={claudeProviderId}
            onClaudeProviderChange={(id) => { setClaudeProviderId(id); writePref('ae_mcp_claude_provider', id); }}
            codexProviderId={codexProviderId}
            onCodexProviderChange={(id) => { setCodexProviderId(id); writePref('ae_mcp_codex_provider', id); setCodexProbe(null); codexBackend.reset(); }}
            claudeSettingsImportAvailable={Boolean(claudeSettingsHint)}
            onImportClaudeSettings={async () => {
              if (!claudeSettingsHint || !providerStore) return;
              if (providerInit.state !== 'ready') throw providerRuntimeUnavailableError();
              let draft = null;
              try {
                draft = readClaudeSettingsProviderDraft({
                  platform,
                  expectedSourceRevision: claudeSettingsHint.sourceRevision,
                  fsImpl: platform.fs,
                });
                if (!draft) return;
                const entry = await importProviderDraft({ candidate: draft, store: providerStore, secretService: providerSecretService, randomUUID: randomProviderCredentialId });
                setProviders(providerStore.list());
                setClaudeProviderId(entry.id);
                writePref('ae_mcp_claude_provider', entry.id);
              } finally {
                draft = null;
              }
            }}
            onSaveZcodeKey={(k) => {
              if (keyStore) keyStore.writeKey(k, 'zcode');
              setZcodeProbe(null);
              zcodeBackend.reset();
              runZcodeProbe();
            }}
            zcodeKeyStored={(() => { try { return Boolean(keyStore && keyStore.readKey('zcode')); } catch (e) { return false; } })()}
            onSaveCodexKey={undefined}
            codexKeyStored={false}
            codexCliConfig={codexCliConfig}
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
