import React from 'react';
import { Button } from '../core/Button';
import { copyText } from '../../lib/clipboard';
import {
  createToolLibraryApi,
  parseToolLibraryImport,
  splitToolLibraryItems,
  toolLibraryActions,
} from '../../lib/toolLibrary.js';

const S = {
  zh: {
    refresh: '刷新',
    loading: '正在加载工具库…',
    candidates: '候选工件',
    artifacts: '已保存工件',
    emptyCandidates: '暂无候选工件。',
    emptyArtifacts: '暂无已保存工件。',
    clearCandidates: '清空候选',
    promote: '沉淀',
    pin: '置顶',
    archive: '归档',
    restore: '恢复为已保存',
    remove: '删除',
    export: '导出',
    import: '导入',
    importHint: '粘贴导出的 JSON，或选择本地 .json 文件。',
    selectFile: '选择 .json 文件',
    importJson: '导入 JSON',
    characters: '字符数',
    time: '时间',
    status: '状态',
    revision: '修订',
    lastUsed: '上次使用',
    exportPath: '导出文件',
    copyPath: '复制路径',
    copied: '路径已复制',
    imported: '导入成功',
    cleared: (count) => `已清空 ${count} 个候选工件`,
    duplicate: (id) => `相同内容已存在：${id}`,
  },
  en: {
    refresh: 'Refresh',
    loading: 'Loading tool library…',
    candidates: 'Candidates',
    artifacts: 'Saved artifacts',
    emptyCandidates: 'No candidate artifacts.',
    emptyArtifacts: 'No saved artifacts.',
    clearCandidates: 'Clear candidates',
    promote: 'Promote',
    pin: 'Pin',
    archive: 'Archive',
    restore: 'Restore saved',
    remove: 'Delete',
    export: 'Export',
    import: 'Import',
    importHint: 'Paste exported JSON or select a local .json file.',
    selectFile: 'Choose .json file',
    importJson: 'Import JSON',
    characters: 'Characters',
    time: 'Time',
    status: 'Status',
    revision: 'Revision',
    lastUsed: 'Last used',
    exportPath: 'Exported file',
    copyPath: 'Copy path',
    copied: 'Path copied',
    imported: 'Import complete',
    cleared: (count) => `Cleared ${count} candidate artifacts`,
    duplicate: (id) => `Identical content already exists: ${id}`,
  },
};

function formatTime(value) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function artifactRowStyle() {
  return {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: 8,
    border: '1px solid var(--border-subtle)',
    borderRadius: 'var(--radius-md)',
    background: 'var(--bg-well)',
  };
}

function ActionButtons({ artifact, t, onAction, disabled }) {
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
      {toolLibraryActions(artifact.status).map((action) => (
        <Button
          key={action}
          variant={action === 'delete' ? 'danger' : 'secondary'}
          size="sm"
          disabled={disabled}
          onClick={() => onAction(action, artifact)}
        >
          {t[action === 'delete' ? 'remove' : action]}
        </Button>
      ))}
    </div>
  );
}

