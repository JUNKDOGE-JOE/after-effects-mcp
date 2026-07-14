import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
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
    fileCount: 4,
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

function dependencies({
  gate = async () => {},
  isProcessAlive = () => true,
  onTransition = () => {},
  renameBundle = rename,
  transactionId = TX1,
  verifyCalls = [],
} = {}) {
  return {
    assertAeStopped: gate,
    isProcessAlive,
    now: () => new Date('2026-07-14T00:00:00.000Z'),
    onTransition,
    platform: 'darwin',
    randomUUID: () => transactionId,
    renameBundle,
    verifyBundle: fakeVerifier(verifyCalls),
  };
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

async function payloadAt(bundle) {
  return readFile(path.join(bundle, 'payload.txt'), 'utf8');
}

async function loadableNames(namespace) {
  return (await readdir(namespace)).filter((name) => name.endsWith('.plugin'));
}

test('fresh install is receipt-bound, double-gated, and rolls back without deleting evidence', async (t) => {
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
  assert.equal(gateCalls, 2);
  assert.equal(installed.transactionId, TX1);
  assert.equal(installed.previous.present, false);
  assert.equal(await payloadAt(state.target), 'one');
  assert.deepEqual(await loadableNames(state.namespace), ['AeMcpNative.plugin']);
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
  assert.ok((await readdir(state.namespace)).includes(
    `.AeMcpNative.replaced.${TX1}.disabled`,
  ));

  const again = await rollbackDevMacPlugin({
    transactionId: TX1,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(again.alreadyRolledBack, true);
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
    await payloadAt(path.join(state.namespace, upgraded.previous.backupName)),
    'one',
  );
  assert.deepEqual(await loadableNames(state.namespace), ['AeMcpNative.plugin']);

  const result = await rollbackDevMacPlugin({
    transactionId: TX2,
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies(),
  });
  assert.equal(result.restoredPrevious, true);
  assert.equal(await payloadAt(state.target), 'one');
});

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
  assert.deepEqual(await loadableNames(state.namespace), ['AeMcpNative.plugin']);
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
  assert.equal((await readdir(state.namespace)).some((name) => name.includes('.stage.')), false);
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
    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0].transactionId, TX2);
    assert.equal(recovered.recovered[0].to, 'failed_rolled_back');
    assert.equal(await payloadAt(state.target), 'one');
    assert.deepEqual(await loadableNames(state.namespace), ['AeMcpNative.plugin']);
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
    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.recovered.length, 1);
    assert.equal(recovered.recovered[0].to, 'committed');
    assert.equal(await payloadAt(state.target), 'two');
    assert.deepEqual(await loadableNames(state.namespace), ['AeMcpNative.plugin']);
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
    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.recovered[0].to, 'failed_rolled_back');
    assert.equal(recovered.currentTransactionId, TX1);
    assert.equal(await payloadAt(state.target), 'same');
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
    const recovered = await recoverDevMacPlugin({
      mediaCoreRoot: state.mediaCoreRoot,
      dependencies: dependencies(),
    });
    assert.equal(recovered.recovered[0].to, 'committed');
    assert.equal(recovered.currentTransactionId, TX2);
    assert.equal(await payloadAt(state.target), 'same');
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
    path.join(state.namespace, '.AeMcpNative.current.json'),
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
    path.join(state.namespace, '.AeMcpNative.current.json'),
    'utf8',
  ));
  assert.equal(current.transactionId, TX1);
});

test('recover rotates a lock owned by a dead process before reconciling state', async (t) => {
  const state = await fixture(t);
  await mkdir(state.namespace, { recursive: true });
  await writeFile(
    path.join(state.namespace, '.AeMcpNative.install.lock'),
    `${JSON.stringify({ pid: 999999, createdAt: '2026-07-14T00:00:00.000Z' })}\n`,
    'utf8',
  );
  const result = await recoverDevMacPlugin({
    mediaCoreRoot: state.mediaCoreRoot,
    dependencies: dependencies({ isProcessAlive: () => false }),
  });
  assert.deepEqual(result.recovered, []);
  assert.ok((await readdir(state.namespace)).some((name) => name.includes('.stale-lock.')));
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
