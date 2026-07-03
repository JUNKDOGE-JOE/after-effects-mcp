import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zcodeModelLocked, zcodeRuntimeBadge, zcodeUnavailableHint } from '../src/lib/settingsState.js';

test('zcodeModelLocked locks settings model control only for static ZCode sessions', () => {
  assert.equal(zcodeModelLocked({ backend: 'zcode', modelSwitchable: false }), true);
  assert.equal(zcodeModelLocked({ backend: 'zcode', modelSwitchable: true }), false);
  assert.equal(zcodeModelLocked({ backend: 'codex', modelSwitchable: false }), false);
});

test('zcodeRuntimeBadge maps runtime errors to an error badge', () => {
  assert.deepEqual(
    zcodeRuntimeBadge({ state: 'runtime-error' }, {
      zcodeReady: 'ready',
      zcodeNotLoggedIn: 'login',
      zcodeRuntimeError: 'runtime',
      zcodeChecking: 'checking',
    }),
    { status: 'error', text: 'runtime' },
  );
});

test('zcodeUnavailableHint shows runtime detail before the generic repair hint', () => {
  assert.equal(
    zcodeUnavailableHint(
      { state: 'runtime-error', detail: 'Set AE_MCP_ZCODE_API_KEY before launching AE.' },
      'Install ZCode or set AE_MCP_ZCODE_CLI.',
    ),
    'Set AE_MCP_ZCODE_API_KEY before launching AE.',
  );
  assert.equal(
    zcodeUnavailableHint({ state: 'runtime-error' }, 'Install ZCode or set AE_MCP_ZCODE_CLI.'),
    'Install ZCode or set AE_MCP_ZCODE_CLI.',
  );
});
