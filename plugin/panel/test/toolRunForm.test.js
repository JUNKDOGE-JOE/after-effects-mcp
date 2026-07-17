import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolArgs, initialToolArgs, toolArgFields } from '../src/lib/toolRunForm.js';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', default: 'Layer' },
    count: { type: 'integer', minimum: 1, maximum: 5 },
    enabled: { type: 'boolean', default: true },
    mode: { type: 'string', enum: ['safe', 'fast'] },
  },
  required: ['count', 'mode'],
  additionalProperties: false,
};

test('schema form derives deterministic fields and defaults', () => {
  assert.deepEqual(initialToolArgs(schema), {
    name: 'Layer', count: '', enabled: true, mode: '',
  });
  assert.deepEqual(toolArgFields(schema).map(({ name, type, required, supported }) => ({
    name, type, required, supported,
  })), [
    { name: 'name', type: 'string', required: false, supported: true },
    { name: 'count', type: 'integer', required: true, supported: true },
    { name: 'enabled', type: 'boolean', required: false, supported: true },
    { name: 'mode', type: 'string', required: true, supported: true },
  ]);
});

test('schema form coerces bounded values and rejects missing or invalid input', () => {
  assert.deepEqual(buildToolArgs(schema, {
    name: 'Layer', count: '2', enabled: false, mode: 'safe',
  }), { name: 'Layer', count: 2, enabled: false, mode: 'safe' });
  assert.throws(() => buildToolArgs(schema, { count: '', mode: 'safe' }), /count/);
  assert.throws(() => buildToolArgs(schema, { count: '7', mode: 'safe' }), /maximum/);
  assert.throws(() => buildToolArgs(schema, { count: '2', mode: 'unsafe' }), /enum/);
});
