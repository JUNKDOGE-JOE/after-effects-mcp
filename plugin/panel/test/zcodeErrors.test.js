import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localizeZcodeError } from '../src/lib/zcodeErrors.js';

test('zh adds an actionable header for missing-API-key errors, keeping the original detail', () => {
  const raw = 'Model provider is missing an API key: builtin:zai-start-plan.';
  const zh = localizeZcodeError(raw, 'zh');
  assert.match(zh, /builtin:zai-start-plan/);
  assert.match(zh, /缺少 API Key/);
  assert.match(zh, /设置 → AI 服务 → ZCode/);
  assert.match(zh, /zcode-key/);
  assert.ok(zh.includes(raw), 'original detail preserved for diagnostics');
});

test('zh localizes missing-model-config and provider-auth failures with next steps', () => {
  assert.match(localizeZcodeError('Model config is missing.', 'zh'), /打开 ZCode|config\.json/);
  assert.match(localizeZcodeError('Provider authentication failed.', 'zh'), /检查 API Key|验证码/);
});

test('en and unknown messages pass through unchanged', () => {
  const raw = 'Model provider is missing an API key: x.';
  assert.equal(localizeZcodeError(raw, 'en'), raw);
  assert.equal(localizeZcodeError('some other error', 'zh'), 'some other error');
  assert.equal(localizeZcodeError('', 'zh'), '');
});
