import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionController, sanitizeRestored } from '../src/lib/sessionController.js';
import { decideBackendReset } from '../src/lib/backendResetDecision.js';

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function meta(id, backend = 'codex', overrides = {}) {
  return {
    id,
    title: 'Saved',
    titleSource: 'auto',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    backend,
    channel: backend === 'codex' ? 'cli' : 'subscription',
    model: 'model-1',
    backendRef: { kind: backend === 'codex' ? 'codex-thread' : 'claude-session', id: 'remote-1' },
    archived: false,
    entryCount: 1,
    ...overrides,
  };
}

function harness({
  index,
  transcripts = {},
  backend = 'codex',
  sessionRef = null,
  selectBackendImpl = null,
} = {}) {
  const calls = [];
  const savedIndexes = [];
  const savedTranscripts = [];
  const deleted = [];
  const timers = [];
  let entries = [];
  let currentBackend = backend;
  let backendRefs = {};
  let resetCount = 0;
  let uuidSequence = 0;
  let clock = Date.parse('2026-08-22T00:00:00.000Z');
  const store = {
    loadIndex() {
      calls.push('load-index');
      return index || { version: 1, activeId: null, sessions: [] };
    },
    saveIndex(value) {
      calls.push('save-index');
      savedIndexes.push(copy(value));
    },
    loadTranscript(id) {
      calls.push(`load:${id}`);
      return transcripts[id] || null;
    },
    saveTranscript(id, value) {
      calls.push(`persist:${id}`);
      savedTranscripts.push({ id, entries: copy(value) });
    },
    deleteTranscript(id) {
      calls.push(`delete:${id}`);
      deleted.push(id);
    },
  };
  const deps = {
    stopActiveTurn: async () => { calls.push('stop'); },
    resetActiveBackend: () => {
      calls.push('reset');
      resetCount += 1;
      backendRefs = {};
    },
    cancelPendingUi: () => { calls.push('cancel-ui'); },
    rotateHostConversation: (id) => { calls.push(`rotate:${id}`); },
    adoptBackendRef: (name, ref) => {
      calls.push(`adopt:${name}:${ref?.id || 'null'}`);
      backendRefs[name] = ref;
    },
    getBackendRef: () => sessionRef,
    setEntries(value) {
      entries = copy(value);
      calls.push(`set:${entries.length}`);
    },
    getEntries: () => entries,
    async selectBackend(value) {
      calls.push(`select:${value}`);
      if (selectBackendImpl) {
        await selectBackendImpl({
          value,
          currentBackend: () => currentBackend,
          setCurrentBackend(next) { currentBackend = next; },
          resetActiveBackend: deps.resetActiveBackend,
        });
      } else {
        currentBackend = value;
      }
    },
    currentBackend: () => currentBackend,
    currentModel: () => 'model-1',
    currentChannel: () => (currentBackend === 'codex' ? 'cli' : 'subscription'),
    log: (line) => calls.push(`log:${line}`),
  };
  const controller = createSessionController({
    store,
    deps,
    now: () => clock,
    uuid: () => `uuid-${++uuidSequence}`,
    setTimeoutImpl(fn, ms) {
      const token = { fn, ms, cancelled: false };
      timers.push(token);
      return token;
    },
    clearTimeoutImpl(token) {
      token.cancelled = true;
    },
  });
  return {
    controller,
    calls,
    savedIndexes,
    savedTranscripts,
    deleted,
    timers,
    get entries() { return entries; },
    get backendRefs() { return copy(backendRefs); },
    get resetCount() { return resetCount; },
    setClock(value) { clock = value; },
  };
}

test('boot restores a matching active session and adopts its backend reference', async () => {
  const saved = meta('chat-saved');
  const h = harness({
    index: { version: 1, activeId: saved.id, sessions: [saved] },
    transcripts: { [saved.id]: { version: 1, id: saved.id, entries: [{ type: 'question', state: 'pending' }] } },
  });
  await h.controller.boot();
  assert.equal(h.controller.snapshot().activeId, saved.id);
  assert.equal(h.entries[0].state, 'cancelled');
  assert.ok(h.calls.includes('adopt:codex:remote-1'));
  assert.ok(h.calls.includes('rotate:chat-saved'));
});

test('boot creates an unpersisted draft for missing or backend-mismatched active sessions', async () => {
  for (const setup of [
    undefined,
    { version: 1, activeId: 'chat-claude', sessions: [meta('chat-claude', 'subscription')] },
  ]) {
    const h = harness({ index: setup, backend: 'codex' });
    await h.controller.boot();
    assert.match(h.controller.snapshot().activeId, /^chat-uuid-/);
    assert.equal(h.controller.snapshot().sessions.length, setup ? 1 : 0);
    assert.equal(h.savedIndexes.at(-1).activeId, null);
  }
});

test('createSession and switchTo settle the old session before loading and adopting', async () => {
  const first = meta('chat-first');
  const second = meta('chat-second', 'subscription');
  const h = harness({
    index: { version: 1, activeId: first.id, sessions: [first, second] },
    transcripts: {
      [first.id]: { version: 1, id: first.id, entries: [{ type: 'user-text', text: 'one' }] },
      [second.id]: { version: 1, id: second.id, entries: [{ type: 'user-text', text: 'two' }] },
    },
  });
  await h.controller.boot();
  h.calls.length = 0;
  await h.controller.switchTo(second.id);
  const ordered = h.calls.filter((call) => (
    ['stop', 'reset', 'cancel-ui'].includes(call)
    || call.startsWith('persist:')
    || call.startsWith('select:')
    || call.startsWith('load:')
    || call.startsWith('adopt:')
    || call.startsWith('rotate:')
  ));
  assert.deepEqual(ordered, [
    'persist:chat-first',
    'stop',
    'reset',
    'cancel-ui',
    'persist:chat-first',
    'select:subscription',
    'load:chat-second',
    'adopt:subscription:remote-1',
    'rotate:chat-second',
  ]);

  h.calls.length = 0;
  await h.controller.createSession();
  assert.deepEqual(h.calls.filter((call) => ['stop', 'reset', 'cancel-ui'].includes(call) || call.startsWith('persist:')).slice(0, 5), [
    'persist:chat-second', 'stop', 'reset', 'cancel-ui', 'persist:chat-second',
  ]);
});

