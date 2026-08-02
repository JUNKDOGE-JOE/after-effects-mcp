import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  installDevWindowsAex,
  removeDevWindowsAex,
} from '../../../native/ae-plugin/install-dev-windows.mjs';

const WINDOWS_RUNTIME = Object.freeze({
  platform: 'win32',
  architecture: 'x64',
});
const SOURCE_COMMIT = 'a'.repeat(40);
const PRODUCT_VERSION = '0.9.2';

async function makeFixture(t) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'ae-mcp-install-windows-'),
  );
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));
  const artifactDirectory = path.join(root, 'build');
  const pluginsRoot = path.join(
    root,
    'Adobe After Effects 2025',
    'Support Files',
    'Plug-ins',
    'Extensions',
  );
  await fs.promises.mkdir(artifactDirectory, { recursive: true });
  await fs.promises.mkdir(pluginsRoot, { recursive: true });
  const artifactPath = path.join(artifactDirectory, 'AeMcpNative.aex');
  const artifactBytes = Buffer.alloc(2048, 0x5a);
  await fs.promises.writeFile(artifactPath, artifactBytes);
  const artifactSha256 = crypto.createHash('sha256').update(artifactBytes).digest('hex');
  const buildReceiptPath = path.join(artifactDirectory, 'build-receipt.json');
  const verifierReceipt = {
    schemaVersion: 1,
    artifact: 'AeMcpNative.aex',
    artifactSha256,
    bytes: artifactBytes.length,
    architecture: 'x64',
    entryExport: 'AeMcpNativeMain',
    resources: ['PiPL/16000', 'VERSION/1'],
    sourceCommit: SOURCE_COMMIT,
    productVersion: PRODUCT_VERSION,
  };
  const buildReceipt = {
    schemaVersion: 1,
    artifact: {
      path: artifactPath,
      fileName: 'AeMcpNative.aex',
      bytes: artifactBytes.length,
      sha256: artifactSha256,
      architecture: 'x64',
      entryExport: 'AeMcpNativeMain',
      resources: ['PiPL/16000', 'VERSION/1'],
    },
    productVersion: PRODUCT_VERSION,
    sourceCommit: SOURCE_COMMIT,
    source: { commit: SOURCE_COMMIT, repositoryClean: true },
    verification: {
      result: 'PASS',
      sourceCommit: SOURCE_COMMIT,
      productVersion: PRODUCT_VERSION,
      expectedSourceCommit: SOURCE_COMMIT,
      expectedProductVersion: PRODUCT_VERSION,
      receipt: verifierReceipt,
    },
  };
  await fs.promises.writeFile(
    buildReceiptPath,
    `${JSON.stringify(buildReceipt, null, 2)}\n`,
  );
  return {
    root,
    artifactDirectory,
    artifactPath,
    artifactBytes,
    artifactSha256,
    buildReceiptPath,
    buildReceipt,
    verifierReceipt,
    pluginsRoot,
    installedPath: path.join(pluginsRoot, 'AeMcpNative.aex'),
    receiptPath: path.join(artifactDirectory, 'install-receipt.json'),
  };
}

function strictVerifier(fixture, overrides = {}) {
  return async (input) => {
    assert.equal(
      path.resolve(input.artifactPath).toLowerCase(),
      path.resolve(fixture.artifactPath).toLowerCase(),
    );
    assert.equal(input.expectedCommit, SOURCE_COMMIT);
    assert.equal(input.expectedProductVersion, PRODUCT_VERSION);
    return {
      result: 'PASS',
      artifactSha256: fixture.artifactSha256,
      bytes: fixture.artifactBytes.length,
      architecture: 'x64',
      entryExport: 'AeMcpNativeMain',
      sourceCommit: SOURCE_COMMIT,
      productVersion: PRODUCT_VERSION,
      receipt: fixture.verifierReceipt,
      ...overrides,
    };
  };
}

function runtimeFor(fixture, overrides = {}) {
  return {
    ...WINDOWS_RUNTIME,
    verifyWindowsAex: strictVerifier(fixture),
    ...overrides,
  };
}

