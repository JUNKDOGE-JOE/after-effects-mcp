import React from 'react';
import { AIAvatar } from './AIAvatar';

export function ChatBubble({ role = 'ai', children, streaming = false, avatar = true, style }) {
  if (role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', ...style }}>
        <div
          style={{
            maxWidth: '85%',
            padding: '5px 10px',
            background: 'var(--bg-raised)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            borderBottomRightRadius: 'var(--radius-sm)',
            font: `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-ui)`,
            color: 'var(--text-primary)',
            overflowWrap: 'break-word',
          }}
        >
          {children}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start', ...style }}>
      {avatar ? <AIAvatar style={{ marginTop: 1 }} /> : <span style={{ width: 20, flex: 'none' }}></span>}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          font: `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-ui)`,
          color: 'var(--text-primary)',
          overflowWrap: 'break-word',
        }}
      >
        {children}
        {streaming ? (
          <span
            style={{
              display: 'inline-block',
              width: 6,
              height: 12,
              marginLeft: 3,
              verticalAlign: '-1px',
              background: 'var(--accent)',
              borderRadius: 1,
              animation: 'ds-pulse 1s var(--ease-in-out) infinite',
            }}
          ></span>
        ) : null}
      </div>
    </div>
  );
}
