import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyDownloadedArtifact } from '../fetch-opencode-runtime.mjs';
import { stagePlatformBundle } from '../stage-platform-bundle.mjs';
import { makeStageHarness, writeFixtureFile } from './helpers/platform-bundle-fixture.mjs';

test('Windows stage includes the pinned OpenCode runtime when it is staged', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await stagePlatformBundle(h.input);

  assert.equal(h.exists('runtime/opencode/opencode.exe'), true);
  assert.equal(h.manifest().files.some((entry) => entry.path === 'runtime/opencode/opencode.exe'), true);
});

test('Windows development stage warns while release-audit stage rejects a missing OpenCode runtime', async (t) => {
  const development = await makeStageHarness(t, 'windows-x64', {
    verificationProfile: 'development',
    inputs: { runtimeStagingRoot: path.join(os.tmpdir(), 'missing-opencode-runtime') },
  });
  const warnings = [];
  await stagePlatformBundle({
    ...development.input,
    dependencies: { warnImpl: (message) => warnings.push(message) },
  });
  assert.equal(development.exists('runtime/opencode/opencode.exe'), false);
  assert.deepEqual(warnings, [
    'WARNING: OpenCode runtime is not staged; run node scripts/package/fetch-opencode-runtime.mjs before packaging.',
  ]);

  const release = await makeStageHarness(t, 'windows-x64', {
    inputs: { runtimeStagingRoot: path.join(os.tmpdir(), 'missing-opencode-runtime') },
  });
  await assert.rejects(stagePlatformBundle({
    ...release.input,
    dependencies: { warnImpl() {} },
  }), { code: 'BUNDLE_OPENCODE_RUNTIME_MISSING' });
  assert.equal(release.exists('runtime/opencode/opencode.exe'), false);
});

test('OpenCode runtime verification removes a hash-mismatched download', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-opencode-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = await writeFixtureFile(root, 'opencode.zip', Buffer.from('tiny'));
  const manifest = {
    version: 'v-test',
    url: 'https://example.invalid/opencode.zip',
    sizeBytes: 4,
    sha256: createHash('sha256').update('different').digest('hex'),
    binary: 'opencode.exe',
  };

  await assert.rejects(verifyDownloadedArtifact({ filePath: archive, manifest }), {
    code: 'OPENCODE_RUNTIME_HASH_MISMATCH',
  });
  await assert.rejects(fs.access(archive));
});
