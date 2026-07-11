import React from 'react';
import { Badge } from '../core/Badge';
import { Button } from '../core/Button';
import { Input } from '../forms/Input';
import { Select } from '../forms/Select';
import { Field } from '../forms/Field';
import { emptyDraft, draftFromEntry, validateDraft, draftToEntry } from '../../lib/providerManagerState';
import { providerDialectBadge } from '../../lib/providerDialectBadge';

const L = {
  zh: { title: 'Provider 管理', add: '新增', edit: '编辑', del: '删除', probe: '探测模型', redetect: '重新检测', probing: '探测中…', save: '保存', cancel: '取消', name: '名称', protocol: '协议', baseUrl: 'Base URL', secret: '模型凭据', probeSecret: '探测凭据', secretCap: '写入系统凭据库；编辑时留空表示保留原凭据', models: (n) => `${n} 个模型`, probeFailed: '探测失败（可手填模型 ID 继续使用）：', importCc: '从 cc-switch 导入', insecure: '允许非回环 HTTP（保存时再次确认）', dialect: 'API 方言', inherit: '继承模型凭据', separate: '单独配置', extraHeaders: '额外请求头', addHeader: '新增请求头', removeHeader: '移除', headerName: 'Header 名称', literal: '普通文本', secretValue: '系统凭据', scopeProbe: '探测', scopeModel: '模型请求' },
  en: { title: 'Provider manager', add: 'Add', edit: 'Edit', del: 'Delete', probe: 'Probe models', redetect: 'Re-detect', probing: 'Probing…', save: 'Save', cancel: 'Cancel', name: 'Name', protocol: 'Protocol', baseUrl: 'Base URL', secret: 'Model credential', probeSecret: 'Probe credential', secretCap: 'Stored in the system credential store; leave blank while editing to retain it', models: (n) => `${n} models`, probeFailed: 'Probe failed (manual model id still works): ', importCc: 'Import from cc-switch', insecure: 'Allow non-loopback HTTP (confirmed again on save)', dialect: 'API dialect', inherit: 'Inherit model credential', separate: 'Configure separately', extraHeaders: 'Extra headers', addHeader: 'Add header', removeHeader: 'Remove', headerName: 'Header name', literal: 'Literal text', secretValue: 'Credential store', scopeProbe: 'Probe', scopeModel: 'Model request' },
};

function SecretInput({ name, disabled = false }) {
  return (
    <input
      name={name}
      type="password"
      autoComplete="new-password"
      defaultValue=""
      disabled={disabled}
      style={{
        width: '100%',
        height: 24,
        boxSizing: 'border-box',
        padding: '0 8px',
        color: 'var(--text-primary)',
        background: 'var(--bg-well)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        outline: 'none',
        font: 'var(--weight-regular) var(--text-caption)/1 var(--font-mono)',
      }}
    />
  );
}

function nextHeaderId(headers) {
  let index = headers.length + 1;
  while (headers.some((header) => header.id === `header-${index}`)) index += 1;
  return `header-${index}`;
}

