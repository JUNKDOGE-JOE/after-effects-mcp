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
const CURRENT_NAME = '.AeMcpNative.current.json';
const MAX_JSON_BYTES = 64 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;
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

async function ensureSafeDirectory(directory) {
  if (!path.isAbsolute(directory)) {
    throw installerError('AE_PLUGIN_INSTALL_ROOT_UNSAFE', 'MediaCore root must be absolute');
  }
  const parsed = path.parse(path.resolve(directory));
  let current = parsed.root;
  for (const component of path.resolve(directory).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let metadata = await lstatOrNull(current);
    if (!metadata) {
      await fs.promises.mkdir(current, { mode: 0o700 }).catch((error) => {
        if (error?.code !== 'EEXIST') throw error;
      });
      metadata = await fs.promises.lstat(current);
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw installerError(
        'AE_PLUGIN_INSTALL_ROOT_UNSAFE',
        'MediaCore path contains a symbolic or non-directory component',
      );
    }
  }
  return fs.promises.realpath(directory);
}

async function readBoundedRegularFile(file, label) {
  const metadata = await fs.promises.lstat(file).catch(() => null);
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

async function acquireLock(namespace, dependencies) {
  const lockPath = path.join(namespace, LOCK_NAME);
  let handle;
  for (let attempt = 0; attempt < 2 && !handle; attempt += 1) {
    try {
      handle = await fs.promises.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readLockOwner(lockPath);
      if (await dependencies.isProcessAlive(owner.pid)) {
        throw installerError(
          'AE_PLUGIN_INSTALL_LOCKED',
          'another native install or rollback is active',
        );
      }
      const stalePath = path.join(
        namespace,
        `.AeMcpNative.stale-lock.${crypto.randomUUID()}.json`,
      );
      try {
        await fs.promises.rename(lockPath, stalePath);
        await syncDirectory(namespace);
      } catch (renameError) {
        if (renameError?.code !== 'ENOENT') throw renameError;
      }
    }
  }
  if (!handle) {
    throw installerError('AE_PLUGIN_INSTALL_LOCKED', 'could not acquire the native install lock');
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: nowIso(dependencies) })}\n`);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.unlink(lockPath).catch(() => {});
    throw error;
  }
  return async () => {
    await handle.close();
    await fs.promises.unlink(lockPath);
    await syncDirectory(namespace);
  };
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

async function removeGeneratedStage(stage, namespace) {
  if (path.dirname(stage) !== namespace
      || !path.basename(stage).startsWith('.AeMcpNative.stage.')
      || !path.basename(stage).endsWith('.disabled')) {
    throw installerError('AE_PLUGIN_INSTALL_STATE_INVALID', 'refused to remove an unmanaged path');
  }
  await fs.promises.rm(stage, { recursive: true, force: true });
}

async function prepareNamespace(mediaCoreRoot) {
  const safeMediaCore = await ensureSafeDirectory(mediaCoreRoot);
  const namespace = await ensureSafeDirectory(path.join(safeMediaCore, NAMESPACE_NAME));
  return {
    namespace,
    target: path.join(namespace, BUNDLE_NAME),
  };
}

async function assertNoUnexpectedLoadableBundles(namespace) {
  const entries = await fs.promises.readdir(namespace);
  const unexpected = entries.filter(
    (name) => name.endsWith('.plugin') && name !== BUNDLE_NAME,
  );
  if (unexpected.length > 0) {
    throw installerError(
      'AE_PLUGIN_INSTALL_STATE_INVALID',
      'managed MediaCore namespace contains an unexpected loadable plug-in bundle',
    );
  }
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
      await dependencies.renameBundle(target, failed);
    } catch (error) {
      failures.push(`preserve failed candidate: ${error?.code ?? 'rename failed'}`);
    }
  }
  if (oldMoved && await lstatOrNull(backup)) {
    try {
      if (await lstatOrNull(target)) {
        failures.push('restore previous target: destination is occupied');
      } else {
        await dependencies.renameBundle(backup, target);
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
  mediaCoreRoot = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Adobe',
    'Common',
    'Plug-ins',
    '7.0',
    'MediaCore',
  ),
  dependencies: dependencyOverrides,
}) {
  const dependencies = dependenciesFor(dependencyOverrides);
  requireMac(dependencies);
  await dependencies.assertAeStopped();
  const source = await loadSourceArtifact(artifactDir, dependencies);
  const { namespace, target } = await prepareNamespace(mediaCoreRoot);
  const artifactReal = await fs.promises.realpath(artifactDir);
  const relativeSource = path.relative(namespace, artifactReal);
  if (relativeSource === ''
      || (!relativeSource.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeSource))) {
    throw installerError(
      'AE_PLUGIN_ARTIFACT_INVALID',
      'source artifact must remain outside the managed installation directory',
    );
  }

  const releaseLock = await acquireLock(namespace, dependencies);
  let stage;
  let preserveForRecovery = false;
  try {
    await assertNoUnexpectedLoadableBundles(namespace);
    await recoverIncompleteTransactions({ dependencies, namespace, target });
    const transactionId = dependencies.randomUUID();
    assertTransactionId(transactionId);
    const stageName = managedName('stage', transactionId);
    const backupName = managedName('backup', transactionId);
    const failedName = managedName('failed', transactionId);
    stage = path.join(namespace, stageName);
    const backup = path.join(namespace, backupName);
    const failed = path.join(namespace, failedName);
    const transactionPath = path.join(namespace, transactionName(transactionId));
    const currentPath = path.join(namespace, CURRENT_NAME);
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
    await writeJsonExclusive(transactionPath, transaction);

    let oldMoved = false;
    let candidateMoved = false;
    try {
      await dependencies.onTransition('install.prepared');
      await dependencies.assertAeStopped();
      if (previousArtifact) {
        await dependencies.renameBundle(target, backup);
        oldMoved = true;
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
      await dependencies.renameBundle(stage, target);
      candidateMoved = true;
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
      await removeGeneratedStage(stage, namespace).catch(() => {});
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

async function loadTransactions(namespace) {
  const records = [];
  const pattern = /^\.AeMcpNative\.transaction\.([0-9a-f-]+)\.json$/u;
  for (const name of await fs.promises.readdir(namespace)) {
    const match = pattern.exec(name);
    if (!match) continue;
    assertTransactionId(match[1]);
    const value = validateTransaction(
      await readJson(path.join(namespace, name), 'transaction record'),
      match[1],
    );
    records.push({ name, path: path.join(namespace, name), value });
  }
  records.sort((left, right) => String(left.value.createdAt).localeCompare(
    String(right.value.createdAt),
  ));
  return records;
}

async function recoverInstallTransaction({ dependencies, namespace, record, target }) {
  let transaction = record.value;
  const { transactionId } = transaction;
  const stage = path.join(namespace, managedName('stage', transactionId));
  const backup = transaction.previous.backupName
    ? path.join(namespace, transaction.previous.backupName) : null;
  const failedName = managedName('failed', transactionId);
  const failed = path.join(namespace, failedName);
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

  await dependencies.assertAeStopped();
  if (targetIsInstalled) {
    if (failedArtifact) {
      throw installerError(
        'AE_PLUGIN_RECOVERY_INCOMPLETE',
        'both target and failed candidate exist during recovery',
        { transactionId },
      );
    }
    await dependencies.renameBundle(target, failed);
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
      await dependencies.renameBundle(backup, target);
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
    await removeGeneratedStage(stage, namespace);
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

async function recoverRollbackTransaction({ dependencies, namespace, record, target }) {
  let transaction = record.value;
  const { transactionId } = transaction;
  const backup = transaction.previous.backupName
    ? path.join(namespace, transaction.previous.backupName) : null;
  const replaced = path.join(namespace, managedName('replaced', transactionId));
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

  await dependencies.assertAeStopped();
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
      await dependencies.renameBundle(target, backup);
    } else if (targetArtifact) {
      throw installerError(
        'AE_PLUGIN_RECOVERY_INCOMPLETE',
        'rollback recovery target is occupied',
        { transactionId },
      );
    }
    await dependencies.renameBundle(replaced, target);
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

async function reconcileCurrentTransaction({ dependencies, namespace, target, transactions }) {
  const currentPath = path.join(namespace, CURRENT_NAME);
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

async function recoverIncompleteTransactions({ dependencies, namespace, target }) {
  const records = await loadTransactions(namespace);
  const recovered = [];
  if (records.length === 0) {
    const currentTransactionId = await readCurrentTransactionId(path.join(namespace, CURRENT_NAME));
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
        namespace,
        record,
        target,
      }));
    } else if (rollbackStates.has(record.value.status)) {
      recovered.push(await recoverRollbackTransaction({
        dependencies,
        namespace,
        record,
        target,
      }));
    }
  }
  const refreshed = recovered.length > 0 ? await loadTransactions(namespace) : records;
  const currentTransactionId = await reconcileCurrentTransaction({
    dependencies,
    namespace,
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
      await dependencies.renameBundle(target, backup);
    } catch (error) {
      failures.push(`preserve restored previous target: ${error?.code ?? 'rename failed'}`);
    }
  }
  if (targetMoved && await lstatOrNull(replaced)) {
    try {
      if (await lstatOrNull(target)) {
        failures.push('restore installed target: destination is occupied');
      } else {
        await dependencies.renameBundle(replaced, target);
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
  mediaCoreRoot = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Adobe',
    'Common',
    'Plug-ins',
    '7.0',
    'MediaCore',
  ),
  dependencies: dependencyOverrides,
}) {
  assertTransactionId(transactionId);
  const dependencies = dependenciesFor(dependencyOverrides);
  requireMac(dependencies);
  await dependencies.assertAeStopped();
  const { namespace, target } = await prepareNamespace(mediaCoreRoot);
  const releaseLock = await acquireLock(namespace, dependencies);
  try {
    await assertNoUnexpectedLoadableBundles(namespace);
    await recoverIncompleteTransactions({ dependencies, namespace, target });
    const transactionPath = path.join(namespace, transactionName(transactionId));
    const currentPath = path.join(namespace, CURRENT_NAME);
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
    const backup = backupName ? path.join(namespace, backupName) : null;
    if (backup) {
      await verifyDisabled(
        backup,
        transaction.previous.artifact,
        dependencies,
        'rollback backup artifact',
      );
    }
    const replacedName = managedName('replaced', transactionId);
    const replaced = path.join(namespace, replacedName);
    await ensureMissing(replaced, 'rollback replacement');
    await dependencies.assertAeStopped();
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
      await dependencies.renameBundle(target, replaced);
      targetMoved = true;
      await dependencies.onTransition('rollback.target_moved');
      transaction = {
        ...transaction,
        status: 'rollback_target_moved',
        updatedAt: nowIso(dependencies),
      };
      await writeJsonAtomic(transactionPath, transaction);
      if (backup) {
        await dependencies.renameBundle(backup, target);
        previousRestored = true;
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
  mediaCoreRoot = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Adobe',
    'Common',
    'Plug-ins',
    '7.0',
    'MediaCore',
  ),
  dependencies: dependencyOverrides,
} = {}) {
  const dependencies = dependenciesFor(dependencyOverrides);
  requireMac(dependencies);
  await dependencies.assertAeStopped();
  const { namespace, target } = await prepareNamespace(mediaCoreRoot);
  const releaseLock = await acquireLock(namespace, dependencies);
  try {
    await assertNoUnexpectedLoadableBundles(namespace);
    const recovery = await recoverIncompleteTransactions({ dependencies, namespace, target });
    return Object.freeze({
      schemaVersion: 1,
      action: 'recover',
      target,
      recovered: recovery.recovered,
      currentTransactionId: recovery.currentTransactionId,
      restartRequired: recovery.recovered.length > 0,
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
