import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reduceEvent, userTurnEntry } from '../src/lib/chatEntries.js';

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

test('turn-accepted appends only redacted display attachment metadata', () => {
  const entry = userTurnEntry({
    turnId: 'turn-1',
    text: '',
    attachments: [{
      id: 'att-1',
      name: 'clip.bin',
      localPath: '/tmp/private/clip.bin',
      size: 3,
      mediaType: 'application/octet-stream',
      temporary: true,
    }],
  });

  assert.equal(entry.type, 'user-text');
  assert.deepEqual(entry.attachments, [{
    id: 'att-1',
    name: 'clip.bin',
    size: 3,
    mediaType: 'application/octet-stream',
  }]);
  assert.equal(JSON.stringify(entry).includes('/tmp/private'), false);
  assert.equal(JSON.stringify(entry).includes('temporary'), false);
});

test('turn-accepted alone never invents a transcript entry', () => {
  const existing = [{ id: 'ai-1', type: 'ai-text', text: 'before' }];
  assert.equal(
    reduceEvent(existing, { type: 'turn-accepted', turnId: 'turn-1' }),
    existing,
  );
});

test('external approvals render as high risk without session allowance', () => {
  const source = readFileSync(new URL('../src/screens/ChatScreen.jsx', import.meta.url), 'utf8');
  assert.match(source, /entry\.risk === 'destructive'\s*\|\|\s*entry\.risk === 'external'/);
  assert.match(source, /onAllowSession=\{highRisk \? null/);

  const entries = reduceEvent([], {
    type: 'approval-required',
    toolUseId: 'u5',
    name: 'ae.toolUse',
    input: {},
    risk: 'external',
  });
  assert.equal(entries[0].risk, 'external');
});

test('user attachment bubbles render display metadata without path-bearing fields', () => {
  const chat = readFileSync(new URL('../src/screens/ChatScreen.jsx', import.meta.url), 'utf8');
  const bubble = readFileSync(new URL('../src/components/chat/ChatBubble.jsx', import.meta.url), 'utf8');
  assert.match(chat, /attachments=\{entry\.attachments\}/);
  assert.match(bubble, /attachment\.name/);
  assert.match(bubble, /formatAttachmentBytes\(attachment\.size\)/);
  assert.doesNotMatch(bubble, /localPath|temporary|manifest|transport/);
});
