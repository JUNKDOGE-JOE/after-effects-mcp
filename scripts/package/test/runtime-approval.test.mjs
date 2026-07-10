import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as inventory from '../generate-runtime-inventory.mjs';

const SHA256 = 'a'.repeat(64);

async function writeJson(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function exactApproval(overrides = {}) {
  return {
    package: 'restricted-python',
    version: '1.2.3',
    sourceSha256: SHA256,
    licenseRef: 'LicenseRef-Proprietary',
    approvalId: 'LEGAL-TEST-2026-001',
    ...overrides,
  };
}

function approvalPolicy(trustedApprovals = []) {
  return {
    trustedApprovals,
  };
}

async function writeApprovalDocument(t, approvals) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-approval-'));
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));
  const approvalPath = path.join(root, 'approval.json');
  await writeJson(approvalPath, { schemaVersion: 1, approvals });
  return approvalPath;
}

test('approval records require exactly five non-empty string fields', async (t) => {
  assert.equal(typeof inventory.loadApprovals, 'function');

  for (const field of ['package', 'version', 'sourceSha256', 'licenseRef', 'approvalId']) {
    for (const invalid of ['', '   ', [], 42, false, null, {}]) {
      const approval = exactApproval({ [field]: invalid });
      const approvalPath = await writeApprovalDocument(t, [approval]);
      await assert.rejects(
        inventory.loadApprovals(approvalPath, approvalPolicy([approval])),
        new RegExp(`${field}.*non-empty string`, 'i'),
      );
    }
  }
});

test('approval sourceSha256 is exact lowercase SHA-256 text', async (t) => {
  assert.equal(typeof inventory.loadApprovals, 'function');

  for (const sourceSha256 of [SHA256.toUpperCase(), ` ${SHA256}`, `${SHA256} `, 'a'.repeat(63)]) {
    const approval = exactApproval({ sourceSha256 });
    const approvalPath = await writeApprovalDocument(t, [approval]);
    await assert.rejects(
      inventory.loadApprovals(approvalPath, approvalPolicy([approval])),
      /invalid approval sourceSha256/i,
    );
  }
});

test('trusted approval identity cannot collide between array and string fields', async (t) => {
  assert.equal(typeof inventory.loadApprovals, 'function');

  const external = exactApproval({ package: 'restricted,python' });
  const forgedTrusted = exactApproval({ package: ['restricted', 'python'] });
  const approvalPath = await writeApprovalDocument(t, [external]);
  await assert.rejects(
    inventory.loadApprovals(approvalPath, approvalPolicy([forgedTrusted])),
    /package.*non-empty string/i,
  );
});

test('repository trusted approvals are validated without an external selector document', async () => {
  assert.equal(typeof inventory.loadApprovals, 'function');

  const forgedTrusted = exactApproval({ package: ['restricted', 'python'] });
  await assert.rejects(
    inventory.loadApprovals(undefined, approvalPolicy([forgedTrusted])),
    /package.*non-empty string/i,
  );
});

test('trusted approval identity preserves exact field boundaries', async (t) => {
  assert.equal(typeof inventory.loadApprovals, 'function');

  const external = exactApproval({ package: 'restricted', version: 'python\u00001.2.3' });
  const trusted = exactApproval({ package: 'restricted\u0000python', version: '1.2.3' });
  const approvalPath = await writeApprovalDocument(t, [external]);
  await assert.rejects(
    inventory.loadApprovals(approvalPath, approvalPolicy([trusted])),
    /not trusted by repository allowlist/i,
  );
});

