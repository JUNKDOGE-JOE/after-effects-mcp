import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceTurnStage, turnProgressText } from '../src/lib/turnProgress.js';

test('reduceTurnStage accepts matching or unscoped progress events', () => {
  assert.equal(reduceTurnStage('connect', {
    type: 'turn-progress',
    turnId: 'turn-1',
    stage: 'spawn',
  }, { pendingTurnId: 'turn-1' }), 'spawn');
  assert.equal(reduceTurnStage('spawn', {
    type: 'turn-progress',
    stage: 'session',
  }, { pendingTurnId: 'turn-1' }), 'session');
  assert.equal(reduceTurnStage('session', {
    type: 'turn-progress',
    turnId: 'turn-old',
    stage: 'dispatch',
  }, { pendingTurnId: 'turn-1' }), 'session');
});

test('reduceTurnStage keeps progress through thinking and clears on visible output or turn completion', () => {
  assert.equal(reduceTurnStage('dispatch', { type: 'thinking', active: true }), 'dispatch');
  assert.equal(reduceTurnStage('dispatch', { type: 'thinking', active: false }), 'dispatch');
  for (const type of [
    'text-delta',
    'tool-start',
    'approval-required',
    'question-required',
    'turn-end',
    'error',
  ]) {
    assert.equal(reduceTurnStage('dispatch', { type }), null, type);
  }
  assert.equal(reduceTurnStage('session', { type: 'turn-accepted' }), 'session');
  assert.equal(reduceTurnStage('thinking', { type: 'turn-progress-warning', elapsedMs: 180000 }), 'thinking');
});

test('turnProgressText localizes backend and generic stages', () => {
  assert.equal(turnProgressText('connect', 'subscription', 'zh'), '正在连接 Claude…');
  assert.equal(turnProgressText('spawn', 'codex', 'en'), 'Starting Codex…');
  assert.equal(turnProgressText('spawn', 'opencode', 'zh'), '正在启动 OpenCode…');
  assert.equal(turnProgressText('session', 'opencode', 'en'), 'Creating session…');
  assert.equal(turnProgressText('mcp-rebuild', 'opencode', 'zh'), '与 AE 宿主的连接已失效，正在重建…');
  assert.equal(turnProgressText('mcp-rebuild', 'opencode', 'en'), 'The connection to the AE host was lost. Rebuilding…');
  assert.equal(turnProgressText('dispatch', 'subscription', 'zh'), '等待模型回复…');
  assert.equal(turnProgressText('thinking', 'subscription', 'en'), 'Model is thinking…');
  assert.equal(turnProgressText('unknown', 'codex', 'en'), '');
});