async function rewriteBuildReceipt(fixture, mutate) {
  const value = structuredClone(fixture.buildReceipt);
  mutate(value);
  await fs.promises.writeFile(
    fixture.buildReceiptPath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function runtimeFailing(fixture, method, shouldFail) {
  let failed = false;
  const promises = new Proxy(fs.promises, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property !== method) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args) => {
        if (!failed && shouldFail(...args)) {
          failed = true;
          throw new Error(`injected ${method} failure`);
        }
        return value.apply(target, args);
      };
    },
  });
  return runtimeFor(fixture, { promises });
}

async function assertPathMissing(candidate) {
  assert.equal(await fs.promises.lstat(candidate).catch(() => null), null);
}

async function assertNoInstallDebris(fixture) {
  await assertPathMissing(fixture.installedPath);
  await assertPathMissing(fixture.receiptPath);
  assert.deepEqual(await fs.promises.readdir(fixture.pluginsRoot), []);
  assert.deepEqual(
    await fs.promises.readdir(fixture.artifactDirectory),
    ['AeMcpNative.aex', 'build-receipt.json'],
  );
}

test('windows dev install requires a strict build and PE identity chain', async (t) => {
  await t.test('build receipt is explicit and mandatory', async (subtest) => {
    const fixture = await makeFixture(subtest);
    await assert.rejects(
      installDevWindowsAex(
        { artifactPath: fixture.artifactPath, pluginsRoot: fixture.pluginsRoot },
        runtimeFor(fixture),
      ),
      (error) => error.code === 'AE_PLUGIN_ARGUMENT_INVALID',
    );
    await assertNoInstallDebris(fixture);
  });

  await t.test('default verifier rejects a hash-bound non-PE artifact', async (subtest) => {
    const fixture = await makeFixture(subtest);
    await assert.rejects(
      installDevWindowsAex(
        {
          artifactPath: fixture.artifactPath,
          buildReceiptPath: fixture.buildReceiptPath,
          pluginsRoot: fixture.pluginsRoot,
        },
        WINDOWS_RUNTIME,
      ),
      (error) => error.code === 'AE_PLUGIN_VERIFY_FAILED',
    );
    await assertNoInstallDebris(fixture);
  });

  await t.test('build receipt must remain bounded', async (subtest) => {
    const fixture = await makeFixture(subtest);
    await fs.promises.writeFile(fixture.buildReceiptPath, Buffer.alloc(256 * 1024 + 1));
    await assert.rejects(
      installDevWindowsAex(
        {
          artifactPath: fixture.artifactPath,
          buildReceiptPath: fixture.buildReceiptPath,
          pluginsRoot: fixture.pluginsRoot,
        },
        runtimeFor(fixture),
      ),
      (error) => error.code === 'AE_PLUGIN_RECEIPT_INVALID',
    );
    await assertNoInstallDebris(fixture);
  });

  const receiptCases = [
    [
      'artifact path',
      (value) => { value.artifact.path = path.join(path.dirname(value.artifact.path), 'other.aex'); },
    ],
    ['artifact hash', (value) => { value.artifact.sha256 = '0'.repeat(64); }],
    ['artifact size', (value) => { value.artifact.bytes += 1; }],
    ['lowercase source commit', (value) => { value.sourceCommit = 'A'.repeat(40); }],
    ['product version', (value) => { value.productVersion = '01.2.3'; }],
    ['verification result', (value) => { value.verification.result = 'FAIL'; }],
    [
      'verified source commit',
      (value) => { value.verification.receipt.sourceCommit = 'b'.repeat(40); },
    ],
  ];
  for (const [name, mutate] of receiptCases) {
    await t.test(`rejects mismatched build receipt ${name}`, async (subtest) => {
      const fixture = await makeFixture(subtest);
      await rewriteBuildReceipt(fixture, mutate);
      await assert.rejects(
        installDevWindowsAex(
          {
            artifactPath: fixture.artifactPath,
            buildReceiptPath: fixture.buildReceiptPath,
            pluginsRoot: fixture.pluginsRoot,
          },
          runtimeFor(fixture),
        ),
        (error) => error.code === 'AE_PLUGIN_RECEIPT_MISMATCH',
      );
      await assertNoInstallDebris(fixture);
    });
  }

  await t.test('rejects verifier output that drifts from the receipt', async (subtest) => {
    const fixture = await makeFixture(subtest);
    await assert.rejects(
      installDevWindowsAex(
        {
          artifactPath: fixture.artifactPath,
          buildReceiptPath: fixture.buildReceiptPath,
          pluginsRoot: fixture.pluginsRoot,
        },
        runtimeFor(fixture, {
          verifyWindowsAex: strictVerifier(fixture, { sourceCommit: 'b'.repeat(40) }),
        }),
      ),
      (error) => error.code === 'AE_PLUGIN_RECEIPT_MISMATCH',
    );
    await assertNoInstallDebris(fixture);
  });
});

