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
import { SessionDrawer } from '../screens/SessionDrawer';
import { ChatScreen } from '../screens/ChatScreen';
import { ToolsScreen } from '../screens/ToolsScreen';
import { ToolApprovalDialog } from '../components/tools/ToolApprovalDialog';
import { QuestionFormDialog } from '../components/tools/QuestionFormDialog';
import { questionsFromElicitationSchema } from '../lib/questionForm';
import { createPanelFileDropGuard } from '../lib/panelFileDrop';
import { revertToPreviousCheckpoint } from '../lib/activityModel';
import { pickBackend, deriveToolMeta } from '../lib/backendSelect';
import { decideBackendReset } from '../lib/backendResetDecision.js';
import { installBeforeUnloadReset } from '../lib/backendLifecycle.js';
import { containsExactSecret } from '../lib/exactSecretRedaction.js';
import { redactCredentialText } from '../lib/credentialTextRedaction.js';
import { firstErrorDetailLine, serializeErrorDetail } from '../lib/errorDetail.js';
import { createMcpClient } from '../cep/mcpClient';
import { createToolsApi } from '../cep/toolsApi';
import { probeClaudeLogin } from '../cep/claudeAuth';
import { startCodexLogin } from '../cep/codexHeadlessLogin.js';
import { createClaudeAgentBackend } from '../cep/claudeAgentBackend';
import { createCodexBackend } from '../cep/codexBackend';
import { createOpenCodeBackend } from '../cep/openCodeBackend';
import {
  claudeChannels,
  codexChannels,
  openCodeChannels,
  migrateBackendPref,
} from '../lib/channels.js';
import { createOpenCodeProviderStore } from '../cep/openCodeProviderStore.js';
import { probeOpenCodeProviderModels } from '../cep/openCodeModelProbe.js';
import { ProviderManagerSection } from '../components/settings/ProviderManagerSection';
import { reduceEvent, userTurnEntry } from '../lib/chatEntries';
import {
  createAttachmentDraftState,
  reduceAttachmentDraft,
} from '../lib/attachmentDraft.js';
import { createAttachmentStore } from '../cep/attachmentStore.js';
import { claudeSubDescriptor, resolveEffectiveEffort } from '../lib/backendCapabilities';
import { selectDescriptor, reconcileModelPref } from '../lib/descriptorSelect';
import { baseDescriptorFor } from '../cep/backends/index.js';
import { costBadge } from '../lib/composerOptions';
import { useActivity } from '../cep/useActivity';
import { isWizardDone, markWizardDone, clearWizardDone } from '../cep/firstRun';
import { useWizardWiring } from './wizardWiring';
import { runDiagnostics } from '../cep/diagnostics';
import { copyText } from '../lib/clipboard';
import { copyWizardConfig } from '../lib/wizardCopy.js';
import { createHostController, loadSavedPort, savePort, DEFAULT_PORT, isValidPort } from '../cep/hostBridge';
import { httpConfigFor } from '../cep/externalClients.js';
import { loadExpertGuidance, saveExpertGuidance } from '../lib/expertGuidance.js';
import pkg from '../../package.json';
import { attachmentPathSecrets, buildLogExport, exportFileName, keepLogLine } from '../lib/logExport.js';
import { writeLogExport, revealInExplorer } from '../cep/logExportFs.js';
import { createPlatformAdapter } from '../cep/platform/index.js';
import { readCepSystemPath } from '../cep/platform/paths.js';
import { createElicitationCoordinator } from '../lib/elicitationCoordinator.js';
import { createHostConversation } from '../lib/hostConversation.js';
import { createHostApprovalBridge } from '../lib/hostApprovalBridge.js';
import { createSessionController } from '../lib/sessionController.js';
import { createSessionStore } from '../cep/sessionStore.js';
import { displayTitle } from '../lib/sessionList.js';
import { reduceTurnStage } from '../lib/turnProgress.js';
import { getMcpSpec as resolveChatMcpSpec } from '../lib/mcpEngine.js';
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
    stopTaskTitle: '停止当前任务并切换？',
    stopTaskBody: '当前任务仍在运行。继续会停止当前任务，然后执行会话切换或新建会话。',
    stopTaskConfirm: '停止并继续',
    approvalSyncError: '审批档位未同步，请重载面板后再操作',
    cancel: '取消',
    pausedHint: '已暂停 — 恢复后才能发送',
    goSettings: '去设置',
    sessions: '会话历史',
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
    stopTaskTitle: 'Stop the current task and continue?',
    stopTaskBody: 'A task is still running. Continuing will stop it before switching or creating a session.',
    stopTaskConfirm: 'Stop and continue',
    approvalSyncError: 'Approval mode is not synced. Reload the panel before continuing.',
    cancel: 'Cancel',
    pausedHint: 'Paused — resume to send',
    goSettings: 'Open Settings',
    sessions: 'Session history',
  },
};

const pkgVersion = pkg.version;
const PROBE_PENDING_GRACE_MS = 8000;
const LOGIN_POLL_INTERVAL_MS = 5000;
const LOGIN_POLL_LIMIT_MS = 5 * 60 * 1000;

function readPref(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v || fallback;
  } catch (e) { return fallback; }
}
function writePref(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* best-effort */ }
}

function openLoginUrl(url) {
  if (typeof window?.cep?.util?.openURLInDefaultBrowser !== 'function') {
    throw new Error('CEP browser opener is unavailable');
  }
  window.cep.util.openURLInDefaultBrowser(url);
}

const DEFAULT_MODEL = claudeSubDescriptor().defaultModelId;

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

function modelMetadataContainsCredential(models, credentials = []) {
  const values = Array.isArray(credentials) ? credentials : (credentials ? [credentials] : []);
  return containsExactSecret(models, ['aemcp-secret://', ...values]);
}

