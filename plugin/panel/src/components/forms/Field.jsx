import React from 'react';

export function Field({ label, hint, caption, layout = 'stack', children, style }) {
  if (layout === 'row') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 'var(--hit-min)', ...style }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ font: `var(--weight-regular) var(--text-body)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-primary)' }}>{label}</div>
          {caption ? (
            <div style={{ font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-tertiary)', marginTop: 2 }}>{caption}</div>
          ) : null}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
        <label style={{ font: `var(--weight-medium) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-secondary)' }}>{label}</label>
        {hint ? <span style={{ font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-tertiary)' }}>{hint}</span> : null}
      </div>
      {children}
      {caption ? (
        <div style={{ font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: 'var(--text-tertiary)' }}>{caption}</div>
      ) : null}
    </div>
  );
}
