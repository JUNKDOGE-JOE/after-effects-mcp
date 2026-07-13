import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseStagePlatformBundleArgs,
  resolveCliSourceCommit,
  stagePlatformBundle,
} from '../stage-platform-bundle.mjs';
import { makeStageHarness, SOURCE_COMMIT_SHA } from './helpers/platform-bundle-fixture.mjs';

test('stage contains one platform and omits development files', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');

  await stagePlatformBundle(h.input);

  assert.equal(h.manifest().sourceCommitSha, SOURCE_COMMIT_SHA);
  assert.equal(h.exists('runtime/macos-arm64/runtime-manifest.json'), true);
  assert.equal(h.exists('runtime/windows-x64'), false);
  assert.equal(h.exists('.debug'), false);
  assert.equal(h.exists('panel'), false);
  assert.equal(h.exists('sidecar/test'), false);
  assert.equal(h.exists('host/server.test.js'), false);
  assert.equal(h.exists('host/node_modules'), false);
  assert.equal(h.exists('bundled-tools/fixture.json'), true);
  assert.equal(h.exists('platform/macos-arm64/helper-manifest.json'), true);
  assert.equal(h.manifest().files.some((entry) => entry.path.endsWith('.node')), false);
});

test('stage rejects a noncanonical source commit SHA', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64', { sourceCommitSha: 'ABC123' });

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'INVALID_SOURCE_COMMIT_SHA' },
  );
  assert.equal(fs.existsSync(h.outDir), false);
});

test('stage fails explicitly when a required helper input is missing', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await fs.promises.rm(h.helperRoot, { recursive: true, force: true });

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_INPUT_MISSING' },
  );
  assert.equal(fs.existsSync(h.outDir), false);
});

test('stage refuses an existing output without changing it', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await fs.promises.mkdir(h.outDir);
  await fs.promises.writeFile(path.join(h.outDir, 'owned.txt'), 'keep me');

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_OUTPUT_EXISTS' },
  );
  assert.equal(await fs.promises.readFile(path.join(h.outDir, 'owned.txt'), 'utf8'), 'keep me');
});

test('stage rejects hard-linked source files instead of normalizing them', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  const source = path.join(h.repoRoot, 'plugin', 'host', 'server.js');
  await fs.promises.link(source, path.join(h.repoRoot, 'plugin', 'host', 'server-copy.js'));

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_HARDLINK_FORBIDDEN' },
  );
  assert.equal(fs.existsSync(h.outDir), false);
});

test('stage rejects a hard-linked opaque helper payload', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  const helper = path.join(h.helperRoot, 'bin', 'ae-mcp-platform-helper');
  await fs.promises.link(helper, path.join(h.root, 'helper-hardlink'));

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_HARDLINK_FORBIDDEN' },
  );
  assert.equal(fs.existsSync(h.outDir), false);
});

test('stage reserves portable aliases of the bundle control manifest', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await fs.promises.writeFile(
    path.join(h.repoRoot, 'plugin', 'BUNDLE-MANIFEST.JSON'),
    '{"forged":true}\n',
  );

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_MANIFEST_INVALID' },
  );
  assert.equal(fs.existsSync(h.outDir), false);
});

test('stage rejects a source symlink that resolves outside its input root', {
  skip: process.platform === 'win32' ? 'Windows symlink creation requires an elevated fixture' : false,
}, async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  const outside = path.join(h.root, 'outside.txt');
  await fs.promises.writeFile(outside, 'outside');
  await fs.promises.symlink(
    outside,
    path.join(h.repoRoot, 'plugin', 'host', 'escape.js'),
  );

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_SYMLINK_UNSAFE' },
  );
  assert.equal(fs.existsSync(h.outDir), false);
});

test('stage requires prebuilt SBOM and license evidence instead of synthesizing it', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  await fs.promises.rm(path.join(h.runtimeRoot, 'sbom.spdx.json'));

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_INPUT_MISSING' },
  );
});

test('identical inputs produce byte-identical bundle manifests', async (t) => {
  const left = await makeStageHarness(t, 'macos-arm64');
  const right = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(left.input);
  await stagePlatformBundle(right.input);

  assert.deepEqual(
    await fs.promises.readFile(path.join(left.outDir, 'bundle-manifest.json')),
    await fs.promises.readFile(path.join(right.outDir, 'bundle-manifest.json')),
  );
});

test('stage rejects undeclared helper architecture fields instead of locking an IPC shape', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  const manifestPath = path.join(h.helperRoot, 'helper-manifest.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  manifest.ipc = 'node-addon';
  manifest.files[0].role = 'addon';
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_HELPER_IDENTITY_INVALID' },
  );
});

test('stage rejects a special filesystem entry', {
  skip: process.platform === 'win32' ? 'FIFO fixture is POSIX-only' : false,
}, async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  const fifoPath = path.join(h.repoRoot, 'plugin', 'host', 'fixture.fifo');
  execFileSync('/usr/bin/mkfifo', [fifoPath], { stdio: 'ignore' });
  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_SPECIAL_FILE' },
  );
});

