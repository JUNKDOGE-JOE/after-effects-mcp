import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventTitle, eventOutcome, filterEvents } from '../src/lib/activityModel.js';

test('eventTitle formats MCP undo groups with and without a target', () => {
  assert.equal(eventTitle({ undoGroup: 'MCP setProperty: Transform/Position' }, 'en'), 'setProperty · Transform/Position');
  assert.equal(eventTitle({ undoGroup: 'MCP newComp' }, 'en'), 'newComp');
});

test('eventTitle falls back to localized raw script label when undoGroup is empty', () => {
  assert.equal(eventTitle({ undoGroup: null }, 'zh'), '原始脚本');
  assert.equal(eventTitle({}, 'en'), 'Raw script');
});

test('eventOutcome maps denied states before ok/error', () => {
  assert.equal(eventOutcome({ ok: true, denied: 'paused' }), 'denied-paused');
  assert.equal(eventOutcome({ ok: true, denied: 'blocked' }), 'denied-blocked');
  assert.equal(eventOutcome({ ok: true, denied: 'policy' }), 'denied');
  assert.equal(eventOutcome({ ok: true }), 'ok');
  assert.equal(eventOutcome({ ok: false }), 'error');
});

test('filterEvents failed mode includes errors and denied operations', () => {
  const events = [
    { id: 1, ok: true },
    { id: 2, ok: false },
    { id: 3, ok: true, denied: 'paused' },
    { id: 4, ok: true, denied: 'blocked' },
  ];

  assert.deepEqual(filterEvents(events, { mode: 'failed', query: '' }).map((e) => e.id), [2, 3, 4]);
});

test('filterEvents query matches client and error fields', () => {
  const events = [
    { id: 1, ok: true, client: 'Claude Desktop', undoGroup: 'MCP newComp' },
    { id: 2, ok: false, client: 'Cursor', error: 'Layer is locked' },
    { id: 3, ok: true, client: 'Panel' },
  ];

  assert.deepEqual(filterEvents(events, { mode: 'all', query: 'desktop' }).map((e) => e.id), [1]);
  assert.deepEqual(filterEvents(events, { mode: 'all', query: 'LOCKED' }).map((e) => e.id), [2]);
});

test('filterEvents with empty query passes through the same array for all mode', () => {
  const events = [{ id: 1, ok: true }];

  assert.equal(filterEvents(events, { mode: 'all', query: '  ' }), events);
});
