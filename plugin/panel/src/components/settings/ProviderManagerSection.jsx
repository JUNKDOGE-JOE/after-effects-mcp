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
  mergeProbedModelIds,
  providerDraftModelIds,
  reconcileDraftModelContexts,
  validateDraft,
} from '../../lib/providerManagerState';
import { redactCredentialText } from '../../lib/credentialTextRedaction.js';
import {
  OPEN_CODE_CONTEXT_WINDOW_PRESETS,
  OPEN_CODE_DEFAULT_CONTEXT_WINDOW,
  openCodeContextPresetValue,
} from '../../lib/openCodeModelLimits.js';

const L = {
  zh: {
    title: 'Provider 管理', add: '新增', edit: '编辑', del: '删除', save: '保存', cancel: '取消',
    name: '名称', baseUrl: 'Base URL', apiKey: 'API Key', model: '模型',
    dialect: '接口方言', dialectAnthropic: 'Anthropic（/v1/messages）',
    dialectOpenAi: 'OpenAI 兼容（/v1/chat/completions）',
    dialectCap: '中转端点常按模型家族区分方言；混合模型列表选 OpenAI 兼容通常全部可用。',
    openCodeKeyCap: '密钥写入 OpenCode auth.json；从旧版本升级的 Provider 必须重新填写。',
    needsApiKey: '需重填 key', insecure: '允许非回环 HTTP（保存时再次确认）',
    probe: '探测模型', probing: '探测中…',
    probeFound: (shown, total) => total > shown
      ? `探测到 ${total} 个模型，已加入前 ${shown} 个`
      : `已加入 ${shown} 个模型`,
    models: (count) => `${count} 个模型`, selected: '已选',
    contextWindow: '上下文窗口', contextCustom: '自定义', contextTokens: 'tokens',
    contextRecommended: '推荐',
    contextCap: '按模型设置。越小越早压缩，32K/64K 也会缩短单次回答与工具规划；不确定就选 128K。自定义范围 32K–2M。',
  },
  en: {
    title: 'Provider manager',
    add: 'Add',
    edit: 'Edit',
    del: 'Delete',
    save: 'Save',
    cancel: 'Cancel',
    name: 'Name', baseUrl: 'Base URL', apiKey: 'API Key', model: 'Model',
    dialect: 'Wire dialect', dialectAnthropic: 'Anthropic (/v1/messages)',
    dialectOpenAi: 'OpenAI-compatible (/v1/chat/completions)',
    dialectCap: 'Relays often vary the dialect per model family; OpenAI-compatible usually covers mixed model lists.',
    openCodeKeyCap: 'The key is written to OpenCode auth.json. Older providers must be entered again.',
    needsApiKey: 'API key required', insecure: 'Allow non-loopback HTTP (confirmed again on save)',
    probe: 'Probe models', probing: 'Probing…',
    probeFound: (shown, total) => total > shown
      ? `Found ${total} models; added the first ${shown}`
      : `Added ${shown} models`,
    models: (count) => `${count} models`, selected: 'selected',
    contextWindow: 'Context window', contextCustom: 'Custom', contextTokens: 'tokens',
    contextRecommended: 'recommended',
    contextCap: 'Set per model. Smaller values compact sooner; 32K/64K also shorten a single answer and tool plan. Use 128K when unsure. Custom range: 32K–2M.',
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
        outline: 'none',
        font: 'var(--weight-regular) var(--text-caption)/1 var(--font-mono)',
      }}
    />
  );
}

