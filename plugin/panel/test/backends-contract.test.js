import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgentLoop } from '../src/lib/agentLoop.js';
import { createClaudeAgentBackend } from '../src/cep/claudeAgentBackend.js';
import { createCodexBackend } from '../src/cep/codexBackend.js';
import { createOpenCodeBackend } from '../src/cep/openCodeBackend.js';
import { createZcodeBackend } from '../src/cep/zcodeBackend.js';
import { BACKEND_EVENTS } from '../src/cep/backends/contract.js';
import {
  BACKENDS,
  REAL_BACKENDS,
  assertAttachmentBackendRegistry,
  baseDescriptorFor,
} from '../src/cep/backends/index.js';

const ATTACHMENT_CONFORMANCE = {
  subscription: {
    factory: createClaudeAgentBackend,
    testFile: 'claudeAgentBackend.test.js',
    assertion: /turn-accepted.*turn-1.*claude-cli-stream-json/s,
  },
  'claude-api': {
    factory: createClaudeAgentBackend,
    testFile: 'claudeAgentBackend.test.js',
    assertion: /turn-accepted.*turn-1.*claude-cli-stream-json/s,
  },
  byok: {
    factory: createAgentLoop,
    testFile: 'agentLoop.test.js',
    assertion: /ATTACHMENTS_UNSUPPORTED.*turn-1.*not-started/s,
  },
  codex: {
    factory: createCodexBackend,
    testFile: 'codexBackend.test.js',
    assertion: /turn-accepted.*turn-1.*codex-app-server/s,
  },
  opencode: {
    factory: createOpenCodeBackend,
    testFile: 'openCodeBackend.test.js',
    assertion: /turn-accepted.*turn-1.*opencode-file-part/s,
  },
  zcode: {
    factory: createZcodeBackend,
    testFile: 'zcodeBackend.test.js',
    assertion: /turn-accepted.*turn-1.*zcode-manifest/s,
  },
};

test('contract event vocabulary is the frozen canonical set', () => {
  assert.ok(Object.isFrozen(BACKEND_EVENTS));
  // v0.6.0 live-acceptance additions that every backend must speak.
  assert.ok(BACKEND_EVENTS.includes('tool-allowed'));
  assert.ok(BACKEND_EVENTS.includes('tool-denied'));
  assert.ok(BACKEND_EVENTS.includes('thinking'));
  assert.ok(BACKEND_EVENTS.includes('turn-accepted'));
  // #219 agent-to-user question form events.
  assert.ok(BACKEND_EVENTS.includes('question-required'));
  assert.ok(BACKEND_EVENTS.includes('question-resolved'));
  for (const e of ['turn-start', 'text-delta', 'tool-start', 'tool-result', 'approval-required', 'turn-end', 'error']) {
    assert.ok(BACKEND_EVENTS.includes(e), 'missing ' + e);
  }
});

test('registry exposes the real embedded backends', () => {
  assert.deepEqual(REAL_BACKENDS, ['subscription', 'byok', 'claude-api', 'codex', 'opencode', 'zcode']);
  for (const id of REAL_BACKENDS) {
    assert.equal(BACKENDS[id].id, id);
    assert.equal(typeof BACKENDS[id].baseDescriptor, 'function');
  }
});

test('registry gives every backend a truthful attachment disposition', () => {
  assert.equal(assertAttachmentBackendRegistry(BACKENDS), true);
  assert.deepEqual(
    Object.fromEntries(REAL_BACKENDS.map((id) => [id, BACKENDS[id].attachmentTransport])),
    {
      subscription: 'manifest+read-rule',
      byok: 'reject',
      'claude-api': 'manifest+read-rule',
      codex: 'native+manifest',
      opencode: 'native',
      zcode: 'manifest',
    },
  );
});

test('attachment registry rejects a missing supported-backend mapping', () => {
  const mutated = {
    ...BACKENDS,
    codex: { ...BACKENDS.codex, attachmentTransport: undefined },
  };
  assert.throws(
    () => assertAttachmentBackendRegistry(mutated),
    /codex.*attachment transport/i,
  );
});

test('attachment registry permits rejection only for legacy byok', () => {
  const mutated = {
    ...BACKENDS,
    codex: { ...BACKENDS.codex, attachmentTransport: 'reject' },
  };
  assert.throws(
    () => assertAttachmentBackendRegistry(mutated),
    /codex.*reject/i,
  );
});

test('every attachment registry row has an executable factory conformance vector', () => {
  assert.deepEqual(Object.keys(ATTACHMENT_CONFORMANCE).sort(), [...REAL_BACKENDS].sort());
  for (const id of REAL_BACKENDS) {
    const vector = ATTACHMENT_CONFORMANCE[id];
    assert.equal(typeof vector.factory, 'function', id + ' factory');
    const source = readFileSync(new URL(vector.testFile, import.meta.url), 'utf8');
    assert.match(source, vector.assertion, id + ' conformance assertion');
    if (BACKENDS[id].attachmentTransport === 'reject') {
      assert.equal(id, 'byok');
    } else {
      assert.notEqual(BACKENDS[id].attachmentTransport, 'reject', id + ' supported transport');
    }
  }
});

test('every registered backend yields a conformant descriptor', () => {
  // The descriptor contract a new backend (OpenCode, …) must satisfy so the
  // chips/settings render with zero hardcoding.
  const expectedModelSwitching = {
    subscription: true,
    byok: true,
    'claude-api': true,
    codex: true,
    opencode: true,
    zcode: false,
  };
  for (const id of REAL_BACKENDS) {
    const d = baseDescriptorFor(id);
    assert.ok(Array.isArray(d.models) && d.models.length > 0, id + ' models');
    assert.ok(d.defaultModelId, id + ' defaultModelId');
    assert.ok(Array.isArray(d.approvalModes) && d.approvalModes.length === 4, id + ' approvalModes');
    assert.equal(typeof d.supportsFast, 'function', id + ' supportsFast');
    assert.equal(typeof d.perTurnModelSwitch, 'boolean', id + ' perTurnModelSwitch');
    assert.equal(d.perTurnModelSwitch, expectedModelSwitching[id], id + ' perTurnModelSwitch');
    for (const m of d.models) {
      assert.ok(m.id && m.label, id + ' model id/label');
      assert.ok(Array.isArray(m.effortLevels), id + ' effortLevels');
    }
  }
});

test('baseDescriptorFor falls back to subscription for an unknown id', () => {
  const d = baseDescriptorFor('nope');
  assert.equal(d.id, 'claude-sub');
});
