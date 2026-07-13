import { redactText } from './exactSecretRedaction.js';
import { isSensitiveProviderHeaderName } from './providerHeaderPolicy.js';

const SECRET_REFERENCE = /aemcp-secret:\/\/provider\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[a-z0-9_-]+\/v1/gi;
const HEADER_LINE = /^([ \t]*)([!#$%&'*+.^_`|~0-9A-Za-z-]+)([ \t]*:[ \t]*)([^\r\n]+)$/gm;
const QUOTED_PAIR = /(["'])([A-Za-z][A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])([^"'\r\n]+)\4/g;
const ASSIGNMENT = /(^|[\s?&,;])([A-Za-z][A-Za-z0-9_.-]*)(\s*=\s*)([^\s&,;]+)/gm;
const INLINE_HEADER = /(^|[\s{,;])([!#$%&'*+.^_`|~0-9A-Za-z-]+)(\s*:\s*)((?:Bearer|Basic)\s+[^\s,;}]+|[^\s,;}]+)/gim;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
const JWT = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
const PREFIXED_KEY = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
const JSON_KEY = /"((?:\\.|[^"\\])*)"\s*:/g;
const SENSITIVE_ASSIGNMENT_START = /(^|[^A-Za-z0-9_.-])(["']?)([A-Za-z][A-Za-z0-9_.-]*)(\2)([ \t]*[:=][ \t]*)/g;

const MARKER = '[redacted]';

function quotedValueEnd(text, start) {
  const quote = text[start];
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === quote) {
      return index + 1;
    }
  }
  return -1;
}

function jsonContainerEnd(text, start) {
  const stack = [text[start]];
  let stringQuote = null;
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (stringQuote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === stringQuote) stringQuote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      stringQuote = character;
      continue;
    }
    if (character === '{' || character === '[') stack.push(character);
    if (character !== '}' && character !== ']') continue;
    const opening = stack.pop();
    if ((opening === '{' && character !== '}') || (opening === '[' && character !== ']')) return -1;
    if (!stack.length) return index + 1;
  }
  return -1;
}

function jsonValueEnd(text, start) {
  if (start >= text.length) return -1;
  if (text[start] === '"') return quotedValueEnd(text, start);
  if (text[start] === '{' || text[start] === '[') return jsonContainerEnd(text, start);
  let end = start;
  while (end < text.length && !/[\s,}\]]/.test(text[end])) end += 1;
  return end > start ? end : -1;
}

function redactSensitiveJsonValues(value) {
  let text = String(value == null ? '' : value);
  let offset = 0;
  while (offset < text.length) {
    JSON_KEY.lastIndex = offset;
    const match = JSON_KEY.exec(text);
    if (!match) break;
    let name = '';
    try { name = JSON.parse(`"${match[1]}"`); } catch { name = ''; }
    if (!isSensitiveProviderHeaderName(name)) {
      offset = JSON_KEY.lastIndex;
      continue;
    }
    let start = JSON_KEY.lastIndex;
    while (start < text.length && /\s/.test(text[start])) start += 1;
    const end = jsonValueEnd(text, start);
    if (end < 0) {
      offset = JSON_KEY.lastIndex;
      continue;
    }
    const replacement = JSON.stringify(MARKER);
    text = text.slice(0, start) + replacement + text.slice(end);
    offset = start + replacement.length;
  }
  return text;
}

function redactSensitiveLineSuffixes(value) {
  const text = String(value == null ? '' : value);
  SENSITIVE_ASSIGNMENT_START.lastIndex = 0;
  let match;
  while ((match = SENSITIVE_ASSIGNMENT_START.exec(text)) !== null) {
    if (!isSensitiveProviderHeaderName(match[3])) continue;
    return text.slice(0, match.index)
      + match[1] + match[2] + match[3] + match[4] + match[5] + MARKER;
  }
  return text;
}

export function redactCredentialText(value, exactSecrets = []) {
  let text = redactText(value, exactSecrets);
  text = redactSensitiveJsonValues(text);
  text = redactSensitiveLineSuffixes(text);
  text = text.replace(SECRET_REFERENCE, '[secret-reference-redacted]');
  text = text.replace(PRIVATE_KEY, MARKER);
  text = text.replace(HEADER_LINE, (match, prefix, name, separator, headerValue) => (
    isSensitiveProviderHeaderName(name) && headerValue.trim()
      ? prefix + name + separator + MARKER
      : match
  ));
  text = text.replace(QUOTED_PAIR, (match, quote, name, separator) => (
    isSensitiveProviderHeaderName(name)
      ? quote + name + quote + separator + quote + MARKER + quote
      : match
  ));
  text = text.replace(ASSIGNMENT, (match, prefix, name, separator) => (
    isSensitiveProviderHeaderName(name)
      ? prefix + name + separator + MARKER
      : match
  ));
  text = text.replace(INLINE_HEADER, (match, prefix, name, separator) => (
    isSensitiveProviderHeaderName(name)
      ? prefix + name + separator + MARKER
      : match
  ));
  text = text.replace(PREFIXED_KEY, MARKER);
  text = text.replace(JWT, MARKER);
  return text;
}
