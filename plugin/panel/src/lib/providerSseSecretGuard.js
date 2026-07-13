import { containsExactSecret } from './exactSecretRedaction.js';

const STREAM_TEXT_KEYS = new Set([
  'arguments',
  'content',
  'delta',
  'input_json',
  'output_text',
  'partial_json',
  'reasoning_content',
  'refusal',
  'signature',
  'summary',
  'summary_text',
  'text',
  'thinking',
  'transcript',
]);
const STREAM_CONTROL_KEYS = new Set([
  'content_index',
  'id',
  'index',
  'item_id',
  'message_id',
  'model',
  'object',
  'output_index',
  'response_id',
  'role',
  'status',
  'type',
]);
const STREAM_DISCRIMINATOR_KEYS = new Set([
  'object',
  'role',
  'status',
  'type',
]);
const MAX_STREAM_AGGREGATE_CHARS = 16 * 1024 * 1024;
const MAX_STREAM_PROJECTION_CHARS = MAX_STREAM_AGGREGATE_CHARS * 12;
const STREAM_TOTAL_CHARS = Symbol('stream-total-chars');

function invalidSse(code, message) {
  return Object.assign(new Error(message), { status: 502, code });
}

function payloadIdentity(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return [
    payload.item_id,
    payload.id,
    payload.response?.id,
    payload.message?.id,
    payload.output_index,
    payload.content_index,
    payload.index,
  ].map((value) => String(value ?? '')).join('|');
}

function appendStream(streams, key, value) {
  const next = (streams.get(key) || '') + value;
  const total = (streams.get(STREAM_TOTAL_CHARS) || 0) + value.length;
  if (next.length > MAX_STREAM_AGGREGATE_CHARS || total > MAX_STREAM_PROJECTION_CHARS) {
    throw invalidSse('provider_stream_too_large', 'Provider stream was too large.');
  }
  streams.set(key, next);
  streams.set(STREAM_TOTAL_CHARS, total);
}

function collectStreamingStrings(value, identity, streams, path = []) {
  if (value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)) {
    const text = String(value);
    const leaf = String(path.at(-1) ?? '');
    const pathKey = `path:${identity}:${path.join('.')}`;
    appendStream(streams, pathKey, text);
    const globalPathKey = `global-path:${path.join('.')}`;
    appendStream(streams, globalPathKey, text);
    appendStream(streams, 'global-all-values', text);
    if (!STREAM_DISCRIMINATOR_KEYS.has(leaf)) {
      appendStream(streams, 'global-data-values', text);
      appendStream(streams, 'sse-visible-data-values', text);
      for (const key of streams.keys()) {
        if (typeof key === 'string' && key.startsWith('sse-seed-value:')) {
          appendStream(streams, key, text);
        }
      }
    }
    if (STREAM_TEXT_KEYS.has(leaf)) {
      const semanticKey = `semantic:${identity}`;
      appendStream(streams, semanticKey, text);
      appendStream(streams, 'global-semantic', text);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStreamingStrings(item, identity, streams, [...path, index]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    appendStream(streams, 'global-all-keys', key);
    if (!STREAM_CONTROL_KEYS.has(key)) {
      appendStream(streams, 'global-data-keys', key);
      appendStream(streams, 'global-data-key-values', key);
      if (item === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof item)) {
        appendStream(streams, 'global-data-key-values', String(item));
      }
    }
    collectStreamingStrings(item, identity, streams, [...path, key]);
  }
}

export function requireCredentialFreeSse(data, secrets = [], {
  maxFrameBytes = 1024 * 1024,
  seedValues = [],
} = {}) {
  const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data || '');
  if (bytes.length > MAX_STREAM_AGGREGATE_CHARS) {
    throw invalidSse('provider_stream_too_large', 'Provider stream was too large.');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw invalidSse('provider_stream_invalid_utf8', 'Provider stream was not valid UTF-8.');
  }
  const frames = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n/);
  const streams = new Map();
  for (const [index, value] of Array.from(seedValues || []).entries()) {
    const textValue = String(value);
    appendStream(streams, `sse-seed-value:${index}`, textValue);
    appendStream(streams, 'sse-visible-data-values', textValue);
  }
  for (const frame of frames) {
    if (!frame) continue;
    if (Buffer.byteLength(frame, 'utf8') > maxFrameBytes) {
      throw invalidSse('provider_stream_frame_too_large', 'Provider stream frame was too large.');
    }
    if (containsExactSecret(frame, secrets)) {
      throw invalidSse('provider_stream_credential_reflection', 'Provider stream metadata was rejected.');
    }
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) {
        const comment = line.slice(1).replace(/^ /, '');
        appendStream(streams, 'sse-comments', comment);
        appendStream(streams, 'sse-non-data-values', comment);
        appendStream(streams, 'sse-visible-data-values', comment);
        continue;
      }
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      const fieldValue = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
      if (field === 'data') {
        dataLines.push(fieldValue);
        continue;
      }
      appendStream(streams, `sse-field:${field}`, fieldValue);
      appendStream(streams, 'sse-field-names', field);
      appendStream(streams, 'sse-non-data-values', fieldValue);
      appendStream(streams, 'sse-non-data-key-values', field + fieldValue);
      appendStream(streams, 'sse-visible-data-values', fieldValue);
    }
    if (!dataLines.length) continue;
    const payloadText = dataLines.join('\n');
    if (payloadText.trim() === '[DONE]') continue;
    let payload;
    try { payload = JSON.parse(payloadText); } catch {
      throw invalidSse('provider_stream_invalid_json', 'Provider stream contained invalid JSON.');
    }
    if (containsExactSecret(payload, secrets)) {
      throw invalidSse('provider_stream_credential_reflection', 'Provider stream metadata was rejected.');
    }
    collectStreamingStrings(payload, payloadIdentity(payload), streams);
  }
  for (const [key, value] of streams) {
    if (key === STREAM_TOTAL_CHARS) continue;
    if (containsExactSecret(value, secrets)) {
      throw invalidSse('provider_stream_credential_reflection', 'Provider stream metadata was rejected.');
    }
  }
}
