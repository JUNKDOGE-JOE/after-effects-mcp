import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stagePlatformBundle } from '../stage-platform-bundle.mjs';
import { verifyPlatformBundle } from '../verify-platform-bundle.mjs';
import { canonicalJson, sha256File, validateBundleManifest } from '../lib/manifest.mjs';
import { buildLicenseInventory, buildRuntimeSpdx } from '../lib/runtime-evidence.mjs';
import {
  SOURCE_COMMIT_SHA,
  machoX64Bytes,
  makeNativeStageHarness,
  makeStageHarness,
  rewriteStageManifests,
} from './helpers/platform-bundle-fixture.mjs';

test('verification accepts an untouched platform bundle without network access', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network access is forbidden'); };
  try {
    await verifyPlatformBundle(h.verifyInput);
    assert.equal(Object.hasOwn(h.manifest(), 'nativePlugin'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verification rejects missing and extra native payload entries after outer rehash', async (t) => {
  await t.test('missing receipt', async (subtest) => {
    const h = await makeNativeStageHarness(subtest);
    await stagePlatformBundle(h.input);
    await fs.promises.rm(h.nativePath('payload/build-receipt.json'));
    await rewriteStageManifests(h);

    await assert.rejects(
      verifyPlatformBundle(h.verifyInput),
      { code: 'BUNDLE_NATIVE_PLUGIN_FILE_SET_MISMATCH' },
    );
  });

  await t.test('extra native stage file', async (subtest) => {
    const h = await makeNativeStageHarness(subtest);
    await stagePlatformBundle(h.input);
    await fs.promises.writeFile(h.nativePath('unexpected.txt'), 'unexpected\n');
    await rewriteStageManifests(h);

    await assert.rejects(
      verifyPlatformBundle(h.verifyInput),
      { code: 'BUNDLE_NATIVE_PLUGIN_FILE_SET_MISMATCH' },
    );
  });
});

test('native payload and its top-level reference are a bidirectional invariant', async (t) => {
  await t.test('referenced payload cannot be made unreferenced', async (subtest) => {
    const h = await makeNativeStageHarness(subtest);
    await stagePlatformBundle(h.input);
    const manifestPath = path.join(h.outDir, 'bundle-manifest.json');
    const manifest = h.manifest();
    delete manifest.nativePlugin;
    await fs.promises.writeFile(manifestPath, canonicalJson(manifest));

    await assert.rejects(
      verifyPlatformBundle(h.verifyInput),
      { code: 'BUNDLE_NATIVE_PLUGIN_REFERENCE_MISSING' },
    );
  });

  await t.test('unreferenced native namespace content is rejected', async (subtest) => {
    const h = await makeStageHarness(subtest, 'macos-arm64');
    await stagePlatformBundle(h.input);
    const unbound = path.join(h.outDir, 'artifacts', 'native-plugin', 'unbound.txt');
    await fs.promises.mkdir(path.dirname(unbound), { recursive: true });
    await fs.promises.writeFile(unbound, 'unbound native payload\n');
    await rewriteStageManifests(h);

    await assert.rejects(
      verifyPlatformBundle(h.verifyInput),
      { code: 'BUNDLE_NATIVE_PLUGIN_REFERENCE_MISSING' },
    );
  });

  await t.test('referenced platform payload excludes sibling namespace files', async (subtest) => {
    const h = await makeNativeStageHarness(subtest);
    await stagePlatformBundle(h.input);
    const sibling = path.join(h.outDir, 'artifacts', 'native-plugin', 'unbound.txt');
    await fs.promises.writeFile(sibling, 'unexpected native sibling\n');
    await rewriteStageManifests(h);

    await assert.rejects(
      verifyPlatformBundle(h.verifyInput),
      { code: 'BUNDLE_NATIVE_PLUGIN_FILE_SET_MISMATCH' },
    );
  });
});

test('verification rejects a tampered native executable byte', async (t) => {
  const h = await makeNativeStageHarness(t);
  await stagePlatformBundle(h.input);
  const executable = await fs.promises.readFile(h.nativeExecutablePath);
  executable[executable.length - 1] ^= 0xff;
  await fs.promises.writeFile(h.nativeExecutablePath, executable);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_HASH_MISMATCH' },
  );
});

test('verification rejects native semantic drift after outer digests are refreshed', async (t) => {
  const cases = [
    {
      name: 'source commit',
      code: 'BUNDLE_NATIVE_PLUGIN_SOURCE_MISMATCH',
      mutate(receipt) {
        receipt.sourceCommit = 'f'.repeat(40);
        receipt.source.commit = receipt.sourceCommit;
      },
    },
    {
      name: 'product version',
      code: 'BUNDLE_NATIVE_PLUGIN_VERSION_MISMATCH',
      mutate(receipt) {
        receipt.productVersion = '0.1.0';
      },
    },
    {
      name: 'RPC protocol digest',
      code: 'BUNDLE_NATIVE_PLUGIN_PROTOCOL_MISMATCH',
      mutate(receipt) {
        receipt.protocolSchemaSha256 = 'f'.repeat(64);
      },
    },
    {
      name: 'SDK build evidence',
      code: 'BUNDLE_NATIVE_PLUGIN_RECEIPT_INVALID',
      mutate(receipt) {
        receipt.sdk.claimedBuild = 60;
      },
    },
    {
      name: 'plug-in entry point identity',
      code: 'BUNDLE_NATIVE_PLUGIN_ARTIFACT_INVALID',
      mutate(receipt) {
        receipt.artifact.entryPoint = 'WrongNativeMain';
      },
    },
    {
      name: 'native plug-in architecture',
      code: 'BUNDLE_NATIVE_PLUGIN_ARTIFACT_INVALID',
      mutate(receipt) {
        receipt.artifact.architecture = 'x86_64';
      },
    },
    {
      name: 'native bundle type',
      code: 'BUNDLE_NATIVE_PLUGIN_ARTIFACT_INVALID',
      mutate(receipt) {
        receipt.artifact.bundleType = 'eFKT';
      },
    },
    {
      name: 'development signature identity',
      code: 'BUNDLE_NATIVE_PLUGIN_ARTIFACT_INVALID',
      mutate(receipt) {
        receipt.artifact.codeSignature = 'developer-id';
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const h = await makeNativeStageHarness(subtest);
      await stagePlatformBundle(h.input);
      await h.mutateNativeReceipt(fixture.mutate);

      await assert.rejects(
        verifyPlatformBundle(h.verifyInput),
        { code: fixture.code },
      );
    });
  }
});

test('verification detects the staged AEGP executable architecture from bytes', async (t) => {
  const h = await makeNativeStageHarness(t);
  await stagePlatformBundle(h.input);
  const executableBytes = Buffer.concat([
    machoX64Bytes(),
    Buffer.from(SOURCE_COMMIT_SHA, 'ascii'),
  ]);
  await fs.promises.writeFile(h.nativeExecutablePath, executableBytes);

  const receiptPath = h.nativePath('payload/build-receipt.json');
  const receipt = JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
  receipt.artifact.executableSha256 = await sha256File(h.nativeExecutablePath);
  await fs.promises.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const manifestPath = h.nativePath('native-plugin-manifest.json');
  const nativeManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  nativeManifest.artifact.executableSha256 = receipt.artifact.executableSha256;
  nativeManifest.artifact.bundleTreeSha256 = receipt.artifact.bundleTreeSha256;
  nativeManifest.artifact.receiptSha256 = await sha256File(receiptPath);
  await fs.promises.writeFile(manifestPath, canonicalJson(nativeManifest));
  await rewriteStageManifests(h);

  h.verifyInput.dependencies.verifyMacPlugin = async () => (
    structuredClone(JSON.parse(await fs.promises.readFile(receiptPath, 'utf8')).artifact)
  );
  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_ARCH_MISMATCH' },
  );
});

