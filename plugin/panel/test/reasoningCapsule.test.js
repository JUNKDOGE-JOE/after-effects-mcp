import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createReasoningCapsule } from '../src/cep/reasoningCapsule.js';

test('reasoning capsule round-trips protocol-typed items without exposing plaintext', () => {
  const capsule = createReasoningCapsule({ crypto, key: Buffer.alloc(32, 7) });
  const item = { type: 'reasoning', encrypted_content: 'opaque-upstream-value', summary: [] };
  const token = capsule.seal({ sourceProtocol: 'responses', item });
  assert.equal(token.includes('opaque-upstream-value'), false);
  assert.deepEqual(capsule.open(token, { sourceProtocol: 'responses' }), {
    version: 1,
    sourceProtocol: 'responses',
    item,
  });
  capsule.destroy();
});

test('reasoning capsule rejects tampering and cross-protocol replay', () => {
  const capsule = createReasoningCapsule({ crypto, key: Buffer.alloc(32, 9) });
  const token = capsule.seal({ sourceProtocol: 'chat', item: 'hidden reasoning' });
  const parts = token.split('.');
  const index = Math.floor(parts[2].length / 2);
  parts[2] = `${parts[2].slice(0, index)}${parts[2][index] === 'A' ? 'B' : 'A'}${parts[2].slice(index + 1)}`;
  const changed = parts.join('.');
  assert.throws(() => capsule.open(changed), (error) => error.code === 'reasoning_capsule_auth_failed');
  assert.throws(
    () => capsule.open(token, { sourceProtocol: 'messages' }),
    (error) => error.code === 'reasoning_capsule_protocol_mismatch',
  );
  capsule.destroy();
});

test('destroyed reasoning capsule key cannot authenticate prior state', () => {
  const key = Buffer.alloc(32, 11);
  const first = createReasoningCapsule({ crypto, key });
  const token = first.seal({ sourceProtocol: 'messages', item: { type: 'redacted_thinking', data: 'opaque' } });
  first.destroy();
  const second = createReasoningCapsule({ crypto, key: Buffer.alloc(32, 12) });
  assert.throws(() => second.open(token), (error) => error.code === 'reasoning_capsule_auth_failed');
  second.destroy();
});
