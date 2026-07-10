import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SHA256 = 'a'.repeat(64);

async function writeJson(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeFile(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, value);
}

async function makeInventoryFixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-runtime-inventory-'));
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));
  const repoRoot = path.join(root, 'repo');
  const runtimeRoot = path.join(root, 'runtime');

  await writeJson(path.join(repoRoot, 'packaging/support-matrix.json'), {
    schemaVersion: 1,
    platforms: {
      'macos-arm64': { minOsVersion: '14.0', arch: 'arm64', rosetta: false },
      'windows-x64': { minOsVersion: '11.0.26100', arch: 'x64' },
    },
    afterEffects: { majors: [25, 26], manifestRange: '[25.0,26.9]' },
  });
  await writeJson(path.join(repoRoot, 'packaging/runtime-lock.json'), {
    schemaVersion: 1,
    node: {
      version: '24.17.0',
      headers: { url: 'https://example.invalid/headers.tgz', sha256: SHA256 },
      assets: {
        'macos-arm64': { url: 'https://example.invalid/node-mac.tgz', sha256: SHA256 },
        'windows-x64': { url: 'https://example.invalid/node-win.zip', sha256: SHA256 },
      },
    },
    python: {
      version: '3.13.14',
      distributionRelease: '20260610',
      assets: {
        'macos-arm64': { url: 'https://example.invalid/python-mac.tgz', sha256: SHA256 },
        'windows-x64': { url: 'https://example.invalid/python-win.tgz', sha256: SHA256 },
      },
    },
  });
  await writeJson(path.join(repoRoot, 'packaging/license-policy.json'), {
    schemaVersion: 1,
    forbidden: ['UNKNOWN'],
    restrictedLicenseRefs: ['LicenseRef-Proprietary'],
    classifications: {
      'npm:@vendor/proprietary-runtime': 'LicenseRef-Proprietary',
      'python:no-license-metadata': 'Apache-2.0',
    },
  });
  await writeFile(path.join(repoRoot, 'uv.lock'), [
    'version = 1',
    '[[package]]',
    'name = "no-license-metadata"',
    'version = "1.2.3"',
    'source = { registry = "https://pypi.org/simple" }',
    '',
  ].join('\n'));

  await writeJson(path.join(repoRoot, 'plugin/host/package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { 'demo-package': '1.0.0' } },
      'node_modules/demo-package': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/demo-package/-/demo-package-1.0.0.tgz',
        integrity: 'sha512-fixture',
        license: 'MIT',
      },
    },
  });
  await writeJson(path.join(repoRoot, 'plugin/sidecar/package-lock.json'), {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@vendor/proprietary-runtime': '2.0.0' } },
      'node_modules/@vendor/proprietary-runtime': {
        version: '2.0.0',
        resolved: 'https://registry.npmjs.org/@vendor/proprietary-runtime/-/proprietary-runtime-2.0.0.tgz',
        integrity: 'sha512-fixture',
        license: 'SEE LICENSE IN LICENSE.md',
      },
    },
  });

  await writeJson(path.join(runtimeRoot, 'node/host/node_modules/demo-package/package.json'), {
    name: 'demo-package', version: '1.0.0', license: 'MIT',
  });
  await writeFile(path.join(runtimeRoot, 'node/host/node_modules/demo-package/index.js'), 'export default 1;\n');
  await writeJson(
    path.join(runtimeRoot, 'node/sidecar/node_modules/@vendor/proprietary-runtime/package.json'),
    { name: '@vendor/proprietary-runtime', version: '2.0.0', license: 'SEE LICENSE IN LICENSE.md' },
  );
  await writeFile(
    path.join(runtimeRoot, 'node/sidecar/node_modules/@vendor/proprietary-runtime/index.js'),
    'export default 2;\n',
  );

  const sitePackages = path.join(runtimeRoot, 'python/lib/python3.13/site-packages');
  const distInfo = path.join(sitePackages, 'no_license_metadata-1.2.3.dist-info');
  await writeFile(path.join(sitePackages, 'no_license_metadata/__init__.py'), '__version__ = "1.2.3"\n');
  await writeFile(path.join(distInfo, 'METADATA'), [
    'Metadata-Version: 2.3',
    'Name: no-license-metadata',
    'Version: 1.2.3',
    '',
  ].join('\n'));
  await writeFile(path.join(distInfo, 'RECORD'), [
    'no_license_metadata/__init__.py,,',
    'no_license_metadata-1.2.3.dist-info/METADATA,,',
    'no_license_metadata-1.2.3.dist-info/RECORD,,',
    '',
  ].join('\n'));

  for (const wheel of [
    'ae_mcp-0.9.0-py3-none-any.whl',
    'ae_mcp_bridge-0.9.0-py3-none-any.whl',
    'ae_mcp_snapshot_mss-0.9.0-py3-none-any.whl',
  ]) {
    await writeFile(path.join(runtimeRoot, 'wheels', wheel), `fixture:${wheel}\n`);
  }

  return {
    repoRoot,
    runtimeRoot,
    approvalPath: path.join(root, 'external-legal-approval.json'),
    restrictedPackageDir: path.join(
      runtimeRoot,
      'node/sidecar/node_modules/@vendor/proprietary-runtime',
    ),
  };
}

