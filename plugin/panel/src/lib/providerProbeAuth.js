const AUTH_NAMES = new Set(['authorization', 'x-api-key']);

function profileError() {
  const error = new Error('Provider probe profile is invalid');
  error.code = 'provider_probe_profile_invalid';
  return error;
}

function normalizedExtraHeaders(profile, protocol) {
  const headers = {};
  for (const header of profile?.extraHeaders || []) {
    const name = String(header?.name || '').trim().toLowerCase();
    const value = String(header?.value ?? '');
    if (!name || /[\r\n\0]/.test(name) || /[\r\n\0]/.test(value) || Object.hasOwn(headers, name)) {
      throw profileError();
    }
    if (AUTH_NAMES.has(name)) throw profileError();
    headers[name] = value;
  }
  if (protocol === 'messages' && !Object.hasOwn(headers, 'anthropic-version')) {
    headers['anthropic-version'] = '2023-06-01';
  }
  return headers;
}

function standardSecret(auth) {
  if (auth?.kind !== 'header') return null;
  const name = String(auth.name || '').trim().toLowerCase();
  const value = String(auth.value ?? '');
  if (name === 'x-api-key' && value) return value;
  if (name === 'authorization') {
    const match = /^Bearer[ \t]+(\S+)$/i.exec(value.trim());
    if (match) return match[1];
  }
  return null;
}

function standardScheme(auth) {
  if (auth?.kind !== 'header') return null;
  const name = String(auth.name || '').trim().toLowerCase();
  if (name === 'x-api-key') return 'x-api-key';
  if (name === 'authorization' && /^Bearer[ \t]+\S+$/i.test(String(auth.value || '').trim())) {
    return 'bearer';
  }
  return null;
}

function authCandidate(baseHeaders, scheme, secret) {
  const headers = { ...baseHeaders };
  if (scheme === 'bearer') headers.authorization = `Bearer ${secret}`;
  if (scheme === 'x-api-key') headers['x-api-key'] = secret;
  return { scheme, headers };
}

export function buildProtocolAuthCandidates(profile, protocol) {
  if (!['responses', 'chat', 'messages', 'models'].includes(protocol)) throw profileError();
  const baseHeaders = normalizedExtraHeaders(profile, protocol);
  const auth = profile?.auth || { kind: 'none' };
  if (auth.kind === 'none') return [{ scheme: 'none', headers: baseHeaders }];
  if (auth.kind !== 'header') throw profileError();

  const secret = standardSecret(auth);
  if (secret !== null) {
    const resolvedScheme = standardScheme(auth);
    const fallbackScheme = resolvedScheme === 'bearer' ? 'x-api-key' : 'bearer';
    const preferred = [resolvedScheme, fallbackScheme];
    return preferred.map((scheme) => authCandidate(baseHeaders, scheme, secret));
  }

  const name = String(auth.name || '').trim().toLowerCase();
  const value = String(auth.value ?? '');
  if (!name || AUTH_NAMES.has(name) || /[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) {
    throw profileError();
  }
  return [{ scheme: 'custom', headers: { ...baseHeaders, [name]: value } }];
}
