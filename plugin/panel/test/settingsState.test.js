import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zcodeModelLocked, zcodeDefaultModelLocked } from '../src/lib/settingsState.js';

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
