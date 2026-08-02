#!/usr/bin/env node

// Reversible development install of one verified AeMcpNative AEX into an
// explicitly selected After Effects application. The receipt binds removal
// to the exact per-app Extensions topology and installed artifact hash.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyWindowsAex } from './verify-windows.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ARTIFACT_NAME = 'AeMcpNative.aex';
const BUILD_RECEIPT_NAME = 'build-receipt.json';
const RECEIPT_NAME = 'install-receipt.json';
const TOPOLOGY_KIND = 'windows-after-effects-per-app-extensions';
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const PRODUCT_VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 256 * 1024;
const CLI_USAGE = `Usage: node native/ae-plugin/install-dev-windows.mjs \\
  install --artifact <absolute-path> --build-receipt <absolute-path> \\
    --plugins-root <absolute-path> \\
| remove --receipt <absolute-path>

The plugins root must already exist and end with
Support Files\\Plug-ins\\Extensions for the selected After Effects app.
`;

function installError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('AE_')) return error;
  return installError('AE_PLUGIN_INSTALL_FAILED', 'development install failed');
}

function resolveRuntime(runtime = {}) {
  return {
    platform: runtime.platform ?? process.platform,
    architecture: runtime.architecture ?? process.arch,
    promises: runtime.promises ?? fs.promises,
    constants: runtime.constants ?? fs.constants,
    randomBytes: runtime.randomBytes ?? crypto.randomBytes,
    verifyWindowsAex: runtime.verifyWindowsAex ?? verifyWindowsAex,
  };
}

function assertWindowsRuntime(runtime) {
  if (runtime.platform !== 'win32' || runtime.architecture !== 'x64') {
    throw installError(
      'AE_PLUGIN_PLATFORM_UNSUPPORTED',
      'Windows x64 is required for the development install',
    );
  }
}

async function lstatIfExists(promises, candidate) {
  try {
    return await promises.lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function digestFile(filePath, promises) {
  return crypto.createHash('sha256').update(
    await promises.readFile(filePath),
  ).digest('hex');
}

function samePath(left, right, platform) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function loadBuildReceipt(input, runtime) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw installError(
      'AE_PLUGIN_ARGUMENT_INVALID',
      '--build-receipt must be an absolute path',
    );
  }
  const resolved = path.resolve(input);
  const stats = await lstatIfExists(runtime.promises, resolved);
  if (!stats?.isFile() || stats.isSymbolicLink()
      || stats.size === 0 || stats.size > MAX_RECEIPT_BYTES
      || path.basename(resolved) !== BUILD_RECEIPT_NAME) {
    throw installError(
      'AE_PLUGIN_RECEIPT_INVALID',
      'build receipt must be one bounded regular build-receipt.json file',
    );
  }
  const canonical = await runtime.promises.realpath(resolved);
  if (!samePath(resolved, canonical, runtime.platform)) {
    throw installError(
      'AE_PLUGIN_RECEIPT_INVALID',
      'build receipt cannot traverse a symbolic link',
    );
  }
  const bytes = await runtime.promises.readFile(canonical);
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
    throw installError('AE_PLUGIN_RECEIPT_INVALID', 'build receipt size changed during preflight');
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw installError('AE_PLUGIN_RECEIPT_INVALID', 'build receipt is not valid JSON');
  }
  if (!isRecord(value)) {
    throw installError('AE_PLUGIN_RECEIPT_INVALID', 'build receipt must be a JSON object');
  }
  return {
    path: canonical,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    value,
  };
}

