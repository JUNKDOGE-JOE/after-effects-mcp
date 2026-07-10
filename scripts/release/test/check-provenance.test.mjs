import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActionsRunDetailsUrl,
  parseActionsRunDetailsUrl,
} from '../check-provenance.mjs';
import * as provenance from '../check-provenance.mjs';

test('attestation writer URL round-trips through the promotion provenance parser', () => {
  const detailsUrl = buildActionsRunDetailsUrl({
    serverUrl: 'https://github.com',
    repository: 'JUNKDOGE-JOE/after-effects-mcp',
    runId: '123456789',
    runAttempt: '3',
  });

  assert.equal(
    detailsUrl,
    'https://github.com/JUNKDOGE-JOE/after-effects-mcp/actions/runs/123456789/attempts/3',
  );
  assert.deepEqual(parseActionsRunDetailsUrl(detailsUrl, {
    serverUrl: 'https://github.com',
    repository: 'JUNKDOGE-JOE/after-effects-mcp',
  }), { runId: '123456789', runAttempt: 3 });
});

test('provenance URL helpers reject PR URLs, other repositories, and invalid run identity', () => {
  const expected = {
    serverUrl: 'https://github.com',
    repository: 'JUNKDOGE-JOE/after-effects-mcp',
  };
  assert.throws(
    () => parseActionsRunDetailsUrl(
      'https://github.com/JUNKDOGE-JOE/after-effects-mcp/pull/51',
      expected,
    ),
    /exact Actions run URL/,
  );
  assert.throws(
    () => parseActionsRunDetailsUrl(
      'https://github.com/other/repository/actions/runs/1/attempts/1',
      expected,
    ),
    /exact Actions run URL/,
  );
  assert.throws(
    () => buildActionsRunDetailsUrl({
      ...expected,
      runId: '0',
      runAttempt: '1',
    }),
    /run identity/,
  );
});

test('active Check provenance rejects a different successful run or attempt', () => {
  assert.equal(typeof provenance.assertActiveAttestationRunProvenance, 'function');
  const expected = {
    serverUrl: 'https://github.com',
    repository: 'JUNKDOGE-JOE/after-effects-mcp',
  };
  const state = { activeRunId: '123456789', activeRunAttempt: 3 };

  assert.deepEqual(provenance.assertActiveAttestationRunProvenance(state,
    'https://github.com/JUNKDOGE-JOE/after-effects-mcp/actions/runs/123456789/attempts/3',
    expected), { runId: '123456789', runAttempt: 3 });
  assert.throws(
    () => provenance.assertActiveAttestationRunProvenance(state,
      'https://github.com/JUNKDOGE-JOE/after-effects-mcp/actions/runs/999999999/attempts/3',
      expected),
    /active attestation run provenance mismatch/,
  );
  assert.throws(
    () => provenance.assertActiveAttestationRunProvenance(state,
      'https://github.com/JUNKDOGE-JOE/after-effects-mcp/actions/runs/123456789/attempts/4',
      expected),
    /active attestation run provenance mismatch/,
  );
  assert.throws(
    () => provenance.assertActiveAttestationRunProvenance(
      { ...state, activeRunId: 123456789 },
      'https://github.com/JUNKDOGE-JOE/after-effects-mcp/actions/runs/123456789/attempts/3',
      expected,
    ),
    /active attestation run provenance mismatch/,
  );
});
