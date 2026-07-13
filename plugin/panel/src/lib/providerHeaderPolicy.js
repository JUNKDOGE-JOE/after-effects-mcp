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

const SENSITIVE_SEGMENTS = new Set([
  'api-key',
  'apikey',
  'auth',
  'authentication',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'key',
  'oauth',
  'passwd',
  'password',
  'secret',
  'session',
  'signature',
  'token',
]);

const STRONG_SENSITIVE_FRAGMENTS = [
  'apikey',
  'auth',
  'cookie',
  'credential',
  'oauth',
  'passwd',
  'password',
  'secret',
  'session',
  'signature',
  'token',
];

const KEY_SUFFIX_PREFIXES = new Set([
  'api',
  'access',
  'client',
  'credential',
  'private',
  'provider',
  'public',
  'secret',
  'x',
]);

const SECRET_LIKE_LITERAL = /(?:^|[^A-Za-z0-9_-])(?:Bearer\s+\S+|Basic\s+\S+|sk-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})(?=$|[^A-Za-z0-9_-])/i;
const CREDENTIAL_ASSIGNMENT = /(?:^|[^A-Za-z0-9_.-])(["']?)([A-Za-z][A-Za-z0-9_.-]*)(\1)[ \t]*[:=]/g;
const MAX_LITERAL_DECODE_LAYERS = 3;

function normalizedName(value) {
  return String(value || '').trim().toLowerCase();
}

export function isSensitiveProviderHeaderName(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const separated = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  const segments = separated.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (STRONG_SENSITIVE_FRAGMENTS.some((fragment) => compact.includes(fragment))) return true;
  if (!compact.endsWith('key')) return false;
  const prefix = compact.slice(0, -3);
  return KEY_SUFFIX_PREFIXES.has(prefix)
    || Array.from(KEY_SUFFIX_PREFIXES).some((candidate) => prefix.endsWith(candidate));
}

export function isCredentialShapedProviderLiteral(value) {
  let text = String(value == null ? '' : value);
  if (!text) return false;
  if (text.length > 8192) return true;
  for (let layer = 0; layer <= MAX_LITERAL_DECODE_LAYERS; layer += 1) {
    if (literalLayerContainsCredential(text)) return true;
    const decoded = text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try { return decodeURIComponent(run); } catch { return run; }
    });
    if (decoded === text) break;
    text = decoded;
  }
  return false;
}

function literalLayerContainsCredential(text) {
  if (textContainsCredentialSyntax(text)) return true;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return false; }
  return jsonContainsCredential(parsed);
}

function textContainsCredentialSyntax(text) {
  if (SECRET_LIKE_LITERAL.test(text)) return true;
  CREDENTIAL_ASSIGNMENT.lastIndex = 0;
  let match;
  while ((match = CREDENTIAL_ASSIGNMENT.exec(text)) !== null) {
    if (isSensitiveProviderHeaderName(match[2])) return true;
  }
  return false;
}

function jsonHasMaterial(value) {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.some(jsonHasMaterial);
  if (value && typeof value === 'object') return Object.values(value).some(jsonHasMaterial);
  return value !== null && value !== undefined;
}

function jsonContainsCredential(value) {
  if (typeof value === 'string') return textContainsCredentialSyntax(value);
  if (Array.isArray(value)) return value.some(jsonContainsCredential);
  if (!value || typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveProviderHeaderName(key) && jsonHasMaterial(item)) return true;
    if (jsonContainsCredential(item)) return true;
  }
  return false;
}

export function isForbiddenProviderHeaderName(value) {
  const name = normalizedName(value);
  return FORBIDDEN_EXACT.has(name)
    || name.startsWith('x-forwarded-')
    || name.startsWith('proxy-')
    || name.startsWith('sec-')
    || name.startsWith('x-ae-mcp-route-');
}

export function isReservedProviderExtraHeaderName(value) {
  const name = normalizedName(value);
  return name === 'authorization'
    || name === 'x-api-key'
    || isForbiddenProviderHeaderName(name);
}
