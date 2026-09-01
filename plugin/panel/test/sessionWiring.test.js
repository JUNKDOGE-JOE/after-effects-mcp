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
  assert.match(APP, /installBeforeUnloadReset\([\s\S]*?window,[\s\S]*?\[codexBackend, openCodeBackend, claudeBackend\],[\s\S]*?\(\) => sessionController\.flush\(\)/);
  assert.match(APP, /if \(pendingSessionLoadRef\.current\) return;/);
  assert.match(APP, /selectBackend: async \(backend\)/);
});

test('chat screen exposes session history and new-session actions', () => {
  assert.match(CHAT_SCREEN, /icon="history"[\s\S]*?title=\{sessionTitle\}[\s\S]*?onClick=\{onOpenSessions\}/);
  assert.match(CHAT_SCREEN, /icon="plus"[\s\S]*?onClick=\{\(\) => onNewSession\(\)\}/);
  assert.match(APP, /sessionTitle=\{sessionTitle\}/);
  assert.match(APP, /onOpenSessions=\{\(\) => setSessionsOpen\(true\)\}/);
});

test('ChatScreen new-session actions discard component click events', () => {
  assert.match(CHAT_SCREEN, /icon="plus"[\s\S]*?onClick=\{\(\) => onNewSession\(\)\}/);
  assert.match(CHAT_SCREEN, /onAction=\{onNoticeAction \|\| \(\(\) => onNewSession\(\)\)\}/);
  assert.match(CHAT_SCREEN, /onAction=\{attachmentDraft\.dispatchState === 'uncertain' \? \(\) => onNewSession\(\) : null\}/);
  assert.doesNotMatch(CHAT_SCREEN, /on(?:Click|Action)=\{onNewSession\}/);
});

test('OpenCode pending probes become retryable and stale rechecks reset idle runtime', () => {
  assert.match(APP, /PROBE_PENDING_GRACE_MS = 8000/);
  assert.match(APP, /setTimeout\(\(\) => setOpenCodeProbeStale\(true\), PROBE_PENDING_GRACE_MS\)/);
  assert.match(APP, /openCodeProbe === null && openCodeProbeStale && !chatStreaming[\s\S]*?openCodeBackend\.reset\(\)/);
  assert.match(APP, /openCodeProbe === null && !openCodeProbeStale/);
});

test('model preferences are channel-scoped and Codex waits for live model facts', () => {
  assert.doesNotMatch(APP, /['"]ae_mcp_model['"]/);
  assert.match(APP, /providerFactsPending:[\s\S]*backendPref === 'codex'[\s\S]*codexProbe === null[\s\S]*codexModels === null/);
});

test('model chips persist the selected model as the current channel default', () => {
  assert.match(APP, /onChipModel=\{\(m\) => \{ setSessionModel\(m\); setModel\(m\); writePref\(modelPreferenceKey\(backendPref\), m\); \}\}/);
  assert.match(APP, /onChipEffort=\{setSessionEffort\}/);
  assert.match(APP, /onChipFast=\{\(v\) => setSessionFast\(Boolean\(v\)\)\}/);
});

test('turn progress is reduced in App and rendered below the transcript', () => {
  assert.match(APP, /const \[turnStage, setTurnStage\] = React\.useState\(null\)/);
  assert.match(APP, /setTurnStage\(\(current\) => reduceTurnStage\(current, evt,/);
  assert.match(APP, /setTurnStage\('connect'\);[\s\S]*?activeBackend\.sendUser\(turn\)/);
  assert.match(APP, /turnStage=\{turnStage\}[\s\S]*?turnBackend=\{effective\.backend\}/);
  assert.match(CHAT_SCREEN, /\[entries, streaming, thinking, turnStage, turnProgress\]/);
  assert.match(CHAT_SCREEN, /streaming && thinking[\s\S]*?turnProgress[\s\S]*?turnProgressText\(turnProgress\?\.stage \|\| turnStage, turnBackend, lang\)/);
  assert.match(CHAT_SCREEN, /estimatedTokens/);
  assert.match(CHAT_SCREEN, /progressWarning/);
  assert.match(APP, /turn-progress-warning/);
});

test('running session navigation requires confirmation and stops the current task', () => {
  assert.match(APP, /confirmChatNavigation/);
  assert.match(APP, /当前任务仍在运行|A task is still running/);
  assert.match(APP, /activeBackend\?\.stop\(\)/);
  assert.match(APP, /stopTaskConfirm/);
});

test('host approval policy sync failure is visible and blocks new sends', () => {
  assert.match(APP, /hostConversationError/);
  assert.match(APP, /审批档位未同步|Approval mode is not synced/);
  assert.match(APP, /composerDisabled[\s\S]*Boolean\(hostConversationError\)/);
  assert.match(APP, /runHostConversationSync[\s\S]*hostConversation\.updatePolicy/);
});

test('SessionDrawer uses inline rename and two-step delete without window.confirm', () => {
  assert.match(DRAWER, /event\.key === 'Enter'/);
  assert.match(DRAWER, /event\.key === 'Escape'/);
  assert.match(DRAWER, /variant="danger" size="sm"/);
  assert.doesNotMatch(DRAWER, /window\.confirm/);
});
