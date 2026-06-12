import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineSplitter, createNdjsonReader } from '../src/lib/ndjson.js';

test('createLineSplitter emits every complete line in a chunk', () => {
  const lines = [];
  const push = createLineSplitter((line) => lines.push(line));

  push('one\ntwo\nthree\n');

  assert.deepEqual(lines, ['one', 'two', 'three']);
});

test('createLineSplitter buffers lines torn across chunks', () => {
  const lines = [];
  const push = createLineSplitter((line) => lines.push(line));

  push('{"a":');
  assert.deepEqual(lines, []);
  push('1}\n{"b":2}\n');

  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test('createLineSplitter trims CRLF and skips blank lines', () => {
  const lines = [];
  const push = createLineSplitter((line) => lines.push(line));

  push('one\r\n\r\n  \ntwo\r\n');

  assert.deepEqual(lines, ['one', 'two']);
});

test('createNdjsonReader parses JSON lines and skips contamination', () => {
  const messages = [];
  const push = createNdjsonReader((message) => messages.push(message));

  push('{"t":"ready"}\nnot json at all\n{"t":"event","n":2}\n');

  assert.deepEqual(messages, [{ t: 'ready' }, { t: 'event', n: 2 }]);
});
