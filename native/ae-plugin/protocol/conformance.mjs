import crypto from 'node:crypto';

import {
  CAPABILITY_DESCRIPTORS,
  NATIVE_EXEC_REGISTRY_DIGEST,
} from './native_exec.generated.mjs';

export const LIMITS = Object.freeze({
  maxFrameBytes: 524288,
  maxJsonDepth: 32,
  maxJsonNodes: 32768,
  maxStringLength: 8192,
  defaultDeadlineMs: 5000,
  maximumDeadlineMs: 30000,
  defaultTerminalCacheEntries: 128,
  defaultTerminalCacheTtlMs: 60000,
});

export const ERROR_POLICIES = Object.freeze({
  NATIVE_UNAVAILABLE: [true, 'not-started', 'reconnect'],
  NATIVE_UNSUPPORTED: [false, 'not-started', 'refresh-capabilities'],
  WIRE_VERSION_MISMATCH: [false, 'not-started', 'reconnect'],
  INVALID_REQUEST: [false, 'not-started', 'none'],
  INVALID_ARGUMENT: [false, 'not-started', 'change-arguments'],
  DUPLICATE_REQUEST: [false, 'not-started', 'inspect-state'],
  PRECONDITION_FAILED: [false, 'not-started', 'open-project'],
  STALE_LOCATOR: [true, 'not-started', 'refresh-locator'],
  DEADLINE_EXCEEDED: [true, 'not-started', 'retry'],
  CANCELLED: [false, 'not-started', 'none'],
  QUEUE_FULL: [true, 'not-started', 'retry'],
  AE_SHUTTING_DOWN: [true, 'not-started', 'reconnect'],
  SESSION_STALE: [true, 'not-started', 'reconnect'],
  CAPABILITY_FAILED: [false, 'not-started', 'inspect-state'],
  POSSIBLY_SIDE_EFFECTING_FAILURE: [
    false, 'may-have-occurred', 'inspect-state',
  ],
});

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function unicodeScalarLength(value) {
  if (typeof value !== 'string' || hasLoneSurrogate(value)) {
    fail('INVALID_REQUEST', 'string is not valid Unicode scalar data');
  }
  return Array.from(value).length;
}

function resolveSchemaRef(root, reference) {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    fail('INVALID_ARGUMENT', 'only local schema references are supported');
  }
  return reference.slice(2).split('/').reduce((value, segment) => {
    if (!isPlainObject(value)) {
      fail('INVALID_ARGUMENT', 'invalid local schema reference');
    }
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!Object.hasOwn(value, key)) {
      fail('INVALID_ARGUMENT', 'unresolved local schema reference');
    }
    return value[key];
  }, root);
}

function jsonDeepEqual(left, right) {
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isNaN(left) && Number.isNaN(right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => jsonDeepEqual(item, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key) => Object.hasOwn(right, key)
        && jsonDeepEqual(left[key], right[key]),
    );
}

function schemaTypeMatches(type, value) {
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (type === 'null') return value === null;
  return typeof value === type;
}

