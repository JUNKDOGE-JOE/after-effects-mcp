import React from 'react';
import { Icon } from '../core/Icon';
import { StatusDot } from '../core/StatusDot';
import { IconButton } from '../core/IconButton';

export function StatusBar({
  status = 'waiting',
  label,
  onStatusClick,
  onTogglePause,
  onSettings,
  pauseTitle = '暂停所有 AI 操作 Pause all AI actions',
  resumeTitle = '恢复 Resume',
  settingsTitle = '设置 Settings',
  style,
}) {
  const [hover, setHover] = React.useState(false);
  const paused = status === 'paused';
  return (
    <div
      style={{
        height: 'var(--statusbar-h)',
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: '0 var(--space-15) 0 var(--space-1)',
        background: 'var(--bg-panel)',
        borderBottom: `1px solid ${paused ? 'var(--warn-border)' : 'var(--border-default)'}`,
        ...style,
      }}
    >
      <button
        type="button"
        className="ds-focusable"
        onClick={onStatusClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-15)',
          height: 26,
          padding: '0 var(--space-2)',
          minWidth: 0,
          background: hover ? 'var(--bg-hover)' : 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          cursor: 'pointer',
          transition: 'background var(--dur-fast) var(--ease-out)',
        }}
      >
        <StatusDot status={status} />
        <span
          style={{
            font: `var(--weight-medium) var(--text-body)/1 var(--font-ui)`,
            color: paused ? 'var(--warn)' : 'var(--text-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {label}
        </span>
        <Icon name="chevron-down" size={11} color="var(--text-tertiary)" />
      </button>
      <span style={{ flex: 1 }}></span>
      <PauseButton paused={paused} title={paused ? resumeTitle : pauseTitle} onClick={onTogglePause} />
      <IconButton icon="settings" title={settingsTitle} onClick={onSettings} />
    </div>
  );
}

function PauseButton({ paused, title, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      className="ds-focusable"
      title={title}
      aria-label={title}
      aria-pressed={paused}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 24,
        height: 24,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        background: paused ? 'var(--warn-bg)' : hover ? 'var(--bg-hover)' : 'transparent',
        color: paused ? 'var(--warn)' : hover ? 'var(--text-primary)' : 'var(--text-secondary)',
        border: paused ? '1px solid var(--warn-border)' : '1px solid transparent',
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      }}
    >
      <Icon name={paused ? 'play' : 'pause'} size={13} strokeWidth={2.25} />
    </button>
  );
}
