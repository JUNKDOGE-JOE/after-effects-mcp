import React from 'react';
import { Icon } from './Icon';

const BADGE_COLORS = {
  ok: { color: 'var(--ok)', background: 'var(--ok-bg)', borderColor: 'var(--ok-border)' },
  warn: { color: 'var(--warn)', background: 'var(--warn-bg)', borderColor: 'var(--warn-border)' },
  error: { color: 'var(--error)', background: 'var(--error-bg)', borderColor: 'var(--error-border)' },
  accent: { color: 'var(--accent)', background: 'var(--accent-bg)', borderColor: 'var(--accent-border)' },
  neutral: { color: 'var(--text-secondary)', background: 'var(--bg-hover)', borderColor: 'var(--border-strong)' },
};

export function Badge({ status = 'neutral', icon, dot = false, children, style }) {
  const c = BADGE_COLORS[status] || BADGE_COLORS.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 16,
        padding: '0 6px',
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${c.borderColor}`,
        background: c.background,
        color: c.color,
        font: `var(--weight-medium) var(--text-micro)/1 var(--font-ui)`,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dot ? <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', flex: 'none' }}></span> : null}
      {icon ? <Icon name={icon} size={10} strokeWidth={2} /> : null}
      {children}
    </span>
  );
}
