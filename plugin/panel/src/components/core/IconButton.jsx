import React from 'react';
import { Icon } from './Icon';

export function IconButton({
  icon,
  title,
  size = 'md',
  variant = 'ghost',
  active = false,
  danger = false,
  disabled = false,
  onClick,
  style,
}) {
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const px = size === 'lg' ? 28 : 24;
  const color = danger
    ? 'var(--error)'
    : active || (hover && !disabled)
      ? 'var(--text-primary)'
      : 'var(--text-secondary)';
  const bg = disabled
    ? 'transparent'
    : press
      ? 'var(--bg-active)'
      : active
        ? 'var(--bg-active)'
        : hover
          ? 'var(--bg-hover)'
          : 'transparent';
  return (
    <button
      type="button"
      className="ds-focusable"
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
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
        width: px,
        height: px,
        flex: 'none',
        padding: 0,
        background: bg,
        color,
        border: variant === 'secondary' ? '1px solid var(--border-strong)' : '1px solid transparent',
        borderRadius: 'var(--radius-md)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
        ...style,
      }}
    >
      <Icon name={icon} size={size === 'lg' ? 16 : 14} />
    </button>
  );
}
