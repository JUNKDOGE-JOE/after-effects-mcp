import React from 'react';
import { Button } from '../core/Button';
import { Field } from '../forms/Field';
import { Input } from '../forms/Input';
import { Select } from '../forms/Select';
import { Textarea } from '../forms/Textarea';
import { buildArtifactEditChanges, displayArtifactContent } from '../../lib/toolsState';

const COPY = {
  zh: {
    titleNew: '新建工具', titleEdit: '编辑工具', name: '名称', description: '说明',
    kind: '类型', category: '分类', tags: '标签', risk: '声明风险', content: '内容',
    args: '参数 Schema（JSON）', save: '保存', cancel: '取消', invalidJson: 'JSON 格式无效',
    legacyName: 'Legacy 工具名称为只读',
    legacySplit: 'Legacy 工具的技能内容字段与元数据字段需要分两次保存。',
    noChanges: '没有需要保存的更改。',
  },
  en: {
    titleNew: 'New tool', titleEdit: 'Edit tool', name: 'Name', description: 'Description',
    kind: 'Kind', category: 'Category', tags: 'Tags', risk: 'Declared risk', content: 'Content',
    args: 'Argument schema (JSON)', save: 'Save', cancel: 'Cancel', invalidJson: 'Invalid JSON',
    legacyName: 'Legacy tool names are read-only',
    legacySplit: 'Save legacy skill fields and metadata fields in two separate operations.',
    noChanges: 'There are no changes to save.',
  },
};

const KIND_OPTIONS = ['jsx', 'expression', 'prompt-skill', 'recipe', 'diagnostic']
  .map((value) => ({ value, label: value }));
const RISK_OPTIONS = ['read', 'write', 'destructive', 'external']
  .map((value) => ({ value, label: value }));

function initialDraft(artifact) {
  return {
    name: artifact && artifact.name || '',
    description: artifact && artifact.description || '',
    kind: artifact && artifact.kind || 'jsx',
    category: artifact && artifact.category || 'workflow',
    tags: artifact && Array.isArray(artifact.tags) ? artifact.tags.join(', ') : '',
    declaredRisk: artifact && artifact.declaredRisk || 'write',
    content: artifact ? displayArtifactContent(artifact) : '',
    argsSchema: JSON.stringify(artifact && artifact.argsSchema || {}, null, 2),
  };
}

function parseObject(text) {
  const parsed = JSON.parse(text || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('object required');
  return parsed;
}

export function ToolArtifactEditor({
  artifact = null,
  lang = 'zh',
  busy = false,
  onSave,
  onCancel,
}) {
  const t = COPY[lang] || COPY.zh;
  const isLegacy = Boolean(
    artifact && (artifact.sourceType || artifact.source && artifact.source.type) === 'legacy',
  );
  const [draft, setDraft] = React.useState(() => initialDraft(artifact));
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    setDraft(initialDraft(artifact));
    setError('');
  }, [artifact]);

  const update = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    let argsSchema;
    let content = draft.content;
    try {
      argsSchema = parseObject(draft.argsSchema);
      if (draft.kind === 'recipe' || draft.kind === 'diagnostic') content = parseObject(draft.content);
    } catch {
      setError(t.invalidJson);
      return;
    }
    const editable = {
      name: draft.name.trim(),
      description: draft.description,
      kind: draft.kind,
      category: draft.category.trim() || 'workflow',
      tags: draft.tags.split(',').map((value) => value.trim()).filter(Boolean),
      declared_risk: draft.declaredRisk,
      content,
      args_schema: argsSchema,
    };
    if (!editable.name) {
      setError(t.name);
      return;
    }
    setError('');
    if (artifact) {
      let changes;
      try {
        changes = buildArtifactEditChanges(artifact, editable);
      } catch (editError) {
        if (editError && editError.code === 'tool_legacy_transaction_required') {
          setError(t.legacySplit);
          return;
        }
        throw editError;
      }
      if (!Object.keys(changes).length) {
        setError(t.noChanges);
        return;
      }
      await onSave({
        artifact_id: artifact.id,
        changes,
        expected_revision: artifact.revision,
        expected_content_hash: artifact.contentHash,
      });
    } else {
      await onSave({ ...editable, status: 'saved' });
    }
  };

  return (
    <div className="tools-editor" role="dialog" aria-label={artifact ? t.titleEdit : t.titleNew}>
      <div className="tools-editor__title">{artifact ? t.titleEdit : t.titleNew}</div>
      <div className="tools-editor__grid">
        <Field label={t.name} caption={isLegacy ? t.legacyName : ''}>
          <Input
            value={draft.name}
            onChange={(value) => update('name', value)}
            disabled={isLegacy}
          />
        </Field>
        <Field label={t.category}><Input value={draft.category} onChange={(value) => update('category', value)} /></Field>
        <Field label={t.kind}><Select value={draft.kind} onChange={(value) => update('kind', value)} options={KIND_OPTIONS} /></Field>
        <Field label={t.risk}><Select value={draft.declaredRisk} onChange={(value) => update('declaredRisk', value)} options={RISK_OPTIONS} /></Field>
      </div>
      <Field label={t.description}><Textarea value={draft.description} onChange={(value) => update('description', value)} rows={2} /></Field>
      <Field label={t.tags}><Input value={draft.tags} onChange={(value) => update('tags', value)} placeholder="animation, utility" /></Field>
      <Field label={t.content}><Textarea mono value={draft.content} onChange={(value) => update('content', value)} rows={9} /></Field>
      <Field label={t.args}><Textarea mono value={draft.argsSchema} onChange={(value) => update('argsSchema', value)} rows={6} error={Boolean(error)} /></Field>
      {error ? <div className="tools-inline-error" role="alert">{error}</div> : null}
      <div className="tools-editor__actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>{t.cancel}</Button>
        <Button variant="primary" onClick={save} disabled={busy || !draft.name.trim()}>{t.save}</Button>
      </div>
    </div>
  );
}