test('windows dev install requires an existing per-app Extensions root', async (t) => {
  const fixture = await makeFixture(t);
  await assert.rejects(
    installDevWindowsAex(
      {
        artifactPath: fixture.artifactPath,
        buildReceiptPath: fixture.buildReceiptPath,
      },
      runtimeFor(fixture),
    ),
    (error) => error.code === 'AE_PLUGIN_ARGUMENT_INVALID',
  );

  const wrongRoot = path.join(fixture.root, 'MediaCore');
  await fs.promises.mkdir(wrongRoot);
  await assert.rejects(
    installDevWindowsAex(
      {
        artifactPath: fixture.artifactPath,
        buildReceiptPath: fixture.buildReceiptPath,
        pluginsRoot: wrongRoot,
      },
      runtimeFor(fixture),
    ),
    (error) => error.code === 'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
  );
  await assertNoInstallDebris(fixture);
});

test('windows dev install preflights existing targets and receipt conflicts', async (t) => {
  await t.test('existing target remains byte-for-byte unchanged', async (subtest) => {
    const fixture = await makeFixture(subtest);
    const existing = Buffer.alloc(1536, 0x31);
    await fs.promises.writeFile(fixture.installedPath, existing);
    await assert.rejects(
      installDevWindowsAex(
        {
          artifactPath: fixture.artifactPath,
          buildReceiptPath: fixture.buildReceiptPath,
          pluginsRoot: fixture.pluginsRoot,
        },
        runtimeFor(fixture),
      ),
      (error) => error.code === 'AE_PLUGIN_INSTALL_CONFLICT',
    );
    assert.deepEqual(await fs.promises.readFile(fixture.installedPath), existing);
    await assertPathMissing(fixture.receiptPath);
    assert.deepEqual(await fs.promises.readdir(fixture.pluginsRoot), [
      'AeMcpNative.aex',
    ]);
  });

  await t.test('existing receipt remains byte-for-byte unchanged', async (subtest) => {
    const fixture = await makeFixture(subtest);
    const existing = Buffer.from('existing receipt');
    await fs.promises.writeFile(fixture.receiptPath, existing);
    await assert.rejects(
      installDevWindowsAex(
        {
          artifactPath: fixture.artifactPath,
          buildReceiptPath: fixture.buildReceiptPath,
          pluginsRoot: fixture.pluginsRoot,
        },
        runtimeFor(fixture),
      ),
      (error) => error.code === 'AE_PLUGIN_INSTALL_CONFLICT',
    );
    assert.deepEqual(await fs.promises.readFile(fixture.receiptPath), existing);
    await assertPathMissing(fixture.installedPath);
    assert.deepEqual(await fs.promises.readdir(fixture.pluginsRoot), []);
  });
});

test('windows dev install rolls back every owned path after injected failures', async (t) => {
  const cases = [
    {
      name: 'source hash preflight',
      method: 'readFile',
      fails: (candidate) => path.basename(candidate) === 'AeMcpNative.aex',
    },
    {
      name: 'stage hash',
      method: 'readFile',
      fails: (candidate) => path.basename(candidate).startsWith('.AeMcpNative.aex.stage-'),
    },
    {
      name: 'artifact rename',
      method: 'rename',
      fails: (_source, destination) => path.basename(destination) === 'AeMcpNative.aex',
    },
    {
      name: 'receipt write',
      method: 'writeFile',
      fails: (candidate) => path.basename(candidate).startsWith('.install-receipt.json.stage-'),
    },
    {
      name: 'receipt rename',
      method: 'rename',
      fails: (_source, destination) => path.basename(destination) === 'install-receipt.json',
    },
  ];

  for (const row of cases) {
    await t.test(row.name, async (subtest) => {
      const fixture = await makeFixture(subtest);
      await assert.rejects(
        installDevWindowsAex(
          {
            artifactPath: fixture.artifactPath,
            buildReceiptPath: fixture.buildReceiptPath,
            pluginsRoot: fixture.pluginsRoot,
          },
          runtimeFailing(fixture, row.method, row.fails),
        ),
        (error) => error.code === 'AE_PLUGIN_INSTALL_FAILED',
      );
      await assertNoInstallDebris(fixture);
    });
  }
});

