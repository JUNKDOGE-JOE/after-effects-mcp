import React from 'react';
import { Icon } from './Icon';

export function Segmented({ options = [], value, onChange, full = false, style }) {
  return (
    <div
      role="radiogroup"
      style={{
        display: full ? 'flex' : 'inline-flex',
        gap: 2,
        padding: 2,
        background: 'var(--bg-well)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        ...style,
      }}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <SegmentedOption key={opt.value} opt={opt} selected={selected} full={full} onSelect={() => onChange && onChange(opt.value)} />
        );
      })}
    </div>
  );
}

function SegmentedOption({ opt, selected, full, onSelect }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className="ds-focusable"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: full ? 1 : undefined,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 5,
        height: 20,
        padding: '0 8px',
        background: selected ? 'var(--gray-5)' : hover ? 'var(--bg-hover)' : 'transparent',
        color: selected ? 'var(--text-primary)' : hover ? 'var(--text-secondary)' : 'var(--text-tertiary)',
        border: selected ? '1px solid var(--border-strong)' : '1px solid transparent',
        borderRadius: 'var(--radius-sm)',
        font: `var(--weight-medium) var(--text-caption)/1 var(--font-ui)`,
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      }}
    >
      {opt.icon ? <Icon name={opt.icon} size={12} /> : null}
      {opt.label}
    </button>
  );
}
