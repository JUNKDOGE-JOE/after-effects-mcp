import React from 'react';
import { Badge } from '../components/core/Badge';
import { Button } from '../components/core/Button';
import { EmptyState } from '../components/shell/EmptyState';
import { Field } from '../components/forms/Field';
import { Input } from '../components/forms/Input';
import { Select } from '../components/forms/Select';
import { Textarea } from '../components/forms/Textarea';
import { ToolArtifactEditor } from '../components/tools/ToolArtifactEditor';
import { ToolArtifactRow } from '../components/tools/ToolArtifactRow';
import { chooseToolExportPath, chooseToolPackage } from '../cep/toolFileDialogs';
import { startToolPlan, waitForToolExecution } from '../cep/toolsApi';
import { copyText } from '../lib/clipboard';
import { buildToolArgs, initialToolArgs, toolArgFields } from '../lib/toolRunForm';
import {
  INITIAL_TOOLS_STATE,
  canEditArtifact,
  canPromoteArtifact,
  confirmToolAction,
  displayArtifactContent,
  emptyToolRunInputs,
  normalizeExpressionTarget,
  reduceToolsState,
  searchArgsFromState,
  toolExecutionCapabilities,
} from '../lib/toolsState';

const TEXT = {
  zh: {
    library: '工具库', new: '新建', import: '导入', export: '导出', search: '搜索工具…', allKinds: '全部类型',
    allRisk: '全部风险', allSource: '全部来源', active: '已保存 + 置顶', candidates: '候选',
    saved: '已保存', pinned: '已置顶', archived: '已归档', deprecated: '已弃用', allStatuses: '全部状态',
    category: '分类', empty: '没有匹配的工具', emptyCap: '新建工具，或导入 .aemcptools 包。',
    select: '选择一个工具', selectCap: '先从列表选择摘要，再按需读取完整内容。',
    edit: '编辑', duplicate: '副本', archive: '归档', delete: '删除', pin: '置顶', unpin: '取消置顶',
    verify: '标记已审阅', promote: '提升为已保存', copy: '复制', renderCopy: '渲染并复制', run: '运行',
    metadata: '元数据', content: '内容（不可信用户数据）', args: '参数', result: '执行结果',
    advancedJson: '高级 JSON', formView: '表单', cancelRun: '取消运行', resumeRun: '恢复状态', history: '执行历史',
    developerTools: '开发者工具', incompatible: '当前不可运行', progress: '进度',
    compId: 'Comp ID', layerId: 'Layer ID', propertyPath: '属性路径', refresh: '刷新',
    importTitle: '导入预览', importChanges: '扫描后差异', importConflict: '冲突', keep: '保留现有',
    duplicateIncoming: '导入副本', commit: '确认导入为候选', cancel: '取消', contentChanged: '内容 hash 已变化',
    confirmDelete: '永久删除这个工具？', confirmArchive: '归档这个工具？', copyName: '副本名称',
    confirmReplace: '提升候选时替换现有冲突工具？取消将保留两份。',
    invalidArgs: '参数必须是 JSON 对象。', targetRequired: '应用表达式需要 compId、layerId 和属性路径。',
    noCep: 'CEP 文件对话框不可用。', trust: '信任', signed: '签名内置', untrusted: '用户不可信',
  },
  en: {
    library: 'Tool Library', new: 'New', import: 'Import', export: 'Export', search: 'Search tools…', allKinds: 'All kinds',
    allRisk: 'All risks', allSource: 'All sources', active: 'Saved + pinned', candidates: 'Candidates',
    saved: 'Saved', pinned: 'Pinned', archived: 'Archived', deprecated: 'Deprecated', allStatuses: 'All statuses',
    category: 'Category', empty: 'No matching tools', emptyCap: 'Create a tool or import an .aemcptools package.',
    select: 'Select a tool', selectCap: 'Choose a summary first, then inspect full content on demand.',
    edit: 'Edit', duplicate: 'Duplicate', archive: 'Archive', delete: 'Delete', pin: 'Pin', unpin: 'Unpin',
    verify: 'Mark reviewed', promote: 'Promote to saved', copy: 'Copy', renderCopy: 'Render & copy', run: 'Run',
    metadata: 'Metadata', content: 'Content (untrusted user data)', args: 'Arguments', result: 'Execution result',
    advancedJson: 'Advanced JSON', formView: 'Form', cancelRun: 'Cancel run', resumeRun: 'Resume status', history: 'Execution history',
    developerTools: 'Developer Tools', incompatible: 'Unavailable', progress: 'Progress',
    compId: 'Comp ID', layerId: 'Layer ID', propertyPath: 'Property path', refresh: 'Refresh',
    importTitle: 'Import preview', importChanges: 'Post-scan changes', importConflict: 'Conflict', keep: 'Keep existing',
    duplicateIncoming: 'Import duplicate', commit: 'Import as candidates', cancel: 'Cancel', contentChanged: 'Content hash changed',
    confirmDelete: 'Permanently delete this tool?', confirmArchive: 'Archive this tool?', copyName: 'Duplicate name',
    confirmReplace: 'Replace the existing conflicting tool while promoting? Cancel keeps both copies.',
    invalidArgs: 'Arguments must be a JSON object.', targetRequired: 'Expression apply requires compId, layerId, and property path.',
    noCep: 'CEP file dialogs are unavailable.', trust: 'Trust', signed: 'Signed bundled', untrusted: 'User untrusted',
  },
};

