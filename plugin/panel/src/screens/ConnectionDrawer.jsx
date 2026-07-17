import React from 'react';
import pkg from '../../package.json';
import { StatusDot } from '../components/core/StatusDot';
import { Button } from '../components/core/Button';
import { IconButton } from '../components/core/IconButton';
import { Badge } from '../components/core/Badge';
import { DiagnosticItem } from '../components/shell/DiagnosticItem';
import { Drawer } from '../components/shell/Drawer';
import { copyText } from '../lib/clipboard';

const D = {
  zh: {
    title: '连接',
    status: '状态', connected: '已连接', waiting: '等待客户端', port: '端口', token: 'Token', ver: '版本',
    recent: '最近活动',
    copyConfig: '复制配置', restart: '重启服务', diagnose: '运行诊断',
    regen: '重新生成 Token',
    rerun: '重新运行', close: '关闭',
    copyReport: '复制诊断报告',
    mismatch: '版本不一致',
    tokenLocal: '本机文件',
    noRecent: '暂无客户端活动',
    checks: {
      'host-listening': 'Host 监听',
      'token-file': 'Token 文件',
      'python-seen': 'Python 握手',
      'ae-project': 'AE 工程',
      'extendscript-ping': 'ExtendScript Ping',
    },
  },
  en: {
    title: 'Connection',
    status: 'Status', connected: 'Connected', waiting: 'Waiting for client', port: 'Port', token: 'Token', ver: 'Version',
    recent: 'Recent activity',
    copyConfig: 'Copy config', restart: 'Restart service', diagnose: 'Run diagnostics',
    regen: 'Regenerate token',
    rerun: 'Run again', close: 'Close',
    copyReport: 'Copy diagnostic report',
    mismatch: 'Version mismatch',
    tokenLocal: 'Local file',
    noRecent: 'No client activity yet',
    checks: {
      'host-listening': 'Host listening',
      'token-file': 'Token file',
      'python-seen': 'Python handshake',
      'ae-project': 'AE project',
      'extendscript-ping': 'ExtendScript ping',
    },
  },
};

function KV({ k, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
      <span style={{ width: 72, flex: 'none', font: '400 11px/1.35 var(--font-ui)', color: 'var(--text-tertiary)' }}>{k}</span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, font: '400 11px/1.35 var(--font-mono)', color: 'var(--text-primary)' }}>{children}</span>
    </div>
  );
}

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function callCopy(handler) {
  if (!handler) return;
  const value = handler();
  if (typeof value === 'string') copyText(value).catch(() => {});
  else if (value && typeof value.then === 'function') value.then((text) => {
    if (typeof text === 'string') copyText(text).catch(() => {});
  }).catch(() => {});
}

/* Body for the connection drawer (opened from the status bar). */
export function ConnectionDrawerBody({ lang = 'zh', info = {}, panelVersion = pkg.version, statusLabel, copyReady = true, onCopyConfig, onRestart, onDiagnose }) {
  const t = D[lang] || D.zh;
  const connected = !!info.lastClientSeenAt || !!info.lastHealthAt;
  const pythonVersion = info.pythonVersion || '-';
  const hostVersion = info.hostVersion || '-';
  const mismatch = info.pythonVersion && info.pythonVersion !== panelVersion;
  const recent = info.lastClientSeenAt ? [{ time: formatTime(info.lastClientSeenAt), text: lang === 'zh' ? '外部 MCP 客户端' : 'External MCP client' }] : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <KV k={t.status}>
        <StatusDot status={connected ? 'connected' : 'waiting'} size={7} />
        <span style={{ fontFamily: 'var(--font-ui)' }}>{statusLabel || (connected ? t.connected : t.waiting)}</span>
      </KV>
      <KV k={t.port}>{info.port || '-'} <IconButton icon="copy" title={t.copyConfig} disabled={!copyReady} onClick={() => callCopy(onCopyConfig)} style={{ width: 20, height: 20 }} /></KV>
      <KV k={t.token}>{info.tokenLabel || t.tokenLocal}</KV>
      <KV k={t.ver}>
        v{panelVersion} · host {hostVersion} · py {pythonVersion}
        {mismatch ? <Badge status="warn">{t.mismatch}</Badge> : null}
      </KV>
      <div style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)', marginTop: 4 }}>{t.recent}</div>
      <div style={{ background: 'var(--bg-well)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: '2px 8px' }}>
        {(recent.length ? recent : [{ time: '-', text: t.noRecent }]).map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 22, font: '400 10px/1.35 var(--font-ui)', color: 'var(--text-secondary)' }}>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>{r.time}</span>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.text}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
        <Button variant="secondary" size="sm" icon="copy" disabled={!copyReady} onClick={() => callCopy(onCopyConfig)}>{t.copyConfig}</Button>
        <Button variant="secondary" size="sm" icon="rotate-cw" onClick={onRestart}>{t.restart}</Button>
        <Button variant="secondary" size="sm" icon="stethoscope" onClick={onDiagnose}>{t.diagnose}</Button>
      </div>
    </div>
  );
}

/* Body for the item-by-item diagnostics overlay. */
export function DiagnosticsBody({ lang = 'zh', diagnostics = [], onRerun }) {
  const t = D[lang] || D.zh;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {diagnostics.map((c) => (
        <DiagnosticItem
          key={c.id}
          label={t.checks[c.id] || c.id}
          status={c.ok ? 'pass' : 'fail'}
          detail={c.ok ? c.detail : [c.detail, c.fixHint && c.fixHint[lang]].filter(Boolean).join(' · ')}
        />
      ))}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, paddingTop: 'var(--space-2)' }}>
        <Button variant="secondary" size="sm" icon="copy" onClick={() => copyText(JSON.stringify(diagnostics, null, 2)).catch(() => {})}>{t.copyReport}</Button>
        <Button variant="secondary" size="sm" icon="rotate-cw" onClick={onRerun}>{t.rerun}</Button>
      </div>
    </div>
  );
}

export function ConnectionDrawer({ open = false, onClose, info = {}, copyReady = true, onCopyConfig, onRestart, onDiagnose, diagnostics = [], lang = 'zh' }) {
  // Default params only cover undefined — a caller passing null or a
  // non-array sentinel must not crash the panel (this component renders
  // even while the drawer is closed).
  const diagList = Array.isArray(diagnostics) ? diagnostics : [];
  const t = D[lang] || D.zh;
  const panelVersion = info.panelVersion || pkg.version;
  return (
    <Drawer open={open} title={t.title} onClose={onClose} closeTitle={t.close}>
      <ConnectionDrawerBody
        lang={lang}
        info={info}
        panelVersion={panelVersion}
        copyReady={copyReady}
        onCopyConfig={onCopyConfig}
        onRestart={onRestart}
        onDiagnose={onDiagnose}
      />
      {diagList.length ? (
        <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-2)', borderTop: '1px solid var(--border-subtle)' }}>
          <DiagnosticsBody lang={lang} diagnostics={diagList} onRerun={onDiagnose} />
        </div>
      ) : null}
    </Drawer>
  );
}
