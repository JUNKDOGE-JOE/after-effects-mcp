import React from 'react';
import { Icon } from './Icon';

const DOT_COLORS = {
  connected: 'var(--ok)',
  waiting: 'var(--neutral-status)',
  error: 'var(--error)',
  paused: 'var(--warn)',
};

export function StatusDot({ status = 'waiting', size = 8, style }) {
  if (status === 'paused') {
    return <Icon name="pause" size={size + 4} strokeWidth={2.5} color={DOT_COLORS.paused} style={style} />;
  }
  return (
    <span
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: '50%',
        background: DOT_COLORS[status] || DOT_COLORS.waiting,
        animation: status === 'waiting' ? 'ds-pulse 1.6s var(--ease-in-out) infinite' : undefined,
        boxShadow: status === 'error' ? '0 0 0 3px var(--error-bg)' : undefined,
        ...style,
      }}
    ></span>
  );
}
