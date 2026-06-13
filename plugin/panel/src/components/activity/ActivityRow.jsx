import React from 'react';
import { Icon } from '../core/Icon';
import { Badge } from '../core/Badge';
import { Button } from '../core/Button';

const RESULT = {
  success: { icon: 'check', color: 'var(--ok)' },
  error: { icon: 'x', color: 'var(--error)' },
  denied: { icon: 'circle-slash', color: 'var(--text-tertiary)' },
  empty: { icon: 'triangle-alert', color: 'var(--warn)' },
};

export function ActivityRow({
  time,
  source,
  verb,
  target,
  result = 'success',
  resultTitle,
  params,
  undoLabel = '撤销到此前',
  onUndo,
  expandable = true,
  style,
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const r = RESULT[result] || RESULT.success;
  return (
    <div style={{ borderBottom: '1px solid var(--border-subtle)', ...style }}>
      <div
        role={expandable ? 'button' : undefined}
        onClick={expandable ? () => setExpanded(!expanded) : undefined}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-15)',
          minHeight: 'var(--hit-min)',
          padding: '2px var(--space-2)',
          cursor: expandable ? 'pointer' : 'default',
          background: hover && expandable ? 'var(--bg-hover)' : 'transparent',
          transition: 'background var(--dur-fast) var(--ease-out)',
        }}
      >
        <span title={resultTitle} style={{ display: 'inline-flex', flex: 'none' }}>
          <Icon name={r.icon} size={12} strokeWidth={2.5} color={r.color} />
        </span>
        <span style={{ flex: 'none', font: `var(--weight-regular) var(--text-micro)/1 var(--font-mono)`, color: 'var(--text-tertiary)' }}>{time}</span>
        <Badge status="neutral" style={{ flex: 'none', maxWidth: 84, overflow: 'hidden' }}>{source}</Badge>
        <span style={{ flex: 'none', font: `var(--weight-medium) var(--text-caption)/1 var(--font-ui)`, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
          {verb}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`,
            color: 'var(--text-tertiary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {target}
        </span>
        {expandable ? (
          <Icon
            name="chevron-down"
            size={11}
            color="var(--text-tertiary)"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-base) var(--ease-out)' }}
          />
        ) : null}
      </div>
      {expanded ? (
        <div style={{ padding: '0 var(--space-2) var(--space-2) 26px', display: 'flex', flexDirection: 'column', gap: 'var(--space-15)' }}>
          {params != null ? (
            <pre
              style={{
                margin: 0,
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
          {onUndo ? (
            <Button size="sm" variant="secondary" icon="undo-2" onClick={onUndo} style={{ alignSelf: 'flex-start' }}>
              {undoLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
