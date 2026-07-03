// Draft/validation logic for the Provider Manager form (spec A2).
export function emptyDraft() {
  return { id: '', name: '', protocol: 'openai-compatible', baseUrl: '', apiKey: '' };
}

export function draftFromEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    protocol: entry.protocol,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
  };
}

export function validateDraft(draft) {
  if (!String(draft.name || '').trim() && !String(draft.id || '').trim()) return '名称不能为空 / name is required';
  if (!/^https?:\/\//i.test(String(draft.baseUrl || '').trim())) return 'Base URL 必须以 http(s):// 开头 / must start with http(s)://';
  return '';
}

export function draftToEntry(draft) {
  const name = String(draft.name || draft.id || '').trim();
  const id = String(draft.id || '').trim() || name.replace(/[^A-Za-z0-9_-]+/g, '-').toLowerCase();
  return { id, name, protocol: draft.protocol, baseUrl: draft.baseUrl, apiKey: draft.apiKey };
}
