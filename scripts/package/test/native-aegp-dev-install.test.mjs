import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  installDevMacPlugin,
  recoverDevMacPlugin,
  rollbackDevMacPlugin,
} from '../../../native/ae-plugin/install-dev-macos.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const installerPath = path.join(repoRoot, 'native/ae-plugin/install-dev-macos.mjs');
const SOURCE_COMMIT = 'a'.repeat(40);
const TX1 = '00000000-0000-4000-8000-000000000001';
const TX2 = '00000000-0000-4000-8000-000000000002';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function artifactFor(payload) {
  return {
    schemaVersion: 1,
    bundleName: 'AeMcpNative.plugin',
    platform: 'macos-arm64',
    architecture: 'arm64',
    bundleType: 'AEgx',
    entryPoint: 'AeMcpNativeMain',
    fileCount: 5,
    bundleTreeSha256: digest(`tree:${payload}`),
    executableSha256: digest(`executable:${payload}`),
    piplSha256: digest(`pipl:${payload}`),
    codeSignature: 'ad-hoc-verified',
  };
}

async function makeArtifact(root, name, payload, { receiptArtifact } = {}) {
  const artifactDir = path.join(root, name);
  const bundle = path.join(artifactDir, 'AeMcpNative.plugin');
  await mkdir(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(path.join(bundle, 'payload.txt'), payload, 'utf8');
  await writeFile(
    path.join(bundle, 'Contents', 'MacOS', 'AeMcpNative'),
    `fake-mach-o:${payload}:${SOURCE_COMMIT}`,
    'utf8',
  );
  const receipt = {
    schemaVersion: 1,
    artifact: receiptArtifact ?? artifactFor(payload),
    sourceCommit: SOURCE_COMMIT,
    source: {
      commit: SOURCE_COMMIT,
      repositoryClean: true,
    },
    protocolSchemaSha256: 'b'.repeat(64),
    sdk: {
      name: 'Adobe After Effects C/C++ Plug-in SDK',
      claimedVersion: '25.6.61',
      claimedBuild: 61,
      materialIncluded: false,
      archiveVerification: 'sha256-verified',
      rootVerification: 'layout-and-content-verified',
      inputProvenance: 'archive-byte-identity-plus-canonical-root-content',
    },
    build: {
      configuration: 'development',
      signing: 'ad-hoc',
      distributionApproved: false,
      runtimeEvidence: false,
      compatibilityEvidence: false,
    },
  };
  await writeFile(
    path.join(artifactDir, 'build-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  );
  return artifactDir;
}

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ae-native-install-test-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    mediaCoreRoot: path.join(root, 'MediaCore'),
    namespace: path.join(root, 'MediaCore', 'ae-mcp'),
    stateBase: path.join(root, '.ae-mcp-native-state-v1'),
    stateStore: path.join(root, '.ae-mcp-native-state-v1', 'store'),
    target: path.join(root, 'MediaCore', 'ae-mcp', 'AeMcpNative.plugin'),
  };
}

function fakeVerifier(calls = []) {
  return async ({ bundlePath, allowManagedDisabledName = false }) => {
    const name = path.basename(bundlePath);
    const disabled = /^\.AeMcpNative\.(?:stage|backup|failed|replaced)\..+\.disabled$/u;
    if (name !== 'AeMcpNative.plugin' && !(allowManagedDisabledName && disabled.test(name))) {
      const error = new Error('unexpected bundle name');
      error.code = 'AE_PLUGIN_LAYOUT_INVALID';
      throw error;
    }
    const payload = await readFile(path.join(bundlePath, 'payload.txt'), 'utf8');
    calls.push({ allowManagedDisabledName, name, payload });
    return artifactFor(payload);
  };
}

const fakeGuardOwners = new Set();

async function fakeAcquireStateGuard(directory) {
  if (fakeGuardOwners.has(directory)) {
    const error = new Error('test state guard is already held');
    error.code = 'AE_PLUGIN_INSTALL_LOCKED';
    throw error;
  }
  fakeGuardOwners.add(directory);
  return async () => {
    fakeGuardOwners.delete(directory);
  };
}

function dependencies({
  acquireStateGuard = process.platform === 'darwin' ? null : fakeAcquireStateGuard,
  gate = async () => {},
  isProcessAlive = () => true,
  onTransition = () => {},
  renameBundle = rename,
  syncDirectory,
  transactionId = TX1,
  verifyCalls = [],
} = {}) {
  const result = {
    assertAeStopped: gate,
    isProcessAlive,
    now: () => new Date('2026-07-14T00:00:00.000Z'),
    onTransition,
    platform: 'darwin',
    randomUUID: () => transactionId,
    renameBundle,
    syncDirectory,
    verifyBundle: fakeVerifier(verifyCalls),
  };
  if (acquireStateGuard) result.acquireStateGuard = acquireStateGuard;
  return result;
}

function crashAt(expected) {
  return (transition) => {
    if (transition !== expected) return;
    const error = new Error(`simulated crash at ${expected}`);
    error.code = 'AE_TEST_CRASH';
    error.simulatedCrash = true;
    throw error;
  };
}

function failFirstSyncAfterRename(expectedSource, expectedDestination) {
  let armed = false;
  let failureCount = 0;
  return {
    failureCount: () => failureCount,
    renameBundle: async (source, destination) => {
      await rename(source, destination);
      if (source === expectedSource && destination === expectedDestination) armed = true;
    },
    syncDirectory: async () => {
      if (!armed) return;
      armed = false;
      failureCount += 1;
      const error = new Error('injected post-rename directory sync failure');
      error.code = 'AE_TEST_SYNC';
      throw error;
    },
  };
}

async function payloadAt(bundle) {
  return readFile(path.join(bundle, 'payload.txt'), 'utf8');
}

async function deploymentNames(namespace) {
  return (await readdir(namespace)).sort();
}

async function deploymentNamesOrEmpty(namespace) {
  try {
    return await deploymentNames(namespace);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function bundlePathsUnder(root) {
  const found = [];
  const bundleShaped = /(?:\.plugin$|^\.AeMcpNative\.(?:stage|backup|failed|replaced)\..+\.disabled$)/u;
  const containsNativeExecutable = async (directory) => {
    try {
      const metadata = await lstat(path.join(directory, 'Contents', 'MacOS', 'AeMcpNative'));
      return metadata.isFile() || metadata.isSymbolicLink();
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
      throw error;
    }
  };
  const visit = async (directory, relativeDirectory = '') => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const relative = path.join(relativeDirectory, entry.name);
      const candidate = path.join(directory, entry.name);
      if (bundleShaped.test(entry.name)
          || (entry.isDirectory() && await containsNativeExecutable(candidate))) {
        found.push(relative);
        continue;
      }
      if (entry.isDirectory()) {
        await visit(candidate, relative);
      }
    }
  };
  await visit(root);
  return found.sort();
}

async function assertScanRootExactly(state, active) {
  const expectedNames = active ? ['AeMcpNative.plugin'] : [];
  const expectedBundles = active ? [path.join('ae-mcp', 'AeMcpNative.plugin')] : [];
  assert.deepEqual(await deploymentNamesOrEmpty(state.namespace), expectedNames);
  assert.deepEqual(await bundlePathsUnder(state.mediaCoreRoot), expectedBundles);
}

async function assertScanRootIsolated(state) {
  const names = await deploymentNamesOrEmpty(state.namespace);
  assert.ok(
    names.length === 0
      || (names.length === 1 && names[0] === 'AeMcpNative.plugin'),
    `unexpected deployment entries: ${names.join(', ')}`,
  );
  assert.deepEqual(
    await bundlePathsUnder(state.mediaCoreRoot),
    names.length === 0 ? [] : [path.join('ae-mcp', 'AeMcpNative.plugin')],
  );
}

async function moveStateStoreIntoLegacyNamespace(state) {
  for (const name of await readdir(state.stateStore)) {
    await rename(path.join(state.stateStore, name), path.join(state.namespace, name));
  }
  await rm(state.stateStore, { recursive: true });
}

async function prepareLegacyUpgrade(state, prefix = 'legacy') {
  const first = await makeArtifact(state.root, `${prefix}-one`, 'one');
  const second = await makeArtifact(state.root, `${prefix}-two`, 'two');
  await installDevMacPlugin({
    artifactDir: first,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  const upgraded = await installDevMacPlugin({
    artifactDir: second,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX2 }),
  });
  await moveStateStoreIntoLegacyNamespace(state);
  return upgraded;
}

async function orphanEvidenceFiles(state) {
  const root = path.join(state.stateBase, 'orphan-evidence');
  let records;
  try {
    records = await readdir(root);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const record of records.sort()) {
    const recordPath = path.join(root, record);
    for (const name of (await readdir(recordPath)).sort()) {
      files.push({
        name,
        path: path.join(recordPath, name),
        record,
      });
    }
  }
  return files;
}

test('fresh install is receipt-bound, triple-gated, and rolls back without deleting evidence', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.root, 'build-one', 'one');
  let gateCalls = 0;
  const verifyCalls = [];
  const installed = await installDevMacPlugin({
    artifactDir,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({
      gate: async () => { gateCalls += 1; },
      transactionId: TX1,
      verifyCalls,
    }),
  });
  assert.equal(gateCalls, 3);
  assert.equal(installed.transactionId, TX1);
  assert.equal(installed.previous.present, false);
  assert.equal(await payloadAt(state.target), 'one');
  await assertScanRootExactly(state, true);
  assert.ok(verifyCalls.some((call) => call.allowManagedDisabledName
    && call.name.includes('.stage.')));

  gateCalls = 0;
  const rolledBack = await rollbackDevMacPlugin({
    transactionId: TX1,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ gate: async () => { gateCalls += 1; } }),
  });
  assert.equal(gateCalls, 2);
  assert.equal(rolledBack.restoredPrevious, false);
  await assert.rejects(payloadAt(state.target), { code: 'ENOENT' });
  assert.ok((await readdir(state.stateStore)).includes(
    `.AeMcpNative.replaced.${TX1}.disabled`,
  ));
  await assertScanRootExactly(state, false);

  const again = await rollbackDevMacPlugin({
    transactionId: TX1,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(again.alreadyRolledBack, true);
  await assertScanRootExactly(state, false);
});

