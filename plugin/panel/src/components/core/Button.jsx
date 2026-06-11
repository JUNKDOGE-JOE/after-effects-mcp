import React from 'react';
import { Icon } from './Icon';

const BTN_H = { sm: 20, md: 24, lg: 28 };
const BTN_PAD = { sm: 8, md: 10, lg: 12 };

const VARIANTS = {
  primary: {
    base: { background: 'var(--gray-11)', color: 'var(--text-on-solid)', border: '1px solid transparent' },
    hover: { background: '#ffffff' },
    press: { background: 'var(--gray-10)' },
  },
  secondary: {
    base: { background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-strong)' },
    hover: { background: 'var(--bg-hover)' },
    press: { background: 'var(--bg-active)' },
  },
  ghost: {
    base: { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid transparent' },
    hover: { background: 'var(--bg-hover)', color: 'var(--text-primary)' },
    press: { background: 'var(--bg-active)', color: 'var(--text-primary)' },
  },
  danger: {
    base: { background: 'var(--error-bg)', color: 'var(--error)', border: '1px solid var(--error-border)' },
    hover: { background: 'rgba(248, 81, 73, 0.2)' },
    press: { background: 'rgba(248, 81, 73, 0.26)' },
  },
  accent: {
    base: { background: 'var(--accent)', color: 'var(--text-on-solid)', border: '1px solid transparent' },
    hover: { background: 'var(--accent-hover)' },
    press: { background: 'var(--accent-press)' },
  },
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  disabled = false,
  full = false,
  onClick,
  title,
  style,
}) {
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const v = VARIANTS[variant] || VARIANTS.secondary;
  const state = disabled ? {} : press ? { ...v.hover, ...v.press } : hover ? v.hover : {};
  return (
    <button
      type="button"
      className="ds-focusable"
      title={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPress(false); }}
      onMouseDown={() => setPress(true)}
      onMouseUp={() => setPress(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: BTN_H[size] || BTN_H.md,
        minHeight: size === 'sm' ? undefined : 'var(--hit-min)',
        padding: `0 ${BTN_PAD[size] || 10}px`,
        width: full ? '100%' : undefined,
        borderRadius: 'var(--radius-md)',
        font: `var(--weight-medium) var(--text-body)/1 var(--font-ui)`,
        whiteSpace: 'nowrap',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
        ...v.base,
        ...state,
        ...style,
      }}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 12 : 14} /> : null}
      {children}
    </button>
  );
}
