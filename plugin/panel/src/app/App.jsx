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
import { ToolsScreen } from '../screens/ToolsScreen';
import { ToolApprovalDialog } from '../components/tools/ToolApprovalDialog';
import { QuestionFormDialog } from '../components/tools/QuestionFormDialog';
import { questionsFromElicitationSchema } from '../lib/questionForm';
import { createPanelFileDropGuard } from '../lib/panelFileDrop';
import { createAgentLoop } from '../lib/agentLoop';
import { revertToPreviousCheckpoint } from '../lib/activityModel';
import { pickBackend, deriveToolMeta, shouldResetOnBackendChange } from '../lib/backendSelect';
import { installBeforeUnloadReset } from '../lib/backendLifecycle.js';
import { containsExactSecret, redactText } from '../lib/exactSecretRedaction.js';
import { createMcpClient, resolveMcpCommand } from '../cep/mcpClient';
import { createApprovalTierFile, withToolApprovalTier } from '../cep/approvalTierFile';
import { createToolsApi } from '../cep/toolsApi';
import { createLegacyApiKeyStore } from '../cep/apiKey';
import { createZcodeCredentialManager } from '../cep/zcodeCredential.js';
import { probeClaudeLogin, resolveNodeForSidecarSelection, resolveSidecarSelection } from '../cep/claudeAuth';
import { createClaudeAgentBackend, resolveSystemNode } from '../cep/claudeAgentBackend';
import { createCodexBackend } from '../cep/codexBackend';
import { createOpenCodeBackend } from '../cep/openCodeBackend';
import { createZcodeBackend, summarizeZcodeConfig } from '../cep/zcodeBackend';
import { claudeChannels, codexChannels, zcodeChannels, migrateBackendPref } from '../lib/channels.js';
import { createProviderStore } from '../cep/providerStore';
import { createProviderSecretService, resolveProviderRequestProfile } from '../cep/providerSecrets';
import {
  countMentionedPanelAttachments,
  createProviderAcceptanceBridge,
  normalizePanelAcceptanceTurns,
} from '../cep/providerAcceptanceBridge.js';
import { createUniversalProviderRoute } from '../cep/universalProviderRoute.js';
import { migrateProviderStoreSecrets } from '../cep/providerMigration';
import { migrateProviderStoreV2ToV3 } from '../cep/providerSchemaMigration';
import { createSecretMigrationRunner } from '../cep/platform/secret-migration';
import { deleteProviderProfile, drainPendingProviderSecretDeletes, importProviderDraft, saveProviderDraft } from './providerProfileFlow';
import { runProviderManagerProbe } from './providerProbeFlow.js';
import { assertProviderStateCredentialFree, providerInitFailure, providerRepairFailure } from './providerInitState';
import { ProviderManagerSection } from '../components/settings/ProviderManagerSection';
import { probeProviderModels } from '../cep/modelProbe';
import { detectCcSwitch, readCcSwitchProviderDrafts } from '../cep/ccSwitch';
import { inspectClaudeSettingsEnv, readClaudeSettingsProviderDraft } from '../cep/claudeSettingsImport';
import { codexCliCredentialAvailable, readCodexCliConfig, resolveCodexCliCredential } from '../cep/codexConfig';
import { reduceEvent, userTurnEntry } from '../lib/chatEntries';
import {
  createAttachmentDraftState,
  reduceAttachmentDraft,
} from '../lib/attachmentDraft.js';
import { createAttachmentStore } from '../cep/attachmentStore.js';
import { DEFAULT_MODEL } from '../lib/anthropic';
import { descriptorWithCustomModel, resolveEffectiveEffort } from '../lib/backendCapabilities';
import { selectDescriptor, reconcileModelPref } from '../lib/descriptorSelect';
import { ZCODE_PROBED_MODELS_CACHE_KEY } from '../lib/zcodeModelCache';
import { baseDescriptorFor } from '../cep/backends/index.js';
import { costBadge } from '../lib/composerOptions';
import { codexRuntimeProviderProfile } from '../lib/providerProfile.js';
import { selectProviderRoute } from '../lib/providerRouteSelection.js';
import { useActivity } from '../cep/useActivity';
import { isWizardDone, markWizardDone, clearWizardDone } from '../cep/firstRun';
import { useWizardWiring } from './wizardWiring';
import { runDiagnostics } from '../cep/diagnostics';
import { copyText } from '../lib/clipboard';
import { copyWizardConfig } from '../lib/wizardCopy.js';
import { createHostController, loadSavedPort, savePort, DEFAULT_PORT, buildMcpConfig, isValidPort } from '../cep/hostBridge';
import { loadExpertGuidance, saveExpertGuidance } from '../lib/expertGuidance.js';
import pkg from '../../package.json';
import { attachmentPathSecrets, buildLogExport, exportFileName, keepLogLine, readDatedLogTail } from '../lib/logExport.js';
import { writeLogExport, revealInExplorer } from '../cep/logExportFs.js';
import { reconcileStableJsonValue } from '../lib/stableValue.js';
import { createPlatformAdapter } from '../cep/platform/index.js';
import { readCepSystemPath } from '../cep/platform/paths.js';
import { createRuntimeManager, hasDevelopmentRuntimeOverride } from '../cep/runtimeManager.js';
import { createElicitationCoordinator } from '../lib/elicitationCoordinator.js';
import { decideToolPlan } from '../../../shared/tool-approval.mjs';
import { normalizeTurnInput } from '../../../shared/chat-attachments.mjs';

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
    tools: '工具',
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
    tools: 'Tools',
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
    if (provider.credential) {
      add(provider.credential.valueRef);
      add(provider.probeAuthOverride?.valueRef);
    } else {
      add(provider.auth?.model?.valueRef);
      add(provider.auth?.probe?.valueRef);
    }
    for (const header of provider.headers || []) add(header.valueRef);
  }
  return Array.from(byReference, ([reference, revision]) => ({ kind: 'secret', reference, revision }));
}

function providerRuntimeUnavailableError() {
  const error = new Error('Repair the platform Helper and re-check provider credentials.');
  error.code = 'PLATFORM_HELPER_REPAIR_REQUIRED';
  return error;
}

