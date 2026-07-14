#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { verifyMacPlugin } from './verify-macos.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const BUNDLE_NAME = 'AeMcpNative.plugin';
const NAMESPACE_NAME = 'ae-mcp';
const RECEIPT_NAME = 'build-receipt.json';
const LOCK_NAME = '.AeMcpNative.install.lock';
const GUARD_NAME = '.AeMcpNative.install.guard';
const CURRENT_NAME = '.AeMcpNative.current.json';
const STATE_STORE_NAME = 'store';
const MIGRATION_NAME = 'legacy-namespace-migration';
const ORPHAN_EVIDENCE_NAME = 'orphan-evidence';
const DARWIN_O_EXLOCK = 0x20;
const MAX_JSON_BYTES = 64 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const MANAGED_BUNDLE_NAME = /^\.AeMcpNative\.(?:stage|backup|failed|replaced)\.([0-9a-f-]+)\.disabled$/u;
const TRANSACTION_FILE_NAME = /^\.AeMcpNative\.transaction\.([0-9a-f-]+)\.json$/u;
const STALE_LOCK_FILE_NAME = /^\.AeMcpNative\.stale-lock\.([0-9a-f-]+)\.json$/u;
const INSTALLER_TEMP_FILE_NAME = /^\.(\.AeMcpNative\.(?:current|transaction\.([0-9a-f-]+))\.json)\.tmp-[1-9][0-9]*-[0-9a-f]{12}$/u;
const LOCK_TEMP_FILE_NAME = /^\.\.AeMcpNative\.install\.lock\.tmp-[1-9][0-9]*-[0-9a-f]{12}$/u;
const STAGE_BUNDLE_NAME = /^\.AeMcpNative\.stage\.([0-9a-f-]+)\.disabled$/u;
const ARTIFACT_KEYS = [
  'architecture',
  'bundleName',
  'bundleTreeSha256',
  'bundleType',
  'codeSignature',
  'entryPoint',
  'executableSha256',
  'fileCount',
  'piplSha256',
  'platform',
  'schemaVersion',
];

function installerError(code, message, recovery) {
  const error = new Error(message);
  error.code = code;
  if (recovery) error.recovery = recovery;
  return error;
}

function defaultMediaCoreRoot() {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Adobe',
    'Common',
    'Plug-ins',
    '7.0',
    'MediaCore',
  );
}

function defaultStateBaseRoot(mediaCoreRoot) {
  if (path.resolve(mediaCoreRoot) === path.resolve(defaultMediaCoreRoot())) {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'AfterEffectsMCP',
      'native-plugin-dev-v1',
    );
  }
  return path.join(path.dirname(path.resolve(mediaCoreRoot)), '.ae-mcp-native-state-v1');
}

function isSameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)
      || !isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    throw installerError('AE_PLUGIN_RECEIPT_INVALID', `${label} has an unexpected shape`);
  }
}

function validateArtifact(value, label = 'artifact') {
  assertExactKeys(value, ARTIFACT_KEYS, label);
  if (value.schemaVersion !== 1
      || value.bundleName !== BUNDLE_NAME
      || value.platform !== 'macos-arm64'
      || value.architecture !== 'arm64'
      || value.bundleType !== 'AEgx'
      || value.entryPoint !== 'AeMcpNativeMain'
      || value.codeSignature !== 'ad-hoc-verified'
      || !Number.isSafeInteger(value.fileCount)
      || value.fileCount <= 0
      || !SHA256.test(value.bundleTreeSha256)
      || !SHA256.test(value.executableSha256)
      || !SHA256.test(value.piplSha256)) {
    throw installerError('AE_PLUGIN_RECEIPT_INVALID', `${label} is not a supported native artifact`);
  }
  return value;
}

function validateReceipt(value) {
  assertExactKeys(
    value,
    [
      'artifact',
      'build',
      'protocolSchemaSha256',
      'schemaVersion',
      'sdk',
      'source',
      'sourceCommit',
    ],
    'build receipt',
  );
  assertExactKeys(value.source, ['commit', 'repositoryClean'], 'build receipt source record');
  assertExactKeys(
    value.sdk,
    [
      'archiveVerification',
      'claimedBuild',
      'claimedVersion',
      'inputProvenance',
      'materialIncluded',
      'name',
      'rootVerification',
    ],
    'build receipt SDK record',
  );
  assertExactKeys(
    value.build,
    [
      'compatibilityEvidence',
      'configuration',
      'distributionApproved',
      'runtimeEvidence',
      'signing',
    ],
    'build receipt build record',
  );
  validateArtifact(value.artifact, 'build receipt artifact');
  if (value.schemaVersion !== 1
      || !COMMIT_SHA.test(value.sourceCommit)
      || value.source.commit !== value.sourceCommit
      || value.source.repositoryClean !== true
      || !SHA256.test(value.protocolSchemaSha256)
      || value.sdk.name !== 'Adobe After Effects C/C++ Plug-in SDK'
      || value.sdk.claimedVersion !== '25.6.61'
      || value.sdk.claimedBuild !== 61
      || value.sdk.materialIncluded !== false
      || value.sdk.archiveVerification !== 'sha256-verified'
      || value.sdk.rootVerification !== 'layout-and-content-verified'
      || value.sdk.inputProvenance
        !== 'archive-byte-identity-plus-canonical-root-content'
      || value.build.configuration !== 'development'
      || value.build.signing !== 'ad-hoc'
      || value.build.distributionApproved !== false
      || value.build.runtimeEvidence !== false
      || value.build.compatibilityEvidence !== false) {
    throw installerError('AE_PLUGIN_RECEIPT_INVALID', 'build receipt is not an approved development build');
  }
  return value;
}

function managedName(kind, transactionId) {
  return `.AeMcpNative.${kind}.${transactionId}.disabled`;
}

function transactionName(transactionId) {
  return `.AeMcpNative.transaction.${transactionId}.json`;
}

function assertTransactionId(transactionId) {
  if (!UUID_V4.test(transactionId ?? '')) {
    throw installerError('AE_PLUGIN_ARGUMENT_INVALID', 'transaction must be a lowercase UUID v4');
  }
}

function nowIso(dependencies) {
  const value = dependencies.now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw installerError('AE_PLUGIN_INSTALL_FAILED', 'installer clock returned an invalid time');
  }
  return date.toISOString();
}

function lstatOrNull(candidate) {
  return fs.promises.lstat(candidate).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertEmbeddedSourceCommit(bundlePath, sourceCommit) {
  const executable = path.join(bundlePath, 'Contents', 'MacOS', 'AeMcpNative');
  const metadata = await fs.promises.lstat(executable).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size <= 0 || metadata.size > 128 * 1024 * 1024) {
    throw installerError(
      'AE_PLUGIN_RECEIPT_MISMATCH',
      'native executable is not a bounded regular file for source binding',
    );
  }
  const bytes = await fs.promises.readFile(executable);
  if (!bytes.includes(Buffer.from(sourceCommit, 'ascii'))) {
    throw installerError(
      'AE_PLUGIN_RECEIPT_MISMATCH',
      'native executable does not embed the build receipt source commit',
    );
  }
}

async function ensureMissing(candidate, label) {
  if (await lstatOrNull(candidate)) {
    throw installerError('AE_PLUGIN_INSTALL_STATE_CONFLICT', `${label} already exists`);
  }
}

async function ensureSafeDirectory(directory, label = 'installer') {
  if (!path.isAbsolute(directory)) {
    throw installerError('AE_PLUGIN_INSTALL_ROOT_UNSAFE', `${label} root must be absolute`);
  }
  const parsed = path.parse(path.resolve(directory));
  let current = parsed.root;
  for (const component of path.resolve(directory).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let metadata = await lstatOrNull(current);
    if (!metadata) {
      try {
        await fs.promises.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      metadata = await fs.promises.lstat(current);
      await syncDirectory(path.dirname(current));
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw installerError(
        'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
        `${label} path contains a symbolic or non-directory component`,
      );
    }
  }
  return fs.promises.realpath(directory);
}

async function readBoundedRegularFile(file, label) {
  const metadata = await lstatOrNull(file);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size <= 0 || metadata.size > MAX_JSON_BYTES) {
    throw installerError('AE_PLUGIN_RECEIPT_INVALID', `${label} is not a bounded regular file`);
  }
  return fs.promises.readFile(file);
}