test('upgrade keeps a hash-bound disabled backup and rollback restores it', async (t) => {
  const state = await fixture(t);
  const first = await makeArtifact(state.root, 'build-one', 'one');
  const second = await makeArtifact(state.root, 'build-two', 'two');
  await installDevMacPlugin({
    artifactDir: first,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  const upgraded = await installDevMacPlugin({
    artifactDir: second,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX2 }),
  });
  assert.equal(upgraded.previous.present, true);
  assert.equal(await payloadAt(state.target), 'two');
  assert.equal(
    await payloadAt(path.join(state.stateStore, upgraded.previous.backupName)),
    'one',
  );
  await assertScanRootExactly(state, true);

  const result = await rollbackDevMacPlugin({
    transactionId: TX2,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(result.restoredPrevious, true);
  assert.equal(await payloadAt(state.target), 'one');
  await assertScanRootExactly(state, true);
});

test('legacy in-scan v1 state migrates off-scan and keeps exact rollback', async (t) => {
  const state = await fixture(t);
  const first = await makeArtifact(state.root, 'legacy-one', 'one');
  const second = await makeArtifact(state.root, 'legacy-two', 'two');
  await installDevMacPlugin({
    artifactDir: first,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  const upgraded = await installDevMacPlugin({
    artifactDir: second,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX2 }),
  });

  await moveStateStoreIntoLegacyNamespace(state);
  assert.ok((await deploymentNames(state.namespace)).length > 1);

  const recovered = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(recovered.migratedLegacyState, true);
  assert.equal(recovered.currentTransactionId, TX2);
  await assertScanRootExactly(state, true);
  assert.equal(
    await payloadAt(path.join(state.stateStore, upgraded.previous.backupName)),
    'one',
  );

  const rolledBack = await rollbackDevMacPlugin({
    transactionId: TX2,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(rolledBack.restoredPrevious, true);
  assert.equal(await payloadAt(state.target), 'one');
  await assertScanRootExactly(state, true);
});

test('recover resumes migration after the legacy namespace was moved off-scan', async (t) => {
  const state = await fixture(t);
  const upgraded = await prepareLegacyUpgrade(state, 'migration-interrupted');
  await rename(state.namespace, state.stateStore);
  await assertScanRootExactly(state, false);

  const recovered = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(recovered.migratedLegacyState, true);
  assert.equal(recovered.currentTransactionId, TX2);
  assert.equal(await payloadAt(state.target), 'two');
  assert.equal(
    await payloadAt(path.join(state.stateStore, upgraded.previous.backupName)),
    'one',
  );
  await assertScanRootExactly(state, true);
});

test('recover finishes a split migration with stateStore and legacy namespace entries', async (t) => {
  const state = await fixture(t);
  const upgraded = await prepareLegacyUpgrade(state, 'migration-split');
  await mkdir(state.stateStore, { recursive: true });
  await rename(
    path.join(state.namespace, '.AeMcpNative.current.json'),
    path.join(state.stateStore, '.AeMcpNative.current.json'),
  );

  const recovered = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(recovered.migratedLegacyState, true);
  assert.equal(recovered.currentTransactionId, TX2);
  assert.equal(await payloadAt(state.target), 'two');
  assert.equal(
    await payloadAt(path.join(state.stateStore, upgraded.previous.backupName)),
    'one',
  );
  await assertScanRootExactly(state, true);
});

test('recover quarantines an unknown legacy temp file after restoring the canonical target', async (t) => {
  const state = await fixture(t);
  const upgraded = await prepareLegacyUpgrade(state, 'legacy-unknown-temp');
  const unknownName = '..AeMcpNative.current.json.tmp-999-abcdef';
  await writeFile(path.join(state.namespace, unknownName), 'partial legacy state\n', 'utf8');

  await assert.rejects(
    recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    (error) => {
      assert.equal(error.code, 'AE_PLUGIN_INSTALL_STATE_INVALID');
      assert.deepEqual(error.recovery, { quarantineName: 'legacy-namespace-migration' });
      return true;
    },
  );
  assert.equal(await payloadAt(state.target), 'two');
  await assertScanRootExactly(state, true);

  const quarantine = path.join(state.stateBase, 'legacy-namespace-migration');
  const quarantineNames = await readdir(quarantine);
  assert.ok(quarantineNames.includes(unknownName));
  assert.ok(quarantineNames.includes(upgraded.previous.backupName));
  assert.ok(quarantineNames.includes(`.AeMcpNative.transaction.${TX1}.json`));
  assert.ok(quarantineNames.includes(`.AeMcpNative.transaction.${TX2}.json`));
  assert.equal(
    await readFile(path.join(quarantine, unknownName), 'utf8'),
    'partial legacy state\n',
  );
  assert.equal(
    await payloadAt(path.join(quarantine, upgraded.previous.backupName)),
    'one',
  );
});

for (const transition of [
  'migration.namespace_moved',
  'migration.namespace_recreated',
  'migration.target_restored',
  'migration.state_moved',
]) {
  test(`recover resumes legacy migration after interrupted ${transition}`, async (t) => {
    const state = await fixture(t);
    await prepareLegacyUpgrade(state, transition.replaceAll('.', '-'));

    await assert.rejects(
      recoverDevMacPlugin({
        mediaCoreRoot: state.mediaCoreRoot,
        dependencies: dependencies({ onTransition: crashAt(transition) }),
      }),
      { code: 'AE_TEST_CRASH' },
    );
    await assertScanRootIsolated(state);

    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.migratedLegacyState, true);
    assert.equal(recovered.currentTransactionId, TX2);
    assert.equal(await payloadAt(state.target), 'two');
    await assertScanRootExactly(state, true);
  });
}

test('second AE process gate aborts an upgrade without changing its target', async (t) => {
  const state = await fixture(t);
  const first = await makeArtifact(state.root, 'build-one', 'one');
  const second = await makeArtifact(state.root, 'build-two', 'two');
  await installDevMacPlugin({
    artifactDir: first,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  let calls = 0;
  const gate = async () => {
    calls += 1;
    if (calls === 2) {
      const error = new Error('AE started during deployment');
      error.code = 'AE_PROCESS_RUNNING';
      throw error;
    }
  };
  await assert.rejects(
    installDevMacPlugin({
      artifactDir: second,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ gate, transactionId: TX2 }),
    }),
    { code: 'AE_PROCESS_RUNNING' },
  );
  assert.equal(await payloadAt(state.target), 'one');
  await assertScanRootExactly(state, true);
});

test('second rename failure restores the old target and removes only generated stage', async (t) => {
  const state = await fixture(t);
  const first = await makeArtifact(state.root, 'build-one', 'one');
  const second = await makeArtifact(state.root, 'build-two', 'two');
  await installDevMacPlugin({
    artifactDir: first,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  let moves = 0;
  const renameBundle = async (source, destination) => {
    moves += 1;
    if (moves === 2) {
      const error = new Error('injected second rename failure');
      error.code = 'AE_TEST_RENAME';
      throw error;
    }
    await rename(source, destination);
  };
  await assert.rejects(
    installDevMacPlugin({
      artifactDir: second,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ renameBundle, transactionId: TX2 }),
    }),
    { code: 'AE_TEST_RENAME' },
  );
  assert.equal(await payloadAt(state.target), 'one');
  assert.equal((await readdir(state.stateStore)).some((name) => name.includes('.stage.')), false);
  await assertScanRootExactly(state, true);
});

test('upgrade restores the old target after target-to-backup post-rename sync failure', async (t) => {
  const state = await fixture(t);
  const first = await makeArtifact(state.root, 'sync-upgrade-one', 'one');
  const second = await makeArtifact(state.root, 'sync-upgrade-two', 'two');
  await installDevMacPlugin({
    artifactDir: first,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  const backup = path.join(
    state.stateStore,
    `.AeMcpNative.backup.${TX2}.disabled`,
  );
  const fault = failFirstSyncAfterRename(state.target, backup);

  await assert.rejects(
    installDevMacPlugin({
      artifactDir: second,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({
        renameBundle: fault.renameBundle,
        syncDirectory: fault.syncDirectory,
        transactionId: TX2,
      }),
    }),
    { code: 'AE_TEST_SYNC' },
  );
  assert.equal(fault.failureCount(), 1);
  assert.equal(await payloadAt(state.target), 'one');
  await assertScanRootExactly(state, true);
  const transaction = JSON.parse(await readFile(
    path.join(state.stateStore, `.AeMcpNative.transaction.${TX2}.json`),
    'utf8',
  ));
  assert.equal(transaction.status, 'failed_rolled_back');
  const current = JSON.parse(await readFile(
    path.join(state.stateStore, '.AeMcpNative.current.json'),
    'utf8',
  ));
  assert.equal(current.transactionId, TX1);
});

test('rollback restores the installed target after target-to-replaced post-rename sync failure', async (t) => {
  const state = await fixture(t);
  const first = await makeArtifact(state.root, 'sync-rollback-one', 'one');
  const second = await makeArtifact(state.root, 'sync-rollback-two', 'two');
  await installDevMacPlugin({
    artifactDir: first,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  await installDevMacPlugin({
    artifactDir: second,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX2 }),
  });
  const replaced = path.join(
    state.stateStore,
    `.AeMcpNative.replaced.${TX2}.disabled`,
  );
  const fault = failFirstSyncAfterRename(state.target, replaced);

  await assert.rejects(
    rollbackDevMacPlugin({
      transactionId: TX2,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({
        renameBundle: fault.renameBundle,
        syncDirectory: fault.syncDirectory,
      }),
    }),
    { code: 'AE_TEST_SYNC' },
  );
  assert.equal(fault.failureCount(), 1);
  assert.equal(await payloadAt(state.target), 'two');
  await assertScanRootExactly(state, true);
  const transaction = JSON.parse(await readFile(
    path.join(state.stateStore, `.AeMcpNative.transaction.${TX2}.json`),
    'utf8',
  ));
  assert.equal(transaction.status, 'committed');
  const current = JSON.parse(await readFile(
    path.join(state.stateStore, '.AeMcpNative.current.json'),
    'utf8',
  ));
  assert.equal(current.transactionId, TX2);
  await assert.rejects(payloadAt(replaced), { code: 'ENOENT' });
});

test('complete artifact receipt comparison rejects a single changed hash', async (t) => {
  const state = await fixture(t);
  const mismatched = {
    ...artifactFor('one'),
    bundleTreeSha256: 'c'.repeat(64),
  };
  const artifactDir = await makeArtifact(
    state.root,
    'build-mismatch',
    'one',
    { receiptArtifact: mismatched },
  );
  await assert.rejects(
    installDevMacPlugin({
      artifactDir,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_RECEIPT_MISMATCH' },
  );
});

test('receipt source commit must also be embedded in the native executable bytes', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.root, 'build-unbound', 'one');
  await writeFile(
    path.join(artifactDir, 'AeMcpNative.plugin', 'Contents', 'MacOS', 'AeMcpNative'),
    'fake-mach-o-without-a-source-commit',
    'utf8',
  );
  await assert.rejects(
    installDevMacPlugin({
      artifactDir,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_RECEIPT_MISMATCH' },
  );
});

for (const transition of ['install.prepared', 'install.old_moved', 'install.candidate_moved']) {
  test(`recover repairs an interrupted upgrade at ${transition}`, async (t) => {
    const state = await fixture(t);
    const first = await makeArtifact(state.root, 'build-one', 'one');
    const second = await makeArtifact(state.root, 'build-two', 'two');
    await installDevMacPlugin({
      artifactDir: first,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ transactionId: TX1 }),
    });
    await assert.rejects(
      installDevMacPlugin({
        artifactDir: second,
        mediaCoreRoot: state.mediaCoreRoot,
        dependencies: dependencies({
          onTransition: crashAt(transition),
          transactionId: TX2,
        }),
      }),
      { code: 'AE_TEST_CRASH' },
    );
    await assertScanRootIsolated(state);
    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0].transactionId, TX2);
    assert.equal(recovered.recovered[0].to, 'failed_rolled_back');
    assert.equal(await payloadAt(state.target), 'one');
    await assertScanRootExactly(state, true);
  });
}

for (const transition of [
  'rollback.prepared',
  'rollback.target_moved',
  'rollback.previous_moved',
]) {
  test(`recover reinstates the current target after interrupted ${transition}`, async (t) => {
    const state = await fixture(t);
    const first = await makeArtifact(state.root, 'build-one', 'one');
    const second = await makeArtifact(state.root, 'build-two', 'two');
    await installDevMacPlugin({
      artifactDir: first,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ transactionId: TX1 }),
    });
    await installDevMacPlugin({
      artifactDir: second,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ transactionId: TX2 }),
    });
    await assert.rejects(
      rollbackDevMacPlugin({
        transactionId: TX2,
        mediaCoreRoot: state.mediaCoreRoot,
        dependencies: dependencies({ onTransition: crashAt(transition) }),
      }),
      { code: 'AE_TEST_CRASH' },
    );
    await assertScanRootIsolated(state);
    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0].to, 'committed');
    assert.equal(await payloadAt(state.target), 'two');
    await assertScanRootExactly(state, true);
  });
}