function schemaAcceptsUnchecked(candidate, value, root) {
  if (candidate === true) return true;
  if (candidate === false || !isPlainObject(candidate)) return false;
  if (candidate.$ref !== undefined
      && !schemaAcceptsUnchecked(
        resolveSchemaRef(root, candidate.$ref), value, root,
      )) return false;
  if (Object.hasOwn(candidate, 'const')
      && !jsonDeepEqual(candidate.const, value)) return false;
  if (candidate.enum
      && !candidate.enum.some((item) => jsonDeepEqual(item, value))) {
    return false;
  }
  if (candidate.not && schemaAcceptsUnchecked(candidate.not, value, root)) {
    return false;
  }
  if (candidate.if) {
    const branch = schemaAcceptsUnchecked(candidate.if, value, root)
      ? candidate.then : candidate.else;
    if (branch !== undefined
        && !schemaAcceptsUnchecked(branch, value, root)) return false;
  }
  if (candidate.oneOf
      && candidate.oneOf.filter(
        (part) => schemaAcceptsUnchecked(part, value, root),
      ).length !== 1) return false;
  if (candidate.anyOf
      && !candidate.anyOf.some(
        (part) => schemaAcceptsUnchecked(part, value, root),
      )) return false;
  if (candidate.allOf
      && !candidate.allOf.every(
        (part) => schemaAcceptsUnchecked(part, value, root),
      )) return false;
  if (candidate.type && !schemaTypeMatches(candidate.type, value)) return false;

  if (typeof value === 'number') {
    if (candidate.minimum !== undefined && value < candidate.minimum) {
      return false;
    }
    if (candidate.maximum !== undefined && value > candidate.maximum) {
      return false;
    }
  }
  if (typeof value === 'string') {
    const length = unicodeScalarLength(value);
    if (candidate.minLength !== undefined && length < candidate.minLength) {
      return false;
    }
    if (candidate.maxLength !== undefined && length > candidate.maxLength) {
      return false;
    }
    if (candidate.pattern
        && !(new RegExp(candidate.pattern, 'u')).test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (candidate.minItems !== undefined
        && value.length < candidate.minItems) return false;
    if (candidate.maxItems !== undefined
        && value.length > candidate.maxItems) return false;
    if (candidate.uniqueItems && value.some(
      (item, index) => value.slice(index + 1).some(
        (other) => jsonDeepEqual(item, other),
      ),
    )) return false;
    if (candidate.items
        && !value.every(
          (item) => schemaAcceptsUnchecked(candidate.items, item, root),
        )) return false;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (candidate.required
        && !candidate.required.every((key) => Object.hasOwn(value, key))) {
      return false;
    }
    if (candidate.properties) {
      for (const [key, member] of Object.entries(candidate.properties)) {
        if (Object.hasOwn(value, key)
            && !schemaAcceptsUnchecked(member, value[key], root)) return false;
      }
    }
    if (candidate.additionalProperties === false
        && keys.some(
          (key) => !Object.hasOwn(candidate.properties ?? {}, key),
        )) return false;
  }
  return true;
}

export function schemaAccepts(candidate, value, root = candidate) {
  try {
    assertJsonLimits(value);
    return schemaAcceptsUnchecked(candidate, value, root);
  } catch {
    return false;
  }
}

export function assertJsonLimits(value, limits = LIMITS) {
  const stack = [{ value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > limits.maxJsonNodes) {
      fail('INVALID_REQUEST', 'JSON node limit exceeded');
    }
    if (current.depth > limits.maxJsonDepth) {
      fail('INVALID_REQUEST', 'JSON depth exceeded');
    }
    if (current.value === null || typeof current.value === 'boolean') continue;
    if (typeof current.value === 'string') {
      if (unicodeScalarLength(current.value) > limits.maxStringLength) {
        fail('INVALID_REQUEST', 'JSON string limit exceeded');
      }
      continue;
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) {
        fail('INVALID_REQUEST', 'non-finite JSON number');
      }
      if (Number.isInteger(current.value)
          && !Number.isSafeInteger(current.value)) {
        fail('INVALID_REQUEST', 'unsafe JSON integer');
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current.value[index],
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (!isPlainObject(current.value)) {
      fail('INVALID_REQUEST', 'unsupported JSON value');
    }
    for (const [key, member] of Object.entries(current.value).reverse()) {
      if (unicodeScalarLength(key) > limits.maxStringLength) {
        fail('INVALID_REQUEST', 'JSON key limit exceeded');
      }
      if (member === undefined || typeof member === 'bigint'
          || typeof member === 'function' || typeof member === 'symbol') {
        fail('INVALID_REQUEST', 'unsupported JSON member');
      }
      stack.push({ value: member, depth: current.depth + 1 });
    }
  }
  return true;
}

function canonicalizeUnchecked(value) {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      fail('INVALID_ARGUMENT', 'lone unicode surrogate');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('INVALID_ARGUMENT', 'non-finite JSON number');
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail('INVALID_ARGUMENT', 'unsafe JSON integer');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeUnchecked(item)).join(',')}]`;
  }
  if (!isPlainObject(value)) {
    fail('INVALID_ARGUMENT', 'unsupported canonical JSON value');
  }
  const members = Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalizeUnchecked(value[key])}`,
  );
  return `{${members.join(',')}}`;
}

export function canonicalize(value) {
  assertJsonLimits(value);
  return canonicalizeUnchecked(value);
}

export function sha256Jcs(value) {
  return crypto.createHash('sha256')
    .update(canonicalize(value), 'utf8')
    .digest('hex');
}

