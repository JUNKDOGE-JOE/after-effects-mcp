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
import { reduceEvent } from '../lib/chatEntries';
import { DEFAULT_MODEL, FALLBACK_MODEL } from '../lib/anthropic';
import { byokStaticDescriptor, mergeByokModels, codexDescriptorFromModels } from '../lib/backendCapabilities';
import { baseDescriptorFor } from '../cep/backends/index.js';
import { cachedByokModels } from '../cep/modelsApi';
import { costBadge } from '../lib/composerOptions';
import { useActivity } from '../cep/useActivity';
import { useHandshake } from '../cep/useHandshake';
import { isWizardDone, markWizardDone } from '../cep/firstRun';
import { useWizardWiring } from './wizardWiring';
import { runDiagnostics } from '../cep/diagnostics';
import { copyText } from '../lib/clipboard';
import { createHostController, loadSavedPort, savePort, DEFAULT_PORT, buildMcpConfig, isValidPort } from '../cep/hostBridge';

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
    noKeyHint: '先在设置里配置 Anthropic API Key',
    probingHint: '正在检测 Claude 登录态…',
    notLoggedInHint: 'Claude 未登录：在终端运行 claude /login，再到设置里重新检测',
    codexProbingHint: '正在检测 Codex 登录态…',
    codexNotLoggedInHint: 'Codex 未登录：在终端运行 codex 登录后重新检测',
    noNodeHint: '内嵌对话需要系统 Node 18+',
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
    noKeyHint: 'Set your Anthropic API key in Settings first',
    probingHint: 'Checking Claude login…',
    notLoggedInHint: 'Not logged in: run claude /login in a terminal, then re-check in Settings',
    codexProbingHint: 'Checking Codex login…',
    codexNotLoggedInHint: 'Codex is not logged in: log in with codex, then re-check',
    noNodeHint: 'Embedded chat needs system Node 18+',
    pausedHint: 'Paused — resume to send',
    goSettings: 'Open Settings',
  },
};

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

