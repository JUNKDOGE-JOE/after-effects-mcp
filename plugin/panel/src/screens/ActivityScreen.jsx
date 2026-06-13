import React from 'react';
import { EmptyState } from '../components/shell/EmptyState';
import { FilterBar } from '../components/activity/FilterBar';
import { ActivityRow } from '../components/activity/ActivityRow';
import { Button } from '../components/core/Button';
import { eventOutcome, eventTitle, filterEvents } from '../lib/activityModel';

const A = {
  zh: {
    search: '搜索操作…',
    allResults: '全部',
    errF: '失败',
    empty: '暂无活动',
    emptyCap: '所有客户端对工程的每一次操作都会记录在这里。',
    clear: '清空',
    undoCheckpoint: '撤销到上一检查点',
    undoingCheckpoint: '撤销中…',
    undoCheckpointTitle: '恢复最近一次保存的 MCP 检查点',
    emptyResult: '无返回值',
  },
  en: {
    search: 'Search actions…',
    allResults: 'All',
    errF: 'Failed',
    empty: 'No activity yet',
    emptyCap: 'Every operation from every client is logged here.',
    clear: 'Clear',
    undoCheckpoint: 'Undo to previous checkpoint',
    undoingCheckpoint: 'Undoing…',
    undoCheckpointTitle: 'Restore the most recent saved MCP checkpoint',
    emptyResult: 'No return value',
  },
};

function rowResult(evt) {
  const outcome = eventOutcome(evt);
  if (outcome === 'ok') return 'success';
  if (outcome === 'empty') return 'empty';
  if (outcome.indexOf('denied') === 0) return 'denied';
  return 'error';
}

function eventDetails(evt) {
  return {
    client: evt.client,
    undoGroup: evt.undoGroup,
    durationMs: evt.durationMs,
    emptyResult: evt.emptyResult,
    error: evt.error,
  };
}

/* Activity tab: filter bar + audit timeline. */
export function ActivityScreen({
  events = [],
  lang = 'zh',
  onClear,
  onUndoCheckpoint,
  emptyTitle,
  emptyCaption,
}) {
  const t = A[lang] || A.zh;
  const [q, setQ] = React.useState('');
  const [res, setRes] = React.useState('all');
  const [undoing, setUndoing] = React.useState(false);
  const rows = filterEvents(events, { mode: res, query: q });
  const empty = events.length === 0;
  const undoCheckpoint = async () => {
    if (!onUndoCheckpoint || undoing) return;
    setUndoing(true);
    try {
      await onUndoCheckpoint();
    } finally {
      setUndoing(false);
    }
  };
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {empty ? (
        <EmptyState icon="list" title={emptyTitle || t.empty} caption={emptyCaption || t.emptyCap} style={{ flex: 1 }} />
      ) : (
        <React.Fragment>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)' }}>
            <FilterBar
              query={q}
              onQuery={setQ}
              searchPlaceholder={t.search}
              style={{ flex: 1, borderBottom: 0 }}
              filters={[
                {
                  value: res,
                  onChange: setRes,
                  width: 76,
                  options: [
                    { value: 'all', label: t.allResults },
                    { value: 'failed', label: t.errF },
                  ],
                },
              ]}
            />
            {onClear ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', padding: 'var(--space-2) var(--space-2) var(--space-2) 0' }}>
                {onUndoCheckpoint ? (
                  <Button size="sm" variant="secondary" icon="undo-2" onClick={undoCheckpoint} disabled={undoing} title={t.undoCheckpointTitle}>
                    {undoing ? t.undoingCheckpoint : t.undoCheckpoint}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" icon="trash-2" onClick={onClear} title={t.clear}>
                  {t.clear}
                </Button>
              </div>
            ) : null}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {rows.length ? rows.map((evt) => (
              <ActivityRow
                key={evt.id}
                time={new Date(evt.ts).toLocaleTimeString()}
                source={evt.client}
                verb={eventTitle(evt, lang)}
                target={eventOutcome(evt) === 'empty' ? t.emptyResult : evt.error || ''}
                result={rowResult(evt)}
                resultTitle={eventOutcome(evt) === 'empty' ? t.emptyResult : undefined}
                params={eventDetails(evt)}
              />
            )) : (
              <EmptyState icon="list" title={emptyTitle || t.empty} caption={emptyCaption || t.emptyCap} style={{ flex: 1 }} />
            )}
          </div>
        </React.Fragment>
      )}
    </div>
  );
}
