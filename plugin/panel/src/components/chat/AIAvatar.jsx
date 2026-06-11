import React from 'react';
import { Icon } from '../core/Icon';

export function AIAvatar({ size = 20, style }) {
  return (
    <span
      aria-label="AI"
      style={{
        width: size,
        height: size,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--accent-bg)',
        border: '1px solid var(--accent-border)',
        borderRadius: 'var(--radius-md)',
        ...style,
      }}
    >
      <Icon name="sparkles" size={Math.round(size * 0.6)} color="var(--accent)" strokeWidth={2} />
    </span>
  );
}