test('verification rejects representative Adobe SDK material paths from the stage', async (t) => {
  for (const relative of [
    'AfterEffectsSDK_25.6_61_mac.zip',
    'sdk/Examples/Headers/AE_GeneralPlug.h',
    'sdk/Examples/AEGP/Commando/main.cpp',
    'sdk/Examples/Other/sample.txt',
    'sdk/AE_IO.h',
    'sdk/AE_General.r',
    'sdk/PiPLtool',
    'sdk/documentation.pdf',
    'tools/ae-sdk-extract-zstd',
  ]) {
    await t.test(relative, async (subtest) => {
      const h = await makeNativeStageHarness(subtest);
      await stagePlatformBundle(h.input);
      const material = path.join(h.outDir, ...relative.split('/'));
      await fs.promises.mkdir(path.dirname(material), { recursive: true });
      await fs.promises.writeFile(material, 'synthetic forbidden SDK material\n');
      await rewriteStageManifests(h);

      await assert.rejects(
        verifyPlatformBundle(h.verifyInput),
        { code: 'BUNDLE_ADOBE_SDK_MATERIAL_FORBIDDEN' },
      );
    });
  }
});

test('verification rejects one changed runtime byte', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  await h.flipByte('runtime/windows-x64/python/python.exe');

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_HASH_MISMATCH' },
  );
});

