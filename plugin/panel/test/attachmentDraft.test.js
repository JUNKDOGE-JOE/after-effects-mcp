import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachmentDropFiles,
  createAttachmentDraftState,
  draftCanSend,
  draftIsBusy,
  readyAttachments,
  reduceAttachmentDraft,
} from '../src/lib/attachmentDraft.js';

function fixtureFile(name = 'clip.bin') {
  return { name, size: 3, type: 'application/octet-stream' };
}

function fixtureRef(overrides = {}) {
  return {
    id: 'att-1',
    name: 'clip.bin',
    localPath: '/tmp/private/clip.bin',
    size: 3,
    mediaType: 'application/octet-stream',
    temporary: true,
    ...overrides,
  };
}

function readyState() {
  let state = createAttachmentDraftState();
  state = reduceAttachmentDraft(state, { type: 'text', value: 'inspect' });
  state = reduceAttachmentDraft(state, {
    type: 'staging',
    pondId: 'p1',
    file: fixtureFile(),
  });
  return reduceAttachmentDraft(state, {
    type: 'ready',
    pondId: 'p1',
    ref: fixtureRef(),
  });
}

test('draft moves one item through staging, ready, error, retry, and remove', () => {
  const file = fixtureFile();
  let state = createAttachmentDraftState();
  state = reduceAttachmentDraft(state, { type: 'staging', pondId: 'p1', file });
  assert.equal(state.items[0].status, 'staging');
  assert.equal(draftIsBusy(state), true);

  state = reduceAttachmentDraft(state, {
    type: 'error',
    pondId: 'p1',
    error: { code: 'ATTACHMENT_STAGING_FAILED', message: 'failed' },
  });
  assert.equal(state.items[0].status, 'error');
  assert.equal(state.items[0].file, file);
  assert.equal(draftCanSend(state), false);

  state = reduceAttachmentDraft(state, { type: 'staging', pondId: 'p1', file });
  state = reduceAttachmentDraft(state, { type: 'ready', pondId: 'p1', ref: fixtureRef() });
  assert.equal(state.items[0].status, 'ready');
  assert.deepEqual(readyAttachments(state), [fixtureRef()]);

  state = reduceAttachmentDraft(state, { type: 'remove', pondId: 'p1' });
  assert.deepEqual(state.items, []);
});

test('attachment-only ready state can send while staging and errors cannot', () => {
  let state = createAttachmentDraftState();
  state = reduceAttachmentDraft(state, {
    type: 'staging',
    pondId: 'p1',
    file: fixtureFile(),
  });
  assert.equal(draftCanSend(state), false);

  state = reduceAttachmentDraft(state, {
    type: 'ready',
    pondId: 'p1',
    ref: fixtureRef(),
  });
  assert.equal(draftCanSend(state), true);
});

test('accepted clears only the matching frozen turn', () => {
  let state = readyState();
  state = reduceAttachmentDraft(state, {
    type: 'sending',
    turnId: 'turn-1',
    turn: {
      turnId: 'turn-1',
      text: state.text,
      attachments: readyAttachments(state),
    },
  });
  assert.equal(draftCanSend(state), false);
  assert.equal(
    reduceAttachmentDraft(state, { type: 'accepted', turnId: 'other' }),
    state,
  );

  const cleared = reduceAttachmentDraft(state, {
    type: 'accepted',
    turnId: 'turn-1',
  });
  assert.equal(cleared.text, '');
  assert.deepEqual(cleared.items, []);
  assert.equal(cleared.pendingTurnId, null);
  assert.equal(cleared.pendingSnapshot, null);
});

test('pre-dispatch rejection preserves text and files', () => {
  let sending = readyState();
  sending = reduceAttachmentDraft(sending, {
    type: 'sending',
    turnId: 'turn-1',
    turn: {
      turnId: 'turn-1',
      text: sending.text,
      attachments: readyAttachments(sending),
    },
  });
  const rejected = reduceAttachmentDraft(sending, {
    type: 'rejected',
    turnId: 'turn-1',
    error: { code: 'BACKEND_UNAVAILABLE', message: 'backend unavailable' },
  });

  assert.equal(rejected.text, sending.text);
  assert.deepEqual(rejected.items, sending.items);
  assert.equal(rejected.pendingTurnId, null);
  assert.equal(rejected.pendingSnapshot, null);
  assert.deepEqual(rejected.sendError, {
    code: 'BACKEND_UNAVAILABLE',
    message: 'backend unavailable',
  });
  assert.equal(draftCanSend(rejected), true);
});

