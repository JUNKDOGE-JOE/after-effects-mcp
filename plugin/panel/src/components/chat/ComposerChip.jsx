import React from 'react';
import { Icon } from '../core/Icon';
import { Menu } from '../core/Menu';

/* Compact option chip for the composer footer row: model, thinking depth,
   fast mode, approval mode. Two behaviors:
   - menu chip: pass `items` — opens a drop-up Menu, shows current value.
   - toggle chip: pass `onToggle` — flips `active` (e.g. 快速 Fast).
   Visuals stay neutral gray — the lavender accent is reserved for AI identity. */

export function ComposerChip({
  icon,
  label,
  active = false,
  disabled = false,
  items,
  menuHeader,
  menuFooter,
  menuAlign = 'left',
  onToggle,
  title,
  style,
}) {
  const [hover, setHover] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef(null);
  const isMenu = Array.isArray(items) && items.length > 0;

  React.useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const lit = active || open;
  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 'none', ...style }}>
      <button
        type="button"
        className="ds-focusable"
        disabled={disabled}
        title={title}
        aria-haspopup={isMenu ? 'menu' : undefined}
        aria-expanded={isMenu ? open : undefined}
        aria-pressed={!isMenu && onToggle ? active : undefined}
        onClick={() => {
          if (disabled) return;
          if (isMenu) setOpen((v) => !v);
          else if (onToggle) onToggle(!active);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 'var(--hit-min)',
          padding: '0 var(--space-15)',
          background: lit ? 'var(--bg-selected)' : hover && !disabled ? 'var(--bg-hover)' : 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          font: '400 var(--text-caption)/1 var(--font-ui)',
          color: disabled ? 'var(--text-disabled)' : lit ? 'var(--text-primary)' : 'var(--text-tertiary)',
          cursor: disabled ? 'default' : 'pointer',
          transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
          whiteSpace: 'nowrap',
        }}
      >
        {icon ? <Icon name={icon} size={12} /> : null}
        {label ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 96 }}>{label}</span> : null}
        {!isMenu && onToggle && active ? <Icon name="check" size={10} strokeWidth={2.5} /> : null}
        {isMenu ? <Icon name="chevron-down" size={10} strokeWidth={2} style={{ opacity: 0.7 }} /> : null}
      </button>
      {isMenu && open ? (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            [menuAlign === 'right' ? 'right' : 'left']: 0,
            zIndex: 30,
            animation: 'ds-fade-up var(--dur-base) var(--ease-out)',
          }}
        >
          <Menu header={menuHeader} items={items} footer={menuFooter} onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
