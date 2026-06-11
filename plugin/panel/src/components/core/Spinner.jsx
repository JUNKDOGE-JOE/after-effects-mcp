import React from 'react';

export function Spinner({ size = 12, style }) {
  return (
    <span
      role="progressbar"
      aria-label="loading"
      style={{
        width: size,
        height: size,
        flex: 'none',
        display: 'inline-block',
        border: '1.5px solid var(--gray-7)',
        borderTopColor: 'var(--text-secondary)',
        borderRadius: '50%',
        animation: 'ds-spin 0.8s linear infinite',
        ...style,
      }}
    ></span>
  );
}