async function loadSourceArtifact(artifactDir, dependencies) {
  if (!artifactDir || !path.isAbsolute(artifactDir)) {
    throw installerError('AE_PLUGIN_ARGUMENT_INVALID', 'artifact directory must be absolute');
  }
  const metadata = await fs.promises.lstat(artifactDir).catch(() => null);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) {
    throw installerError('AE_PLUGIN_ARTIFACT_INVALID', 'artifact directory is missing or symbolic');
  }
  const entries = (await fs.promises.readdir(artifactDir)).sort();
  if (!isDeepStrictEqual(entries, [BUNDLE_NAME, RECEIPT_NAME].sort())) {
    throw installerError(
      'AE_PLUGIN_ARTIFACT_INVALID',
      'artifact directory must contain only the native bundle and build receipt',
    );
  }
  const bundlePath = path.join(artifactDir, BUNDLE_NAME);
  const bundleMetadata = await fs.promises.lstat(bundlePath).catch(() => null);
  if (!bundleMetadata?.isDirectory() || bundleMetadata.isSymbolicLink()) {
    throw installerError('AE_PLUGIN_ARTIFACT_INVALID', 'source native bundle is missing or symbolic');
  }
  const receiptBytes = await readBoundedRegularFile(
    path.join(artifactDir, RECEIPT_NAME),
    'build receipt',
  );
  let receipt;
  try {
    receipt = validateReceipt(JSON.parse(receiptBytes.toString('utf8')));
  } catch (error) {
    if (typeof error?.code === 'string') throw error;
    throw installerError('AE_PLUGIN_RECEIPT_INVALID', 'build receipt is not valid JSON');
  }
  const observed = validateArtifact(
    await dependencies.verifyBundle({ bundlePath }),
    'verified source artifact',
  );
  if (!isDeepStrictEqual(observed, receipt.artifact)) {
    throw installerError(
      'AE_PLUGIN_RECEIPT_MISMATCH',
      'verified source bundle does not match its complete build receipt artifact record',
    );
  }
  await assertEmbeddedSourceCommit(bundlePath, receipt.sourceCommit);
  return {
    bundlePath,
    receipt,
    receiptSha256: crypto.createHash('sha256').update(receiptBytes).digest('hex'),
  };
}

async function syncDirectory(directory) {
  const handle = await fs.promises.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertSameFilesystem(sourceParent, destinationParent) {
  const [sourceMetadata, destinationMetadata] = await Promise.all([
    fs.promises.stat(sourceParent),
    fs.promises.stat(destinationParent),
  ]);
  if (sourceMetadata.dev !== destinationMetadata.dev) {
    throw installerError(
      'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
      'native deployment rename crosses filesystem boundaries',
    );
  }
}

async function durableRename(
  source,
  destination,
  renameOperation = fs.promises.rename,
  syncOperation = syncDirectory,
) {
  const sourceParent = path.dirname(source);
  const destinationParent = path.dirname(destination);
  await assertSameFilesystem(sourceParent, destinationParent);
  const [sourceMetadata, destinationParentMetadata] = await Promise.all([
    fs.promises.stat(source),
    fs.promises.stat(destinationParent),
  ]);
  if (sourceMetadata.dev !== destinationParentMetadata.dev) {
    throw installerError(
      'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
      'native deployment source is mounted on a different filesystem',
    );
  }
  let renameCompleted = false;
  try {
    await renameOperation(source, destination);
    renameCompleted = true;
    const parents = [...new Set([sourceParent, destinationParent])];
    await Promise.all(parents.map((directory) => syncOperation(directory)));
  } catch (error) {
    if (renameCompleted && error && typeof error === 'object') {
      error.renameCompleted = true;
    }
    throw error;
  }
}

async function renameBundleDurable(dependencies, source, destination) {
  await dependencies.assertAeStopped();
  await durableRename(
    source,
    destination,
    dependencies.renameBundle,
    dependencies.syncDirectory,
  );
}

async function renameBundleTracked(dependencies, source, destination, markMoved) {
  try {
    await renameBundleDurable(dependencies, source, destination);
    markMoved();
  } catch (error) {
    if (error?.renameCompleted
        || (!await lstatOrNull(source) && await lstatOrNull(destination))) {
      markMoved();
    }
    throw error;
  }
}

async function renameDeploymentDirectoryDurable(dependencies, source, destination) {
  await dependencies.assertAeStopped();
  await durableRename(
    source,
    destination,
    fs.promises.rename,
    dependencies.syncDirectory,
  );
}

async function syncTree(candidate, syncOperation = syncDirectory) {
  const metadata = await fs.promises.lstat(candidate);
  if (metadata.isSymbolicLink()) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'native staging tree contains a symbolic entry',
    );
  }
  if (metadata.isDirectory()) {
    for (const name of await fs.promises.readdir(candidate)) {
      await syncTree(path.join(candidate, name), syncOperation);
    }
    await syncOperation(candidate);
    return;
  }
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'native staging tree contains an unsupported filesystem entry',
    );
  }
  const handle = await fs.promises.open(candidate, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonExclusive(file, value) {
  const handle = await fs.promises.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function writeJsonExclusiveAtomic(file, value) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  let published = false;
  try {
    await writeJsonExclusive(temporary, value);
    await fs.promises.link(temporary, file);
    published = true;
    await syncDirectory(path.dirname(file));
    await fs.promises.unlink(temporary).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {});
    if (published) await syncDirectory(path.dirname(file)).catch(() => {});
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    await writeJsonExclusive(temporary, value);
    await fs.promises.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readJson(file, label) {
  const bytes = await readBoundedRegularFile(file, label);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw installerError('AE_PLUGIN_INSTALL_STATE_INVALID', `${label} is not valid JSON`);
  }
}

async function readCurrentTransactionId(currentPath) {
  if (!await lstatOrNull(currentPath)) return null;
  const current = await readJson(currentPath, 'current installation record');
  if (!isRecord(current) || current.schemaVersion !== 1
      || !(current.transactionId === null || UUID_V4.test(current.transactionId))) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'current installation record is invalid',
    );
  }
  return current.transactionId;
}

async function writeCurrentTransaction(currentPath, transactionId, dependencies, extra = {}) {
  await writeJsonAtomic(currentPath, {
    schemaVersion: 1,
    transactionId,
    ...extra,
    updatedAt: nowIso(dependencies),
  });
}

function simulatedCrash(error) {
  return error?.simulatedCrash === true;
}

async function readLockOwner(lockPath) {
  const metadata = await fs.promises.lstat(lockPath).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.size <= 0 || metadata.size > 4096) {
    throw installerError(
      'AE_PLUGIN_INSTALL_LOCKED',
      'native install lock is invalid and cannot be recovered automatically',
    );
  }
  try {
    const value = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
    if (!isRecord(value) || !Number.isSafeInteger(value.pid) || value.pid <= 0
        || typeof value.createdAt !== 'string') {
      throw new Error('invalid lock');
    }
    return value;
  } catch {
    throw installerError(
      'AE_PLUGIN_INSTALL_LOCKED',
      'native install lock is invalid and cannot be recovered automatically',
    );
  }
}

