import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localizeZcodeError } from '../src/lib/zcodeErrors.js';

test('zh adds an actionable header for missing-API-key errors, keeping the original detail', () => {
  const raw = 'Model provider is missing an API key: builtin:zai-start-plan.';
  const zh = localizeZcodeError(raw, 'zh');
  assert.match(zh, /builtin:zai-start-plan/);
  assert.match(zh, /缺少 API Key/);
  assert.match(zh, /设置 → AI 服务 → ZCode/);
  assert.match(zh, /系统安全凭据库/);
  assert.doesNotMatch(zh, /zcode-key/);
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

test('zh captures provider ids containing dots without truncation', () => {
  const zh = localizeZcodeError('Model provider is missing an API key: mediastorm_glm/glm-5.2.', 'zh');
  assert.match(zh, /「mediastorm_glm\/glm-5\.2」/);
});

test('localizeZcodeError is idempotent: re-localizing does not duplicate the guidance header', () => {
  const raw = 'Model provider is missing an API key: builtin:zai-start-plan.';
  const once = localizeZcodeError(raw, 'zh');
  const twice = localizeZcodeError(once, 'zh');
  assert.equal(twice, once);
  assert.equal(localizeZcodeError(localizeZcodeError('Provider authentication failed.', 'zh'), 'zh'), localizeZcodeError('Provider authentication failed.', 'zh'));
});
