import React from 'react';
import pkg from '../../package.json';
import { Badge } from '../components/core/Badge';
import { Button } from '../components/core/Button';
import { IconButton } from '../components/core/IconButton';
import { Switch } from '../components/core/Switch';
import { Segmented } from '../components/core/Segmented';
import { Input } from '../components/forms/Input';
import { Select } from '../components/forms/Select';
import { Field } from '../components/forms/Field';
import { Toast } from '../components/shell/Toast';
import { EXTERNAL_CLIENTS, mcpConfigFor } from '../cep/externalClients';
import { copyText } from '../lib/clipboard';
import { zcodeModelLocked as shouldLockZcodeModel, zcodeRuntimeBadge } from '../lib/settingsState';

const S = {
  zh: {
    ai: 'AI 服务',
    conn: '连接',
    externalClients: '外接客户端',
    externalClientsCap: '给常见 MCP 客户端复制配置；文档型框架按其接入方式配置。',
    mcpStdio: 'MCP stdio',
    mcpDoc: '文档接入',
    openDocs: '打开文档',
    sec: '安全',
    gen: '通用',
    about: '关于',
    backend: '后端',
    backendSub: 'Claude',
    backendByok: 'BYOK',
    backendCodex: 'Codex',
    backendZcode: 'ZCode',
    backendOpenCode: 'OpenCode',
    claudeReady: '已登录 ✓',
    claudeNotLoggedIn: '未登录',
    claudeChecking: '检测中…',
    claudeNoNode: '需要 Node 18+',
    claudeLoginCap: '在终端运行 claude /login 完成登录，然后点「重新检测」',
    recheckClaude: '重新检测',
    codexSub: 'Codex',
    codexReady: '已登录 ✓',
    codexCustomReady: 'Custom API ✓',
    codexNotLoggedIn: '未登录 codex',
    codexRuntimeError: '运行时不可用',
    codexChecking: '检测中…',
    codexLoginCap: '在终端完成 codex 登录，然后点「重新检测」',
    recheckCodex: '重新检测',
    zcodeSub: 'ZCode',
    zcodeReady: '运行时可用 ✓',
    zcodeNotLoggedIn: 'ZCode 不可用',
    zcodeRuntimeError: '运行时不可用',
    zcodeChecking: '检测中…',
    zcodeLoginCap: '打开 ZCode 应用，或确认 ZCode CLI/Node 可用，然后点「重新检测」',
    recheckZcode: '重新检测',
    openCodeSub: 'OpenCode',
    openCodeReady: '已登录 ✓',
    openCodeNotLoggedIn: '未登录 OpenCode',
    openCodeChecking: '检测中…',
    openCodeLoginCap: '在终端完成 opencode 登录，然后点「重新检测」',
    recheckOpenCode: '重新检测',
    apiKey: 'API Key',
    apiKeyCap: '仅保存在本机，不会上传',
    apiBaseUrl: 'API Base URL',
    anthropicBaseUrlCap: '留空使用官方 Anthropic API',
    codexBaseUrlCap: '留空使用官方 Codex 登录态；填写后使用自定义 OpenAI-compatible provider',
    codexApiKeyCap: '仅用于自定义 Codex provider，保存在本机',
    save: '保存',
    saveVerify: '保存并验证',
    validating: '正在验证…',
    saved: 'API Key 已保存并验证',
    savedLocal: '已保存到本机',
    invalidKey: '无效 key',
    verifyFailed: '验证失败，请稍后重试',
    clear: '清除',
    cleared: 'API Key 已清除',
    modelDefault: '默认模型（打开面板时使用）',
    customModel: '自定义模型 ID',
    customModelCap: '可选；填写后优先用于 BYOK/Codex',
    zcodeModelManaged: '由 ZCode 当前会话管理',
    port: '端口',
    portHint: '默认 11488',
    apply: '应用',
    token: '访问 Token',
    regen: '重新生成',
    tokenCap: '重新生成后需重启你的 AI 客户端',
    tokenMissing: '未找到 ~/.ae-mcp/auth-token',
    autostart: '随 AE 启动',
    autostartCap: '打开工程时自动启动服务',
    clients: '已连接客户端',
    lastActive: '最后活跃',
    blocked: '屏蔽',
    mins: (n) => `${n} 分钟前`,
    hours: (n) => `${n} 小时前`,
    language: '界面语言',
    expertGuidance: 'AE 专家防错指导',
    expertGuidanceCap: '增加每会话一次性握手 token，换更少的 AE 脚本报错',
    logLevel: '日志级别',
    exportLog: '导出日志',
    mcp: 'MCP 配置',
    logs: '日志',
    copy: '复制',
    copied: '已复制',
    verPanel: '面板',
    verHost: 'Host 脚本',
    verPy: 'Python 服务',
    pending: 'P3 接通',
    docs: '文档',
    github: 'GitHub',
  },
  en: {
    ai: 'AI service',
    conn: 'Connection',
    externalClients: 'External clients',
    externalClientsCap: 'Copy config for common MCP clients; configure documentation-driven frameworks with their own flow.',
    mcpStdio: 'MCP stdio',
    mcpDoc: 'Docs',
    openDocs: 'Open docs',
    sec: 'Security',
    gen: 'General',
    about: 'About',
    backend: 'Backend',
    backendSub: 'Claude',
    backendByok: 'BYOK',
    backendCodex: 'Codex',
    backendZcode: 'ZCode',
    backendOpenCode: 'OpenCode',
    claudeReady: 'Logged in ✓',
    claudeNotLoggedIn: 'Not logged in',
    claudeChecking: 'Checking…',
    claudeNoNode: 'Needs Node 18+',
    claudeLoginCap: 'Run claude /login in a terminal, then click Re-check',
    recheckClaude: 'Re-check',
    codexSub: 'Codex',
    codexReady: 'Logged in ✓',
    codexCustomReady: 'Custom API ✓',
    codexNotLoggedIn: 'Not logged in to codex',
    codexRuntimeError: 'Runtime unavailable',
    codexChecking: 'Checking…',
    codexLoginCap: 'Sign in with codex in a terminal, then click Re-check',
    recheckCodex: 'Re-check',
    zcodeSub: 'ZCode',
    zcodeReady: 'Runtime ready ✓',
    zcodeNotLoggedIn: 'ZCode unavailable',
    zcodeRuntimeError: 'Runtime unavailable',
    zcodeChecking: 'Checking…',
    zcodeLoginCap: 'Open the ZCode app, or confirm the ZCode CLI and Node are available, then click Re-check',
    recheckZcode: 'Re-check',
    openCodeSub: 'OpenCode',
    openCodeReady: 'Logged in ✓',
    openCodeNotLoggedIn: 'Not logged in to OpenCode',
    openCodeChecking: 'Checking…',
    openCodeLoginCap: 'Sign in with opencode in a terminal, then click Re-check',
    recheckOpenCode: 'Re-check',
    apiKey: 'API Key',
    apiKeyCap: 'Stored locally, never uploaded',
    apiBaseUrl: 'API Base URL',
    anthropicBaseUrlCap: 'Leave blank to use the official Anthropic API',
    codexBaseUrlCap: 'Leave blank for official Codex login; fill to use a custom OpenAI-compatible provider',
    codexApiKeyCap: 'Only used for a custom Codex provider; stored locally',
    save: 'Save',
    saveVerify: 'Save and verify',
    validating: 'Validating…',
    saved: 'API Key saved and verified',
    savedLocal: 'Saved locally',
    invalidKey: 'Invalid key',
    verifyFailed: 'Verification failed. Try again later.',
    clear: 'Clear',
    cleared: 'API Key cleared',
    modelDefault: 'Default model (used when the panel opens)',
    customModel: 'Custom model ID',
    customModelCap: 'Optional; takes priority for BYOK/Codex',
    zcodeModelManaged: 'Managed by the current ZCode session',
    port: 'Port',
    portHint: 'Default 11488',
    apply: 'Apply',
    token: 'Access token',
    regen: 'Regenerate',
    tokenCap: 'Restart your AI client after regenerating.',
    tokenMissing: '~/.ae-mcp/auth-token not found',
    autostart: 'Launch with AE',
    autostartCap: 'Start the service when a project opens',
    clients: 'Connected clients',
    lastActive: 'Last active',
    blocked: 'Block',
    mins: (n) => `${n} min ago`,
    hours: (n) => `${n} h ago`,
    language: 'Language',
    expertGuidance: 'AE expert anti-error guidance',
    expertGuidanceCap: 'Adds a one-time handshake token cost per session for fewer AE scripting errors',
    logLevel: 'Log level',
    exportLog: 'Export log',
    mcp: 'MCP config',
    logs: 'Logs',
    copy: 'Copy',
    copied: 'Copied',
    verPanel: 'Panel',
    verHost: 'Host script',
    verPy: 'Python service',
    pending: 'P3',
    docs: 'Docs',
    github: 'GitHub',
  },
};

