import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zcodeModelLocked, zcodeDefaultModelLocked, zcodeManagedModelLabel } from '../src/lib/settingsState.js';

test('zcodeModelLocked locks settings model control only for static ZCode sessions', () => {
  assert.equal(zcodeModelLocked({ backend: 'zcode', modelSwitchable: false }), true);
  assert.equal(zcodeModelLocked({ backend: 'zcode', modelSwitchable: true }), false);
  assert.equal(zcodeModelLocked({ backend: 'codex', modelSwitchable: false }), false);
});

// The DEFAULT model picker (Settings -> "默认模型") is a distinct concept from
// the composer's mid-session switch lock. Changing the default model just
// means "use this model on the next session/create" -- it never requires
// switching mid-turn, so it must NOT be gated by modelSwitchable/perTurnModelSwitch.
// It should only be locked when there's genuinely nothing to pick from.
test('zcodeDefaultModelLocked is selectable for zcode with multiple models regardless of modelSwitchable', () => {
  assert.equal(
    zcodeDefaultModelLocked({ backend: 'zcode', modelSwitchable: false, models: [{ id: 'a' }, { id: 'b' }] }),
    false
  );
  assert.equal(
    zcodeDefaultModelLocked({ backend: 'zcode', modelSwitchable: true, models: [{ id: 'a' }, { id: 'b' }] }),
    false
  );
});

test('zcodeDefaultModelLocked is locked for zcode with 0 or 1 selectable models', () => {
  assert.equal(zcodeDefaultModelLocked({ backend: 'zcode', modelSwitchable: false, models: [] }), true);
  assert.equal(zcodeDefaultModelLocked({ backend: 'zcode', modelSwitchable: false, models: [{ id: 'only' }] }), true);
  assert.equal(zcodeDefaultModelLocked({ backend: 'zcode', modelSwitchable: false, models: undefined }), true);
});

test('zcodeDefaultModelLocked never locks non-zcode backends', () => {
  assert.equal(zcodeDefaultModelLocked({ backend: 'codex', modelSwitchable: false, models: [] }), false);
  assert.equal(zcodeDefaultModelLocked({ backend: 'subscription', modelSwitchable: false, models: undefined }), false);
});

// The locked-state hint used to be a generic "managed by the current ZCode
// session" string with no indication of which model is actually in use.
// zcodeManagedModelLabel formats the actual model id (as sent on the wire,
// e.g. from summarizeZcodeConfig().cli.model / the effective model) into the
// zh/en copy so users can see what's really configured.
test('zcodeManagedModelLabel formats the current model id into localized copy', () => {
  assert.equal(
    zcodeManagedModelLabel('zh', 'mediastorm_glm/deepseek-v4-flash'),
    '当前模型：mediastorm_glm/deepseek-v4-flash（由 ZCode 配置管理）'
  );
  assert.equal(
    zcodeManagedModelLabel('en', 'mediastorm_glm/deepseek-v4-flash'),
    'Current model: mediastorm_glm/deepseek-v4-flash (managed by ZCode configuration)'
  );
});

test('zcodeManagedModelLabel falls back to the generic copy when no model id is known', () => {
  assert.equal(zcodeManagedModelLabel('zh', ''), '由 ZCode 当前会话管理');
  assert.equal(zcodeManagedModelLabel('en', ''), 'Managed by the current ZCode session');
  assert.equal(zcodeManagedModelLabel('en', null), 'Managed by the current ZCode session');
});

