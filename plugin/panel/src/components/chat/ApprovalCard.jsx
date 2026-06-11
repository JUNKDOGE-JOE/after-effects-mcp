import React from 'react';
import { Icon } from '../core/Icon';
import { Badge } from '../core/Badge';
import { Button } from '../core/Button';

const L = {
  zh: {
    needs: '需要批准',
    high: '高风险',
    params: '查看参数',
    allow: '允许',
    deny: '拒绝',
    session: '本会话此类操作免批',
    allowed: '已允许',
    denied: '已拒绝',
  },
  en: {
    needs: 'Approval required',
    high: 'High risk',
    params: 'View parameters',
    allow: 'Allow',
    deny: 'Deny',
    session: "Don't ask again this session",
    allowed: 'Allowed',
    denied: 'Denied',
  },
};

export function ApprovalCard({
  risk = 'normal',
  title,
  description,
  params,
  lang = 'zh',
  state = 'pending',
  onAllow,
  onDeny,
  onAllowSession,
  style,
}) {
  const [expanded, setExpanded] = React.useState(false);
  const t = L[lang] || L.zh;
  const high = risk === 'high';
  return (
    <div
      style={{
        background: 'var(--bg-raised)',
        border: `1px solid ${high ? 'var(--error-border)' : 'var(--border-strong)'}`,
        borderLeft: `2px solid ${high ? 'var(--error)' : 'var(--accent)'}`,
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <div style={{ padding: 'var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-15)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-15)' }}>
          {high ? (
            <Badge status="error" icon="shield-alert">{t.high}</Badge>
          ) : (
            <Badge status="warn" icon="shield">{t.needs}</Badge>
          )}
        </div>
        <div style={{ font: `var(--weight-semibold) var(--text-body)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-primary)' }}>{title}</div>
        {description ? (
          <div style={{ font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: 'var(--text-secondary)' }}>{description}</div>
        ) : null}
        {params != null ? (
          <ApprovalParams t={t} expanded={expanded} onToggle={() => setExpanded(!expanded)} params={params} />
        ) : null}
      </div>
      {state === 'pending' ? (
        <div style={{ padding: '0 var(--space-2) var(--space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--space-15)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-15)' }}>
            <Button variant={high ? 'danger' : 'primary'} full onClick={onAllow}>{t.allow}</Button>
            <Button variant="secondary" full onClick={onDeny}>{t.deny}</Button>
          </div>
          {onAllowSession && !high ? (
            <Button variant="ghost" size="sm" onClick={onAllowSession} style={{ alignSelf: 'flex-start', color: 'var(--text-tertiary)' }}>
              {t.session}
            </Button>
          ) : null}
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-15)',
            padding: 'var(--space-15) var(--space-2)',
            borderTop: '1px solid var(--border-subtle)',
            font: `var(--weight-medium) var(--text-caption)/1 var(--font-ui)`,
            color: state === 'allowed' ? 'var(--ok)' : 'var(--text-tertiary)',
          }}
        >
          <Icon name={state === 'allowed' ? 'check' : 'x'} size={12} strokeWidth={2.5} />
          {state === 'allowed' ? t.allowed : t.denied}
        </div>
      )}
    </div>
  );
}

function ApprovalParams({ t, expanded, onToggle, params }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div>
      <button
        type="button"
        className="ds-focusable"
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          minHeight: 20,
          padding: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`,
          color: hover ? 'var(--text-secondary)' : 'var(--text-tertiary)',
        }}
      >
        <Icon name="chevron-right" size={11} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur-base) var(--ease-out)' }} />
        {t.params}
      </button>
      {expanded ? (
        <pre
          style={{
            margin: '4px 0 0',
            padding: 'var(--space-2)',
            background: 'var(--gray-0)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            font: `var(--weight-regular) var(--text-micro)/1.6 var(--font-mono)`,
            color: 'var(--text-secondary)',
            maxHeight: 120,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {typeof params === 'string' ? params : JSON.stringify(params, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
