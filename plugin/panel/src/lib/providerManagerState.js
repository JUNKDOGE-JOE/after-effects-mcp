// React state contains form hints only. Opaque references stay in the Provider
// entry and an empty secret input means "retain the current protected value".
export function defaultProviderModelAuthKind(protocol) {
  return protocol === 'anthropic' ? 'x-api-key' : 'bearer';
}

export function draftWithProtocol(draft, protocol) {
  const current = draft || emptyDraft();
  const currentKind = current.modelAuthKind || defaultProviderModelAuthKind(current.protocol);
  const followsProtocolDefault = current.modelAuthAutomatic === true;
  return {
    ...current,
    protocol,
    modelAuthKind: followsProtocolDefault ? defaultProviderModelAuthKind(protocol) : currentKind,
  };
}

export function emptyDraft() {
  return {
    id: '',
    name: '',
    baseUrl: '',
    allowInsecureHttp: false,
    modelAuthKind: 'auto',
    modelAuthAutomatic: false,
    modelAuthHeaderName: '',
    modelAuthSecret: '',
    headers: [],
    probePreference: '',
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

function legacyAuth(entry) {
  const model = entry?.auth?.model || { kind: 'none' };
  return {
    scheme: model.kind || 'none',
    headerName: model.kind === 'custom' ? model.headerName : null,
  };
}

export function draftFromEntry(entry) {
  const auth = entry?.credential?.preferredAuth || legacyAuth(entry);
  const legacyProbePreference = entry?.dialect?.override?.source === 'manual'
    ? entry.dialect.override.wireApi
    : '';
  return {
    ...emptyDraft(),
    id: String(entry?.id || ''),
    name: String(entry?.name || ''),
    baseUrl: String(entry?.baseUrl || ''),
    allowInsecureHttp: entry?.allowInsecureHttp === true,
    modelAuthKind: auth.scheme || 'auto',
    modelAuthAutomatic: false,
    modelAuthHeaderName: auth.scheme === 'custom' ? String(auth.headerName || '') : '',
    headers: Array.isArray(entry?.headers) ? entry.headers.map(headerDraft) : [],
    probePreference: String(entry?.probePreference || legacyProbePreference || ''),
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
    headers: Array.isArray(draft?.headers)
      ? draft.headers.map((header) => ({ ...header, scopes: [...(header.scopes || [])] }))
      : [],
  };
}