function modelMetadataContainsCredential(models, credentials = []) {
  const values = Array.isArray(credentials) ? credentials : (credentials ? [credentials] : []);
  return containsExactSecret(models, ['aemcp-secret://', ...values]);
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
  const attachmentStore = React.useMemo(() => createAttachmentStore({
    platform,
    randomUUID: randomProviderCredentialId,
  }), [platform]);
  const [attachmentDraft, dispatchAttachmentDraft] = React.useReducer(
    reduceAttachmentDraft,
    undefined,
    createAttachmentDraftState,
  );
  const [chatSessionId, setChatSessionId] = React.useState('chat-0');
  const chatSessionIdRef = React.useRef(chatSessionId);
  chatSessionIdRef.current = chatSessionId;
  const attachmentOperationsRef = React.useRef(new Map());
  const pendingTurnRef = React.useRef(null);
  const acceptedTurnRef = React.useRef(null);
  React.useEffect(() => () => attachmentStore.dispose(), [attachmentStore]);
  const legacyKeyStore = React.useMemo(() => {
    try { return createLegacyApiKeyStore(); } catch (e) { return null; }
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
  const permissionModeRef = React.useRef(permissionMode);
  permissionModeRef.current = permissionMode;
  const approvalTierFile = React.useMemo(() => createApprovalTierFile({
    fs: platform.fs,
    paths: platform.paths,
    platformId: platform.id,
    pid: (window.cep_node && window.cep_node.process && window.cep_node.process.pid) || 0,
  }), [platform]);
  const elicitationCoordinator = React.useMemo(() => createElicitationCoordinator({
    resolveApproval: (_request, { plan }) => decideToolPlan({
      tier: permissionModeRef.current,
      plan,
    }),
    // Generic MCP elicitation reaches the visible question form (#219); only
    // schemas the form cannot faithfully render are declined. Permission tier
    // is deliberately not consulted: automatic modes never answer questions.
    presentGenericForm: (request) => {
      const built = questionsFromElicitationSchema(
        request && request.message,
        request && request.requestedSchema,
      );
      if (!built.ok) return { action: 'decline', content: {} };
      return {
        kind: 'question-form',
        title: (request && request.message) || '',
        questions: built.questions,
      };
    },
  }), []);
  const [toolApproval, setToolApproval] = React.useState(() => elicitationCoordinator.snapshot());
  React.useEffect(() => elicitationCoordinator.subscribe(setToolApproval), [elicitationCoordinator]);
  React.useEffect(() => {
    approvalTierFile.write(permissionMode);
  }, [approvalTierFile, permissionMode]);
  React.useEffect(() => () => {
    elicitationCoordinator.dispose();
    try { approvalTierFile.dispose(); } catch (error) { /* best effort on shutdown */ }
  }, [approvalTierFile, elicitationCoordinator]);
  // Panel-lifetime navigation guard (#208): file drops must never navigate the
  // CEP WebView, on any tab. Attaching is handled by the Composer's own guard
  // while the chat screen is mounted; this one only blocks navigation, and
  // leaves text/URL drags to their native behavior.
  React.useEffect(() => {
    const guard = createPanelFileDropGuard({ target: window });
    return guard.dispose;
  }, []);
  const backendMigration = React.useMemo(() => migrateBackendPref(window.localStorage), []);
  const [backendPref, setBackendPref] = React.useState(() => backendMigration.pref);
  // #229: channels are user-enabled per backend; routing follows the choice
  // exactly (no auto-pick, no lock, no pinning by provider selection).
  const [channelChoices, setChannelChoices] = React.useState(() => backendMigration.channelChoices);
  const providerStore = React.useMemo(() => {
    try { return createProviderStore(); } catch (e) { return null; }
  }, []);
  const providerSecretService = React.useMemo(() => createProviderSecretService({
    getHost,
    randomBytes: (size) => cepRequire('crypto').randomBytes(size),
  }), [getHost]);
  const zcodeCredentialManager = React.useMemo(() => createZcodeCredentialManager({
    storage: window.localStorage,
    secretService: providerSecretService,
    legacyKeyStore,
  }), [legacyKeyStore, providerSecretService]);
  const zcodeStoredKeyRef = React.useRef('');
  const [zcodeCredentialEpoch, setZcodeCredentialEpoch] = React.useState(0);
  const [providerInit, setProviderInit] = React.useState({ state: 'checking', error: '' });
  const [providerRepairing, setProviderRepairing] = React.useState(false);
  const [providerInitEpoch, setProviderInitEpoch] = React.useState(0);
  const [providers, setProviders] = React.useState([]);
  const [claudeProviderId, setClaudeProviderId] = React.useState(() => readPref('ae_mcp_claude_provider', ''));
  const [codexProviderId, setCodexProviderId] = React.useState(() => readPref('ae_mcp_codex_provider', ''));
  const [expertGuidance, setExpertGuidance] = React.useState(() => loadExpertGuidance(window.localStorage));
  const [probe, setProbe] = React.useState(null);
  const [codexProbe, setCodexProbe] = React.useState(null);
  const [codexModels, setCodexModels] = React.useState(null);
  const [zcodeProbe, setZcodeProbe] = React.useState(null);
  const [zcodeSessionModels, setZcodeSessionModels] = React.useState(null);
  const [zcodeProbedModels, setZcodeProbedModels] = React.useState(null);
  React.useEffect(() => {
    try {
      window.localStorage.removeItem(CODEX_MODELS_CACHE_KEY);
      window.localStorage.removeItem(ZCODE_PROBED_MODELS_CACHE_KEY);
    } catch {}
  }, []);
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
  // Reconcile against the SELECTED model, not just the backend: a session
  // effort chosen for one model must not survive a switch to a model with a
  // narrower effort set (#218) — the chip and the dispatched pair both derive
  // from this single reconciled value.
  const effectiveEffort = resolveEffectiveEffort({
    requested: sessionEffort,
    model: modelMeta,
    defaultEffort: descriptor.defaultEffort,
  });
  const effectiveFast = Boolean(sessionFast && descriptor.supportsFast(effectiveModel));
  const claudeApiProvider = React.useMemo(() => {
    return providers.find((provider) => provider.id === claudeProviderId) || null;
  }, [providers, claudeProviderId]);
  const codexCustomProvider = React.useMemo(() => {
    return providers.find((provider) => provider.id === codexProviderId) || null;
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
      activeProviderId={codexProviderId}
      activeModelId={effectiveModel}
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
        if (codexProviderId === provider.id) {
          setCodexProviderId('');
          writePref('ae_mcp_codex_provider', '');
        }
      }}
      onProbe={async (provider, options = {}) => {
        if (providerInit.state !== 'ready') throw providerRuntimeUnavailableError();
        setProviderProbing(provider.id);
        try {
          const result = await runProviderManagerProbe(provider, {
            store: providerStore,
            resolveRequestProfile: (entry, { scope }) => resolveProviderRequestProfile(entry, {
              scope,
              secretService: providerSecretService,
            }),
            forceDetect: options.forceDetect === true,
            modelId: options.modelId,
          });
          if (result.ok && providerStore) {
            setProviders(providerStore.list());
            setProviderProbeErrors((errors) => ({ ...errors, [provider.id]: '' }));
          } else {
            setProviderProbeErrors((errors) => ({ ...errors, [provider.id]: result.detail || 'Provider probe failed' }));
          }
        } catch (error) {
          setProviderProbeErrors((errors) => ({ ...errors, [provider.id]: error?.message || 'Provider probe failed' }));
        } finally {
          setProviderProbing('');
        }
      }}
    />
  );
  const zcodeConfigSummary = React.useMemo(() => {
    try { return summarizeZcodeConfig({ env: (window.cep_node && window.cep_node.process && window.cep_node.process.env) || {}, storedKey: zcodeStoredKeyRef.current }); } catch (e) { return null; }
  }, [zcodeCredentialEpoch, zcodeProbe]);
  const codexCliConfigStableRef = React.useRef(null);
  // Keep a Codex CLI model_provider available when the panel has no explicit
  // provider configuration of its own.
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
  const codexProviderCredentialResolverReady = providerInit.state === 'ready';
  const channels = React.useMemo(() => ({
    claude: claudeChannels({ probe, apiProvider: claudeApiProvider, apiProviderSelected: Boolean(claudeProviderId), providerAvailable: providerInit.state === 'ready' && Boolean(claudeApiProvider), providerCredentialResolverReady: codexProviderCredentialResolverReady, providerChecking: providerInit.state === 'checking' }),
    codex: codexChannels({ codexProbe, customProvider: codexCustomProvider, customProviderSelected: Boolean(codexProviderId), customProviderAvailable: providerInit.state === 'ready' && Boolean(codexCustomProvider), customProviderCredentialResolverReady: codexProviderCredentialResolverReady, providerChecking: providerInit.state === 'checking', cliConfig: codexCliConfig, cliCredentialAvailable: codexCliCredentialReady }),
    zcode: zcodeChannels({ zcodeProbe, configSummary: zcodeConfigSummary }),
  }), [probe, claudeApiProvider, claudeProviderId, codexProbe, codexCustomProvider, codexProviderCredentialResolverReady, codexProviderId, zcodeProbe, zcodeConfigSummary, codexCliConfig, codexCliCredentialReady, providerInit.state]);
  const effective = pickBackend({ pref: backendPref, channels, channelChoices });
  const claudeSettingsHint = React.useMemo(() => {
    try { return inspectClaudeSettingsEnv({ platform, fsImpl: platform.fs }); } catch (e) { return null; }
  }, [platform]);
  const providerProfile = React.useMemo(() => codexRuntimeProviderProfile({
    effectiveChannel: effective.channel,
    customProvider: codexCustomProvider,
    customProviderCredentialResolverReady: codexProviderCredentialResolverReady,
    modelId: effectiveModel,
  }), [effective.channel, codexCustomProvider, codexProviderCredentialResolverReady, effectiveModel]);
  const runtimeRef = React.useRef({ providerProfile, providerCandidate: null, model: effectiveModel, permissionMode, effort: effectiveEffort, thinking: null, fast: effectiveFast, claudeChannel: 'subscription', claudeApiProvider: null });
  const previousCodexProviderProfileRef = React.useRef(providerProfile);
  const extRoot = React.useMemo(() => readCepSystemPath({ cs, platform }), [cs, platform]);
  const developmentRuntimeFallback = React.useMemo(() => {
    if (platform.id !== 'macos-arm64') return false;
    const debugMarker = platform.paths.join([extRoot, '.debug']);
    const bundleManifest = platform.paths.join([extRoot, 'bundle-manifest.json']);
    return platform.fs.existsSync(debugMarker)
      && !platform.fs.existsSync(bundleManifest);
  }, [extRoot, platform]);
  const developmentRuntimeOverride = React.useMemo(
    () => hasDevelopmentRuntimeOverride(platform.env),
    [platform],
  );
  const runtimeManager = React.useMemo(() => (
    platform.id === 'macos-arm64' && (!developmentRuntimeFallback || developmentRuntimeOverride)
      ? createRuntimeManager({ platform, extensionRoot: extRoot })
      : null
  ), [developmentRuntimeFallback, developmentRuntimeOverride, extRoot, platform]);
  const [runtimeActivation, setRuntimeActivation] = React.useState(() => ({
    state: runtimeManager ? 'starting' : 'ready',
    result: null,
    error: null,
  }));
  const markRuntimeReady = React.useCallback((result) => {
    setRuntimeActivation({ state: 'ready', result: result || null, error: null });
  }, []);
  React.useEffect(() => {
    if (!runtimeManager) {
      setRuntimeActivation({ state: 'ready', result: null, error: null });
      return undefined;
    }
    let alive = true;
    setRuntimeActivation({ state: 'starting', result: null, error: null });
    let retryTimer = null;
    const activate = () => {
      runtimeManager.ensureReady().then((result) => {
        if (alive) markRuntimeReady(result);
      }).catch((error) => {
        if (!alive) return;
        setRuntimeActivation({ state: 'error', result: null, error });
        // A second panel can hold the short-lived install lock during boot.
        // Keep configuration hidden, then retry without requiring a reload.
        if (error && error.code === 'RUNTIME_MANAGER_LOCKED') {
          retryTimer = setTimeout(activate, 1000);
        }
      });
    };
    activate();
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [markRuntimeReady, runtimeManager]);
  const runtimeReady = runtimeActivation.state === 'ready';
  const mcpCommand = runtimeManager ? platform.paths.launcher : 'ae-mcp';
  const resolvePanelNode = React.useCallback(
    ({ platform: requestedPlatform } = {}) => (runtimeManager
      ? resolveNodeForSidecarSelection({
        resolveNode: () => runtimeManager.resolveNode(),
        runtimeSelection: runtimeActivation.result,
        platform: requestedPlatform || platform,
      })
      : resolveSystemNode({ platform: requestedPlatform || platform })),
    [platform, runtimeActivation.result, runtimeManager],
  );
  const sidecarSelection = React.useMemo(() => resolveSidecarSelection({
    extRoot,
    platform,
    runtimeActivation,
  }), [extRoot, platform, runtimeActivation]);
  const sidecarPath = sidecarSelection.path;
  const getMcpSpec = React.useCallback(async () => {
    try {
      const spec = await resolveMcpCommand({ extRoot, platform, runtimeManager });
      if (runtimeManager && spec.runtime) markRuntimeReady(spec.runtime);
      return withToolApprovalTier(spec, approvalTierFile);
    } catch (error) {
      if (runtimeManager) setRuntimeActivation({ state: 'error', result: null, error });
      throw error;
    }
  }, [approvalTierFile, extRoot, markRuntimeReady, platform, runtimeManager]);
  const mcp = React.useMemo(() => createMcpClient({
    platform,
    extRoot,
    resolveCommand: getMcpSpec,
    env: approvalTierFile.env(),
    onElicitation: elicitationCoordinator.handle,
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    randomBytes: (size) => cepRequire('crypto').randomBytes(size),
  }), [approvalTierFile, elicitationCoordinator, extRoot, getMcpSpec, platform]);
  const toolsApi = React.useMemo(() => createToolsApi(mcp), [mcp]);
  React.useEffect(() => () => mcp.stop(), [mcp]);
  const releaseTurnAttachments = React.useCallback((turn) => {
    for (const attachment of turn?.attachments || []) {
      attachmentStore.release(attachment.id);
    }
  }, [attachmentStore]);
  const resetAttachmentDraftSession = React.useCallback(() => {
    attachmentStore.releaseSession(chatSessionIdRef.current);
    attachmentOperationsRef.current.clear();
    pendingTurnRef.current = null;
    acceptedTurnRef.current = null;
    dispatchAttachmentDraft({ type: 'reset' });
    const nextSessionId = 'chat-' + randomProviderCredentialId();
    chatSessionIdRef.current = nextSessionId;
    setChatSessionId(nextSessionId);
  }, [attachmentStore]);
  const addAttachment = React.useCallback(async ({ pondId, file }) => {
    const operation = {};
    const sessionId = chatSessionId;
    attachmentOperationsRef.current.set(pondId, operation);
    dispatchAttachmentDraft({ type: 'staging', pondId, file });
    try {
      const ref = await attachmentStore.prepare(file, { sessionId, pondId });
      if (
        attachmentOperationsRef.current.get(pondId) !== operation
        || chatSessionIdRef.current !== sessionId
      ) {
        attachmentStore.release(ref.id);
        return;
      }
      attachmentOperationsRef.current.delete(pondId);
      dispatchAttachmentDraft({ type: 'ready', pondId, ref });
    } catch (error) {
      if (
        attachmentOperationsRef.current.get(pondId) !== operation
        || chatSessionIdRef.current !== sessionId
      ) return;
      attachmentOperationsRef.current.delete(pondId);
      dispatchAttachmentDraft({
        type: 'error',
        pondId,
        error: {
          code: error?.code || 'ATTACHMENT_STAGING_FAILED',
          message: error?.message || 'Attachment staging failed',
        },
      });
    }
  }, [attachmentStore, chatSessionId]);
  const removeAttachment = React.useCallback((item) => {
    attachmentOperationsRef.current.delete(item.pondId);
    if (item.ref) attachmentStore.release(item.ref.id);
    dispatchAttachmentDraft({ type: 'remove', pondId: item.pondId });
  }, [attachmentStore]);
  const retryAttachment = React.useCallback((item) => {
    addAttachment({ pondId: item.pondId, file: item.file });
  }, [addAttachment]);
  const providerAcceptanceEventsRef = React.useRef([]);
  const handleChatEvent = React.useCallback((evt) => {
    if (evt && typeof evt.type === 'string') {
      providerAcceptanceEventsRef.current.push({
        type: evt.type,
        ...(typeof evt.kind === 'string' ? { kind: evt.kind } : {}),
        ...(typeof evt.code === 'string' ? { code: evt.code } : {}),
      });
      if (providerAcceptanceEventsRef.current.length > 256) providerAcceptanceEventsRef.current.shift();
    }
    const pending = pendingTurnRef.current;
    if (evt.type === 'turn-accepted') {
      if (!pending || evt.turnId !== pending.turnId) return;
      acceptedTurnRef.current = pending.turnId;
      setChatEntries((entries) => entries.concat(userTurnEntry(pending)));
      dispatchAttachmentDraft({ type: 'accepted', turnId: pending.turnId });
      setChatStreaming(true);
      return;
    }
    if (evt.type === 'error' && pending && acceptedTurnRef.current !== pending.turnId) {
      if (evt.turnId !== pending.turnId) return;
      setChatStreaming(false);
      setThinkingActive(false);
      if (evt.dispatchState === 'not-started') {
        dispatchAttachmentDraft({
          type: 'rejected',
          turnId: pending.turnId,
          error: { code: evt.code || 'BACKEND_ERROR', message: evt.message || 'Backend unavailable' },
        });
        pendingTurnRef.current = null;
      } else {
        dispatchAttachmentDraft({
          type: 'uncertain',
          turnId: pending.turnId,
          error: { code: evt.code || 'TRANSPORT_UNCERTAIN', message: evt.message || 'Send outcome is uncertain' },
        });
      }
      return;
    }
    if (evt.type === 'thinking') setThinkingActive(!!evt.active);
    if (evt.type === 'turn-end' || evt.type === 'error') {
      if (pending && acceptedTurnRef.current === pending.turnId) {
        releaseTurnAttachments(pending);
        pendingTurnRef.current = null;
        acceptedTurnRef.current = null;
      }
      setChatStreaming(false);
      setThinkingActive(false);
    }
    if (evt.type === 'zcode-session-created') setZcodeSessionModels(evt.result || null);
    setChatEntries((entries) => reduceEvent(entries, evt));
  }, [releaseTurnAttachments]);

  const recoverRuntimeProvider = React.useCallback(async (provider, _failureFacts, requestedModelId) => {
    if (!providerStore) return null;
    const modelId = String(requestedModelId || '').trim();
    if (!modelId) return null;
    const result = await runProviderManagerProbe(provider, {
      store: providerStore,
      resolveRequestProfile: (entry, details) => resolveProviderRequestProfile(entry, {
        ...details,
        secretService: providerSecretService,
      }),
      forceDetect: true,
      modelId,
    });
    if (!result.ok) {
      // #222: this detail reaches chat error events verbatim, so exact-secret
      // redaction must happen here, the shared choke point for both backends.
      const detail = redactText(String(result.detail || ''), providerSecretService.getRedactionValues());
      const error = new Error(detail || `Provider did not expose a verified API for model ${modelId}`);
      error.kind = 'model';
      error.code = 'provider_preflight_failed';
      throw error;
    }
    return { provider: result.entry, modelId };
  }, [providerSecretService, providerStore]);

  const refreshRuntimeProviders = React.useCallback(() => {
    if (providerStore) setProviders(providerStore.list());
  }, [providerStore]);

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
    resolveNode: resolvePanelNode,
    sidecarPath,
    getMcpSpec,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getThinking: () => runtimeRef.current.thinking,
    getChannel: () => runtimeRef.current.claudeChannel || 'subscription',
    getProviderSensitiveValues: () => providerSecretService.getRedactionValues(),
    resolveApiProvider: () => {
      const provider = runtimeRef.current.claudeApiProvider;
      if (!provider) throw new Error('Custom Provider is unavailable');
      return provider;
    },
    resolveRequestProfile: (provider, details) => resolveProviderRequestProfile(provider, {
      ...details,
      secretService: providerSecretService,
    }),
    recoverProviderProfile: recoverRuntimeProvider,
    onProviderProfileRecovered: refreshRuntimeProviders,
    lang,
    onEvent: handleChatEvent,
  }), [getMcpSpec, sidecarPath, mcp, handleChatEvent, platform, providerSecretService, recoverRuntimeProvider, refreshRuntimeProviders, resolvePanelNode]);

  const codexBackend = React.useMemo(() => createCodexBackend({
    platform,
    getMcpSpec,
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getFast: () => runtimeRef.current.fast,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    getServerInstructions: () => mcp.getServerInstructions(),
    getProviderProfile: () => runtimeRef.current.providerProfile,
    getProviderCandidate: () => runtimeRef.current.providerCandidate,
    getProviderSensitiveValues: () => providerSecretService.getRedactionValues(),
    resolveRequestProfile: (provider, details) => resolveProviderRequestProfile(provider, {
      ...details,
      secretService: providerSecretService,
    }),
    recoverProviderProfile: recoverRuntimeProvider,
    onProviderProfileRecovered: refreshRuntimeProviders,
    getCliConfigProvider: () => null,
    lang,
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, getMcpSpec, mcp, handleChatEvent, platform, providerSecretService, recoverRuntimeProvider, refreshRuntimeProviders]);

  React.useEffect(() => {
    if (providerInit.state !== 'ready' || !providerStore) return undefined;
    let debugMarker = false;
    try {
      debugMarker = platform.fs.existsSync(platform.paths.join([extRoot, '.debug']));
    } catch {}
    if (!debugMarker) return undefined;
    const key = '__AE_MCP_PROVIDER_ACCEPTANCE__';
    const previous = window[key];
    if (previous?.dispose) Promise.resolve(previous.dispose()).catch(() => {});
    const bridge = createProviderAcceptanceBridge({
      store: providerStore,
      secretService: providerSecretService,
      runProviderManagerProbe,
      createUniversalProviderRoute,
      selectProviderRoute,
      resolveProviderRequestProfile,
      onProvidersChanged: refreshRuntimeProviders,
    });
    let panelQueue = Promise.resolve();
    const panelTurns = (input = {}) => {
      const run = async () => {
        const client = input.client === 'claude' ? 'claude' : input.client === 'codex' ? 'codex' : '';
        const providerId = typeof input.providerId === 'string' ? input.providerId.trim() : '';
        const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
        let plannedTurns;
        try {
          plannedTurns = normalizePanelAcceptanceTurns(input);
        } catch {
          return { ok: false, errorCode: 'PROVIDER_ACCEPTANCE_INVALID_PANEL_TURN', turns: [] };
        }
        const graceMs = Number.isInteger(input.graceMs) && input.graceMs >= 0 && input.graceMs <= 10000
          ? input.graceMs
          : 3000;
        if (!client || !providerId || !modelId) {
          return { ok: false, errorCode: 'PROVIDER_ACCEPTANCE_INVALID_PANEL_TURN', turns: [] };
        }
        let provider = null;
        try { provider = providerStore.get(providerId); } catch {}
        if (!provider) return { ok: false, errorCode: 'PROVIDER_ACCEPTANCE_PROVIDER_NOT_FOUND', turns: [] };
        const backend = client === 'codex' ? codexBackend : claudeBackend;
        const savedRuntime = runtimeRef.current;
        const turns = [];
        providerAcceptanceEventsRef.current = [];
        runtimeRef.current = {
          ...savedRuntime,
          providerProfile: { provider, modelId },
          providerCandidate: { provider, modelId },
          model: modelId,
          permissionMode: 'none',
          effort: 'low',
          thinking: input.thinking === 'adaptive' ? 'adaptive' : null,
          fast: false,
          claudeChannel: 'api',
          claudeApiProvider: provider,
        };
        backend.reset();
        try {
          for (const plannedTurn of plannedTurns) {
            const eventStart = providerAcceptanceEventsRef.current.length;
            const startedAt = Date.now();
            await backend.sendUser(plannedTurn);
            await new Promise((resolve) => setTimeout(resolve, graceMs));
            const events = providerAcceptanceEventsRef.current.slice(eventStart);
            const error = events.find((event) => event.type === 'error');
            const accepted = events.some((event) => event.type === 'turn-accepted');
            const terminal = events.some((event) => event.type === 'turn-end');
            const transcript = backend.getMessages();
            const hasAssistant = transcript.some((message) => message?.role === 'assistant'
              && typeof message.text === 'string' && message.text.trim());
            turns.push({
              ok: !error && terminal && hasAssistant,
              terminal: terminal ? 'turn-end' : null,
              durationMs: Date.now() - startedAt,
              errorCode: error?.code || error?.kind || null,
              attachmentCount: plannedTurn.attachments.length,
              mentionedAttachmentCount: countMentionedPanelAttachments(
                transcript,
                plannedTurn.attachments,
              ),
              accepted,
            });
            if (!turns.at(-1).ok) break;
          }
          return {
            ok: turns.length === plannedTurns.length && turns.every((turn) => turn.ok),
            client,
            modelId,
            turns,
          };
        } catch (error) {
          return {
            ok: false,
            client,
            modelId,
            turns,
            errorCode: typeof error?.code === 'string' ? error.code : 'PROVIDER_ACCEPTANCE_PANEL_TURN_FAILED',
          };
        } finally {
          backend.reset();
          runtimeRef.current = savedRuntime;
        }
      };
      const pending = panelQueue.then(run, run);
      panelQueue = pending.then(() => undefined, () => undefined);
      return pending;
    };
    const acceptance = Object.freeze({ ...bridge, panelTurns });
    window[key] = acceptance;
    return () => {
      if (window[key] === acceptance) delete window[key];
      Promise.resolve(bridge.dispose()).catch(() => {});
    };
  }, [claudeBackend, codexBackend, extRoot, platform, providerInit.state, providerSecretService, providerStore, refreshRuntimeProviders]);

  React.useEffect(
    () => installBeforeUnloadReset(window, codexBackend),
    [codexBackend],
  );

  React.useEffect(() => {
    if (previousCodexProviderProfileRef.current === providerProfile) return;
    previousCodexProviderProfileRef.current = providerProfile;
    codexBackend.reset();
  }, [codexBackend, providerProfile]);

  const openCodeBackend = React.useMemo(() => createOpenCodeBackend({
    platform,
    getMcpSpec,
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, getMcpSpec, mcp, handleChatEvent, platform]);

  const zcodeBackend = React.useMemo(() => createZcodeBackend({
    platform,
    getMcpSpec,
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    getServerInstructions: () => mcp.getServerInstructions(),
    readStoredZcodeKey: () => zcodeStoredKeyRef.current,
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, getMcpSpec, mcp, handleChatEvent, platform]);

  React.useEffect(() => () => {
    zcodeStoredKeyRef.current = '';
    zcodeBackend.reset();
  }, [zcodeBackend]);

  runtimeRef.current = {
    providerProfile,
    providerCandidate: effective.channel === 'custom' && codexCustomProvider
      ? { provider: codexCustomProvider, modelId: effectiveModel }
      : null,
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
  // not backendPref. `byok` remains only for legacy state compatibility;
  // live custom Claude Provider selection resolves to `claude-api`.
  React.useEffect(() => {
    const facts = {
      effectiveBackend: effective.backend,
      effectiveChannel: effective.channel,
      backendPref,
      baseDescriptor,
      customModel,
      claudeApiProvider,
      codexCustomProvider,
      customProviderCredentialResolverReady: codexProviderCredentialResolverReady,
      byokApiModels: null,
      codexCachedModels: codexModels,
      zcodeSessionModels,
      zcodeProbedModels,
    };
    const nextDescriptor = selectDescriptor(facts);
    setDescriptor(nextDescriptor);
    // A persisted model id can outlive its backend or model catalog. Reset it
    // when the current model isn't in the new descriptor's model list, but
    // exempt the codex custom-model path (customModel is intentionally not
    // in the curated list there).
    const isCustomModelPath = backendPref === 'codex' && customModelForBackend && model === customModelForBackend;
    const providerFactsPending = backendPref === 'codex'
      && Boolean(codexProviderId)
      && providerInit.state === 'checking';
    const reconciled = reconcileModelPref(model, nextDescriptor, {
      isCustom: isCustomModelPath,
      providerFactsPending,
    });
    if (reconciled !== model) {
      setModel(reconciled);
      writePref('ae_mcp_model', reconciled);
    }
  }, [effective.backend, effective.channel, backendPref, baseDescriptor, customModel, claudeApiProvider, codexCustomProvider, codexModels, zcodeSessionModels, zcodeProbedModels, providerSecretService, codexProviderCredentialResolverReady, codexProviderId, providerInit.state]);
  const activeBackendRef = React.useRef(null);

  // Custom ZCode providers can omit model.available, so use their authenticated
  // /models endpoint only after the runtime configuration is ready.
  React.useEffect(() => {
    if (backendPref !== 'zcode') return undefined;
    const sessionAvailable = zcodeSessionModels && zcodeSessionModels.settings && zcodeSessionModels.settings.model && Array.isArray(zcodeSessionModels.settings.model.available)
      ? zcodeSessionModels.settings.model.available
      : [];
    if (sessionAvailable.length > 1) return undefined;
    const cli = zcodeConfigSummary && zcodeConfigSummary.cli;
    if (!cli || !cli.model || !cli.baseUrl || !cli.hasCredential) return undefined;
    let alive = true;
    const providerId = cli.providerId || '';
    probeProviderModels({
      baseUrl: cli.baseUrl,
      ['apiKey']: zcodeStoredKeyRef.current,
      protocol: cli.protocol,
      allowInsecureHttp: false,
    }).then((result) => {
      if (!alive) return;
      if (result.ok && result.models && result.models.length) {
        const entry = { cliModel: cli.model, providerId, probedModels: result.models };
        setZcodeProbedModels(entry);
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [backendPref, zcodeCredentialEpoch, zcodeSessionModels, zcodeConfigSummary]);

  const runClaudeProbe = React.useCallback(() => {
    let alive = true;
    setProbe(null);
    if (sidecarSelection.state !== 'ready') {
      if (sidecarSelection.state === 'error') {
        const error = sidecarSelection.error;
        setProbe({
          loggedIn: false,
          nodeOk: false,
          detail: error?.message || String(error),
        });
      }
      return () => { alive = false; };
    }
    probeClaudeLogin({
      platform,
      resolveNode: resolvePanelNode,
      sidecarPath,
    }).then((result) => {
      if (alive) setProbe(result);
    }).catch((e) => {
      if (alive) setProbe({ loggedIn: false, nodeOk: false, detail: e && e.message ? e.message : String(e) });
    });
    return () => { alive = false; };
  }, [platform, resolvePanelNode, sidecarPath, sidecarSelection]);

  React.useEffect(() => {
    if (backendPref !== 'subscription') return undefined;
    return runClaudeProbe();
  }, [backendPref, runClaudeProbe]);

  const runCodexProbe = React.useCallback(() => {
    let alive = true;
    setCodexProbe(null);
    codexBackend.probeAccount().then((result) => {
      if (!alive) return;
      const redactionValues = providerSecretService.getRedactionValues();
      if (containsExactSecret(result, ['aemcp-secret://', ...redactionValues])) {
        setCodexProbe({ loggedIn: false, runtimeOk: false, detail: 'Codex probe metadata was rejected' });
        setCodexModels(null);
        return;
      }
      setCodexProbe(result);
      if (result && Array.isArray(result.models) && !modelMetadataContainsCredential(result.models, redactionValues)) {
        setCodexModels(result.models);
      }
    }).catch((e) => {
      if (alive) setCodexProbe({ loggedIn: false, detail: e && e.message ? e.message : String(e) });
    });
    return () => { alive = false; };
  }, [codexBackend, providerSecretService]);

  React.useEffect(() => {
    if (backendPref !== 'codex') return undefined;
    return runCodexProbe();
  }, [backendPref, runCodexProbe]);

  // CLI-configured providers need a direct /models fallback when Codex does
  // not enumerate their models through the app-server.
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
        if (result.ok && result.models && result.models.length && !modelMetadataContainsCredential(result.models, [credential])) {
          setCodexModels(result.models);
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
    resetAttachmentDraftSession();
    setChatEntries([]);
    setChatStreaming(false);
    setSessionModel(null);
    setSessionEffort(null);
    setSessionFast(null);
    if (decision.nextReal !== 'zcode') setZcodeSessionModels(null);
  }, [effective.backend, byokLoop, claudeBackend, codexBackend, openCodeBackend, resetAttachmentDraftSession, zcodeBackend]);

  const sendChat = (input) => {
    if (pendingTurnRef.current) return;
    let turn;
    try {
      turn = normalizeTurnInput(input);
    } catch (error) {
      const turnId = typeof input?.turnId === 'string' ? input.turnId : '';
      dispatchAttachmentDraft({
        type: 'rejected',
        turnId,
        error: { code: 'TURN_INPUT_INVALID', message: error.message },
      });
      return;
    }
    pendingTurnRef.current = turn;
    acceptedTurnRef.current = null;
    try {
      const result = activeBackend.sendUser(turn);
      Promise.resolve(result).catch((error) => {
        if (pendingTurnRef.current?.turnId !== turn.turnId) return;
        handleChatEvent({
          type: 'error',
          kind: error?.kind || 'backend',
          code: error?.code || 'BACKEND_ERROR',
          message: error?.message || String(error),
          turnId: turn.turnId,
          dispatchState: error?.dispatchState || 'uncertain',
        });
      });
    } catch (error) {
      handleChatEvent({
        type: 'error',
        kind: error?.kind || 'backend',
        code: error?.code || 'BACKEND_ERROR',
        message: error?.message || String(error),
        turnId: turn.turnId,
        dispatchState: error?.dispatchState || 'not-started',
      });
    }
  };

  const newChatSession = () => {
    activeBackend.reset();
    resetAttachmentDraftSession();
    setChatStreaming(false);
    setThinkingActive(false);
    setChatEntries([]);
  };

  // Note: the log-level filter is intentionally applied at append time only; existing buffered lines are unaffected by later level changes.
  const pushLog = React.useCallback((m) => {
    const message = String(m ?? '');
    const host = getHost();
    try {
      if (host && host.hostLog && typeof host.hostLog.record === 'function') {
        const level = /error|failed|exception/i.test(message)
          ? 'error'
          : (/warn|timeout|unavailable/i.test(message) ? 'warn' : 'info');
        host.hostLog.record({ source: 'panel', level, message });
      }
    } catch (error) {
      // Logging must never change the panel's existing error path.
    }
    if (!keepLogLine(logLevelRef.current, message)) return;
    setLogs((xs) => [...xs.slice(-199), `[${new Date().toLocaleTimeString()}] ${message}`]);
  }, [getHost]);

  const repairPlatformHelper = React.useCallback(async () => {
    if (providerRepairing) return;
    setProviderRepairing(true);
    try {
      const controller = ctrl.current;
      if (!controller || typeof controller.repairPlatformHelper !== 'function') {
        throw providerRuntimeUnavailableError();
      }
      await controller.repairPlatformHelper();
      pushLog('Platform Helper repaired; rechecking protected provider state');
      setProviderInitEpoch((current) => current + 1);
    } catch (error) {
      setProviderInit(providerRepairFailure(error));
      pushLog('Platform Helper repair failed: ' + (
        typeof error?.code === 'string' ? error.code : 'HELPER_UNAVAILABLE'
      ));
    } finally {
      setProviderRepairing(false);
    }
  }, [providerRepairing, pushLog]);

  const exportLogs = React.useCallback(async () => {
    try {
      let exactSecrets = [];
      try { exactSecrets = providerSecretService.getRedactionValues() || []; } catch (error) { exactSecrets = []; }
      if (zcodeStoredKeyRef.current) exactSecrets.push(zcodeStoredKeyRef.current);
      const attachmentSecrets = attachmentPathSecrets({
        draft: attachmentDraft,
        pendingTurn: pendingTurnRef.current,
      });
      exactSecrets.push(...attachmentSecrets);
      const host = getHost();
      let diagnosticItems;
      let diagnosticsError = null;
      try {
        diagnosticItems = await runDiagnostics({
          getHost,
          port: status.port,
          fs: cepRequire('fs'),
          fetchImpl: window.fetch.bind(window),
          platform,
          runtimeManager,
          allowDevelopmentPath: developmentRuntimeFallback,
        });
      } catch (error) {
        diagnosticsError = error?.message || String(error);
      }
      const safeValue = (read, fallback = undefined) => {
        try { return read(); } catch (error) { return fallback; }
      };
      const connection = (host && typeof host.getConnectionInfo === 'function')
        ? safeValue(() => host.getConnectionInfo(), {})
        : (connInfo || {});
      const hostLog = host && host.hostLog;
      const hostLogStats = hostLog && typeof hostLog.stats === 'function'
        ? (safeValue(() => hostLog.stats(), {}) || {})
        : {};
      const logsDir = hostLogStats.dir || platform.paths.logsRoot;
      const processApi = window.cep_node?.process || globalThis.process || {};
      let aeApp = {};
      try {
        const env = cs.getHostEnvironment ? (cs.getHostEnvironment() || {}) : {};
        // Identity fields only; appSkinInfo is a UI palette and just noise here.
        for (const key of ['appName', 'appId', 'appVersion', 'appLocale', 'appUILocale', 'isAppOnline']) {
          if (env[key] !== undefined) aeApp[key] = env[key];
        }
      } catch (error) { aeApp = {}; }
      let cepVersion = '-';
      try {
        const apiVersion = cs.getCurrentApiVersion ? cs.getCurrentApiVersion() : null;
        const parts = [apiVersion?.major, apiVersion?.minor, apiVersion?.micro];
        if (parts.every((part) => part !== undefined && part !== null && part !== '')) cepVersion = parts.join('.');
      } catch (error) { /* best effort */ }
      // OS identity comes from the platform adapter (no direct `os` module in
      // business code — see scripts/package/test/no-platform-leaks.test.mjs);
      // the Chromium UA line in the same header carries the OS release.
      const osInfo = { platform: platform.id || '-' };
      const versions = processApi.versions || {};
      const today = new Date();
      const dateKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
      const pythonLogPath = platform.paths.join([logsDir, 'server-' + dateKey + '.log']);
      let pythonServerLog;
      try {
        const hasFile = [0, 1].some((offset) => {
          const date = new Date(today);
          date.setDate(date.getDate() - offset);
          const key = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
          return platform.fs.existsSync(platform.paths.join([logsDir, 'server-' + key + '.log']));
        });
        pythonServerLog = hasFile ? readDatedLogTail({
          fsImpl: platform.fs,
          pathJoin: platform.paths.join,
          dir: logsDir,
          prefix: 'server-',
          suffix: '.log',
          now: today,
          days: 2,
          lines: 300,
        }) : undefined;
      } catch (error) {
        pythonServerLog = undefined;
      }
      const backendStderrTails = {};
      for (const [name, backend] of [
        ['claude', claudeBackend],
        ['codex', codexBackend],
        ['opencode', openCodeBackend],
        ['zcode', zcodeBackend],
      ]) {
        if (!backend || typeof backend.getStderrTail !== 'function') continue;
        try {
          backendStderrTails[name] = backend.getStderrTail();
        } catch (error) {
          backendStderrTails[name] = '(unavailable: ' + (error?.message || String(error)) + ')';
        }
      }
      const text = buildLogExport({
        panelLogs: logs,
        hostInfo: {
          hostVersion: connection.hostVersion || '-',
          pythonVersion: connection.pythonVersion || '-',
          aeApp,
          cepVersion,
          os: osInfo,
          hostNode: hostLogStats.nodeVersion || processApi.version || '-',
          chromiumUa: navigator.userAgent || '-',
          pluginPort: connection.port || status.port,
          logsDir,
          logLevel: logLevelRef.current,
        },
        hostActivity: host && host.activity && typeof host.activity.list === 'function'
          ? safeValue(() => host.activity.list())
          : undefined,
        hostLogMemory: hostLog && typeof hostLog.tail === 'function'
          ? safeValue(() => hostLog.tail(500))
          : undefined,
        hostLogDisk: hostLog && typeof hostLog.readFileTail === 'function'
          ? safeValue(() => hostLog.readFileTail({ days: 2, lines: 500 }))
          : undefined,
        diagnostics: diagnosticItems,
        diagnosticsError,
        backendStderrTails,
        pythonServerLog,
        pythonLogPath,
        version: pkgVersion,
        exactSecrets,
      });
      const file = writeLogExport({ text, fileName: exportFileName() });
      revealInExplorer(file, undefined, (err) => pushLog('Log export reveal failed: ' + (err && err.message ? err.message : String(err))));
      pushLog('Log exported: ' + file);
    } catch (e) {
      pushLog('Log export failed: ' + (e && e.message ? e.message : String(e)));
    }
  }, [logs, connInfo, claudeBackend, codexBackend, openCodeBackend, zcodeBackend, providerSecretService, pushLog, attachmentDraft, getHost, platform, runtimeManager, developmentRuntimeFallback, status.port, cs]);

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
        const host = getHost();
        if (!host || typeof host.capabilities !== 'function') throw providerRuntimeUnavailableError();
        const capabilities = await host.capabilities();
        requireProviderHelperCapabilities(capabilities, platform.id);
        try {
          const value = await zcodeCredentialManager.loadOrMigrate();
          if (alive) {
            zcodeStoredKeyRef.current = value;
            setZcodeCredentialEpoch((current) => current + 1);
          }
        } catch {
          if (alive) {
            zcodeStoredKeyRef.current = '';
            setZcodeCredentialEpoch((current) => current + 1);
          }
          pushLog('ZCode credential unavailable: protected credential migration is required');
        }
        if (!providerStore) {
          const error = new Error('Provider store is unavailable');
          error.code = 'PROVIDER_STORE_UNAVAILABLE';
          throw error;
        }
        if (providerStore.needsSecretMigration() || providerStore.needsSchemaMigration()) {
          const secretStore = createHostSecretStore(host);
          const runner = createSecretMigrationRunner({
            journalStore: createProviderMigrationJournalStore(platform),
            secretStore,
          });
          await migrateProviderStoreSecrets({
            store: providerStore,
            legacyKeyStore: {
              readKey: (name) => { try { return legacyKeyStore ? legacyKeyStore.readKey(name) : ''; } catch { return ''; } },
              async cleanupCommittedProviderSecrets() {
                if (!legacyKeyStore) return;
                legacyKeyStore.clearKey('anthropic');
                legacyKeyStore.clearKey('codex');
              },
            },
            runner,
            secretStore: host,
          });
        }
        if (providerStore.needsSchemaMigration()) {
          await migrateProviderStoreV2ToV3({ store: providerStore });
        }
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
        assertProviderStateCredentialFree(
          providerState,
          providerSecretService.getRedactionValues(),
        );
        if (!alive) return;
        setProviders(providerState.providers);
        setProviderInit({ state: 'ready', error: '' });
      } catch (error) {
        if (!alive) return;
        setProviderInit(providerInitFailure(error));
      }
    })();
    return () => { alive = false; };
  }, [status.state, providerStore, providerSecretService, getHost, legacyKeyStore, platform, pushLog, providerInitEpoch, zcodeCredentialManager]);

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
        platform,
        runtimeManager,
        allowDevelopmentPath: developmentRuntimeFallback,
      });
      const verifiedRuntime = items.find((item) => item.id === 'node' && item.ok && item.runtime)?.runtime;
      if (verifiedRuntime) markRuntimeReady(verifiedRuntime);
      setDiagnostics(items);
    } catch (e) {
      setDiagnostics([{ id: 'host-listening', ok: false, detail: String(e && e.message), fixHint: { zh: '诊断执行失败，重启面板后重试。', en: 'Diagnostics failed to run; reload the panel and retry.' } }]);
    }
  }, [developmentRuntimeFallback, getHost, markRuntimeReady, platform, runtimeManager, status.port]);

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

  const mcpConfigStr = runtimeReady ? JSON.stringify(buildMcpConfig(
    status.port,
    expertGuidance,
    mcpCommand,
  ), null, 2) : '';
  const claudeStatus = probe === null ? { state: 'checking' }
    : probe.nodeOk === false ? { state: 'no-node', detail: probe.detail }
    : probe.loggedIn === false ? { state: 'not-logged-in', detail: probe.detail }
    : { state: 'ready', nodeVersion: probe.nodeVersion };
  const wizard = useWizardWiring({
    extRoot,
    lang,
    claudeStatus,
    recheckLogin: runClaudeProbe,
    platform,
    runtimeManager,
    onRuntimeReady: markRuntimeReady,
  });

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
        mcpCommand={mcpCommand}
        mcpReady={runtimeReady}
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
    { id: 'tools', icon: 'wrench', label: t.tools },
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
            onAnswerQuestion={(id, result) => activeBackend.answerQuestion
              && activeBackend.answerQuestion(id, result)}
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
            attachmentDraft={attachmentDraft}
            dispatchAttachmentDraft={dispatchAttachmentDraft}
            createTurnId={randomProviderCredentialId}
            onAddFile={addAttachment}
            onRemoveAttachment={removeAttachment}
            onRetryAttachment={retryAttachment}
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
        {tab === 'tools' ? (
          <ToolsScreen
            api={toolsApi}
            lang={lang}
            cepFs={window.cep && window.cep.fs}
            initialPath={extRoot}
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
            mcpCommand={mcpCommand}
            mcpReady={runtimeReady}
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
            selectedChannel={channelChoices[backendPref === 'codex' ? 'codex' : 'claude'] || ''}
            onSelectChannel={(channel) => {
              // #229: enabling a channel is the routing decision and actively
              // triggers that backend's detection.
              const group = backendPref === 'codex' ? 'codex' : 'claude';
              setChannelChoices((current) => ({ ...current, [group]: channel }));
              writePref('ae_mcp_channel_' + group, channel);
              if (group === 'codex') {
                codexBackend.reset();
                runCodexProbe();
              } else {
                runClaudeProbe();
              }
            }}
            onRecheckBackend={() => {
              if (backendPref === 'codex') runCodexProbe();
              else if (backendPref === 'zcode') runZcodeProbe();
              else runClaudeProbe();
            }}
            recheckDisabled={backendPref === 'codex' ? codexProbe === null : backendPref === 'zcode' ? zcodeProbe === null : probe === null}
            providers={providers}
            providerManager={providerManager}
            providerInit={providerInit}
            providerRepairing={providerRepairing}
            onRepairPlatformHelper={repairPlatformHelper}
            claudeProviderId={claudeProviderId}
            onClaudeProviderChange={(id) => { setClaudeProviderId(id); writePref('ae_mcp_claude_provider', id); }}
            codexProviderId={codexProviderId}
            onCodexProviderChange={(id) => {
              // #229: picking a provider only configures the custom channel;
              // routing still follows the user's explicit channel choice.
              setCodexProviderId(id);
              writePref('ae_mcp_codex_provider', id);
              setCodexProbe(null);
              codexBackend.reset();
            }}
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
            onSaveZcodeKey={async (k) => {
              try {
                const value = await zcodeCredentialManager.save(k);
                zcodeStoredKeyRef.current = value;
                setZcodeCredentialEpoch((current) => current + 1);
                setZcodeProbe(null);
                zcodeBackend.reset();
                runZcodeProbe();
                return true;
              } catch {
                pushLog('ZCode credential save failed: protected credential store is unavailable');
                return false;
              }
            }}
            zcodeKeyStored={Boolean(zcodeStoredKeyRef.current)}
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
        copyReady={runtimeReady}
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
      <ToolApprovalDialog
        record={toolApproval && toolApproval.plan ? toolApproval : null}
        lang={lang}
        onResolve={(result) => elicitationCoordinator.resolveVisible(result)}
      />
      <QuestionFormDialog
        record={toolApproval && !toolApproval.plan ? toolApproval : null}
        lang={lang}
        onResolve={(result) => elicitationCoordinator.resolveVisible(result)}
      />
    </React.Fragment>
  );
}

export function App({ cs }) {
  return <LangProvider><Shell cs={cs} /></LangProvider>;
}
