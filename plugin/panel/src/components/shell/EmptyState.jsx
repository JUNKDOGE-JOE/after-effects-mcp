import React from 'react';
import { Icon } from '../core/Icon';

export function EmptyState({ icon = 'inbox', title, caption, action, compact = false, style }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--space-2)',
        padding: compact ? 'var(--space-4)' : 'var(--space-6) var(--space-4)',
        textAlign: 'center',
        ...style,
      }}
    >
      <span
        style={{
          width: compact ? 36 : 48,
          height: compact ? 36 : 48,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--bg-well)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '50%',
        }}
      >
        <Icon name={icon} size={compact ? 16 : 20} strokeWidth={1.5} color="var(--text-tertiary)" />
      </span>
      <div style={{ font: `var(--weight-medium) var(--text-heading)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-secondary)' }}>{title}</div>
      {caption ? (
        <div style={{ maxWidth: 240, font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: 'var(--text-tertiary)' }}>
          {caption}
        </div>
      ) : null}
      {action ? <div style={{ marginTop: 'var(--space-1)' }}>{action}</div> : null}
    </div>
  );
}
