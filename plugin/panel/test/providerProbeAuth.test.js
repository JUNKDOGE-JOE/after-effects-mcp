import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProtocolAuthCandidates } from '../src/lib/providerProbeAuth.js';

function profile(auth, extraHeaders = []) {
  return { auth, extraHeaders };
}

test('protocol auth candidates preserve the resolved scheme before a bounded standard fallback', () => {
  const resolved = profile({ kind: 'header', name: 'Authorization', value: 'Bearer secret-value' });
  const responses = buildProtocolAuthCandidates(resolved, 'responses');
  const messages = buildProtocolAuthCandidates(resolved, 'messages');

  assert.deepEqual(responses.map((entry) => entry.scheme), ['bearer', 'x-api-key']);
  assert.deepEqual(messages.map((entry) => entry.scheme), ['bearer', 'x-api-key']);
  for (const candidate of [...responses, ...messages]) {
    assert.equal(
      Object.hasOwn(candidate.headers, 'authorization') && Object.hasOwn(candidate.headers, 'x-api-key'),
      false,
    );
  }
  assert.equal(messages[0].headers['anthropic-version'], '2023-06-01');

  const fromApiKey = buildProtocolAuthCandidates(
    profile({ kind: 'header', name: 'x-api-key', value: 'secret-value' }),
    'chat',
  );
  assert.deepEqual(fromApiKey.map((entry) => entry.scheme), ['x-api-key', 'bearer']);
});

test('custom and unauthenticated profiles remain single-candidate schemes', () => {
  assert.deepEqual(buildProtocolAuthCandidates(profile({ kind: 'none' }), 'chat'), [
    { scheme: 'none', headers: {} },
  ]);
  assert.deepEqual(buildProtocolAuthCandidates(profile({ kind: 'header', name: 'x-custom-auth', value: 'opaque' }), 'messages'), [
    {
      scheme: 'custom',
      headers: { 'anthropic-version': '2023-06-01', 'x-custom-auth': 'opaque' },
    },
  ]);
});

test('reserved duplicate auth headers are rejected before a request can be built', () => {
  assert.throws(
    () => buildProtocolAuthCandidates(profile(
      { kind: 'header', name: 'Authorization', value: 'Bearer secret' },
      [{ name: 'x-api-key', value: 'other', source: 'secret' }],
    ), 'responses'),
    (error) => error?.code === 'provider_probe_profile_invalid',
  );
});
