import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/app/App.jsx', import.meta.url), 'utf8');
const STATUS_BAR = readFileSync(new URL('../src/components/shell/StatusBar.jsx', import.meta.url), 'utf8');
const DRAWER = readFileSync(new URL('../src/screens/SessionDrawer.jsx', import.meta.url), 'utf8');
const CHAT_SCREEN = readFileSync(new URL('../src/screens/ChatScreen.jsx', import.meta.url), 'utf8');

test('App constructs and boots the session controller with persistent CEP storage', () => {
  assert.match(APP, /createSessionStore\(\{[\s\S]*?platform/);
  assert.match(APP, /createSessionController\(\{/);
  assert.match(APP, /sessionController\.boot\(\)/);
  assert.match(APP, /sessionController\.subscribe\(setSessionSnapshot\)/);
});

test('chat events persist reduced entries and capture backend session references', () => {
  assert.match(APP, /sessionControllerRef\.current\?\.recordEntries\(chatEntriesRef\.current, event\)/);
  assert.match(APP, /evt\.type === 'session-ref'[\s\S]*?recordBackendRef\(evt\.ref\)/);
  assert.match(APP, /reduceEvent\(entries, evt\)/);
  assert.match(CHAT_SCREEN, /key=\{entry\.sid \|\| entry\.id\}/);
});

test('status bar and session drawer are wired to the controller actions', () => {
  assert.match(APP, /<StatusBar[\s\S]*?onSessions=\{\(\) => setSessionsOpen\(true\)\}/);
  assert.match(APP, /<SessionDrawer[\s\S]*?sessions=\{sessionSnapshot\.sessions\}[\s\S]*?onSwitch=\{switchChatSession\}/);
  assert.match(STATUS_BAR, /icon="history"[\s\S]*?<PauseButton/);
});

test('unload flushes first and controlled backend switches guard restored entries', () => {
  assert.match(APP, /installBeforeUnloadReset\(window, codexBackend, \(\) => sessionController\.flush\(\)\)/);
  assert.match(APP, /if \(pendingSessionLoadRef\.current\) return;/);
  assert.match(APP, /selectBackend: async \(backend\)/);
});

test('SessionDrawer uses inline rename and two-step delete without window.confirm', () => {
  assert.match(DRAWER, /event\.key === 'Enter'/);
  assert.match(DRAWER, /event\.key === 'Escape'/);
  assert.match(DRAWER, /variant="danger" size="sm"/);
  assert.doesNotMatch(DRAWER, /window\.confirm/);
});
