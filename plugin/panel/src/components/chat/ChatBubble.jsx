import React from 'react';
import { AIAvatar } from './AIAvatar';

function formatAttachmentBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

// CR/CRLF handling varies between engines under pre-wrap; normalize to LF so
// backend text renders one break per logical newline.
function normalizeBreaks(children) {
  return typeof children === 'string' ? children.replace(/\r\n?/g, '\n') : children;
}

export function ChatBubble({
  role = 'ai',
  children: rawChildren,
  attachments = [],
  streaming = false,
  avatar = true,
  style,
}) {
  const children = normalizeBreaks(rawChildren);
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
            whiteSpace: 'pre-wrap',
          }}
        >
          {children ? <div>{children}</div> : null}
          {attachments.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: children ? 5 : 0 }}>
              {attachments.map((attachment) => (
                <div
                  key={attachment.id}
                  style={{
                    minWidth: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    color: 'var(--text-secondary)',
                    font: 'var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)',
                  }}
                >
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {attachment.name}
                  </span>
                  <span style={{ flex: 'none', color: 'var(--text-tertiary)' }}>
                    {formatAttachmentBytes(attachment.size)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
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
          whiteSpace: 'pre-wrap',
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
