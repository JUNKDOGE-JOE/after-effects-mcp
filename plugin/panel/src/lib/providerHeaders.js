const RFC_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const INBOUND_EXACT = new Set([
  'accept',
  'content-type',
  'openai-beta',
  'user-agent',
  'x-client-request-id',
  'x-request-id',
  'traceparent',
  'tracestate',
]);
export const LOCAL_ROUTE_TOKEN_HEADER = 'x-ae-mcp-route-token';
const LOCAL_ONLY = new Set([
  'authorization',
  LOCAL_ROUTE_TOKEN_HEADER,
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);
const FORBIDDEN_EXACT = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
  'keep-alive',
  'te',
  'trailer',
  'expect',
  'cookie',
  'set-cookie',
  'forwarded',
  'proxy-authorization',
  'proxy-authenticate',
]);
const RESPONSE_EXACT = new Set([
  'content-type',
  'cache-control',
  'retry-after',
  'x-request-id',
  'request-id',
  'openai-request-id',
  'x-goog-request-id',
  'x-amzn-requestid',
]);
const SENSITIVE_HEADER_NAME = /(?:^|[-_])(?:authorization|api[-_]?key|token|secret|password)(?:$|[-_])/i;
const SECRET_LIKE_LITERAL = /^(?:Bearer\s+\S+|Basic\s+\S+|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})$/;
const JSON_MEDIA_TYPE = /^application\/(?:json|[!#$%&'*+.^_`|~0-9A-Za-z-]+\+json)(?:\s*;\s*charset=utf-8)?$/i;
const DEFAULT_LIMITS = Object.freeze({ maxValueBytes: 8 * 1024, maxTotalBytes: 32 * 1024, maxCount: 64 });

function headerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolvedLimits(limits = {}) {
  const output = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const candidate = Number(limits[key]);
    output[key] = Number.isFinite(candidate) && candidate > 0
      ? Math.min(DEFAULT_LIMITS[key], Math.floor(candidate))
      : DEFAULT_LIMITS[key];
  }
  return output;
}

function isForbiddenName(name) {
  return FORBIDDEN_EXACT.has(name)
    || name.startsWith('x-forwarded-')
    || name.startsWith('proxy-')
    || name.startsWith('sec-')
    || name.startsWith('x-ae-mcp-route-')
    || name === 'x-ae-mcp-route-token';
}

function validatesInboundName(name) {
  return INBOUND_EXACT.has(name) || name.startsWith('x-stainless-') || name.startsWith('x-codex-');
}

function validateName(name) {
  const value = String(name);
  if (!RFC_TOKEN.test(value)) throw headerError('provider_header_invalid_name', 'Provider header name is invalid.');
  return value.toLowerCase();
}

function validateValue(value, limits) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw headerError('provider_header_invalid_value', 'Provider header value is invalid.');
  if (Buffer.byteLength(text, 'utf8') > limits.maxValueBytes) {
    throw headerError('provider_header_value_too_large', 'Provider header value is too large.');
  }
  return text;
}

function fieldBytes(name, value) {
  return Buffer.byteLength(`${name}: ${value}`, 'utf8');
}

function checkAggregate(fields, limits) {
  if (fields.length > limits.maxCount) {
    throw headerError('provider_header_count_exceeded', 'Provider header count is too large.');
  }
  const total = fields.reduce((sum, field) => sum + fieldBytes(field.name, field.value), 0);
  if (total > limits.maxTotalBytes) {
    throw headerError('provider_headers_too_large', 'Provider headers are too large.');
  }
}

function validateContentType(value) {
  if (value && !JSON_MEDIA_TYPE.test(String(value))) {
    throw headerError('provider_content_type_unsupported', 'Provider request content type must be JSON.');
  }
}

export function collectCodexHeaders(rawHeaders = [], limits = {}) {
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) {
    throw headerError('provider_header_invalid', 'Provider headers are malformed.');
  }
  const bounded = resolvedLimits(limits);
  const seen = new Set();
  const all = [];
  const forwarded = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = validateName(rawHeaders[index]);
    const value = validateValue(rawHeaders[index + 1], bounded);
    if (seen.has(name) && name !== 'authorization') {
      throw headerError('provider_header_duplicate', 'Duplicate provider header is forbidden.');
    }
    seen.add(name);
    all.push({ name, value });
    if (LOCAL_ONLY.has(name)) continue;
    if (isForbiddenName(name)) throw headerError('provider_header_forbidden', 'Provider header is forbidden.');
    if (!validatesInboundName(name)) continue;
    if (SENSITIVE_HEADER_NAME.test(name)) {
      throw headerError('provider_header_forbidden', 'Provider header is forbidden.');
    }
    if (name === 'content-type') validateContentType(value);
    forwarded.push({ name, value });
  }
  checkAggregate(all, bounded);
  return forwarded;
}

