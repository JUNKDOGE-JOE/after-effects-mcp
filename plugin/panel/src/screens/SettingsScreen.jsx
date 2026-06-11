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

const S = {
  zh: {
    ai: 'AI 服务',
    aiDisabled: 'P5 接通内嵌对话后启用。',
    conn: '连接',
    sec: '安全',
    gen: '通用',
    about: '关于',
    apiKey: 'API Key',
    apiKeyCap: '仅保存在本机，不会上传',
    model: '模型',
    port: '端口',
    portHint: '默认 11488',
    apply: '应用',
    token: '访问 Token',
    regen: '重新生成',
    tokenCap: '客户端凭此连接面板；重新生成将在 P2 接通。',
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
    aiDisabled: 'Enabled in P5 when built-in chat is wired.',
    conn: 'Connection',
    sec: 'Security',
    gen: 'General',
    about: 'About',
    apiKey: 'API Key',
    apiKeyCap: 'Stored locally, never uploaded',
    model: 'Model',
    port: 'Port',
    portHint: 'Default 11488',
    apply: 'Apply',
    token: 'Access token',
    regen: 'Regenerate',
    tokenCap: 'Clients use this to reach the panel; regeneration lands in P2.',
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

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

export function SettingsScreen({ lang = 'zh', onLangChange, port = 11488, onApplyPort, mcpConfig, logs = [] }) {
  const t = S[lang] || S.zh;
  const [key, setKey] = React.useState('');
  const [model, setModel] = React.useState('sonnet');
  const [draftPort, setDraftPort] = React.useState(String(port));
  const [tokenRaw, setTokenRaw] = React.useState('');
  const [autostart, setAutostart] = React.useState(true);
  const [perm, setPerm] = React.useState('manual');
  const [blockClaude, setBlockClaude] = React.useState(false);
  const [blockCursor, setBlockCursor] = React.useState(true);
  const [logLevel, setLogLevel] = React.useState('info');
  const [copied, setCopied] = React.useState('');

  React.useEffect(() => setDraftPort(String(port)), [port]);
  React.useEffect(() => setTokenRaw(readTokenValue()), []);

  const copy = (label, text) => {
    copyText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(''), 1200);
    }).catch(() => {});
  };
  const permCap = perm === 'manual' ? t.permCap1 : perm === 'auto' ? t.permCap2 : t.permCap3;
  const tokenDisplay = tokenRaw ? maskToken(tokenRaw) : t.tokenMissing;

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <Section title={t.ai} disabled caption={t.aiDisabled}>
        <Field label={t.apiKey} caption={t.apiKeyCap}>
          <Input secret disabled value={key} onChange={setKey} placeholder="sk-ant-..." />
        </Field>
        <Field label={t.model}>
          <Select disabled value={model} onChange={setModel} options={[
            { value: 'sonnet', label: 'Claude Sonnet' },
            { value: 'haiku', label: 'Claude Haiku' },
          ]} />
        </Field>
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
            <Button variant="secondary" icon="rotate-cw" disabled>{t.regen}</Button>
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
          <Segmented full value={perm} onChange={setPerm} options={[
            { value: 'manual', label: t.perm1 },
            { value: 'auto', label: t.perm2 },
            { value: 'none', label: t.perm3 },
          ]} />
        </Field>
        <div style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)', marginTop: 2 }}>{t.clients}</div>
        <ClientRow name="Claude Desktop" lastActive={`${t.lastActive} · ${t.mins(2)}`} blocked={blockClaude} onBlock={setBlockClaude} blockLabel={t.blocked} />
        <ClientRow name="Cursor" lastActive={`${t.lastActive} · ${t.hours(1)}`} blocked={blockCursor} onBlock={setBlockCursor} blockLabel={t.blocked} />
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
        <VersionRow label={t.verHost} value="-" badge={<Badge status="neutral">{t.pending}</Badge>} />
        <VersionRow label={t.verPy} value="-" badge={<Badge status="neutral">{t.pending}</Badge>} />
        <div style={{ display: 'flex', gap: 6 }}>
          <Button variant="ghost" size="sm" icon="book-open">{t.docs}</Button>
          <Button variant="ghost" size="sm" icon="github">{t.github}</Button>
        </div>
      </Section>
    </div>
  );
}
