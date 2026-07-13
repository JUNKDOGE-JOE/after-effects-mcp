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

function collectStreamingStrings(value, identity, streams, path = []) {
  if (typeof value === 'string') {
    const leaf = String(path.at(-1) ?? '');
    const pathKey = `path:${identity}:${path.join('.')}`;
    streams.set(pathKey, (streams.get(pathKey) || '') + value);
    const globalPathKey = `global-path:${path.join('.')}`;
    streams.set(globalPathKey, (streams.get(globalPathKey) || '') + value);
    if (STREAM_TEXT_KEYS.has(leaf)) {
      const semanticKey = `semantic:${identity}`;
      streams.set(semanticKey, (streams.get(semanticKey) || '') + value);
      streams.set('global-semantic', (streams.get('global-semantic') || '') + value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStreamingStrings(item, identity, streams, [...path, index]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    collectStreamingStrings(item, identity, streams, [...path, key]);
  }
}

export function requireCredentialFreeSse(data, secrets = [], { maxFrameBytes = 1024 * 1024 } = {}) {
  const bytes = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data || '');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw invalidSse('provider_stream_invalid_utf8', 'Provider stream was not valid UTF-8.');
  }
  const frames = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split(/\n\n/);
  const streams = new Map();
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
      if (line === 'data') dataLines.push('');
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
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
  for (const value of streams.values()) {
    if (containsExactSecret(value, secrets)) {
      throw invalidSse('provider_stream_credential_reflection', 'Provider stream metadata was rejected.');
    }
  }
}