function validateProviderHeaders(providerHeaders, authName, limits) {
  if (!Array.isArray(providerHeaders)) throw headerError('provider_header_invalid', 'Provider headers are invalid.');
  const seen = new Set();
  const validated = [];
  for (const header of providerHeaders) {
    const name = validateName(header?.name);
    const value = validateValue(header?.value, limits);
    const source = header?.source;
    if (source !== 'literal' && source !== 'secret') {
      throw headerError('provider_header_invalid', 'Provider header source is invalid.');
    }
    if (seen.has(name)) throw headerError('provider_header_duplicate', 'Duplicate provider header is forbidden.');
    seen.add(name);
    if (isForbiddenName(name) || name === 'authorization' || name === 'x-api-key' || name === authName) {
      throw headerError('provider_header_forbidden', 'Provider header is reserved.');
    }
    if (source !== 'secret' && (SENSITIVE_HEADER_NAME.test(name) || SECRET_LIKE_LITERAL.test(value))) {
      throw headerError('provider_header_secret_reference_required', 'Provider header requires a secret reference.');
    }
    if (name === 'content-type') validateContentType(value);
    validated.push({ name, value });
  }
  return validated;
}

function validateAuth(auth, limits) {
  if (!auth || auth.kind === 'none') return { kind: 'none' };
  if (auth.kind !== 'header') throw headerError('provider_header_invalid', 'Provider auth header is invalid.');
  const name = validateName(auth.name);
  if (isForbiddenName(name)) throw headerError('provider_header_forbidden', 'Provider auth header is forbidden.');
  const value = validateValue(auth.value, limits);
  return { kind: 'header', name, value };
}

export function mergeUpstreamHeaders({ rawHeaders = [], providerHeaders = [], auth = { kind: 'none' }, contentType, limits } = {}) {
  const bounded = resolvedLimits(limits);
  const codex = collectCodexHeaders(rawHeaders, bounded);
  const validatedAuth = validateAuth(auth, bounded);
  const authName = validatedAuth.kind === 'header' ? validatedAuth.name : '';
  const extras = validateProviderHeaders(providerHeaders, authName, bounded);

  const merged = {};
  for (const field of codex) merged[field.name] = field.value;
  if (contentType) {
    validateContentType(contentType);
    merged['content-type'] = String(contentType);
  }
  for (const field of extras) merged[field.name] = field.value;
  if (validatedAuth.kind === 'header') merged[validatedAuth.name] = validatedAuth.value;
  if (merged['content-type']) validateContentType(merged['content-type']);
  checkAggregate(Object.entries(merged).map(([name, value]) => ({ name, value })), bounded);
  return merged;
}

export function validateProviderRequestConfiguration(provider, scope, limits = {}) {
  const bounded = resolvedLimits(limits);
  const model = provider?.auth?.model || { kind: 'none' };
  const probe = provider?.auth?.probe;
  const policy = scope === 'probe' && probe?.kind !== 'inherit-model' ? probe : model;
  let authName = '';
  if (policy?.kind === 'bearer') authName = 'authorization';
  else if (policy?.kind === 'x-api-key') authName = 'x-api-key';
  else if (policy?.kind === 'custom') {
    authName = validateName(policy.headerName);
    if (isForbiddenName(authName)) throw headerError('provider_header_forbidden', 'Provider auth header is forbidden.');
  }

  const relevant = [];
  for (const header of provider?.headers || []) {
    if (!Array.isArray(header?.scopes) || !header.scopes.includes(scope)) continue;
    relevant.push({
      name: header.name,
      value: header.valueRef?.kind === 'literal' ? header.valueRef.value : 'resolved-secret',
      source: header.valueRef?.kind === 'literal' ? 'literal' : 'secret',
    });
  }
  const validated = validateProviderHeaders(relevant, authName, bounded);
  checkAggregate(validated, bounded);
}

export function filterUpstreamResponseHeaders(rawHeaders = []) {
  if (!Array.isArray(rawHeaders)) return {};
  const output = {};
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const rawName = String(rawHeaders[index]);
    if (!RFC_TOKEN.test(rawName)) continue;
    const name = rawName.toLowerCase();
    if (!RESPONSE_EXACT.has(name) && !name.startsWith('ratelimit-') && !name.startsWith('x-ratelimit-')) continue;
    const value = String(rawHeaders[index + 1]);
    if (/[\r\n\0]/.test(value)) continue;
    output[name] = value;
  }
  return output;
}