function Section({ title, children, disabled, caption }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', opacity: disabled ? 0.45 : 1 }}>
      <div style={{ font: '600 11px/1 var(--font-ui)', letterSpacing: '0.04em', color: 'var(--text-tertiary)', textTransform: 'uppercase', paddingBottom: 2, borderBottom: '1px solid var(--border-subtle)' }}>
        {title}
      </div>
      {caption ? <div style={{ font: '400 10px/1.35 var(--font-ui)', color: 'var(--text-tertiary)' }}>{caption}</div> : null}
      {children}
    </div>
  );
}

function ClientRow({ name, lastActive, blocked, onBlock, blockLabel }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 32, padding: '2px 8px', background: 'var(--bg-well)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', opacity: blocked ? 0.55 : 1 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)', textDecoration: blocked ? 'line-through' : 'none' }}>{name}</span>
        <span style={{ display: 'block', font: '400 10px/1.35 var(--font-ui)', color: 'var(--text-tertiary)' }}>{lastActive}</span>
      </span>
      <span style={{ font: '400 10px/1 var(--font-ui)', color: 'var(--text-tertiary)' }}>{blockLabel}</span>
      <Switch checked={blocked} onChange={onBlock} />
    </div>
  );
}

function ExternalClientRow({ client, t, configText, copied, onCopy }) {
  const isStdio = client.kind === 'mcp-stdio';
  return (
    <details style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', padding: '7px 8px' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{client.name}</span>
          <span style={{ display: 'block', font: '400 10px/1.35 var(--font-ui)', color: 'var(--text-tertiary)' }}>{isStdio ? t.mcpStdio : t.mcpDoc}</span>
        </span>
        {isStdio ? <Button variant="secondary" size="sm" icon="copy" onClick={(e) => { e.preventDefault(); onCopy(); }}>{copied ? t.copied : t.copy}</Button> : null}
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {client.installHint ? <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-secondary)' }}>{client.installHint}</div> : null}
        {client.loginHint ? <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>{client.loginHint}</div> : null}
        {isStdio ? (
          <pre style={{ margin: 0, maxHeight: 128, overflow: 'auto', padding: 8, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', background: 'var(--gray-0)', color: 'var(--text-secondary)', font: '400 10px/1.4 var(--font-mono)', whiteSpace: 'pre' }}>{configText}</pre>
        ) : null}
        {client.networkNote ? <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>{client.networkNote}</div> : null}
        <a href={client.docsUrl} target="_blank" rel="noreferrer" style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--accent)' }}>{t.openDocs}</a>
      </div>
    </details>
  );
}

function VersionRow({ label, value, badge }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
      <span style={{ flex: 1, font: '400 12px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{label}</span>
      {badge}
      <span style={{ font: '400 11px/1 var(--font-mono)', color: 'var(--text-secondary)' }}>{value}</span>
    </div>
  );
}

function maskToken(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.length <= 10) return '*'.repeat(v.length);
  return v.slice(0, 7) + '*'.repeat(Math.min(10, v.length - 11)) + v.slice(-4);
}

function cepRequire() {
  if (globalThis.window && globalThis.window.cep_node && globalThis.window.cep_node.require) return globalThis.window.cep_node.require;
  if (globalThis.window && globalThis.window.require) return globalThis.window.require;
  if (globalThis.require) return globalThis.require;
  return null;
}

function readTokenValue() {
  try {
    const req = cepRequire();
    if (!req) return '';
    const fs = req('fs');
    const path = req('path');
    const os = req('os');
    const tokenPath = path.join(os.homedir(), '.ae-mcp', 'auth-token');
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch (e) {
    return '';
  }
}

function formatLastSeen(ts, t) {
  if (!ts) return t.lastActive + ' · -';
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) return `${t.lastActive} · ${t.mins(mins)}`;
  return `${t.lastActive} · ${t.hours(Math.round(mins / 60))}`;
}

export function SettingsScreen({
  lang = 'zh',
  onLangChange,
  port = 11488,
  onApplyPort,
  mcpConfig,
  logs = [],
  clients = [],
  onBlockClient,
  onRegenToken,
  hostVersion = '-',
  pythonVersion = '-',
  apiKey = '',
  onSaveApiKey,
  onClearApiKey,
  anthropicBaseUrl = '',
  onAnthropicBaseUrlChange,
  codexApiKey = '',
  codexBaseUrl = '',
  onCodexBaseUrlChange,
  onSaveCodexApiKey,
  onClearCodexApiKey,
  validateKey,
  model = 'claude-sonnet-4-6',
  modelOptions,
  modelSwitchable = true,
  onModelChange,
  customModel = '',
  onCustomModelChange,
  backend = 'subscription',
  onBackendChange,
  expertGuidance = true,
  onExpertGuidance,
  claudeStatus = { state: 'checking' },
  onRecheckClaude,
  codexStatus = { state: 'checking' },
  onRecheckCodex,
  openCodeStatus = { state: 'checking' },
  onRecheckOpenCode,
  zcodeStatus = { state: 'checking' },
  onRecheckZcode,
}) {
  const t = S[lang] || S.zh;
  const zcodeModelLocked = shouldLockZcodeModel({ backend, modelSwitchable });
  const [key, setKey] = React.useState(apiKey);
  const [apiBaseUrlDraft, setApiBaseUrlDraft] = React.useState(anthropicBaseUrl);
  const [codexKeyDraft, setCodexKeyDraft] = React.useState(codexApiKey);
  const [codexBaseUrlDraft, setCodexBaseUrlDraft] = React.useState(codexBaseUrl);
  const [customModelDraft, setCustomModelDraft] = React.useState(customModel);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiToast, setAiToast] = React.useState(null);
  const [draftPort, setDraftPort] = React.useState(String(port));
  const [tokenRaw, setTokenRaw] = React.useState('');
  const [autostart, setAutostart] = React.useState(true);
  const [logLevel, setLogLevel] = React.useState('info');
  const [copied, setCopied] = React.useState('');

  React.useEffect(() => setDraftPort(String(port)), [port]);
  React.useEffect(() => setTokenRaw(readTokenValue()), []);
  React.useEffect(() => setKey(apiKey), [apiKey]);
  React.useEffect(() => setApiBaseUrlDraft(anthropicBaseUrl), [anthropicBaseUrl]);
  React.useEffect(() => setCodexKeyDraft(codexApiKey), [codexApiKey]);
  React.useEffect(() => setCodexBaseUrlDraft(codexBaseUrl), [codexBaseUrl]);
  React.useEffect(() => setCustomModelDraft(customModel), [customModel]);

  const copy = (label, text) => {
    copyText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1200);
    }).catch(() => {});
  };
  const tokenDisplay = tokenRaw ? maskToken(tokenRaw) : t.tokenMissing;
  const claudeState = (claudeStatus && claudeStatus.state) || 'checking';
  const claudeBadgeStatus = claudeState === 'ready' ? 'ok' : claudeState === 'not-logged-in' ? 'warn' : claudeState === 'no-node' ? 'error' : 'neutral';
  const claudeBadgeText = claudeState === 'ready' ? t.claudeReady : claudeState === 'not-logged-in' ? t.claudeNotLoggedIn : claudeState === 'no-node' ? t.claudeNoNode : t.claudeChecking;
  const codexState = (codexStatus && codexStatus.state) || 'checking';
  const codexBadgeStatus = codexState === 'ready' ? 'ok' : codexState === 'not-logged-in' ? 'warn' : codexState === 'runtime-error' ? 'error' : 'neutral';
  const codexBadgeText = codexState === 'ready' && codexStatus && codexStatus.planType === 'Custom API'
    ? t.codexCustomReady
    : codexState === 'ready' ? t.codexReady
      : codexState === 'not-logged-in' ? t.codexNotLoggedIn
        : codexState === 'runtime-error' ? t.codexRuntimeError
          : t.codexChecking;
  const openCodeState = (openCodeStatus && openCodeStatus.state) || 'checking';
  const openCodeBadgeStatus = openCodeState === 'ready' ? 'ok' : openCodeState === 'not-logged-in' ? 'warn' : 'neutral';
  const openCodeBadgeText = openCodeState === 'ready' ? t.openCodeReady : openCodeState === 'not-logged-in' ? t.openCodeNotLoggedIn : t.openCodeChecking;
  const zcodeState = (zcodeStatus && zcodeStatus.state) || 'checking';
  const zcodeBadge = zcodeRuntimeBadge(zcodeStatus, t);
  const saveApiKey = () => {
    if (aiBusy) return;
    setAiBusy(true);
    setAiToast(null);
    Promise.resolve(validateKey ? validateKey(key, apiBaseUrlDraft) : true).then((result) => {
      const ok = result === true || (result && result.ok === true) || (result && result.status === 200);
      const status = result && typeof result === 'object' ? result.status : null;
      if (!ok) {
        setAiToast({ type: 'error', message: status === 401 ? t.invalidKey : t.verifyFailed });
        return null;
      }
      return Promise.resolve(onSaveApiKey ? onSaveApiKey(key) : null).then(() => {
        setAiToast({ type: 'ok', message: t.saved });
      });
    }).catch((e) => {
      const status = e && (e.status || (e.response && e.response.status));
      setAiToast({ type: 'error', message: status === 401 ? t.invalidKey : t.verifyFailed });
    }).finally(() => setAiBusy(false));
  };
  const saveCodexKey = () => {
    if (aiBusy) return;
    setAiBusy(true);
    setAiToast(null);
    Promise.resolve(onSaveCodexApiKey ? onSaveCodexApiKey(codexKeyDraft) : null).then(() => {
      setAiToast({ type: 'ok', message: t.savedLocal });
    }).catch(() => {
      setAiToast({ type: 'error', message: t.verifyFailed });
    }).finally(() => setAiBusy(false));
  };
  const clearApiKey = () => {
    setKey('');
    Promise.resolve(onClearApiKey ? onClearApiKey() : null).then(() => {
      setAiToast({ type: 'info', message: t.cleared });
    }).catch(() => {
      setAiToast({ type: 'error', message: t.verifyFailed });
    });
  };
  const clearCodexKey = () => {
    setCodexKeyDraft('');
    Promise.resolve(onClearCodexApiKey ? onClearCodexApiKey() : null).then(() => {
      setAiToast({ type: 'info', message: t.cleared });
    }).catch(() => {
      setAiToast({ type: 'error', message: t.verifyFailed });
    });
  };
  const regenerate = () => {
    if (!onRegenToken) return;
    const result = onRegenToken();
    if (result && typeof result.then === 'function') {
      result.then((token) => setTokenRaw(token || readTokenValue())).catch(() => {});
    } else {
      setTokenRaw(result || readTokenValue());
    }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Section title={t.ai}>
        <Field label={t.backend}>
          {/* OpenCode embedded backend is implemented (openCodeBackend.js) but
              NOT exposed for v0.7.0: its approval gating is unverified (opencode
              permission-rule DSL + a live write-turn needed). Re-add the option
              in v0.7.1 after gating is verified. OpenCode is available now as an
              external client (see the External clients section). */}
          <Segmented full value={backend} onChange={onBackendChange} options={[
            { value: 'subscription', label: t.backendSub },
            { value: 'codex', label: t.backendCodex },
            { value: 'zcode', label: t.backendZcode },
            { value: 'byok', label: t.backendByok },
          ]} />
        </Field>
        {backend === 'subscription' ? (
          <Field label={t.backendSub} caption={claudeState === 'not-logged-in' ? t.claudeLoginCap : (claudeStatus && claudeStatus.detail) || null}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Badge status={claudeBadgeStatus}>{claudeBadgeText}</Badge>
              {claudeState === 'ready' && claudeStatus.nodeVersion ? <span style={{ flex: 1, font: '400 11px/1 var(--font-mono)', color: 'var(--text-secondary)' }}>Node {String(claudeStatus.nodeVersion).replace(/^v?/, 'v')}</span> : <span style={{ flex: 1 }} />}
              <Button variant="secondary" icon="rotate-cw" disabled={claudeState === 'checking'} onClick={onRecheckClaude}>{t.recheckClaude}</Button>
            </div>
          </Field>
        ) : backend === 'codex' ? (
          <React.Fragment>
            <Field label={t.codexSub} caption={codexState === 'not-logged-in' ? t.codexLoginCap : (codexStatus && codexStatus.detail) || null}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Badge status={codexBadgeStatus}>{codexBadgeText}</Badge>
                {codexState === 'ready' && (codexStatus.email || codexStatus.planType) ? <span style={{ flex: 1, font: '400 11px/1 var(--font-mono)', color: 'var(--text-secondary)' }}>{[codexStatus.email, codexStatus.planType].filter(Boolean).join(' · ')}</span> : <span style={{ flex: 1 }} />}
                <Button variant="secondary" icon="rotate-cw" disabled={codexState === 'checking'} onClick={onRecheckCodex}>{t.recheckCodex}</Button>
              </div>
            </Field>
            <Field label={t.apiBaseUrl} caption={t.codexBaseUrlCap}>
              <Input mono value={codexBaseUrlDraft} onChange={(v) => { setCodexBaseUrlDraft(v); if (onCodexBaseUrlChange) onCodexBaseUrlChange(v); }} placeholder="https://api.openai.com" />
            </Field>
            <Field label={t.apiKey} caption={t.codexApiKeyCap}>
              <div style={{ display: 'flex', gap: 6 }}>
                <Input secret value={codexKeyDraft} onChange={setCodexKeyDraft} placeholder="sk-..." style={{ flex: 1 }} />
                <Button variant="primary" disabled={aiBusy} onClick={saveCodexKey}>{aiBusy ? t.validating : t.save}</Button>
                <Button variant="secondary" disabled={aiBusy} onClick={clearCodexKey}>{t.clear}</Button>
              </div>
            </Field>
          </React.Fragment>
        ) : backend === 'opencode' ? (
          <Field label={t.openCodeSub} caption={openCodeState === 'not-logged-in' ? t.openCodeLoginCap : (openCodeStatus && openCodeStatus.detail) || null}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Badge status={openCodeBadgeStatus}>{openCodeBadgeText}</Badge>
              <span style={{ flex: 1 }} />
              <Button variant="secondary" icon="rotate-cw" disabled={openCodeState === 'checking'} onClick={onRecheckOpenCode}>{t.recheckOpenCode}</Button>
            </div>
          </Field>
        ) : backend === 'zcode' ? (
          <Field label={t.zcodeSub} caption={zcodeState === 'not-logged-in' ? t.zcodeLoginCap : (zcodeStatus && zcodeStatus.detail) || null}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Badge status={zcodeBadge.status}>{zcodeBadge.text}</Badge>
              <span style={{ flex: 1 }} />
              <Button variant="secondary" icon="rotate-cw" disabled={zcodeState === 'checking'} onClick={onRecheckZcode}>{t.recheckZcode}</Button>
            </div>
          </Field>
        ) : (
          <React.Fragment>
            <Field label={t.apiBaseUrl} caption={t.anthropicBaseUrlCap}>
              <Input mono value={apiBaseUrlDraft} onChange={(v) => { setApiBaseUrlDraft(v); if (onAnthropicBaseUrlChange) onAnthropicBaseUrlChange(v); }} placeholder="https://api.anthropic.com" />
            </Field>
            <Field label={t.apiKey} caption={t.apiKeyCap}>
              <div style={{ display: 'flex', gap: 6 }}>
                <Input secret value={key} onChange={setKey} placeholder="sk-ant-..." style={{ flex: 1 }} />
                <Button variant="primary" disabled={aiBusy || !key.trim()} onClick={saveApiKey}>{aiBusy ? t.validating : t.saveVerify}</Button>
                <Button variant="secondary" disabled={aiBusy} onClick={clearApiKey}>{t.clear}</Button>
              </div>
            </Field>
          </React.Fragment>
        )}
        <Field label={t.modelDefault}>
          {zcodeModelLocked ? (
            <div style={{ minHeight: 28, display: 'flex', alignItems: 'center', padding: '0 8px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', font: '400 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)' }}>
              {t.zcodeModelManaged}
            </div>
          ) : (
            <Select value={model} onChange={onModelChange} options={modelOptions || [
              { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
              { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
            ]} />
          )}
        </Field>
        {(backend === 'byok' || backend === 'codex') ? (
          <Field label={t.customModel} caption={t.customModelCap}>
            <Input mono value={customModelDraft} onChange={(v) => { setCustomModelDraft(v); if (onCustomModelChange) onCustomModelChange(v); }} placeholder={backend === 'codex' ? 'provider/model' : 'claude-custom'} />
          </Field>
        ) : null}
        {aiToast ? <Toast type={aiToast.type} message={aiToast.message} onClose={() => setAiToast(null)} /> : null}
      </Section>

      <Section title={t.conn}>
        <Field label={t.port} hint={t.portHint}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Input mono value={draftPort} onChange={setDraftPort} style={{ flex: 1 }} />
            <Button variant="secondary" onClick={() => onApplyPort && onApplyPort(draftPort)}>{t.apply}</Button>
          </div>
        </Field>
        <Field label={t.token} caption={t.tokenCap}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Input mono value={tokenDisplay} style={{ flex: 1 }} suffix={<IconButton icon="copy" title={t.copy} disabled={!tokenRaw} onClick={() => copy('token', tokenRaw)} style={{ width: 20, height: 20 }} />} />
            <Button variant="secondary" icon="rotate-cw" onClick={regenerate}>{t.regen}</Button>
          </div>
        </Field>
        <Field layout="row" label={t.autostart} caption={t.autostartCap}>
          <Switch checked={autostart} onChange={setAutostart} />
        </Field>
        <Field label={t.mcp} caption={copied === 'mcp' ? t.copied : null}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <pre style={{ margin: 0, maxHeight: 160, overflow: 'auto', padding: 8, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', color: 'var(--text-secondary)', font: '400 10px/1.4 var(--font-mono)' }}>{mcpConfig}</pre>
            <Button variant="secondary" icon="copy" onClick={() => copy('mcp', mcpConfig)}>{t.copy}</Button>
          </div>
        </Field>
      </Section>

      <Section title={t.externalClients} caption={t.externalClientsCap}>
        {EXTERNAL_CLIENTS.map((externalClient) => {
          const configText = JSON.stringify(mcpConfigFor(externalClient, Number(draftPort) || port || 11488, expertGuidance), null, 2);
          return (
            <ExternalClientRow
              key={externalClient.id}
              client={externalClient}
              t={t}
              configText={configText}
              copied={copied === externalClient.id}
              onCopy={() => copy(externalClient.id, configText)}
            />
          );
        })}
      </Section>

      <Section title={t.sec}>
        <div style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)', marginTop: 2 }}>{t.clients}</div>
        {clients.map((client) => (
          <ClientRow
            key={client.label}
            name={client.label}
            lastActive={formatLastSeen(client.lastSeen, t)}
            blocked={!!client.blocked}
            onBlock={(v) => onBlockClient && onBlockClient(client.label, v)}
            blockLabel={t.blocked}
          />
        ))}
      </Section>

      <Section title={t.gen}>
        <Field layout="row" label={t.expertGuidance} caption={t.expertGuidanceCap}>
          <Switch checked={expertGuidance} onChange={(v) => onExpertGuidance && onExpertGuidance(v)} />
        </Field>
        <Field label={t.language}>
          <Segmented full value={lang} onChange={onLangChange} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} />
        </Field>
        <Field label={t.logLevel}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Select value={logLevel} onChange={setLogLevel} style={{ flex: 1 }} options={[
              { value: 'error', label: 'Error' },
              { value: 'info', label: 'Info' },
              { value: 'debug', label: 'Debug' },
            ]} />
            <Button variant="secondary" icon="download" disabled>{t.exportLog}</Button>
          </div>
        </Field>
        <Field label={t.logs}>
          <details>
            <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', font: '500 11px/1.35 var(--font-ui)' }}>{t.logs}</summary>
            <pre style={{ margin: '6px 0 0', maxHeight: 128, overflow: 'auto', padding: 8, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', color: 'var(--text-tertiary)', font: '400 10px/1.4 var(--font-mono)' }}>{logs.join('\n')}</pre>
          </details>
        </Field>
      </Section>

      <Section title={t.about}>
        <VersionRow label={t.verPanel} value={`v${pkg.version}`} />
        <VersionRow label={t.verHost} value={hostVersion} badge={hostVersion === '-' ? <Badge status="neutral">{t.pending}</Badge> : null} />
        <VersionRow label={t.verPy} value={pythonVersion} badge={pythonVersion === '-' ? <Badge status="neutral">{t.pending}</Badge> : null} />
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="ghost" size="sm" icon="book-open">{t.docs}</Button>
          <Button variant="ghost" size="sm" icon="github">{t.github}</Button>
        </div>
      </Section>
    </div>
  );
}