const KIND_OPTIONS = ['', 'jsx', 'expression', 'prompt-skill', 'recipe', 'diagnostic', 'system-command'];
const RISK_OPTIONS = ['', 'read', 'write', 'destructive', 'external'];
const SOURCE_OPTIONS = ['', 'user', 'legacy', 'bundled', 'imported', 'chat-tool-call'];

function artifactSource(artifact) {
  return artifact && (artifact.sourceType || artifact.source && artifact.source.type) || '';
}

function asObject(text) {
  const value = JSON.parse(text || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('object required');
  return value;
}

function confirmPanel(message) {
  const confirmImpl = typeof globalThis.confirm === 'function'
    ? (value) => globalThis.confirm(value)
    : null;
  return confirmToolAction(confirmImpl, message);
}

function promptPanel(message, fallback) {
  return typeof globalThis.prompt === 'function' ? globalThis.prompt(message, fallback) : fallback;
}

function ImportPreview({ preview, resolutions, lang, busy, onResolve, onCommit, onCancel }) {
  const t = TEXT[lang] || TEXT.zh;
  const conflicts = preview.conflicts || [];
  const complete = conflicts.every((conflict) => ['keep', 'duplicate'].includes(resolutions[conflict.conflictId]));
  return (
    <div className="tools-modal" role="presentation">
      <div className="tools-modal__scrim" />
      <div className="tools-import" role="dialog" aria-label={t.importTitle}>
        <div className="tools-import__heading">
          <span>{t.importTitle}</span>
          <Badge status={preview.highestRisk === 'external' || preview.highestRisk === 'destructive' ? 'error' : 'warn'}>{preview.highestRisk}</Badge>
        </div>
        <div className="tools-import__body">
          {(preview.artifacts || []).map((item, index) => (
            <div className="tools-import__item" key={`${item.summary && item.summary.id || 'artifact'}:${index}`}>
              <strong>{item.summary && item.summary.name}</strong>
              <span>{item.summary && item.summary.kind} · {item.calculatedRisk}</span>
              {item.contentChanged ? <Badge status="warn">{t.contentChanged}</Badge> : null}
              {item.metadataChanges && Object.keys(item.metadataChanges).length ? (
                <details>
                  <summary>{t.importChanges}</summary>
                  <pre>{JSON.stringify(item.metadataChanges, null, 2)}</pre>
                </details>
              ) : null}
            </div>
          ))}
          {conflicts.map((conflict) => (
            <div className="tools-import__conflict" key={conflict.conflictId}>
              <div><strong>{t.importConflict}</strong> · {conflict.incomingName}</div>
              <div className="tools-import__hashes">
                <span>{conflict.existingContentHash}</span>
                <span>{conflict.incomingContentHash}</span>
              </div>
              <Select
                value={resolutions[conflict.conflictId] || ''}
                onChange={(value) => onResolve(conflict.conflictId, value)}
                options={[
                  { value: '', label: '—' },
                  { value: 'keep', label: t.keep },
                  { value: 'duplicate', label: t.duplicateIncoming },
                ]}
              />
            </div>
          ))}
        </div>
        <div className="tools-import__actions">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>{t.cancel}</Button>
          <Button variant="primary" onClick={onCommit} disabled={busy || !complete}>{t.commit}</Button>
        </div>
      </div>
    </div>
  );
}

export function ToolsScreen({
  api,
  lang = 'zh',
  cepFs = globalThis.window && globalThis.window.cep && globalThis.window.cep.fs,
  initialPath = '',
}) {
  const t = TEXT[lang] || TEXT.zh;
  const [state, dispatch] = React.useReducer(reduceToolsState, INITIAL_TOOLS_STATE);
  const [busy, setBusy] = React.useState(false);
  const initialRunInputs = React.useMemo(() => emptyToolRunInputs(), []);
  const [runArgs, setRunArgs] = React.useState(initialRunInputs.args);
  const [runForm, setRunForm] = React.useState({});
  const [advancedJson, setAdvancedJson] = React.useState(false);
  const [target, setTarget] = React.useState(initialRunInputs.target);
  const [runResult, setRunResult] = React.useState(null);
  const [runJob, setRunJob] = React.useState(null);
  const [runHistory, setRunHistory] = React.useState([]);
  const [developerMode, setDeveloperMode] = React.useState(false);
  const loadSequence = React.useRef(0);
  const inspectSequence = React.useRef(0);
  const rowRunLock = React.useRef(false);
  const selectedSummary = state.summaries.find((row) => row.id === state.selectedId) || null;
  const artifact = state.inspected && state.inspected.artifact || null;
  const runPending = Boolean(runJob && !runJob.terminal);

  const load = React.useCallback(async () => {
    if (!api) return;
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    dispatch({ type: 'load-start' });
    try {
      const needsSearch = Boolean(
        state.query || state.category || state.risk || (state.kinds && state.kinds.length),
      );
      const payload = needsSearch
        ? await (developerMode ? api.developerSearch : api.search)(searchArgsFromState(state))
        : await (developerMode ? api.developerIndex : api.index)({
          statuses: state.statuses,
          source_types: state.sourceType ? [state.sourceType] : undefined,
          include_candidates: state.statuses.includes('candidate'),
          limit: 100,
        });
      if (sequence === loadSequence.current) dispatch({ type: 'load-success', payload });
    } catch (error) {
      if (sequence === loadSequence.current) dispatch({ type: 'load-error', error });
    }
  }, [api, state.query, state.kinds, state.category, state.risk, state.statuses, state.sourceType, developerMode]);

  React.useEffect(() => {
    const timer = setTimeout(load, 120);
    return () => clearTimeout(timer);
  }, [load]);

  const inspect = async (id) => {
    const sequence = inspectSequence.current + 1;
    inspectSequence.current = sequence;
    const freshInputs = emptyToolRunInputs();
    setRunArgs(freshInputs.args);
    setRunForm({});
    setAdvancedJson(false);
    setTarget(freshInputs.target);
    dispatch({ type: 'select', id });
    setRunResult(null);
    try {
      const payload = await (developerMode ? api.developerInspect(id) : api.inspect(id));
      if (sequence === inspectSequence.current) {
        dispatch({ type: 'inspect-success', payload });
        const defaults = initialToolArgs(payload.artifact && payload.artifact.argsSchema);
        setRunForm(defaults);
        let initialJson = {};
        try {
          initialJson = buildToolArgs(payload.artifact && payload.artifact.argsSchema, defaults);
        } catch {
          initialJson = Object.fromEntries(
            Object.entries(defaults).filter(([, value]) => value !== ''),
          );
        }
        setRunArgs(JSON.stringify(initialJson, null, 2));
        const history = await api.use({ action: 'history', artifact_id: id, limit: 20 });
        setRunHistory(history.executions || []);
      }
      return payload;
    } catch (error) {
      if (sequence === inspectSequence.current) dispatch({ type: 'load-error', error });
    }
  };

  const refreshAndInspect = async (id) => {
    await load();
    if (id) await inspect(id);
  };

  const saveEditor = async (input) => {
    setBusy(true);
    try {
      const result = state.editor && state.editor.mode === 'create'
        ? await api.create(input)
        : await api.edit(input);
      dispatch({ type: 'save-success', payload: result, artifact: result.artifact });
      await refreshAndInspect(result.artifact && result.artifact.id);
    } catch (error) {
      dispatch({ type: 'load-error', error });
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (request, id = artifact && artifact.id) => {
    setBusy(true);
    try {
      const result = await request();
      if (result && result.artifact) dispatch({ type: 'save-success', artifact: result.artifact });
      await refreshAndInspect(result && result.artifact ? result.artifact.id : id);
      return result;
    } catch (error) {
      dispatch({ type: 'load-error', error });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const duplicate = () => {
    if (!artifact) return;
    const name = promptPanel(t.copyName, `${artifact.name} Copy`);
    if (!name || !name.trim()) return;
    mutate(() => api.duplicate({
      artifact_id: artifact.id,
      name: name.trim(),
      expected_revision: artifact.revision,
      expected_content_hash: artifact.contentHash,
    }));
  };

  const archive = () => {
    if (!artifact || !confirmPanel(t.confirmArchive)) return;
    mutate(() => api.archive({
      artifact_id: artifact.id,
      expected_revision: artifact.revision,
      expected_content_hash: artifact.contentHash,
    }));
  };

  const remove = async () => {
    if (!artifact || !confirmPanel(t.confirmDelete)) return;
    setBusy(true);
    try {
      await api.delete({
        artifact_id: artifact.id,
        expected_revision: artifact.revision,
        expected_content_hash: artifact.contentHash,
      });
      dispatch({ type: 'delete-success', id: artifact.id });
      await load();
    } catch (error) {
      dispatch({ type: 'load-error', error });
    } finally {
      setBusy(false);
    }
  };

  const editStatus = (status) => mutate(() => api.edit({
    artifact_id: artifact.id,
    changes: { status },
    expected_revision: artifact.revision,
    expected_content_hash: artifact.contentHash,
  }));

  const verify = () => mutate(() => api.edit({
    artifact_id: artifact.id,
    changes: { verification_action: 'mark-reviewed' },
    expected_revision: artifact.revision,
    expected_content_hash: artifact.contentHash,
  }));

  const promote = () => {
    const input = {
      artifact_id: artifact.id,
      expected_revision: artifact.revision,
      expected_content_hash: artifact.contentHash,
    };
    if (artifactSource(artifact) === 'chat-tool-call') {
      return mutate(() => api.promoteFromHistory(input));
    }
    const originalId = artifact.source && artifact.source.provenance
      && artifact.source.provenance.originalArtifactId;
    const replacement = typeof originalId === 'string'
      && originalId.startsWith('user:')
      && originalId !== artifact.id
      && state.summaries.some((row) => row.id === originalId && row.sourceType !== 'bundled')
      && confirmPanel(t.confirmReplace)
      ? originalId
      : null;
    return mutate(() => api.edit({
      ...input,
      changes: { status: 'saved' },
      ...(replacement ? { replace_artifact_id: replacement } : {}),
    }));
  };

  const renderAndCopy = async () => {
    if (!artifact) return;
    setBusy(true);
    try {
      const args = asObject(runArgs);
      const result = await api.use({ artifact_id: artifact.id, action: 'render', args });
      const content = result.rendered || result.untrustedContext && result.untrustedContext.content || '';
      await copyText(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
      setRunResult(result);
    } catch (error) {
      dispatch({ type: 'load-error', error: error instanceof SyntaxError ? new Error(t.invalidArgs) : error });
    } finally {
      setBusy(false);
    }
  };

  const executeArtifact = async (artifactToRun, args, normalizedTarget = {}) => {
    if (runPending) return;
    const capability = toolExecutionCapabilities(artifactToRun);
    const operation = capability.operation;
    if (!capability.directRun || !operation) return;
    setBusy(true);
    setRunResult(null);
    setRunJob(null);
    try {
      const started = await startToolPlan(api, {
        artifactId: artifactToRun.id,
        operation,
        args,
        target: normalizedTarget,
      });
      const completed = await waitForToolExecution(api, started, {
        onProgress: setRunJob,
      });
      await refreshAndInspect(artifactToRun.id);
      setRunJob(completed);
      setRunResult(completed);
    } catch (error) {
      if (error && error.execution) setRunJob(error.execution);
      dispatch({ type: 'load-error', error });
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!artifact || runPending) return;
    let args;
    try {
      args = advancedJson
        ? asObject(runArgs)
        : buildToolArgs(artifact.argsSchema, runForm);
    } catch (error) {
      dispatch({ type: 'load-error', error: new Error(t.invalidArgs) });
      return;
    }
    const capability = toolExecutionCapabilities(artifact);
    let normalizedTarget = {};
    if (capability.operation === 'apply') {
      try {
        normalizedTarget = normalizeExpressionTarget(target);
      } catch {
        dispatch({ type: 'load-error', error: new Error(t.targetRequired) });
        return;
      }
    }
    await executeArtifact(artifact, args, normalizedTarget);
  };

  const inspectForRun = async (row) => {
    if (busy || runPending || rowRunLock.current || !row) return;
    rowRunLock.current = true;
    try {
      const payload = await inspect(row.id);
      const inspectedArtifact = payload && payload.artifact;
      const capability = toolExecutionCapabilities(inspectedArtifact);
      if (!capability.directRun || capability.requiresTarget) return;
      const defaults = initialToolArgs(inspectedArtifact.argsSchema);
      try {
        const args = buildToolArgs(inspectedArtifact.argsSchema, defaults);
        await executeArtifact(inspectedArtifact, args);
      } catch {
        // Required values without defaults belong in the detail form. Selecting
        // the row above has already opened that deterministic input surface.
      }
    } finally {
      rowRunLock.current = false;
    }
  };

  const cancelExecution = async () => {
    if (!runJob || runJob.terminal) return;
    try {
      const next = await api.use({ action: 'cancel', execution_id: runJob.executionId });
      setRunJob(next);
    } catch (error) {
      dispatch({ type: 'load-error', error });
    }
  };

  const resumeExecution = async () => {
    if (!runJob || runJob.terminal) return;
    setBusy(true);
    try {
      const completed = await waitForToolExecution(api, runJob, {
        onProgress: setRunJob,
      });
      await refreshAndInspect(completed.artifactId);
      setRunJob(completed);
      setRunResult(completed);
    } catch (error) {
      if (error && error.execution) setRunJob(error.execution);
      dispatch({ type: 'load-error', error });
    } finally {
      setBusy(false);
    }
  };

  const previewImport = async () => {
    if (!cepFs) {
      dispatch({ type: 'load-error', error: new Error(t.noCep) });
      return;
    }
    try {
      const path = chooseToolPackage(cepFs, { title: t.importTitle, initialPath });
      if (!path) return;
      setBusy(true);
      const preview = await api.previewImport(path);
      dispatch({ type: 'import-preview', preview });
    } catch (error) {
      dispatch({ type: 'load-error', error });
    } finally {
      setBusy(false);
    }
  };

  const cancelImport = async () => {
    try {
      if (state.importPreview) await api.discardImport(state.importPreview.importId);
    } catch (error) {
      dispatch({ type: 'load-error', error });
    } finally {
      dispatch({ type: 'import-finished' });
    }
  };

  const commitImport = async () => {
    if (!state.importPreview) return;
    setBusy(true);
    try {
      await api.commitImport(state.importPreview.importId, state.conflictResolutions);
      dispatch({ type: 'import-finished' });
      dispatch({ type: 'set-filter', key: 'statuses', value: ['candidate', 'saved', 'pinned'] });
      const payload = await (developerMode ? api.developerIndex : api.index)({
        statuses: ['candidate', 'saved', 'pinned'], include_candidates: true,
        limit: 100,
      });
      dispatch({ type: 'load-success', payload });
    } catch (error) {
      dispatch({ type: 'load-error', error });
    } finally {
      setBusy(false);
    }
  };

  const exportPackage = async () => {
    if (!cepFs) {
      dispatch({ type: 'load-error', error: new Error(t.noCep) });
      return;
    }
    try {
      const path = chooseToolExportPath(cepFs, { title: t.export, initialPath });
      if (!path) return;
      const ids = state.selectedId ? [state.selectedId] : state.summaries.map((row) => row.id);
      if (!ids.length) return;
      setBusy(true);
      await api.exportPackage(ids, path);
    } catch (error) {
      dispatch({ type: 'load-error', error });
    } finally {
      setBusy(false);
    }
  };

  const statusValue = state.statuses.join(',');
  const source = artifactSource(artifact);
  const editable = canEditArtifact(artifact);
  const execution = toolExecutionCapabilities(artifact);
  const executable = execution.render || execution.directRun;
  const argFields = toolArgFields(artifact && artifact.argsSchema);

  return (
    <div className="tools-screen">
      <header className="tools-header">
        <div className="tools-header__title">{t.library}</div>
        <div className="tools-header__actions">
          <Button size="sm" variant="primary" icon="plus" onClick={() => dispatch({ type: 'edit-start', editor: { mode: 'create', artifact: null } })}>{t.new}</Button>
          <Button size="sm" variant="secondary" icon="download" onClick={previewImport} disabled={busy}>{t.import}</Button>
          <Button size="sm" variant="secondary" icon="external-link" onClick={exportPackage} disabled={busy || !state.summaries.length}>{t.export}</Button>
          {runPending ? <Button size="sm" variant="secondary" onClick={resumeExecution} disabled={busy}>{t.resumeRun}</Button> : null}
          {runPending ? <Button size="sm" variant="danger" onClick={cancelExecution} disabled={busy}>{t.cancelRun}</Button> : null}
          <Button size="sm" variant={developerMode ? 'danger' : 'ghost'} onClick={() => setDeveloperMode((value) => !value)} disabled={busy}>{t.developerTools}</Button>
        </div>
      </header>

      <div className="tools-filters">
        <Input value={state.query} onChange={(value) => dispatch({ type: 'set-query', value })} placeholder={t.search} />
        <Select value={state.kinds[0] || ''} onChange={(value) => dispatch({ type: 'set-filter', key: 'kinds', value: value ? [value] : [] })} options={KIND_OPTIONS.filter((value) => developerMode || value !== 'system-command').map((value) => ({ value, label: value || t.allKinds }))} />
        <Input value={state.category} onChange={(value) => dispatch({ type: 'set-filter', key: 'category', value })} placeholder={t.category} />
        <Select value={state.risk} onChange={(value) => dispatch({ type: 'set-filter', key: 'risk', value })} options={RISK_OPTIONS.map((value) => ({ value, label: value || t.allRisk }))} />
        <Select value={statusValue} onChange={(value) => dispatch({ type: 'set-filter', key: 'statuses', value: value.split(',').filter(Boolean) })} options={[
          { value: 'saved,pinned', label: t.active },
          { value: 'candidate', label: t.candidates },
          { value: 'saved', label: t.saved },
          { value: 'pinned', label: t.pinned },
          { value: 'archived', label: t.archived },
          { value: 'deprecated', label: t.deprecated },
          { value: 'candidate,saved,pinned,archived,deprecated', label: t.allStatuses },
        ]} />
        <Select value={state.sourceType} onChange={(value) => dispatch({ type: 'set-filter', key: 'sourceType', value })} options={SOURCE_OPTIONS.map((value) => ({ value, label: value || t.allSource }))} />
      </div>

      {state.error ? (
        <div className="tools-error" role="alert">
          <span>{state.error}</span>
          {state.refreshRequired ? <Button size="sm" variant="ghost" onClick={load}>{t.refresh}</Button> : null}
          <button type="button" aria-label="Dismiss" onClick={() => dispatch({ type: 'clear-error' })}>×</button>
        </div>
      ) : null}

      <div className="tools-split">
        <section className="tools-list" aria-label="Tool summaries">
          {state.summaries.length ? state.summaries.map((row) => (
            <ToolArtifactRow
              key={row.id}
              artifact={row}
              selected={row.id === state.selectedId}
              onSelect={inspect}
              onRun={inspectForRun}
              runDisabled={busy || runPending}
              lang={lang}
            />
          )) : (
            <EmptyState icon="box" title={t.empty} caption={t.emptyCap} compact />
          )}
        </section>

        <section className="tools-detail">
          {!selectedSummary ? (
            <EmptyState icon="box" title={t.select} caption={t.selectCap} />
          ) : !artifact ? (
            <EmptyState icon="rotate-cw" title={state.phase === 'error' ? state.error : t.select} compact />
          ) : (
            <React.Fragment>
              <div className="tools-detail__heading">
                <div>
                  <h2>{artifact.name}</h2>
                  <p>{artifact.description}</p>
                </div>
                <Badge status={state.inspected.trust === 'signed-bundled' ? 'ok' : 'warn'}>
                  {state.inspected.trust === 'signed-bundled' ? t.signed : t.untrusted}
                </Badge>
              </div>
              <div className="tools-detail__actions">
                {editable ? <Button size="sm" variant="secondary" onClick={() => dispatch({ type: 'edit-start', editor: { mode: 'edit', artifact } })}>{t.edit}</Button> : null}
                <Button size="sm" variant="secondary" onClick={duplicate} disabled={busy}>{t.duplicate}</Button>
                {editable && ['saved', 'pinned'].includes(artifact.status) ? (
                  <Button size="sm" variant="secondary" onClick={() => editStatus(artifact.status === 'pinned' ? 'saved' : 'pinned')} disabled={busy}>{artifact.status === 'pinned' ? t.unpin : t.pin}</Button>
                ) : null}
                {editable && !artifact.verified && ['saved', 'pinned'].includes(artifact.status) ? <Button size="sm" variant="secondary" onClick={verify} disabled={busy}>{t.verify}</Button> : null}
                {canPromoteArtifact(artifact) ? <Button size="sm" variant="accent" onClick={promote} disabled={busy}>{t.promote}</Button> : null}
                {editable && !['archived', 'deprecated'].includes(artifact.status) ? <Button size="sm" variant="ghost" onClick={archive} disabled={busy}>{t.archive}</Button> : null}
                {source !== 'bundled' ? <Button size="sm" variant="danger" onClick={remove} disabled={busy}>{t.delete}</Button> : null}
                <Button size="sm" variant="ghost" icon="copy" onClick={() => copyText(displayArtifactContent(artifact))}>{t.copy}</Button>
              </div>

              <section className="tools-detail__section">
                <h3>{t.metadata}</h3>
                <dl className="tools-kv">
                  <dt>ID</dt><dd>{artifact.id}</dd>
                  <dt>Kind</dt><dd>{artifact.kind}</dd>
                  <dt>Category</dt><dd>{artifact.category}</dd>
                  <dt>Risk</dt><dd>{artifact.declaredRisk}</dd>
                  <dt>Status</dt><dd>{artifact.status}</dd>
                  <dt>Source</dt><dd>{source}</dd>
                  <dt>Runtime</dt><dd>{execution.runtime || '—'}</dd>
                  <dt>Hash</dt><dd>{artifact.contentHash}</dd>
                </dl>
              </section>
              <section className="tools-detail__section">
                <h3>{t.content}</h3>
                <pre className="tools-content">{displayArtifactContent(artifact)}</pre>
              </section>
              {executable ? (
                <section className="tools-detail__section tools-runner">
                  <h3>{t.args}</h3>
                  <div className="tools-runner__actions">
                    <Button size="sm" variant="ghost" onClick={() => setAdvancedJson((value) => !value)} disabled={busy}>
                      {advancedJson ? t.formView : t.advancedJson}
                    </Button>
                  </div>
                  {advancedJson ? (
                    <Textarea mono value={runArgs} onChange={setRunArgs} rows={4} />
                  ) : (
                    <div className="tools-runner__form">
                      {argFields.length ? argFields.map((field) => (
                        <Field key={field.name} label={`${field.name}${field.required ? ' *' : ''}`}>
                          {field.type === 'boolean' ? (
                            <Select
                              value={String(Boolean(runForm[field.name]))}
                              onChange={(value) => setRunForm((current) => ({ ...current, [field.name]: value === 'true' }))}
                              options={[{ value: 'false', label: 'false' }, { value: 'true', label: 'true' }]}
                            />
                          ) : field.enum ? (
                            <Select
                              value={runForm[field.name] === '' ? '' : JSON.stringify(runForm[field.name])}
                              onChange={(value) => setRunForm((current) => ({ ...current, [field.name]: JSON.parse(value) }))}
                              options={[
                                ...(!field.required ? [{ value: '', label: '—' }] : []),
                                ...field.enum.map((value) => ({ value: JSON.stringify(value), label: String(value) })),
                              ]}
                            />
                          ) : (
                            <Input
                              value={runForm[field.name] ?? ''}
                              type={['number', 'integer'].includes(field.type) ? 'number' : 'text'}
                              disabled={!field.supported}
                              onChange={(value) => setRunForm((current) => ({ ...current, [field.name]: value }))}
                            />
                          )}
                        </Field>
                      )) : <span>{'{}'}</span>}
                    </div>
                  )}
                  {artifact.kind === 'expression' ? (
                    <div className="tools-runner__target">
                      <Field label={t.compId}><Input value={target.compId} onChange={(value) => setTarget((current) => ({ ...current, compId: value }))} /></Field>
                      <Field label={t.layerId}><Input value={target.layerId} onChange={(value) => setTarget((current) => ({ ...current, layerId: value }))} /></Field>
                      <Field label={t.propertyPath}><Input value={target.path} onChange={(value) => setTarget((current) => ({ ...current, path: value }))} /></Field>
                    </div>
                  ) : null}
                  <div className="tools-runner__actions">
                    {execution.render ? <Button variant="secondary" onClick={renderAndCopy} disabled={busy}>{t.renderCopy}</Button> : null}
                    {execution.directRun ? <Button variant="primary" onClick={execute} disabled={busy || runPending}>{t.run}</Button> : null}
                  </div>
                  {runJob ? <div>{t.progress}: {runJob.progress}% · {runJob.status}</div> : null}
                  {runResult ? (
                    <React.Fragment>
                      <h3>{t.result}</h3>
                      <pre className="tools-content">{JSON.stringify(runResult, null, 2)}</pre>
                    </React.Fragment>
                  ) : null}
                  {runHistory.length ? (
                    <React.Fragment>
                      <h3>{t.history}</h3>
                      <pre className="tools-content">{JSON.stringify(runHistory, null, 2)}</pre>
                    </React.Fragment>
                  ) : null}
                </section>
              ) : execution.disabledReason ? (
                <section className="tools-detail__section">
                  <h3>{t.incompatible}</h3>
                  <p>{execution.disabledReason.message}</p>
                </section>
              ) : null}
            </React.Fragment>
          )}
        </section>
      </div>

      {state.editor ? (
        <div className="tools-modal" role="presentation">
          <div className="tools-modal__scrim" onClick={() => !busy && dispatch({ type: 'edit-cancel' })} />
          <ToolArtifactEditor
            artifact={state.editor.artifact}
            lang={lang}
            busy={busy}
            onSave={saveEditor}
            onCancel={() => dispatch({ type: 'edit-cancel' })}
          />
        </div>
      ) : null}
      {state.importPreview ? (
        <ImportPreview
          preview={state.importPreview}
          resolutions={state.conflictResolutions}
          lang={lang}
          busy={busy}
          onResolve={(conflictId, resolution) => dispatch({ type: 'import-resolution', conflictId, resolution })}
          onCommit={commitImport}
          onCancel={cancelImport}
        />
      ) : null}
    </div>
  );
}
