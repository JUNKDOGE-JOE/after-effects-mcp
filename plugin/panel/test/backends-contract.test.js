import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKEND_EVENTS } from '../src/cep/backends/contract.js';
import {
  BACKENDS,
  REAL_BACKENDS,
  assertAttachmentBackendRegistry,
  baseDescriptorFor,
} from '../src/cep/backends/index.js';

test('backend registry has exactly the three supported channels', () => {
  assert.deepEqual(Object.keys(BACKENDS).sort(), ['codex', 'opencode', 'subscription']);
  assert.deepEqual([...REAL_BACKENDS].sort(), ['codex', 'opencode', 'subscription']);
  assert.equal(assertAttachmentBackendRegistry(BACKENDS), true);
  for (const backend of Object.values(BACKENDS)) {
    assert.equal(typeof backend.baseDescriptor, 'function');
    assert.ok(backend.attachmentTransport);
  }
});

test('baseDescriptorFor rejects an unknown backend id', () => {
  assert.throws(() => baseDescriptorFor('nope'), (error) => {
    assert.match(error.message, /Unknown backend id "nope"/);
    for (const backendId of ['codex', 'opencode', 'subscription']) {
      assert.match(error.message, new RegExp(backendId));
    }
    return true;
  });
});

test('attachment registry rejects an invalid transport', () => {
  assert.throws(
    () => assertAttachmentBackendRegistry({
      ...BACKENDS,
      codex: { ...BACKENDS.codex, attachmentTransport: 'invalid' },
    }),
    /codex.*attachment transport/i,
  );
});

test('registered backend descriptors have models and approval modes', () => {
  for (const id of REAL_BACKENDS) {
    const descriptor = baseDescriptorFor(id);
    assert.ok(Array.isArray(descriptor.models) && descriptor.models.length > 0, id);
    assert.ok(Array.isArray(descriptor.approvalModes) && descriptor.approvalModes.length === 4, id);
  }
});

test('contract event vocabulary retains the public backend events', () => {
  assert.deepEqual(BACKEND_EVENTS, [
    'turn-start',
    'turn-accepted',
    'text-delta',
    'tool-start',
    'tool-result',
    'approval-required',
    'tool-allowed',
    'tool-denied',
    'question-required',
    'question-resolved',
    'thinking',
    'turn-end',
    'error',
  ]);
});