function Shell({ cs }) {
  const { lang, setLang } = useLang();
  const langRef = React.useRef(lang);
  langRef.current = lang;
  const t = T[lang];
  const [tab, setTab] = React.useState('chat');
  const [status, setStatus] = React.useState({ state: 'starting', port: DEFAULT_PORT, error: null });
  const statusRef = React.useRef(status);
  statusRef.current = status;
  const [paused, setPaused] = React.useState(false);
  const [logs, setLogs] = React.useState([]);
  const backendErrorsRef = React.useRef([]);
  const panelLogRef = React.useRef(null);
  const ctrl = React.useRef(null);
  const getHost = React.useCallback(() => (ctrl.current ? ctrl.current.getHost() : null), []);
  const hostConversation = React.useMemo(() => createHostConversation({ getHost }), [getHost]);
  const hostApprovalBridge = React.useMemo(() => createHostApprovalBridge(), []);
  const [hostConversationError, setHostConversationError] = React.useState('');
  const runHostConversationSync = React.useCallback((operation) => {
    try {
      const value = operation();
      setHostConversationError('');
      return value;
    } catch (error) {
      const message = error?.message || String(error);
      setHostConversationError(message);
      panelLogRef.current?.(`Host conversation sync failed: ${message}`);
      return null;
    }
  }, []);

  // First-run wizard
  const [wizardDone, setWizardDone] = React.useState(() => isWizardDone(window.localStorage));
  const [wizStep, setWizStep] = React.useState(1);

  // Connection drawer + diagnostics
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [sessionsOpen, setSessionsOpen] = React.useState(false);
  const [connInfo, setConnInfo] = React.useState(null);
  const [diagnostics, setDiagnostics] = React.useState(null);

  // Activity feed (in-process subscription)
  const { events, clear } = useActivity(getHost);

  // Settings: live client registry + token regeneration
  const [clients, setClients] = React.useState([]);
  const [mcpSessions, setMcpSessions] = React.useState([]);
  const [confirmRegen, setConfirmRegen] = React.useState(false);
  const [confirmChatNavigation, setConfirmChatNavigation] = React.useState(null);
  const [tokenEpoch, setTokenEpoch] = React.useState(0);

  // Embedded chat: provider references, model/permission prefs, entry feed.
  // Resolved provider values exist only inside a request/probe/spawn call.
  const platform = React.useMemo(() => createPlatformAdapter(), []);
  const sessionStore = React.useMemo(() => createSessionStore({
    platform,
    log: (message) => panelLogRef.current?.(message),
  }), [platform]);
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
    runHostConversationSync(() => hostConversation.updatePolicy({ approvalTier: permissionMode }));
  }, [hostConversation, permissionMode, runHostConversationSync]);
  React.useEffect(() => () => {
    elicitationCoordinator.dispose();
  }, [elicitationCoordinator]);
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
  const openCodeProviderStore = React.useMemo(() => createOpenCodeProviderStore({ platform }), [platform]);
  const [providerInit, setProviderInit] = React.useState({ state: 'checking', error: '' });
  const [providers, setProviders] = React.useState([]);
  const providersRef = React.useRef(providers);
  providersRef.current = providers;
  const providerSensitiveValues = React.useMemo(() => providers.map((provider) => {
    try { return openCodeProviderStore.readApiKey(provider.id); } catch { return ''; }
  }).filter(Boolean), [openCodeProviderStore, providers]);
  const providerSensitiveValuesRef = React.useRef(providerSensitiveValues);
  providerSensitiveValuesRef.current = providerSensitiveValues;
  const [expertGuidance, setExpertGuidance] = React.useState(() => loadExpertGuidance(window.localStorage));
  const expertGuidanceRef = React.useRef(expertGuidance);
  expertGuidanceRef.current = expertGuidance;
  React.useEffect(() => {
    runHostConversationSync(() => hostConversation.updatePolicy({ expertGuidance }));
  }, [expertGuidance, hostConversation, runHostConversationSync]);
  React.useEffect(() => {
    if (status.state !== 'ok') return;
    runHostConversationSync(() => hostConversation.ensureConversation({
      label: chatSessionIdRef.current,
      approvalTier: permissionModeRef.current,
      expertGuidance: expertGuidanceRef.current,
    }));
  }, [hostConversation, runHostConversationSync, status.state]);
  const resolveHostConversationContext = React.useCallback((conversationId) => {
    const current = hostConversation.currentConversation();
    if (!current || current.id !== conversationId) return null;
    return {
      conversationId,
      conversationLabel: current.label || chatSessionIdRef.current,
    };
  }, [hostConversation]);
  React.useEffect(() => {
    if (status.state !== 'ok') {
      hostApprovalBridge.detach();
      return undefined;
    }
    const host = getHost();
    const approvals = host && host.mcp && host.mcp.approvals;
    hostApprovalBridge.attach({
      approvals,
      coordinator: elicitationCoordinator,
      resolveConversationContext: resolveHostConversationContext,
    });
    return () => hostApprovalBridge.detach();
  }, [elicitationCoordinator, getHost, hostApprovalBridge, resolveHostConversationContext, status.state]);
  const [probe, setProbe] = React.useState(null);
  const [codexProbe, setCodexProbe] = React.useState(null);
  const [codexModels, setCodexModels] = React.useState(null);
  const [loginState, setLoginState] = React.useState({ channel: '', status: 'idle', detail: '' });
  const codexLoginRef = React.useRef(null);
  const [openCodeProbe, setOpenCodeProbe] = React.useState(null);
  const [openCodeProbeStale, setOpenCodeProbeStale] = React.useState(false);
  const [openCodeProbeAttempt, setOpenCodeProbeAttempt] = React.useState(0);
  const openCodeProbeRunRef = React.useRef(0);
  const openCodeAvailableProviders = React.useMemo(() => (
    Array.isArray(openCodeProbe?.providers) && openCodeProbe.providers.length
      ? openCodeProbe.providers
      : providers
  ), [openCodeProbe, providers]);
  const [chatEntries, setChatEntries] = React.useState([]);
  const chatEntriesRef = React.useRef(chatEntries);
  chatEntriesRef.current = chatEntries;
  const sessionControllerRef = React.useRef(null);
  const [chatStreaming, setChatStreaming] = React.useState(false);
  const [thinkingActive, setThinkingActive] = React.useState(false);
  const [turnStage, setTurnStage] = React.useState(null);
  const [turnProgress, setTurnProgress] = React.useState(null);
  const baseDescriptor = React.useMemo(
    () => baseDescriptorFor(backendPref),
    [backendPref],
  );
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
  const providerManager = (
    <ProviderManagerSection
      lang={lang}
      providers={providers}
      disabled={providerInit.state !== 'ready' || chatStreaming}
      onProbe={async (draft, { apiKey }) => probeOpenCodeProviderModels({
        draft,
        apiKey: apiKey || openCodeProviderStore.readApiKey(draft.id || ''),
        adapter: platform,
      })}
      onUpsert={async (event, draft) => {
        const formElement = event.currentTarget;
        const form = new FormData(event.currentTarget);
        const apiKey = String(form.get('modelAuthSecret') || '');
        form.delete('modelAuthSecret');
        formElement?.reset?.();
        try {
          if (String(draft.baseUrl || '').startsWith('http:') && draft.allowInsecureHttp === true) {
            if (!window.confirm(`Allow provider requests over insecure HTTP?\n${draft.baseUrl}`)) return;
          }
          openCodeProviderStore.save(draft, { apiKey, currentId: draft.id });
          const nextProviders = openCodeProviderStore.list();
          // React state commits after this handler returns, while reset/probe
          // below reads the synchronous ref. Publish the new registry to both
          // so the first regenerated opencode.json cannot reuse old limits.
          providersRef.current = nextProviders;
          setProviders(nextProviders);
          if (apiKey) {
            providerSensitiveValuesRef.current = Array.from(new Set([
              ...providerSensitiveValuesRef.current,
              apiKey,
            ]));
          }
          openCodeBackend.reset();
          runOpenCodeProbe();
        } finally {
          form.delete('modelAuthSecret');
        }
      }}
      onRemove={async (provider) => {
        openCodeProviderStore.remove(provider.id);
        const nextProviders = openCodeProviderStore.list();
        providersRef.current = nextProviders;
        setProviders(nextProviders);
        openCodeBackend.reset();
        runOpenCodeProbe();
      }}
    />
  );
  const channels = React.useMemo(() => ({
    claude: claudeChannels({
      probe,
      canOpenLoginTerminal: typeof platform.openLoginTerminal === 'function',
    }),
    codex: codexChannels({
      codexProbe,
      loginFallback: loginState.channel === 'cli' && loginState.status === 'fallback',
    }),
    opencode: openCodeChannels({
      probe: openCodeProbe,
      providers: openCodeAvailableProviders,
    }),
  }), [
    probe,
    codexProbe,
    loginState.channel,
    loginState.status,
    openCodeProbe,
    openCodeAvailableProviders,
    platform,
  ]);
  const effective = pickBackend({ pref: backendPref, channels, channelChoices });
  const effectiveBackendRef = React.useRef(effective.backend);
  effectiveBackendRef.current = effective.backend;
  const effectiveChannelRef = React.useRef(effective.channel);
  effectiveChannelRef.current = effective.channel;
  const runtimeRef = React.useRef({
    model: effectiveModel,
    permissionMode,
    effort: effectiveEffort,
    thinking: null,
    fast: effectiveFast,
  });
  const extRoot = React.useMemo(() => readCepSystemPath({ cs, platform }), [cs, platform]);
  const hostPortRef = React.useRef(status.port);
  hostPortRef.current = status.port;
  const getMcpSpec = React.useCallback(() => resolveChatMcpSpec({
    port: hostPortRef.current,
    label: chatSessionIdRef.current,
    approvalTier: permissionModeRef.current,
    expertGuidance: expertGuidanceRef.current,
    hostConversation,
  }), [hostConversation]);
  const mcp = React.useMemo(() => createMcpClient({
    extRoot,
    getHost,
    getPort: () => hostPortRef.current,
    getConversation: () => hostConversation.ensureConversation({
      label: chatSessionIdRef.current,
      approvalTier: permissionModeRef.current,
      expertGuidance: expertGuidanceRef.current,
    }),
  }), [extRoot, getHost, hostConversation]);
  const toolsApi = React.useMemo(() => createToolsApi(mcp), [mcp]);
  React.useEffect(() => () => mcp.stop(), [mcp]);
  const releaseTurnAttachments = React.useCallback((turn) => {
    for (const attachment of turn?.attachments || []) {
      attachmentStore.release(attachment.id);
    }
  }, [attachmentStore]);
  const resetAttachmentDraftSession = React.useCallback((nextSessionId = null) => {
    attachmentStore.releaseSession(chatSessionIdRef.current);
    attachmentOperationsRef.current.clear();
    pendingTurnRef.current = null;
    acceptedTurnRef.current = null;
    dispatchAttachmentDraft({ type: 'reset' });
    if (nextSessionId) {
      chatSessionIdRef.current = nextSessionId;
      setChatSessionId(nextSessionId);
    }
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
  const commitChatEntries = React.useCallback((updater, event) => {
    const current = chatEntriesRef.current;
    const next = typeof updater === 'function' ? updater(current) : updater;
    chatEntriesRef.current = Array.isArray(next) ? next : current;
    setChatEntries(chatEntriesRef.current);
    sessionControllerRef.current?.recordEntries(chatEntriesRef.current, event);
  }, []);
  const handleChatEvent = React.useCallback((evt) => {
    const pending = pendingTurnRef.current;
    setTurnStage((current) => reduceTurnStage(current, evt, {
      pendingTurnId: pending?.turnId,
    }));
    const progressMatches = evt.turnId
      ? evt.turnId === pending?.turnId
      : Boolean(pending);
    if (evt.type === 'turn-progress' && progressMatches) {
      setTurnProgress((current) => ({
        ...(current || {}),
        stage: evt.stage || current?.stage || null,
        ...(evt.estimatedTokens === undefined ? {} : { estimatedTokens: evt.estimatedTokens }),
        ...(evt.elapsedMs === undefined ? {} : { elapsedMs: evt.elapsedMs }),
        warning: false,
      }));
    }
    if (evt.type === 'turn-progress-warning' && progressMatches) {
      setTurnProgress((current) => ({
        ...(current || {}),
        warning: true,
        ...(evt.elapsedMs === undefined ? {} : { warningElapsedMs: evt.elapsedMs }),
        ...(evt.warningMs === undefined ? {} : { warningMs: evt.warningMs }),
      }));
    }
    if (evt.type === 'session-ref') {
      sessionControllerRef.current?.recordBackendRef(evt.ref);
      return;
    }
    if (evt.type === 'error') {
      const exactSecrets = attachmentPathSecrets({ pendingTurn: pending });
      const effectiveBackend = effectiveBackendRef.current;
      const backend = effectiveBackend === 'subscription' ? 'claude' : effectiveBackend;
      const message = redactCredentialText(evt.message || 'Backend error', exactSecrets).slice(0, 2000);
      const detail = serializeErrorDetail(evt.detail, exactSecrets, 2000);
      const record = {
        ts: new Date().toISOString(),
        backend: backend || 'none',
        code: evt.code || 'BACKEND_ERROR',
        kind: evt.kind || 'backend',
        message,
        detail: firstErrorDetailLine(evt.detail, exactSecrets),
      };
      backendErrorsRef.current = [...backendErrorsRef.current.slice(-49), record];
      try {
        const host = getHost();
        if (host?.hostLog && typeof host.hostLog.record === 'function') {
          host.hostLog.record({
            source: 'chat',
            level: 'error',
            backend: record.backend,
            code: record.code,
            kind: record.kind,
            message,
            detail,
          });
        }
      } catch (error) {
        // Logging must not change turn settlement or draft recovery.
      }
    }
    if (evt.type === 'turn-accepted') {
      if (!pending || evt.turnId !== pending.turnId) return;
      acceptedTurnRef.current = pending.turnId;
      commitChatEntries((entries) => entries.concat(userTurnEntry(pending)), evt);
      dispatchAttachmentDraft({ type: 'accepted', turnId: pending.turnId });
      setChatStreaming(true);
      return;
    }
    if (evt.type === 'error' && pending && acceptedTurnRef.current !== pending.turnId) {
      if (evt.turnId !== pending.turnId) return;
      setChatStreaming(false);
      setThinkingActive(false);
      setTurnStage(null);
      setTurnProgress(null);
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
      setTurnStage(null);
      setTurnProgress(null);
    }
    commitChatEntries((entries) => reduceEvent(entries, evt), evt);
  }, [commitChatEntries, releaseTurnAttachments]);

  const claudeBackend = React.useMemo(() => createClaudeAgentBackend({
    platform,
    getMcpSpec,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getEffort: () => runtimeRef.current.effort,
    getThinking: () => runtimeRef.current.thinking,
    getChannel: () => 'subscription',
    getLang: () => langRef.current,
    onEvent: handleChatEvent,
  }), [
    getMcpSpec,
    mcp,
    handleChatEvent,
    platform,
  ]);

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
    getLang: () => langRef.current,
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, getMcpSpec, mcp, handleChatEvent, platform]);

  const openCodeBackend = React.useMemo(() => createOpenCodeBackend({
    platform,
    getMcpSpec,
    getModel: () => runtimeRef.current.model,
    getPermissionMode: () => runtimeRef.current.permissionMode,
    getToolMeta: async () => deriveToolMeta(await mcp.listTools()),
    getProviders: () => providersRef.current,
    getSensitiveValues: () => providerSensitiveValuesRef.current,
    getExpertGuidance: () => loadExpertGuidance(window.localStorage),
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    getLang: () => langRef.current,
    onEvent: handleChatEvent,
  }), [extRoot, getMcpSpec, mcp, handleChatEvent, platform]);

  runtimeRef.current = {
    model: effectiveModel,
    permissionMode,
    effort: effectiveEffort,
    thinking: modelMeta.adaptive === true ? 'adaptive' : null,
    fast: effectiveFast,
  };
  // Map real-backend id -> instance.
  const backendInstances = {
    subscription: claudeBackend,
    codex: codexBackend,
    opencode: openCodeBackend,
  };
  const activeBackend = (() => {
    if (effective.backend === 'none') return null;
    const backend = backendInstances[effective.backend];
    if (backend) return backend;
    const knownBackendIds = Object.keys(backendInstances).join(', ');
    throw new Error(
      `Unknown backend id "${effective.backend}". Known backend ids: ${knownBackendIds}`,
    );
  })();
  const backendInstancesRef = React.useRef(backendInstances);
  backendInstancesRef.current = backendInstances;
  const activeBackendInstanceRef = React.useRef(activeBackend);
  activeBackendInstanceRef.current = activeBackend;
  const pendingSessionLoadRef = React.useRef(null);
  const [sessionSnapshot, setSessionSnapshot] = React.useState({ sessions: [], activeId: null });
  const sessionController = React.useMemo(() => createSessionController({
    store: sessionStore,
    now: () => Date.now(),
    uuid: randomProviderCredentialId,
    deps: {
      stopActiveTurn: () => activeBackendInstanceRef.current?.stop?.(),
      resetActiveBackend: () => activeBackendInstanceRef.current?.reset?.(),
      cancelPendingUi: () => elicitationCoordinator.cancelAll(),
      rotateHostConversation: (sessionId) => {
        resetAttachmentDraftSession(sessionId);
        hostConversation.closeConversation();
        if (statusRef.current.state === 'ok') {
          hostConversation.ensureConversation({
            label: sessionId,
            approvalTier: permissionModeRef.current,
            expertGuidance: expertGuidanceRef.current,
          });
        }
      },
      adoptBackendRef: (backend, ref) => {
        backendInstancesRef.current[backend]?.adoptSessionRef?.(ref);
      },
      getBackendRef: () => activeBackendInstanceRef.current?.getSessionRef?.() || null,
      setEntries: (entries) => {
        chatEntriesRef.current = entries;
        setChatEntries(entries);
      },
      getEntries: () => chatEntriesRef.current,
      selectBackend: async (backend) => {
        lastRealBackendRef.current = backend;
        setBackendPref(backend);
        writePref('ae_mcp_backend', backend);
        await new Promise((resolve) => {
          const afterPaint = () => setTimeout(resolve, 0);
          if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(afterPaint);
          else afterPaint();
        });
      },
      currentBackend: () => effectiveBackendRef.current,
      currentModel: () => runtimeRef.current.model,
      currentChannel: () => effectiveChannelRef.current,
      log: (message) => panelLogRef.current?.(message),
    },
  }), [
    elicitationCoordinator,
    hostConversation,
    resetAttachmentDraftSession,
    sessionStore,
  ]);
  sessionControllerRef.current = sessionController;
  React.useEffect(() => sessionController.subscribe(setSessionSnapshot), [sessionController]);
  const sessionBootStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (status.state !== 'ok' || effective.backend === 'none' || sessionBootStartedRef.current) return;
    sessionBootStartedRef.current = true;
    sessionController.boot().catch((error) => panelLogRef.current?.(
      'Session restore failed: ' + (error?.message || String(error)),
    ));
  }, [effective.backend, sessionController, status.state]);
  React.useEffect(
    () => installBeforeUnloadReset(
      window,
      [codexBackend, openCodeBackend, claudeBackend],
      () => sessionController.flush(),
    ),
    [claudeBackend, codexBackend, openCodeBackend, sessionController],
  );

  // Descriptor selection is keyed on the effective backend from pickBackend.
  React.useEffect(() => {
    const facts = {
      effectiveBackend: effective.backend,
      effectiveChannel: effective.channel,
      backendPref,
      baseDescriptor,
      codexCachedModels: codexModels,
      openCodeProviders: openCodeAvailableProviders,
    };
    const nextDescriptor = selectDescriptor(facts);
    setDescriptor(nextDescriptor);
    // A persisted model id can outlive its backend or model catalog. Reset it
    // when the current model isn't in the new descriptor's model list — but
    // never while the OpenCode provider registry is still loading: the static
    // fallback descriptor would clobber a valid provider-model pref at boot
    // (live-seen: pref reset to the first relay model on every restart).
    const reconciled = reconcileModelPref(model, nextDescriptor, {
      providerFactsPending: backendPref === 'opencode'
        && (providerInit.state !== 'ready' || openCodeProbe === null),
    });
    if (reconciled !== model) {
      setModel(reconciled);
      writePref('ae_mcp_model', reconciled);
    }
  }, [
    effective.backend,
    effective.channel,
    backendPref,
    baseDescriptor,
    codexModels,
    openCodeAvailableProviders,
    openCodeProbe,
    providerInit.state,
  ]);
  const lastRealBackendRef = React.useRef(null);

  const runClaudeProbe = React.useCallback(() => {
    let alive = true;
    setProbe(null);
    probeClaudeLogin({
      platform,
    }).then((result) => {
      if (alive) setProbe(result);
    }).catch((e) => {
      if (alive) {
        setProbe({
          loggedIn: false,
          cliOk: false,
          reason: 'cli-missing',
          detail: e && e.message ? e.message : String(e),
        });
      }
    });
    return () => { alive = false; };
  }, [platform]);

  React.useEffect(() => {
    if (backendPref !== 'subscription') return undefined;
    return runClaudeProbe();
  }, [backendPref, runClaudeProbe]);

  const runCodexProbe = React.useCallback(() => {
    let alive = true;
    setCodexProbe(null);
    codexBackend.probeAccount().then((result) => {
      if (!alive) return;
      if (containsExactSecret(result, ['aemcp-secret://'])) {
        setCodexProbe({ loggedIn: false, runtimeOk: false, detail: 'Codex probe metadata was rejected' });
        setCodexModels(null);
        return;
      }
      setCodexProbe(result);
      if (result && Array.isArray(result.models) && !modelMetadataContainsCredential(result.models)) {
        setCodexModels(result.models);
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

  const onLoginChannel = React.useCallback((_channel, action) => {
    if (action?.kind === 'terminal') {
      setLoginState({
        channel: 'subscription',
        status: 'launching',
        detail: langRef.current === 'en' ? 'Opening the sign-in window…' : '正在打开登录窗口…',
      });
      Promise.resolve().then(() => platform.openLoginTerminal('claude')).then((result) => {
        if (result && result.exitCode !== undefined && result.exitCode !== 0) {
          throw new Error(result.stderr || 'The sign-in window could not be opened');
        }
        setLoginState({
          channel: 'subscription',
          status: 'waiting',
          detail: langRef.current === 'en'
            ? 'Waiting for Claude sign-in; status refreshes automatically.'
            : '正在等待 Claude 登录，状态会自动刷新。',
        });
      }).catch((error) => {
        setLoginState({
          channel: 'subscription',
          status: 'fallback',
          detail: error?.message || String(error),
        });
      });
      return;
    }
    if (action?.kind !== 'headless' || !codexProbe?.codexHome) return;

    if (codexLoginRef.current) codexLoginRef.current.cancel();
    setLoginState({
      channel: 'cli',
      status: 'waiting',
      detail: langRef.current === 'en'
        ? 'Starting Codex sign-in and waiting for browser verification…'
        : '正在启动 Codex 登录并等待浏览器验证…',
    });
    const login = startCodexLogin({
      adapter: platform,
      codexHome: codexProbe.codexHome,
      onUrl: openLoginUrl,
    });
    codexLoginRef.current = login;
    login.promise.then(() => {
      if (codexLoginRef.current !== login) return;
      codexLoginRef.current = null;
      setLoginState({
        channel: 'cli',
        status: 'verifying',
        detail: langRef.current === 'en' ? 'Verifying Codex sign-in…' : '正在验证 Codex 登录状态…',
      });
      codexBackend.reset();
      runCodexProbe();
    }).catch((error) => {
      if (codexLoginRef.current !== login) return;
      codexLoginRef.current = null;
      setLoginState({
        channel: 'cli',
        status: 'fallback',
        detail: langRef.current === 'en'
          ? 'Automatic sign-in stopped safely. Retry or use the copy-command fallback below.'
          : '自动登录已安全停止。请重试，或使用下方的复制命令备用操作。',
      });
      panelLogRef.current?.(`Codex login failed: ${error?.message || String(error)}`);
    });
  }, [codexBackend, codexProbe?.codexHome, platform, runCodexProbe]);

  React.useEffect(() => {
    if (loginState.channel !== 'subscription' || loginState.status !== 'waiting') return undefined;
    if (tab !== 'settings' || backendPref !== 'subscription') return undefined;
    let alive = true;
    let timer = null;
    const deadline = Date.now() + LOGIN_POLL_LIMIT_MS;
    const poll = () => {
      probeClaudeLogin({ platform }).then((result) => {
        if (!alive) return;
        setProbe(result);
        if (result?.loggedIn) {
          setLoginState({ channel: '', status: 'idle', detail: '' });
          return;
        }
        if (Date.now() >= deadline) {
          setLoginState({
            channel: 'subscription',
            status: 'fallback',
            detail: langRef.current === 'en'
              ? 'Automatic refresh stopped after five minutes. Open the sign-in window again to retry.'
              : '自动刷新已在五分钟后停止，请重新打开登录窗口重试。',
          });
          return;
        }
        timer = setTimeout(poll, LOGIN_POLL_INTERVAL_MS);
      }).catch(() => {
        if (alive) timer = setTimeout(poll, LOGIN_POLL_INTERVAL_MS);
      });
    };
    timer = setTimeout(poll, LOGIN_POLL_INTERVAL_MS);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [backendPref, loginState.channel, loginState.status, platform, tab]);

  React.useEffect(() => {
    if (loginState.channel !== 'cli' || loginState.status !== 'verifying' || codexProbe === null) return;
    setLoginState(codexProbe.loggedIn
      ? { channel: '', status: 'idle', detail: '' }
      : {
        channel: 'cli',
        status: 'fallback',
        detail: langRef.current === 'en'
          ? 'Codex sign-in could not be verified. Retry or use the copy-command fallback below.'
          : '未能验证 Codex 登录状态。请重试，或使用下方的复制命令备用操作。',
      });
  }, [codexProbe, loginState.channel, loginState.status]);

  React.useEffect(() => {
    const loginBackend = loginState.channel === 'cli' ? 'codex' : 'subscription';
    if (loginState.status === 'idle' || (tab === 'settings' && backendPref === loginBackend)) return;
    const current = codexLoginRef.current;
    codexLoginRef.current = null;
    if (current) current.cancel();
    setLoginState({ channel: '', status: 'idle', detail: '' });
  }, [backendPref, loginState.channel, loginState.status, tab]);

  React.useEffect(() => () => {
    const current = codexLoginRef.current;
    codexLoginRef.current = null;
    if (current) current.cancel();
  }, []);

  const runOpenCodeProbe = React.useCallback(() => {
    let alive = true;
    const runId = openCodeProbeRunRef.current + 1;
    openCodeProbeRunRef.current = runId;
    setOpenCodeProbeStale(false);
    setOpenCodeProbeAttempt((value) => value + 1);
    setOpenCodeProbe(null);
    openCodeBackend.probeAccount().then((result) => {
      if (!alive || openCodeProbeRunRef.current !== runId) return;
      if (modelMetadataContainsCredential(result?.providers, providerSensitiveValuesRef.current)) {
        setOpenCodeProbe({ loggedIn: false, detail: 'OpenCode model metadata was rejected' });
        return;
      }
      setOpenCodeProbe(result);
    }).catch((error) => {
      if (alive && openCodeProbeRunRef.current === runId) {
        setOpenCodeProbe({ loggedIn: false, detail: error?.message || String(error) });
      }
    });
    return () => { alive = false; };
  }, [openCodeBackend]);

  React.useEffect(() => {
    if (backendPref !== 'opencode' || openCodeProbe !== null) {
      setOpenCodeProbeStale(false);
      return undefined;
    }
    const timer = setTimeout(() => setOpenCodeProbeStale(true), PROBE_PENDING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [backendPref, openCodeProbe, openCodeProbeAttempt]);

  React.useEffect(() => {
    if (backendPref !== 'opencode') return undefined;
    // Two boot races (both seen live): the host controller effect runs after
    // this one on mount (probing before status turns ok fails host-not-running),
    // and the provider registry loads async (probing before it is ready makes
    // writeConfig inject an empty provider table, so every send dies with
    // ProviderModelNotFoundError). Gate on both; readiness re-fires the probe.
    if (status.state !== 'ok' || providerInit.state !== 'ready') return undefined;
    return runOpenCodeProbe();
  }, [backendPref, status.state, providerInit.state, runOpenCodeProbe]);

  React.useEffect(() => {
    const pendingSessionLoad = pendingSessionLoadRef.current;
    const decision = decideBackendReset({
      lastReal: lastRealBackendRef.current,
      effective: effective.backend,
      selectedPref: backendPref,
      pendingSessionLoad: pendingSessionLoadRef.current,
    });
    lastRealBackendRef.current = decision.nextReal;
    if (pendingSessionLoad?.backend === effective.backend) {
      pendingSessionLoadRef.current = null;
    }
    if (!decision.reset) return;
    claudeBackend.reset();
    codexBackend.reset();
    openCodeBackend.reset();
    resetAttachmentDraftSession();
    setChatStreaming(false);
    setThinkingActive(false);
    setTurnStage(null);
    setTurnProgress(null);
    if (pendingSessionLoad) return;
    setSessionModel(null);
    setSessionEffort(null);
    setSessionFast(null);
    void sessionController.createSession();
  }, [
    effective.backend,
    backendPref,
    claudeBackend,
    codexBackend,
    openCodeBackend,
    resetAttachmentDraftSession,
    sessionController,
  ]);

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
    if (!activeBackend) {
      handleChatEvent({
        type: 'error',
        kind: 'backend',
        code: 'BACKEND_UNAVAILABLE',
        message: effective.fixHint?.en || 'Configure an available chat backend first.',
        turnId: turn.turnId,
        dispatchState: 'not-started',
      });
      return;
    }
    try {
      setTurnStage('connect');
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

  const newChatSession = async (skipConfirmation = false) => {
    if (!skipConfirmation && (pendingTurnRef.current || chatStreaming)) {
      setConfirmChatNavigation({ kind: 'new' });
      return;
    }
    await sessionController.createSession();
    setChatStreaming(false);
    setThinkingActive(false);
    setTurnStage(null);
    setTurnProgress(null);
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
  panelLogRef.current = pushLog;

  const switchChatSession = React.useCallback(async (id) => {
    if (id === sessionController.snapshot().activeId) return;
    if (pendingTurnRef.current || chatStreaming) {
      setConfirmChatNavigation({ kind: 'switch', id });
      return;
    }
    await switchChatSessionNow(id);
  }, [chatStreaming, sessionController]);

  const switchChatSessionNow = React.useCallback(async (id) => {
    const target = sessionController.snapshot().sessions.find((meta) => meta.id === id);
    pendingSessionLoadRef.current = target ? { id, backend: target.backend } : { id, backend: null };
    if (target) {
      setSessionModel(target.model || null);
      setSessionEffort(null);
      setSessionFast(null);
    }
    try {
      await sessionController.switchTo(id);
      setChatStreaming(false);
      setThinkingActive(false);
      setTurnStage(null);
      setTurnProgress(null);
    } catch (error) {
      pushLog('Session switch failed: ' + (error?.message || String(error)));
    } finally {
      if (!target || effectiveBackendRef.current === target?.backend) {
        pendingSessionLoadRef.current = null;
      }
    }
  }, [pushLog, sessionController]);

  const confirmChatNavigationNow = React.useCallback(async () => {
    const request = confirmChatNavigation;
    setConfirmChatNavigation(null);
    if (!request) return;
    if (pendingTurnRef.current || chatStreaming) activeBackend?.stop();
    if (request.kind === 'new') await newChatSession(true);
    else await switchChatSessionNow(request.id);
  }, [activeBackend, chatStreaming, confirmChatNavigation, newChatSession, switchChatSessionNow]);

  const deleteChatSession = React.useCallback(async (id) => {
    const target = sessionController.snapshot().sessions.find((meta) => meta.id === id);
    try {
      const ref = await sessionController.remove(id);
      if (!target || !ref) return;
      const backend = backendInstancesRef.current[target.backend];
      const result = await backend?.deleteSessionRef?.(ref);
      pushLog(`Session backend delete (${target.backend}): ${JSON.stringify(result || { ok: false })}`);
    } catch (error) {
      pushLog('Session delete failed: ' + (error?.message || String(error)));
    }
  }, [pushLog, sessionController]);

  const exportLogs = React.useCallback(async () => {
    try {
      const exactSecrets = [];
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
      const backendStderrTails = {};
      for (const [name, backend] of [
        ['claude', claudeBackend],
        ['codex', codexBackend],
        ['opencode', openCodeBackend],
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
        backendErrors: backendErrorsRef.current,
        backendStderrTails,
        version: pkgVersion,
        exactSecrets,
      });
      const file = writeLogExport({ text, fileName: exportFileName() });
      revealInExplorer(file, undefined, (err) => pushLog('Log export reveal failed: ' + (err && err.message ? err.message : String(err))));
      pushLog('Log exported: ' + file);
    } catch (e) {
      pushLog('Log export failed: ' + (e && e.message ? e.message : String(e)));
    }
  }, [
    logs,
    connInfo,
    claudeBackend,
    codexBackend,
    openCodeBackend,
    pushLog,
    attachmentDraft,
    getHost,
    platform,
    status.port,
    cs,
  ]);

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
        if (!alive) return;
        setProviders(openCodeProviderStore.list());
        setProviderInit({ state: 'ready', error: '' });
      } catch (error) {
        if (!alive) return;
        setProviderInit({
          state: 'unavailable',
          error: error?.code || 'OPENCODE_PROVIDER_STORE_UNAVAILABLE',
        });
      }
    })();
    return () => { alive = false; };
  }, [openCodeProviderStore, status.state]);

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
      if (h && h.getMcpSessions) setMcpSessions(h.getMcpSessions());
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
      });
      setDiagnostics(items);
    } catch (e) {
      setDiagnostics([{ id: 'host-listening', ok: false, detail: String(e && e.message), fixHint: { zh: '诊断执行失败，重启面板后重试。', en: 'Diagnostics failed to run; reload the panel and retry.' } }]);
    }
  }, [getHost, platform, status.port]);

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
    hostConversation.closeConversation();
    if (ctrl.current) ctrl.current.restart(port);
  };

  const finishWizard = () => {
    markWizardDone(window.localStorage);
    setWizardDone(true);
  };

  const externalMcpReady = status.state === 'ok';
  const mcpConfigStr = externalMcpReady
    ? JSON.stringify(httpConfigFor('claude-desktop', status.port, extRoot), null, 2)
    : '';
  const wizard = useWizardWiring({
    lang,
    platform,
    port: status.port,
    fetchImpl: window.fetch.bind(window),
  });

  if (!wizardDone) {
    return (
      <WizardScreen
        step={wizStep}
        lang={lang}
        onLangChange={setLang}
        extensionRoot={extRoot}
        mcpReady={externalMcpReady}
        port={status.port}
        onNext={() => setWizStep((s) => Math.min(3, s + 1))}
        onBack={() => setWizStep((s) => Math.max(1, s - 1))}
        onCopy={(text) => copyWizardConfig(copyText, mcpConfigStr, text)}
        onDone={finishWizard}
        onSkip={finishWizard}
        {...wizard.props}
      />
    );
  }

  const statusForBar = hostConversationError
    ? 'error'
    : paused ? 'paused' : status.state === 'ok' ? 'connected' : status.state === 'starting' ? 'waiting' : 'error';
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
  const composerDisabled = paused || effective.backend === 'none' || Boolean(hostConversationError);
  const modelOptions = descriptor.models.map((m) => ({ value: m.id, label: `${m.label} ${costBadge(m.cost)}` }));
  const activeSessionMeta = sessionSnapshot.sessions.find(
    (meta) => meta.id === sessionSnapshot.activeId,
  ) || null;
  const sessionTitle = displayTitle(activeSessionMeta, lang);

  return (
    <React.Fragment>
      <StatusBar
        status={statusForBar}
        label={hostConversationError
          ? `${t.error} · ${t.approvalSyncError}`
          : paused ? t.paused : status.state === 'ok' ? `${t.connected} · 127.0.0.1:${status.port}` : status.state === 'error' ? `${t.error} · ${status.error || ''}` : t.starting}
        onStatusClick={() => { setDrawerOpen(true); }}
        onSessions={() => setSessionsOpen(true)}
        onTogglePause={togglePause}
        onSettings={() => setTab('settings')}
        pauseTitle={t.pauseAll}
        resumeTitle={t.resume}
        sessionsTitle={t.sessions}
        settingsTitle={t.settings}
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {tab === 'chat' ? (
          <ChatScreen
            lang={lang}
            entries={chatEntries}
            streaming={chatStreaming}
            thinking={thinkingActive}
            turnStage={turnStage}
            turnProgress={turnProgress}
            turnBackend={effective.backend}
            sessionTitle={sessionTitle}
            onOpenSessions={() => setSessionsOpen(true)}
            composerDisabled={composerDisabled}
            disabledHint={hostConversationError
              ? t.approvalSyncError
              : paused ? t.pausedHint : composerDisabled ? backendDisabledHint : ''}
            noticeActionLabel={paused ? t.resume : t.goSettings}
            onNoticeAction={() => (paused ? togglePause() : setTab('settings'))}
            onSend={sendChat}
            onStop={() => activeBackend?.stop()}
            onApprove={(id, decision) => activeBackend?.approve(id, decision)}
            onAnswerQuestion={(id, result) => activeBackend?.answerQuestion
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
            port={status.port}
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
            mcpReady={externalMcpReady}
            logs={logs}
            clients={clients}
            mcpSessions={mcpSessions}
            extensionRoot={extRoot}
            onBlockClient={(label, v) => {
              const h = getHost();
              if (h && h.setClientBlocked) {
                h.setClientBlocked(label, v);
                if (h.getClients) setClients(h.getClients());
                pushLog((v ? 'Blocked client: ' : 'Unblocked client: ') + label);
              }
            }}
            onBlockMcpClient={(name, v) => {
              const h = getHost();
              if (h && h.setClientBlocked) {
                h.setClientBlocked(name, v);
                if (h.getMcpSessions) setMcpSessions(h.getMcpSessions());
                pushLog((v ? 'Blocked MCP client: ' : 'Unblocked MCP client: ') + name);
              }
            }}
            onRegenToken={() => setConfirmRegen(true)}
            hostVersion={(connInfo && connInfo.hostVersion) || '-'}
            channels={channels}
            activeChannel={effective.channel || ''}
            selectedChannel={channelChoices[
              backendPref === 'codex' ? 'codex' : backendPref === 'opencode' ? 'opencode' : 'claude'
            ] || ''}
            onSelectChannel={(channel) => {
              // #229: enabling a channel is the routing decision and actively
              // triggers that backend's detection.
              const group = backendPref === 'codex'
                ? 'codex' : backendPref === 'opencode' ? 'opencode' : 'claude';
              setChannelChoices((current) => ({ ...current, [group]: channel }));
              writePref('ae_mcp_channel_' + group, channel);
              if (group === 'codex') {
                codexBackend.reset();
                runCodexProbe();
              } else if (group === 'opencode') {
                openCodeBackend.reset();
                runOpenCodeProbe();
              } else {
                runClaudeProbe();
              }
            }}
            onLoginChannel={onLoginChannel}
            loginState={loginState}
            onRecheckBackend={() => {
              if (backendPref === 'codex') runCodexProbe();
              else if (backendPref === 'opencode') {
                if (openCodeProbe === null && openCodeProbeStale && !chatStreaming) {
                  openCodeBackend.reset();
                }
                runOpenCodeProbe();
              }
              else runClaudeProbe();
            }}
            recheckDisabled={backendPref === 'codex'
              ? codexProbe === null : backendPref === 'opencode'
                ? openCodeProbe === null && !openCodeProbeStale : probe === null}
            providers={providers}
            providerManager={providerManager}
            providerInit={providerInit}
            model={effectiveModel}
            modelOptions={modelOptions}
            modelSwitchable={descriptor.perTurnModelSwitch !== false}
            onModelChange={(m) => { setModel(m); writePref('ae_mcp_model', m); }}
            backend={backendPref}
            onBackendChange={(m) => {
              sessionController.flush();
              setBackendPref(m);
              writePref('ae_mcp_backend', m);
            }}
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
        copyReady={externalMcpReady}
        onDiagnose={runDiag}
        onCopyConfig={() => copyText(mcpConfigStr)}
        onRestart={() => applyPort(status.port)}
      />
      <SessionDrawer
        open={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        lang={lang}
        sessions={sessionSnapshot.sessions}
        activeId={sessionSnapshot.activeId}
        onNew={newChatSession}
        onSwitch={switchChatSession}
        onRename={(id, title) => sessionController.rename(id, title)}
        onArchive={(id) => sessionController.archive(id)}
        onUnarchive={(id) => sessionController.unarchive(id)}
        onDelete={deleteChatSession}
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
      <ConfirmDialog
        open={Boolean(confirmChatNavigation)}
        title={t.stopTaskTitle}
        body={t.stopTaskBody}
        confirmLabel={t.stopTaskConfirm}
        cancelLabel={t.cancel}
        danger
        onCancel={() => setConfirmChatNavigation(null)}
        onConfirm={confirmChatNavigationNow}
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
