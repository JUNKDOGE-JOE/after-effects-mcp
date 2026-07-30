import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const addonPath = process.env.AE_MCP_MACOS_ADDON_PATH || '';

test('macOS helper addon loads and exposes createTransport', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64' || !addonPath,
}, () => {
  const addon = createRequire(import.meta.url)(addonPath);
  assert.equal(typeof addon.createTransport, 'function');
});
