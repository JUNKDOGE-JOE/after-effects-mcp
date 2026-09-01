import React from 'react';
import pkg from '../../package.json';
import { Badge } from '../components/core/Badge';
import { Button } from '../components/core/Button';
import { IconButton } from '../components/core/IconButton';
import { Switch } from '../components/core/Switch';
import { Segmented } from '../components/core/Segmented';
import { ChannelCard } from '../components/settings/ChannelCard';
import { Input } from '../components/forms/Input';
import { Select } from '../components/forms/Select';
import { Field } from '../components/forms/Field';
import { EXTERNAL_CLIENTS, externalClientConfigText } from '../cep/externalClients';
import { copyText } from '../lib/clipboard';
import { Icon } from '../components/core/Icon';
import { loadSectionState, saveSectionState, toggleSection } from '../lib/settingsSections';
import { createPlatformAdapter } from '../cep/platform/index';
import { Toast } from '../components/shell/Toast';
import { docsUrlForLocale, openExternal, REPO_URL } from '../lib/externalLinks.js';
import { claudeSubDescriptor } from '../lib/backendCapabilities.js';

// Fallbacks for a SettingsScreen rendered without the live descriptor from
// App; they derive from the curated Claude list so no model id is repeated.
const FALLBACK_CLAUDE_DESCRIPTOR = claudeSubDescriptor();
const FALLBACK_MODEL_OPTIONS = FALLBACK_CLAUDE_DESCRIPTOR.models.map((entry) => ({
  value: entry.id,
  label: 'Claude ' + entry.label,
}));

const S = {
  zh: {
    ai: 'AI 服务',
    conn: '连接',
    externalClients: '外接客户端',
    externalClientsCap: '复制宿主 URL，或为 Claude Desktop 使用 Node shim。',
    mcpShim: 'Node shim（可选）',
    mcpHttp: 'MCP HTTP',
    panelOpenNote: '面板开着才能连接；关闭或重载面板后客户端需要重连。',
    openDocs: '打开文档',
    sec: '安全',
    gen: '通用',
    about: '关于',
    backend: '后端',
    backendSub: 'Claude',
    backendCodex: 'Codex',
    backendOpenCode: 'OpenCode',
    recheck: '重新检测',
    providerInitializationFailed: 'Provider 初始化失败；当前列表已保留。请检查 OpenCode provider 配置后重新检测。',
    save: '保存',
    modelDefault: '默认模型（打开面板时使用）',
    port: '端口',
    portHint: '默认 11488',
    apply: '应用',
    token: '访问 Token',
    regen: '重新生成',
    tokenCap: '重新生成后需重启你的 AI 客户端',
    tokenMissing: '未找到 ~/.ae-mcp/auth-token',
    clients: '已连接客户端',
    mcpSessions: '活动 MCP 会话',
    sessionSourcePanel: '面板内会话',
    sessionSourceExternal: '外部客户端',
    sessionId: 'session',
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
    pending: 'P3 接通',
    docs: '文档',
    github: 'GitHub',
    rerunWizard: '重新运行向导',
    externalLinkFailed: '无法打开链接，请检查默认浏览器后重试。',
  },
  en: {
    ai: 'AI service',
    conn: 'Connection',
    externalClients: 'External clients',
    externalClientsCap: 'Copy the host URL, or use the Node shim for Claude Desktop.',
    mcpShim: 'Node shim (optional)',
    mcpHttp: 'MCP HTTP',
    panelOpenNote: 'The panel must stay open. Clients reconnect after the panel closes or reloads.',
    openDocs: 'Open docs',
    sec: 'Security',
    gen: 'General',
    about: 'About',
    backend: 'Backend',
    backendSub: 'Claude',
    backendCodex: 'Codex',
    backendOpenCode: 'OpenCode',
    recheck: 'Re-check',
    providerInitializationFailed: 'Provider initialization failed; the current list was retained. '
      + 'Check the OpenCode provider configuration, then re-check.',
    save: 'Save',
    modelDefault: 'Default model (used when the panel opens)',
    port: 'Port',
    portHint: 'Default 11488',
    apply: 'Apply',
    token: 'Access token',
    regen: 'Regenerate',
    tokenCap: 'Restart your AI client after regenerating.',
    tokenMissing: '~/.ae-mcp/auth-token not found',
    clients: 'Connected clients',
    mcpSessions: 'Active MCP sessions',
    sessionSourcePanel: 'Panel session',
    sessionSourceExternal: 'External client',
    sessionId: 'session',
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
    pending: 'P3',
    docs: 'Docs',
    github: 'GitHub',
    rerunWizard: 'Re-run setup wizard',
    externalLinkFailed: 'Could not open the link. Check your default browser and try again.',
  },
};

