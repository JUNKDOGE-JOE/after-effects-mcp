import React from 'react';
import { Badge } from '../components/core/Badge';
import { Button } from '../components/core/Button';
import { EmptyState } from '../components/shell/EmptyState';
import { Input } from '../components/forms/Input';
import { Textarea } from '../components/forms/Textarea';
import { Segmented } from '../components/core/Segmented';
import { copyText } from '../lib/clipboard';
import {
  createToolLibraryApi,
  executeToolLibraryAction,
  filterToolLibraryItems,
  groupToolLibraryItems,
  mergeToolLibraryItems,
  parseToolLibraryImport,
  splitToolLibraryItems,
  toolLibraryActions,
} from '../lib/toolLibrary.js';

const TEXT = {
  zh: {
    title: '工具库',
    tools: '工具',
    skills: '技能',
    searchTools: '搜索工具…',
    searchSkills: '筛选技能…',
    empty: '没有匹配项',
    select: '选择一个条目',
    selectCap: '先从左侧选择，再查看详情或运行。',
    args: '参数（JSON）',
    argsTab: '参数',
    cancel: '取消',
    run: '运行',
    render: '渲染并复制',
    result: '结果',
    refresh: '刷新',
    content: '内容',
    invalidArgs: '参数必须是 JSON 对象。',
    signed: '已验证',
    user: '用户工具',
    prompt: '提示技能',
    import: '导入',
    importHint: '粘贴导出的 JSON，或选择本地 .json 文件。',
    selectFile: '选择 .json 文件',
    importJson: '导入 JSON',
    clearCandidates: '清空候选',
    candidates: '候选',
    saved: '已保存',
    pinned: '已置顶',
    archived: '已归档',
    deprecated: '已归档（弃用）',
    candidate: '候选',
    status: '状态',
    promote: '沉淀',
    pin: '置顶',
    unpin: '取消置顶',
    archive: '归档',
    restore: '恢复为已保存',
    delete: '删除',
    export: '导出',
    exportPath: '导出文件',
    copyPath: '复制路径',
    copied: '路径已复制',
    imported: '导入成功',
    cleared: (count) => `已清空 ${count} 个候选工件`,
    completed: (action) => `${action}成功`,
    duplicate: (id) => `相同内容已存在：${id}`,
  },
  en: {
    title: 'Tool Library',
    tools: 'Tools',
    skills: 'Skills',
    searchTools: 'Search tools…',
    searchSkills: 'Filter skills…',
    empty: 'No matching items',
    select: 'Select an item',
    selectCap: 'Choose an item on the left to inspect or run it.',
    args: 'Arguments (JSON)',
    argsTab: 'Args',
    cancel: 'Cancel',
    run: 'Run',
    render: 'Render & copy',
    result: 'Result',
    refresh: 'Refresh',
    content: 'Content',
    invalidArgs: 'Arguments must be a JSON object.',
    signed: 'Verified',
    user: 'User tool',
    prompt: 'Prompt skill',
    import: 'Import',
    importHint: 'Paste exported JSON or select a local .json file.',
    selectFile: 'Choose .json file',
    importJson: 'Import JSON',
    clearCandidates: 'Clear candidates',
    candidates: 'Candidates',
    saved: 'Saved',
    pinned: 'Pinned',
    archived: 'Archived',
    deprecated: 'Archived (deprecated)',
    candidate: 'Candidate',
    status: 'Status',
    promote: 'Promote',
    pin: 'Pin',
    unpin: 'Unpin',
    archive: 'Archive',
    restore: 'Restore saved',
    delete: 'Delete',
    export: 'Export',
    exportPath: 'Exported file',
    copyPath: 'Copy path',
    copied: 'Path copied',
    imported: 'Import complete',
    cleared: (count) => `Cleared ${count} candidate artifacts`,
    completed: (action) => `${action} complete`,
    duplicate: (id) => `Identical content already exists: ${id}`,
  },
};

