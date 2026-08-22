import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  channelChoiceState,
  channelCopiedLabel,
  channelDot,
  channelTexts,
} from '../src/lib/channelCard.js';

test('channelDot maps probe state to a status color token', () => {
  assert.equal(channelDot({ checking: true, ok: false }), 'neutral');
  assert.equal(channelDot({ checking: false, ok: true }), 'ok');
  assert.equal(channelDot({ checking: false, ok: false }), 'warn');
});

test('channelTexts picks language-specific source badge and fixHint', () => {
  const probe = { source: { zh: '订阅登录', en: 'Subscription login' }, ok: false, checking: false, detail: 'd', fixHint: { zh: '去登录', en: 'log in' } };
  assert.deepEqual(channelTexts(probe, 'zh'), {
    source: '订阅登录', detail: 'd', fixHint: '去登录', copyLabel: '', copyText: '',
  });
  assert.deepEqual(channelTexts(probe, 'en'), {
    source: 'Subscription login', detail: 'd', fixHint: 'log in', copyLabel: '', copyText: '',
  });
  assert.equal(channelTexts({ ...probe, ok: true }, 'zh').fixHint, '', 'no fixHint when channel is ok');
});

test('channelTexts exposes copy actions only for failed settled probes', () => {
  const probe = {
    source: { zh: 'Codex', en: 'Codex' },
    ok: false,
    checking: false,
    fixHint: { zh: '登录', en: 'Sign in' },
    copyAction: {
      label: { zh: '复制登录命令', en: 'Copy login command' },
      text: 'codex login',
    },
  };
  assert.equal(channelTexts(probe, 'zh').copyLabel, '复制登录命令');
  assert.equal(channelTexts(probe, 'en').copyLabel, 'Copy login command');
  assert.equal(channelTexts(probe, 'zh').copyText, 'codex login');
  assert.equal(channelTexts({ ...probe, ok: true }, 'zh').copyText, '');
  assert.equal(channelTexts({ ...probe, checking: true }, 'zh').copyText, '');
});

test('channelCopiedLabel returns bilingual copied feedback', () => {
  assert.equal(channelCopiedLabel('zh'), '已复制');
  assert.equal(channelCopiedLabel('en'), 'Copied');
});

test('channelChoiceState marks exactly the enabled row (#229)', () => {
  assert.deepEqual(channelChoiceState('cli', 'cli', 'zh'), { label: '使用中', active: true });
  assert.deepEqual(channelChoiceState('custom', 'cli', 'zh'), { label: '使用此通道', active: false });
  assert.deepEqual(channelChoiceState('cli', 'cli', 'en'), { label: 'In use', active: true });
  assert.deepEqual(channelChoiceState('custom', 'cli', 'en'), { label: 'Use this channel', active: false });
});
