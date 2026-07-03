import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelDot, channelTexts, lockLabel } from '../src/lib/channelCard.js';

test('channelDot maps probe state to a status color token', () => {
  assert.equal(channelDot({ checking: true, ok: false }), 'neutral');
  assert.equal(channelDot({ checking: false, ok: true }), 'ok');
  assert.equal(channelDot({ checking: false, ok: false }), 'warn');
});

test('channelTexts picks language-specific source badge and fixHint', () => {
  const probe = { source: { zh: '订阅登录', en: 'Subscription login' }, ok: false, checking: false, detail: 'd', fixHint: { zh: '去登录', en: 'log in' } };
  assert.deepEqual(channelTexts(probe, 'zh'), { source: '订阅登录', detail: 'd', fixHint: '去登录' });
  assert.deepEqual(channelTexts(probe, 'en'), { source: 'Subscription login', detail: 'd', fixHint: 'log in' });
  assert.equal(channelTexts({ ...probe, ok: true }, 'zh').fixHint, '', 'no fixHint when channel is ok');
});

test('lockLabel reflects current lock', () => {
  assert.equal(lockLabel('api', 'api', 'zh'), '已锁定');
  assert.equal(lockLabel('api', '', 'zh'), '锁定');
  assert.equal(lockLabel('api', 'api', 'en'), 'Locked');
  assert.equal(lockLabel('api', '', 'en'), 'Lock');
});
