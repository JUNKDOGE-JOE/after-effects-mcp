import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { freezeSignedManifests, freezeSignedManifestsWithEvidence } from '../freeze-signed-manifests.mjs';
import { stagePlatformBundle } from '../stage-platform-bundle.mjs';
import { verifyPlatformBundle } from '../verify-platform-bundle.mjs';
import { copyTree, readCanonicalJsonFile, sha256File, canonicalJson } from '../lib/manifest.mjs';
import { sha256Directory } from '../lib/files.mjs';
import { makeStageHarness } from './helpers/platform-bundle-fixture.mjs';

test('writes canonical freeze evidence bound to the direct extension stage', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  const signingRoot = path.join(h.root, 'signed');
  await copyTree(h.outDir, signingRoot);
  const sourceStageSha256 = await sha256File(path.join(h.outDir, 'bundle-manifest.json'));
  const inputSha256 = await sha256Directory(signingRoot);
  const evidencePath = path.join(h.root, 'freeze-evidence.json');

  const evidence = await freezeSignedManifestsWithEvidence({
    root: signingRoot,
    platform: 'windows-x64',
    version: '0.9.6',
    sourceCommitSha: h.input.sourceCommitSha,
    sourceStageSha256,
    evidencePath,
  });

  assert.deepEqual(Object.keys(evidence).sort(), [
    'platform',
    'schemaVersion',
    'sourceStageSha256',
    'step',
  ]);
  assert.deepEqual(evidence.step, {
    id: 'freeze-signed-manifests',
    inputSha256,
    outputSha256: await sha256Directory(signingRoot),
    exitCode: 0,
  });
  assert.equal(await fs.promises.readFile(evidencePath, 'utf8'), canonicalJson(evidence));
});

test('freezes a changed direct payload without adding retired payload roots', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const signingRoot = path.join(h.root, 'signed');
  await copyTree(h.outDir, signingRoot);
  const sourceManifestPath = path.join(h.outDir, 'bundle-manifest.json');
  const sourceManifestBytes = await fs.promises.readFile(sourceManifestPath);
  const sourceStageSha256 = await sha256File(sourceManifestPath);
  await fs.promises.appendFile(path.join(signingRoot, 'host', 'server.js'), '\n// signed\n');

  await assert.rejects(verifyPlatformBundle({
    root: signingRoot,
    platform: 'macos-arm64',
    version: '0.9.6',
    sourceCommitSha: h.input.sourceCommitSha,
  }), { code: 'BUNDLE_FILE_METADATA_MISMATCH' });

  const result = await freezeSignedManifests({
    root: signingRoot,
    platform: 'macos-arm64',
    version: '0.9.6',
    sourceCommitSha: h.input.sourceCommitSha,
    sourceStageSha256,
  });
  await verifyPlatformBundle({
    root: signingRoot,
    platform: 'macos-arm64',
    version: '0.9.6',
    sourceCommitSha: h.input.sourceCommitSha,
  });
  assert.equal(result.signedBundleManifestSha256, await sha256File(
    path.join(signingRoot, 'bundle-manifest.json'),
  ));
  assert.equal(result.finalRootSha256, await sha256Directory(signingRoot));
  assert.equal(result.sourceStageSha256, sourceStageSha256);
  assert.deepEqual(await fs.promises.readFile(sourceManifestPath), sourceManifestBytes);
  const manifest = await readCanonicalJsonFile(path.join(signingRoot, 'bundle-manifest.json'));
  assert.equal(manifest.files.some((entry) => entry.path === 'host/server.js'), true);
  assert.equal(manifest.files.some((entry) => entry.path.startsWith('runtime/')), false);
  assert.equal(manifest.files.some((entry) => entry.path.startsWith('sidecar/')), false);
});

test('refuses to freeze when the asserted source digest is malformed', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  await assert.rejects(freezeSignedManifests({
    root: h.outDir,
    platform: 'windows-x64',
    version: '0.9.6',
    sourceCommitSha: h.input.sourceCommitSha,
    sourceStageSha256: 'bad',
  }), /source stage digest/i);
});
