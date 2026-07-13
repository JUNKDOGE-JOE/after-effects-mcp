import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireCredentialFreeSse } from '../src/lib/providerSseSecretGuard.js';

function sse(...payloads) {
  return Buffer.from(payloads.map((payload) => `data: ${payload}\n\n`).join(''), 'utf8');
}

test('SSE guard rejects Unicode and percent encoded credential reflections', () => {
  const secret = 'opaque-provider-secret';
  for (const payload of [
    '{"type":"response.output_text.delta","delta":"opaque-provider\\u002dsecret"}',
    '{"type":"response.output_text.delta","delta":"opaque%2dprovider-secret"}',
    '{"type":"response.output_text.delta","delta":"%6f%70%61%71%75%65%2dprovider%2dsecret"}',
    '{"type":"response.output_text.delta","delta":"opaque\\u002dprovider%2dsecret"}',
  ]) {
    assert.throws(
      () => requireCredentialFreeSse(sse(payload), [secret]),
      (error) => error.code === 'provider_stream_credential_reflection',
    );
  }
});

test('SSE guard rejects credentials split across semantic events at every byte boundary', () => {
  const secret = 'opaque-provider-secret';
  const transcript = sse(
    JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { content: 'opaque-provider-' } }] }),
    JSON.stringify({ id: 'chat-1', choices: [{ index: 0, delta: { content: 'secret' } }] }),
    '[DONE]',
  );
  for (let split = 1; split < transcript.length; split += 1) {
    const joined = Buffer.concat([transcript.subarray(0, split), transcript.subarray(split)]);
    assert.throws(
      () => requireCredentialFreeSse(joined, [secret]),
      (error) => error.code === 'provider_stream_credential_reflection',
    );
  }
});

test('SSE guard preserves safe unknown JSON events without rewriting them', () => {
  const transcript = sse(
    JSON.stringify({ type: 'future.event', future_field: { preserved: true }, delta: 'safe' }),
    '[DONE]',
  );
  assert.doesNotThrow(() => requireCredentialFreeSse(transcript, ['provider-secret']));
});

test('SSE guard rejects credential reflections in non-data fields and comments', () => {
  const secret = 'opaque-provider-secret';
  for (const transcript of [
    `event: opaque%2dprovider%2dsecret\ndata: {"type":"safe"}\n\n`,
    `id: opaque\\u002dprovider-secret\ndata: {"type":"safe"}\n\n`,
    `: opaque-provider-secret\ndata: {"type":"safe"}\n\n`,
  ]) {
    assert.throws(
      () => requireCredentialFreeSse(Buffer.from(transcript), [secret]),
      (error) => error.code === 'provider_stream_credential_reflection',
    );
  }
});

test('SSE guard joins start and delta text across event types for one item', () => {
  const transcript = sse(
    JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'opaque-' } }),
    JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'provider-secret' } }),
  );
  assert.throws(
    () => requireCredentialFreeSse(transcript, ['opaque-provider-secret']),
    (error) => error.code === 'provider_stream_credential_reflection',
  );
});

test('SSE guard joins unknown metadata strings at a stable path across events', () => {
  const transcript = sse(
    JSON.stringify({ type: 'future.event', metadata: { piece: 'opaque-provider-' } }),
    JSON.stringify({ type: 'future.event', metadata: { piece: 'secret' } }),
  );
  assert.throws(
    () => requireCredentialFreeSse(transcript, ['opaque-provider-secret']),
    (error) => error.code === 'provider_stream_credential_reflection',
  );
});

test('SSE guard does not trust provider-controlled ids to partition unknown metadata', () => {
  const transcript = sse(
    JSON.stringify({ id: 'event-a', metadata: { piece: 'opaque-provider-' } }),
    JSON.stringify({ id: 'event-b', metadata: { piece: 'secret' } }),
  );
  assert.throws(
    () => requireCredentialFreeSse(transcript, ['opaque-provider-secret']),
    (error) => error.code === 'provider_stream_credential_reflection',
  );
});

test('SSE guard joins unknown metadata across different keys and events', () => {
  for (const transcript of [
    sse(JSON.stringify({ type: 'future.event', metadata: {
      left: 'opaque-provider-', right: 'secret',
    } })),
    sse(
      JSON.stringify({ type: 'future.event', metadata: { left: 'opaque-provider-' } }),
      JSON.stringify({ type: 'future.event', metadata: { right: 'secret' } }),
    ),
  ]) {
    assert.throws(
      () => requireCredentialFreeSse(transcript, ['opaque-provider-secret']),
      (error) => error.code === 'provider_stream_credential_reflection',
    );
  }
});

test('SSE guard joins credential fragments across control fields and primitive types', () => {
  for (const [transcript, secret] of [
    [sse(
      JSON.stringify({ type: 'future.event', id: 'opaque-provider-' }),
      JSON.stringify({ type: 'future.event', model: 'secret' }),
    ), 'opaque-provider-secret'],
    [sse(
      JSON.stringify({ type: 'future.event', metadata: { part: 'opaque' } }),
      JSON.stringify({ type: 'future.event', metadata: { part: 123 } }),
    ), 'opaque123'],
  ]) {
    assert.throws(
      () => requireCredentialFreeSse(transcript, [secret]),
      (error) => error.code === 'provider_stream_credential_reflection',
    );
  }
});

test('SSE guard joins credential fragments across comment-only frames', () => {
  const transcript = Buffer.from(': opaque-provider-\n\n: secret\n\n', 'utf8');
  assert.throws(
    () => requireCredentialFreeSse(transcript, ['opaque-provider-secret']),
    (error) => error.code === 'provider_stream_credential_reflection',
  );
});

test('SSE guard joins non-data field fragments with JSON payload values', () => {
  for (const prefix of [':', 'event:', 'id:']) {
    const transcript = Buffer.from(
      `${prefix} opaque-provider-\ndata: ${JSON.stringify({ type: 'future.event', text: 'secret' })}\n\n`,
      'utf8',
    );
    assert.throws(
      () => requireCredentialFreeSse(transcript, ['opaque-provider-secret']),
      (error) => error.code === 'provider_stream_credential_reflection',
    );
  }
});

test('SSE guard keeps the 16 MiB transcript budget independent of projection count', () => {
  const transcript = sse(JSON.stringify({
    type: 'response.output_text.delta',
    delta: 'x'.repeat(3 * 1024 * 1024),
  }));
  assert.doesNotThrow(() => requireCredentialFreeSse(
    transcript,
    ['opaque-provider-secret'],
    { maxFrameBytes: 4 * 1024 * 1024 },
  ));
  assert.throws(
    () => requireCredentialFreeSse(Buffer.alloc(16 * 1024 * 1024 + 1, 0x78), []),
    (error) => error.code === 'provider_stream_too_large',
  );
});
