import React from 'react';
import { Badge } from '../components/core/Badge';
import { Button } from '../components/core/Button';
import { IconButton } from '../components/core/IconButton';
import { Segmented } from '../components/core/Segmented';
import { Input } from '../components/forms/Input';
import { Drawer } from '../components/shell/Drawer';
import {
  backendLabel,
  displayTitle,
  filterSessions,
  relativeTime,
  sortSessions,
} from '../lib/sessionList.js';

const C = {
  zh: {
    title: '会话历史',
    close: '关闭',
    search: '搜索会话',
    create: '新会话',
    active: '进行中',
    archived: '已归档',
    current: '使用中',
    rename: '改名',
    archive: '归档',
    restore: '还原',
    remove: '删除',
    confirmRemove: '确认删除？',
    cancel: '取消',
    emptyActive: '还没有历史会话',
    emptyArchived: '归档区为空',
  },
  en: {
    title: 'Session history',
    close: 'Close',
    search: 'Search sessions',
    create: 'New session',
    active: 'Active',
    archived: 'Archived',
    current: 'In use',
    rename: 'Rename',
    archive: 'Archive',
    restore: 'Restore',
    remove: 'Delete',
    confirmRemove: 'Delete permanently?',
    cancel: 'Cancel',
    emptyActive: 'No session history yet',
    emptyArchived: 'No archived sessions',
  },
};

export function SessionDrawer({
  open = false,
  onClose,
  lang = 'zh',
  sessions = [],
  activeId = null,
  onNew,
  onSwitch,
  onRename,
  onArchive,
  onUnarchive,
  onDelete,
}) {
  const t = C[lang] || C.zh;
  const [search, setSearch] = React.useState('');
  const [view, setView] = React.useState('active');
  const [editingId, setEditingId] = React.useState(null);
  const [editingTitle, setEditingTitle] = React.useState('');
  const [confirmId, setConfirmId] = React.useState(null);
  const now = Date.now();
  const archived = view === 'archived';
  const visible = sortSessions(filterSessions(sessions, { archived, search }));

  const submitRename = (id) => {
    if (onRename) onRename(id, editingTitle);
    setEditingId(null);
    setEditingTitle('');
  };

  return (
    <Drawer open={open} title={t.title} onClose={onClose} closeTitle={t.close}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-15)', flexWrap: 'wrap' }}>
          <Input
            value={search}
            onChange={setSearch}
            placeholder={t.search}
            ariaLabel={t.search}
            icon="search"
            style={{ flex: '1 1 150px' }}
          />
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            onClick={() => {
              if (onNew) onNew();
              if (onClose) onClose();
            }}
          >
            {t.create}
          </Button>
        </div>
        <Segmented
          full
          value={view}
          onChange={(value) => {
            setView(value);
            setConfirmId(null);
            setEditingId(null);
          }}
          options={[
            { value: 'active', label: t.active },
            { value: 'archived', label: t.archived },
          ]}
        />
        {visible.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            {visible.map((meta) => {
              const current = meta.id === activeId;
              const editing = editingId === meta.id;
              const confirming = confirmId === meta.id;
              return (
                <div
                  key={meta.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-1)',
                    minWidth: 0,
                    padding: 'var(--space-15) var(--space-1) var(--space-15) var(--space-2)',
                    background: current ? 'var(--bg-selected)' : 'var(--bg-well)',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editing ? (
                      <Input
                        value={editingTitle}
                        onChange={setEditingTitle}
                        autoFocus
                        ariaLabel={t.rename}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') submitRename(meta.id);
                          if (event.key === 'Escape') setEditingId(null);
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="ds-focusable"
                        onClick={() => {
                          if (onSwitch) onSwitch(meta.id);
                          if (onClose) onClose();
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 'var(--space-1)',
                          width: '100%',
                          minWidth: 0,
                          padding: 0,
                          color: 'var(--text-primary)',
                          background: 'transparent',
                          border: 0,
                          textAlign: 'left',
                          cursor: 'pointer',
                        }}
                      >
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: 'var(--weight-medium) var(--text-body)/var(--leading-tight) var(--font-ui)' }}>
                          {displayTitle(meta, lang)}
                        </span>
                        {current ? <Badge status="accent">{t.current}</Badge> : null}
                      </button>
                    )}
                    {!editing ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, marginTop: 3 }}>
                        <Badge status="neutral">{backendLabel(meta.backend, lang)}</Badge>
                        {meta.model ? <Badge status="neutral">{meta.model}</Badge> : null}
                        <span style={{ minWidth: 0, color: 'var(--text-tertiary)', font: 'var(--weight-regular) var(--text-micro)/var(--leading-tight) var(--font-ui)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {relativeTime(meta.updatedAt, now, lang)}
                        </span>
                      </div>
                    ) : null}
                  </div>
                  {confirming ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
                      <span style={{ color: 'var(--error)', font: 'var(--weight-medium) var(--text-caption)/1 var(--font-ui)' }}>{t.confirmRemove}</span>
                      <Button variant="danger" size="sm" onClick={() => { setConfirmId(null); if (onDelete) onDelete(meta.id); }}>{t.remove}</Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>{t.cancel}</Button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
                      <IconButton
                        icon="pencil"
                        title={t.rename}
                        onClick={() => {
                          setEditingId(meta.id);
                          setEditingTitle(meta.title || '');
                          setConfirmId(null);
                        }}
                      />
                      <IconButton
                        icon={meta.archived ? 'archive-restore' : 'archive'}
                        title={meta.archived ? t.restore : t.archive}
                        onClick={() => (meta.archived ? onUnarchive?.(meta.id) : onArchive?.(meta.id))}
                      />
                      <IconButton icon="trash-2" danger title={t.remove} onClick={() => { setConfirmId(meta.id); setEditingId(null); }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: 'var(--space-5) var(--space-2)', textAlign: 'center', color: 'var(--text-tertiary)', font: 'var(--weight-regular) var(--text-body)/var(--leading-normal) var(--font-ui)' }}>
            {archived ? t.emptyArchived : t.emptyActive}
          </div>
        )}
      </div>
    </Drawer>
  );
}
