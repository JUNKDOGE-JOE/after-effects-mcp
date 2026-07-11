import React from 'react';

export function Textarea({
  value,
  onChange,
  placeholder,
  mono = false,
  disabled = false,
  error = false,
  rows = 5,
  style,
}) {
  const [focused, setFocused] = React.useState(false);
  return (
    <textarea
      className="ds-focusable"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      onChange={(event) => onChange && onChange(event.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: 'block',
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        resize: 'vertical',
        padding: '7px 8px',
        background: 'var(--bg-well)',
        color: error ? 'var(--error)' : 'var(--text-primary)',
        border: `1px solid ${error ? 'var(--error-border)' : focused ? 'var(--border-strong)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: focused ? '0 0 0 1px var(--focus-ring)' : 'none',
        outline: 'none',
        opacity: disabled ? 0.45 : 1,
        font: `var(--weight-regular) ${mono ? 'var(--text-caption)' : 'var(--text-body)'}/var(--leading-normal) ${mono ? 'var(--font-mono)' : 'var(--font-ui)'}`,
        transition: 'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
        ...style,
      }}
    />
  );
}
