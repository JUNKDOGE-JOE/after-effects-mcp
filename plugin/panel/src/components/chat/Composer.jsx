import React from 'react';
import { Icon } from '../core/Icon';

export function Composer({
  value = '',
  onChange,
  onSend,
  onStop,
  streaming = false,
  disabled = false,
  notice,
  options,
  placeholder,
  style,
}) {
  const [focus, setFocus] = React.useState(false);
  const canSend = !disabled && !streaming && value.trim().length > 0;
  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend && onSend) onSend();
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-15)', ...style }}>
      {notice}
      <div
        style={{
          display: 'flex',
          flexDirection: options ? 'column' : 'row',
          alignItems: options ? 'stretch' : 'flex-end',
          gap: options ? 2 : 'var(--space-15)',
          padding: 'var(--space-15)',
          background: 'var(--bg-well)',
          border: `1px solid ${focus && !disabled ? 'var(--border-strong)' : 'var(--border-default)'}`,
          boxShadow: focus && !disabled ? '0 0 0 1px var(--focus-ring)' : 'none',
          borderRadius: 'var(--radius-lg)',
          opacity: disabled ? 0.5 : 1,
          transition: 'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
        }}
      >
        <textarea
          rows={1}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange && onChange(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onKeyDown={handleKey}
          style={{
            flex: 1,
            minWidth: 0,
            maxHeight: 72,
            resize: 'none',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            padding: '4px 2px 4px 4px',
            color: 'var(--text-primary)',
            font: `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-ui)`,
          }}
        ></textarea>
        {options ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2, overflow: 'hidden' }}>{options}</div>
            {streaming ? (
              <SendButton icon="square" title="停止 Stop" kind="stop" onClick={onStop} />
            ) : (
              <SendButton icon="arrow-up" title="发送 Send" kind="send" disabled={!canSend} onClick={canSend ? onSend : undefined} />
            )}
          </div>
        ) : streaming ? (
          <SendButton icon="square" title="停止 Stop" kind="stop" onClick={onStop} />
        ) : (
          <SendButton icon="arrow-up" title="发送 Send" kind="send" disabled={!canSend} onClick={canSend ? onSend : undefined} />
        )}
      </div>
    </div>
  );
}

function SendButton({ icon, title, kind, disabled = false, onClick }) {
  const [hover, setHover] = React.useState(false);
  const active = kind === 'send' && !disabled;
  return (
    <button
      type="button"
      className="ds-focusable"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 24,
        height: 24,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        background: active ? (hover ? 'var(--accent-hover)' : 'var(--accent)') : kind === 'stop' ? (hover ? '#ffffff' : 'var(--gray-11)') : 'var(--gray-6)',
        color: active || kind === 'stop' ? 'var(--text-on-solid)' : 'var(--gray-8)',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out)',
      }}
    >
      <Icon name={icon} size={13} strokeWidth={2.25} />
    </button>
  );
}
