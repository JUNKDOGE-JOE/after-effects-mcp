import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { freezeSignedManifests } from '../freeze-signed-manifests.mjs';
import { sha256Directory } from '../lib/files.mjs';
import {
  canonicalJson,
  copyTree,
  readCanonicalJsonFile,
  sha256File,
} from '../lib/manifest.mjs';
import { stagePlatformBundle } from '../stage-platform-bundle.mjs';
import { verifyPlatformBundle } from '../verify-platform-bundle.mjs';
import { makeStageHarness } from './helpers/platform-bundle-fixture.mjs';

test('writes independent canonical freeze-step evidence bound to signed root bytes', async (t) => {
  const module = await import('../freeze-signed-manifests.mjs');
  assert.equal(
    typeof module.freezeSignedManifestsWithEvidence,
    'function',
    'freezeSignedManifestsWithEvidence export is required',
  );
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  const signingRoot = path.join(h.root, 'signed');
  await copyTree(h.outDir, signingRoot);
  const sourceStageSha256 = await sha256File(path.join(h.outDir, 'bundle-manifest.json'));
  const helperPath = path.join(
    signingRoot,
    'platform/windows-x64/bin/ae-mcp-platform-helper.exe',
  );
  await fs.promises.appendFile(helperPath, 'simulated-authenticode-signature');
  const inputSha256 = await sha256Directory(signingRoot);
  const evidencePath = path.join(h.root, 'freeze-evidence.json');

  const evidence = await module.freezeSignedManifestsWithEvidence({
    root: signingRoot,
    platform: 'windows-x64',
    version: '0.9.1',
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
  assert.equal(
    await fs.promises.readFile(evidencePath, 'utf8'),
    canonicalJson(evidence),
  );
});

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

test('freezes the reviewed XPC CodeResources seal into the helper manifest', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  const helperManifestPath = path.join(h.helperRoot, 'helper-manifest.json');
  const helperManifest = JSON.parse(await fs.promises.readFile(helperManifestPath, 'utf8'));
  const addonRelative = 'lib/ae-mcp-platform-helper-transport.node';
  const xpcRelative = 'xpc/com.junkdoge.ae-mcp.platform-helper.xpc/Contents/MacOS/ae-mcp-platform-helper';
  for (const relative of [addonRelative, xpcRelative]) {
    const target = path.join(h.helperRoot, ...relative.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, Buffer.from([
      0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
    ]), { mode: 0o755 });
    helperManifest.files.push({
      path: relative,
      architecture: 'macho-arm64',
      sha256: await sha256File(target),
    });
  }
  await fs.promises.writeFile(helperManifestPath, `${JSON.stringify(helperManifest, null, 2)}\n`);

  await stagePlatformBundle(h.input);
  const signingRoot = path.join(h.root, 'signed-xpc');
  await copyTree(h.outDir, signingRoot);
  const sourceStageSha256 = await sha256File(path.join(h.outDir, 'bundle-manifest.json'));
  const codeResourcesRelative = 'xpc/com.junkdoge.ae-mcp.platform-helper.xpc/Contents/_CodeSignature/CodeResources';
  const codeResourcesPath = path.join(
    signingRoot,
    'platform/macos-arm64',
    ...codeResourcesRelative.split('/'),
  );
  await fs.promises.mkdir(path.dirname(codeResourcesPath), { recursive: true });
  await fs.promises.writeFile(codeResourcesPath, 'simulated XPC resource seal');

  await freezeSignedManifests({
    root: signingRoot,
    platform: 'macos-arm64',
    version: '0.9.1',
    sourceCommitSha: h.input.sourceCommitSha,
    sourceStageSha256,
  });

  const frozen = await readCanonicalJsonFile(path.join(
    signingRoot,
    'platform/macos-arm64/helper-manifest.json',
  ));
  assert.deepEqual(
    frozen.files.find((record) => record.path === codeResourcesRelative),
    {
      path: codeResourcesRelative,
      architecture: 'data',
      sha256: await sha256File(codeResourcesPath),
    },
  );
  await verifyPlatformBundle({
    root: signingRoot,
    platform: 'macos-arm64',
    version: '0.9.1',
    sourceCommitSha: h.input.sourceCommitSha,
  });
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
