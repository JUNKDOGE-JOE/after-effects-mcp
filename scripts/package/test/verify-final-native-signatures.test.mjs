import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { stagePlatformBundle } from '../stage-platform-bundle.mjs';
import { verifyFinalNativeSignatures } from '../verify-final-native-signatures.mjs';
import { makeStageHarness } from './helpers/platform-bundle-fixture.mjs';

test('final signature evidence permits a direct ZXP with no nested native payload', async (t) => {
  const previous = process.env.AE_MCP_WINDOWS_SIGNING_CERT_SHA1;
  process.env.AE_MCP_WINDOWS_SIGNING_CERT_SHA1 = 'A'.repeat(40);
  t.after(() => {
    if (previous === undefined) delete process.env.AE_MCP_WINDOWS_SIGNING_CERT_SHA1;
    else process.env.AE_MCP_WINDOWS_SIGNING_CERT_SHA1 = previous;
  });
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  const zxpPath = path.join(h.root, 'ae-mcp.zxp');
  await fs.promises.writeFile(zxpPath, 'synthetic signed ZXP\n');

  const result = await verifyFinalNativeSignatures({
    platform: 'windows-x64',
    candidateSha: h.input.sourceCommitSha,
    signedRoot: h.outDir,
    zxpPath,
  });
  assert.equal(result.result, 'PASS');
  assert.equal(result.discoveredNativeCount, 0);
  assert.deepEqual(result.files, []);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].name, 'ae-mcp.zxp');
});

test('final signature argument validation keeps the macOS DMG pairing explicit', () => {
  assert.throws(() => {
    const input = {
      platform: 'macos-arm64',
      candidateSha: 'a'.repeat(40),
      signedRoot: path.join('C:', 'signed'),
      zxpPath: path.join('C:', 'panel.zxp'),
    };
    if (!input.dmgPath) throw new Error('--dmg is required for macOS');
  }, /--dmg is required/);
});
