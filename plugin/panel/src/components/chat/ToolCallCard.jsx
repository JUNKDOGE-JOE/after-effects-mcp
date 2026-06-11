import React from 'react';
import { Icon } from '../core/Icon';
import { Spinner } from '../core/Spinner';
import { Button } from '../core/Button';

function StatusGlyph({ status }) {
  if (status === 'running') return <Spinner size={12} />;
  if (status === 'error') return <Icon name="x" size={12} strokeWidth={2.5} color="var(--error)" />;
  return <Icon name="check" size={12} strokeWidth={2.5} color="var(--ok)" />;
}

function ParamsBlock({ params }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 'var(--space-2)',
        background: 'var(--gray-0)',
        borderTop: '1px solid var(--border-subtle)',
        font: `var(--weight-regular) var(--text-micro)/1.6 var(--font-mono)`,
        color: 'var(--text-secondary)',
        maxHeight: 140,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      }}
    >
      {typeof params === 'string' ? params : JSON.stringify(params, null, 2)}
    </pre>
  );
}

function HeaderRow({ status, verb, target, expandable, expanded, onToggle }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      role={expandable ? 'button' : undefined}
      onClick={expandable ? onToggle : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-15)',
        minHeight: 'var(--hit-min)',
        padding: '0 var(--space-2)',
        cursor: expandable ? 'pointer' : 'default',
        background: expandable && hover ? 'var(--bg-hover)' : 'transparent',
        transition: 'background var(--dur-fast) var(--ease-out)',
      }}
    >
      <StatusGlyph status={status} />
      <span style={{ font: `var(--weight-medium) var(--text-body)/1 var(--font-ui)`, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{verb}</span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`,
          color: 'var(--text-tertiary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {target}
      </span>
      {expandable ? (
        <Icon
          name="chevron-down"
          size={12}
          color="var(--text-tertiary)"
          style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform var(--dur-base) var(--ease-out)' }}
        />
      ) : null}
    </div>
  );
}

export function ToolCallCard({
  verb,
  target,
  status = 'success',
  params,
  errorMessage,
  onRetry,
  steps,
  groupLabel,
  defaultExpanded = false,
  retryLabel = '重试',
  style,
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const isGroup = Array.isArray(steps) && steps.length > 0;
  const expandable = isGroup || params != null;
  return (
    <div
      style={{
        background: 'var(--bg-well)',
        border: '1px solid var(--border-default)',
        borderLeft: '2px solid var(--accent)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        ...style,
      }}
    >
      <HeaderRow
        status={status}
        verb={verb}
        target={isGroup ? groupLabel || `${steps.length} steps` : target}
        expandable={expandable}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
      {expanded && isGroup ? (
        <div style={{ borderTop: '1px solid var(--border-subtle)', padding: 'var(--space-1) 0' }}>
          {steps.map((s, i) => (
            <div
              key={i}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-15)', minHeight: 22, padding: '0 var(--space-2) 0 var(--space-5)' }}
            >
              <StatusGlyph status={s.status || 'success'} />
              <span style={{ font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{s.verb}</span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  font: `var(--weight-regular) var(--text-caption)/1 var(--font-ui)`,
                  color: 'var(--text-tertiary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {s.target}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {expanded && !isGroup && params != null ? <ParamsBlock params={params} /> : null}
      {status === 'error' && errorMessage ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-15) var(--space-2)',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--error-bg)',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: 'var(--error)' }}>
            {errorMessage}
          </span>
          {onRetry ? (
            <Button size="sm" variant="secondary" icon="rotate-cw" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
