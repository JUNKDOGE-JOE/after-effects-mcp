// Pure, UI-safe Provider Manager form state. Secret references and resolved
// values never enter React state; an empty secret field means "retain current".
export function emptyDraft() {
  return {
    id: '',
    name: '',
    protocol: 'openai-compatible',
    baseUrl: '',
    allowInsecureHttp: false,
    modelAuthKind: 'bearer',
    modelAuthHeaderName: '',
    modelAuthSecret: '',
    probeAuthMode: 'inherit-model',
    probeAuthKind: 'none',
    probeAuthHeaderName: '',
    probeAuthSecret: '',
    headers: [],
    dialectOverride: '',
  };
}

function headerDraft(header) {
  if (header?.valueRef?.kind === 'literal') {
    return {
      id: header.id,
      name: header.name,
      scopes: Array.isArray(header.scopes) ? header.scopes.slice() : [],
      valueKind: 'literal',
      value: header.valueRef.value,
    };
  }
  return {
    id: header.id,
    name: header.name,
    scopes: Array.isArray(header.scopes) ? header.scopes.slice() : [],
    valueKind: 'secret',
    value: '',
  };
}

export function draftFromEntry(entry) {
  const model = entry?.auth?.model || { kind: 'none' };
  const probe = entry?.auth?.probe || { kind: 'inherit-model' };
  return {
    id: String(entry?.id || ''),
    name: String(entry?.name || ''),
    protocol: entry?.protocol || 'openai-compatible',
    baseUrl: String(entry?.baseUrl || ''),
    allowInsecureHttp: entry?.allowInsecureHttp === true,
    modelAuthKind: model.kind || 'none',
    modelAuthHeaderName: model.kind === 'custom' ? model.headerName : '',
    modelAuthSecret: '',
    probeAuthMode: probe.kind === 'inherit-model' ? 'inherit-model' : 'separate',
    probeAuthKind: probe.kind === 'inherit-model' ? 'none' : probe.kind,
    probeAuthHeaderName: probe.kind === 'custom' ? probe.headerName : '',
    probeAuthSecret: '',
    headers: Array.isArray(entry?.headers) ? entry.headers.map(headerDraft) : [],
    dialectOverride: entry?.dialect?.override?.wireApi || '',
  };
}

export function validateDraft(draft) {
  if (!String(draft?.name || '').trim() && !String(draft?.id || '').trim()) {
    return '名称不能为空 / name is required';
  }
  let url;
  try {
    url = new URL(String(draft?.baseUrl || '').trim());
  } catch {
    return 'Base URL 必须以 http(s):// 开头 / must start with http(s)://';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Base URL 必须以 http(s):// 开头 / must start with http(s)://';
  }
  return '';
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
    headers: Array.isArray(draft?.headers) ? draft.headers.map((header) => ({ ...header, scopes: [...(header.scopes || [])] })) : [],
  };
}