function CandidateList({ rows, t, onAction, busy }) {
  if (!rows.length) return <div style={{ color: 'var(--text-tertiary)', font: '400 11px/1.4 var(--font-ui)' }}>{t.emptyCandidates}</div>;
  return rows.map((artifact) => (
    <div key={artifact.id} style={artifactRowStyle()}>
      <div style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{artifact.name}</div>
      <div style={{ font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{artifact.id}</div>
      <div style={{ font: '400 10px/1.35 var(--font-ui)', color: 'var(--text-secondary)' }}>
        {t.characters}: {artifact.contentCharacters || 0} · {t.time}: {formatTime(artifact.updatedAt)}
      </div>
      <ActionButtons artifact={artifact} t={t} onAction={onAction} disabled={busy} />
    </div>
  ));
}

function ArtifactList({ rows, t, onAction, busy }) {
  if (!rows.length) return <div style={{ color: 'var(--text-tertiary)', font: '400 11px/1.4 var(--font-ui)' }}>{t.emptyArtifacts}</div>;
  return rows.map((artifact) => (
    <div key={artifact.id} style={artifactRowStyle()}>
      <div style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{artifact.name}</div>
      <div style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--text-secondary)' }}>
        {t.status}: {artifact.status} · {t.revision}: {artifact.revision} · {t.lastUsed}: {formatTime(artifact.lastUsedAt)}
      </div>
      <ActionButtons artifact={artifact} t={t} onAction={onAction} disabled={busy} />
    </div>
  ));
}

export function ToolLibrarySection({ lang = 'zh', port = 11488 }) {
  const t = S[lang] || S.zh;
  const [rows, setRows] = React.useState({ candidates: [], artifacts: [] });
  const [importText, setImportText] = React.useState('');
  const [feedback, setFeedback] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const fileInputRef = React.useRef(null);

  const request = React.useCallback(async (operation) => {
    const api = createToolLibraryApi({ port });
    return operation(api);
  }, [port]);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      const payload = await request((api) => api.list());
      setRows(splitToolLibraryItems(payload));
      setFeedback(null);
    } catch (error) {
      setFeedback({ type: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  }, [request]);

  React.useEffect(() => { refresh(); }, [refresh]);

  const runAction = async (action, artifact) => {
    setBusy(true);
    try {
      if (action === 'promote') await request((api) => api.promote(artifact.id));
      if (action === 'pin') await request((api) => api.pin(artifact.id));
      if (action === 'archive') await request((api) => api.archive(artifact.id));
      if (action === 'restore') await request((api) => api.restore(artifact.id));
      if (action === 'delete') await request((api) => api.remove(artifact.id));
      if (action === 'export') {
        const result = await request((api) => api.exportArtifact(artifact.id));
        setFeedback({ type: 'success', message: t.exportPath + ': ' + result.path, path: result.path });
      }
      if (action !== 'export') await refresh();
    } catch (error) {
      setFeedback({
        type: 'error',
        message: error.existingId ? t.duplicate(error.existingId) : error.message,
      });
    } finally {
      setBusy(false);
    }
  };

  const clearCandidates = async () => {
    setBusy(true);
    try {
      const result = await request((api) => api.clearCandidates());
      await refresh();
      setFeedback({ type: 'success', message: t.cleared(result.count || 0) });
    } catch (error) {
      setFeedback({ type: 'error', message: error.message });
    } finally {
      setBusy(false);
    }
  };

  const importArtifact = async () => {
    setBusy(true);
    try {
      const wire = parseToolLibraryImport(importText);
      await request((api) => api.importArtifact(wire));
      setImportText('');
      await refresh();
      setFeedback({ type: 'success', message: t.imported });
    } catch (error) {
      setFeedback({
        type: 'error',
        message: error.existingId ? t.duplicate(error.existingId) : error.message,
      });
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      parseToolLibraryImport(text);
      setImportText(text);
      setFeedback(null);
    } catch (error) {
      setFeedback({ type: 'error', message: error.message });
    } finally {
      event.target.value = '';
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {feedback ? (
        <div role={feedback.type === 'error' ? 'alert' : 'status'} style={{ padding: '7px 8px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', color: feedback.type === 'error' ? 'var(--error)' : 'var(--text-secondary)', font: '400 10px/1.45 var(--font-ui)', overflowWrap: 'anywhere' }}>
          {feedback.message}
          {feedback.path ? (
            <Button size="sm" variant="ghost" onClick={() => copyText(feedback.path).then(
              () => setFeedback({ type: 'success', message: t.copied }),
              (error) => setFeedback({ type: 'error', message: error.message }),
            )}>
              {t.copyPath}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)' }}>{t.candidates}</span>
        <Button size="sm" variant="danger" disabled={busy || !rows.candidates.length} onClick={clearCandidates}>{t.clearCandidates}</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={refresh}>{t.refresh}</Button>
      </div>
      {busy && !rows.candidates.length && !rows.artifacts.length ? <div style={{ color: 'var(--text-tertiary)', font: '400 10px/1.35 var(--font-ui)' }}>{t.loading}</div> : null}
      <CandidateList rows={rows.candidates} t={t} onAction={runAction} busy={busy} />

      <div style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)', marginTop: 2 }}>{t.artifacts}</div>
      <ArtifactList rows={rows.artifacts} t={t} onAction={runAction} busy={busy} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
        <div style={{ font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)' }}>{t.import}</div>
        <div style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--text-tertiary)' }}>{t.importHint}</div>
        <textarea
          value={importText}
          onChange={(event) => setImportText(event.target.value)}
          aria-label={t.import}
          style={{ minHeight: 84, resize: 'vertical', padding: 8, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', color: 'var(--text-primary)', font: '400 10px/1.4 var(--font-mono)' }}
        />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={chooseFile} style={{ display: 'none' }} />
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => fileInputRef.current && fileInputRef.current.click()}>{t.selectFile}</Button>
          <Button size="sm" variant="secondary" disabled={busy || !importText.trim()} onClick={importArtifact}>{t.importJson}</Button>
        </div>
      </div>
    </div>
  );
}
