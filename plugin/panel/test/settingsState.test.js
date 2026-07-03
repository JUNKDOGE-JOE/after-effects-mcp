import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zcodeModelLocked } from '../src/lib/settingsState.js';

test('zcodeModelLocked locks settings model control only for static ZCode sessions', () => {
  assert.equal(zcodeModelLocked({ backend: 'zcode', modelSwitchable: false }), true);
  assert.equal(zcodeModelLocked({ backend: 'zcode', modelSwitchable: true }), false);
  assert.equal(zcodeModelLocked({ backend: 'codex', modelSwitchable: false }), false);
});
