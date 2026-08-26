import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLI_STEPS,
  HOST_STEPS,
  OPTIONAL_CLIENT_STEPS,
  initialStepStates,
  stepReducer,
} from '../src/lib/wizardSteps.js';

test('wizard steps cover host health, three AI CLIs, and optional shim Node', () => {
  assert.deepEqual(HOST_STEPS, ['host']);
  assert.deepEqual(CLI_STEPS, ['claude', 'codex', 'opencode']);
  assert.deepEqual(OPTIONAL_CLIENT_STEPS, ['node']);
  assert.equal(Object.hasOwn(initialStepStates(), 'uv'), false);
  assert.equal(Object.hasOwn(initialStepStates(), 'aeMcp'), false);
});

test('reducer walks idle -> checking -> missing -> running -> ok', () => {
  let state = initialStepStates();
  state = stepReducer(state, { type: 'detect-start', id: 'host' });
  assert.equal(state.host.status, 'checking');
  state = stepReducer(state, {
    type: 'detect-result',
    id: 'host',
    ok: false,
    detail: 'connection refused',
  });
  assert.equal(state.host.status, 'missing');
  assert.equal(state.host.logTail, 'connection refused');
  state = stepReducer(state, { type: 'run-start', id: 'host' });
  assert.equal(state.host.status, 'running');
  state = stepReducer(state, { type: 'run-chunk', id: 'host', text: 'checking...' });
  assert.ok(state.host.logTail.includes('checking'));
  state = stepReducer(state, {
    type: 'detect-result',
    id: 'host',
    ok: true,
    version: 'Host 0.9.6',
  });
  assert.equal(state.host.status, 'ok');
  assert.equal(state.host.version, 'Host 0.9.6');
});

test('optional Node install failure keeps its log tail', () => {
  let state = initialStepStates();
  state = stepReducer(state, { type: 'run-start', id: 'node' });
  state = stepReducer(state, {
    type: 'run-done',
    id: 'node',
    ok: false,
    output: 'boom',
  });
  assert.equal(state.node.status, 'fail');
  assert.ok(state.node.logTail.includes('boom'));
});

test('reducer retains detected executable path provenance', () => {
  const state = stepReducer(initialStepStates(), {
    type: 'detect-result',
    id: 'claude',
    ok: true,
    version: '2.1.0',
    path: 'C:\\Users\\a\\.local\\bin\\claude.exe',
    source: 'standard',
  });
  assert.equal(state.claude.path, 'C:\\Users\\a\\.local\\bin\\claude.exe');
  assert.equal(state.claude.source, 'standard');
});