test('verification requires the production host package anchor used by the CEP panel', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  await fs.promises.rm(path.join(
    h.outDir,
    'runtime/windows-x64/node/host/package.json',
  ));
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_HOST_RUNTIME_INVALID' },
  );
});

test('verification rejects the wrong expected platform and version', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);

  await assert.rejects(
    verifyPlatformBundle({ ...h.verifyInput, platform: 'macos-arm64' }),
    { code: 'BUNDLE_PLATFORM_MISMATCH' },
  );
  await assert.rejects(
    verifyPlatformBundle({ ...h.verifyInput, version: '0.9.3' }),
    { code: 'BUNDLE_VERSION_MISMATCH' },
  );
});

test('verification rejects an extra file that is absent from the manifest', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  await fs.promises.writeFile(path.join(h.outDir, 'unexpected.txt'), 'unexpected');

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_FILE_SET_MISMATCH' },
  );
});

test('manifest validation rejects traversal, Windows-reserved, and case-colliding paths', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const baseline = h.manifest();
  const entry = baseline.files[0];

  for (const invalidPath of ['../escape', 'host/CON.txt', 'host/name:stream']) {
    const invalid = structuredClone(baseline);
    invalid.files = [{ ...entry, path: invalidPath }];
    assert.throws(
      () => validateBundleManifest(invalid),
      { code: 'BUNDLE_MANIFEST_INVALID' },
    );
  }

  const collision = structuredClone(baseline);
  collision.files = [
    { ...entry, path: 'host/README' },
    { ...entry, path: 'host/readme' },
  ];
  assert.throws(
    () => validateBundleManifest(collision),
    { code: 'BUNDLE_MANIFEST_INVALID' },
  );
});

test('manifest file order uses portable UTF-8 byte ordering instead of host locale', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const baseline = h.manifest();
  const entry = baseline.files[0];
  const byteOrdered = structuredClone(baseline);
  byteOrdered.files = [
    { ...entry, path: 'bundled-tools/z.json' },
    { ...entry, path: 'bundled-tools/ä.json' },
  ];

  assert.doesNotThrow(() => validateBundleManifest(byteOrdered));
});

test('verification binds the bundle source commit to the expected candidate', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);

  await verifyPlatformBundle({ ...h.verifyInput, sourceCommitSha: SOURCE_COMMIT_SHA });
  await assert.rejects(
    verifyPlatformBundle({ ...h.verifyInput, sourceCommitSha: 'f'.repeat(40) }),
    { code: 'BUNDLE_SOURCE_COMMIT_MISMATCH' },
  );
});

