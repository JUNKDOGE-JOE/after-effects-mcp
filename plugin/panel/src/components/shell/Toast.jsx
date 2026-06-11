import React from 'react';
import { Icon } from '../core/Icon';
import { IconButton } from '../core/IconButton';

const TOAST_ICONS = {
  ok: { icon: 'check', color: 'var(--ok)' },
  error: { icon: 'circle-alert', color: 'var(--error)' },
  warn: { icon: 'triangle-alert', color: 'var(--warn)' },
  info: { icon: 'info', color: 'var(--text-secondary)' },
};

export function Toast({ type = 'info', message, actionLabel, onAction, onClose, style }) {
  const t = TOAST_ICONS[type] || TOAST_ICONS.info;
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        maxWidth: '100%',
        padding: '5px 6px 5px 10px',
        background: 'var(--bg-overlay)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-toast)',
        animation: 'ds-fade-up var(--dur-slow) var(--ease-out)',
        ...style,
      }}
    >
      <Icon name={t.icon} size={13} strokeWidth={2.25} color={t.color} />
      <span
        style={{
          flex: 1,
          minWidth: 0,
          font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`,
          color: 'var(--text-primary)',
        }}
      >
        {message}
      </span>
      {actionLabel ? (
        <ToastAction label={actionLabel} onClick={onAction} />
      ) : null}
      {onClose ? <IconButton icon="x" title="关闭 Dismiss" onClick={onClose} style={{ width: 20, height: 20 }} /> : null}
    </div>
  );
}

function ToastAction({ label, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      className="ds-focusable"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 'none',
        height: 20,
        padding: '0 6px',
        background: hover ? 'var(--bg-active)' : 'var(--bg-hover)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text-primary)',
        font: `var(--weight-medium) var(--text-caption)/1 var(--font-ui)`,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}
