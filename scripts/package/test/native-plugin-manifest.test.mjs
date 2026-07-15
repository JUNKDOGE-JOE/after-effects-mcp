import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import {
  validateNativePluginManifest,
} from '../lib/native-plugin-manifest.mjs';
import { stagePlatformBundle } from '../stage-platform-bundle.mjs';
import {
  makeNativeStageHarness,
} from './helpers/platform-bundle-fixture.mjs';

test('native plug-in schema and runtime validator enforce the exact generated shape', async (t) => {
  const h = await makeNativeStageHarness(t);
  await stagePlatformBundle(h.input);
  const manifest = h.nativeManifest();
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
  assert.throws(
    () => validateNativePluginManifest(unknownTop),
    { code: 'BUNDLE_NATIVE_PLUGIN_MANIFEST_INVALID' },
  );

  const unknownNested = structuredClone(manifest);
  unknownNested.artifact.unreviewed = true;
  assert.throws(
    () => validateNativePluginManifest(unknownNested),
    { code: 'BUNDLE_NATIVE_PLUGIN_MANIFEST_INVALID' },
  );

  const abbreviatedSource = structuredClone(manifest);
  abbreviatedSource.sourceCommitSha = abbreviatedSource.sourceCommitSha.slice(0, 12);
  assert.throws(
    () => validateNativePluginManifest(abbreviatedSource),
    { code: 'BUNDLE_NATIVE_PLUGIN_MANIFEST_INVALID' },
  );

  for (const mutate of [
    (value) => { value.artifact.bundleIdentifier = 'dev.aemcp.wrong'; },
    (value) => { value.artifact.piplResourceId = 16001; },
    (value) => { value.artifact.piplCompatibilityVersion = 1; },
    (value) => { value.build.signatureVerification = 'developer-id'; },
  ]) {
    const wrongIdentity = structuredClone(manifest);
    mutate(wrongIdentity);
    assert.throws(
      () => validateNativePluginManifest(wrongIdentity),
      { code: 'BUNDLE_NATIVE_PLUGIN_MANIFEST_INVALID' },
    );
  }
});