function Section({ id, title, children, disabled, caption, expanded, onToggle }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', opacity: disabled ? 0.45 : 1 }}>
      <button
        type="button"
        aria-expanded={expanded}
        className="ds-focusable"
        onClick={() => onToggle && onToggle(id)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none', padding: '0 0 2px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)', textAlign: 'left' }}
      >
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} strokeWidth={2} color="var(--text-tertiary)" />
        <span style={{ font: '600 11px/1 var(--font-ui)', letterSpacing: '0.04em', color: 'var(--text-tertiary)', textTransform: 'uppercase' }}>{title}</span>
      </button>
      {expanded && caption ? <div style={{ font: '400 10px/1.35 var(--font-ui)', color: 'var(--text-tertiary)' }}>{caption}</div> : null}
      {expanded ? children : null}
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

function McpSessionRow({ session, t, onBlock }) {
  const info = session.clientInfo || {};
  const name = info.version ? `${info.name} · ${info.version}` : (info.name || session.clientName || '-');
  const source = session.source === 'panel' ? t.sessionSourcePanel : t.sessionSourceExternal;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 42, padding: '4px 8px', background: 'var(--bg-well)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', opacity: session.blocked ? 0.55 : 1 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)', textDecoration: session.blocked ? 'line-through' : 'none' }}>{name}</span>
        <span style={{ display: 'block', font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.sessionId}: {session.sessionId}</span>
        <span style={{ display: 'block', font: '400 10px/1.35 var(--font-ui)', color: 'var(--text-tertiary)' }}>{source} · {formatLastSeen(session.lastActivityAt, t)}</span>
      </span>
      <Switch checked={!!session.blocked} onChange={(value) => onBlock && onBlock(info.name, value)} />
    </div>
  );
}

function ExternalClientRow({ client, t, configText, copied, onCopy, onOpenExternal, copyDisabled = false }) {
  const isShim = client.kind === 'mcp-shim';
  return (
    <details style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', padding: '7px 8px' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{client.name}</span>
          <span
            style={{
              display: 'block',
              font: '400 10px/1.35 var(--font-ui)',
              color: 'var(--text-tertiary)',
            }}
          >
            {isShim ? t.mcpShim : t.mcpHttp}
          </span>
        </span>
        <Button
          variant="secondary"
          size="sm"
          icon="copy"
          disabled={copyDisabled}
          onClick={(e) => {
            e.preventDefault();
            if (!copyDisabled) onCopy();
          }}
        >
          {copied && !copyDisabled ? t.copied : t.copy}
        </Button>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {client.installHint ? <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-secondary)' }}>{client.installHint}</div> : null}
        {client.loginHint ? <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>{client.loginHint}</div> : null}
        <pre
          style={{
            margin: 0,
            maxHeight: 128,
            overflow: 'auto',
            padding: 8,
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--gray-0)',
            color: 'var(--text-secondary)',
            font: '400 10px/1.4 var(--font-mono)',
            whiteSpace: 'pre',
          }}
        >
          {configText}
        </pre>
        <div
          style={{
            font: '400 10px/1.45 var(--font-ui)',
            color: 'var(--text-tertiary)',
          }}
        >
          {t.panelOpenNote}
        </div>
        {client.networkNote ? <div style={{ font: '400 10px/1.45 var(--font-ui)', color: 'var(--text-tertiary)' }}>{client.networkNote}</div> : null}
        <a
          href={client.docsUrl}
          onClick={(event) => {
            event.preventDefault();
            onOpenExternal(client.docsUrl);
          }}
          style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--accent)' }}
        >
          {t.openDocs}
        </a>
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