test('verification rejects a runtime inventory that duplicates one path and omits another', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  const runtimeManifestPath = path.join(
    h.outDir,
    'runtime',
    'windows-x64',
    'runtime-manifest.json',
  );
  const runtimeManifest = JSON.parse(await fs.promises.readFile(runtimeManifestPath, 'utf8'));
  runtimeManifest.files[1] = { ...runtimeManifest.files[0] };
  await fs.promises.writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  const bundle = h.manifest();
  const runtimeEntry = bundle.files.find((entry) => (
    entry.path === 'runtime/windows-x64/runtime-manifest.json'
  ));
  const bytes = await fs.promises.readFile(runtimeManifestPath);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(bytes).digest('hex');
  runtimeEntry.sha256 = digest;
  runtimeEntry.size = bytes.length;
  bundle.runtime.manifestSha256 = digest;
  await fs.promises.writeFile(
    path.join(h.outDir, 'bundle-manifest.json'),
    canonicalJson(bundle),
  );

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_RUNTIME_MANIFEST_INVALID' },
  );
});

test('verification rejects a wrong native architecture even after all hashes are refreshed', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  await fs.promises.writeFile(
    path.join(h.outDir, 'runtime', 'macos-arm64', 'node', 'bin', 'node'),
    machoX64Bytes(),
  );
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_ARCH_MISMATCH' },
  );
});

test('verification requires native architecture for extensionless macOS runtime entrypoints', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const elfX64 = Buffer.alloc(64);
  elfX64.set([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
  elfX64.writeUInt16LE(0x3e, 18);
  const nodePath = path.join(h.outDir, 'runtime', 'macos-arm64', 'node', 'bin', 'node');
  await fs.promises.writeFile(nodePath, elfX64);
  await fs.promises.chmod(nodePath, 0o755);
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_ARCH_MISMATCH' },
  );
});

test('verification requires the platform-specific Claude sidecar payload', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  await fs.promises.rm(path.join(
    h.outDir,
    'runtime/windows-x64/node/sidecar/node_modules',
    '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
  ));
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_ARCH_MISMATCH' },
  );
});

test('verification rejects a non-executable macOS runtime even after mode inventory is refreshed', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const nodePath = path.join(h.outDir, 'runtime', 'macos-arm64', 'node', 'bin', 'node');
  await fs.promises.chmod(nodePath, 0o644);
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_EXECUTABLE_MODE_INVALID' },
  );
});

test('verification rejects unknown runtime manifest fields after all hashes are refreshed', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  const runtimeManifestPath = path.join(
    h.outDir,
    'runtime',
    'windows-x64',
    'runtime-manifest.json',
  );
  const runtimeManifest = JSON.parse(await fs.promises.readFile(runtimeManifestPath, 'utf8'));
  runtimeManifest.unreviewedSourceCommit = 'f'.repeat(40);
  await fs.promises.writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_RUNTIME_MANIFEST_INVALID' },
  );
});

test('verification rejects unknown runtime component fields after evidence is refreshed', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  const runtimeRoot = path.join(h.outDir, 'runtime', 'windows-x64');
  const runtimeManifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  const runtimeManifest = JSON.parse(await fs.promises.readFile(runtimeManifestPath, 'utf8'));
  runtimeManifest.components[0].unreviewed = true;
  await fs.promises.writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  await fs.promises.writeFile(
    path.join(runtimeRoot, 'license-inventory.json'),
    canonicalJson(buildLicenseInventory({
      platform: 'windows-x64',
      components: runtimeManifest.components,
      licenseApprovals: runtimeManifest.licenseApprovals,
    })),
  );
  await fs.promises.writeFile(
    path.join(runtimeRoot, 'sbom.spdx.json'),
    canonicalJson(buildRuntimeSpdx({
      platform: 'windows-x64',
      components: runtimeManifest.components,
    })),
  );
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_RUNTIME_MANIFEST_INVALID' },
  );
});

test('verification rejects a hard link even when hashes, size, and mode still match', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const host = path.join(h.outDir, 'host', 'server.js');
  const sidecar = path.join(h.outDir, 'sidecar', 'agent-sidecar.mjs');
  await fs.promises.rm(sidecar);
  await fs.promises.link(host, sidecar);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_HARDLINK_FORBIDDEN' },
  );
});

