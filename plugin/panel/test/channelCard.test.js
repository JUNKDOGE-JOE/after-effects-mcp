import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelDot, channelTexts, lockButtonState, lockLabel } from '../src/lib/channelCard.js';

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

test('lockButtonState mirrors lockLabel when nothing is pinned', () => {
  assert.deepEqual(lockButtonState('cli', { lockedChannel: 'cli' }, 'zh'), {
    label: '已锁定', disabled: false, hint: '',
  });
  assert.deepEqual(lockButtonState('cli', { lockedChannel: '' }, 'en'), {
    label: 'Lock', disabled: false, hint: '',
  });
});

test('lockButtonState disables the whole group and explains the pin (#224)', () => {
  const pinned = lockButtonState('custom', { lockedChannel: 'custom', pinnedChannel: 'custom' }, 'zh');
  assert.equal(pinned.label, '已锁定');
  assert.equal(pinned.disabled, true);
  assert.match(pinned.hint, /无 provider/);

  // Sibling rows in a pinned group also disable: the App lock handler re-pins
  // on any click, so a clickable sibling toggle would silently revert too.
  const sibling = lockButtonState('cli', { lockedChannel: 'custom', pinnedChannel: 'custom' }, 'en');
  assert.equal(sibling.label, 'Lock');
  assert.equal(sibling.disabled, true);
  assert.equal(sibling.hint, '');

  // Defensive: a pinned row reads as locked even if the stored lock drifted.
  const drifted = lockButtonState('custom', { lockedChannel: '', pinnedChannel: 'custom' }, 'en');
  assert.equal(drifted.label, 'Locked');
  assert.equal(drifted.disabled, true);
  assert.match(drifted.hint, /No provider/);
});
