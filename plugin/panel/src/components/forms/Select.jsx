import React from 'react';
import { Icon } from '../core/Icon';

export function Select({ options = [], value, onChange, disabled = false, full = true, size = 'md', style }) {
  const [focus, setFocus] = React.useState(false);
  const h = size === 'lg' ? 28 : 24;
  return (
    <span
      style={{
        position: 'relative',
        display: full ? 'flex' : 'inline-flex',
        alignItems: 'center',
        height: h,
        background: 'var(--bg-well)',
        border: `1px solid ${focus ? 'var(--border-strong)' : 'var(--border-default)'}`,
        boxShadow: focus ? '0 0 0 1px var(--focus-ring)' : 'none',
        borderRadius: 'var(--radius-md)',
        opacity: disabled ? 0.45 : 1,
        transition: 'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
        ...style,
      }}
    >
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange && onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          appearance: 'none',
          WebkitAppearance: 'none',
          background: 'transparent',
          border: 'none',
          outline: 'none',
          padding: '0 22px 0 8px',
          color: 'var(--text-primary)',
          font: `var(--weight-regular) var(--text-body)/1 var(--font-ui)`,
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} style={{ background: 'var(--bg-overlay)', color: 'var(--text-primary)' }}>
            {opt.label}
          </option>
        ))}
      </select>
      <Icon
        name="chevron-down"
        size={12}
        color="var(--text-tertiary)"
        style={{ position: 'absolute', right: 6, pointerEvents: 'none' }}
      />
    </span>
  );
}