async function removePublishedLockTempAliases(directory, lockPath) {
  const lockMetadata = await lstatOrNull(lockPath);
  if (!lockMetadata) return;
  let changed = false;
  for (const name of await fs.promises.readdir(directory)) {
    if (!LOCK_TEMP_FILE_NAME.test(name)) continue;
    const temporary = path.join(directory, name);
    const metadata = await lstatOrNull(temporary);
    if (metadata?.isFile() && !metadata.isSymbolicLink()
        && metadata.dev === lockMetadata.dev && metadata.ino === lockMetadata.ino) {
      try {
        await fs.promises.unlink(temporary);
        changed = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  if (changed) await syncDirectory(directory);
}

async function defaultAcquireStateGuard(directory) {
  if (process.platform !== 'darwin') {
    throw installerError(
      'AE_PLUGIN_PLATFORM_UNSUPPORTED',
      'native installer kernel guard requires macOS',
    );
  }
  const guardPath = path.join(directory, GUARD_NAME);
  const flags = fs.constants.O_RDWR
    | fs.constants.O_CREAT
    | fs.constants.O_NONBLOCK
    | fs.constants.O_NOFOLLOW
    | DARWIN_O_EXLOCK;
  let handle;
  try {
    handle = await fs.promises.open(guardPath, flags, 0o600);
  } catch (error) {
    if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') {
      throw installerError(
        'AE_PLUGIN_INSTALL_LOCKED',
        'another native install or rollback holds the kernel guard',
      );
    }
    throw error;
  }
  try {
    const [descriptorMetadata, pathMetadata] = await Promise.all([
      handle.stat(),
      fs.promises.lstat(guardPath),
    ]);
    if (!descriptorMetadata.isFile() || descriptorMetadata.nlink !== 1
        || pathMetadata.isSymbolicLink() || !pathMetadata.isFile()
        || descriptorMetadata.dev !== pathMetadata.dev
        || descriptorMetadata.ino !== pathMetadata.ino) {
      throw installerError(
        'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
        'native installer kernel guard is not a private regular file',
      );
    }
    await handle.sync();
    await syncDirectory(directory);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  return async () => {
    await handle.close();
  };
}

async function acquireLock(directory, dependencies) {
  const releaseGuard = await dependencies.acquireStateGuard(directory);
  const lockPath = path.join(directory, LOCK_NAME);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ownerRecord = {
        pid: process.pid,
        createdAt: nowIso(dependencies),
        nonce: crypto.randomBytes(16).toString('hex'),
      };
      try {
        await writeJsonExclusiveAtomic(lockPath, ownerRecord);
        const identity = await fs.promises.lstat(lockPath);
        return async () => {
          try {
            const observed = await lstatOrNull(lockPath);
            if (!observed || observed.dev !== identity.dev || observed.ino !== identity.ino) {
              throw installerError(
                'AE_PLUGIN_INSTALL_LOCKED',
                'native install lock ownership changed before release',
              );
            }
            await fs.promises.unlink(lockPath);
            await syncDirectory(directory);
          } finally {
            await releaseGuard();
          }
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        await removePublishedLockTempAliases(directory, lockPath);
        if (!await lstatOrNull(lockPath)) continue;
        let owner;
        try {
          owner = await readLockOwner(lockPath);
        } catch (lockError) {
          if (!await lstatOrNull(lockPath)) continue;
          const metadata = await fs.promises.lstat(lockPath);
          if (!metadata.isFile() || metadata.isSymbolicLink()
              || metadata.nlink !== 1 || metadata.size > 4096) {
            throw lockError;
          }
        }
        if (owner && await dependencies.isProcessAlive(owner.pid)) {
          throw installerError(
            'AE_PLUGIN_INSTALL_LOCKED',
            'another native install or rollback is active',
          );
        }
        const stalePath = path.join(
          directory,
          `.AeMcpNative.stale-lock.${crypto.randomUUID()}.json`,
        );
        try {
          await durableRename(
            lockPath,
            stalePath,
            fs.promises.rename,
            dependencies.syncDirectory,
          );
        } catch (renameError) {
          if (renameError?.code !== 'ENOENT') throw renameError;
        }
      }
    }
    throw installerError('AE_PLUGIN_INSTALL_LOCKED', 'could not acquire the native install lock');
  } catch (error) {
    await releaseGuard().catch(() => {});
    throw error;
  }
}

async function defaultAssertAeStopped() {
  try {
    execFileSync(
      '/usr/bin/pgrep',
      [
        '-x',
        'After Effects|After Effects \\(Beta\\)|Adobe After Effects|Adobe After Effects \\(Beta\\)|AfterFX|aerender',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    throw installerError(
      'AE_PROCESS_RUNNING',
      'all After Effects and aerender processes must be closed before native deployment',
    );
  } catch (error) {
    if (error?.code === 'AE_PROCESS_RUNNING') throw error;
    if (error?.status === 1) return;
    throw installerError(
      'AE_PROCESS_CHECK_FAILED',
      'could not determine whether After Effects or aerender is running',
    );
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

function dependenciesFor(overrides = {}) {
  return {
    acquireStateGuard: overrides.acquireStateGuard ?? defaultAcquireStateGuard,
    assertAeStopped: overrides.assertAeStopped ?? defaultAssertAeStopped,
    copyBundle: overrides.copyBundle ?? ((source, destination) => fs.promises.cp(
      source,
      destination,
      {
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        recursive: true,
        verbatimSymlinks: true,
      },
    )),
    isProcessAlive: overrides.isProcessAlive ?? defaultIsProcessAlive,
    now: overrides.now ?? (() => new Date()),
    onTransition: overrides.onTransition ?? (() => {}),
    platform: overrides.platform ?? process.platform,
    randomUUID: overrides.randomUUID ?? (() => crypto.randomUUID()),
    renameBundle: overrides.renameBundle ?? ((source, destination) => (
      fs.promises.rename(source, destination)
    )),
    syncDirectory: overrides.syncDirectory ?? syncDirectory,
    verifyBundle: overrides.verifyBundle ?? verifyMacPlugin,
  };
}

function requireMac(dependencies) {
  if (dependencies.platform !== 'darwin') {
    throw installerError(
      'AE_PLUGIN_PLATFORM_UNSUPPORTED',
      'native development installation requires macOS',
    );
  }
}

async function inspectTarget(target, dependencies) {
  const metadata = await lstatOrNull(target);
  if (!metadata) return null;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw installerError(
      'AE_PLUGIN_EXISTING_TARGET_INVALID',
      'existing native plug-in target is not a real bundle directory',
    );
  }
  try {
    return validateArtifact(
      await dependencies.verifyBundle({ bundlePath: target }),
      'existing installed artifact',
    );
  } catch (error) {
    if (error?.code === 'AE_PLUGIN_RECEIPT_INVALID') throw error;
    throw installerError(
      'AE_PLUGIN_EXISTING_TARGET_INVALID',
      'existing native plug-in target failed verification',
    );
  }
}

async function verifyDisabled(bundlePath, expected, dependencies, label, sourceCommit = null) {
  const observed = validateArtifact(
    await dependencies.verifyBundle({ bundlePath, allowManagedDisabledName: true }),
    label,
  );
  if (!isDeepStrictEqual(observed, expected)) {
    throw installerError('AE_PLUGIN_RECEIPT_MISMATCH', `${label} does not match its recorded hash set`);
  }
  if (sourceCommit) await assertEmbeddedSourceCommit(bundlePath, sourceCommit);
  return observed;
}

async function verifyTarget(target, expected, dependencies, label, sourceCommit = null) {
  const observed = validateArtifact(
    await dependencies.verifyBundle({ bundlePath: target }),
    label,
  );
  if (!isDeepStrictEqual(observed, expected)) {
    throw installerError('AE_PLUGIN_RECEIPT_MISMATCH', `${label} does not match its recorded hash set`);
  }
  if (sourceCommit) await assertEmbeddedSourceCommit(target, sourceCommit);
  return observed;
}

async function removeGeneratedStage(stage, stateStore) {
  if (path.dirname(stage) !== stateStore
      || !path.basename(stage).startsWith('.AeMcpNative.stage.')
      || !path.basename(stage).endsWith('.disabled')) {
    throw installerError('AE_PLUGIN_INSTALL_STATE_INVALID', 'refused to remove an unmanaged path');
  }
  await fs.promises.rm(stage, { recursive: true, force: true });
  await syncDirectory(stateStore);
}

async function prepareRoots(mediaCoreRoot, stateBaseRoot) {
  if (!path.isAbsolute(mediaCoreRoot) || !path.isAbsolute(stateBaseRoot)) {
    throw installerError(
      'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
      'MediaCore and native installer state roots must be absolute',
    );
  }
  const mediaCore = path.resolve(mediaCoreRoot);
  const stateBaseInput = path.resolve(stateBaseRoot);
  if (isSameOrDescendant(mediaCore, stateBaseInput)
      || isSameOrDescendant(stateBaseInput, mediaCore)) {
    throw installerError(
      'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
      'native installer state must remain outside the Adobe plug-in scan root',
    );
  }
  const safeMediaCore = await ensureSafeDirectory(mediaCore, 'MediaCore');
  const stateBase = await ensureSafeDirectory(stateBaseInput, 'native installer state');
  if (isSameOrDescendant(safeMediaCore, stateBase)
      || isSameOrDescendant(stateBase, safeMediaCore)) {
    throw installerError(
      'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
      'native installer state resolves inside the Adobe plug-in scan root',
    );
  }
  const [mediaCoreMetadata, stateBaseMetadata] = await Promise.all([
    fs.promises.stat(safeMediaCore),
    fs.promises.stat(stateBase),
  ]);
  if (mediaCoreMetadata.dev !== stateBaseMetadata.dev) {
    throw installerError(
      'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
      'native installer state and MediaCore must share a filesystem for atomic deployment',
    );
  }
  const namespace = path.join(safeMediaCore, NAMESPACE_NAME);
  const stateStore = path.join(stateBase, STATE_STORE_NAME);
  const migration = path.join(stateBase, MIGRATION_NAME);
  for (const [candidate, label] of [
    [namespace, 'managed MediaCore namespace'],
    [stateStore, 'native installer state store'],
    [migration, 'native installer legacy migration'],
  ]) {
    const metadata = await lstatOrNull(candidate);
    if (!metadata) continue;
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw installerError(
        'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
        `${label} is symbolic or not a directory`,
      );
    }
    if ((await fs.promises.stat(candidate)).dev !== mediaCoreMetadata.dev) {
      throw installerError(
        'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
        `${label} is mounted on a different filesystem`,
      );
    }
  }
  return {
    device: mediaCoreMetadata.dev,
    migration,
    namespace,
    stateBase,
    stateStore,
    target: path.join(namespace, BUNDLE_NAME),
  };
}

function managedStateEntry(name) {
  if (name === BUNDLE_NAME || name === LOCK_NAME || name === CURRENT_NAME) return true;
  const managed = MANAGED_BUNDLE_NAME.exec(name);
  if (managed) return UUID_V4.test(managed[1] ?? '');
  const transaction = TRANSACTION_FILE_NAME.exec(name);
  if (transaction) return UUID_V4.test(transaction[1] ?? '');
  const staleLock = STALE_LOCK_FILE_NAME.exec(name);
  if (staleLock) return UUID_V4.test(staleLock[1] ?? '');
  return false;
}

async function validateManagedStateDirectory(directory, label) {
  const metadata = await lstatOrNull(directory);
  if (!metadata) return [];
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw installerError(
      'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
      `${label} is symbolic or not a directory`,
    );
  }
  const entries = (await fs.promises.readdir(directory)).sort();
  for (const name of entries) {
    if (!managedStateEntry(name)) {
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        `${label} contains an unexpected entry`,
      );
    }
    const entry = await fs.promises.lstat(path.join(directory, name));
    if (entry.isSymbolicLink()) {
      if (name === BUNDLE_NAME) {
        throw installerError(
          'AE_PLUGIN_EXISTING_TARGET_INVALID',
          'existing native plug-in target is symbolic',
        );
      }
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        `${label} contains a symbolic entry`,
      );
    }
    const bundleShaped = name === BUNDLE_NAME || MANAGED_BUNDLE_NAME.test(name);
    if ((bundleShaped && !entry.isDirectory()) || (!bundleShaped && !entry.isFile())) {
      if (name === BUNDLE_NAME) {
        throw installerError(
          'AE_PLUGIN_EXISTING_TARGET_INVALID',
          'existing native plug-in target is not a bundle directory',
        );
      }
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        `${label} contains an entry with the wrong type`,
      );
    }
  }
  return entries;
}

