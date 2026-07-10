import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaRedactor, redactText } from '../src/lib/exactSecretRedaction.js';

test('redaction never emits a secret that collides with the display marker', () => {
  for (const secret of ['[redacted]', 'redacted']) {
    const output = redactText(`before ${secret} after`, [secret]);
    assert.equal(output.includes(secret), false);
  }
});

test('streaming redaction preserves the marker-collision guarantee across chunks', () => {
  const secret = '[redacted]';
  let output = '';
  const redactor = createDeltaRedactor([secret], (text) => { output += text; });
  redactor.feed('[reda');
  redactor.feed('cted]');
  redactor.flush();
  assert.equal(output.includes(secret), false);
});
