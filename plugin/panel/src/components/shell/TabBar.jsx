import React from 'react';
import { Icon } from '../core/Icon';

export function TabBar({ tabs = [], active, onChange, style }) {
  return (
    <div
      role="tablist"
      style={{
        height: 'var(--tabbar-h)',
        flex: 'none',
        display: 'grid',
        gridTemplateColumns: `repeat(${tabs.length || 1}, 1fr)`,
        background: 'var(--bg-panel)',
        borderTop: '1px solid var(--border-default)',
        ...style,
      }}
    >
      {tabs.map((tab) => (
        <Tab key={tab.id} tab={tab} selected={tab.id === active} onSelect={() => onChange && onChange(tab.id)} />
      ))}
    </div>
  );
}

function Tab({ tab, selected, onSelect }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className="ds-focusable"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        padding: 0,
        background: hover && !selected ? 'var(--bg-hover)' : 'transparent',
        border: 'none',
        color: selected ? 'var(--text-primary)' : hover ? 'var(--text-secondary)' : 'var(--text-tertiary)',
        cursor: 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: -1,
          left: '25%',
          right: '25%',
          height: 2,
          background: selected ? 'var(--gray-11)' : 'transparent',
          transition: 'background var(--dur-fast) var(--ease-out)',
        }}
      ></span>
      <span style={{ position: 'relative' }}>
        <Icon name={tab.icon} size={14} />
        {tab.dot ? (
          <span style={{ position: 'absolute', top: -2, right: -4, width: 5, height: 5, borderRadius: '50%', background: 'var(--warn)' }}></span>
        ) : null}
      </span>
      <span style={{ font: `var(--weight-medium) var(--text-micro)/1 var(--font-ui)` }}>{tab.label}</span>
    </button>
  );
}
