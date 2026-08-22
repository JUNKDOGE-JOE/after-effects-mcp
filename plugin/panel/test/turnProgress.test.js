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
});

test('turnProgressText localizes backend and generic stages', () => {
  assert.equal(turnProgressText('connect', 'subscription', 'zh'), '正在连接 Claude…');
  assert.equal(turnProgressText('spawn', 'codex', 'en'), 'Starting Codex…');
  assert.equal(turnProgressText('spawn', 'opencode', 'zh'), '正在启动 OpenCode…');
  assert.equal(turnProgressText('session', 'opencode', 'en'), 'Creating session…');
  assert.equal(turnProgressText('dispatch', 'subscription', 'zh'), '等待模型回复…');
  assert.equal(turnProgressText('unknown', 'codex', 'en'), '');
});