async function assertManagedDirectoryDevice(directory, device, label) {
  const metadata = await lstatOrNull(directory);
  if (!metadata) return false;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || (await fs.promises.stat(directory)).dev !== device) {
    throw installerError(
      'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
      `${label} is unsafe or mounted on a different filesystem`,
    );
  }
  return true;
}

async function ensureManagedDirectory(directory, device, label) {
  const safeDirectory = await ensureSafeDirectory(directory, label);
  await assertManagedDirectoryDevice(safeDirectory, device, label);
  return safeDirectory;
}

async function ensureDeploymentNamespace(dependencies, namespace, device) {
  if (await lstatOrNull(namespace)) {
    await assertManagedDirectoryDevice(namespace, device, 'managed MediaCore namespace');
    return;
  }
  await dependencies.assertAeStopped();
  await ensureManagedDirectory(namespace, device, 'managed MediaCore namespace');
  await dependencies.syncDirectory(path.dirname(namespace));
}

async function assertLegacyLockInactive(directory, dependencies) {
  const lockPath = path.join(directory, LOCK_NAME);
  if (!await lstatOrNull(lockPath)) return null;
  const owner = await readLockOwner(lockPath);
  if (await dependencies.isProcessAlive(owner.pid)) {
    throw installerError(
      'AE_PLUGIN_INSTALL_LOCKED',
      'a legacy native install or rollback is active',
    );
  }
  return owner;
}

async function rotateLegacyLock(directory, stateStore, dependencies, checkedOwner = undefined) {
  const lockPath = path.join(directory, LOCK_NAME);
  if (!await lstatOrNull(lockPath)) return false;
  if (checkedOwner === undefined) await assertLegacyLockInactive(directory, dependencies);
  let stalePath;
  do {
    stalePath = path.join(
      stateStore,
      `.AeMcpNative.stale-lock.${crypto.randomUUID()}.json`,
    );
  } while (await lstatOrNull(stalePath));
  await durableRename(
    lockPath,
    stalePath,
    fs.promises.rename,
    dependencies.syncDirectory,
  );
  return true;
}

function installerTempFinalName(name) {
  const match = INSTALLER_TEMP_FILE_NAME.exec(name);
  if (!match || (match[2] && !UUID_V4.test(match[2]))) return null;
  return match[1];
}

async function ensureOrphanEvidenceDirectory(stateBase, device, name) {
  const evidenceBase = await ensureManagedDirectory(
    path.join(stateBase, ORPHAN_EVIDENCE_NAME),
    device,
    'native installer orphan evidence',
  );
  return ensureManagedDirectory(
    path.join(evidenceBase, name),
    device,
    'native installer orphan evidence record',
  );
}

async function moveOrphanEvidence(source, destinationDirectory, dependencies) {
  const destination = path.join(destinationDirectory, path.basename(source));
  await ensureMissing(destination, 'native installer orphan evidence');
  await durableRename(
    source,
    destination,
    fs.promises.rename,
    dependencies.syncDirectory,
  );
}

async function recoverInstallerTempFiles({
  dependencies,
  device,
  stateBase,
  stateStore,
}) {
  let recovered = 0;
  for (const name of await fs.promises.readdir(stateStore)) {
    const finalName = installerTempFinalName(name);
    if (!finalName) continue;
    const temporary = path.join(stateStore, name);
    const finalPath = path.join(stateStore, finalName);
    const [temporaryMetadata, finalMetadata] = await Promise.all([
      fs.promises.lstat(temporary),
      lstatOrNull(finalPath),
    ]);
    if (!temporaryMetadata.isFile() || temporaryMetadata.isSymbolicLink()
        || temporaryMetadata.size > MAX_JSON_BYTES || temporaryMetadata.nlink > 2) {
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        'native installer temporary state is unsafe',
      );
    }
    if (finalMetadata
        && finalMetadata.dev === temporaryMetadata.dev
        && finalMetadata.ino === temporaryMetadata.ino) {
      await fs.promises.unlink(temporary);
      await dependencies.syncDirectory(stateStore);
      recovered += 1;
      continue;
    }
    if (temporaryMetadata.nlink !== 1) {
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        'native installer temporary state has an unexpected hard link',
      );
    }
    const evidenceDirectory = await ensureOrphanEvidenceDirectory(
      stateBase,
      device,
      `temp-${crypto.randomUUID()}`,
    );
    await moveOrphanEvidence(temporary, evidenceDirectory, dependencies);
    recovered += 1;
  }
  return recovered;
}

async function archiveOrphanTransaction({
  dependencies,
  device,
  stateBase,
  stateStore,
  transactionId,
  transactionPath,
}) {
  const currentTransactionId = await readCurrentTransactionId(
    path.join(stateStore, CURRENT_NAME),
  );
  if (currentTransactionId === transactionId) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'current native transaction metadata is incomplete and cannot be archived',
    );
  }
  for (const kind of ['backup', 'failed', 'replaced']) {
    if (await lstatOrNull(path.join(stateStore, managedName(kind, transactionId)))) {
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        'partial native transaction has deployment evidence and requires manual recovery',
      );
    }
  }
  const stage = path.join(stateStore, managedName('stage', transactionId));
  const evidenceDirectory = await ensureOrphanEvidenceDirectory(
    stateBase,
    device,
    `transaction-${transactionId}`,
  );
  const evidenceStage = path.join(evidenceDirectory, path.basename(stage));
  if (!await lstatOrNull(stage) && !await lstatOrNull(evidenceStage)) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'partial native transaction has no recoverable staging evidence',
    );
  }
  if (transactionPath && await lstatOrNull(transactionPath)) {
    const metadata = await fs.promises.lstat(transactionPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
        || metadata.nlink !== 1 || metadata.size > MAX_JSON_BYTES) {
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        'partial native transaction metadata is unsafe',
      );
    }
    await moveOrphanEvidence(transactionPath, evidenceDirectory, dependencies);
  }
  if (await lstatOrNull(stage)) {
    const metadata = await fs.promises.lstat(stage);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        'partial native transaction stage is unsafe',
      );
    }
    await moveOrphanEvidence(stage, evidenceDirectory, dependencies);
  }
}

async function recoverOrphanStateArtifacts({
  dependencies,
  device,
  stateBase,
  stateStore,
}) {
  let recovered = await recoverInstallerTempFiles({
    dependencies,
    device,
    stateBase,
    stateStore,
  });
  for (const name of await fs.promises.readdir(stateStore)) {
    const match = TRANSACTION_FILE_NAME.exec(name);
    if (!match || !UUID_V4.test(match[1] ?? '')) continue;
    const transactionId = match[1];
    const transactionPath = path.join(stateStore, name);
    try {
      validateTransaction(
        await readJson(transactionPath, 'transaction record'),
        transactionId,
      );
    } catch (error) {
      if (!['AE_PLUGIN_INSTALL_STATE_INVALID', 'AE_PLUGIN_RECEIPT_INVALID']
        .includes(error?.code)) {
        throw error;
      }
      await archiveOrphanTransaction({
        dependencies,
        device,
        stateBase,
        stateStore,
        transactionId,
        transactionPath,
      });
      recovered += 1;
    }
  }
  for (const name of await fs.promises.readdir(stateStore)) {
    const match = STAGE_BUNDLE_NAME.exec(name);
    if (!match || !UUID_V4.test(match[1] ?? '')) continue;
    const transactionId = match[1];
    if (await lstatOrNull(path.join(stateStore, transactionName(transactionId)))) continue;
    await archiveOrphanTransaction({
      dependencies,
      device,
      stateBase,
      stateStore,
      transactionId,
      transactionPath: null,
    });
    recovered += 1;
  }
  return recovered;
}

async function assertDeploymentNamespace(namespace) {
  const entries = (await fs.promises.readdir(namespace)).sort();
  if (!isDeepStrictEqual(entries, [])
      && !isDeepStrictEqual(entries, [BUNDLE_NAME])) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'managed MediaCore namespace must contain only the active native plug-in',
    );
  }
}

