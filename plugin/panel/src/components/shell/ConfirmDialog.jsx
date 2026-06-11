import React from 'react';
import { Button } from '../core/Button';

export function ConfirmDialog({
  open = false,
  title,
  body,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
  style,
}) {
  if (!open) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 'var(--space-4)' }}>
      <div
        onClick={onCancel}
        style={{ position: 'absolute', inset: 0, background: 'var(--scrim)', animation: 'ds-fade var(--dur-slow) var(--ease-out)' }}
      ></div>
      <div
        role="alertdialog"
        aria-label={typeof title === 'string' ? title : undefined}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 280,
          padding: 'var(--space-3)',
          background: 'var(--bg-overlay)',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-overlay)',
          animation: 'ds-fade-up var(--dur-slow) var(--ease-out)',
          ...style,
        }}
      >
        <div style={{ font: `var(--weight-semibold) var(--text-heading)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-primary)' }}>{title}</div>
        {body ? (
          <div style={{ marginTop: 'var(--space-15)', font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: 'var(--text-secondary)' }}>
            {body}
          </div>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-15)', marginTop: 'var(--space-3)' }}>
          <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