test('uncertain rejection freezes the pending turn and blocks resubmission', () => {
  let sending = readyState();
  sending = reduceAttachmentDraft(sending, {
    type: 'sending',
    turnId: 'turn-1',
    turn: {
      turnId: 'turn-1',
      text: sending.text,
      attachments: readyAttachments(sending),
    },
  });
  const uncertain = reduceAttachmentDraft(sending, {
    type: 'uncertain',
    turnId: 'turn-1',
    error: { code: 'TRANSPORT_LOST', message: 'outcome unknown' },
  });

  assert.equal(uncertain.pendingTurnId, 'turn-1');
  assert.equal(uncertain.dispatchState, 'uncertain');
  assert.equal(draftCanSend(uncertain), false);
  assert.equal(
    reduceAttachmentDraft(uncertain, { type: 'remove', pondId: 'p1' }),
    uncertain,
  );
});

test('stale terminal actions do not change a newer pending draft', () => {
  let state = readyState();
  state = reduceAttachmentDraft(state, {
    type: 'sending',
    turnId: 'turn-2',
    turn: {
      turnId: 'turn-2',
      text: state.text,
      attachments: readyAttachments(state),
    },
  });

  assert.equal(
    reduceAttachmentDraft(state, { type: 'rejected', turnId: 'turn-1', error: {} }),
    state,
  );
  assert.equal(
    reduceAttachmentDraft(state, { type: 'uncertain', turnId: 'turn-1', error: {} }),
    state,
  );
});

test('attachmentDropFiles returns complete file drops and ignores text drops', () => {
  const first = fixtureFile('one.txt');
  const second = fixtureFile('two.mov');
  assert.deepEqual(
    attachmentDropFiles({
      types: ['text/plain', 'Files'],
      files: { 0: first, 1: second, length: 2 },
    }),
    [first, second],
  );
  assert.deepEqual(
    attachmentDropFiles({
      types: ['text/plain'],
      files: { 0: first, length: 1 },
    }),
    [],
  );
});

test('an accepted attachment failure restores files and preserves newly typed text', () => {
  const ready = readyState();
  let state = reduceAttachmentDraft(ready, { type: 'sending', turnId: 'failed' });
  state = reduceAttachmentDraft(state, { type: 'accepted', turnId: 'failed' });
  state = reduceAttachmentDraft(state, { type: 'text', value: 'corrected prompt' });
  assert.equal(reduceAttachmentDraft(state, { type: 'settled', turnId: 'stale' }), state);
  state = reduceAttachmentDraft(state, { type: 'settled', turnId: 'failed', dispatchState: 'not-started', error: { message: 'Provider rejected format' } });
  assert.equal(state.text, 'corrected prompt');
  assert.deepEqual(state.items, ready.items);
  assert.equal(state.sendError.message, 'Provider rejected format');
  assert.equal(draftCanSend(state), true);
  assert.equal(state.acceptedDraft, null);
});

test('accepted attachment failures remain frozen unless execution was ruled out', () => {
  for (const dispatchState of ['uncertain', undefined]) {
    let state = reduceAttachmentDraft(readyState(), { type: 'sending', turnId: 'unknown' });
    state = reduceAttachmentDraft(state, { type: 'accepted', turnId: 'unknown' });
    state = reduceAttachmentDraft(state, { type: 'settled', turnId: 'unknown', dispatchState, error: { message: 'disconnected' } });
    assert.equal(draftCanSend(state), false);
    assert.equal(state.pendingTurnId, 'unknown');
    assert.equal(state.dispatchState, 'uncertain');
    assert.equal(state.pendingSnapshot.turnId, 'unknown');
    assert.equal(state.items.length, 1);
  }
});

test('successful completion clears the retained draft without overwriting the next prompt', () => {
  let state = reduceAttachmentDraft(readyState(), { type: 'sending', turnId: 'ok' });
  state = reduceAttachmentDraft(state, { type: 'accepted', turnId: 'ok' });
  state = reduceAttachmentDraft(state, { type: 'text', value: 'next' });
  state = reduceAttachmentDraft(state, { type: 'settled', turnId: 'ok' });
  assert.equal(state.text, 'next');
  assert.deepEqual(state.items, []);
  assert.equal(state.acceptedDraft, null);
});
