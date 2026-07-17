import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildHelperManifest,
  parseBuildPlatformHelperArgs,
  prepareEmptyOutput,
  snapshotNodeHeadersArchive,
  snapshotNodeImportLibrary,
  validateHelperIdentityPolicy,
  validateNodeHeadersArchive,
} from '../../../../scripts/package/build-platform-helper.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

test('build CLI accepts only the exact platform and output arguments', () => {
  assert.deepEqual(parseBuildPlatformHelperArgs([
    '--platform', 'macos-arm64', '--out', 'build/helper/macos-arm64',
  ]), {
    platform: 'macos-arm64',
    outDir: 'build/helper/macos-arm64',
  });
  assert.deepEqual(parseBuildPlatformHelperArgs([
    '--platform', 'windows-x64', '--out', 'build/helper/windows-x64',
  ]), {
    platform: 'windows-x64',
    outDir: 'build/helper/windows-x64',
  });
  assert.throws(() => parseBuildPlatformHelperArgs([
    '--platform', 'macos-arm64', '--out', 'out', '--force', '1',
  ]), /unknown argument/);
  assert.throws(() => parseBuildPlatformHelperArgs([
    '--platform', 'linux-x64', '--out', 'out',
  ]), /unsupported platform/);
});

test('Windows identity policy locks pipe, signer, ancestry, and Credential Manager boundaries', () => {
  const policy = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'packaging/helper-identity-policy.json'),
    'utf8',
  ));
  assert.doesNotThrow(() => validateHelperIdentityPolicy(policy, 'windows-x64'));
  assert.equal(policy.windows.pipeName, '\\\\.\\pipe\\com.junkdoge.ae-mcp.platform-helper');
  assert.equal(policy.windows.credentialTargetPrefix, 'com.junkdoge.ae-mcp/provider:');
  assert.equal(policy.windows.caller.publisherOrganization, 'Adobe Inc.');
  assert.equal(policy.windows.caller.directImage, 'CEPHtmlEngine.exe');
  assert.equal(policy.windows.caller.ancestorImage, 'AfterFX.exe');
  assert.deepEqual(policy.windows.caller.afterEffectsMajors, [25, 26]);
  assert.equal(policy.windows.authorization.currentUserOnly, true);
  assert.equal(policy.windows.authorization.processGenerationDoubleRead, true);
  assert.equal(policy.windows.authorization.wholeChainFinalRead, true);
  assert.equal(policy.windows.authorization.authenticodeChainRequired, true);
  assert.equal(policy.windows.authorization.rejectionBackendAccessCount, 0);

  const loose = structuredClone(policy);
  loose.windows.caller.publisherOrganization = 'Any Publisher';
  assert.throws(
    () => validateHelperIdentityPolicy(loose, 'windows-x64'),
    { code: 'HELPER_IDENTITY_POLICY_INVALID' },
  );
});

test('mac identity policy locks public connection, signer, version, and Keychain boundaries', () => {
  const policy = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'packaging/helper-identity-policy.json'),
    'utf8',
  ));
  assert.doesNotThrow(() => validateHelperIdentityPolicy(policy, 'macos-arm64'));
  assert.equal(policy.helperId, 'com.junkdoge.ae-mcp.platform-helper');
  assert.equal(policy.macos.keychainService, 'com.junkdoge.ae-mcp');
  assert.equal(
    policy.macos.keychainAccountPattern,
    '^provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[a-z][a-z0-9_-]{0,31}:v1$',
  );
  assert.equal(policy.macos.caller.adobeTeamId, 'JQ525L2MZD');
  assert.deepEqual(policy.macos.caller.afterEffectsMajors, [25, 26]);
  assert.deepEqual(policy.macos.caller.directSigningIdentifiers, [
    'com.adobe.cep.CEPHtmlEngine',
  ]);
  assert.equal(policy.macos.authorization.publicConnectionIdentityOnly, true);
  assert.equal(policy.macos.authorization.processGenerationDoubleRead, true);
  assert.equal(policy.macos.authorization.positiveAuditSessionBinding, true);
  assert.equal(policy.macos.authorization.ancestrySnapshotCodeSnapshot, true);
  assert.equal(policy.macos.authorization.wholeChainFinalRead, true);
  assert.equal(policy.macos.authorization.rejectionBackendAccessCount, 0);

  const loose = structuredClone(policy);
  loose.macos.keychainAccountPattern = '^provider:[0-9a-f-]{36}:.+:v1$';
  assert.throws(
    () => validateHelperIdentityPolicy(loose, 'macos-arm64'),
    { code: 'HELPER_IDENTITY_POLICY_INVALID' },
  );
});

test('locked Node headers archive must match the 24.17.0 digest and contain node_api.h', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-node-headers-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'headers.tar.gz');
  const includeDir = path.join(root, 'node-v24.17.0', 'include', 'node');
  await fs.promises.mkdir(includeDir, { recursive: true });
  await fs.promises.writeFile(path.join(includeDir, 'node_api.h'), 'fixture');
  await fs.promises.writeFile(archive, 'not-the-locked-archive');

  await assert.rejects(
    validateNodeHeadersArchive({ archivePath: archive, extractedRoot: root }),
    { code: 'HELPER_NODE_HEADERS_INVALID' },
  );
});

