import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser } from '../src/lib/sse.js';

test('createSseParser parses a frame split across chunks', () => {
  const events = [];
  const parser = createSseParser((evt) => events.push(evt));

  parser.feed('event: message_start\r\ndata: {"type":"message_');
  parser.feed('start","message":{"id":"m1"}}\r\n\r\n');

  assert.deepEqual(events, [{ event: 'message_start', data: { type: 'message_start', message: { id: 'm1' } } }]);
});

test('createSseParser parses multiple frames from one chunk', () => {
  const events = [];
  const parser = createSseParser((evt) => events.push(evt));

  parser.feed('event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\n');

  assert.deepEqual(events, [
    { event: 'a', data: { n: 1 } },
    { event: 'b', data: { n: 2 } },
  ]);
});

test('createSseParser tolerates CRLF and multi-line data fields', () => {
  const events = [];
  const parser = createSseParser((evt) => events.push(evt));

  parser.feed('event: content_block_delta\r\ndata: {"partial":"hel"\r\ndata: ,"tail":"lo"}\r\n\r\n');

  assert.deepEqual(events, [
    { event: 'content_block_delta', data: { partial: 'hel', tail: 'lo' } },
  ]);
});

test('createSseParser ignores non-JSON data and done frames', () => {
  const events = [];
  const parser = createSseParser((evt) => events.push(evt));

  parser.feed('event: ping\ndata: keep-alive\n\ndata: [DONE]\n\nevent: ok\ndata: {"done":true}\n\n');

  assert.deepEqual(events, [{ event: 'ok', data: { done: true } }]);
});