class StrictJsonParser {
  constructor(text, limits = LIMITS) {
    this.text = text;
    this.index = 0;
    this.nodes = 0;
    this.limits = limits;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue(1);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      fail('INVALID_REQUEST', 'trailing JSON bytes');
    }
    return value;
  }

  countNode(depth) {
    if (depth > this.limits.maxJsonDepth) {
      fail('INVALID_REQUEST', 'JSON depth exceeded');
    }
    this.nodes += 1;
    if (this.nodes > this.limits.maxJsonNodes) {
      fail('INVALID_REQUEST', 'JSON node limit exceeded');
    }
  }

  parseValue(depth) {
    this.countNode(depth);
    const char = this.text[this.index];
    if (char === '{') return this.parseObject(depth);
    if (char === '[') return this.parseArray(depth);
    if (char === '"') return this.parseString();
    if (char === 't') return this.parseLiteral('true', true);
    if (char === 'f') return this.parseLiteral('false', false);
    if (char === 'n') return this.parseLiteral('null', null);
    return this.parseNumber();
  }

  parseObject(depth) {
    this.index += 1;
    this.skipWhitespace();
    const result = Object.create(null);
    const keys = new Set();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      if (this.text[this.index] !== '"') {
        fail('INVALID_REQUEST', 'object key must be a string');
      }
      const key = this.parseString();
      if (keys.has(key)) fail('INVALID_REQUEST', 'duplicate JSON object key');
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') {
        fail('INVALID_REQUEST', 'missing object colon');
      }
      this.index += 1;
      this.skipWhitespace();
      result[key] = this.parseValue(depth + 1);
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === '}') return result;
      if (separator !== ',') {
        fail('INVALID_REQUEST', 'invalid object separator');
      }
      this.skipWhitespace();
    }
    fail('INVALID_REQUEST', 'unterminated object');
  }

  parseArray(depth) {
    this.index += 1;
    this.skipWhitespace();
    const result = [];
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }
    while (this.index < this.text.length) {
      result.push(this.parseValue(depth + 1));
      this.skipWhitespace();
      const separator = this.text[this.index];
      this.index += 1;
      if (separator === ']') return result;
      if (separator !== ',') {
        fail('INVALID_REQUEST', 'invalid array separator');
      }
      this.skipWhitespace();
    }
    fail('INVALID_REQUEST', 'unterminated array');
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        let value;
        try {
          value = JSON.parse(this.text.slice(start, this.index));
        } catch {
          fail('INVALID_REQUEST', 'invalid JSON string');
        }
        if (unicodeScalarLength(value) > this.limits.maxStringLength) {
          fail('INVALID_REQUEST', 'JSON string limit exceeded');
        }
        return value;
      }
      if (code < 0x20) {
        fail('INVALID_REQUEST', 'unescaped string control character');
      }
      if (code === 0x5c) {
        this.index += 1;
        const escaped = this.text[this.index];
        if (escaped === 'u') {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
            fail('INVALID_REQUEST', 'invalid unicode escape');
          }
          this.index += 4;
        } else if (!'"\\/bfnrt'.includes(escaped)) {
          fail('INVALID_REQUEST', 'invalid string escape');
        }
      }
      this.index += 1;
    }
    fail('INVALID_REQUEST', 'unterminated string');
  }

  parseLiteral(literal, value) {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      fail('INVALID_REQUEST', 'invalid JSON literal');
    }
    this.index += literal.length;
    return value;
  }

  parseNumber() {
    const match =
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
        this.text.slice(this.index),
      );
    if (!match) fail('INVALID_REQUEST', 'invalid JSON value');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      fail('INVALID_REQUEST', 'non-finite JSON number');
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      fail('INVALID_REQUEST', 'unsafe JSON integer');
    }
    return value;
  }

  skipWhitespace() {
    while (' \t\r\n'.includes(this.text[this.index] ?? '\0')) {
      this.index += 1;
    }
  }
}

export function strictParseJson(text, limits = LIMITS) {
  return new StrictJsonParser(text, limits).parse();
}

export function encodeFrame(message) {
  const body = Buffer.from(canonicalize(message), 'utf8');
  if (body.length === 0 || body.length > LIMITS.maxFrameBytes) {
    fail('INVALID_REQUEST', 'frame size rejected');
  }
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function decodeFrame(frame) {
  if (frame.length < 4) fail('INVALID_REQUEST', 'incomplete frame prefix');
  const length = frame.readUInt32BE(0);
  if (length === 0 || length > LIMITS.maxFrameBytes) {
    fail('INVALID_REQUEST', 'frame size rejected');
  }
  if (frame.length !== length + 4) {
    fail('INVALID_REQUEST', 'incomplete or trailing frame bytes');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4));
  } catch {
    fail('INVALID_REQUEST', 'invalid UTF-8');
  }
  return strictParseJson(text);
}

export function selectWireVersion(clientRange, pluginRange) {
  for (const range of [clientRange, pluginRange]) {
    if (!Number.isInteger(range?.minimum)
        || !Number.isInteger(range?.maximum)
        || range.minimum < 1 || range.maximum > 65535
        || range.maximum < range.minimum) {
      fail('INVALID_ARGUMENT', 'invalid wire-version range');
    }
  }
  const minimum = Math.max(clientRange.minimum, pluginRange.minimum);
  const maximum = Math.min(clientRange.maximum, pluginRange.maximum);
  return minimum <= maximum ? maximum : null;
}

export function nativeCapabilityRegistry() {
  return structuredClone(CAPABILITY_DESCRIPTORS.full);
}

export function capabilityDigest(registry) {
  const computed = sha256Jcs(registry);
  if (jsonDeepEqual(registry, CAPABILITY_DESCRIPTORS.full)
      && computed !== NATIVE_EXEC_REGISTRY_DIGEST) {
    fail('INVALID_ARGUMENT', 'generated capability digest mismatch');
  }
  return computed;
}