test('helper manifest declares helper, launcher, XPC executable, and N-API addon', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-helper-manifest-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const definitions = [
    ['bin/ae-mcp-platform-helper', 'macho-arm64'],
    ['bin/ae-mcp', 'script'],
    ['lib/ae-mcp-platform-helper-transport.node', 'macho-arm64'],
    ['xpc/com.junkdoge.ae-mcp.platform-helper.xpc/Contents/MacOS/ae-mcp-platform-helper', 'macho-arm64'],
  ];
  for (const [relative] of definitions) {
    const target = path.join(root, ...relative.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, relative);
  }

  const manifest = await buildHelperManifest(root, 'macos-arm64', definitions.map(
    ([relative, architecture]) => ({ path: relative, architecture }),
  ));
  assert.equal(manifest.entrypoints.helper, 'bin/ae-mcp-platform-helper');
  assert.equal(manifest.entrypoints.launcher, 'bin/ae-mcp');
  assert.deepEqual(manifest.files.map((item) => item.path), definitions.map(([relative]) => relative));
  assert.ok(manifest.files.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)));
});

test('Windows helper manifest uses executable entrypoints', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-helper-win-manifest-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const definitions = [
    { path: 'bin/ae-mcp-platform-helper.exe', architecture: 'pe-x64' },
    { path: 'bin/ae-mcp.exe', architecture: 'pe-x64' },
    { path: 'lib/ae-mcp-platform-helper-transport.node', architecture: 'pe-x64' },
  ];
  for (const definition of definitions) {
    const target = path.join(root, ...definition.path.split('/'));
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, definition.path);
  }

  const manifest = await buildHelperManifest(root, 'windows-x64', definitions);
  assert.equal(manifest.entrypoints.helper, 'bin/ae-mcp-platform-helper.exe');
  assert.equal(manifest.entrypoints.launcher, 'bin/ae-mcp.exe');
});

test('helper build refuses an existing output without changing it', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-helper-output-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'out');
  await fs.promises.mkdir(output);
  await fs.promises.writeFile(path.join(output, 'owned.txt'), 'keep');

  await assert.rejects(prepareEmptyOutput(output), { code: 'HELPER_OUTPUT_EXISTS' });
  assert.equal(await fs.promises.readFile(path.join(output, 'owned.txt'), 'utf8'), 'keep');
});

test('lipo architecture verification uses the current input-first CLI grammar', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'scripts/package/build-platform-helper.mjs'),
    'utf8',
  );
  assert.match(script, /\[filePath, '-verify_arch', 'arm64'\]/);
  assert.doesNotMatch(script, /\['-verify_arch', 'arm64', filePath\]/);
});

test('mac addon compilation always receives an explicit SDK root', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'scripts/package/build-platform-helper.mjs'),
    'utf8',
  );
  const start = script.indexOf('async function buildAddon');
  const end = script.indexOf('async function verifyArm64', start);
  const block = script.slice(start, end);
  assert.match(block, /AE_MCP_MACOS_SDK/);
  assert.match(block, /\['--show-sdk-path'\]/);
  assert.match(block, /const sdkArgs = \['-isysroot', sdkPath\]/);
  assert.ok(block.indexOf('const sdkArgs') < block.indexOf("'-c', path.join(sourceRoot, 'common.cpp')"));
});

test('locked archive digest is verified before tar sees attacker-controlled bytes', () => {
  const script = fs.readFileSync(
    path.join(repoRoot, 'scripts/package/build-platform-helper.mjs'),
    'utf8',
  );
  const start = script.indexOf('async function extractNodeHeaders');
  const end = script.indexOf('function swiftEnvironment', start);
  const block = script.slice(start, end);
  assert.ok(block.indexOf('snapshotNodeHeadersArchive') < block.indexOf('validateNodeHeadersArchive'));
  assert.match(block, /validateNodeHeadersArchive\(\{ archivePath: snapshotArchive \}\)/);
  assert.match(block, /run\(tar, \['-xzf', snapshotArchive/);
  const tarLine = block.split('\n').find((line) => line.includes('run(tar'));
  assert.doesNotMatch(tarLine, /\barchivePath\b/);
});

test('Node headers are copied to a private build snapshot before validation', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-header-snapshot-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'original.tar.gz');
  const scratch = path.join(root, 'scratch');
  await fs.promises.writeFile(original, 'original bytes');

  const snapshot = await snapshotNodeHeadersArchive({ archivePath: original, scratchRoot: scratch });
  await fs.promises.writeFile(original, 'attacker replacement');

  assert.equal(await fs.promises.readFile(snapshot, 'utf8'), 'original bytes');
  const stats = await fs.promises.lstat(snapshot);
  assert.equal(stats.isFile(), true);
  assert.equal(stats.isSymbolicLink(), false);
  assert.equal(stats.nlink, 1);
  if (process.platform !== 'win32') assert.equal(stats.mode & 0o777, 0o600);
  assert.notEqual(path.dirname(snapshot), path.dirname(original));
});

test('Windows node.lib is copied privately and rejected unless its bytes are locked', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-node-lib-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const original = path.join(root, 'node.lib');
  await fs.promises.writeFile(original, 'not-the-locked-library');

  await assert.rejects(
    snapshotNodeImportLibrary({ libraryPath: original, scratchRoot: path.join(root, 'scratch') }),
    { code: 'HELPER_NODE_IMPORT_LIBRARY_INVALID' },
  );
});
