import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsExactSecret,
  createByteRedactor,
  createDeltaRedactor,
  redactText,
  redactValue,
} from '../src/lib/exactSecretRedaction.js';

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

test('byte redaction preserves UTF-8 and catches a secret split at every boundary', () => {
  const secret = 'opaque-provider-value';
  const input = Buffer.from(`中文 before ${secret} after 中文`, 'utf8');
  for (let split = 1; split < input.length; split += 1) {
    const chunks = [];
    const redactor = createByteRedactor([secret], (value) => chunks.push(Buffer.from(value)));
    redactor.feed(input.subarray(0, split));
    redactor.feed(input.subarray(split));
    redactor.flush();
    assert.equal(Buffer.concat(chunks).toString('utf8'), '中文 before [redacted] after 中文');
  }
});

test('byte redaction catches JSON-escaped credentials at every boundary', () => {
  for (const secret of ['opaque"provider-secret', 'opaque\\provider-secret']) {
    const input = Buffer.from(JSON.stringify({ text: secret }), 'utf8');
    for (let split = 1; split < input.length; split += 1) {
      const chunks = [];
      const redactor = createByteRedactor([secret], (value) => chunks.push(Buffer.from(value)));
      redactor.feed(input.subarray(0, split));
      redactor.feed(input.subarray(split));
      redactor.flush();
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), { text: '[redacted]' });
    }
  }
});

test('recursive detection inspects decoded values and keys and fails closed on unsafe graphs', () => {
  for (const secret of ['opaque"provider-secret', 'opaque\\provider-secret']) {
    assert.equal(containsExactSecret({ id: secret }, [secret]), true);
    assert.equal(containsExactSecret({ nested: { [secret]: 'safe' } }, [secret]), true);
    assert.equal(containsExactSecret({ id: 'safe-model' }, [secret]), false);
  }
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(containsExactSecret(cyclic, ['provider-secret']), true);
  const inaccessible = {};
  Object.defineProperty(inaccessible, 'metadata', { get() { throw new Error('blocked'); } });
  assert.equal(containsExactSecret(inaccessible, ['provider-secret']), true);
});

test('recursive detection and redaction decode bounded percent and Unicode escapes', () => {
  const secret = 'opaque-provider-secret';
  for (const encoded of [
    'opaque%2dprovider%2dsecret',
    '%6f%70%61%71%75%65%2d%70%72%6f%76%69%64%65%72%2d%73%65%63%72%65%74',
    'opaque\\u002dprovider%2dsecret',
    'opaque%252dprovider%252dsecret',
  ]) {
    assert.equal(containsExactSecret({ id: encoded }, [secret]), true);
    assert.equal(redactValue({ id: encoded }, [secret]).id, '[redacted]');
    assert.equal(redactText(`prefix ${encoded} suffix`, [secret]), '[redacted]');
  }
});

test('structured redaction removes secrets from nested object keys and values', () => {
  const secret = 'opaque-provider-secret';
  const output = redactValue({
    [secret]: 'safe',
    nested: { [secret]: secret },
  }, [secret]);
  const rendered = JSON.stringify(output);
  assert.equal(rendered.includes(secret), false);
  assert.match(rendered, /\[redacted\]/);
  assert.equal(
    JSON.stringify(redactValue({ '[redacted]': 'safe' }, ['[redacted]'])).includes('[redacted]'),
    false,
  );
  assert.equal(redactValue({ pin: 123456 }, ['123456']).pin, '[redacted]');
  assert.equal(redactValue({ enabled: true }, ['true']).enabled, '[redacted]');
  assert.equal(redactValue({ empty: null }, ['null']).empty, '[redacted]');
});
