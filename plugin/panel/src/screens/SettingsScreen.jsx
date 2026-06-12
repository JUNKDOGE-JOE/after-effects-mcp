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
import { copyText } from '../lib/clipboard';

const S = {
  zh: {
    ai: 'AI 服务',
    conn: '连接',
    sec: '安全',
    gen: '通用',
    about: '关于',
    backend: '后端',
    backendSub: '订阅',
    backendByok: 'BYOK',
    claudeReady: '已登录 ✓',
    claudeNotLoggedIn: '未登录',
    claudeChecking: '检测中…',
    claudeNoNode: '需要 Node 18+',
    claudeLoginCap: '在终端运行 claude /login 完成登录，然后点「重新检测」',
    recheckClaude: '重新检测',
    apiKey: 'API Key',
    apiKeyCap: '仅保存在本机，不会上传',
    saveVerify: '保存并验证',
    validating: '正在验证…',
    saved: 'API Key 已保存并验证',
    invalidKey: '无效 key',
    verifyFailed: '验证失败，请稍后重试',
    clear: '清除',
    cleared: 'API Key 已清除',
    model: '模型',
    port: '端口',
    portHint: '默认 11488',
    apply: '应用',
    token: '访问 Token',
    regen: '重新生成',
    tokenCap: '重新生成后需重启你的 AI 客户端',
    tokenMissing: '未找到 ~/.ae-mcp/auth-token',
    autostart: '随 AE 启动',
    autostartCap: '打开工程时自动启动服务',
    permTitle: '内嵌对话权限',
    perm1: '手动批准',
    perm2: '自动审核',
    perm3: '无需批准',
    permCap1: '每个写操作都需要你确认',
    permCap2: '低风险自动放行，高风险仍需确认',
    permCap3: '全部放行 - 仅在信任的工程中使用',
    clients: '已连接客户端',
    lastActive: '最后活跃',
    blocked: '屏蔽',
    mins: (n) => `${n} 分钟前`,
    hours: (n) => `${n} 小时前`,
    language: '界面语言',
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
    sec: 'Security',
    gen: 'General',
    about: 'About',
    backend: 'Backend',
    backendSub: 'Subscription',
    backendByok: 'BYOK',
    claudeReady: 'Logged in ✓',
    claudeNotLoggedIn: 'Not logged in',
    claudeChecking: 'Checking…',
    claudeNoNode: 'Needs Node 18+',
    claudeLoginCap: 'Run claude /login in a terminal, then click Re-check',
    recheckClaude: 'Re-check',
    apiKey: 'API Key',
    apiKeyCap: 'Stored locally, never uploaded',
    saveVerify: 'Save and verify',
    validating: 'Validating…',
    saved: 'API Key saved and verified',
    invalidKey: 'Invalid key',
    verifyFailed: 'Verification failed. Try again later.',
    clear: 'Clear',
    cleared: 'API Key cleared',
    model: 'Model',
    port: 'Port',
    portHint: 'Default 11488',
    apply: 'Apply',
    token: 'Access token',
    regen: 'Regenerate',
    tokenCap: 'Restart your AI client after regenerating.',
    tokenMissing: '~/.ae-mcp/auth-token not found',
    autostart: 'Launch with AE',
    autostartCap: 'Start the service when a project opens',
    permTitle: 'Built-in chat permissions',
    perm1: 'Approve each',
    perm2: 'Auto-review',
    perm3: 'Allow all',
    permCap1: 'Every write operation asks for confirmation',
    permCap2: 'Low-risk auto-allowed; high-risk still asks',
    permCap3: 'Everything allowed - trusted projects only',
    clients: 'Connected clients',
    lastActive: 'Last active',
    blocked: 'Block',
    mins: (n) => `${n} min ago`,
    hours: (n) => `${n} h ago`,
    language: 'Language',
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
  validateKey,
  model = 'claude-sonnet-4-6',
  onModelChange,
  backend = 'subscription',
  onBackendChange,
  claudeStatus = { state: 'checking' },
  onRecheckClaude,
  permissionMode = 'manual',
  onPermissionMode,
}) {
  const t = S[lang] || S.zh;
  const [key, setKey] = React.useState(apiKey);
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

  const copy = (label, text) => {
    copyText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1200);
    }).catch(() => {});
  };
  const permCap = permissionMode === 'manual' ? t.permCap1 : permissionMode === 'auto' ? t.permCap2 : t.permCap3;
  const tokenDisplay = tokenRaw ? maskToken(tokenRaw) : t.tokenMissing;
  const claudeState = (claudeStatus && claudeStatus.state) || 'checking';
  const claudeBadgeStatus = claudeState === 'ready' ? 'ok' : claudeState === 'not-logged-in' ? 'warn' : claudeState === 'no-node' ? 'error' : 'neutral';
  const claudeBadgeText = claudeState === 'ready' ? t.claudeReady : claudeState === 'not-logged-in' ? t.claudeNotLoggedIn : claudeState === 'no-node' ? t.claudeNoNode : t.claudeChecking;
  const saveApiKey = () => {
    if (aiBusy) return;
    setAiBusy(true);
    setAiToast(null);
    Promise.resolve(validateKey ? validateKey(key) : true).then((result) => {
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
  const clearApiKey = () => {
    setKey('');
    Promise.resolve(onClearApiKey ? onClearApiKey() : null).then(() => {
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
          <Segmented full value={backend} onChange={onBackendChange} options={[
            { value: 'subscription', label: t.backendSub },
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
        ) : (
          <Field label={t.apiKey} caption={t.apiKeyCap}>
            <div style={{ display: 'flex', gap: 6 }}>
              <Input secret value={key} onChange={setKey} placeholder="sk-ant-..." style={{ flex: 1 }} />
              <Button variant="primary" disabled={aiBusy || !key.trim()} onClick={saveApiKey}>{aiBusy ? t.validating : t.saveVerify}</Button>
              <Button variant="secondary" disabled={aiBusy} onClick={clearApiKey}>{t.clear}</Button>
            </div>
          </Field>
        )}
        <Field label={t.model}>
          <Select value={model} onChange={onModelChange} options={[
            { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
            { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
          ]} />
        </Field>
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

      <Section title={t.sec}>
        <Field label={t.permTitle} caption={permCap}>
          <Segmented full value={permissionMode} onChange={onPermissionMode} options={[
            { value: 'manual', label: t.perm1 },
            { value: 'auto', label: t.perm2 },
            { value: 'none', label: t.perm3 },
          ]} />
        </Field>
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
