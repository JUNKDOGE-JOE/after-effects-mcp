import React from 'react';
import { Icon } from '../core/Icon';
import { Spinner } from '../core/Spinner';
import { Button } from '../core/Button';

const GLYPHS = {
  pass: { icon: 'check', color: 'var(--ok)' },
  fail: { icon: 'x', color: 'var(--error)' },
  pending: { icon: 'circle', color: 'var(--text-disabled)' },
};

export function DiagnosticItem({ label, status = 'pending', detail, actionLabel, onAction, style }) {
  const g = GLYPHS[status];
  return (
    <div style={{ padding: 'var(--space-1) 0', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 22 }}>
        {status === 'running' ? (
          <Spinner size={12} />
        ) : (
          <Icon name={g.icon} size={12} strokeWidth={2.5} color={g.color} />
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            font: `var(--weight-regular) var(--text-body)/var(--leading-tight) var(--font-ui)`,
            color: status === 'pending' ? 'var(--text-tertiary)' : 'var(--text-primary)',
          }}
        >
          {label}
        </span>
      </div>
      {status === 'fail' && detail ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-2)',
            margin: '2px 0 2px 20px',
            padding: 'var(--space-15) var(--space-2)',
            background: 'var(--error-bg)',
            border: '1px solid var(--error-border)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: 'var(--text-secondary)' }}>
            {detail}
          </span>
          {actionLabel ? (
            <Button size="sm" variant="secondary" onClick={onAction} style={{ flex: 'none' }}>
              {actionLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