function validateBuildReceipt(value, expected, runtime) {
  const artifact = value?.artifact;
  const source = value?.source;
  const verification = value?.verification;
  const verified = verification?.receipt;
  if (value?.schemaVersion !== 1
      || !isRecord(artifact)
      || artifact.fileName !== ARTIFACT_NAME
      || typeof artifact.path !== 'string'
      || !path.isAbsolute(artifact.path)
      || !samePath(artifact.path, expected.artifactPath, runtime.platform)
      || artifact.bytes !== expected.artifactStats.size
      || artifact.sha256 !== expected.sourceSha256
      || !COMMIT_PATTERN.test(value.sourceCommit ?? '')
      || !PRODUCT_VERSION_PATTERN.test(value.productVersion ?? '')
      || !isRecord(source)
      || source.commit !== value.sourceCommit
      || typeof source.repositoryClean !== 'boolean'
      || !isRecord(verification)
      || verification.result !== 'PASS'
      || verification.sourceCommit !== value.sourceCommit
      || verification.productVersion !== value.productVersion
      || verification.expectedSourceCommit !== value.sourceCommit
      || verification.expectedProductVersion !== value.productVersion
      || !isRecord(verified)
      || verified.artifact !== ARTIFACT_NAME
      || verified.artifactSha256 !== expected.sourceSha256
      || verified.bytes !== expected.artifactStats.size
      || verified.sourceCommit !== value.sourceCommit
      || verified.productVersion !== value.productVersion) {
    throw installError(
      'AE_PLUGIN_RECEIPT_MISMATCH',
      'build receipt does not bind the selected artifact identity',
    );
  }
  return {
    sourceCommit: value.sourceCommit,
    productVersion: value.productVersion,
  };
}

function validateArtifactVerification(value, expected) {
  const receipt = value?.receipt;
  if (value?.result !== 'PASS'
      || value.artifactSha256 !== expected.sourceSha256
      || value.bytes !== expected.artifactStats.size
      || value.sourceCommit !== expected.sourceCommit
      || value.productVersion !== expected.productVersion
      || !isRecord(receipt)
      || receipt.artifact !== ARTIFACT_NAME
      || receipt.artifactSha256 !== expected.sourceSha256
      || receipt.bytes !== expected.artifactStats.size
      || receipt.sourceCommit !== expected.sourceCommit
      || receipt.productVersion !== expected.productVersion) {
    throw installError(
      'AE_PLUGIN_RECEIPT_MISMATCH',
      'strict Windows verifier did not confirm the build receipt identity',
    );
  }
}

function assertPluginsRootShape(pluginsRoot) {
  const expected = ['Extensions', 'Plug-ins', 'Support Files'];
  let cursor = pluginsRoot;
  for (const segment of expected) {
    if (path.basename(cursor).toLowerCase() !== segment.toLowerCase()) {
      throw installError(
        'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
        'plugins root must end with Support Files\\Plug-ins\\Extensions',
      );
    }
    cursor = path.dirname(cursor);
  }
  if (path.dirname(cursor) === cursor || path.basename(cursor).length === 0) {
    throw installError(
      'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
      'plugins root must belong to one After Effects application directory',
    );
  }
}

async function canonicalPluginsRoot(input, runtime) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw installError(
      'AE_PLUGIN_ARGUMENT_INVALID',
      '--plugins-root must be an absolute per-app Extensions path',
    );
  }
  const resolved = path.resolve(input);
  const stats = await lstatIfExists(runtime.promises, resolved);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw installError(
      'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
      'plugins root must be an existing real directory',
    );
  }
  const canonical = await runtime.promises.realpath(resolved);
  if (!samePath(resolved, canonical, runtime.platform)) {
    throw installError(
      'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
      'plugins root cannot traverse a symbolic link',
    );
  }
  assertPluginsRootShape(canonical);
  return canonical;
}