async function restoreMigratedTarget({
  dependencies,
  device,
  sourceDirectory,
  namespace,
  target,
}) {
  const migratedTarget = path.join(sourceDirectory, BUNDLE_NAME);
  if (!await lstatOrNull(migratedTarget)) return false;
  if (await lstatOrNull(target)) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_CONFLICT',
      'both deployment and migrated state contain the active native plug-in',
    );
  }
  await inspectTarget(migratedTarget, dependencies);
  await Promise.all([
    assertManagedDirectoryDevice(sourceDirectory, device, 'native installer migration source'),
    assertManagedDirectoryDevice(namespace, device, 'managed MediaCore namespace'),
  ]);
  await renameBundleDurable(dependencies, migratedTarget, target);
  await dependencies.onTransition('migration.target_restored');
  return true;
}

async function mergeMigrationState({
  dependencies,
  migration,
  stateStore,
}) {
  const entries = (await fs.promises.readdir(migration)).sort();
  if (entries.some((name) => !managedStateEntry(name))) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'off-scan legacy migration contains unrecognized state and was retained for recovery',
      { quarantineName: MIGRATION_NAME },
    );
  }
  await validateManagedStateDirectory(migration, 'native installer legacy migration');
  const movable = entries.filter((name) => name !== BUNDLE_NAME && name !== LOCK_NAME);
  const stateEntries = new Set(await fs.promises.readdir(stateStore));
  if (movable.some((name) => stateEntries.has(name))) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_CONFLICT',
      'off-scan legacy migration overlaps existing installer state and was retained for recovery',
      { quarantineName: MIGRATION_NAME },
    );
  }
  for (const name of movable) {
    const source = path.join(migration, name);
    const destination = path.join(stateStore, name);
    await durableRename(
      source,
      destination,
      fs.promises.rename,
      dependencies.syncDirectory,
    );
    await dependencies.onTransition('migration.state_moved');
  }
}

async function resumeLegacyMigration({
  dependencies,
  device,
  migration,
  namespace,
  stateStore,
  target,
}) {
  await assertManagedDirectoryDevice(
    migration,
    device,
    'native installer legacy migration',
  );
  const migrationEntries = (await fs.promises.readdir(migration)).sort();
  const legacyLockOwner = migrationEntries.includes(LOCK_NAME)
    ? await assertLegacyLockInactive(migration, dependencies)
    : null;
  if (!await lstatOrNull(namespace)) {
    await ensureDeploymentNamespace(dependencies, namespace, device);
    await dependencies.onTransition('migration.namespace_recreated');
  } else {
    await assertManagedDirectoryDevice(namespace, device, 'managed MediaCore namespace');
  }
  await restoreMigratedTarget({
    dependencies,
    device,
    sourceDirectory: migration,
    namespace,
    target,
  });
  if (migrationEntries.includes(LOCK_NAME)) {
    await rotateLegacyLock(migration, stateStore, dependencies, legacyLockOwner);
  }
  await mergeMigrationState({ dependencies, migration, stateStore });
  const remaining = await fs.promises.readdir(migration);
  if (remaining.length !== 0) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'native installer legacy migration could not be emptied safely',
    );
  }
  await fs.promises.rmdir(migration);
  await syncDirectory(path.dirname(migration));
  await dependencies.onTransition('migration.complete');
}

async function prepareStateLayout({
  dependencies,
  device,
  migration,
  namespace,
  stateBase,
  stateStore,
  target,
}) {
  let migratedLegacyState = false;
  await ensureManagedDirectory(stateStore, device, 'native installer state store');
  if (await recoverOrphanStateArtifacts({
    dependencies,
    device,
    stateBase,
    stateStore,
  }) > 0) {
    migratedLegacyState = true;
  }

  if (await lstatOrNull(migration)) {
    migratedLegacyState = true;
    await resumeLegacyMigration({
      dependencies,
      device,
      migration,
      namespace,
      stateStore,
      target,
    });
  }

  if (!await lstatOrNull(namespace)) {
    await ensureDeploymentNamespace(dependencies, namespace, device);
  }

  await validateManagedStateDirectory(stateStore, 'native installer state store');
  if (await lstatOrNull(path.join(stateStore, LOCK_NAME))) {
    await rotateLegacyLock(stateStore, stateStore, dependencies);
    migratedLegacyState = true;
  }
  if (await restoreMigratedTarget({
    dependencies,
    device,
    sourceDirectory: stateStore,
    namespace,
    target,
  })) {
    migratedLegacyState = true;
  }

  let legacyEntries = (await fs.promises.readdir(namespace)).sort();
  if (!isDeepStrictEqual(legacyEntries, [])
      && !isDeepStrictEqual(legacyEntries, [BUNDLE_NAME])) {
    await ensureMissing(migration, 'native installer legacy migration');
    if (legacyEntries.includes(LOCK_NAME)) {
      await assertLegacyLockInactive(namespace, dependencies);
    }
    await assertManagedDirectoryDevice(namespace, device, 'managed MediaCore namespace');
    await renameDeploymentDirectoryDurable(dependencies, namespace, migration);
    migratedLegacyState = true;
    await dependencies.onTransition('migration.namespace_moved');
    await resumeLegacyMigration({
      dependencies,
      device,
      migration,
      namespace,
      stateStore,
      target,
    });
  } else {
    await validateManagedStateDirectory(namespace, 'managed MediaCore namespace');
  }

  await assertDeploymentNamespace(namespace);
  const stateEntries = await validateManagedStateDirectory(
    stateStore,
    'native installer state store',
  );
  if (stateEntries.includes(BUNDLE_NAME) || stateEntries.includes(LOCK_NAME)) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'native installer state store retained a deployment or legacy lock entry',
    );
  }
  return {
    migratedLegacyState,
    namespace,
    stateStore,
    target,
  };
}

async function compensateInstall({
  backup,
  candidateMoved,
  dependencies,
  failed,
  oldMoved,
  previousArtifact,
  target,
}) {
  const failures = [];
  if (candidateMoved && await lstatOrNull(target)) {
    try {
      await renameBundleDurable(dependencies, target, failed);
    } catch (error) {
      failures.push(`preserve failed candidate: ${error?.code ?? 'rename failed'}`);
    }
  }
  if (oldMoved && await lstatOrNull(backup)) {
    try {
      if (await lstatOrNull(target)) {
        failures.push('restore previous target: destination is occupied');
      } else {
        await renameBundleDurable(dependencies, backup, target);
        await verifyTarget(target, previousArtifact, dependencies, 'restored previous artifact');
      }
    } catch (error) {
      failures.push(`restore previous target: ${error?.code ?? 'restore failed'}`);
    }
  }
  return failures;
}

