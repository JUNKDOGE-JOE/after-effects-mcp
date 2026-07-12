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
import { EXTERNAL_CLIENTS, mcpConfigFor } from '../cep/externalClients';
import { copyText } from '../lib/clipboard';
import { zcodeDefaultModelLocked as shouldLockZcodeDefaultModel, zcodeManagedModelLabel } from '../lib/settingsState';
import { Icon } from '../components/core/Icon';
import { loadSectionState, saveSectionState, toggleSection } from '../lib/settingsSections';
import { createPlatformAdapter } from '../cep/platform/index';

const REPO_URL = 'https://github.com/JUNKDOGE-JOE/after-effects-mcp';
const DOCS_URL = 'https://github.com/JUNKDOGE-JOE/after-effects-mcp#readme';

function openExternal(url) {
  try {
    if (globalThis.window && window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) {
      window.cep.util.openURLInDefaultBrowser(url);
      return;
    }
  } catch (e) { /* fall through */ }
  try { window.open(url, '_blank'); } catch (e) { /* best effort */ }
}

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
    backendCodex: 'Codex',
    backendZcode: 'ZCode',
    recheck: '重新检测',
    providerNone: '（未选择 provider）',
    importClaudeSettings: '从 ~/.claude/settings.json 导入',
    claude3pNote: '同一个 Provider 可同时用于 Claude 和 Codex；协议与兼容转换按当前模型自动选择。',
    providerHelperRepair: 'Provider 凭据功能已安全停用。请修复或重新安装平台 Helper，重启 AE 后再点「重新检测」；不会回退读取明文凭据。',
    providerStoreCorrupt: 'Provider 配置文件损坏；当前列表已保留。请先从备份恢复 providers.json，再点「重新检测」。',
    providerStoreUnavailable: 'Provider 配置文件不可用；当前列表已保留。请检查 ~/.ae-mcp 的磁盘空间与读写权限。',
    providerMigrationConflict: 'Provider 迁移期间配置发生冲突；当前列表已保留。请关闭其他面板实例后重新启动 AE 再检测。',
    providerSecretMismatch: 'Provider 引用与系统凭据不一致；当前列表已保留。请在 Provider 管理中重新保存对应凭据。',
    providerInitializationFailed: 'Provider 初始化失败；当前列表已保留。请导出日志后重新检测。',
    zcodeKeyPlaceholder: '粘贴 provider API Key（存本机）',
    zcodeKeyStored: '已保存到 ~/.ae-mcp/zcode-key，可粘贴新值覆盖',
    save: '保存',
    modelDefault: '默认模型（打开面板时使用）',
    customModel: '自定义模型 ID',
    customModelCap: '可选；填写后优先用于 Codex',
    zcodeModelManaged: '由 ZCode 当前会话管理',
    port: '端口',
    portHint: '默认 11488',
    apply: '应用',
    token: '访问 Token',
    regen: '重新生成',
    tokenCap: '重新生成后需重启你的 AI 客户端',
    tokenMissing: '未找到 ~/.ae-mcp/auth-token',
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
    rerunWizard: '重新运行向导',
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
    backendCodex: 'Codex',
    backendZcode: 'ZCode',
    recheck: 'Re-check',
    providerNone: '(no provider selected)',
    importClaudeSettings: 'Import from ~/.claude/settings.json',
    claude3pNote: 'The same Provider can serve Claude and Codex; protocol routing and compatibility conversion are selected per model.',
    providerHelperRepair: 'Provider credentials are safely disabled. Repair or reinstall the platform Helper, restart AE, then re-check. Plaintext fallback is disabled.',
    providerStoreCorrupt: 'The provider configuration is corrupt; the current list was retained. Restore providers.json from backup, then re-check.',
    providerStoreUnavailable: 'The provider configuration is unavailable; the current list was retained. Check disk space and permissions for ~/.ae-mcp.',
    providerMigrationConflict: 'The provider configuration changed during migration; the current list was retained. Close other panel instances, restart AE, then re-check.',
    providerSecretMismatch: 'A provider reference no longer matches its system credential; the current list was retained. Save that credential again in Provider Manager.',
    providerInitializationFailed: 'Provider initialization failed; the current list was retained. Export logs, then re-check.',
    zcodeKeyPlaceholder: 'Paste the provider API key (stored locally)',
    zcodeKeyStored: 'Saved to ~/.ae-mcp/zcode-key; paste a new value to overwrite',
    save: 'Save',
    modelDefault: 'Default model (used when the panel opens)',
    customModel: 'Custom model ID',
    customModelCap: 'Optional; takes priority for Codex',
    zcodeModelManaged: 'Managed by the current ZCode session',
    port: 'Port',
    portHint: 'Default 11488',
    apply: 'Apply',
    token: 'Access token',
    regen: 'Regenerate',
    tokenCap: 'Restart your AI client after regenerating.',
    tokenMissing: '~/.ae-mcp/auth-token not found',
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
    rerunWizard: 'Re-run setup wizard',
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

