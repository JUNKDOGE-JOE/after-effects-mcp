import React from 'react';
import { Icon } from '../core/Icon';
import { Button } from '../core/Button';

export function PausedOverlay({
  title = '已暂停',
  caption = '所有 AI 操作已被阻止，正在进行的调用已中止。',
  note,
  resumeLabel = '恢复',
  onResume,
  style,
}) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-4)',
        background: 'rgba(29, 29, 29, 0.82)',
        backdropFilter: 'blur(1.5px)',
        animation: 'ds-fade var(--dur-slow) var(--ease-out)',
        ...style,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)', textAlign: 'center', maxWidth: 260 }}>
        <span
          style={{
            width: 48,
            height: 48,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--warn-bg)',
            border: '1px solid var(--warn-border)',
            borderRadius: '50%',
          }}
        >
          <Icon name="pause" size={20} strokeWidth={2} color="var(--warn)" />
        </span>
        <div style={{ font: `var(--weight-semibold) var(--text-title)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-primary)' }}>{title}</div>
        <div style={{ font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: 'var(--text-secondary)' }}>{caption}</div>
        {note ? (
          <div style={{ font: `var(--weight-regular) var(--text-caption)/var(--leading-normal) var(--font-ui)`, color: 'var(--text-tertiary)' }}>{note}</div>
        ) : null}
        <Button variant="primary" size="lg" icon="play" onClick={onResume} style={{ marginTop: 'var(--space-1)' }}>
          {resumeLabel}
        </Button>
      </div>
    </div>
  );
}