export async function installDevMacPlugin({
  artifactDir,
  mediaCoreRoot = defaultMediaCoreRoot(),
  stateBaseRoot = defaultStateBaseRoot(mediaCoreRoot),
  dependencies: dependencyOverrides,
}) {
  const dependencies = dependenciesFor(dependencyOverrides);
  requireMac(dependencies);
  await dependencies.assertAeStopped();
  const source = await loadSourceArtifact(artifactDir, dependencies);
  const artifactReal = await fs.promises.realpath(artifactDir);
  const deploymentInput = path.join(path.resolve(mediaCoreRoot), NAMESPACE_NAME);
  const stateBaseInput = path.resolve(stateBaseRoot);
  if (isSameOrDescendant(deploymentInput, artifactReal)
      || isSameOrDescendant(artifactReal, deploymentInput)
      || isSameOrDescendant(stateBaseInput, artifactReal)
      || isSameOrDescendant(artifactReal, stateBaseInput)) {
    throw installerError(
      'AE_PLUGIN_ARTIFACT_INVALID',
      'source artifact must remain outside deployment and installer state directories',
    );
  }
  const roots = await prepareRoots(mediaCoreRoot, stateBaseRoot);
  if (isSameOrDescendant(roots.namespace, artifactReal)
      || isSameOrDescendant(artifactReal, roots.namespace)
      || isSameOrDescendant(roots.stateBase, artifactReal)
      || isSameOrDescendant(artifactReal, roots.stateBase)) {
    throw installerError(
      'AE_PLUGIN_ARTIFACT_INVALID',
      'source artifact must remain outside deployment and installer state directories',
    );
  }

  const releaseLock = await acquireLock(roots.stateBase, dependencies);
  let stage;
  let preserveForRecovery = false;
  try {
    const {
      namespace,
      stateStore,
      target,
    } = await prepareStateLayout({ dependencies, ...roots });
    await recoverIncompleteTransactions({ dependencies, stateStore, target });
    const transactionId = dependencies.randomUUID();
    assertTransactionId(transactionId);
    const stageName = managedName('stage', transactionId);
    const backupName = managedName('backup', transactionId);
    const failedName = managedName('failed', transactionId);
    stage = path.join(stateStore, stageName);
    const backup = path.join(stateStore, backupName);
    const failed = path.join(stateStore, failedName);
    const transactionPath = path.join(stateStore, transactionName(transactionId));
    const currentPath = path.join(stateStore, CURRENT_NAME);
    await Promise.all([
      ensureMissing(stage, 'transaction stage'),
      ensureMissing(backup, 'transaction backup'),
      ensureMissing(failed, 'transaction failed candidate'),
      ensureMissing(transactionPath, 'transaction record'),
    ]);

    await dependencies.copyBundle(source.bundlePath, stage);
    await verifyDisabled(
      stage,
      source.receipt.artifact,
      dependencies,
      'staged native artifact',
      source.receipt.sourceCommit,
    );
    await syncTree(stage, dependencies.syncDirectory);
    await dependencies.syncDirectory(stateStore);
    const previousArtifact = await inspectTarget(target, dependencies);
    const previousCurrentTransactionId = await readCurrentTransactionId(currentPath);
    if (!previousArtifact && previousCurrentTransactionId) {
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        'current installation record exists without an installed native bundle',
      );
    }
    const createdAt = nowIso(dependencies);
    let transaction = {
      schemaVersion: 1,
      transactionId,
      status: 'prepared',
      targetName: BUNDLE_NAME,
      sourceCommit: source.receipt.sourceCommit,
      buildReceiptSha256: source.receiptSha256,
      installedArtifact: source.receipt.artifact,
      previous: {
        present: previousArtifact !== null,
        artifact: previousArtifact,
        backupName: previousArtifact ? backupName : null,
        currentTransactionId: previousArtifact ? previousCurrentTransactionId : null,
      },
      createdAt,
      updatedAt: createdAt,
    };
    await writeJsonExclusiveAtomic(transactionPath, transaction);

    let oldMoved = false;
    let candidateMoved = false;
    try {
      await dependencies.onTransition('install.prepared');
      if (previousArtifact) {
        await renameBundleTracked(
          dependencies,
          target,
          backup,
          () => { oldMoved = true; },
        );
        await dependencies.onTransition('install.old_moved');
        transaction = {
          ...transaction,
          status: 'old_moved',
          updatedAt: nowIso(dependencies),
        };
        await writeJsonAtomic(transactionPath, transaction);
        await verifyDisabled(
          backup,
          previousArtifact,
          dependencies,
          'backed-up previous artifact',
        );
      }
      await renameBundleTracked(
        dependencies,
        stage,
        target,
        () => { candidateMoved = true; },
      );
      await dependencies.onTransition('install.candidate_moved');
      transaction = {
        ...transaction,
        status: 'candidate_moved',
        updatedAt: nowIso(dependencies),
      };
      await writeJsonAtomic(transactionPath, transaction);
      await verifyTarget(
        target,
        source.receipt.artifact,
        dependencies,
        'installed native artifact',
        source.receipt.sourceCommit,
      );

      transaction = {
        ...transaction,
        status: 'committed',
        updatedAt: nowIso(dependencies),
      };
      await writeJsonAtomic(transactionPath, transaction);
      await writeCurrentTransaction(currentPath, transactionId, dependencies);
      await assertDeploymentNamespace(namespace);
      stage = null;
      return Object.freeze({
        schemaVersion: 1,
        action: 'install',
        transactionId,
        target,
        sourceCommit: source.receipt.sourceCommit,
        artifact: source.receipt.artifact,
        previous: {
          present: previousArtifact !== null,
          artifact: previousArtifact,
          backupName: previousArtifact ? backupName : null,
        },
        restartRequired: true,
      });
    } catch (error) {
      if (simulatedCrash(error)) {
        preserveForRecovery = true;
        throw error;
      }
      const failures = await compensateInstall({
        backup,
        candidateMoved,
        dependencies,
        failed,
        oldMoved,
        previousArtifact,
        target,
      });
      transaction = {
        ...transaction,
        status: failures.length === 0 ? 'failed_rolled_back' : 'failed_recovery_required',
        failedName: await lstatOrNull(failed) ? failedName : null,
        updatedAt: nowIso(dependencies),
      };
      await writeJsonAtomic(transactionPath, transaction).catch((metadataError) => {
        failures.push(`write transaction state: ${metadataError?.code ?? 'write failed'}`);
      });
      if (failures.length > 0) {
        throw installerError(
          'AE_PLUGIN_ROLLBACK_INCOMPLETE',
          'native install failed and automatic restoration was incomplete',
          {
            backupName,
            failedName,
            failures,
            targetName: BUNDLE_NAME,
          },
        );
      }
      throw error;
    }
  } finally {
    if (!preserveForRecovery && stage && await lstatOrNull(stage)) {
      await removeGeneratedStage(stage, roots.stateStore).catch(() => {});
    }
    await releaseLock();
  }
}

function validateTransaction(value, transactionId) {
  if (!isRecord(value)
      || value.schemaVersion !== 1
      || value.transactionId !== transactionId
      || value.targetName !== BUNDLE_NAME
      || ![
        'candidate_moved',
        'committed',
        'failed_recovery_required',
        'failed_rolled_back',
        'old_moved',
        'prepared',
        'rollback_prepared',
        'rollback_previous_moved',
        'rollback_target_moved',
        'rolled_back',
      ].includes(value.status)
      || !COMMIT_SHA.test(value.sourceCommit ?? '')
      || !SHA256.test(value.buildReceiptSha256 ?? '')
      || !isRecord(value.previous)
      || typeof value.previous.present !== 'boolean'
      || !(value.previous.currentTransactionId === null
        || UUID_V4.test(value.previous.currentTransactionId))) {
    throw installerError('AE_PLUGIN_INSTALL_STATE_INVALID', 'transaction record is invalid');
  }
  validateArtifact(value.installedArtifact, 'transaction installed artifact');
  if (value.previous.present) {
    validateArtifact(value.previous.artifact, 'transaction previous artifact');
    if (value.previous.backupName !== managedName('backup', transactionId)) {
      throw installerError('AE_PLUGIN_INSTALL_STATE_INVALID', 'transaction backup name is invalid');
    }
  } else if (value.previous.artifact !== null || value.previous.backupName !== null) {
    throw installerError('AE_PLUGIN_INSTALL_STATE_INVALID', 'fresh install transaction is invalid');
  }
  return value;
}

async function observeBundle(bundlePath, dependencies, allowManagedDisabledName, label) {
  const metadata = await lstatOrNull(bundlePath);
  if (!metadata) return null;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      `${label} is not a real bundle directory`,
    );
  }
  try {
    return validateArtifact(
      await dependencies.verifyBundle({ bundlePath, allowManagedDisabledName }),
      label,
    );
  } catch (error) {
    if (error?.code === 'AE_PLUGIN_RECOVERY_INCOMPLETE') throw error;
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      `${label} failed verification during recovery`,
    );
  }
}

async function loadTransactions(stateStore) {
  const records = [];
  const pattern = /^\.AeMcpNative\.transaction\.([0-9a-f-]+)\.json$/u;
  for (const name of await fs.promises.readdir(stateStore)) {
    const match = pattern.exec(name);
    if (!match) continue;
    assertTransactionId(match[1]);
    const value = validateTransaction(
      await readJson(path.join(stateStore, name), 'transaction record'),
      match[1],
    );
    records.push({ name, path: path.join(stateStore, name), value });
  }
  records.sort((left, right) => String(left.value.createdAt).localeCompare(
    String(right.value.createdAt),
  ));
  return records;
}

async function recoverInstallTransaction({ dependencies, stateStore, record, target }) {
  let transaction = record.value;
  const { transactionId } = transaction;
  const stage = path.join(stateStore, managedName('stage', transactionId));
  const backup = transaction.previous.backupName
    ? path.join(stateStore, transaction.previous.backupName) : null;
  const failedName = managedName('failed', transactionId);
  const failed = path.join(stateStore, failedName);
  const targetArtifact = await observeBundle(
    target,
    dependencies,
    false,
    'recovery target artifact',
  );
  const stageArtifact = await observeBundle(
    stage,
    dependencies,
    true,
    'recovery staged artifact',
  );
  const backupArtifact = backup ? await observeBundle(
    backup,
    dependencies,
    true,
    'recovery backup artifact',
  ) : null;
  const failedArtifact = await observeBundle(
    failed,
    dependencies,
    true,
    'recovery failed artifact',
  );

  if (stageArtifact && !isDeepStrictEqual(stageArtifact, transaction.installedArtifact)) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      'recovery stage does not match the interrupted transaction',
      { transactionId },
    );
  }
  if (stageArtifact) await assertEmbeddedSourceCommit(stage, transaction.sourceCommit);
  if (failedArtifact && !isDeepStrictEqual(failedArtifact, transaction.installedArtifact)) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      'recovery failed candidate does not match the interrupted transaction',
      { transactionId },
    );
  }
  if (failedArtifact) await assertEmbeddedSourceCommit(failed, transaction.sourceCommit);
  if (backupArtifact && (!transaction.previous.artifact
      || !isDeepStrictEqual(backupArtifact, transaction.previous.artifact))) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      'recovery backup does not match the interrupted transaction',
      { transactionId },
    );
  }

  const targetMatchesInstalled = targetArtifact
    && isDeepStrictEqual(targetArtifact, transaction.installedArtifact);
  const targetMatchesPrevious = targetArtifact && transaction.previous.artifact
    && isDeepStrictEqual(targetArtifact, transaction.previous.artifact);
  // When reinstalling identical bytes, a surviving backup proves that the
  // target is the moved candidate; without it the target is the untouched or
  // already-restored predecessor. The durable phase can lag one rename after
  // SIGKILL, so topology must participate in the decision.
  const targetIsInstalled = targetMatchesInstalled
    && !(targetMatchesPrevious && !backupArtifact);
  const targetIsPrevious = targetMatchesPrevious && !targetIsInstalled;
  if (targetArtifact && !targetIsInstalled && !targetIsPrevious) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      'recovery target was modified outside the interrupted transaction',
      { transactionId },
    );
  }
  if (targetIsInstalled) await assertEmbeddedSourceCommit(target, transaction.sourceCommit);

  if (targetIsInstalled) {
    if (failedArtifact) {
      throw installerError(
        'AE_PLUGIN_RECOVERY_INCOMPLETE',
        'both target and failed candidate exist during recovery',
        { transactionId },
      );
    }
    await renameBundleDurable(dependencies, target, failed);
  }

  if (transaction.previous.present) {
    if (!targetIsPrevious) {
      if (!backupArtifact) {
        throw installerError(
          'AE_PLUGIN_RECOVERY_INCOMPLETE',
          'previous native bundle is unavailable for interrupted install recovery',
          { transactionId },
        );
      }
      if (await lstatOrNull(target)) {
        throw installerError(
          'AE_PLUGIN_RECOVERY_INCOMPLETE',
          'native target remained occupied during interrupted install recovery',
          { transactionId },
        );
      }
      await renameBundleDurable(dependencies, backup, target);
    }
    await verifyTarget(
      target,
      transaction.previous.artifact,
      dependencies,
      'recovered previous native artifact',
    );
  } else if (await lstatOrNull(target)) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      'fresh interrupted install could not restore an empty target',
      { transactionId },
    );
  }

  if (stageArtifact && await lstatOrNull(stage)) {
    await removeGeneratedStage(stage, stateStore);
  }
  transaction = {
    ...transaction,
    status: 'failed_rolled_back',
    failedName: await lstatOrNull(failed) ? failedName : null,
    recoveredAt: nowIso(dependencies),
    updatedAt: nowIso(dependencies),
  };
  await writeJsonAtomic(record.path, transaction);
  return {
    transactionId,
    from: record.value.status,
    to: transaction.status,
  };
}