function ZcodeKeyFallback({ t, stored, onSave }) {
  const [draft, setDraft] = React.useState('');
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <Input secret value={draft} onChange={setDraft} placeholder={stored ? t.zcodeKeyStored : t.zcodeKeyPlaceholder} style={{ flex: 1 }} />
      <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={() => { if (onSave) onSave(draft.trim()); setDraft(''); }}>{t.save}</Button>
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
  logs = [],
  clients = [],
  onBlockClient,
  onRegenToken,
  hostVersion = '-',
  pythonVersion = '-',
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
  channels = { claude: [], codex: [], zcode: [] },
  activeChannel = '',
  lockedChannel = '',
  onLockChannel,
  onRecheckBackend,
  recheckDisabled = false,
  providers = [],
  claudeProviderId = '',
  onClaudeProviderChange,
  codexProviderId = '',
  onCodexProviderChange,
  onImportClaudeSettings,
  claudeSettingsImportAvailable = false,
  onSaveZcodeKey,
  zcodeKeyStored = false,
  onSaveCodexKey,
  codexKeyStored = false,
  codexCliConfig = null,
  providerManager = null,
  providerInit = { state: 'checking', error: '' },
  logLevel = 'info',
  onLogLevel,
  onExportLogs,
  onRerunWizard,
}) {
  const t = S[lang] || S.zh;
  const providerInitMessage = {
    PLATFORM_HELPER_REPAIR_REQUIRED: t.providerHelperRepair,
    PROVIDER_STORE_CORRUPT: t.providerStoreCorrupt,
    PROVIDER_STORE_UNAVAILABLE: t.providerStoreUnavailable,
    PROVIDER_MIGRATION_CONFLICT: t.providerMigrationConflict,
    PROVIDER_SECRET_MISMATCH: t.providerSecretMismatch,
    PROVIDER_INITIALIZATION_FAILED: t.providerInitializationFailed,
  }[providerInit.error] || t.providerInitializationFailed;
  const zcodeModelLocked = shouldLockZcodeDefaultModel({ backend, models: modelOptions });
  const [customModelDraft, setCustomModelDraft] = React.useState(customModel);
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
  React.useEffect(() => setCustomModelDraft(customModel), [customModel]);

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

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Section id="ai" title={t.ai} expanded={sections.ai} onToggle={onToggleSection}>
        <Field label={t.backend}>
          <Segmented full value={backend} onChange={onBackendChange} options={[
            { value: 'subscription', label: t.backendSub },
            { value: 'codex', label: t.backendCodex },
            { value: 'zcode', label: t.backendZcode },
          ]} />
        </Field>
        <ChannelCard
          lang={lang}
          channels={backend === 'codex' ? channels.codex : backend === 'zcode' ? channels.zcode : channels.claude}
          activeChannel={activeChannel}
          lockedChannel={lockedChannel}
          onLockChannel={onLockChannel}
          onRecheck={onRecheckBackend}
          recheckLabel={t.recheck}
          recheckDisabled={recheckDisabled}
          renderChannelBody={(channel) => {
            if (backend !== 'codex' && backend !== 'zcode' && channel === 'api') {
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <Select value={claudeProviderId} onChange={onClaudeProviderChange} options={[
                    { value: '', label: t.providerNone },
                    ...providers.map((p) => ({ value: p.id, label: p.name })),
                  ]} />
                  {claudeSettingsImportAvailable ? (
                    <Button variant="secondary" size="sm" icon="download" onClick={onImportClaudeSettings}>{t.importClaudeSettings}</Button>
                  ) : null}
                  <div style={{ font: '400 10px/1.5 var(--font-ui)', color: 'var(--text-tertiary)' }}>{t.claude3pNote}</div>
                </div>
              );
            }
            if (backend === 'codex' && channel === 'custom') {
              return (
                <Select value={codexProviderId} onChange={onCodexProviderChange} options={[
                  { value: '', label: t.providerNone },
                  ...providers.map((p) => ({ value: p.id, label: p.name })),
                ]} />
              );
            }
            if (backend === 'zcode' && channel === 'cli-config') {
              return <ZcodeKeyFallback t={t} stored={zcodeKeyStored} onSave={onSaveZcodeKey} />;
            }
            if (backend === 'codex' && channel === 'cli-config') {
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {codexCliConfig && codexCliConfig.provider ? (
                    <div style={{ font: '400 10px/1.5 var(--font-ui)', color: 'var(--text-tertiary)' }}>
                      {[codexCliConfig.providerId, codexCliConfig.model, codexCliConfig.provider.baseUrl].filter(Boolean).join(' · ')}
                    </div>
                  ) : null}
                  {onSaveCodexKey ? <ZcodeKeyFallback t={t} stored={codexKeyStored} onSave={onSaveCodexKey} /> : null}
                </div>
              );
            }
            return null;
          }}
        />
        {providerInit.state === 'unavailable' ? (
          <div role="alert" style={{ padding: '7px 8px', border: '1px solid var(--error-border)', borderRadius: 'var(--radius-md)', background: 'var(--error-bg)', color: 'var(--error)', font: '400 10px/1.5 var(--font-ui)' }}>
            {providerInitMessage}{providerInit.error ? ` (${providerInit.error})` : ''}
          </div>
        ) : null}
        {providerManager}
        <Field label={t.modelDefault}>
          {zcodeModelLocked ? (
            <div style={{ minHeight: 28, display: 'flex', alignItems: 'center', padding: '0 8px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', font: '400 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)' }}>
              {zcodeManagedModelLabel(lang, backend === 'zcode' ? model : '')}
            </div>
          ) : (
            <Select value={model} onChange={onModelChange} options={modelOptions || [
              { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
              { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
              { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
            ]} />
          )}
        </Field>
        {backend === 'codex' ? (
          <Field label={t.customModel} caption={t.customModelCap}>
            <Input mono value={customModelDraft} onChange={(v) => { setCustomModelDraft(v); if (onCustomModelChange) onCustomModelChange(v); }} placeholder={backend === 'codex' ? 'provider/model' : 'claude-custom'} />
          </Field>
        ) : null}
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
            <Button variant="secondary" icon="copy" onClick={() => copy('mcp', mcpConfig)}>{t.copy}</Button>
          </div>
        </Field>
      </Section>

      <Section id="externalClients" title={t.externalClients} caption={t.externalClientsCap} expanded={sections.externalClients} onToggle={onToggleSection}>
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

      <Section id="sec" title={t.sec} expanded={sections.sec} onToggle={onToggleSection}>
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
        <VersionRow label={t.verPy} value={pythonVersion} badge={pythonVersion === '-' ? <Badge status="neutral">{t.pending}</Badge> : null} />
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="ghost" size="sm" icon="book-open" onClick={() => openExternal(DOCS_URL)}>{t.docs}</Button>
          <Button variant="ghost" size="sm" icon="github" onClick={() => openExternal(REPO_URL)}>{t.github}</Button>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm" icon="rotate-cw" onClick={onRerunWizard}>{t.rerunWizard}</Button>
        </div>
      </Section>
    </div>
  );
}