const STATUS_BADGE = {
  pinned: 'accent',
  saved: 'ok',
  candidate: 'warn',
  archived: 'neutral',
  deprecated: 'neutral',
};

function objectArgs(text) {
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('object required');
  }
  return value;
}

function defaultArgs(schema) {
  const result = {};
  const properties = schema && schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  for (const [name, definition] of Object.entries(properties)) {
    if (definition && definition.default !== undefined) result[name] = definition.default;
  }
  return result;
}

function itemId(mode, item) {
  return mode === 'skills' ? 'skill:' + item.name : item.id;
}

function statusLabel(t, status) {
  return t[status] || status;
}

function statusBadgeStatus(status) {
  return STATUS_BADGE[status] || 'neutral';
}

function ItemRow({ mode, item, selected, onSelect, t }) {
  const id = itemId(mode, item);
  const status = mode === 'tools' ? item.status : '';
  const archived = status === 'archived' || status === 'deprecated';
  return (
    <button
      type="button"
      className="ds-focusable"
      onClick={() => onSelect(item)}
      style={{
        width: '100%',
        minHeight: 48,
        padding: '7px 9px',
        textAlign: 'left',
        background: selected ? 'var(--bg-selected)' : 'transparent',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-primary)',
        cursor: 'pointer',
        opacity: archived ? 0.65 : 1,
      }}
      data-item-id={id}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            font: '500 12px/1.35 var(--font-ui)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.name || item.id}
        </span>
        {status ? <Badge status={statusBadgeStatus(status)}>{statusLabel(t, status)}</Badge> : null}
      </span>
      <span
        style={{
          display: 'block',
          marginTop: 2,
          font: '400 10px/1.35 var(--font-ui)',
          color: 'var(--text-tertiary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {item.description || item.kind || ''}
      </span>
    </button>
  );
}

function LibraryActionButtons({ artifact, t, onAction, disabled }) {
  return (
    <div className="tools-library-actions">
      {toolLibraryActions(artifact.status).map((action) => (
        <Button
          key={action}
          variant={action === 'delete' ? 'danger' : 'secondary'}
          size="sm"
          disabled={disabled}
          onClick={() => onAction(action)}
        >
          {action === 'restore' && artifact.status === 'pinned' ? t.unpin : t[action]}
        </Button>
      ))}
    </div>
  );
}

function Feedback({ feedback, t, onCopy }) {
  if (!feedback) return null;
  return (
    <div
      role={feedback.type === 'error' ? 'alert' : 'status'}
      className="tools-feedback"
      style={{ color: feedback.type === 'error' ? 'var(--error)' : 'var(--text-secondary)' }}
    >
      <span>{feedback.message}</span>
      {feedback.path ? (
        <Button size="sm" variant="ghost" onClick={onCopy}>{t.copyPath}</Button>
      ) : null}
    </div>
  );
}

export function ToolsScreen({ api, lang = 'zh', port = 11488 }) {
  const t = TEXT[lang] || TEXT.zh;
  const [mode, setMode] = React.useState('tools');
  const [query, setQuery] = React.useState('');
  const [items, setItems] = React.useState([]);
  const [libraryRows, setLibraryRows] = React.useState({ candidates: [], artifacts: [] });
  const [selectedId, setSelectedId] = React.useState('');
  const [detail, setDetail] = React.useState(null);
  const [argsText, setArgsText] = React.useState('{}');
  const [result, setResult] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [feedback, setFeedback] = React.useState(null);
  const [showImport, setShowImport] = React.useState(false);
  const [importText, setImportText] = React.useState('');
  const [pane, setPane] = React.useState('content');
  const loadSequence = React.useRef(0);
  const selectSequence = React.useRef(0);
  const fileInputRef = React.useRef(null);

  const requestLibrary = React.useCallback(async (operation) => {
    const libraryApi = createToolLibraryApi({ port });
    return operation(libraryApi);
  }, [port]);

  const load = React.useCallback(async () => {
    if (!api) return;
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    setError('');
    try {
      if (mode === 'skills') {
        const payload = await api.listSkills({ includeTemplates: true });
        const needle = query.trim().toLowerCase();
        const skills = (payload.skills || []).filter((skill) => {
          const text = [skill.name, skill.description].join(' ').toLowerCase();
          return !needle || text.includes(needle);
        });
        if (sequence === loadSequence.current) setItems(skills);
        return;
      }

      const toolPromise = query.trim()
        ? api.search({ query, limit: 100 })
        : api.index({ limit: 100 });
      const [toolResult, libraryResult] = await Promise.allSettled([
        toolPromise,
        requestLibrary((libraryApi) => libraryApi.list()),
      ]);
      if (sequence !== loadSequence.current) return;
      if (toolResult.status === 'rejected') throw toolResult.reason;

      const payload = toolResult.value || {};
      const management = libraryResult.status === 'fulfilled'
        ? splitToolLibraryItems(libraryResult.value)
        : { candidates: [], artifacts: [] };
      setLibraryRows(management);
      setItems(filterToolLibraryItems(
        mergeToolLibraryItems(payload.artifacts || [], libraryResult.status === 'fulfilled' ? libraryResult.value : {}),
        query,
      ));
      if (libraryResult.status === 'rejected') {
        setFeedback({
          type: 'error',
          message: (libraryResult.reason && libraryResult.reason.message) || String(libraryResult.reason),
        });
      }
    } catch (cause) {
      if (sequence === loadSequence.current) setError(cause.message || String(cause));
    }
  }, [api, mode, query, requestLibrary]);

  React.useEffect(() => {
    const timer = setTimeout(load, 120);
    return () => clearTimeout(timer);
  }, [load]);

  React.useEffect(() => {
    if (result || error) setPane('result');
  }, [result, error]);

  const changeMode = (next) => {
    setMode(next);
    setSelectedId('');
    setDetail(null);
    setResult(null);
    setArgsText('{}');
  };

  const select = async (item) => {
    const id = itemId(mode, item);
    const sequence = selectSequence.current + 1;
    selectSequence.current = sequence;
    setSelectedId(id);
    setResult(null);
    setError('');
    setPane('content');
    try {
      const value = mode === 'skills'
        ? item
        : (await api.inspect(item.id)).artifact;
      if (sequence !== selectSequence.current) return;
      setDetail({ mode, value });
      const schema = mode === 'skills' ? value.args_schema : value.argsSchema;
      setArgsText(JSON.stringify(defaultArgs(schema), null, 2));
    } catch (cause) {
      if (sequence === selectSequence.current) setError(cause.message || String(cause));
    }
  };

  const invoke = async (action) => {
    if (!detail || busy) return;
    setBusy(true);
    setError('');
    try {
      const args = objectArgs(argsText);
      const value = detail.value;
      let output;
      if (detail.mode === 'skills') {
        output = action === 'render'
          ? await api.renderSkill(value.name, args)
          : await api.executeSkill(value.name, args);
      } else {
        output = await api.executeTool(value.id, args);
      }
      if (action === 'render') await copyText(output.rendered || '');
      setResult(output);
    } catch (cause) {
      setError(cause instanceof SyntaxError ? t.invalidArgs : cause.message || String(cause));
    } finally {
      setPane('result');
      setBusy(false);
    }
  };

  const runLibraryAction = async (action) => {
    const artifact = detail && detail.mode === 'tools' ? detail.value : null;
    if (!artifact || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await requestLibrary((libraryApi) => executeToolLibraryAction(libraryApi, action, artifact.id));
      if (action === 'export') {
        setFeedback({ type: 'success', message: t.exportPath + ': ' + response.path, path: response.path });
      } else {
        if (action === 'delete') {
          setSelectedId('');
          setDetail(null);
          setResult(null);
        } else if (response.artifact) {
          setDetail({ mode: 'tools', value: response.artifact });
        }
        await load();
        setFeedback({ type: 'success', message: t.completed(t[action]) });
      }
    } catch (cause) {
      setFeedback({
        type: 'error',
        message: cause.existingId ? t.duplicate(cause.existingId) : cause.message || String(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  const clearCandidates = async () => {
    if (busy || !libraryRows.candidates.length) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestLibrary((libraryApi) => libraryApi.clearCandidates());
      if (detail && detail.mode === 'tools' && detail.value.status === 'candidate') {
        setSelectedId('');
        setDetail(null);
      }
      await load();
      setFeedback({ type: 'success', message: t.cleared(result.count || 0) });
    } catch (cause) {
      setFeedback({ type: 'error', message: cause.message || String(cause) });
    } finally {
      setBusy(false);
    }
  };

  const importArtifact = async () => {
    setBusy(true);
    setError('');
    try {
      const wire = parseToolLibraryImport(importText);
      await requestLibrary((libraryApi) => libraryApi.importArtifact(wire));
      setImportText('');
      await load();
      setFeedback({ type: 'success', message: t.imported });
    } catch (cause) {
      setFeedback({
        type: 'error',
        message: cause.existingId ? t.duplicate(cause.existingId) : cause.message || String(cause),
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
    } catch (cause) {
      setFeedback({ type: 'error', message: cause.message || String(cause) });
    } finally {
      event.target.value = '';
    }
  };

  const selected = detail && detail.value;
  const selectedContent = selected && (detail.mode === 'skills'
    ? selected.template
    : selected.content);
  const canExecuteSkill = detail && detail.mode === 'skills'
    && selected.template_type === 'jsx';
  const canExecuteTool = detail && detail.mode === 'tools'
    && !['candidate', 'archived', 'deprecated'].includes(selected.status);
  const groups = mode === 'tools' ? groupToolLibraryItems(items) : [];

  return (
    <div className="tools-screen">
      <header className="tools-header">
        <div className="tools-header__title" title={t.title}>{t.title}</div>
        <div className="tools-header__actions">
          <Button size="sm" variant="ghost" onClick={load} disabled={busy}>
            {t.refresh}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setShowImport(!showImport)} disabled={busy}>
            {t.import}
          </Button>
          <Button size="sm" variant="danger" onClick={clearCandidates} disabled={busy || !libraryRows.candidates.length}>
            {t.clearCandidates}
          </Button>
        </div>
      </header>
      <div className="tools-filters">
        <Segmented
          value={mode}
          onChange={changeMode}
          options={[
            { value: 'tools', label: t.tools },
            { value: 'skills', label: t.skills },
          ]}
        />
        <Input
          value={query}
          onChange={setQuery}
          placeholder={mode === 'skills' ? t.searchSkills : t.searchTools}
        />
      </div>
      <Feedback
        feedback={feedback}
        t={t}
        onCopy={() => copyText(feedback.path).then(
          () => setFeedback({ type: 'success', message: t.copied }),
          (cause) => setFeedback({ type: 'error', message: cause.message || String(cause) }),
        )}
      />
      {error && !selected ? <div className="tools-error" role="alert">{error}</div> : null}
      {showImport ? (
        <section className="tools-import-view" aria-label={t.import}>
          <div className="tools-text-area">
            <p>{t.importHint}</p>
            <label>{t.importJson}
              <Textarea mono value={importText} onChange={setImportText} rows={4} />
            </label>
          </div>
          <div className="tools-import__actions">
            <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={chooseFile} style={{ display: 'none' }} />
            <Button size="sm" disabled={busy} onClick={() => fileInputRef.current && fileInputRef.current.click()}>{t.selectFile}</Button>
            <Button size="sm" disabled={busy || !importText.trim()} onClick={importArtifact}>{t.importJson}</Button>
            <Button size="sm" disabled={busy} onClick={() => setShowImport(false)}>{t.cancel}</Button>
          </div>
        </section>
      ) : (
        <React.Fragment>
          <select className="tools-selector ds-focusable" aria-label={t.select} value={selectedId}
            onChange={(event) => { const item = items.find((entry) => itemId(mode, entry) === event.target.value); if (item) select(item); }}>
            <option value="" disabled>{t.select}</option>
            {selectedId && !items.some((item) => itemId(mode, item) === selectedId) ? <option value={selectedId}>{selected?.name || selectedId}</option> : null}
            {items.map((item) => <option key={itemId(mode, item)} value={itemId(mode, item)}>{mode === 'tools' ? statusLabel(t, item.status) + ' · ' : ''}{item.name || item.id}</option>)}
          </select>
          <div className="tools-split">
            <section className="tools-list" aria-label={mode === 'skills' ? t.skills : t.tools}>
              {mode === 'tools' && groups.length ? groups.map((group) => (
                <React.Fragment key={group.status}>
                  <div style={{ margin: '4px 2px 2px', color: 'var(--text-tertiary)', font: '600 10px/1.35 var(--font-ui)', textTransform: 'uppercase' }}>
                    {statusLabel(t, group.status)}
                  </div>
                  {group.items.map((item) => (
                    <ItemRow
                      key={itemId(mode, item)}
                      mode={mode}
                      item={item}
                      selected={itemId(mode, item) === selectedId}
                      onSelect={select}
                      t={t}
                    />
                  ))}
                </React.Fragment>
              )) : mode === 'skills' && items.length ? items.map((item) => (
                <ItemRow
                  key={itemId(mode, item)}
                  mode={mode}
                  item={item}
                  selected={itemId(mode, item) === selectedId}
                  onSelect={select}
                  t={t}
                />
              )) : <EmptyState icon="box" title={t.empty} compact />}
            </section>
            <section className="tools-detail">
              {!selected ? (
                <EmptyState icon="box" title={t.select} caption={t.selectCap} />
              ) : (
                <React.Fragment>
                  <div className="tools-detail__heading">
                    <h2 title={selected.name}>{selected.name}</h2>
                    <Badge status={detail.mode === 'tools' ? statusBadgeStatus(selected.status) : selected.verified ? 'ok' : 'neutral'}>
                      {detail.mode === 'tools' ? statusLabel(t, selected.status) : selected.verified ? t.signed : t.prompt}
                    </Badge>
                  </div>
                  <div className="tools-detail__tabs">
                    <Segmented value={pane} onChange={setPane} options={[
                      { value: 'content', label: t.content },
                      { value: 'args', label: t.argsTab },
                      { value: 'result', label: t.result },
                    ]} />
                  </div>
                  <section className="tools-text-area" aria-label={t[pane]}>
                    {pane === 'content' ? <React.Fragment>
                      <h3>{selected.name}</h3>
                      <p>{selected.description}</p>
                      <pre className="tools-content">{selectedContent || '—'}</pre>
                    </React.Fragment> : pane === 'args' ? <label className="tools-args">{t.args}
                      <Textarea mono value={argsText} onChange={setArgsText} rows={4}
                        style={{ flex: 1, minHeight: 0, resize: 'none' }}
                        disabled={detail.mode === 'tools' && !canExecuteTool} />
                    </label> : <React.Fragment>
                      {error ? <div className="tools-result-error" role="alert">{error}</div> : null}
                      <pre className="tools-content">{result ? JSON.stringify(result, null, 2) : '—'}</pre>
                    </React.Fragment>}
                  </section>
                  <footer className="tools-detail__actions">
                    <div className="tools-runner__actions">
                      {detail.mode === 'skills' ? (
                        <Button size="sm" variant="secondary" onClick={() => invoke('render')} disabled={busy}>
                          {t.render}
                        </Button>
                      ) : null}
                      {canExecuteTool || canExecuteSkill ? (
                        <Button size="sm" variant="primary" onClick={() => invoke('execute')} disabled={busy}>
                          {t.run}
                        </Button>
                      ) : null}
                    </div>
                    {detail.mode === 'tools' ? <LibraryActionButtons artifact={selected} t={t} onAction={runLibraryAction} disabled={busy} /> : null}
                  </footer>
                </React.Fragment>
              )}
            </section>
          </div>
        </React.Fragment>
      )}
    </div>
  );
}