test('manifest hashing refuses symlink and hard-link path reopening', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  const target = path.join(h.root, 'hash-target');
  const hardlink = path.join(h.root, 'hash-hardlink');
  await fs.promises.writeFile(target, 'trusted bytes\n');
  await fs.promises.link(target, hardlink);
  await assert.rejects(
    sha256File(hardlink),
    { code: 'BUNDLE_HARDLINK_FORBIDDEN' },
  );
  if (process.platform !== 'win32') {
    const symlink = path.join(h.root, 'hash-symlink');
    await fs.promises.symlink('hash-target', symlink);
    await assert.rejects(
      sha256File(symlink),
      { code: 'BUNDLE_SYMLINK_UNSAFE' },
    );
  }
});

test('verification requires the bundle manifest itself to be canonical and regular', {
  skip: process.platform === 'win32' ? 'Windows symlink creation requires an elevated fixture' : false,
}, async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const manifestPath = path.join(h.outDir, 'bundle-manifest.json');
  await fs.promises.appendFile(manifestPath, ' ');
  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_MANIFEST_NONCANONICAL' },
  );

  await fs.promises.writeFile(manifestPath, canonicalJson(h.manifest()));
  const outside = path.join(h.root, 'outside-manifest.json');
  await fs.promises.rename(manifestPath, outside);
  await fs.promises.symlink(outside, manifestPath);
  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_MANIFEST_INVALID' },
  );
});

test('verification rejects mismatched SBOM and license inventory platform evidence', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  const runtimeRoot = path.join(h.outDir, 'runtime', 'windows-x64');
  const sbomPath = path.join(runtimeRoot, 'sbom.spdx.json');
  const sbom = JSON.parse(await fs.promises.readFile(sbomPath, 'utf8'));
  sbom.name = 'ae-mcp-runtime-macos-arm64';
  await fs.promises.writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  await rewriteStageManifests(h);
  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_SBOM_INVALID' },
  );

  sbom.name = 'ae-mcp-runtime-windows-x64';
  await fs.promises.writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  const licensesPath = path.join(runtimeRoot, 'license-inventory.json');
  const licenses = JSON.parse(await fs.promises.readFile(licensesPath, 'utf8'));
  licenses.components[0].license = 'Apache-2.0';
  await fs.promises.writeFile(licensesPath, `${JSON.stringify(licenses, null, 2)}\n`);
  await rewriteStageManifests(h);
  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_LICENSE_INVENTORY_INVALID' },
  );
});

test('verification binds each LicenseRef to exact staged extracted license text', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const runtimeRoot = path.join(h.outDir, 'runtime', 'macos-arm64');
  const runtimeManifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  const runtimeManifest = JSON.parse(await fs.promises.readFile(runtimeManifestPath, 'utf8'));
  runtimeManifest.components[0].license = 'LicenseRef-Fixture';
  await fs.promises.writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);

  const extractedText = 'Reviewed fixture license text.\n';
  const evidencePath = 'licenses/LicenseRef-Fixture.txt';
  const evidenceAbsolute = path.join(runtimeRoot, ...evidencePath.split('/'));
  await fs.promises.writeFile(evidenceAbsolute, extractedText, 'utf8');
  const { createHash } = await import('node:crypto');
  const extractedLicenses = [{
    licenseId: 'LicenseRef-Fixture',
    name: 'Fixture reviewed license',
    extractedText,
    evidence: {
      path: evidencePath,
      sha256: createHash('sha256').update(extractedText, 'utf8').digest('hex'),
    },
  }];
  runtimeManifest.components[0].licenseEvidence = [{
    kind: 'payload-file',
    path: evidencePath,
    sha256: extractedLicenses[0].evidence.sha256,
  }];
  await fs.promises.writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);
  await fs.promises.writeFile(
    path.join(runtimeRoot, 'license-inventory.json'),
    canonicalJson(buildLicenseInventory({
      platform: 'macos-arm64',
      components: runtimeManifest.components,
      licenseApprovals: runtimeManifest.licenseApprovals,
      extractedLicenses,
    })),
  );
  await fs.promises.writeFile(
    path.join(runtimeRoot, 'sbom.spdx.json'),
    canonicalJson(buildRuntimeSpdx({
      platform: 'macos-arm64',
      components: runtimeManifest.components,
      extractedLicenses,
    })),
  );
  await rewriteStageManifests(h);
  await assert.doesNotReject(verifyPlatformBundle(h.verifyInput));

  await fs.promises.writeFile(evidenceAbsolute, 'forged fixture license text.\n', 'utf8');
  await rewriteStageManifests(h);
  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_RUNTIME_MANIFEST_INVALID' },
  );
});