test('CLI candidate resolution requires exact clean HEAD and strict arguments', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  const gitRoot = path.join(h.root, 'git-source');
  await fs.promises.mkdir(gitRoot);
  await fs.promises.writeFile(path.join(gitRoot, 'tracked.txt'), 'clean\n');
  await fs.promises.writeFile(path.join(gitRoot, '.gitignore'), 'dist/\n');
  const git = (...args) => execFileSync('git', args, { cwd: gitRoot, encoding: 'utf8' }).trim();
  git('init');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('add', 'tracked.txt', '.gitignore');
  git('commit', '-m', 'fixture');
  const head = git('rev-parse', 'HEAD');

  assert.equal(await resolveCliSourceCommit(gitRoot, { AE_MCP_SOURCE_COMMIT_SHA: head }), head);
  await fs.promises.mkdir(path.join(gitRoot, 'build'), { recursive: true });
  await fs.promises.writeFile(path.join(gitRoot, 'build', 'runtime.bin'), 'untracked build output\n');
  assert.equal(await resolveCliSourceCommit(gitRoot, { AE_MCP_SOURCE_COMMIT_SHA: head }), head);
  await fs.promises.mkdir(path.join(gitRoot, 'plugin', 'host'), { recursive: true });
  await fs.promises.writeFile(path.join(gitRoot, 'plugin', 'host', 'injected.js'), 'injected\n');
  await assert.rejects(
    resolveCliSourceCommit(gitRoot, { AE_MCP_SOURCE_COMMIT_SHA: head }),
    { code: 'BUNDLE_SOURCE_DIRTY' },
  );
  await fs.promises.rm(path.join(gitRoot, 'plugin'), { recursive: true });
  await fs.promises.mkdir(path.join(gitRoot, 'plugin', 'host', 'dist'), { recursive: true });
  await fs.promises.writeFile(
    path.join(gitRoot, 'plugin', 'host', 'dist', 'ignored-injected.js'),
    'ignored injected source\n',
  );
  await assert.rejects(
    resolveCliSourceCommit(gitRoot, { AE_MCP_SOURCE_COMMIT_SHA: head }),
    { code: 'BUNDLE_SOURCE_DIRTY' },
  );
  await fs.promises.rm(path.join(gitRoot, 'plugin'), { recursive: true });
  await assert.rejects(
    resolveCliSourceCommit(gitRoot, { AE_MCP_SOURCE_COMMIT_SHA: head.toUpperCase() }),
    { code: 'INVALID_SOURCE_COMMIT_SHA' },
  );
  await fs.promises.appendFile(path.join(gitRoot, 'tracked.txt'), 'dirty\n');
  await assert.rejects(
    resolveCliSourceCommit(gitRoot, { AE_MCP_SOURCE_COMMIT_SHA: head }),
    { code: 'BUNDLE_SOURCE_DIRTY' },
  );
  assert.deepEqual(
    parseStagePlatformBundleArgs([
      '--platform=macos-arm64', '--version', '0.9.2', '--out', 'build/stage',
    ]),
    { platform: 'macos-arm64', version: '0.9.2', outDir: 'build/stage' },
  );
  assert.throws(
    () => parseStagePlatformBundleArgs([
      '--platform', 'macos-arm64', '--version', '0.9.2', '--out', 'stage', '--force', '1',
    ]),
    /invalid argument/,
  );
});

test('failed final verification removes the temporary stage and publishes nothing', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  const runtimeManifestPath = path.join(h.runtimeRoot, 'runtime-manifest.json');
  const runtimeManifest = JSON.parse(await fs.promises.readFile(runtimeManifestPath, 'utf8'));
  runtimeManifest.files[1] = { ...runtimeManifest.files[0] };
  await fs.promises.writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_RUNTIME_MANIFEST_INVALID' },
  );
  assert.equal(fs.existsSync(h.outDir), false);
  assert.equal(
    (await fs.promises.readdir(h.root)).some((name) => name.startsWith('.stage.tmp-')),
    false,
  );
});

test('opaque helper manifest cannot label a non-native data file as the helper entrypoint', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  const manifestPath = path.join(h.helperRoot, 'helper-manifest.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  const helperRecord = manifest.files.find((record) => (
    record.path === manifest.entrypoints.helper
  ));
  const helperPath = path.join(h.helperRoot, ...helperRecord.path.split('/'));
  await fs.promises.writeFile(helperPath, 'not a native helper\n');
  const { createHash } = await import('node:crypto');
  helperRecord.architecture = 'data';
  helperRecord.sha256 = createHash('sha256')
    .update(await fs.promises.readFile(helperPath))
    .digest('hex');
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_HELPER_IDENTITY_INVALID' },
  );
});

test('stage rejects unknown nested runtime identity fields', async (t) => {
  const h = await makeStageHarness(t, 'windows-x64');
  const manifestPath = path.join(h.runtimeRoot, 'runtime-manifest.json');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  manifest.node.unreviewed = true;
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(
    stagePlatformBundle(h.input),
    { code: 'BUNDLE_RUNTIME_MANIFEST_INVALID' },
  );
});
