import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backendLabel,
  deriveTitle,
  displayTitle,
  filterSessions,
  relativeTime,
  sortSessions,
} from '../src/lib/sessionList.js';

test('deriveTitle compacts whitespace and truncates after forty characters', () => {
  assert.equal(deriveTitle([{ type: 'ai-text', text: 'skip' }, { type: 'user-text', text: '  hello\n  AE  ' }]), 'hello AE');
  assert.equal(deriveTitle([{ type: 'user-text', text: '12345678901234567890123456789012345678901' }]), '1234567890123456789012345678901234567890…');
  assert.equal(deriveTitle([{ type: 'ai-text', text: 'only assistant' }]), null);
});

test('session sorting and filtering are deterministic and case-insensitive', () => {
  const sessions = [
    { id: 'chat-a', title: 'First Edit', updatedAt: '2026-08-20T10:00:00.000Z', archived: false },
    { id: 'chat-b', title: 'Second Pass', updatedAt: '2026-08-22T10:00:00.000Z', archived: true },
    { id: 'chat-c', title: 'Final edit', updatedAt: '2026-08-21T10:00:00.000Z', archived: false },
  ];
  assert.deepEqual(sortSessions(sessions).map((item) => item.id), ['chat-b', 'chat-c', 'chat-a']);
  assert.deepEqual(filterSessions(sessions, { archived: false, search: 'EDIT' }).map((item) => item.id), ['chat-a', 'chat-c']);
  assert.deepEqual(filterSessions(sessions, { archived: true, search: '' }).map((item) => item.id), ['chat-b']);
});

test('relativeTime and empty titles are localized', () => {
  const now = Date.parse('2026-08-22T12:00:00.000Z');
  assert.equal(relativeTime(now - 10_000, now, 'zh'), '刚刚');
  assert.equal(relativeTime(now - 5 * 60_000, now, 'zh'), '5 分钟前');
  assert.equal(relativeTime(now - 2 * 3_600_000, now, 'en'), '2h ago');
  assert.equal(relativeTime(now - 3 * 86_400_000, now, 'en'), '3d ago');
  assert.match(relativeTime(now - 8 * 86_400_000, now, 'zh'), /2026/);
  assert.match(displayTitle({ title: null, createdAt: now }, 'zh'), /^新会话 · /);
  assert.match(displayTitle({ title: '', createdAt: now }, 'en'), /^New session · /);
  assert.equal(displayTitle(null, 'zh'), '新会话');
  assert.equal(displayTitle({ title: null }, 'en'), 'New session');
  assert.equal(backendLabel('subscription', 'zh'), 'Claude');
  assert.equal(backendLabel('opencode', 'en'), 'OpenCode');
});

