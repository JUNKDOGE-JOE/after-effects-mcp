import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialStepStates, stepReducer, LOCAL_STEPS, SUBSCRIPTION_STEPS } from '../src/lib/wizardSteps.js';

test('step ids cover local service and subscription readiness', () => {
  assert.deepEqual(LOCAL_STEPS, ['uv', 'aeMcp']);
  assert.deepEqual(SUBSCRIPTION_STEPS, ['node', 'claude', 'login']);
});

test('reducer walks idle -> checking -> missing -> running -> ok', () => {
  let s = initialStepStates();
  s = stepReducer(s, { type: 'detect-start', id: 'uv' });
  assert.equal(s.uv.status, 'checking');
  s = stepReducer(s, { type: 'detect-result', id: 'uv', ok: false });
  assert.equal(s.uv.status, 'missing');
  s = stepReducer(s, { type: 'run-start', id: 'uv' });
  assert.equal(s.uv.status, 'running');
  s = stepReducer(s, { type: 'run-chunk', id: 'uv', text: 'installing...' });
  assert.ok(s.uv.logTail.includes('installing'));
  s = stepReducer(s, { type: 'detect-result', id: 'uv', ok: true, version: 'uv 0.7.2' });
  assert.equal(s.uv.status, 'ok');
  assert.equal(s.uv.version, 'uv 0.7.2');
});

test('run failure keeps the log tail and marks fail', () => {
  let s = initialStepStates();
  s = stepReducer(s, { type: 'run-start', id: 'node' });
  s = stepReducer(s, { type: 'run-done', id: 'node', ok: false, output: 'boom' });
  assert.equal(s.node.status, 'fail');
  assert.ok(s.node.logTail.includes('boom'));
});