export function ProviderManagerSection({ lang = 'zh', providers = [], onUpsert, onRemove, onProbe, probing = '', probeErrors = {}, ccSwitch = null, onImportCcSwitch, disabled = false }) {
  const t = L[lang] || L.zh;
  const [draft, setDraft] = React.useState(null);
  const [error, setError] = React.useState('');

  const save = async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const message = validateDraft(draft);
    if (message) { setError(message); return; }
    try {
      await onUpsert(event, draftToEntry(draft));
      setDraft(null);
      setError('');
    } catch (saveError) {
      setError(saveError?.message || 'Provider save failed');
    } finally {
      formElement?.reset?.();
    }
  };

  return (
    <details style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', background: 'var(--bg-well)', padding: '7px 8px' }}>
      <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)' }}>{t.title}</span>
        <Button variant="secondary" size="sm" icon="plus" onClick={(e) => { e.preventDefault(); setDraft(emptyDraft()); }}>{t.add}</Button>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {ccSwitch && onImportCcSwitch ? <Button variant="secondary" size="sm" icon="download" disabled={disabled} onClick={onImportCcSwitch}>{t.importCc}</Button> : null}
        {providers.map((provider) => {
          const dialectBadge = providerDialectBadge(provider, lang);
          return (
          <div key={provider.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1, minWidth: 0, font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provider.name}</span>
              <Badge status="neutral">{provider.protocol}</Badge>
              {dialectBadge ? <span title={dialectBadge.title}><Badge status={dialectBadge.label === 'unconfirmed' ? 'warn' : 'neutral'}>{dialectBadge.label}</Badge></span> : null}
              {provider.probedModels.length ? <Badge status="ok">{t.models(provider.probedModels.length)}</Badge> : null}
              <Button variant="ghost" size="sm" disabled={disabled || probing === provider.id} onClick={() => onProbe(provider)}>{probing === provider.id ? t.probing : t.probe}</Button>
              {provider.protocol === 'openai-compatible' ? <Button variant="ghost" size="sm" disabled={disabled || probing === provider.id} onClick={() => onProbe(provider, { forceDetect: true })}>{t.redetect}</Button> : null}
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { setDraft(draftFromEntry(provider)); setError(''); }}>{t.edit}</Button>
              <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onRemove(provider)}>{t.del}</Button>
            </div>
            <div style={{ font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provider.baseUrl}</div>
            {probeErrors[provider.id] ? <div style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--warn)' }}>{t.probeFailed}{probeErrors[provider.id]}</div> : null}
          </div>
          );
        })}
        {draft ? (
          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)' }}>
            <Field label={t.name}><Input value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} /></Field>
            <Field label={t.protocol}><Select value={draft.protocol} onChange={(value) => setDraft({ ...draft, protocol: value })} options={[{ value: 'openai-compatible', label: 'OpenAI compatible' }, { value: 'anthropic', label: 'Anthropic' }]} /></Field>
            <Field label={t.baseUrl}><Input mono value={draft.baseUrl} onChange={(value) => setDraft({ ...draft, baseUrl: value })} placeholder="https://api.example.com/v1" /></Field>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', font: '400 11px/1.35 var(--font-ui)' }}><input type="checkbox" checked={draft.allowInsecureHttp} onChange={(event) => setDraft({ ...draft, allowInsecureHttp: event.target.checked })} />{t.insecure}</label>
            <Field label={t.secret} caption={t.secretCap}>
              <Select value={draft.modelAuthKind} onChange={(value) => setDraft({ ...draft, modelAuthKind: value })} options={[{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer' }, { value: 'x-api-key', label: 'x-api-key' }, { value: 'custom', label: 'Custom header' }]} />
              {draft.modelAuthKind === 'custom' ? <Input mono value={draft.modelAuthHeaderName} onChange={(value) => setDraft({ ...draft, modelAuthHeaderName: value })} placeholder="x-provider-token" /> : null}
              {draft.modelAuthKind !== 'none' ? <SecretInput name="modelAuthSecret" disabled={disabled} /> : null}
            </Field>
            <Field label={t.probeSecret} caption={t.secretCap}>
              <Select value={draft.probeAuthMode} onChange={(value) => setDraft({ ...draft, probeAuthMode: value })} options={[{ value: 'inherit-model', label: t.inherit }, { value: 'separate', label: t.separate }]} />
              {draft.probeAuthMode === 'separate' ? (
                <React.Fragment>
                  <Select value={draft.probeAuthKind} onChange={(value) => setDraft({ ...draft, probeAuthKind: value })} options={[{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer' }, { value: 'x-api-key', label: 'x-api-key' }, { value: 'custom', label: 'Custom header' }]} />
                  {draft.probeAuthKind === 'custom' ? <Input mono value={draft.probeAuthHeaderName} onChange={(value) => setDraft({ ...draft, probeAuthHeaderName: value })} placeholder="x-provider-token" /> : null}
                  {draft.probeAuthKind !== 'none' ? <SecretInput name="probeAuthSecret" disabled={disabled} /> : null}
                </React.Fragment>
              ) : null}
            </Field>
            <Field label={t.extraHeaders}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {draft.headers.map((header, index) => (
                  <div key={header.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 6, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)' }}>
                    <Input mono value={header.name} onChange={(value) => setDraft({ ...draft, headers: draft.headers.map((item, itemIndex) => itemIndex === index ? { ...item, name: value } : item) })} placeholder={t.headerName} />
                    <Select value={header.valueKind} onChange={(valueKind) => setDraft({ ...draft, headers: draft.headers.map((item, itemIndex) => itemIndex === index ? { ...item, valueKind, value: valueKind === 'literal' ? item.value || '' : '' } : item) })} options={[{ value: 'literal', label: t.literal }, { value: 'secret', label: t.secretValue }]} />
                    {header.valueKind === 'secret'
                      ? <SecretInput name={`headerSecret:${header.id}`} disabled={disabled} />
                      : <Input mono value={header.value || ''} onChange={(value) => setDraft({ ...draft, headers: draft.headers.map((item, itemIndex) => itemIndex === index ? { ...item, value } : item) })} />}
                    <div style={{ display: 'flex', gap: 10 }}>
                      {['probe', 'model'].map((scope) => (
                        <label key={scope} style={{ display: 'flex', alignItems: 'center', gap: 4, font: '400 10px/1.35 var(--font-ui)' }}>
                          <input type="checkbox" checked={header.scopes.includes(scope)} onChange={(event) => setDraft({ ...draft, headers: draft.headers.map((item, itemIndex) => itemIndex === index ? { ...item, scopes: event.target.checked ? [...new Set([...item.scopes, scope])] : item.scopes.filter((value) => value !== scope) } : item) })} />
                          {scope === 'probe' ? t.scopeProbe : t.scopeModel}
                        </label>
                      ))}
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => setDraft({ ...draft, headers: draft.headers.filter((_, itemIndex) => itemIndex !== index) })}>{t.removeHeader}</Button>
                  </div>
                ))}
                <Button variant="secondary" size="sm" icon="plus" onClick={() => setDraft({ ...draft, headers: [...draft.headers, { id: nextHeaderId(draft.headers), name: '', scopes: ['model'], valueKind: 'literal', value: '' }] })}>{t.addHeader}</Button>
              </div>
            </Field>
            <Field label={t.dialect}><Select value={draft.dialectOverride} onChange={(value) => setDraft({ ...draft, dialectOverride: value })} options={[{ value: '', label: 'Auto detect' }, { value: 'responses', label: 'Responses' }, { value: 'chat', label: 'Chat' }]} /></Field>
            {error ? <div style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--warn)' }}>{error}</div> : null}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <Button variant="ghost" size="sm" onClick={() => { setDraft(null); setError(''); }}>{t.cancel}</Button>
              <Button variant="primary" size="sm" disabled={disabled} onClick={(event) => event.currentTarget.closest('form')?.requestSubmit()}>{t.save}</Button>
            </div>
          </form>
        ) : null}
      </div>
    </details>
  );
}
