import React from 'react';
import { Badge } from '../core/Badge';
import { Button } from '../core/Button';
import { Input } from '../forms/Input';
import { Select } from '../forms/Select';
import { Field } from '../forms/Field';
import {
  draftFromEntry,
  draftToEntry,
  emptyDraft,
  validateDraft,
} from '../../lib/providerManagerState';
import { providerClientRouteBadge } from '../../lib/providerDialectBadge';

const L = {
  zh: {
    title: 'Provider 管理', add: '新增', edit: '编辑', del: '删除', probe: '探测模型',
    redetect: '重新探测当前模型', probing: '探测中…', save: '保存', cancel: '取消', name: '名称',
    baseUrl: 'Base URL', apiKey: 'API Key', autoAuthCap: '自动识别 Authorization: Bearer、x-api-key 或无认证；只需填写平台给出的 API Key。密钥写入系统凭据库，编辑时留空表示保留。',
    overrideAuthCap: '已启用高级认证规则；密钥写入系统凭据库，编辑时留空表示保留。',
    noApiKey: '高级设置为无需凭据。', advancedAuth: '高级认证与请求头', authType: '认证规则',
    probePreference: '探测优先协议', probePreferenceCap: '仅调整探测顺序；实际路由每个模型的能力矩阵决定。',
    auto: '自动（推荐）', models: (n) => `${n} 个模型`, probeFailed: '探测失败：',
    importCc: '从 cc-switch 导入', insecure: '允许非回环 HTTP（保存时再次确认）',
    extraHeaders: '额外请求头', addHeader: '新增请求头', removeHeader: '移除', headerName: 'Header 名称',
    literal: '普通文本', secretValue: '系统凭据', scopeProbe: '探测', scopeModel: '模型请求',
    perModel: '逐模型', selected: '已选',
  },
  en: {
    title: 'Provider manager', add: 'Add', edit: 'Edit', del: 'Delete', probe: 'Probe models',
    redetect: 'Re-probe current model', probing: 'Probing…', save: 'Save', cancel: 'Cancel', name: 'Name',
    baseUrl: 'Base URL', apiKey: 'API Key', autoAuthCap: 'Automatically detects Authorization: Bearer, x-api-key, or no authentication. Enter the API key supplied by the platform. It is stored in the system credential store; leave blank while editing to retain it.',
    overrideAuthCap: 'An advanced authentication rule is active. The key is stored in the system credential store; leave blank while editing to retain it.',
    noApiKey: 'Advanced settings specify that no credential is required.', advancedAuth: 'Advanced authentication and headers', authType: 'Authentication rule',
    probePreference: 'Probe protocol preference', probePreferenceCap: 'Changes probe order only; each model\'s capability matrix determines its actual route.',
    auto: 'Auto (recommended)', models: (n) => `${n} models`, probeFailed: 'Probe failed: ',
    importCc: 'Import from cc-switch', insecure: 'Allow non-loopback HTTP (confirmed again on save)',
    extraHeaders: 'Extra headers', addHeader: 'Add header', removeHeader: 'Remove', headerName: 'Header name',
    literal: 'Literal text', secretValue: 'Credential store', scopeProbe: 'Probe', scopeModel: 'Model request',
    perModel: 'per-model', selected: 'selected',
  },
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
        width: '100%', height: 24, boxSizing: 'border-box', padding: '0 8px',
        color: 'var(--text-primary)', background: 'var(--bg-well)',
        border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
        outline: 'none', font: 'var(--weight-regular) var(--text-caption)/1 var(--font-mono)',
      }}
    />
  );
}

function nextHeaderId(headers) {
  let index = headers.length + 1;
  while (headers.some((header) => header.id === `header-${index}`)) index += 1;
  return `header-${index}`;
}

function providerModelCount(provider) {
  if (Array.isArray(provider?.modelList?.models)) return provider.modelList.models.length;
  return Array.isArray(provider?.probedModels) ? provider.probedModels.length : 0;
}

