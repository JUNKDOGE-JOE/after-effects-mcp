import React from 'react';
import { Badge } from '../core/Badge';
import { Button } from '../core/Button';
import { Input } from '../forms/Input';
import { Select } from '../forms/Select';
import { Field } from '../forms/Field';
import { emptyDraft, draftFromEntry, validateDraft, draftToEntry } from '../../lib/providerManagerState';

const L = {
  zh: { title: 'Provider 管理', add: '新增', edit: '编辑', del: '删除', probe: '探测模型', probing: '探测中…', save: '保存', cancel: '取消', name: '名称', protocol: '协议', baseUrl: 'Base URL', apiKey: 'API Key', keyCap: '仅保存在本机 ~/.ae-mcp/providers.json', models: (n) => `${n} 个模型`, probeFailed: '探测失败（可手填模型 ID 继续使用）：', importCc: '从 cc-switch 导入' },
  en: { title: 'Provider manager', add: 'Add', edit: 'Edit', del: 'Delete', probe: 'Probe models', probing: 'Probing…', save: 'Save', cancel: 'Cancel', name: 'Name', protocol: 'Protocol', baseUrl: 'Base URL', apiKey: 'API Key', keyCap: 'Stored locally in ~/.ae-mcp/providers.json', models: (n) => `${n} models`, probeFailed: 'Probe failed (manual model id still works): ', importCc: 'Import from cc-switch' },
};

export function ProviderManagerSection({ lang = 'zh', providers = [], onUpsert, onRemove, onProbe, probing = '', probeErrors = {}, ccSwitch = null, onImportCcSwitch }) {
  const t = L[lang] || L.zh;
  const [draft, setDraft] = React.useState(null);
  const [error, setError] = React.useState('');
  const save = () => {
    const message = validateDraft(draft);
    if (message) { setError(message); return; }
    onUpsert(draftToEntry(draft));
    setDraft(null);
    setError('');
  };
  return (
    <details style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', padding: '7px 8px' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{t.title}</span>
        <Button variant="secondary" size="sm" icon="plus" onClick={(e) => { e.preventDefault(); setDraft(emptyDraft()); }}>{t.add}</Button>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {ccSwitch && onImportCcSwitch ? (
          <Button variant="secondary" size="sm" icon="download" onClick={onImportCcSwitch}>{t.importCc}</Button>
        ) : null}
        {providers.map((p) => (
          <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0, font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
              <Badge status="neutral">{p.protocol}</Badge>
              {p.probedModels.length ? <Badge status="ok">{t.models(p.probedModels.length)}</Badge> : null}
              <Button variant="ghost" size="sm" disabled={probing === p.id} onClick={() => onProbe(p)}>{probing === p.id ? t.probing : t.probe}</Button>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(draftFromEntry(p)); setError(''); }}>{t.edit}</Button>
              <Button variant="ghost" size="sm" onClick={() => onRemove(p.id)}>{t.del}</Button>
            </div>
            <div style={{ font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.baseUrl}</div>
            {probeErrors[p.id] ? <div style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--warn)' }}>{t.probeFailed}{probeErrors[p.id]}</div> : null}
          </div>
        ))}
        {draft ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)' }}>
            <Field label={t.name}><Input value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} /></Field>
            <Field label={t.protocol}>
              <Select value={draft.protocol} onChange={(v) => setDraft({ ...draft, protocol: v })} options={[
                { value: 'openai-compatible', label: 'OpenAI compatible' },
                { value: 'anthropic', label: 'Anthropic' },
              ]} />
            </Field>
            <Field label={t.baseUrl}><Input mono value={draft.baseUrl} onChange={(v) => setDraft({ ...draft, baseUrl: v })} placeholder="https://api.example.com/v1" /></Field>
            <Field label={t.apiKey} caption={t.keyCap}><Input secret value={draft.apiKey} onChange={(v) => setDraft({ ...draft, apiKey: v })} /></Field>
            {error ? <div style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--warn)' }}>{error}</div> : null}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setError(''); }}>{t.cancel}</Button>
              <Button variant="primary" size="sm" onClick={save}>{t.save}</Button>
            </div>
          </div>
        ) : null}
      </div>
    </details>
  );
}