function stagePath(directory, name, randomBytes) {
  return path.join(
    directory,
    `.${name}.stage-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
}

async function assertAbsent(promises, candidate, label) {
  if (await lstatIfExists(promises, candidate)) {
    throw installError('AE_PLUGIN_INSTALL_CONFLICT', `${label} already exists`);
  }
}

async function preflightInstall(input, runtime) {
  assertWindowsRuntime(runtime);
  const artifactInput = input?.artifactPath;
  if (typeof artifactInput !== 'string' || !path.isAbsolute(artifactInput)) {
    throw installError('AE_PLUGIN_ARGUMENT_INVALID', '--artifact must be an absolute path');
  }
  const resolvedArtifact = path.resolve(artifactInput);
  const artifactStats = await lstatIfExists(runtime.promises, resolvedArtifact);
  if (!artifactStats?.isFile() || artifactStats.isSymbolicLink()
      || artifactStats.size < 1024 || artifactStats.size > MAX_ARTIFACT_BYTES
      || path.basename(resolvedArtifact) !== ARTIFACT_NAME) {
    throw installError(
      'AE_PLUGIN_INSTALL_FAILED',
      'artifact must be one bounded regular AeMcpNative.aex file',
    );
  }
  const artifactPath = await runtime.promises.realpath(resolvedArtifact);
  const canonicalArtifactStats = await runtime.promises.lstat(artifactPath);
  if (!canonicalArtifactStats.isFile() || canonicalArtifactStats.isSymbolicLink()
      || canonicalArtifactStats.size !== artifactStats.size) {
    throw installError(
      'AE_PLUGIN_INSTALL_FAILED',
      'artifact identity changed while its canonical path was resolved',
    );
  }
  const sourceSha256 = await digestFile(artifactPath, runtime.promises);
  const buildReceipt = await loadBuildReceipt(input?.buildReceiptPath, runtime);
  const buildIdentity = validateBuildReceipt(buildReceipt.value, {
    artifactPath,
    artifactStats: canonicalArtifactStats,
    sourceSha256,
  }, runtime);
  const verification = await runtime.verifyWindowsAex({
    artifactPath,
    expectedCommit: buildIdentity.sourceCommit,
    expectedProductVersion: buildIdentity.productVersion,
  });
  validateArtifactVerification(verification, {
    artifactStats: canonicalArtifactStats,
    sourceSha256,
    ...buildIdentity,
  });
  const receiptParent = path.dirname(artifactPath);
  const receiptParentStats = await runtime.promises.lstat(receiptParent);
  if (!receiptParentStats.isDirectory() || receiptParentStats.isSymbolicLink()) {
    throw installError(
      'AE_PLUGIN_INSTALL_FAILED',
      'artifact receipt parent must be a real directory',
    );
  }
  await runtime.promises.access(receiptParent, runtime.constants.W_OK);
  const receiptPath = path.join(receiptParent, RECEIPT_NAME);
  await assertAbsent(runtime.promises, receiptPath, 'install receipt');

  const pluginsRoot = await canonicalPluginsRoot(input?.pluginsRoot, runtime);
  await runtime.promises.access(pluginsRoot, runtime.constants.W_OK);
  const installedPath = path.join(pluginsRoot, ARTIFACT_NAME);
  await assertAbsent(runtime.promises, installedPath, 'development install target');

  const artifactStage = stagePath(pluginsRoot, ARTIFACT_NAME, runtime.randomBytes);
  const receiptStage = stagePath(receiptParent, RECEIPT_NAME, runtime.randomBytes);
  await assertAbsent(runtime.promises, artifactStage, 'artifact stage');
  await assertAbsent(runtime.promises, receiptStage, 'receipt stage');
  return {
    artifactPath,
    artifactStats: canonicalArtifactStats,
    sourceSha256,
    buildReceiptPath: buildReceipt.path,
    buildReceiptSha256: buildReceipt.sha256,
    sourceCommit: buildIdentity.sourceCommit,
    productVersion: buildIdentity.productVersion,
    pluginsRoot,
    installedPath,
    artifactStage,
    receiptPath,
    receiptStage,
  };
}

async function rollbackInstall(state, runtime, ownership) {
  const paths = [
    ownership.receipt ? state.receiptPath : null,
    ownership.receiptStage ? state.receiptStage : null,
    ownership.installed ? state.installedPath : null,
    ownership.artifactStage ? state.artifactStage : null,
  ].filter(Boolean);
  const failures = [];
  for (const candidate of paths) {
    try {
      await runtime.promises.rm(candidate, { force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw installError(
      'AE_PLUGIN_INSTALL_CLEANUP_REQUIRED',
      'development install rollback did not remove every transaction-owned path',
    );
  }
}

export async function installDevWindowsAex(input = {}, runtimeInput = {}) {
  const runtime = resolveRuntime(runtimeInput);
  let state;
  const ownership = {
    artifactStage: false,
    installed: false,
    receiptStage: false,
    receipt: false,
  };
  try {
    state = await preflightInstall(input, runtime);
    ownership.artifactStage = true;
    await runtime.promises.copyFile(
      state.artifactPath,
      state.artifactStage,
      runtime.constants.COPYFILE_EXCL,
    );
    const stageStats = await runtime.promises.lstat(state.artifactStage);
    const stageSha256 = await digestFile(state.artifactStage, runtime.promises);
    if (!stageStats.isFile() || stageStats.isSymbolicLink()
        || stageStats.size !== state.artifactStats.size
        || stageSha256 !== state.sourceSha256) {
      throw installError(
        'AE_PLUGIN_INSTALL_HASH_MISMATCH',
        'staged artifact does not match the preflight source identity',
      );
    }
    await assertAbsent(
      runtime.promises,
      state.installedPath,
      'development install target',
    );
    await runtime.promises.rename(state.artifactStage, state.installedPath);
    ownership.artifactStage = false;
    ownership.installed = true;

    const installedStats = await runtime.promises.lstat(state.installedPath);
    const installedSha256 = await digestFile(state.installedPath, runtime.promises);
    if (!installedStats.isFile() || installedStats.isSymbolicLink()
        || installedStats.size !== state.artifactStats.size
        || installedSha256 !== state.sourceSha256) {
      throw installError(
        'AE_PLUGIN_INSTALL_HASH_MISMATCH',
        'installed artifact does not match the verified stage identity',
      );
    }

    const receipt = {
      schemaVersion: 2,
      operation: 'install',
      sourceCommit: state.sourceCommit,
      productVersion: state.productVersion,
      buildReceipt: {
        path: state.buildReceiptPath,
        sha256: state.buildReceiptSha256,
      },
      artifact: {
        sourcePath: state.artifactPath,
        sourceSha256: state.sourceSha256,
        bytes: state.artifactStats.size,
      },
      installed: {
        path: state.installedPath,
        sha256: installedSha256,
        bytes: installedStats.size,
        mtimeMs: installedStats.mtimeMs,
      },
      topology: {
        kind: TOPOLOGY_KIND,
        pluginsRoot: state.pluginsRoot,
        artifactName: ARTIFACT_NAME,
      },
      installedAtUnixMs: Date.now(),
      runtimeEvidence: false,
    };
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    ownership.receiptStage = true;
    await runtime.promises.writeFile(
      state.receiptStage,
      receiptText,
      { flag: 'wx' },
    );
    if (await runtime.promises.readFile(state.receiptStage, 'utf8') !== receiptText) {
      throw installError(
        'AE_PLUGIN_INSTALL_FAILED',
        'staged install receipt did not round-trip exactly',
      );
    }
    await assertAbsent(runtime.promises, state.receiptPath, 'install receipt');
    await runtime.promises.rename(state.receiptStage, state.receiptPath);
    ownership.receiptStage = false;
    ownership.receipt = true;
    return Object.freeze({
      installedPath: state.installedPath,
      receipt: state.receiptPath,
      installedSha256,
    });
  } catch (error) {
    if (state) await rollbackInstall(state, runtime, ownership);
    throw normalizeError(error);
  }
}

function validateReceiptTopology(receipt, runtime) {
  const topology = receipt?.topology;
  const buildReceipt = receipt?.buildReceipt;
  const artifact = receipt?.artifact;
  const installed = receipt?.installed;
  if (receipt?.schemaVersion !== 2 || receipt?.operation !== 'install'
      || !COMMIT_PATTERN.test(receipt?.sourceCommit ?? '')
      || !PRODUCT_VERSION_PATTERN.test(receipt?.productVersion ?? '')
      || !isRecord(buildReceipt)
      || typeof buildReceipt.path !== 'string'
      || !path.isAbsolute(buildReceipt.path)
      || path.basename(buildReceipt.path) !== BUILD_RECEIPT_NAME
      || !HASH_PATTERN.test(buildReceipt.sha256 ?? '')
      || !isRecord(artifact)
      || artifact.sourceSha256 !== installed?.sha256
      || artifact.bytes !== installed?.bytes
      || topology?.kind !== TOPOLOGY_KIND
      || topology?.artifactName !== ARTIFACT_NAME
      || typeof topology?.pluginsRoot !== 'string'
      || !path.isAbsolute(topology.pluginsRoot)
      || typeof installed?.path !== 'string'
      || !path.isAbsolute(installed.path)
      || typeof installed.sha256 !== 'string'
      || !HASH_PATTERN.test(installed.sha256)) {
    throw installError(
      'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
      'install receipt topology is invalid',
    );
  }
  assertPluginsRootShape(topology.pluginsRoot);
  const expectedInstalledPath = path.join(topology.pluginsRoot, ARTIFACT_NAME);
  if (!samePath(receipt.installed.path, expectedInstalledPath, runtime.platform)) {
    throw installError(
      'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
      'install receipt target escapes its per-app Extensions topology',
    );
  }
  return { pluginsRoot: topology.pluginsRoot, installedPath: expectedInstalledPath };
}

export async function removeDevWindowsAex(input = {}, runtimeInput = {}) {
  const runtime = resolveRuntime(runtimeInput);
  try {
    assertWindowsRuntime(runtime);
    const receiptPath = input?.receiptPath;
    if (typeof receiptPath !== 'string' || !path.isAbsolute(receiptPath)) {
      throw installError('AE_PLUGIN_ARGUMENT_INVALID', '--receipt must be an absolute path');
    }
    const receiptStats = await lstatIfExists(runtime.promises, receiptPath);
    if (!receiptStats?.isFile() || receiptStats.isSymbolicLink()
        || receiptStats.size === 0 || receiptStats.size > MAX_RECEIPT_BYTES) {
      throw installError('AE_PLUGIN_INSTALL_FAILED', 'install receipt is unreadable');
    }
    let receipt;
    try {
      receipt = JSON.parse(await runtime.promises.readFile(receiptPath, 'utf8'));
    } catch {
      throw installError('AE_PLUGIN_INSTALL_FAILED', 'install receipt is unreadable');
    }
    const topology = validateReceiptTopology(receipt, runtime);
    const canonicalRoot = await canonicalPluginsRoot(topology.pluginsRoot, runtime);
    if (!samePath(canonicalRoot, topology.pluginsRoot, runtime.platform)) {
      throw installError(
        'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
        'install receipt plugins root is no longer canonical',
      );
    }
    const stats = await lstatIfExists(runtime.promises, topology.installedPath);
    if (stats) {
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw installError(
          'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
          'installed artifact is no longer one regular file',
        );
      }
      const currentSha256 = await digestFile(topology.installedPath, runtime.promises);
      if (currentSha256 !== receipt.installed.sha256) {
        throw installError(
          'AE_PLUGIN_INSTALL_HASH_MISMATCH',
          'installed artifact changed since the receipt was recorded; refusing removal',
        );
      }
      await runtime.promises.rm(topology.installedPath);
    }
    await runtime.promises.rm(receiptPath);
    return Object.freeze({ removed: true });
  } catch (error) {
    throw normalizeError(error);
  }
}

function parseCli(argv) {
  const [commandName, ...rest] = argv;
  const allowed = commandName === 'install'
    ? new Set(['--artifact', '--build-receipt', '--plugins-root'])
    : commandName === 'remove'
      ? new Set(['--receipt'])
      : null;
  if (!allowed) throw installError('AE_PLUGIN_ARGUMENT_INVALID', 'expected install or remove');
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!allowed.has(name) || !value || options.has(name)) {
      throw installError('AE_PLUGIN_ARGUMENT_INVALID', 'invalid or duplicate CLI option');
    }
    options.set(name, value);
  }
  if (commandName === 'install'
      && (!options.has('--artifact')
        || !options.has('--build-receipt')
        || !options.has('--plugins-root'))) {
    throw installError(
      'AE_PLUGIN_ARGUMENT_INVALID',
      'install requires --artifact, --build-receipt, and --plugins-root',
    );
  }
  if (commandName === 'remove' && !options.has('--receipt')) {
    throw installError('AE_PLUGIN_ARGUMENT_INVALID', 'remove requires --receipt');
  }
  return { commandName, options };
}

function publicError(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'AE_PLUGIN_INSTALL_FAILED',
      message: typeof error?.message === 'string' ? error.message : 'development install failed',
    },
  };
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(CLI_USAGE);
  } else {
    try {
      const { commandName, options } = parseCli(argv);
      const result = commandName === 'install'
        ? await installDevWindowsAex({
          artifactPath: options.get('--artifact'),
          buildReceiptPath: options.get('--build-receipt'),
          pluginsRoot: options.get('--plugins-root'),
        })
        : await removeDevWindowsAex({ receiptPath: options.get('--receipt') });
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
      process.stderr.write(CLI_USAGE);
      process.exitCode = 1;
    }
  }
}