async function makePythonFixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-python-approval-'));
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));
  const repoRoot = path.join(root, 'repo');
  const runtimeRoot = path.join(root, 'runtime');
  const sitePackages = path.join(runtimeRoot, 'python/lib/python3.13/site-packages');
  const packageFile = 'restricted_python/__init__.py';
  const packageContents = '__version__ = "1.2.3"\n';

  await fs.promises.mkdir(path.join(sitePackages, 'restricted-python-1.2.3.dist-info'), {
    recursive: true,
  });
  await fs.promises.mkdir(path.join(sitePackages, 'restricted_python'), { recursive: true });
  await fs.promises.writeFile(path.join(sitePackages, packageFile), packageContents);
  await fs.promises.writeFile(
    path.join(sitePackages, 'restricted-python-1.2.3.dist-info/METADATA'),
    [
      'Metadata-Version: 2.4',
      'Name: restricted-python',
      'Version: 1.2.3',
      'License-Expression: MIT AND LicenseRef-Proprietary',
      '',
    ].join('\n'),
  );
  await fs.promises.writeFile(
    path.join(sitePackages, 'restricted-python-1.2.3.dist-info/RECORD'),
    `${packageFile},,\n`,
  );
  await fs.promises.mkdir(repoRoot, { recursive: true });
  await fs.promises.writeFile(
    path.join(repoRoot, 'uv.lock'),
    [
      'version = 1',
      '[[package]]',
      'name = "restricted-python"',
      'version = "1.2.3"',
      'source = { registry = "https://pypi.org/simple" }',
      '',
    ].join('\n'),
  );

  const fileSha256 = createHash('sha256').update(packageContents).digest('hex');
  const distributionSha256 = createHash('sha256')
    .update(`${packageFile}\0${fileSha256}\n`)
    .digest('hex');
  const policy = {
    forbidden: ['UNKNOWN'],
    allowedSpdxLicenses: ['MIT'],
    allowedSpdxExceptions: [],
    allowedLicenseRefs: ['LicenseRef-Proprietary'],
    restrictedLicenseRefs: ['LicenseRef-Proprietary'],
    reviewedNonRestrictedLicenseRefs: [],
    classifications: {},
  };
  return { repoRoot, runtimeRoot, policy, distributionSha256 };
}

test('compound restricted Python license rejects an inexact source approval', async (t) => {
  assert.equal(typeof inventory.pythonComponents, 'function');
  const fixture = await makePythonFixture(t);
  const inexactApproval = exactApproval({ sourceSha256: SHA256 });

  await assert.rejects(
    inventory.pythonComponents({
      ...fixture,
      platform: 'macos-arm64',
      approvals: [inexactApproval],
      usedApprovals: new Map(),
    }),
    /approval does not match.*restricted-python.*sourceSha256/i,
  );
});

test('compound restricted Python license consumes only an exact trusted approval', async (t) => {
  assert.equal(typeof inventory.pythonComponents, 'function');
  const fixture = await makePythonFixture(t);
  const approval = exactApproval({ sourceSha256: fixture.distributionSha256 });
  fixture.policy.trustedApprovals = [approval];
  const approvalPath = await writeApprovalDocument(t, [approval]);
  const approvals = await inventory.loadApprovals(approvalPath, fixture.policy);
  const usedApprovals = new Map();

  const components = await inventory.pythonComponents({
    ...fixture,
    platform: 'macos-arm64',
    approvals,
    usedApprovals,
  });

  assert.equal(components[0].license, 'MIT AND LicenseRef-Proprietary');
  assert.deepEqual([...usedApprovals.values()], [approval]);
});

test('consumed approvals retain distinct restricted refs sharing one approval id', async (t) => {
  const fixture = await makePythonFixture(t);
  const metadataPath = path.join(
    fixture.runtimeRoot,
    'python/lib/python3.13/site-packages/restricted-python-1.2.3.dist-info/METADATA',
  );
  await fs.promises.writeFile(metadataPath, [
    'Metadata-Version: 2.4',
    'Name: restricted-python',
    'Version: 1.2.3',
    'License-Expression: LicenseRef-Proprietary AND LicenseRef-Second',
    '',
  ].join('\n'));
  fixture.policy.allowedLicenseRefs.push('LicenseRef-Second');
  fixture.policy.restrictedLicenseRefs.push('LicenseRef-Second');
  const approvals = [
    exactApproval({ sourceSha256: fixture.distributionSha256 }),
    exactApproval({
      sourceSha256: fixture.distributionSha256,
      licenseRef: 'LicenseRef-Second',
    }),
  ];
  const usedApprovals = new Map();

  await inventory.pythonComponents({
    ...fixture,
    platform: 'macos-arm64',
    approvals,
    usedApprovals,
  });

  assert.deepEqual([...usedApprovals.values()], approvals);
});