async function writeExactApproval(fixture, overrides = {}) {
  const { sha256Directory } = await import('../lib/files.mjs');
  const approval = {
    package: '@vendor/proprietary-runtime',
    version: '2.0.0',
    sourceSha256: await sha256Directory(fixture.restrictedPackageDir, {
      excludeDirectoryNames: ['node_modules'],
    }),
    licenseRef: 'LicenseRef-Proprietary',
    approvalId: 'LEGAL-TEST-2026-001',
    ...overrides,
  };
  await writeJson(fixture.approvalPath, {
    schemaVersion: 1,
    approvals: [approval],
  });
  return approval;
}

test('runtime inventory records every real component with a known license and SHA-256', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  const approval = await writeExactApproval(fixture);

  const first = await generateRuntimeInventory({
    platform: 'macos-arm64',
    licenseApprovalPath: fixture.approvalPath,
    ...fixture,
  });
  const second = await generateRuntimeInventory({
    platform: 'macos-arm64',
    licenseApprovalPath: fixture.approvalPath,
    ...fixture,
  });

  assert.deepEqual(second, first, 'inventory must be deterministic');
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.platform, 'macos-arm64');
  assert.equal(first.node.version, '24.17.0');
  assert.equal(first.python.version, '3.13.14');
  assert.equal(first.python.distributionRelease, '20260610');
  assert.deepEqual(first.licenseApprovals, [approval]);
  assert.ok(first.components.length >= 7);

  for (const component of first.components) {
    assert.deepEqual(Object.keys(component).sort(), ['license', 'name', 'sha256', 'source', 'version']);
    assert.ok(component.name);
    assert.ok(component.version);
    assert.ok(component.license);
    assert.notEqual(component.license, 'UNKNOWN');
    assert.ok(component.source);
    assert.match(component.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(
    first.components.find(({ name }) => name === 'npm:@vendor/proprietary-runtime').license,
    'LicenseRef-Proprietary',
  );
  assert.equal(
    first.components.find(({ name }) => name === 'python:no-license-metadata').license,
    'Apache-2.0',
  );
  assert.deepEqual(
    JSON.parse(await fs.promises.readFile(path.join(fixture.runtimeRoot, 'runtime-manifest.json'), 'utf8')),
    first,
  );
});

test('restricted SEE LICENSE package fails closed without exact external legal approval', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);

  await assert.rejects(
    generateRuntimeInventory({ platform: 'macos-arm64', ...fixture }),
    /redistribution approval required.*@vendor\/proprietary-runtime/i,
  );
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'runtime-manifest.json')), false);
});

test('restricted approval rejects source digest or version drift', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);

  await writeExactApproval(fixture, { sourceSha256: '0'.repeat(64) });
  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /approval does not match.*sourceSha256/i,
  );

  await writeExactApproval(fixture, { version: '2.0.1' });
  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /approval does not match.*version/i,
  );
});

test('runtime inventory rejects installed packages absent from frozen locks', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  await writeJson(path.join(
    fixture.runtimeRoot,
    'node/host/node_modules/unlocked/package.json',
  ), { name: 'unlocked', version: '9.9.9', license: 'MIT' });

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /not present in plugin\/host\/package-lock\.json/i,
  );
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'runtime-manifest.json')), false);
});

test('runtime manifest schema requires complete licensed component records', () => {
  const schema = JSON.parse(
    fs.readFileSync('packaging/schemas/runtime-manifest.schema.json', 'utf8'),
  );
  const required = schema.properties.components.items.required;
  assert.deepEqual(required, ['name', 'version', 'license', 'source', 'sha256']);
  assert.equal(schema.properties.components.items.properties.license.not.const, 'UNKNOWN');
  assert.deepEqual(
    schema.properties.licenseApprovals.items.required,
    ['package', 'version', 'sourceSha256', 'licenseRef', 'approvalId'],
  );
});

test('license policy explicitly forbids UNKNOWN', () => {
  const policy = JSON.parse(fs.readFileSync('packaging/license-policy.json', 'utf8'));
  assert.equal(policy.schemaVersion, 1);
  assert.ok(policy.forbidden.includes('UNKNOWN'));
  assert.ok(policy.restrictedLicenseRefs.includes('LicenseRef-Anthropic-Commercial'));
  assert.equal(
    policy.classifications['npm:@anthropic-ai/claude-agent-sdk'],
    'LicenseRef-Anthropic-Commercial',
  );
  assert.ok(Object.values(policy.classifications).every((license) => license !== 'UNKNOWN'));
});