test('verification rejects foreign platform payload after manifests are made self-consistent', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const foreignPath = path.join(
    h.outDir,
    'runtime',
    'macos-arm64',
    'node',
    'vendor',
    'win32-x64',
    'payload.txt',
  );
  await fs.promises.mkdir(path.dirname(foreignPath), { recursive: true });
  await fs.promises.writeFile(foreignPath, 'foreign');
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_FOREIGN_PLATFORM' },
  );
});

test('verification rejects helper architecture drift after helper and bundle hashes are refreshed', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  await fs.promises.writeFile(
    path.join(h.outDir, 'platform', 'macos-arm64', 'bin', 'ae-mcp-platform-helper'),
    machoX64Bytes(),
  );
  await rewriteStageManifests(h, { helper: true });

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_ARCH_MISMATCH' },
  );
});

test('verification rejects a symlinked helper manifest payload', {
  skip: process.platform === 'win32' ? 'Windows symlink creation requires an elevated fixture' : false,
}, async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const helperRoot = path.join(h.outDir, 'platform', 'macos-arm64');
  const helperManifestPath = path.join(helperRoot, 'helper-manifest.json');
  const helperManifest = JSON.parse(await fs.promises.readFile(helperManifestPath, 'utf8'));
  const helperPath = helperManifest.entrypoints.helper;
  const helperAbsolute = path.join(helperRoot, ...helperPath.split('/'));
  const shadowPath = 'bin/helper-shadow';
  const shadowAbsolute = path.join(helperRoot, ...shadowPath.split('/'));
  await fs.promises.copyFile(helperAbsolute, shadowAbsolute);
  await fs.promises.rm(helperAbsolute);
  await fs.promises.symlink('helper-shadow', helperAbsolute);
  helperManifest.files.push({
    path: shadowPath,
    architecture: 'data',
    sha256: helperManifest.files.find(({ path: relative }) => relative === helperPath).sha256,
  });
  await fs.promises.writeFile(helperManifestPath, `${JSON.stringify(helperManifest, null, 2)}\n`);
  await rewriteStageManifests(h, { helper: true });

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_HELPER_IDENTITY_INVALID' },
  );
});

test('verification rejects a widened CEP range after the bundle inventory is refreshed', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  const cepPath = path.join(h.outDir, 'CSXS', 'manifest.xml');
  const cep = await fs.promises.readFile(cepPath, 'utf8');
  await fs.promises.writeFile(cepPath, cep.replace('[25.0,26.9]', '[22.0,99.9]'));
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_CEP_RANGE_INVALID' },
  );
});

test('verification requires the exact cross-platform support matrix contract', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);
  const supportPath = path.join(h.outDir, 'metadata', 'support-matrix.json');
  const support = JSON.parse(await fs.promises.readFile(supportPath, 'utf8'));
  support.platforms['windows-x64'].arch = 'arm64';
  support.unreviewed = true;
  await fs.promises.writeFile(supportPath, `${JSON.stringify(support, null, 2)}\n`);
  await rewriteStageManifests(h);

  await assert.rejects(
    verifyPlatformBundle(h.verifyInput),
    { code: 'BUNDLE_SUPPORT_MATRIX_INVALID' },
  );
});
