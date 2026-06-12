import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceEvent } from '../src/lib/chatEntries.js';

test('text deltas merge into one ai-text entry', () => {
  let entries = [];
  entries = reduceEvent(entries, { type: 'turn-start' });
  entries = reduceEvent(entries, { type: 'text-delta', text: 'Hello' });
  entries = reduceEvent(entries, { type: 'text-delta', text: ', AE' });
  entries = reduceEvent(entries, { type: 'turn-end', stopReason: 'end_turn' });
  assert.deepEqual(entries, [{ id: 'ai-1', type: 'ai-text', text: 'Hello, AE' }]);
});

test('tool-start to approval-required to tool-result updates one tool-call entry', () => {
  let entries = [];
  entries = reduceEvent(entries, { type: 'tool-start', toolUseId: 'u1', name: 'ae.createText', input: { text: 'Title' } });
  entries = reduceEvent(entries, { type: 'approval-required', toolUseId: 'u1', name: 'ae.createText', input: { text: 'Title' }, risk: 'write' });
  entries = reduceEvent(entries, { type: 'tool-result', toolUseId: 'u1', ok: true, text: 'created', durationMs: 12 });
  assert.deepEqual(entries, [{
    id: 'u1',
    type: 'tool-call',
    toolUseId: 'u1',
    name: 'ae.createText',
    input: { text: 'Title' },
    risk: 'write',
    state: 'ok',
    ok: true,
    text: 'created',
    durationMs: 12,
  }]);
});

test('tool-denied marks a pending tool as denied', () => {
  let entries = [];
  entries = reduceEvent(entries, { type: 'tool-start', toolUseId: 'u2', name: 'ae.exec', input: {} });
  entries = reduceEvent(entries, { type: 'approval-required', toolUseId: 'u2', name: 'ae.exec', input: {}, risk: 'destructive' });
  entries = reduceEvent(entries, { type: 'tool-denied', toolUseId: 'u2' });
  assert.equal(entries[0].state, 'denied');
  assert.equal(entries[0].risk, 'destructive');
});

test('tool-allowed marks a pending approval as running', () => {
  let entries = [];
  entries = reduceEvent(entries, { type: 'approval-required', toolUseId: 'u4', name: 'ae.exec', input: {}, risk: 'destructive' });
  entries = reduceEvent(entries, { type: 'tool-allowed', toolUseId: 'u4' });
  assert.equal(entries[0].state, 'running');
  assert.equal(entries[0].risk, 'destructive');
});

test('failed tool-result marks a tool as error with returned text', () => {
  let entries = [];
  entries = reduceEvent(entries, { type: 'tool-start', toolUseId: 'u3', name: 'ae.rename', input: {} });
  entries = reduceEvent(entries, { type: 'tool-result', toolUseId: 'u3', ok: false, text: 'Layer locked', durationMs: 5 });
  assert.equal(entries[0].state, 'error');
  assert.equal(entries[0].text, 'Layer locked');
});

test('error event appends an error entry', () => {
  const entries = reduceEvent([], { type: 'error', kind: 'auth', message: 'Invalid key' });
  assert.deepEqual(entries, [{ id: 'error-1', type: 'error', kind: 'auth', message: 'Invalid key' }]);
});
