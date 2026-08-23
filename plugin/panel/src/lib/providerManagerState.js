// Provider Manager drafts are the small OpenCode configuration surface. API
// keys are posted directly to OpenCode auth.json and never enter this state.
import {
  OPEN_CODE_DEFAULT_CONTEXT_WINDOW,
  normalizeOpenCodeContextWindow,
} from './openCodeModelLimits.js';
import { openCodeCatalogId } from './openCodeCatalogId.js';

export function providerDraftModelIds(value) {
  return Array.from(new Set(
    String(value || '').split(/[\s,]+/).map((id) => id.trim()).filter(Boolean),
  ));
}

export function reconcileDraftModelContexts(modelId, current = {}) {
  const source = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  return Object.fromEntries(providerDraftModelIds(modelId).map((id) => [
    id,
    Object.prototype.hasOwnProperty.call(source, id)
      ? source[id]
      : OPEN_CODE_DEFAULT_CONTEXT_WINDOW,
  ]));
}

export function emptyDraft() {
  return {
    id: '',
    name: '',
    baseUrl: '',
    allowInsecureHttp: false,
    modelId: '',
    modelContexts: {},
    protocol: 'anthropic',
  };
}

export function draftFromEntry(entry) {
  const modelId = Array.isArray(entry?.modelIds) ? entry.modelIds.join(', ') : '';
  return {
    ...emptyDraft(),
    id: String(entry?.id || ''),
    name: String(entry?.name || ''),
    baseUrl: String(entry?.baseUrl || ''),
    allowInsecureHttp: entry?.allowInsecureHttp === true,
    modelId,
    modelContexts: reconcileDraftModelContexts(modelId, entry?.modelContexts),
    protocol: entry?.protocol === 'openai' ? 'openai' : 'anthropic',
  };
}

export function validateDraft(draft) {
  if (!String(draft?.name || '').trim() && !String(draft?.id || '').trim()) {
    return '名称不能为空 / name is required';
  }
  try {
    const url = new URL(String(draft?.baseUrl || '').trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const modelIds = providerDraftModelIds(draft?.modelId);
      if (!modelIds.length) return '至少填写一个模型 / at least one model is required';
      if (modelIds.some((modelId) => !openCodeCatalogId(modelId))) {
        return '模型名称格式无效 / model id is invalid';
      }
      try {
        const contexts = reconcileDraftModelContexts(draft?.modelId, draft?.modelContexts);
        for (const value of Object.values(contexts)) normalizeOpenCodeContextWindow(value);
      } catch (error) {
        return `${error.message} / 上下文窗口数值无效`;
      }
      return '';
    }
  } catch (error) { /* invalid URL */ }
  return 'Base URL 必须以 http(s):// 开头 / must start with http(s)://';
}

export function draftToEntry(draft) {
  const name = String(draft?.name || draft?.id || '').trim();
  const id = String(draft?.id || '').trim()
    || name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const modelContexts = Object.fromEntries(
    Object.entries(reconcileDraftModelContexts(draft?.modelId, draft?.modelContexts))
      .map(([modelId, value]) => [modelId, normalizeOpenCodeContextWindow(value)]),
  );
  return {
    ...emptyDraft(),
    ...(draft || {}),
    id,
    name,
    modelContexts,
  };
}

export function mergeProbedModelIds(current, discovered) {
  const existing = String(current || '').split(/[\s,]+/).map((id) => id.trim()).filter(Boolean);
  const merged = Array.from(new Set([...existing, ...(discovered || []).map((id) => String(id).trim())]));
  return { modelId: merged.filter(Boolean).join(', '), added: merged.length - new Set(existing).size };
}
