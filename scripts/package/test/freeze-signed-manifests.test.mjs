import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { freezeSignedManifests } from '../freeze-signed-manifests.mjs';
import { sha256Directory } from '../lib/files.mjs';
import { copyTree, readCanonicalJsonFile, sha256File } from '../lib/manifest.mjs';
import { stagePlatformBundle } from '../stage-platform-bundle.mjs';
import { verifyPlatformBundle } from '../verify-platform-bundle.mjs';
import { makeStageHarness } from './helpers/platform-bundle-fixture.mjs';

test('freezes signed helper bytes into a final helper and bundle manifest without changing source', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const signingRoot = path.join(h.root, 'signed');
  await copyTree(h.outDir, signingRoot);
  const sourceManifestPath = path.join(h.outDir, 'bundle-manifest.json');
  const sourceManifestBytes = await fs.promises.readFile(sourceManifestPath);
  const sourceStageSha256 = await sha256File(sourceManifestPath);
  const runtimeManifestPath = path.join(
    signingRoot,
    'runtime/macos-arm64/runtime-manifest.json',
  );
  const runtimeManifestBefore = await fs.promises.readFile(runtimeManifestPath);

  const helperPath = path.join(
    signingRoot,
    'platform/macos-arm64/bin/ae-mcp-platform-helper',
  );
  await fs.promises.appendFile(helperPath, 'simulated-developer-id-signature');
  await assert.rejects(verifyPlatformBundle({
    root: signingRoot,
    platform: 'macos-arm64',
    version: '0.9.1',
    sourceCommitSha: h.input.sourceCommitSha,
  }), { code: 'BUNDLE_FILE_METADATA_MISMATCH' });

  const result = await freezeSignedManifests({
    root: signingRoot,
    platform: 'macos-arm64',
    version: '0.9.1',
    sourceCommitSha: h.input.sourceCommitSha,
    sourceStageSha256,
  });

  await verifyPlatformBundle({
    root: signingRoot,
    platform: 'macos-arm64',
    version: '0.9.1',
    sourceCommitSha: h.input.sourceCommitSha,
  });
  assert.equal(
    result.signedBundleManifestSha256,
    await sha256File(path.join(signingRoot, 'bundle-manifest.json')),
  );
  assert.equal(result.finalRootSha256, await sha256Directory(signingRoot));
  assert.equal(result.sourceStageSha256, sourceStageSha256);
  assert.deepEqual(await fs.promises.readFile(sourceManifestPath), sourceManifestBytes);
  assert.deepEqual(await fs.promises.readFile(runtimeManifestPath), runtimeManifestBefore);

  const helperManifest = await readCanonicalJsonFile(path.join(
    signingRoot,
    'platform/macos-arm64/helper-manifest.json',
  ));
  const helperRecord = helperManifest.files.find(
    (record) => record.path === 'bin/ae-mcp-platform-helper',
  );
  assert.equal(helperRecord.sha256, await sha256File(helperPath));
});

test('refuses to freeze when the asserted unsigned source digest is malformed', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  await assert.rejects(freezeSignedManifests({
    root: h.outDir,
    platform: 'windows-x64',
    version: '0.9.1',
    sourceCommitSha: h.input.sourceCommitSha,
    sourceStageSha256: 'bad',
  }), /source stage digest/i);
});