async function recoverRollbackTransaction({ dependencies, stateStore, record, target }) {
  let transaction = record.value;
  const { transactionId } = transaction;
  const backup = transaction.previous.backupName
    ? path.join(stateStore, transaction.previous.backupName) : null;
  const replaced = path.join(stateStore, managedName('replaced', transactionId));
  const targetArtifact = await observeBundle(
    target,
    dependencies,
    false,
    'rollback recovery target artifact',
  );
  const replacedArtifact = await observeBundle(
    replaced,
    dependencies,
    true,
    'rollback recovery replaced artifact',
  );
  const backupArtifact = backup ? await observeBundle(
    backup,
    dependencies,
    true,
    'rollback recovery backup artifact',
  ) : null;
  const targetMatchesInstalled = targetArtifact
    && isDeepStrictEqual(targetArtifact, transaction.installedArtifact);
  const targetMatchesPrevious = targetArtifact && transaction.previous.artifact
    && isDeepStrictEqual(targetArtifact, transaction.previous.artifact);
  // With identical old/new bytes, replaced + no backup is the topology after
  // the predecessor was restored. Before the first rollback rename there is
  // no replaced bundle, so the target remains the installed candidate.
  const targetIsPrevious = targetMatchesPrevious && replacedArtifact && !backupArtifact;
  const targetIsInstalled = targetMatchesInstalled && !targetIsPrevious;
  if (targetArtifact && !targetIsInstalled && !targetIsPrevious) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      'rollback recovery target was modified outside the interrupted transaction',
      { transactionId },
    );
  }
  if (replacedArtifact && !isDeepStrictEqual(replacedArtifact, transaction.installedArtifact)) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      'rollback recovery replacement does not match the interrupted transaction',
      { transactionId },
    );
  }
  if (replacedArtifact) await assertEmbeddedSourceCommit(replaced, transaction.sourceCommit);
  if (backupArtifact && (!transaction.previous.artifact
      || !isDeepStrictEqual(backupArtifact, transaction.previous.artifact))) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      'rollback recovery backup does not match the interrupted transaction',
      { transactionId },
    );
  }
  if (targetIsInstalled) await assertEmbeddedSourceCommit(target, transaction.sourceCommit);

  if (!targetIsInstalled) {
    if (!replacedArtifact) {
      throw installerError(
        'AE_PLUGIN_RECOVERY_INCOMPLETE',
        'interrupted rollback no longer has the installed bundle to reinstate',
        { transactionId },
      );
    }
    if (targetIsPrevious) {
      if (backupArtifact) {
        throw installerError(
          'AE_PLUGIN_RECOVERY_INCOMPLETE',
          'rollback recovery found duplicate previous bundles',
          { transactionId },
        );
      }
      await renameBundleDurable(dependencies, target, backup);
    } else if (targetArtifact) {
      throw installerError(
        'AE_PLUGIN_RECOVERY_INCOMPLETE',
        'rollback recovery target is occupied',
        { transactionId },
      );
    }
    await renameBundleDurable(dependencies, replaced, target);
  } else if (replacedArtifact) {
    throw installerError(
      'AE_PLUGIN_RECOVERY_INCOMPLETE',
      'rollback recovery found duplicate installed bundles',
      { transactionId },
    );
  }
  await verifyTarget(
    target,
    transaction.installedArtifact,
    dependencies,
    'recovered current native artifact',
    transaction.sourceCommit,
  );
  transaction = {
    ...transaction,
    status: 'committed',
    recoveredAt: nowIso(dependencies),
    updatedAt: nowIso(dependencies),
  };
  await writeJsonAtomic(record.path, transaction);
  return {
    transactionId,
    from: record.value.status,
    to: transaction.status,
  };
}

async function reconcileCurrentTransaction({ dependencies, stateStore, target, transactions }) {
  const currentPath = path.join(stateStore, CURRENT_NAME);
  const targetArtifact = await observeBundle(
    target,
    dependencies,
    false,
    'current native artifact',
  );
  const observed = await readCurrentTransactionId(currentPath);
  let desired = null;
  if (targetArtifact) {
    const committed = transactions.filter((record) => record.value.status === 'committed');
    const byId = new Map(committed.map((record) => [record.value.transactionId, record]));
    const successor = new Map();
    for (const record of committed) {
      const predecessor = record.value.previous.currentTransactionId;
      if (predecessor && byId.has(predecessor)) {
        if (successor.has(predecessor)) {
          throw installerError(
            'AE_PLUGIN_INSTALL_STATE_INVALID',
            'committed native transaction history contains a branch',
          );
        }
        successor.set(predecessor, record.value.transactionId);
      }
    }
    const tipFrom = (start) => {
      const visited = new Set();
      let candidate = start;
      while (successor.has(candidate)) {
        if (visited.has(candidate)) {
          throw installerError(
            'AE_PLUGIN_INSTALL_STATE_INVALID',
            'committed native transaction history contains a cycle',
          );
        }
        visited.add(candidate);
        candidate = successor.get(candidate);
      }
      return candidate;
    };
    const observedTip = observed && byId.has(observed) ? tipFrom(observed) : null;
    if (observedTip
        && isDeepStrictEqual(byId.get(observedTip).value.installedArtifact, targetArtifact)) {
      desired = observedTip;
    } else {
      const matchingTips = committed.filter((record) => (
        !successor.has(record.value.transactionId)
        && isDeepStrictEqual(record.value.installedArtifact, targetArtifact)
      ));
      if (matchingTips.length > 1) {
        throw installerError(
          'AE_PLUGIN_INSTALL_STATE_INVALID',
          'current native artifact matches multiple unrelated transaction tips',
        );
      }
      desired = matchingTips[0]?.value.transactionId ?? null;
    }
    if (desired) {
      await assertEmbeddedSourceCommit(target, byId.get(desired).value.sourceCommit);
    }
  }
  if (observed !== desired) {
    await writeCurrentTransaction(currentPath, desired, dependencies);
  }
  return desired;
}

async function recoverIncompleteTransactions({ dependencies, stateStore, target }) {
  const records = await loadTransactions(stateStore);
  const recovered = [];
  if (records.length === 0) {
    const currentTransactionId = await readCurrentTransactionId(path.join(stateStore, CURRENT_NAME));
    if (currentTransactionId) {
      throw installerError(
        'AE_PLUGIN_INSTALL_STATE_INVALID',
        'current installation record references a missing transaction',
      );
    }
    return { recovered, currentTransactionId: null };
  }
  const installStates = new Set([
    'candidate_moved',
    'failed_recovery_required',
    'old_moved',
    'prepared',
  ]);
  const rollbackStates = new Set([
    'rollback_prepared',
    'rollback_previous_moved',
    'rollback_target_moved',
  ]);
  for (const record of records) {
    if (installStates.has(record.value.status)) {
      recovered.push(await recoverInstallTransaction({
        dependencies,
        stateStore,
        record,
        target,
      }));
    } else if (rollbackStates.has(record.value.status)) {
      recovered.push(await recoverRollbackTransaction({
        dependencies,
        stateStore,
        record,
        target,
      }));
    }
  }
  const refreshed = recovered.length > 0 ? await loadTransactions(stateStore) : records;
  const currentTransactionId = await reconcileCurrentTransaction({
    dependencies,
    stateStore,
    target,
    transactions: refreshed,
  });
  return { recovered, currentTransactionId };
}