export function ProviderManagerSection({
  lang = 'zh',
  providers = [],
  activeProviderId = '',
  onUpsert,
  onRemove,
  onProbe,
  disabled = false,
}) {
  const t = L[lang] || L.zh;
  const [draft, setDraft] = React.useState(null);
  const [error, setError] = React.useState('');
  const [note, setNote] = React.useState('');
  const [probing, setProbing] = React.useState(false);
  const probeRunRef = React.useRef(0);
  const invalidateProbe = React.useCallback(() => {
    probeRunRef.current += 1;
    setProbing(false);
  }, []);
  const draftModelIds = providerDraftModelIds(draft?.modelId);
  const setModelContext = (modelId, value) => setDraft((current) => (
    current ? {
      ...current,
      // Keep temporarily removed IDs while the user edits the comma-separated
      // list. draftToEntry performs the final cleanup on Save.
      modelContexts: { ...current.modelContexts, [modelId]: value },
    } : current
  ));
  const save = async (event) => {
    event.preventDefault();
    invalidateProbe();
    const message = validateDraft(draft);
    if (message) {
      setError(message);
      return;
    }
    try {
      await onUpsert(event, draftToEntry(draft));
      setDraft(null);
      setError('');
    } catch (saveError) {
      setError(saveError?.message || 'Provider save failed');
    } finally {
      event.currentTarget?.reset?.();
    }
  };

  return (
    <details style={{
      border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
      background: 'var(--bg-well)', padding: '7px 8px',
    }}>
      <summary style={{
        cursor: 'pointer', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{
          flex: 1, font: '500 12px/1.35 var(--font-ui)', color: 'var(--text-primary)',
        }}>{t.title}</span>
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          disabled={disabled}
          onClick={(event) => {
            event.preventDefault();
            invalidateProbe();
            setDraft(emptyDraft());
            setError('');
            setNote('');
          }}
        >
          {t.add}
        </Button>
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {providers.map((provider) => {
          const modelCount = Array.isArray(provider?.modelIds) ? provider.modelIds.length : 0;
          const selected = provider.id === activeProviderId;
          return (
            <div key={provider.id} data-provider-id={provider.id} style={{
              display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px',
              border: `1px solid ${selected ? 'var(--accent-border)' : 'var(--border-default)'}`,
              borderRadius: 'var(--radius-sm)', background: 'var(--bg-panel)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  flex: 1, minWidth: 120, font: '500 12px/1.35 var(--font-ui)',
                  color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {provider.name}
                </span>
                {selected ? <Badge status="accent">{t.selected}</Badge> : null}
                {provider.needsApiKey ? <Badge status="warn">{t.needsApiKey}</Badge> : null}
                {modelCount ? <Badge status="ok">{t.models(modelCount)}</Badge> : null}
              </div>
              <div style={{
                font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-tertiary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {provider.baseUrl}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    invalidateProbe();
                    setDraft(draftFromEntry(provider));
                    setError('');
                    setNote('');
                  }}
                >
                  {t.edit}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    invalidateProbe();
                    onRemove(provider);
                  }}
                >
                  {t.del}
                </Button>
              </div>
            </div>
          );
        })}
        {draft ? (
          <form onSubmit={save} style={{
            display: 'flex', flexDirection: 'column', gap: 6, padding: '8px',
            border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-panel)',
          }}>
            <Field label={t.name}>
              <Input
                disabled={disabled}
                value={draft.name}
                onChange={(value) => setDraft({ ...draft, name: value })}
              />
            </Field>
            <Field label={t.baseUrl}>
              <Input
                mono
                disabled={disabled}
                value={draft.baseUrl}
                onChange={(value) => {
                  invalidateProbe();
                  setDraft({ ...draft, baseUrl: value });
                }}
                placeholder="https://api.example.com/v1"
              />
            </Field>
            <Field label={t.dialect} caption={t.dialectCap}>
              <Select
                disabled={disabled}
                value={draft.protocol}
                onChange={(value) => {
                  invalidateProbe();
                  setDraft({ ...draft, protocol: value });
                }}
                options={[
                  { value: 'anthropic', label: t.dialectAnthropic },
                  { value: 'openai', label: t.dialectOpenAi },
                ]}
              />
            </Field>
            <label style={{
              display: 'flex', gap: 6, alignItems: 'center', font: '400 11px/1.35 var(--font-ui)',
            }}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={draft.allowInsecureHttp}
                onChange={(event) => {
                  invalidateProbe();
                  setDraft({
                    ...draft,
                    allowInsecureHttp: event.target.checked,
                  });
                }}
              />
              {t.insecure}
            </label>
            <Field label={t.apiKey} caption={t.openCodeKeyCap}>
              <SecretInput name="modelAuthSecret" disabled={disabled} />
            </Field>
            <Field label={t.model}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Input
                  mono
                  disabled={disabled}
                  value={draft.modelId}
                  onChange={(value) => setDraft({
                    ...draft,
                    modelId: value,
                  })}
                  placeholder="claude-sonnet-5"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={disabled || probing || !String(draft.baseUrl || '').trim()}
                  onClick={async (event) => {
                    const form = event.currentTarget.closest('form');
                    const apiKey = String(new FormData(form).get('modelAuthSecret') || '');
                    const runId = probeRunRef.current + 1;
                    probeRunRef.current = runId;
                    setProbing(true);
                    setError('');
                    setNote('');
                    try {
                      const result = await onProbe(draft, { apiKey });
                      if (probeRunRef.current !== runId) return;
                      if (!result.ok) setError(result.detail);
                      else {
                        setDraft((current) => {
                          if (!current || probeRunRef.current !== runId) return current;
                          const merged = mergeProbedModelIds(current.modelId, result.models);
                          return {
                            ...current,
                            modelId: merged.modelId,
                            modelContexts: {
                              ...current.modelContexts,
                              ...Object.fromEntries(result.models.map((modelId) => [
                                modelId,
                                Object.prototype.hasOwnProperty.call(
                                  current.modelContexts || {}, modelId,
                                )
                                  ? current.modelContexts[modelId]
                                  : OPEN_CODE_DEFAULT_CONTEXT_WINDOW,
                              ])),
                            },
                          };
                        });
                        setNote(t.probeFound(result.models.length, result.total));
                      }
                    } catch (probeError) {
                      if (probeRunRef.current === runId) {
                        setError(redactCredentialText(
                          probeError?.message || 'Provider model probe failed', [apiKey],
                        ));
                      }
                    } finally {
                      if (probeRunRef.current === runId) setProbing(false);
                    }
                  }}
                >
                  {probing ? t.probing : t.probe}
                </Button>
              </div>
            </Field>
            {draftModelIds.length ? (
              <Field label={t.contextWindow} caption={t.contextCap}>
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 5,
                  maxHeight: 240, overflowY: 'auto', paddingRight: 2,
                }}>
                  {draftModelIds.map((modelId) => {
                    const contextValue = Object.prototype.hasOwnProperty.call(
                      draft.modelContexts || {}, modelId,
                    )
                      ? draft.modelContexts[modelId]
                      : OPEN_CODE_DEFAULT_CONTEXT_WINDOW;
                    const choice = openCodeContextPresetValue(contextValue);
                    return (
                      <div key={modelId} style={{
                        display: 'grid', gridTemplateColumns: 'minmax(90px, 1fr) 105px',
                        gap: 6, alignItems: 'center',
                      }}>
                        <span title={modelId} style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          font: '400 10px/1.35 var(--font-mono)', color: 'var(--text-secondary)',
                        }}>
                          {modelId}
                        </span>
                        <Select
                          disabled={disabled}
                          value={choice}
                          onChange={(value) => setModelContext(
                            modelId,
                            value === 'custom' ? String(contextValue) : Number(value),
                          )}
                          options={[
                            ...OPEN_CODE_CONTEXT_WINDOW_PRESETS.map((value) => ({
                              value: String(value),
                              label: value === OPEN_CODE_DEFAULT_CONTEXT_WINDOW
                                ? `${value / 1000}K (${t.contextRecommended})`
                                : `${value / 1000}K`,
                            })),
                            { value: 'custom', label: t.contextCustom },
                          ]}
                        />
                        {choice === 'custom' ? (
                          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6 }}>
                            <Input
                              mono
                              type="number"
                              disabled={disabled}
                              value={String(contextValue)}
                              onChange={(value) => setModelContext(modelId, value)}
                              suffix={<span style={{
                                paddingRight: 5, font: '400 9px/1 var(--font-ui)',
                                color: 'var(--text-tertiary)',
                              }}>{t.contextTokens}</span>}
                            />
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </Field>
            ) : null}
            {error ? <div style={{
              font: '400 10px/1.4 var(--font-ui)', color: 'var(--warn)',
            }}>{error}</div> : null}
            {note ? <div style={{
              font: '400 10px/1.4 var(--font-ui)', color: 'var(--text-tertiary)',
            }}>{note}</div> : null}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  invalidateProbe();
                  setDraft(null);
                  setError('');
                  setNote('');
                }}
              >
                {t.cancel}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={disabled}
                onClick={(event) => event.currentTarget.closest('form')?.requestSubmit()}
              >
                {t.save}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </details>
  );
}
