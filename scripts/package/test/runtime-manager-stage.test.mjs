import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createMacosAdapter } from '../../../plugin/panel/src/cep/platform/macos.js';
import { createRuntimeManager } from '../../../plugin/panel/src/cep/runtimeManager.js';
import { stagePlatformBundle } from '../stage-platform-bundle.mjs';
import { makeStageHarness } from './helpers/platform-bundle-fixture.mjs';

test('RuntimeManager installs the exact verified macOS platform-bundle layout', async (t) => {
  const fixture = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(fixture.input);
  const home = path.join(fixture.root, '用户 Home with spaces');
  await fs.promises.mkdir(home, { recursive: true });
  const platform = createMacosAdapter({
    platform: 'darwin',
    arch: 'arm64',
    home,
    temp: fixture.root,
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    fs,
    spawnImpl() { throw new Error('not expected'); },
    now: () => Date.now(),
  });
  const manager = createRuntimeManager({
    platform,
    extensionRoot: fixture.outDir,
    cryptoImpl: crypto,
    randomBytes: crypto.randomBytes,
  });

  const selected = await manager.ensureReady();

  assert.equal(selected.action, 'install');
  assert.equal(selected.version, fixture.input.version);
  assert.equal(selected.sourceCommitSha, fixture.input.sourceCommitSha);
  assert.equal(selected.launcher, path.join(home, '.ae-mcp', 'bin', 'ae-mcp'));
  const state = await manager.inspect();
  assert.equal(state.ok, true);
  assert.equal(state.current.record.runtimeManifestSha256, fixture.manifest().runtime.manifestSha256);
});
