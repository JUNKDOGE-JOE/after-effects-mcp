import React from 'react';
import { Icon } from '../core/Icon';

export function PromptCard({ icon = 'wand-2', title, caption, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      className="ds-focusable"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--space-2)',
        width: '100%',
        textAlign: 'left',
        padding: 'var(--space-2)',
        background: hover ? 'var(--bg-hover)' : 'var(--bg-raised)',
        border: `1px solid ${hover ? 'var(--border-strong)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)',
        ...style,
      }}
    >
      <Icon name={icon} size={14} color="var(--text-tertiary)" style={{ marginTop: 1 }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', font: `var(--weight-medium) var(--text-body)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-primary)' }}>
          {title}
        </span>
        {caption ? (
          <span style={{ display: 'block', marginTop: 2, font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-tertiary)' }}>
            {caption}
          </span>
        ) : null}
      </span>
    </button>
  );
}