export function ProviderManagerSection({
  lang = 'zh',
  providers = [],
  activeProviderId = '',
  activeModelId = '',
  onUpsert,
  onRemove,
  onProbe,
  probing = '',
  probeErrors = {},
  ccSwitch = null,
  onImportCcSwitch,
  disabled = false,
}) {
  const t = L[lang] || L.zh;
  const [draft, setDraft] = React.useState(null);
  const [error, setError] = React.useState('');
  const currentModelId = String(activeModelId || '').trim();

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
        <Button variant="secondary" size="sm" icon="plus" onClick={(event) => { event.preventDefault(); setDraft(emptyDraft()); }}>{t.add}</Button>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {ccSwitch && onImportCcSwitch ? <Button variant="secondary" size="sm" icon="download" disabled={disabled} onClick={onImportCcSwitch}>{t.importCc}</Button> : null}
        {providers.map((provider) => {
          const modelCount = providerModelCount(provider);
          const selected = provider.id === activeProviderId;
          const routeBadges = ['codex', 'claude-code']
            .map((client) => providerClientRouteBadge(provider, { client, modelId: currentModelId, lang }))
            .filter(Boolean);
          const canRedetectCurrentModel = Boolean(currentModelId && Array.isArray(provider.modelCapabilities));
          return (
            <div key={provider.id} data-provider-id={provider.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', border: `1px solid ${selected ? 'var(--accent-border)' : 'var(--border-default)'}`, borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 120, font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provider.name}</span>
                {selected ? <Badge status="accent">{t.selected}</Badge> : null}
                <Badge status="neutral">{t.perModel}</Badge>
                {modelCount ? <Badge status="ok">{t.models(modelCount)}</Badge> : null}
              </div>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                {routeBadges.map((badge) => <span key={badge.label} title={badge.title}><Badge status={badge.status}>{badge.label}</Badge></span>)}
              </div>
              <div style={{ font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provider.baseUrl}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <Button variant="ghost" size="sm" disabled={disabled || probing === provider.id} onClick={() => onProbe(provider)}>{probing === provider.id ? t.probing : t.probe}</Button>
                <Button variant="ghost" size="sm" disabled={disabled || probing === provider.id || !canRedetectCurrentModel} onClick={() => onProbe(provider, { forceDetect: true, modelId: currentModelId })}>{t.redetect}</Button>
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => { setDraft(draftFromEntry(provider)); setError(''); }}>{t.edit}</Button>
                <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onRemove(provider)}>{t.del}</Button>
              </div>
              {probeErrors[provider.id] ? <div style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--warn)' }}>{t.probeFailed}{probeErrors[provider.id]}</div> : null}
            </div>
          );
        })}
        {draft ? (
          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)' }}>
            <Field label={t.name}><Input value={draft.name} onChange={(value) => setDraft({ ...draft, name: value })} /></Field>
            <Field label={t.baseUrl}><Input mono value={draft.baseUrl} onChange={(value) => setDraft({ ...draft, baseUrl: value })} placeholder="https://api.example.com/v1" /></Field>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', font: '400 11px/1.35 var(--font-ui)' }}><input type="checkbox" checked={draft.allowInsecureHttp} onChange={(event) => setDraft({ ...draft, allowInsecureHttp: event.target.checked })} />{t.insecure}</label>
            <Field label={t.apiKey} caption={draft.modelAuthKind === 'auto' ? t.autoAuthCap : t.overrideAuthCap}>
              {draft.modelAuthKind !== 'none'
                ? <SecretInput name="modelAuthSecret" disabled={disabled} />
                : <span style={{ font: '400 10px/1.4 var(--font-ui)', color: 'var(--text-tertiary)' }}>{t.noApiKey}</span>}
            </Field>
            <details data-provider-advanced-auth style={{ border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)', padding: '5px 6px' }}>
              <summary style={{ cursor: 'pointer', font: '500 11px/1.35 var(--font-ui)', color: 'var(--text-secondary)' }}>{t.advancedAuth}</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                <Field label={t.authType}>
                  <Select value={draft.modelAuthKind} onChange={(value) => setDraft({ ...draft, modelAuthKind: value, modelAuthAutomatic: false })} options={[
                    { value: 'auto', label: t.auto },
                    { value: 'bearer', label: 'Authorization: Bearer' },
                    { value: 'x-api-key', label: 'x-api-key' },
                    { value: 'custom', label: 'Custom header' },
                    { value: 'none', label: 'None' },
                  ]} />
                  {draft.modelAuthKind === 'custom' ? <Input mono value={draft.modelAuthHeaderName} onChange={(value) => setDraft({ ...draft, modelAuthHeaderName: value })} placeholder="x-provider-token" /> : null}
                </Field>
                <Field label={t.probePreference} caption={t.probePreferenceCap}>
                  <Select value={draft.probePreference} onChange={(value) => setDraft({ ...draft, probePreference: value })} options={[
                    { value: '', label: t.auto },
                    { value: 'responses', label: 'Responses' },
                    { value: 'chat', label: 'Chat Completions' },
                    { value: 'messages', label: 'Messages' },
                  ]} />
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
              </div>
            </details>
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
