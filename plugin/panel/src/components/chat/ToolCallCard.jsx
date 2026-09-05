import React from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../core/Icon';
import { Spinner } from '../core/Spinner';
import { Button } from '../core/Button';
import { Drawer } from '../shell/Drawer';

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

function DetailsBlock({ details }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 'var(--space-2)',
        background: 'var(--gray-0)',
        borderTop: '1px solid var(--border-subtle)',
        font: `var(--weight-regular) var(--text-micro)/1.6 var(--font-mono)`,
        color: 'var(--text-secondary)',
        maxHeight: 220,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {details}
    </pre>
  );
}

function PreviewImage({ image, lang, onOpen, large = false }) {
  const [failed, setFailed] = React.useState(false);
  const reason = image.unavailable || (failed || !image.src ? 'load' : '');
  const messages = lang === 'en' ? {
    load: 'Preview unavailable. The file may have expired or failed to load.',
    limit: 'Preview exceeds the display limit.',
    format: 'This image format cannot be displayed.',
  } : {
    load: '预览不可用，文件可能已失效或加载失败。',
    limit: '预览超出显示上限。',
    format: '无法显示此图片格式。',
  };
  const preview = <img src={image.src} alt={lang === 'en' ? 'Tool preview' : '工具预览'} onError={() => setFailed(true)}
    style={{ display: 'block', width: '100%', height: large ? 'calc(100vh - 112px)' : 'min(240px, var(--tool-preview-max-height, 40vh))', objectFit: 'contain' }} />;
  return reason ? (
    <div role="status" style={{ padding: 8, color: 'var(--text-secondary)', fontSize: 12 }}>{messages[reason] || messages.load}</div>
  ) : onOpen ? <button type="button" title={lang === 'en' ? 'View larger image' : '查看大图'} onClick={onOpen}
    style={{ display: 'block', width: '100%', border: 0, padding: 0, background: 'transparent', cursor: 'zoom-in' }}>{preview}</button> : preview;
}

function ToolImages({ images, lang }) {
  const [index, setIndex] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const inline = React.useRef(null);
  const dialog = React.useRef(null);
  const close = () => { setOpen(false); inline.current?.querySelector('button')?.focus(); };
  React.useEffect(() => {
    if (open) dialog.current?.querySelector('button')?.focus();
  }, [open]);
  const dialogKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key !== 'Tab') return;
    const buttons = [...dialog.current.querySelectorAll('button:not(:disabled)')];
    const next = (buttons.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
    event.preventDefault(); buttons[next]?.focus();
  };
  const image = images[index];
  const navigation = images.length > 1 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 4 }}>
          <Button size="sm" disabled={index === 0} onClick={() => setIndex(index - 1)} title={lang === 'en' ? 'Previous image' : '上一张'}>‹</Button>
          <span style={{ fontSize: 12 }}>{index + 1} / {images.length}</span>
          <Button size="sm" disabled={index === images.length - 1} onClick={() => setIndex(index + 1)} title={lang === 'en' ? 'Next image' : '下一张'}>›</Button>
        </div>
      ) : null;
  return (
    <div ref={inline} data-tool-images style={{ borderTop: '1px solid var(--border-subtle)', minWidth: 0 }}>
      <PreviewImage key={`${index}:${image.src || image.unavailable}`} image={image} lang={lang}
        onOpen={() => setOpen(true)} />
      {navigation}
      {open ? createPortal(
        <div ref={dialog} onKeyDown={dialogKey} style={{ position: 'fixed', inset: 0, zIndex: 100 }}>
          <Drawer open title={lang === 'en' ? 'Preview' : '预览'} onClose={close} closeTitle={lang === 'en' ? 'Close preview' : '关闭预览'} style={{ maxHeight: '100%' }}>
            <PreviewImage key={`${index}:${image.src || image.unavailable}`} image={image} lang={lang} large />
            {navigation}
          </Drawer>
        </div>, document.body,
      ) : null}
    </div>
  );
}

function HeaderRow({ status, verb, target, expandable, expanded, onToggle }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      role={expandable ? 'button' : undefined}
      tabIndex={expandable ? 0 : undefined}
      aria-expanded={expandable ? expanded : undefined}
      onKeyDown={(event) => {
        if (expandable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onToggle(); }
      }}
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
  hint,
  details,
  images,
  lang = 'zh',
  detailsLabel = '详情',
  onRetry,
  steps,
  groupLabel,
  defaultExpanded = false,
  retryLabel = '重试',
  style,
}) {
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const isGroup = Array.isArray(steps) && steps.length > 0;
  const hasDetails = details !== undefined && details !== null && details !== '';
  const expandable = isGroup || params != null || hasDetails;
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
      {images?.length ? <ToolImages key={JSON.stringify(images)} images={images} lang={lang} /> : null}
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
      {expanded && !isGroup && hasDetails ? <DetailsBlock details={details} /> : null}
      {status === 'error' && errorMessage ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-2)',
            padding: 'var(--space-15) var(--space-2)',
            borderTop: '1px solid var(--border-subtle)',
            background: 'var(--error-bg)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ font: `var(--weight-regular) var(--text-caption)/var(--leading-tight) var(--font-ui)`, color: 'var(--error)' }}>
              {errorMessage}
            </span>
            {hint ? (
              <span style={{ font: `var(--weight-regular) var(--text-micro)/var(--leading-tight) var(--font-ui)`, color: 'var(--text-secondary)' }}>
                {hint}
              </span>
            ) : null}
            {hasDetails ? (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                style={{ alignSelf: 'flex-start', padding: 0, border: 0, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', font: `var(--weight-medium) var(--text-micro)/1.4 var(--font-ui)` }}
              >
                {detailsLabel}
              </button>
            ) : null}
          </div>
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