test('switchTo adopts the target backend reference after an asynchronous probe transition', async () => {
  const first = meta('chat-first', 'subscription');
  const second = meta('chat-second', 'codex', {
    backendRef: { kind: 'codex-thread', id: 'thread-second' },
  });
  let releaseProbe;
  const probePending = new Promise((resolve) => { releaseProbe = resolve; });
  let probeStarted;
  const started = new Promise((resolve) => { probeStarted = resolve; });
  let lastReal = 'subscription';
  const h = harness({
    backend: 'subscription',
    index: { version: 1, activeId: first.id, sessions: [first, second] },
    transcripts: {
      [first.id]: { version: 1, id: first.id, entries: [{ type: 'user-text', text: 'one' }] },
      [second.id]: { version: 1, id: second.id, entries: [{ type: 'user-text', text: 'two' }] },
    },
    async selectBackendImpl({ value, setCurrentBackend, resetActiveBackend }) {
      lastReal = value;
      setCurrentBackend('none');
      probeStarted();
      await probePending;
      const decision = decideBackendReset({
        lastReal,
        effective: value,
        selectedPref: value,
        pendingSessionLoad: second.id,
      });
      lastReal = decision.nextReal;
      if (decision.reset) resetActiveBackend();
      setCurrentBackend(value);
    },
  });
  await h.controller.boot();
  const switching = h.controller.switchTo(second.id);
  await started;
  assert.equal(h.backendRefs.codex, undefined);
  releaseProbe();
  await switching;

  assert.equal(h.resetCount, 1);
  assert.deepEqual(h.backendRefs.codex, { kind: 'codex-thread', id: 'thread-second' });
});

test('entries materialize the draft, derive a title, and manual rename remains authoritative', async () => {
  const h = harness();
  await h.controller.boot();
  assert.equal(h.controller.snapshot().sessions.length, 0);
  h.controller.recordEntries([{ type: 'user-text', text: '  Build   a comp  ' }]);
  assert.equal(h.controller.snapshot().sessions[0].title, 'Build a comp');
  h.controller.rename(h.controller.snapshot().activeId, 'Manual title');
  h.controller.recordEntries([{ type: 'user-text', text: 'Different first message' }]);
  assert.equal(h.controller.snapshot().sessions[0].title, 'Manual title');
  assert.equal(h.controller.snapshot().sessions[0].titleSource, 'manual');
});

test('backend references save immediately and persistence can capture the current backend reference', async () => {
  const h = harness({ sessionRef: { kind: 'codex-thread', id: 'thread-current' } });
  await h.controller.boot();
  h.controller.recordEntries([{ type: 'user-text', text: 'hello' }], { type: 'turn-end' });
  assert.deepEqual(h.controller.snapshot().sessions[0].backendRef, {
    kind: 'codex-thread',
    id: 'thread-current',
  });

  h.controller.recordBackendRef({ kind: 'codex-thread', id: 'thread-event' });
  assert.equal(h.savedIndexes.at(-1).sessions[0].backendRef.id, 'thread-event');
});

test('archive and remove create a replacement before changing the current session', async () => {
  const current = meta('chat-current');
  const h = harness({
    index: { version: 1, activeId: current.id, sessions: [current] },
    transcripts: { [current.id]: { version: 1, id: current.id, entries: [{ type: 'user-text', text: 'one' }] } },
  });
  await h.controller.boot();
  await h.controller.archive(current.id);
  assert.notEqual(h.controller.snapshot().activeId, current.id);
  assert.equal(h.controller.snapshot().sessions.find((item) => item.id === current.id).archived, true);

  const replacement = h.controller.snapshot().activeId;
  h.controller.recordEntries([{ type: 'user-text', text: 'replacement' }], { type: 'turn-end' });
  const ref = await h.controller.remove(replacement);
  assert.equal(ref, null);
  assert.notEqual(h.controller.snapshot().activeId, replacement);
  assert.ok(h.deleted.includes(replacement));
});

test('recordEntries debounces ordinary updates and flushes turn settlement immediately', async () => {
  const h = harness();
  await h.controller.boot();
  h.savedTranscripts.length = 0;
  h.controller.recordEntries([{ type: 'user-text', text: 'hello' }]);
  assert.equal(h.savedTranscripts.length, 0);
  assert.equal(h.timers.at(-1).ms, 400);
  h.timers.at(-1).fn();
  assert.equal(h.savedTranscripts.length, 1);
  h.controller.recordEntries([{ type: 'user-text', text: 'hello' }, { type: 'ai-text', text: 'done' }], { type: 'turn-end' });
  assert.equal(h.savedTranscripts.length, 2);
});

test('sanitizeRestored cancels non-resumable UI state and clears streaming flags', () => {
  assert.deepEqual(sanitizeRestored([
    { type: 'tool-call', state: 'awaiting-approval' },
    { type: 'question', state: 'pending' },
    { type: 'ai-text', state: 'streaming', streaming: true, isStreaming: true },
  ]), [
    { type: 'tool-call', state: 'denied' },
    { type: 'question', state: 'cancelled' },
    { type: 'ai-text', state: 'complete', streaming: false, isStreaming: false },
  ]);
});
