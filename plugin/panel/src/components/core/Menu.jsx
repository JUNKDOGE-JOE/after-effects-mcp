import React from 'react';
import { Icon } from './Icon';

/* Dropdown/drop-up menu panel. Pure panel — the opener positions it
   (ComposerChip does this automatically). Selected row shows a check;
   right side carries a hint (shortcut number, "Enable", …). */

function Keycap({ children }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 16,
        height: 16,
        padding: '0 3px',
        background: 'var(--bg-raised)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        font: '400 var(--text-micro)/1 var(--font-ui)',
        color: 'var(--text-tertiary)',
      }}
    >
      {children}
    </span>
  );
}

function MenuRow({ item, onClose }) {
  const [hover, setHover] = React.useState(false);
  const disabled = !!item.disabled;
  return (
    <button
      type="button"
      className="ds-focusable"
      disabled={disabled}
      onClick={() => {
        if (item.onSelect) item.onSelect();
        if (onClose) onClose();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        width: '100%',
        minHeight: 'var(--hit-min)',
        padding: '2px var(--space-2)',
        background: hover && !disabled ? 'var(--bg-hover)' : 'transparent',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        font: '400 var(--text-body)/var(--leading-tight) var(--font-ui)',
        color: disabled ? 'var(--text-disabled)' : item.danger ? 'var(--error)' : 'var(--text-primary)',
        textAlign: 'left',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
      {item.checked ? <Icon name="check" size={12} strokeWidth={2.25} color="var(--text-primary)" /> : null}
      {item.hint ? (
        <span style={{ flex: 'none', font: '400 var(--text-caption)/1 var(--font-ui)', color: 'var(--text-tertiary)' }}>{item.hint}</span>
      ) : null}
    </button>
  );
}

export function Menu({ header, items = [], footer, onClose, minWidth = 184, style }) {
  return (
    <div
      role="menu"
      style={{
        minWidth,
        padding: 'var(--space-1)',
        background: 'var(--bg-overlay)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-overlay)',
        ...style,
      }}
    >
      {header ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-2)',
            padding: '4px var(--space-2) 6px',
            borderBottom: '1px solid var(--border-subtle)',
            marginBottom: 'var(--space-1)',
          }}
        >
          <span style={{ font: '400 var(--text-caption)/1 var(--font-ui)', color: 'var(--text-tertiary)' }}>{header.label}</span>
          {header.keys && header.keys.length ? (
            <span style={{ display: 'inline-flex', gap: 3 }}>
              {header.keys.map((k, i) => (
                <Keycap key={i}>{k}</Keycap>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {items.map((item, i) =>
          item.divider ? (
            <div key={i} style={{ height: 1, background: 'var(--border-subtle)', margin: '4px 0' }}></div>
          ) : (
            <MenuRow key={i} item={item} onClose={onClose} />
          )
        )}
      </div>
      {footer ? (
        <div
          style={{
            padding: '6px var(--space-2) 4px',
            borderTop: '1px solid var(--border-subtle)',
            marginTop: 'var(--space-1)',
            font: '400 var(--text-caption)/var(--leading-tight) var(--font-ui)',
            color: 'var(--text-tertiary)',
          }}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
