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

test('createNdjsonReader preserves UTF-8 text across every multibyte chunk boundary', () => {
  const source = `${JSON.stringify({ text: '做个炫酷文字动画' })}\n`;
  const bytes = new TextEncoder().encode(source);

  for (let cut = 1; cut < bytes.length; cut += 1) {
    const messages = [];
    const push = createNdjsonReader((message) => messages.push(message));
    push(bytes.slice(0, cut));
    push(bytes.slice(cut));
    assert.deepEqual(messages, [{ text: '做个炫酷文字动画' }], `cut ${cut}`);
  }
});
