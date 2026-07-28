import React from 'react';
import { Icon } from '../core/Icon';
import {
  COMPOSER_DEFAULT_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  FALLBACK_MAX_HEIGHT,
  composerKeyboardRequest,
  createComposerDragSession,
} from '../../lib/composerResize';

function ComposerResizeHandle({
  height,
  minHeight,
  maxHeight,
  onHeightChange,
  onHeightReset,
}) {
  const [hover, setHover] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [focused, setFocused] = React.useState(false);
  const dragRef = React.useRef(null);

  const clearDrag = (updateState = true) => {
    const active = dragRef.current;
    if (!active) return;
    window.removeEventListener('mousemove', active.move);
    window.removeEventListener('mouseup', active.finish);
    active.session.cancel();
    dragRef.current = null;
    if (updateState) setDragging(false);
  };

  React.useEffect(() => () => clearDrag(false), []);

  const handleMouseDown = (event) => {
    if (event.button !== 0) return;
    event.currentTarget.focus();
    event.preventDefault();
    clearDrag();

    const session = createComposerDragSession({
      startY: event.clientY,
      startHeight: height,
      onRequest: (nextHeight) => onHeightChange?.(nextHeight),
    });
    const move = (moveEvent) => session.move(moveEvent);
    const finish = () => {
      if (dragRef.current?.session !== session) return;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', finish);
      session.finish();
      dragRef.current = null;
      setDragging(false);
    };

    dragRef.current = { session, move, finish };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', finish);
    setDragging(true);
  };

  const handleResizeKey = (event) => {
    const nextHeight = composerKeyboardRequest(event, height);
    if (nextHeight === null) {
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    onHeightChange?.(nextHeight);
  };

  return (
    <div
      style={{
        height: 10,
        flex: 'none',
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'row-resize',
        touchAction: 'none',
        userSelect: 'none',
        borderRadius: 4,
        boxShadow: focused ? '0 0 0 1px var(--focus-ring)' : 'none',
      }}
    >
      <input
        type="text"
        className="ds-focusable"
        tabIndex={0}
        role="separator"
        aria-label="调整输入区高度 Resize composer"
        aria-orientation="horizontal"
        aria-keyshortcuts="Shift+ArrowUp Shift+ArrowDown"
        aria-valuemin={minHeight}
        aria-valuemax={maxHeight}
        aria-valuenow={height}
        value=""
        readOnly
        onDoubleClick={onHeightReset}
        onKeyDown={handleResizeKey}
        onMouseDown={handleMouseDown}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          margin: 0,
          padding: 0,
          border: 'none',
          background: 'transparent',
          opacity: 0,
          cursor: 'row-resize',
          appearance: 'none',
          WebkitAppearance: 'none',
          touchAction: 'none',
        }}
      />
      <span
        aria-hidden="true"
        style={{
          width: 36,
          height: 2,
          pointerEvents: 'none',
          borderRadius: 1,
          background: dragging
            ? 'var(--focus-ring)'
            : hover
              ? 'var(--border-strong)'
              : 'var(--border-default)',
          transition: 'background var(--dur-fast) var(--ease-out)',
        }}
      />
    </div>
  );
}

export function Composer({
  value = '',
  onChange,
  onSend,
  onStop,
  streaming = false,
  disabled = false,
  notice,
  options,
  placeholder,
  style,
  height = COMPOSER_DEFAULT_HEIGHT,
  minHeight = COMPOSER_MIN_HEIGHT,
  maxHeight = FALLBACK_MAX_HEIGHT,
  onHeightChange,
  onHeightReset,
}) {
  const [focus, setFocus] = React.useState(false);
  const canSend = !disabled && !streaming && value.trim().length > 0;
  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend && onSend) onSend();
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-15)', ...style }}>
      {notice}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <ComposerResizeHandle
          height={height}
          minHeight={minHeight}
          maxHeight={maxHeight}
          onHeightChange={onHeightChange}
          onHeightReset={onHeightReset}
        />
        <div
          style={{
            height,
            minHeight: 0,
            display: 'flex',
            flexDirection: options ? 'column' : 'row',
            alignItems: 'stretch',
            gap: options ? 2 : 'var(--space-15)',
            padding: 'var(--space-15)',
            background: 'var(--bg-well)',
            border: `1px solid ${focus && !disabled ? 'var(--border-strong)' : 'var(--border-default)'}`,
            boxShadow: focus && !disabled ? '0 0 0 1px var(--focus-ring)' : 'none',
            borderRadius: 'var(--radius-lg)',
            opacity: disabled ? 0.5 : 1,
            transition: 'border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)',
          }}
        >
          <textarea
            rows={1}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange && onChange(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onKeyDown={handleKey}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              overflowY: 'auto',
              resize: 'none',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              padding: '4px 2px 4px 4px',
              color: 'var(--text-primary)',
              font: `var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-ui)`,
            }}
          ></textarea>
          {options ? (
            <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, overflow: 'visible' }}>
              {/* overflow must stay visible: ComposerChip drop-up menus render
                  inside this row and get clipped to its 24px strip otherwise. */}
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 2 }}>{options}</div>
              {streaming ? (
                <SendButton icon="square" title="停止 Stop" kind="stop" onClick={onStop} />
              ) : (
                <SendButton icon="arrow-up" title="发送 Send" kind="send" disabled={!canSend} onClick={canSend ? onSend : undefined} />
              )}
            </div>
          ) : streaming ? (
            <SendButton icon="square" title="停止 Stop" kind="stop" onClick={onStop} />
          ) : (
            <SendButton icon="arrow-up" title="发送 Send" kind="send" disabled={!canSend} onClick={canSend ? onSend : undefined} />
          )}
        </div>
      </div>
    </div>
  );
}

function SendButton({ icon, title, kind, disabled = false, onClick }) {
  const [hover, setHover] = React.useState(false);
  const active = kind === 'send' && !disabled;
  return (
    <button
      type="button"
      className="ds-focusable"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 24,
        height: 24,
        flex: 'none',
        alignSelf: 'flex-end',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        background: active ? (hover ? 'var(--accent-hover)' : 'var(--accent)') : kind === 'stop' ? (hover ? '#ffffff' : 'var(--gray-11)') : 'var(--gray-6)',
        color: active || kind === 'stop' ? 'var(--text-on-solid)' : 'var(--gray-8)',
        border: 'none',
        borderRadius: 'var(--radius-md)',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out)',
      }}
    >
      <Icon name={icon} size={13} strokeWidth={2.25} />
    </button>
  );
}