async function compensateRollback({
  backup,
  dependencies,
  installedArtifact,
  sourceCommit,
  previousRestored,
  replaced,
  target,
  targetMoved,
}) {
  const failures = [];
  if (previousRestored && await lstatOrNull(target)) {
    try {
      await renameBundleDurable(dependencies, target, backup);
    } catch (error) {
      failures.push(`preserve restored previous target: ${error?.code ?? 'rename failed'}`);
    }
  }
  if (targetMoved && await lstatOrNull(replaced)) {
    try {
      if (await lstatOrNull(target)) {
        failures.push('restore installed target: destination is occupied');
      } else {
        await renameBundleDurable(dependencies, replaced, target);
        await verifyTarget(
          target,
          installedArtifact,
          dependencies,
          'reinstated current artifact',
          sourceCommit,
        );
      }
    } catch (error) {
      failures.push(`restore installed target: ${error?.code ?? 'restore failed'}`);
    }
  }
  return failures;
}

export async function rollbackDevMacPlugin({
  transactionId,
  mediaCoreRoot = defaultMediaCoreRoot(),
  stateBaseRoot = defaultStateBaseRoot(mediaCoreRoot),
  dependencies: dependencyOverrides,
}) {
  assertTransactionId(transactionId);
  const dependencies = dependenciesFor(dependencyOverrides);
  requireMac(dependencies);
  await dependencies.assertAeStopped();
  const roots = await prepareRoots(mediaCoreRoot, stateBaseRoot);
  const releaseLock = await acquireLock(roots.stateBase, dependencies);
  try {
    const {
      namespace,
      stateStore,
      target,
    } = await prepareStateLayout({ dependencies, ...roots });
    await recoverIncompleteTransactions({ dependencies, stateStore, target });
    const transactionPath = path.join(stateStore, transactionName(transactionId));
    const currentPath = path.join(stateStore, CURRENT_NAME);
    let transaction = validateTransaction(
      await readJson(transactionPath, 'transaction record'),
      transactionId,
    );
    if (transaction.status === 'rolled_back') {
      return Object.freeze({
        schemaVersion: 1,
        action: 'rollback',
        transactionId,
        target,
        alreadyRolledBack: true,
        restoredPrevious: transaction.previous.present,
        restartRequired: true,
      });
    }
    const current = await readJson(currentPath, 'current installation record');
    if (!isRecord(current)
        || current.schemaVersion !== 1
        || current.transactionId !== transactionId) {
      throw installerError(
        'AE_PLUGIN_ROLLBACK_STALE',
        'only the current committed native transaction can be rolled back',
      );
    }
    await verifyTarget(
      target,
      transaction.installedArtifact,
      dependencies,
      'current installed artifact',
      transaction.sourceCommit,
    );

    const backupName = transaction.previous.backupName;
    const backup = backupName ? path.join(stateStore, backupName) : null;
    if (backup) {
      await verifyDisabled(
        backup,
        transaction.previous.artifact,
        dependencies,
        'rollback backup artifact',
      );
    }
    const replacedName = managedName('replaced', transactionId);
    const replaced = path.join(stateStore, replacedName);
    await ensureMissing(replaced, 'rollback replacement');
    transaction = {
      ...transaction,
      status: 'rollback_prepared',
      updatedAt: nowIso(dependencies),
    };
    await writeJsonAtomic(transactionPath, transaction);

    let targetMoved = false;
    let previousRestored = false;
    try {
      await dependencies.onTransition('rollback.prepared');
      await renameBundleTracked(
        dependencies,
        target,
        replaced,
        () => { targetMoved = true; },
      );
      await dependencies.onTransition('rollback.target_moved');
      transaction = {
        ...transaction,
        status: 'rollback_target_moved',
        updatedAt: nowIso(dependencies),
      };
      await writeJsonAtomic(transactionPath, transaction);
      if (backup) {
        await renameBundleTracked(
          dependencies,
          backup,
          target,
          () => { previousRestored = true; },
        );
        await dependencies.onTransition('rollback.previous_moved');
        transaction = {
          ...transaction,
          status: 'rollback_previous_moved',
          updatedAt: nowIso(dependencies),
        };
        await writeJsonAtomic(transactionPath, transaction);
        await verifyTarget(
          target,
          transaction.previous.artifact,
          dependencies,
          'rolled-back native artifact',
        );
      } else if (await lstatOrNull(target)) {
        throw installerError('AE_PLUGIN_INSTALL_STATE_INVALID', 'fresh rollback target is not absent');
      }

      const rolledBackAt = nowIso(dependencies);
      transaction = {
        ...transaction,
        status: 'rolled_back',
        replacedName,
        rolledBackAt,
        updatedAt: rolledBackAt,
      };
      await writeJsonAtomic(transactionPath, transaction);
      await writeCurrentTransaction(
        currentPath,
        transaction.previous.currentTransactionId,
        dependencies,
        { rolledBackTransactionId: transactionId },
      );
      await assertDeploymentNamespace(namespace);
      return Object.freeze({
        schemaVersion: 1,
        action: 'rollback',
        transactionId,
        target,
        alreadyRolledBack: false,
        restoredPrevious: transaction.previous.present,
        replacedName,
        restartRequired: true,
      });
    } catch (error) {
      if (simulatedCrash(error)) throw error;
      const failures = await compensateRollback({
        backup,
        dependencies,
        installedArtifact: transaction.installedArtifact,
        sourceCommit: transaction.sourceCommit,
        previousRestored,
        replaced,
        target,
        targetMoved,
      });
      const committed = {
        ...transaction,
        status: 'committed',
        updatedAt: nowIso(dependencies),
      };
      await writeJsonAtomic(transactionPath, committed).catch((metadataError) => {
        failures.push(`restore transaction state: ${metadataError?.code ?? 'write failed'}`);
      });
      if (failures.length > 0) {
        throw installerError(
          'AE_PLUGIN_ROLLBACK_INCOMPLETE',
          'native rollback failed and the installed plug-in could not be reinstated completely',
          {
            backupName,
            failures,
            replacedName,
            targetName: BUNDLE_NAME,
          },
        );
      }
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

export async function recoverDevMacPlugin({
  mediaCoreRoot = defaultMediaCoreRoot(),
  stateBaseRoot = defaultStateBaseRoot(mediaCoreRoot),
  dependencies: dependencyOverrides,
} = {}) {
  const dependencies = dependenciesFor(dependencyOverrides);
  requireMac(dependencies);
  await dependencies.assertAeStopped();
  const roots = await prepareRoots(mediaCoreRoot, stateBaseRoot);
  const releaseLock = await acquireLock(roots.stateBase, dependencies);
  try {
    const layout = await prepareStateLayout({ dependencies, ...roots });
    const recovery = await recoverIncompleteTransactions({
      dependencies,
      stateStore: layout.stateStore,
      target: layout.target,
    });
    await assertDeploymentNamespace(layout.namespace);
    return Object.freeze({
      schemaVersion: 1,
      action: 'recover',
      target: layout.target,
      recovered: recovery.recovered,
      currentTransactionId: recovery.currentTransactionId,
      migratedLegacyState: layout.migratedLegacyState,
      restartRequired: layout.migratedLegacyState || recovery.recovered.length > 0,
    });
  } finally {
    await releaseLock();
  }
}

function parseCli(argv) {
  if (argv.length === 3 && argv[0] === 'install' && argv[1] === '--artifact-dir'
      && path.isAbsolute(argv[2])) {
    return { action: 'install', artifactDir: argv[2] };
  }
  if (argv.length === 3 && argv[0] === 'rollback' && argv[1] === '--transaction'
      && UUID_V4.test(argv[2])) {
    return { action: 'rollback', transactionId: argv[2] };
  }
  if (argv.length === 1 && argv[0] === 'recover') {
    return { action: 'recover' };
  }
  throw installerError(
    'AE_PLUGIN_ARGUMENT_INVALID',
    'usage: install --artifact-dir /absolute/build-output | rollback --transaction <uuid> | recover',
  );
}

function publicError(error) {
  const structured = typeof error?.code === 'string' && error.code.startsWith('AE_');
  const result = {
    ok: false,
    error: {
      code: structured ? error.code : 'AE_PLUGIN_INSTALL_FAILED',
      message: structured && typeof error?.message === 'string'
        ? error.message : 'native development deployment failed without exposing local paths',
    },
  };
  if (structured && isRecord(error?.recovery)) result.error.recovery = error.recovery;
  return result;
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) {
  try {
    const command = parseCli(process.argv.slice(2));
    let result;
    if (command.action === 'install') {
      result = await installDevMacPlugin({ artifactDir: command.artifactDir });
    } else if (command.action === 'rollback') {
      result = await rollbackDevMacPlugin({ transactionId: command.transactionId });
    } else {
      result = await recoverDevMacPlugin();
    }
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  }
}