async function validateAnthropicKey(key) {
  // /v1/models is not CORS-enabled for direct browser access (verified in AE:
  // the preflight fails), so validate against /v1/messages — the endpoint the
  // chat actually uses — with a 1-token haiku ping. 401/403 = invalid key.
  const r = await fetch('https://api.anthropic.com/v1/messages', {
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
  const handshake = useHandshake(getHost, !wizardDone && wizStep === 4);

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
  const [model, setModel] = React.useState(() => readPref('ae_mcp_model', DEFAULT_MODEL));
  const [sessionModel, setSessionModel] = React.useState(null);
  const [sessionEffort, setSessionEffort] = React.useState(null);
  const [sessionFast, setSessionFast] = React.useState(null);
  const [permissionMode, setPermissionMode] = React.useState(() => readPref('ae_mcp_perm_mode', 'manual'));
  const [backendPref, setBackendPref] = React.useState(() => readPref('ae_mcp_backend', 'subscription'));
  const [probe, setProbe] = React.useState(null);
  const [codexProbe, setCodexProbe] = React.useState(null);
  const [codexModels, setCodexModels] = React.useState(() => readCachedCodexModels(window.localStorage));
  const [chatEntries, setChatEntries] = React.useState([]);
  const [chatStreaming, setChatStreaming] = React.useState(false);
  const [thinkingActive, setThinkingActive] = React.useState(false);
  const baseDescriptor = React.useMemo(() => baseDescriptorFor(backendPref), [backendPref]);
  const [descriptor, setDescriptor] = React.useState(() => baseDescriptor);
  React.useEffect(() => {
    let alive = true;
    setDescriptor(baseDescriptor);
    if (backendPref === 'byok' && apiKey) {
      cachedByokModels({ apiKey }).then((list) => {
        if (alive) setDescriptor(mergeByokModels(byokStaticDescriptor(), list));
      }).catch(() => {});
    }
    if (backendPref === 'codex') {
      const cached = codexModels || readCachedCodexModels(window.localStorage);
      if (cached) setDescriptor(codexDescriptorFromModels({ models: cached }));
    }
    return () => { alive = false; };
  }, [apiKey, backendPref, baseDescriptor, codexModels]);
  const requestedModel = sessionModel || model;
  const effectiveModel = descriptor.models.some((m) => m.id === requestedModel)
    ? requestedModel
    : (descriptor.defaultModelId || (descriptor.models[0] && descriptor.models[0].id) || requestedModel);
  const modelMeta = descriptor.models.find((m) => m.id === effectiveModel) || descriptor.models[0] || {};
  const effectiveEffort = sessionEffort || (modelMeta.effortLevels && modelMeta.effortLevels.length ? descriptor.defaultEffort : null);
  const effectiveFast = Boolean(sessionFast && descriptor.supportsFast(effectiveModel));
  const runtimeRef = React.useRef({ apiKey, model: effectiveModel, permissionMode, effort: effectiveEffort, thinking: null, fast: effectiveFast });
  runtimeRef.current = {
    apiKey,
    model: effectiveModel,
    permissionMode,
    effort: effectiveEffort,
    thinking: modelMeta.adaptive === true ? 'adaptive' : null,
    fast: effectiveFast,
  };
  const extRoot = cs && cs.getSystemPath ? cs.getSystemPath('extension') : '';
  const sidecarPath = React.useMemo(() => resolveSidecarPath({ extRoot }), [extRoot]);
  const mcp = React.useMemo(() => createMcpClient({ extRoot }), [extRoot]);
  const handleChatEvent = React.useCallback((evt) => {
    if (evt.type === 'turn-start') setChatStreaming(true);
    if (evt.type === 'thinking') setThinkingActive(!!evt.active);
    if (evt.type === 'turn-end' || evt.type === 'error') {
      setChatStreaming(false);
      setThinkingActive(false);
    }
    setChatEntries((entries) => reduceEvent(entries, evt));
  }, []);

  const byokLoop = React.useMemo(() => {
    return createAgentLoop({
      getApiKey: () => runtimeRef.current.apiKey,
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
    lang,
    env: { AE_MCP_PANEL_EXT_ROOT: extRoot },
    onEvent: handleChatEvent,
  }), [extRoot, mcp, handleChatEvent]);

  const effective = pickBackend({ pref: backendPref, probe, hasApiKey: !!apiKey, codexProbe });
  // Map real-backend id -> instance (registry leaves a slot for OpenCode/F2).
  const backendInstances = { subscription: claudeBackend, byok: byokLoop, codex: codexBackend };
  const activeBackend = backendInstances[effective.backend] || byokLoop;
  const activeBackendRef = React.useRef(null);

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

  React.useEffect(() => {
    const decision = shouldResetOnBackendChange(activeBackendRef.current, effective.backend);
    activeBackendRef.current = decision.nextReal;
    if (!decision.reset) return;
    byokLoop.reset();
    claudeBackend.reset();
    codexBackend.reset();
    setChatEntries([]);
    setChatStreaming(false);
    setSessionModel(null);
    setSessionEffort(null);
    setSessionFast(null);
  }, [effective.backend, byokLoop, claudeBackend, codexBackend]);

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

  const pushLog = React.useCallback((m) => {
    setLogs((xs) => [...xs.slice(-199), `[${new Date().toLocaleTimeString()}] ${m}`]);
  }, []);

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

  const mcpConfigStr = JSON.stringify(buildMcpConfig(status.port), null, 2);
  const claudeStatus = probe === null ? { state: 'checking' }
    : probe.nodeOk === false ? { state: 'no-node', detail: probe.detail }
    : probe.loggedIn === false ? { state: 'not-logged-in', detail: probe.detail }
    : { state: 'ready', nodeVersion: probe.nodeVersion };
  const codexStatus = codexProbe === null ? { state: 'checking' }
    : codexProbe.loggedIn === false ? { state: 'not-logged-in', detail: codexProbe.detail }
    : { state: 'ready', email: codexProbe.email, planType: codexProbe.planType };
  const wizard = useWizardWiring({ extRoot, lang, claudeStatus, recheckLogin: runClaudeProbe });

  if (!wizardDone) {
    return (
      <WizardScreen
        step={wizStep}
        lang={lang}
        onLangChange={setLang}
        client={wizClient}
        onClient={setWizClient}
        handshake={handshake}
        clientName={(CLIENT_NAMES[wizClient] || CLIENT_NAMES['claude-desktop'])[lang]}
        mcpConfig={mcpConfigStr}
        onNext={() => setWizStep((s) => Math.min(4, s + 1))}
        onBack={() => setWizStep((s) => Math.max(1, s - 1))}
        onCopy={() => copyText(mcpConfigStr)}
        onDiagnose={() => { finishWizard(); setDrawerOpen(true); runDiag(); }}
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
  const backendDisabledHint = effective.reason === 'probing' ? t.probingHint
    : effective.reason === 'not-logged-in' ? t.notLoggedInHint
    : effective.reason === 'codex-probing' ? t.codexProbingHint
    : effective.reason === 'codex-not-logged-in' ? t.codexNotLoggedInHint
    : effective.reason === 'no-node' ? t.noNodeHint
    : effective.reason === 'no-key' ? t.noKeyHint
    : '';
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
            apiKey={apiKey}
            onSaveApiKey={(k) => { if (keyStore) keyStore.writeKey(k); setApiKey(k); }}
            onClearApiKey={() => { if (keyStore) keyStore.clearKey(); setApiKey(''); }}
            validateKey={validateAnthropicKey}
            model={effectiveModel}
            modelOptions={modelOptions}
            onModelChange={(m) => { setModel(m); writePref('ae_mcp_model', m); }}
            backend={backendPref}
            onBackendChange={(m) => { setBackendPref(m); writePref('ae_mcp_backend', m); }}
            claudeStatus={claudeStatus}
            onRecheckClaude={runClaudeProbe}
            codexStatus={codexStatus}
            onRecheckCodex={runCodexProbe}
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
