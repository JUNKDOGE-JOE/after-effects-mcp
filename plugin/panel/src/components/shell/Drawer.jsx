import React from 'react';
import { IconButton } from '../core/IconButton';

/* Top drawer that slides under the status bar. Parent container must be position:relative. */
export function Drawer({ open = false, title, onClose, children, closeTitle = '关闭 Close', style }) {
  if (!open) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30 }}>
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'var(--scrim)', animation: 'ds-fade var(--dur-slow) var(--ease-out)' }}
      ></div>
      <div
        role="dialog"
        aria-label={typeof title === 'string' ? title : undefined}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          maxHeight: '85%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-overlay)',
          borderBottom: '1px solid var(--border-strong)',
          borderRadius: '0 0 var(--radius-lg) var(--radius-lg)',
          boxShadow: 'var(--shadow-overlay)',
          animation: 'ds-fade-down var(--dur-slow) var(--ease-out)',
          ...style,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-2) var(--space-2) var(--space-3)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, font: `var(--weight-semibold) var(--text-heading)/1 var(--font-ui)`, color: 'var(--text-primary)' }}>
            {title}
          </span>
          <IconButton icon="x" title={closeTitle} onClick={onClose} />
        </div>
        <div style={{ overflow: 'auto', padding: 'var(--space-3)' }}>{children}</div>
      </div>
    </div>
  );
}