test('windows dev install records topology and remove is hash-bound', async (t) => {
  await t.test('successful install and remove leave no managed files', async (subtest) => {
    const fixture = await makeFixture(subtest);
    const result = await installDevWindowsAex(
      {
        artifactPath: fixture.artifactPath,
        buildReceiptPath: fixture.buildReceiptPath,
        pluginsRoot: fixture.pluginsRoot,
      },
      runtimeFor(fixture),
    );
    const receipt = JSON.parse(await fs.promises.readFile(result.receipt, 'utf8'));
    assert.deepEqual(receipt.topology, {
      kind: 'windows-after-effects-per-app-extensions',
      pluginsRoot: fixture.pluginsRoot,
      artifactName: 'AeMcpNative.aex',
    });
    assert.equal(receipt.sourceCommit, SOURCE_COMMIT);
    assert.equal(receipt.productVersion, PRODUCT_VERSION);
    assert.equal(receipt.buildReceipt.path, fixture.buildReceiptPath);
    assert.equal(
      receipt.buildReceipt.sha256,
      crypto.createHash('sha256').update(
        await fs.promises.readFile(fixture.buildReceiptPath),
      ).digest('hex'),
    );
    assert.equal(receipt.installed.path, fixture.installedPath);
    assert.equal(
      receipt.installed.sha256,
      crypto.createHash('sha256').update(fixture.artifactBytes).digest('hex'),
    );
    assert.deepEqual(await fs.promises.readdir(fixture.pluginsRoot), [
      'AeMcpNative.aex',
    ]);

    assert.deepEqual(
      await removeDevWindowsAex({ receiptPath: result.receipt }, WINDOWS_RUNTIME),
      { removed: true },
    );
    await assertNoInstallDebris(fixture);
  });

  await t.test('changed installed bytes preserve the artifact and receipt', async (subtest) => {
    const fixture = await makeFixture(subtest);
    const result = await installDevWindowsAex(
      {
        artifactPath: fixture.artifactPath,
        buildReceiptPath: fixture.buildReceiptPath,
        pluginsRoot: fixture.pluginsRoot,
      },
      runtimeFor(fixture),
    );
    await fs.promises.appendFile(result.installedPath, Buffer.from('changed'));
    await assert.rejects(
      removeDevWindowsAex({ receiptPath: result.receipt }, WINDOWS_RUNTIME),
      (error) => error.code === 'AE_PLUGIN_INSTALL_HASH_MISMATCH',
    );
    assert.ok(await fs.promises.lstat(result.installedPath));
    assert.ok(await fs.promises.lstat(result.receipt));
  });

  await t.test('receipt cannot redirect removal outside its topology', async (subtest) => {
    const fixture = await makeFixture(subtest);
    const result = await installDevWindowsAex(
      {
        artifactPath: fixture.artifactPath,
        buildReceiptPath: fixture.buildReceiptPath,
        pluginsRoot: fixture.pluginsRoot,
      },
      runtimeFor(fixture),
    );
    const victim = path.join(fixture.root, 'victim.aex');
    await fs.promises.writeFile(victim, Buffer.alloc(2048, 0x44));
    const receipt = JSON.parse(await fs.promises.readFile(result.receipt, 'utf8'));
    receipt.installed.path = victim;
    await fs.promises.writeFile(
      result.receipt,
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    await assert.rejects(
      removeDevWindowsAex({ receiptPath: result.receipt }, WINDOWS_RUNTIME),
      (error) => error.code === 'AE_PLUGIN_INSTALL_TOPOLOGY_INVALID',
    );
    assert.ok(await fs.promises.lstat(victim));
    assert.ok(await fs.promises.lstat(result.installedPath));
  });
});

test('windows dev installer CLI has no implicit MediaCore target', async () => {
  const script = await fs.promises.readFile(
    'native/ae-plugin/install-dev-windows.mjs',
    'utf8',
  );
  assert.match(
    script,
    /install --artifact <absolute-path> --build-receipt <absolute-path>/u,
  );
  assert.match(script, /--plugins-root <absolute-path>/u);
  assert.doesNotMatch(script, /defaultPluginsRoot|MediaCore|\[--plugins-root/u);
});
