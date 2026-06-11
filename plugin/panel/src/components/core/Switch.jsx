import React from 'react';

export function Switch({ checked = false, onChange, disabled = false, title, style }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className="ds-focusable"
      title={title}
      disabled={disabled}
      onClick={() => onChange && onChange(!checked)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        width: 28,
        height: 16,
        flex: 'none',
        padding: 2,
        margin: '4px 0', /* pads the 16px control to a ≥24px hit area */
        background: checked ? (hover && !disabled ? '#ffffff' : 'var(--gray-11)') : hover && !disabled ? 'var(--gray-8)' : 'var(--gray-7)',
        border: 'none',
        borderRadius: 'var(--radius-full)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background var(--dur-fast) var(--ease-out)',
        ...style,
      }}
    >
      <span
        style={{
          width: 12,
          height: 12,
          borderRadius: 'var(--radius-full)',
          background: checked ? 'var(--gray-3)' : 'var(--gray-10)',
          transform: checked ? 'translateX(12px)' : 'translateX(0)',
          transition: 'transform var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)',
        }}
      ></span>
    </button>
  );
}
