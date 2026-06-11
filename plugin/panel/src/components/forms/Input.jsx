import React from 'react';
import { Icon } from '../core/Icon';
import { IconButton } from '../core/IconButton';

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  secret = false,
  mono = false,
  disabled = false,
  error = false,
  size = 'md',
  suffix,
  full = true,
  style,
}) {
  const [focus, setFocus] = React.useState(false);
  const [revealed, setRevealed] = React.useState(false);
  const h = size === 'lg' ? 28 : 24;
  return (
    <span
      style={{
        display: full ? 'flex' : 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: h,
        padding: '0 2px 0 8px',
        background: 'var(--bg-well)',
        border: `1px solid ${error ? 'var(--error-border)' : focus ? 'var(--border-strong)' : 'var(--border-default)'}`,
        boxShadow: focus ? '0 0 0 1px var(--focus-ring)' : 'none',
        borderRadius: 'var(--radius-md)',
        opacity: disabled ? 0.45 : 1,
        transition: 'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
        ...style,
      }}
    >
      <input
        type={secret && !revealed ? 'password' : type === 'password' ? 'text' : type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange && onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          padding: 0,
          color: error ? 'var(--error)' : 'var(--text-primary)',
          font: `var(--weight-regular) ${mono || secret ? 'var(--text-caption)' : 'var(--text-body)'}/1 ${mono || secret ? 'var(--font-mono)' : 'var(--font-ui)'}`,
        }}
      />
      {secret ? (
        <IconButton
          icon={revealed ? 'eye-off' : 'eye'}
          title={revealed ? 'Hide' : 'Show'}
          onClick={() => setRevealed(!revealed)}
          style={{ width: 20, height: 20 }}
        />
      ) : null}
      {suffix}
    </span>
  );
}
