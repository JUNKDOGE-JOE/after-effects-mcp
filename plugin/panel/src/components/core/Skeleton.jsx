import React from 'react';

export function Skeleton({ width = '100%', height = 12, radius = 'var(--radius-sm)', style }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block',
        width,
        height,
        borderRadius: radius,
        background: 'linear-gradient(90deg, var(--gray-4) 25%, var(--gray-5) 40%, var(--gray-4) 55%)',
        backgroundSize: '200% 100%',
        animation: 'ds-shimmer 1.4s linear infinite',
        ...style,
      }}
    ></span>
  );
}