for (const transition of ['install.prepared', 'install.old_moved', 'install.candidate_moved']) {
  test(`identical artifact reinstall recovers safely at ${transition}`, async (t) => {
    const state = await fixture(t);
    const first = await makeArtifact(state.root, 'build-one-a', 'same');
    const second = await makeArtifact(state.root, 'build-one-b', 'same');
    await installDevMacPlugin({
      artifactDir: first,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ transactionId: TX1 }),
    });
    await assert.rejects(
      installDevMacPlugin({
        artifactDir: second,
        mediaCoreRoot: state.mediaCoreRoot,
        dependencies: dependencies({
          onTransition: crashAt(transition),
          transactionId: TX2,
        }),
      }),
      { code: 'AE_TEST_CRASH' },
    );
    await assertScanRootIsolated(state);
    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.recovered[0].to, 'failed_rolled_back');
    assert.equal(recovered.currentTransactionId, TX1);
    assert.equal(await payloadAt(state.target), 'same');
    await assertScanRootExactly(state, true);
  });
}

for (const transition of [
  'rollback.prepared',
  'rollback.target_moved',
  'rollback.previous_moved',
]) {
  test(`identical artifact rollback recovers safely at ${transition}`, async (t) => {
    const state = await fixture(t);
    const first = await makeArtifact(state.root, 'build-one-a', 'same');
    const second = await makeArtifact(state.root, 'build-one-b', 'same');
    await installDevMacPlugin({
      artifactDir: first,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ transactionId: TX1 }),
    });
    await installDevMacPlugin({
      artifactDir: second,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ transactionId: TX2 }),
    });
    await assert.rejects(
      rollbackDevMacPlugin({
        transactionId: TX2,
        mediaCoreRoot: state.mediaCoreRoot,
        dependencies: dependencies({ onTransition: crashAt(transition) }),
      }),
      { code: 'AE_TEST_CRASH' },
    );
    await assertScanRootIsolated(state);
    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.recovered[0].to, 'committed');
    assert.equal(recovered.currentTransactionId, TX2);
    assert.equal(await payloadAt(state.target), 'same');
    await assertScanRootExactly(state, true);
  });
}

