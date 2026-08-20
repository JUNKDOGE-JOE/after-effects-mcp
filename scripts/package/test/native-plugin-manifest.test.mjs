import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { validateNativePluginManifest } from '../lib/native-plugin-manifest.mjs';

const SHA = 'a'.repeat(64);
const SOURCE = '0123456789abcdef0123456789abcdef01234567';

function fixtureManifest() {
  return {
    schemaVersion: 1,
    productVersion: '0.9.2',
    sourceCommitSha: SOURCE,
    platform: 'macos-arm64',
    architecture: 'arm64',
    artifact: {
      payloadRoot: 'payload',
      bundlePath: 'payload/AeMcpNative.plugin',
      receiptPath: 'payload/build-receipt.json',
      receiptSha256: SHA,
      bundleName: 'AeMcpNative.plugin',
      bundleIdentifier: 'dev.aemcp.native-plugin',
      bundleType: 'AEgx',
      entryPoint: 'AeMcpNativeMain',
      fileCount: 5,
      bundleTreeSha256: SHA,
      executablePath: 'payload/AeMcpNative.plugin/Contents/MacOS/AeMcpNative',
      executableSha256: SHA,
      piplPath: 'payload/AeMcpNative.plugin/Contents/Resources/AeMcpNative.rsrc',
      piplResourceId: 16000,
      piplCompatibilityVersion: 65536,
      piplSha256: SHA,
    },
    sdk: {
      name: 'Adobe After Effects C/C++ Plug-in SDK',
      claimedVersion: '25.6.61',
      claimedBuild: 61,
      policySha256: SHA,
      archiveSha256: SHA,
      rootContentSha256: SHA,
      verification: 'archive-byte-identity-plus-canonical-root-content',
      materialIncluded: false,
    },
    protocol: { schemaSha256: SHA },
    build: {
      configuration: 'development',
      signing: 'ad-hoc',
      signatureVerification: 'ad-hoc-verified',
      distributionApproved: false,
    },
  };
}

test('native plug-in manifest enforces the exact frozen AEGP shape', async () => {
  const manifest = fixtureManifest();
  const schema = JSON.parse(await fs.promises.readFile(
    'packaging/schemas/native-plugin-manifest.schema.json',
    'utf8',
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(manifest).sort());
  for (const key of ['artifact', 'sdk', 'protocol', 'build']) {
    assert.equal(schema.properties[key].additionalProperties, false, key);
    assert.deepEqual(
      [...schema.properties[key].required].sort(),
      Object.keys(manifest[key]).sort(),
      key,
    );
  }
  assert.doesNotThrow(() => validateNativePluginManifest(manifest));

  const unknownTop = structuredClone(manifest);
  unknownTop.unreviewed = true;
  assert.throws(() => validateNativePluginManifest(unknownTop), {
    code: 'BUNDLE_NATIVE_PLUGIN_MANIFEST_INVALID',
  });

  const unknownNested = structuredClone(manifest);
  unknownNested.artifact.unreviewed = true;
  assert.throws(() => validateNativePluginManifest(unknownNested), {
    code: 'BUNDLE_NATIVE_PLUGIN_MANIFEST_INVALID',
  });

  for (const mutate of [
    (value) => { value.artifact.bundleIdentifier = 'dev.aemcp.wrong'; },
    (value) => { value.artifact.piplResourceId = 16001; },
    (value) => { value.artifact.piplCompatibilityVersion = 1; },
    (value) => { value.build.signatureVerification = 'developer-id'; },
  ]) {
    const wrongIdentity = structuredClone(manifest);
    mutate(wrongIdentity);
    assert.throws(() => validateNativePluginManifest(wrongIdentity), {
      code: 'BUNDLE_NATIVE_PLUGIN_MANIFEST_INVALID',
    });
  }
});