function readTokenValue() {
  try {
    const platform = createPlatformAdapter();
    const tokenPath = platform.paths.join([platform.paths.configRoot, 'auth-token']);
    return platform.fs.readFileSync(tokenPath, 'utf8').trim();
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
  extensionRoot = '<extension root>',
  mcpReady = true,
  logs = [],
  clients = [],
  mcpSessions = [],
  onBlockClient,
  onBlockMcpClient,
  onRegenToken,
  hostVersion = '-',
  model = FALLBACK_CLAUDE_DESCRIPTOR.defaultModelId,
  modelOptions,
  modelSwitchable = true,
  onModelChange,
  backend = 'subscription',
  onBackendChange,
  expertGuidance = true,
  onExpertGuidance,
  channels = { claude: [], codex: [], opencode: [] },
  activeChannel = '',
  selectedChannel = '',
  onSelectChannel,
  onRecheckBackend,
  onLoginChannel,
  loginState = null,
  recheckDisabled = false,
  providerManager = null,
  providerInit = { state: 'checking', error: '' },
  logLevel = 'info',
  onLogLevel,
  onExportLogs,
  onRerunWizard,
}) {
  const t = S[lang] || S.zh;
  const providerInitMessage = t.providerInitializationFailed;
  const [externalLinkError, setExternalLinkError] = React.useState('');
  const [draftPort, setDraftPort] = React.useState(String(port));
  const [tokenRaw, setTokenRaw] = React.useState('');
  const [copied, setCopied] = React.useState('');
  const [sections, setSections] = React.useState(() => loadSectionState(window.localStorage));
  const onToggleSection = (id) => setSections((s) => {
    const next = toggleSection(s, id);
    saveSectionState(window.localStorage, next);
    return next;
  });

  React.useEffect(() => setDraftPort(String(port)), [port]);
  React.useEffect(() => setTokenRaw(readTokenValue()), []);

  const copy = (label, text) => {
    copyText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1200);
    }).catch(() => {});
  };
  const tokenDisplay = tokenRaw ? maskToken(tokenRaw) : t.tokenMissing;
  const regenerate = () => {
    if (!onRegenToken) return;
    const result = onRegenToken();
    if (result && typeof result.then === 'function') {
      result.then((token) => setTokenRaw(token || readTokenValue())).catch(() => {});
    } else {
      setTokenRaw(result || readTokenValue());
    }
  };
  const handleExternalLink = (url) => {
    setExternalLinkError('');
    return openExternal(url, { onFailure: () => setExternalLinkError(t.externalLinkFailed) });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      {externalLinkError ? <Toast type="error" message={externalLinkError} onClose={() => setExternalLinkError('')} /> : null}
      <Section id="ai" title={t.ai} expanded={sections.ai} onToggle={onToggleSection}>
        <Field label={t.backend}>
          <Segmented full value={backend} onChange={onBackendChange} options={[
            { value: 'subscription', label: t.backendSub },
            { value: 'codex', label: t.backendCodex },
            { value: 'opencode', label: t.backendOpenCode },
          ]} />
        </Field>
        <ChannelCard
          lang={lang}
          channels={backend === 'codex'
            ? channels.codex : backend === 'opencode' ? channels.opencode : channels.claude}
          activeChannel={activeChannel}
          selectedChannel={selectedChannel}
          onSelectChannel={onSelectChannel}
          onRecheck={onRecheckBackend}
          onLogin={onLoginChannel}
          loginState={loginState}
          recheckLabel={t.recheck}
          recheckDisabled={recheckDisabled}
        />
        {providerInit.state === 'unavailable' ? (
          <div role="alert" style={{ padding: '7px 8px', border: '1px solid var(--error-border)', borderRadius: 'var(--radius-md)', background: 'var(--error-bg)', color: 'var(--error)', font: '400 10px/1.5 var(--font-ui)' }}>
            {providerInitMessage}{providerInit.detail || providerInit.error ? ` (${providerInit.detail || providerInit.error})` : ''}
          </div>
        ) : null}
        {providerManager}
        <Field label={t.modelDefault}>
          <Select value={model} onChange={onModelChange} options={modelOptions || FALLBACK_MODEL_OPTIONS} />
        </Field>
      </Section>

      <Section id="conn" title={t.conn} expanded={sections.conn} onToggle={onToggleSection}>
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
        <Field label={t.mcp} caption={copied === 'mcp' ? t.copied : null}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <pre style={{ margin: 0, maxHeight: 160, overflow: 'auto', padding: 8, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', color: 'var(--text-secondary)', font: '400 10px/1.4 var(--font-mono)' }}>{mcpConfig}</pre>
            <Button variant="secondary" icon="copy" disabled={!mcpReady} onClick={() => copy('mcp', mcpConfig)}>{t.copy}</Button>
          </div>
        </Field>
      </Section>

      <Section id="externalClients" title={t.externalClients} caption={t.externalClientsCap} expanded={sections.externalClients} onToggle={onToggleSection}>
        {EXTERNAL_CLIENTS.map((externalClient) => {
          const configText = mcpReady ? externalClientConfigText({
            client: externalClient,
            port: Number(draftPort) || port || 11488,
            extensionRoot,
          }) : '';
          return (
            <ExternalClientRow
              key={externalClient.id}
              client={externalClient}
              t={t}
              configText={configText}
              copied={copied === externalClient.id}
              copyDisabled={!mcpReady}
              onCopy={() => copy(externalClient.id, configText)}
              onOpenExternal={handleExternalLink}
            />
          );
        })}
      </Section>

      <Section id="sec" title={t.sec} expanded={sections.sec} onToggle={onToggleSection}>
        <div style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)', marginTop: 2 }}>{t.mcpSessions}</div>
        {mcpSessions.map((session) => (
          <McpSessionRow
            key={session.sessionId}
            session={session}
            t={t}
            onBlock={onBlockMcpClient}
          />
        ))}
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

      <Section id="gen" title={t.gen} expanded={sections.gen} onToggle={onToggleSection}>
        <Field layout="row" label={t.expertGuidance} caption={t.expertGuidanceCap}>
          <Switch checked={expertGuidance} onChange={(v) => onExpertGuidance && onExpertGuidance(v)} />
        </Field>
        <Field label={t.language}>
          <Segmented full value={lang} onChange={onLangChange} options={[{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }]} />
        </Field>
        <Field label={t.logLevel}>
          <div style={{ display: 'flex', gap: 6 }}>
            <Select value={logLevel} onChange={onLogLevel} style={{ flex: 1 }} options={[
              { value: 'error', label: 'Error' },
              { value: 'info', label: 'Info' },
              { value: 'debug', label: 'Debug' },
            ]} />
            <Button variant="secondary" icon="download" onClick={onExportLogs}>{t.exportLog}</Button>
          </div>
        </Field>
        <Field label={t.logs}>
          <details>
            <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)', font: '500 11px/1.35 var(--font-ui)' }}>{t.logs}</summary>
            <pre style={{ margin: '6px 0 0', maxHeight: 128, overflow: 'auto', padding: 8, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', color: 'var(--text-tertiary)', font: '400 10px/1.4 var(--font-mono)' }}>{logs.join('\n')}</pre>
          </details>
        </Field>
      </Section>

      <Section id="about" title={t.about} expanded={sections.about} onToggle={onToggleSection}>
        <VersionRow label={t.verPanel} value={`v${pkg.version}`} />
        <VersionRow label={t.verHost} value={hostVersion} badge={hostVersion === '-' ? <Badge status="neutral">{t.pending}</Badge> : null} />
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="ghost" size="sm" icon="book-open" onClick={() => handleExternalLink(docsUrlForLocale(lang))}>{t.docs}</Button>
          <Button variant="ghost" size="sm" icon="github" onClick={() => handleExternalLink(REPO_URL)}>{t.github}</Button>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" icon="rotate-cw" onClick={onRerunWizard}>{t.rerunWizard}</Button>
        </div>
      </Section>
    </div>
  );
}
