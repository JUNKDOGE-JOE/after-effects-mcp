// Provider Manager drafts are the small OpenCode configuration surface. API
// keys are posted directly to OpenCode auth.json and never enter this state.
export function emptyDraft() {
  return {
    id: '',
    name: '',
    baseUrl: '',
    allowInsecureHttp: false,
    modelId: '',
    protocol: 'anthropic',
  };
}

export function draftFromEntry(entry) {
  return {
    ...emptyDraft(),
    id: String(entry?.id || ''),
    name: String(entry?.name || ''),
    baseUrl: String(entry?.baseUrl || ''),
    allowInsecureHttp: entry?.allowInsecureHttp === true,
    modelId: Array.isArray(entry?.modelIds) ? entry.modelIds.join(', ') : '',
    protocol: entry?.protocol === 'openai' ? 'openai' : 'anthropic',
  };
}

export function validateDraft(draft) {
  if (!String(draft?.name || '').trim() && !String(draft?.id || '').trim()) {
    return '名称不能为空 / name is required';
  }
  try {
    const url = new URL(String(draft?.baseUrl || '').trim());
    if (url.protocol === 'http:' || url.protocol === 'https:') return '';
  } catch (error) { /* invalid URL */ }
  return 'Base URL 必须以 http(s):// 开头 / must start with http(s)://';
}

export function draftToEntry(draft) {
  const name = String(draft?.name || draft?.id || '').trim();
  const id = String(draft?.id || '').trim()
    || name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    ...emptyDraft(),
    ...(draft || {}),
    id,
    name,
  };
}