test('reconcile follows transaction ancestry instead of timestamp or UUID ordering', async (t) => {
  const state = await fixture(t);
  const first = await makeArtifact(state.root, 'reverse-one', 'same');
  const second = await makeArtifact(state.root, 'reverse-two', 'same');
  await installDevMacPlugin({
    artifactDir: first,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX2 }),
  });
  await installDevMacPlugin({
    artifactDir: second,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  await writeFile(
    path.join(state.stateStore, '.AeMcpNative.current.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      transactionId: TX2,
      updatedAt: '2026-07-14T00:00:00.000Z',
    })}\n`,
    'utf8',
  );
  const recovered = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(recovered.currentTransactionId, TX1);
  const current = JSON.parse(await readFile(
    path.join(state.stateStore, '.AeMcpNative.current.json'),
    'utf8',
  ));
  assert.equal(current.transactionId, TX1);
});

test('recover archives complete and partial orphan state temps and continues', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.root, 'orphan-temp-baseline', 'one');
  await installDevMacPlugin({
    artifactDir,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  const currentPath = path.join(state.stateStore, '.AeMcpNative.current.json');
  const currentTempName = '..AeMcpNative.current.json.tmp-1001-aaaaaaaaaaaa';
  const transactionTempName = `..AeMcpNative.transaction.${TX2}.json.tmp-1002-bbbbbbbbbbbb`;
  const completeCurrent = await readFile(currentPath);
  const partialTransaction = Buffer.from('{"schemaVersion": 1, "transactionId":');
  await writeFile(path.join(state.stateStore, currentTempName), completeCurrent);
  await writeFile(path.join(state.stateStore, transactionTempName), partialTransaction);

  const recovered = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(recovered.migratedLegacyState, true);
  assert.equal(recovered.currentTransactionId, TX1);
  assert.equal(await payloadAt(state.target), 'one');
  await assertScanRootExactly(state, true);
  const firstEvidence = await orphanEvidenceFiles(state);
  assert.deepEqual(
    firstEvidence.map((entry) => entry.name).sort(),
    [currentTempName, transactionTempName].sort(),
  );
  const currentEvidence = firstEvidence.find((entry) => entry.name === currentTempName);
  const transactionEvidence = firstEvidence.find((entry) => entry.name === transactionTempName);
  assert.deepEqual(await readFile(currentEvidence.path), completeCurrent);
  assert.deepEqual(await readFile(transactionEvidence.path), partialTransaction);
  assert.equal((await readdir(state.stateStore)).includes(currentTempName), false);
  assert.equal((await readdir(state.stateStore)).includes(transactionTempName), false);

  const again = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(again.currentTransactionId, TX1);
  assert.equal(again.migratedLegacyState, false);
  assert.deepEqual(
    (await orphanEvidenceFiles(state)).map((entry) => `${entry.record}/${entry.name}`),
    firstEvidence.map((entry) => `${entry.record}/${entry.name}`),
  );
  await assertScanRootExactly(state, true);
});

test('recover removes hardlinked state temp aliases without changing valid finals', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.root, 'hardlink-temp-baseline', 'one');
  await installDevMacPlugin({
    artifactDir,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ transactionId: TX1 }),
  });
  const currentPath = path.join(state.stateStore, '.AeMcpNative.current.json');
  const transactionPath = path.join(
    state.stateStore,
    `.AeMcpNative.transaction.${TX1}.json`,
  );
  const currentTemp = path.join(
    state.stateStore,
    '..AeMcpNative.current.json.tmp-1003-cccccccccccc',
  );
  const transactionTemp = path.join(
    state.stateStore,
    `..AeMcpNative.transaction.${TX1}.json.tmp-1004-dddddddddddd`,
  );
  await link(currentPath, currentTemp);
  await link(transactionPath, transactionTemp);
  const [currentFinalBefore, currentTempBefore, transactionFinalBefore, transactionTempBefore]
    = await Promise.all([
      lstat(currentPath),
      lstat(currentTemp),
      lstat(transactionPath),
      lstat(transactionTemp),
    ]);
  assert.equal(currentFinalBefore.ino, currentTempBefore.ino);
  assert.equal(transactionFinalBefore.ino, transactionTempBefore.ino);
  assert.equal(currentFinalBefore.nlink, 2);
  assert.equal(transactionFinalBefore.nlink, 2);

  const recovered = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(recovered.currentTransactionId, TX1);
  await assert.rejects(lstat(currentTemp), { code: 'ENOENT' });
  await assert.rejects(lstat(transactionTemp), { code: 'ENOENT' });
  assert.equal((await lstat(currentPath)).nlink, 1);
  assert.equal((await lstat(transactionPath)).nlink, 1);
  assert.equal(JSON.parse(await readFile(currentPath, 'utf8')).transactionId, TX1);
  assert.equal(JSON.parse(await readFile(transactionPath, 'utf8')).status, 'committed');
  assert.deepEqual(await orphanEvidenceFiles(state), []);
  assert.equal(await payloadAt(state.target), 'one');
  await assertScanRootExactly(state, true);
});

for (const orphan of [
  { label: 'zero-byte', bytes: Buffer.alloc(0) },
  { label: 'partial', bytes: Buffer.from('{"schemaVersion": 1') },
]) {
  test(`recover deterministically archives a ${orphan.label} transaction and matching stage`, async (t) => {
    const state = await fixture(t);
    const baseline = await makeArtifact(state.root, `${orphan.label}-baseline`, 'one');
    const staged = await makeArtifact(state.root, `${orphan.label}-staged`, 'two');
    await installDevMacPlugin({
      artifactDir: baseline,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ transactionId: TX1 }),
    });
    const transactionName = `.AeMcpNative.transaction.${TX2}.json`;
    const stageName = `.AeMcpNative.stage.${TX2}.disabled`;
    const transactionPath = path.join(state.stateStore, transactionName);
    const stagePath = path.join(state.stateStore, stageName);
    await writeFile(transactionPath, orphan.bytes);
    await rename(path.join(staged, 'AeMcpNative.plugin'), stagePath);
    const initialCurrent = JSON.parse(await readFile(
      path.join(state.stateStore, '.AeMcpNative.current.json'),
      'utf8',
    ));
    assert.equal(initialCurrent.transactionId, TX1);
    for (const kind of ['backup', 'failed', 'replaced']) {
      await assert.rejects(
        lstat(path.join(state.stateStore, `.AeMcpNative.${kind}.${TX2}.disabled`)),
        { code: 'ENOENT' },
      );
    }

    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.migratedLegacyState, true);
    assert.equal(recovered.currentTransactionId, TX1);
    assert.equal(await payloadAt(state.target), 'one');
    await assertScanRootExactly(state, true);
    const evidenceDirectory = path.join(
      state.stateBase,
      'orphan-evidence',
      `transaction-${TX2}`,
    );
    assert.deepEqual((await readdir(evidenceDirectory)).sort(), [stageName, transactionName].sort());
    assert.deepEqual(await readFile(path.join(evidenceDirectory, transactionName)), orphan.bytes);
    assert.equal(await payloadAt(path.join(evidenceDirectory, stageName)), 'two');
    await assert.rejects(lstat(transactionPath), { code: 'ENOENT' });
    await assert.rejects(lstat(stagePath), { code: 'ENOENT' });

    const again = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(again.migratedLegacyState, false);
    assert.equal(again.currentTransactionId, TX1);
    assert.deepEqual(
      (await readdir(evidenceDirectory)).sort(),
      [stageName, transactionName].sort(),
    );
    assert.deepEqual(await readFile(path.join(evidenceDirectory, transactionName)), orphan.bytes);
    assert.equal(await payloadAt(state.target), 'one');
    await assertScanRootExactly(state, true);
  });
}

for (const conflict of [
  { label: 'current pointer', kind: 'current' },
  { label: 'backup evidence', kind: 'backup' },
  { label: 'replaced evidence', kind: 'replaced' },
]) {
  test(`recover fails closed for a partial transaction with ${conflict.label}`, async (t) => {
    const state = await fixture(t);
    const baseline = await makeArtifact(state.root, `fail-closed-${conflict.kind}-base`, 'one');
    const staged = await makeArtifact(state.root, `fail-closed-${conflict.kind}-stage`, 'two');
    await installDevMacPlugin({
      artifactDir: baseline,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({ transactionId: TX1 }),
    });
    const transactionName = `.AeMcpNative.transaction.${TX2}.json`;
    const stageName = `.AeMcpNative.stage.${TX2}.disabled`;
    const transactionPath = path.join(state.stateStore, transactionName);
    const stagePath = path.join(state.stateStore, stageName);
    const partialTransaction = Buffer.from('{"schemaVersion": 1, "transactionId":');
    await writeFile(transactionPath, partialTransaction);
    await rename(path.join(staged, 'AeMcpNative.plugin'), stagePath);

    const currentPath = path.join(state.stateStore, '.AeMcpNative.current.json');
    let conflictingEvidence = null;
    if (conflict.kind === 'current') {
      await writeFile(
        currentPath,
        `${JSON.stringify({
          schemaVersion: 1,
          transactionId: TX2,
          updatedAt: '2026-07-14T00:00:00.000Z',
        }, null, 2)}\n`,
        'utf8',
      );
    } else {
      const evidenceArtifact = await makeArtifact(
        state.root,
        `fail-closed-${conflict.kind}-evidence`,
        'evidence',
      );
      conflictingEvidence = path.join(
        state.stateStore,
        `.AeMcpNative.${conflict.kind}.${TX2}.disabled`,
      );
      await rename(
        path.join(evidenceArtifact, 'AeMcpNative.plugin'),
        conflictingEvidence,
      );
    }

    const before = {
      current: await readFile(currentPath),
      evidenceInode: conflictingEvidence ? (await lstat(conflictingEvidence)).ino : null,
      names: (await readdir(state.stateStore)).sort(),
      stageInode: (await lstat(stagePath)).ino,
      transaction: await readFile(transactionPath),
    };
    await assert.rejects(
      recoverDevMacPlugin({
        mediaCoreRoot: state.mediaCoreRoot,
        dependencies: dependencies(),
      }),
      { code: 'AE_PLUGIN_INSTALL_STATE_INVALID' },
    );

    assert.deepEqual((await readdir(state.stateStore)).sort(), before.names);
    assert.deepEqual(await readFile(transactionPath), before.transaction);
    assert.deepEqual(await readFile(currentPath), before.current);
    assert.equal((await lstat(stagePath)).ino, before.stageInode);
    assert.equal(await payloadAt(stagePath), 'two');
    if (conflictingEvidence) {
      assert.equal((await lstat(conflictingEvidence)).ino, before.evidenceInode);
      assert.equal(await payloadAt(conflictingEvidence), 'evidence');
    }
    await assert.rejects(
      lstat(path.join(state.stateBase, 'orphan-evidence')),
      { code: 'ENOENT' },
    );
    assert.equal(await payloadAt(state.target), 'one');
    await assertScanRootExactly(state, true);
  });
}

test('orphan recovery rethrows filesystem read errors before any archival by contract', async () => {
  const source = await readFile(installerPath, 'utf8');
  const recoveryStart = source.indexOf('async function recoverOrphanStateArtifacts(');
  const recoveryEnd = source.indexOf('\nasync function assertDeploymentNamespace(', recoveryStart);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  const recoveryContract = source.slice(recoveryStart, recoveryEnd);
  assert.match(
    recoveryContract,
    /\['AE_PLUGIN_INSTALL_STATE_INVALID', 'AE_PLUGIN_RECEIPT_INVALID'\]/u,
  );
  assert.doesNotMatch(recoveryContract, /['"](?:EIO|EACCES)['"]/u);
  const catchIndex = recoveryContract.indexOf('} catch (error) {');
  const rethrowIndex = recoveryContract.indexOf('throw error;', catchIndex);
  const archiveIndex = recoveryContract.indexOf('await archiveOrphanTransaction({', catchIndex);
  assert.ok(catchIndex >= 0 && rethrowIndex > catchIndex && archiveIndex > rethrowIndex);
});

test('kernel state guard rejects a concurrent recover and allows retry after release', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.root, 'kernel-guard-install', 'one');
  let enteredResolve;
  let enteredReject;
  let releaseResolve;
  const entered = new Promise((resolve, reject) => {
    enteredResolve = resolve;
    enteredReject = reject;
  });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const first = installDevMacPlugin({
    artifactDir,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({
      onTransition: async (transition) => {
        if (transition !== 'install.prepared') return;
        enteredResolve();
        await release;
      },
      transactionId: TX1,
    }),
  });
  first.catch(enteredReject);
  await entered;

  const preparedTransaction = path.join(
    state.stateStore,
    `.AeMcpNative.transaction.${TX1}.json`,
  );
  const stage = path.join(state.stateStore, `.AeMcpNative.stage.${TX1}.disabled`);
  const before = {
    baseNames: (await readdir(state.stateBase)).sort(),
    stageInode: (await lstat(stage)).ino,
    storeNames: (await readdir(state.stateStore)).sort(),
    transaction: await readFile(preparedTransaction),
  };
  await assertScanRootExactly(state, false);
  await assert.rejects(
    recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_INSTALL_LOCKED' },
  );
  assert.deepEqual((await readdir(state.stateBase)).sort(), before.baseNames);
  assert.deepEqual((await readdir(state.stateStore)).sort(), before.storeNames);
  assert.deepEqual(await readFile(preparedTransaction), before.transaction);
  assert.equal((await lstat(stage)).ino, before.stageInode);
  assert.equal(await payloadAt(stage), 'one');
  await assertScanRootExactly(state, false);

  releaseResolve();
  const installed = await first;
  assert.equal(installed.transactionId, TX1);
  assert.equal(await payloadAt(state.target), 'one');
  await assertScanRootExactly(state, true);

  const retried = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(retried.currentTransactionId, TX1);
  assert.equal(await payloadAt(state.target), 'one');
  await assertScanRootExactly(state, true);
});

test('Darwin kernel guard is persistent, exclusive, and held through lock release by contract', async () => {
  const source = await readFile(installerPath, 'utf8');
  assert.match(source, /const GUARD_NAME = '\.AeMcpNative\.install\.guard';/u);
  assert.match(source, /const DARWIN_O_EXLOCK = 0x20;/u);
  const guardStart = source.indexOf('async function defaultAcquireStateGuard(');
  const guardEnd = source.indexOf('\nasync function acquireLock(', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart);
  const guardContract = source.slice(guardStart, guardEnd);
  assert.match(guardContract, /process\.platform !== 'darwin'/u);
  assert.match(guardContract, /fs\.constants\.O_NONBLOCK/u);
  assert.match(guardContract, /fs\.constants\.O_NOFOLLOW/u);
  assert.match(guardContract, /DARWIN_O_EXLOCK/u);
  assert.match(guardContract, /return async \(\) => \{\s*await handle\.close\(\);\s*\};/u);
  assert.doesNotMatch(guardContract, /unlink\(guardPath\)/u);

  const lockStart = source.indexOf('async function acquireLock(');
  const lockEnd = source.indexOf('\nasync function defaultAssertAeStopped(', lockStart);
  assert.ok(lockStart >= 0 && lockEnd > lockStart);
  const lockContract = source.slice(lockStart, lockEnd);
  assert.match(
    lockContract,
    /const releaseGuard = await dependencies\.acquireStateGuard\(directory\);/u,
  );
  assert.match(lockContract, /finally \{\s*await releaseGuard\(\);\s*\}/u);
  assert.match(lockContract, /catch \(error\) \{\s*await releaseGuard\(\)\.catch/u);
});

test('recover rotates a lock owned by a dead process before reconciling state', async (t) => {
  const state = await fixture(t);
  await mkdir(state.stateBase, { recursive: true });
  await writeFile(
    path.join(state.stateBase, '.AeMcpNative.install.lock'),
    `${JSON.stringify({ pid: 999999, createdAt: '2026-07-14T00:00:00.000Z' })}\n`,
    'utf8',
  );
  const result = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ isProcessAlive: () => false }),
  });
  assert.deepEqual(result.recovered, []);
  assert.ok((await readdir(state.stateBase)).some((name) => name.includes('.stale-lock.')));
});

for (const invalidLock of [
  { label: 'zero-byte', bytes: Buffer.alloc(0) },
  { label: 'partial', bytes: Buffer.from('{"pid": 999999') },
]) {
  test(`kernel guard preserves a ${invalidLock.label} final owner lock as stale evidence`, async (t) => {
    const state = await fixture(t);
    await mkdir(state.stateBase, { recursive: true });
    const lockPath = path.join(state.stateBase, '.AeMcpNative.install.lock');
    await writeFile(lockPath, invalidLock.bytes);

    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.currentTransactionId, null);
    await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
    const staleNames = (await readdir(state.stateBase))
      .filter((name) => name.startsWith('.AeMcpNative.stale-lock.'));
    assert.equal(staleNames.length, 1);
    const stalePath = path.join(state.stateBase, staleNames[0]);
    assert.deepEqual(await readFile(stalePath), invalidLock.bytes);
    assert.equal((await lstat(stalePath)).nlink, 1);
    if (process.platform === 'darwin') {
      assert.ok((await readdir(state.stateBase)).includes('.AeMcpNative.install.guard'));
    }
    await assertScanRootExactly(state, false);

    const beforeRetry = await readFile(stalePath);
    const again = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(again.currentTransactionId, null);
    assert.deepEqual(await readFile(stalePath), beforeRetry);
    await assertScanRootExactly(state, false);
  });
}

for (const unsafeLock of ['symlink', 'hardlink', 'directory']) {
  test(`kernel guard refuses an unsafe ${unsafeLock} final owner lock`, async (t) => {
    const state = await fixture(t);
    await mkdir(state.stateBase, { recursive: true });
    const lockPath = path.join(state.stateBase, '.AeMcpNative.install.lock');
    let comparisonPath = null;
    if (unsafeLock === 'symlink') {
      comparisonPath = path.join(state.root, 'unsafe-lock-symlink-target');
      await writeFile(comparisonPath, '{"pid":999999}\n', 'utf8');
      await symlink(comparisonPath, lockPath);
    } else if (unsafeLock === 'hardlink') {
      comparisonPath = path.join(state.root, 'unsafe-lock-hardlink-source');
      await writeFile(comparisonPath, '{"pid":999999}\n', 'utf8');
      await link(comparisonPath, lockPath);
    } else {
      await mkdir(lockPath);
    }
    const before = await lstat(lockPath);

    await assert.rejects(
      recoverDevMacPlugin({
        mediaCoreRoot: state.mediaCoreRoot,
        dependencies: dependencies(),
      }),
      { code: 'AE_PLUGIN_INSTALL_LOCKED' },
    );
    const after = await lstat(lockPath);
    assert.equal(after.ino, before.ino);
    assert.equal(after.isSymbolicLink(), before.isSymbolicLink());
    assert.equal(after.isDirectory(), before.isDirectory());
    assert.equal(after.nlink, before.nlink);
    if (comparisonPath) {
      if (unsafeLock === 'hardlink') {
        assert.equal((await lstat(comparisonPath)).ino, after.ino);
      }
      assert.equal(await readFile(comparisonPath, 'utf8'), '{"pid":999999}\n');
    }
    assert.deepEqual(
      (await readdir(state.stateBase))
        .filter((name) => name.startsWith('.AeMcpNative.stale-lock.')),
      [],
    );
    await assertScanRootExactly(state, false);
  });
}

test('atomic stateBase lock acquisition cleans a published hardlink temp alias', async (t) => {
  const source = await readFile(installerPath, 'utf8');
  const acquireStart = source.indexOf('async function acquireLock(');
  const acquireEnd = source.indexOf('\nasync function defaultAssertAeStopped(', acquireStart);
  assert.ok(acquireStart >= 0 && acquireEnd > acquireStart);
  const acquireContract = source.slice(acquireStart, acquireEnd);
  assert.match(
    acquireContract,
    /await writeJsonExclusiveAtomic\(lockPath, ownerRecord\)/u,
  );
  assert.doesNotMatch(acquireContract, /writeJsonExclusive\(lockPath/u);
  assert.doesNotMatch(acquireContract, /fs\.promises\.open\(lockPath/u);

  const state = await fixture(t);
  await mkdir(state.stateBase, { recursive: true });
  const lockPath = path.join(state.stateBase, '.AeMcpNative.install.lock');
  const lockTemp = path.join(
    state.stateBase,
    '..AeMcpNative.install.lock.tmp-1005-eeeeeeeeeeee',
  );
  const oldOwner = {
    pid: 999999,
    createdAt: '2026-07-14T00:00:00.000Z',
    nonce: 'f'.repeat(32),
  };
  await writeFile(lockPath, `${JSON.stringify(oldOwner)}\n`, 'utf8');
  await link(lockPath, lockTemp);
  const [lockBefore, aliasBefore] = await Promise.all([lstat(lockPath), lstat(lockTemp)]);
  assert.equal(lockBefore.ino, aliasBefore.ino);
  assert.equal(lockBefore.nlink, 2);
  const checkedPids = [];

  const recovered = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({
      isProcessAlive: (pid) => {
        checkedPids.push(pid);
        return false;
      },
    }),
  });
  assert.equal(recovered.currentTransactionId, null);
  assert.deepEqual(checkedPids, [999999]);
  await assert.rejects(lstat(lockTemp), { code: 'ENOENT' });
  await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
  const staleNames = (await readdir(state.stateBase))
    .filter((name) => name.startsWith('.AeMcpNative.stale-lock.'));
  assert.equal(staleNames.length, 1);
  const stalePath = path.join(state.stateBase, staleNames[0]);
  assert.equal((await lstat(stalePath)).nlink, 1);
  assert.deepEqual(JSON.parse(await readFile(stalePath, 'utf8')), oldOwner);
  await assertScanRootExactly(state, false);
});

test('migration refuses a live legacy in-scan installer lock', async (t) => {
  const state = await fixture(t);
  await prepareLegacyUpgrade(state, 'legacy-live-lock');
  await writeFile(
    path.join(state.namespace, '.AeMcpNative.install.lock'),
    `${JSON.stringify({ pid: 424242, createdAt: '2026-07-14T00:00:00.000Z' })}\n`,
    'utf8',
  );
  const checkedPids = [];

  await assert.rejects(
    recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies({
        isProcessAlive: (pid) => {
          checkedPids.push(pid);
          return true;
        },
      }),
    }),
    { code: 'AE_PLUGIN_INSTALL_LOCKED' },
  );
  assert.deepEqual(checkedPids, [424242]);
  assert.equal(
    (await deploymentNames(state.namespace)).includes('.AeMcpNative.install.lock'),
    true,
  );
});

test('migration rotates a dead legacy in-scan installer lock before recovery', async (t) => {
  const state = await fixture(t);
  await prepareLegacyUpgrade(state, 'legacy-dead-lock');
  await writeFile(
    path.join(state.namespace, '.AeMcpNative.install.lock'),
    `${JSON.stringify({ pid: 424242, createdAt: '2026-07-14T00:00:00.000Z' })}\n`,
    'utf8',
  );
  const checkedPids = [];

  const recovered = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({
      isProcessAlive: (pid) => {
        checkedPids.push(pid);
        return false;
      },
    }),
  });
  assert.equal(recovered.migratedLegacyState, true);
  assert.deepEqual(checkedPids, [424242, 424242]);
  const [stateBaseNames, stateStoreNames] = await Promise.all([
    readdir(state.stateBase),
    readdir(state.stateStore),
  ]);
  assert.equal(stateBaseNames.includes('.AeMcpNative.install.lock'), false);
  assert.equal(stateStoreNames.includes('.AeMcpNative.install.lock'), false);
  assert.ok(
    [...stateBaseNames, ...stateStoreNames]
      .some((name) => name.startsWith('.AeMcpNative.stale-lock.')),
  );
  await assertScanRootExactly(state, true);
});

test('installer rejects a symbolic target and an extra loadable bundle', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.root, 'build-one', 'one');
  await mkdir(state.namespace, { recursive: true });
  await symlink(state.root, state.target, 'dir');
  await assert.rejects(
    installDevMacPlugin({
      artifactDir,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_EXISTING_TARGET_INVALID' },
  );
  await rm(state.target);
  await mkdir(path.join(state.namespace, 'Unexpected.plugin'));
  await assert.rejects(
    installDevMacPlugin({
      artifactDir,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_INSTALL_STATE_INVALID' },
  );
});

test('installer rejects a source artifact nested in the deployment namespace', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.namespace, 'nested-source', 'one');
  await assert.rejects(
    installDevMacPlugin({
      artifactDir,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_ARTIFACT_INVALID' },
  );
});

test('installer rejects a source artifact nested in the installer state store', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.stateStore, 'nested-source', 'one');
  await assert.rejects(
    installDevMacPlugin({
      artifactDir,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_ARTIFACT_INVALID' },
  );
});

test('installer rejects a source artifact that contains the deployment namespace', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.root, 'MediaCore', 'one');
  assert.equal(artifactDir, state.mediaCoreRoot);
  await assert.rejects(
    installDevMacPlugin({
      artifactDir,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_ARTIFACT_INVALID' },
  );
});

test('installer rejects a source artifact that contains the installer state store', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.root, '.ae-mcp-native-state-v1', 'one');
  assert.equal(artifactDir, state.stateBase);
  await assert.rejects(
    installDevMacPlugin({
      artifactDir,
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_ARTIFACT_INVALID' },
  );
});

test('installer rejects state storage inside the Adobe scan root', async (t) => {
  const state = await fixture(t);
  const artifactDir = await makeArtifact(state.root, 'unsafe-state-root', 'one');
  await assert.rejects(
    installDevMacPlugin({
      artifactDir,
      mediaCoreRoot: state.mediaCoreRoot,
      stateBaseRoot: path.join(state.mediaCoreRoot, 'unsafe-state'),
      dependencies: dependencies(),
    }),
    { code: 'AE_PLUGIN_INSTALL_ROOT_UNSAFE' },
  );
});

test('production CLI exposes no target override and returns structured errors', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [installerPath, 'install', '--target', '/tmp/escape']),
    (error) => {
      const response = JSON.parse(error.stderr);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'AE_PLUGIN_ARGUMENT_INVALID');
      assert.doesNotMatch(response.error.message, /--target/u);
      return true;
    },
  );
});
