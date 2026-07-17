import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkPythonStandaloneEvidenceContent,
  CPYTHON_LICENSE_OVERLAY_V1,
  encodePythonStandaloneEvidenceContent,
  TCL_LIBRARY_PATHS_OVERLAY_V1,
} from '../lib/python-standalone-evidence.mjs';
import { canonicalJson } from '../lib/manifest.mjs';

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
  const nodeLicenseText = [
    'Copyright Node.js contributors. MIT License.',
    '',
    'The externally maintained libraries used by Node.js are:',
    '',
    '- Acorn, located at deps/acorn, is licensed as follows:',
    '  """MIT License"""',
    '',
  ].join('\n');
  const nodeLicenseSha256 = createHash('sha256').update(nodeLicenseText).digest('hex');
  const fixtureProcessVersions = { node: '24.17.0', acorn: '8.16.0' };
  const fixtureNotices = [
    {
      package: 'brace-expansion',
      version: '5.0.5',
      bytes: Buffer.from('MIT License\n\nCopyright Brace Fixture\n', 'utf8'),
      archivePath: 'package/LICENSE',
      fileName: 'brace-expansion-5.0.5-LICENSE.txt',
    },
    {
      package: 'balanced-match',
      version: '4.0.4',
      bytes: Buffer.from('MIT License\n\nCopyright Balanced Fixture\n', 'utf8'),
      archivePath: 'package/LICENSE.md',
      fileName: 'balanced-match-4.0.4-LICENSE.txt',
    },
  ].map((notice) => ({
    ...notice,
    sha256: createHash('sha256').update(notice.bytes).digest('hex'),
    sourcePath: `packaging/licenses/node-runtime/${notice.fileName}`,
    payloadPath: `licenses/node-runtime/${notice.fileName}`,
  }));
  const pythonMetadataOrigins = {
    'macos-arm64': {
      url: 'https://example.invalid/python-mac-full.tar.zst',
      sha256: SHA256,
    },
    'windows-x64': {
      url: 'https://example.invalid/python-win-full.tar.zst',
      sha256: SHA256,
    },
  };
  const pythonExpandedMetadata = {
    'macos-arm64': { expandedTarBytes: 1, expandedTarSha256: SHA256 },
    'windows-x64': { expandedTarBytes: 1, expandedTarSha256: SHA256 },
  };
  const pythonJsonBytes = {
    'macos-arm64': Buffer.from(`${JSON.stringify({
      build_options: 'pgo+lto',
      license_path: 'licenses/LICENSE.cpython.txt',
      licenses: ['Python-2.0', 'CNRI-Python'],
      target_triple: 'aarch64-apple-darwin',
      tcl_library_paths: ['itcl4.3.5', 'thread3.0.4', 'tk9.0'],
    })}\n`),
    'windows-x64': Buffer.from(`${JSON.stringify({
      build_options: 'pgo',
      license_path: 'licenses/LICENSE.cpython.txt',
      licenses: ['Python-2.0', 'CNRI-Python'],
      target_triple: 'x86_64-pc-windows-msvc',
      tcl_library_paths: ['dde1.4', 'reg1.3', 'tcl8.6', 'tk8.6', 'tcl8', 'tix8.4.3'],
    })}\n`),
  };
  const pythonLicenseBytes = {
    'macos-arm64': Buffer.from('Composite Python fixture license\n', 'utf8'),
    'windows-x64': Buffer.from('Composite Python fixture license\r\n', 'utf8'),
  };
  const pythonJsonSha256 = Object.fromEntries(Object.entries(pythonJsonBytes).map(
    ([platform, bytes]) => [platform, createHash('sha256').update(bytes).digest('hex')],
  ));
  const pythonLicenseSha256 = Object.fromEntries(Object.entries(pythonLicenseBytes).map(
    ([platform, bytes]) => [platform, createHash('sha256').update(bytes).digest('hex')],
  ));
  const evidenceEntry = ({ platform, kind, memberPath, bytes }) => ({
    platforms: [platform],
    kind,
    origin: pythonMetadataOrigins[platform],
    memberPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    encoding: 'gzip-base64',
    content: chunkPythonStandaloneEvidenceContent(
      encodePythonStandaloneEvidenceContent(bytes),
    ),
  });
  const fixturePythonComponent = (platform, name, version) => ({
    name,
    version,
    relationship: 'CONTAINS',
    disposition: 'payload',
    licenseDeclared: 'Python-2.0',
    source: {
      kind: 'archive',
      url: 'https://example.invalid/Python-3.13.14.tar.xz',
      sha256: SHA256,
    },
    evidenceOrigins: [pythonMetadataOrigins[platform]],
    licenseEvidence: [{
      kind: 'metadata-file',
      path: 'python/licenses/LICENSE.cpython.txt',
      sha256: pythonLicenseSha256[platform],
    }],
  });

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
      sourceAsset: {
        url: 'https://example.invalid/node-v24.17.0.tar.xz',
        sha256: SHA256,
        licenseSha256: nodeLicenseSha256,
      },
      headers: { url: 'https://example.invalid/headers.tgz', sha256: SHA256 },
      assets: {
        'macos-arm64': { url: 'https://example.invalid/node-mac.tgz', sha256: SHA256 },
        'windows-x64': { url: 'https://example.invalid/node-win.zip', sha256: SHA256 },
      },
    },
    python: {
      version: '3.13.14',
      distributionRelease: '20260610',
      releaseCommit: 'f1d7b92301235781d4de2493578773aaa413c0a5',
      assets: {
        'macos-arm64': { url: 'https://example.invalid/python-mac.tgz', sha256: SHA256 },
        'windows-x64': { url: 'https://example.invalid/python-win.tgz', sha256: SHA256 },
      },
      metadataAssets: {
        'macos-arm64': {
          ...pythonMetadataOrigins['macos-arm64'],
          ...pythonExpandedMetadata['macos-arm64'],
          size: 1,
          pythonJsonSha256: pythonJsonSha256['macos-arm64'],
        },
        'windows-x64': {
          ...pythonMetadataOrigins['windows-x64'],
          ...pythonExpandedMetadata['windows-x64'],
          size: 1,
          pythonJsonSha256: pythonJsonSha256['windows-x64'],
        },
      },
    },
  });
  await writeJson(path.join(repoRoot, 'packaging/python-standalone-bom.json'), {
    schemaVersion: 1,
    pythonVersion: '3.13.14',
    distributionRelease: '20260610',
    releaseCommit: 'f1d7b92301235781d4de2493578773aaa413c0a5',
    platforms: {
      'macos-arm64': {
        metadataSource: {
          ...pythonMetadataOrigins['macos-arm64'],
          ...pythonExpandedMetadata['macos-arm64'],
          size: 1,
          targetTriple: 'aarch64-apple-darwin',
          buildOptions: ['pgo', 'lto'],
          pythonJson: {
            path: 'python/PYTHON.json',
            sha256: pythonJsonSha256['macos-arm64'],
          },
        },
        externalSystemDependenciesScope:
          'locked-payload-native-imports-excluding-baseline-loader-libraries',
        externalSystemDependencies: ['libSystem'],
        components: [{
          name: 'cpython',
          version: '3.13.14',
          relationship: 'CONTAINS',
          disposition: 'payload',
          licenseDeclared: 'Python-2.0',
          source: {
            kind: 'archive',
            url: 'https://example.invalid/Python-3.13.14.tar.xz',
            sha256: SHA256,
          },
          evidenceOrigins: [pythonMetadataOrigins['macos-arm64']],
          licenseEvidence: [{
            kind: 'metadata-file',
            path: 'python/licenses/LICENSE.cpython.txt',
            sha256: pythonLicenseSha256['macos-arm64'],
          }],
        },
        fixturePythonComponent('macos-arm64', 'itcl', '4.3.5'),
        fixturePythonComponent('macos-arm64', 'tcl-thread', '3.0.4'),
        fixturePythonComponent('macos-arm64', 'tk', '9.0.3')],
      },
      'windows-x64': {
        metadataSource: {
          ...pythonMetadataOrigins['windows-x64'],
          ...pythonExpandedMetadata['windows-x64'],
          size: 1,
          targetTriple: 'x86_64-pc-windows-msvc',
          buildOptions: ['pgo'],
          pythonJson: {
            path: 'python/PYTHON.json',
            sha256: pythonJsonSha256['windows-x64'],
          },
        },
        externalSystemDependenciesScope:
          'PYTHON.json-declared-system-links-excluding-placeholders-and-baseline-loader-libraries',
        externalSystemDependencies: ['Ws2_32'],
        components: [{
          name: 'cpython',
          version: '3.13.14',
          relationship: 'CONTAINS',
          disposition: 'payload',
          licenseDeclared: 'Python-2.0',
          source: {
            kind: 'archive',
            url: 'https://example.invalid/Python-3.13.14.tar.xz',
            sha256: SHA256,
          },
          evidenceOrigins: [pythonMetadataOrigins['windows-x64']],
          licenseEvidence: [{
            kind: 'metadata-file',
            path: 'python/licenses/LICENSE.cpython.txt',
            sha256: pythonLicenseSha256['windows-x64'],
          }],
        },
        fixturePythonComponent('windows-x64', 'tcl', '8.6.12'),
        fixturePythonComponent('windows-x64', 'tk', '8.6.12'),
        fixturePythonComponent('windows-x64', 'tix', '8.4.3.6')],
      },
    },
  });
  await writeJson(
    path.join(repoRoot, 'packaging/evidence/python-standalone/evidence-bundle.json'),
    {
      schemaVersion: 1,
      format: 'python-standalone-evidence-gzip-base64-v1',
      reviewedOverlays: {
        cpythonLicense: CPYTHON_LICENSE_OVERLAY_V1,
        tclLibraryPaths: TCL_LIBRARY_PATHS_OVERLAY_V1,
        metadataLicensePathExclusions: {
          'macos-arm64': [],
          'windows-x64': [],
        },
      },
      entries: Object.keys(pythonMetadataOrigins).flatMap((platform) => [
        evidenceEntry({
          platform,
          kind: 'python-json',
          memberPath: 'python/PYTHON.json',
          bytes: pythonJsonBytes[platform],
        }),
        evidenceEntry({
          platform,
          kind: 'metadata-file',
          memberPath: 'python/licenses/LICENSE.cpython.txt',
          bytes: pythonLicenseBytes[platform],
        }),
      ]),
    },
  );
  await writeJson(path.join(repoRoot, 'packaging/node-runtime-bom.json'), {
    schemaVersion: 1,
    nodeVersion: '24.17.0',
    sourceAsset: {
      url: 'https://example.invalid/node-v24.17.0.tar.xz',
      sha256: SHA256,
      license: { path: 'LICENSE', sha256: nodeLicenseSha256 },
    },
    platforms: {
      'macos-arm64': {
        licenseFile: { path: 'node/LICENSE', sha256: nodeLicenseSha256 },
        processVersions: fixtureProcessVersions,
        verification: 'verified-native',
      },
      'windows-x64': {
        licenseFile: { path: 'node/LICENSE', sha256: nodeLicenseSha256 },
        processVersions: fixtureProcessVersions,
        verification: 'pending-native',
      },
    },
    licenseNotices: fixtureNotices.map((notice) => ({
      package: notice.package,
      version: notice.version,
      tarball: {
        url: `https://registry.npmjs.org/${notice.package}/-/${notice.package}-${notice.version}.tgz`,
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        sha256: 'b'.repeat(64),
        bytes: 1,
      },
      archivePath: notice.archivePath,
      sourcePath: notice.sourcePath,
      payloadPath: notice.payloadPath,
      sha256: notice.sha256,
    })),
    payloadComponents: [
      {
        name: 'node-core',
        version: '24.17.0',
        relationship: 'CONTAINS',
        disposition: 'payload',
        licenseDeclared: 'MIT',
        sourceSubpath: '.',
        processVersionKey: 'node',
        licenseEvidence: { kind: 'license-preamble' },
      },
      {
        name: 'acorn-and-acorn-walk',
        version: '8.16.0',
        relationship: 'CONTAINS',
        disposition: 'payload',
        licenseDeclared: 'MIT',
        sourceSubpath: 'deps/acorn',
        processVersionKey: 'acorn',
        licenseEvidence: {
          kind: 'license-section',
          heading: 'Acorn',
          sourceSubpath: 'deps/acorn',
        },
      },
      ...fixtureNotices.map((notice) => ({
        name: notice.package,
        version: notice.version,
        relationship: 'CONTAINS',
        disposition: 'payload',
        licenseDeclared: 'MIT',
        sourceSubpath: 'deps/minimatch/index.js',
        licenseEvidence: {
          kind: 'payload-file',
          path: notice.payloadPath,
          sha256: notice.sha256,
        },
      })),
    ],
    excludedLicenseSections: [],
  });
  await writeJson(path.join(repoRoot, 'packaging/license-policy.json'), {
    schemaVersion: 1,
    forbidden: ['UNKNOWN'],
    allowedSpdxLicenses: ['Apache-2.0', 'GPL-2.0-only', 'MIT', 'Python-2.0'],
    allowedSpdxExceptions: ['Classpath-exception-2.0'],
    allowedLicenseRefs: ['LicenseRef-Proprietary'],
    reviewedNonRestrictedLicenseRefs: [],
    restrictedLicenseRefs: ['LicenseRef-Proprietary'],
    trustedApprovals: [],
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
  await writeFile(path.join(runtimeRoot, 'node/LICENSE'), nodeLicenseText);
  for (const notice of fixtureNotices) {
    await writeFile(path.join(repoRoot, notice.sourcePath), notice.bytes);
    await writeFile(path.join(runtimeRoot, notice.payloadPath), notice.bytes);
  }
  const fixtureNode = path.join(runtimeRoot, 'node/bin/node');
  await writeFile(
    fixtureNode,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(fixtureProcessVersions)}'\n`,
  );
  await fs.promises.chmod(fixtureNode, 0o755);
  await writeFile(path.join(runtimeRoot, 'node/host/node_modules/demo-package/index.js'), 'export default 1;\n');
  await writeJson(
    path.join(runtimeRoot, 'node/sidecar/node_modules/@vendor/proprietary-runtime/package.json'),
    { name: '@vendor/proprietary-runtime', version: '2.0.0', license: 'SEE LICENSE IN LICENSE.md' },
  );
  await writeFile(
    path.join(runtimeRoot, 'node/sidecar/node_modules/@vendor/proprietary-runtime/index.js'),
    'export default 2;\n',
  );
  await writeFile(
    path.join(runtimeRoot, 'node/sidecar/node_modules/@vendor/proprietary-runtime/LICENSE.md'),
    'Reviewed proprietary fixture terms.\n',
  );

  const sitePackages = path.join(runtimeRoot, 'python/lib/python3.13/site-packages');
  const distInfo = path.join(sitePackages, 'no_license_metadata-1.2.3.dist-info');
  await writeFile(
    path.join(runtimeRoot, 'python/lib/python3.13/LICENSE.txt'),
    'Python fixture license notices\n',
  );
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
  const {
    loadPythonStandaloneEvidence,
    stagePythonStandaloneNotices,
  } = await import('../lib/python-standalone-evidence.mjs');
  const pythonEvidence = loadPythonStandaloneEvidence({
    bundle: path.join(
      repoRoot,
      'packaging/evidence/python-standalone/evidence-bundle.json',
    ),
    runtimeLock: path.join(repoRoot, 'packaging/runtime-lock.json'),
    bom: path.join(repoRoot, 'packaging/python-standalone-bom.json'),
  });
  stagePythonStandaloneNotices({
    runtimeRoot,
    platform: 'macos-arm64',
    evidence: pythonEvidence,
  });

  return {
    repoRoot,
    runtimeRoot,
    approvalPath: path.join(root, 'external-legal-approval.json'),
    restrictedPackageDir: path.join(
      runtimeRoot,
      'node/sidecar/node_modules/@vendor/proprietary-runtime',
    ),
    nodeNoticePaths: fixtureNotices.map(({ payloadPath }) => path.join(runtimeRoot, payloadPath)),
    pythonLicensePath: path.join(
      runtimeRoot,
      'licenses/python-standalone/macos-arm64/metadata-file/python/licenses/LICENSE.cpython.txt',
    ),
  };
}

async function writeExactApproval(fixture, overrides = {}, trusted = true) {
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
  if (trusted) {
    const policyPath = path.join(fixture.repoRoot, 'packaging/license-policy.json');
    const policy = JSON.parse(await fs.promises.readFile(policyPath, 'utf8'));
    policy.trustedApprovals = [approval];
    await writeJson(policyPath, policy);
  }
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
    for (const required of ['license', 'name', 'sha256', 'source', 'version']) {
      assert.ok(Object.hasOwn(component, required), `${component.name} missing ${required}`);
    }
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
  const proprietaryTerms = Buffer.from('Reviewed proprietary fixture terms.\n', 'utf8');
  assert.deepEqual(
    first.components.find(({ name }) => name === 'npm:@vendor/proprietary-runtime').licenseEvidence,
    [{
      kind: 'payload-file',
      path: 'node/sidecar/node_modules/@vendor/proprietary-runtime/LICENSE.md',
      sha256: createHash('sha256').update(proprietaryTerms).digest('hex'),
    }],
  );
  assert.equal(
    first.components.find(({ name }) => name === 'python:no-license-metadata').license,
    'Apache-2.0',
  );
  assert.equal(
    first.components.find(({ name }) => name === 'python-standalone:cpython').license,
    'Python-2.0',
  );
  assert.equal(
    first.components.find(({ name }) => name === 'node-runtime:acorn-and-acorn-walk').license,
    'MIT',
  );
  const braceNotice = await fs.promises.readFile(fixture.nodeNoticePaths[0]);
  assert.deepEqual(
    first.components.find(({ name }) => name === 'node-runtime:brace-expansion').licenseEvidence,
    [{
      kind: 'payload-file',
      path: 'licenses/node-runtime/brace-expansion-5.0.5-LICENSE.txt',
      sha256: createHash('sha256').update(braceNotice).digest('hex'),
    }],
  );
  const pythonLicense = await fs.promises.readFile(fixture.pythonLicensePath);
  assert.deepEqual(
    first.components.find(({ name }) => name === 'python-standalone:cpython').licenseEvidence,
    [{
      kind: 'payload-file',
      path: 'licenses/python-standalone/macos-arm64/metadata-file/python/licenses/LICENSE.cpython.txt',
      sha256: createHash('sha256').update(pythonLicense).digest('hex'),
    }],
  );
  const licenseInventory = JSON.parse(await fs.promises.readFile(
    path.join(fixture.runtimeRoot, 'license-inventory.json'),
    'utf8',
  ));
  assert.deepEqual(licenseInventory.extractedLicenses, [{
    licenseId: 'LicenseRef-Proprietary',
    name: 'Proprietary',
    extractedText: proprietaryTerms.toString('utf8'),
    evidence: {
      path: 'node/sidecar/node_modules/@vendor/proprietary-runtime/LICENSE.md',
      sha256: createHash('sha256').update(proprietaryTerms).digest('hex'),
    },
  }]);
  const spdx = JSON.parse(await fs.promises.readFile(
    path.join(fixture.runtimeRoot, 'sbom.spdx.json'),
    'utf8',
  ));
  assert.equal(spdx.hasExtractedLicensingInfos[0].licenseId, 'LicenseRef-Proprietary');
  assert.ok(first.files.some(({ path: filePath }) => filePath === 'license-inventory.json'));
  assert.ok(first.files.some(({ path: filePath }) => filePath === 'sbom.spdx.json'));
  assert.deepEqual(
    JSON.parse(await fs.promises.readFile(path.join(fixture.runtimeRoot, 'runtime-manifest.json'), 'utf8')),
    first,
  );
  assert.equal(
    await fs.promises.readFile(path.join(fixture.runtimeRoot, 'runtime-manifest.json'), 'utf8'),
    canonicalJson(first),
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

test('forged external approval is rejected when absent from repository trust policy', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture, {}, false);

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /approval.*not trusted|trusted.*allowlist/i,
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

test('runtime inventory binds installed npm package names to their lockfile paths', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  const packageJsonPath = path.join(fixture.restrictedPackageDir, 'package.json');
  const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, 'utf8'));
  packageJson.name = '@vendor/permitted-rename';
  packageJson.license = 'MIT';
  await writeJson(packageJsonPath, packageJson);

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /npm package identity.*package-lock/i,
  );
});

test('runtime inventory rejects bundled npm and pip bootstrap payloads', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  for (const relativePath of [
    'node/lib/node_modules/npm/package.json',
    'python/lib/python3.13/site-packages/pip/__init__.py',
  ]) {
    const fixture = await makeInventoryFixture(t);
    await writeExactApproval(fixture);
    await writeFile(path.join(fixture.runtimeRoot, relativePath), 'bundled tool');
    await assert.rejects(
      generateRuntimeInventory({
        platform: 'macos-arm64',
        licenseApprovalPath: fixture.approvalPath,
        ...fixture,
      }),
      /bundled.*(?:npm|pip).*must be pruned/i,
    );
  }
});

test('license validation accepts policy-allowed SPDX semantics only', async () => {
  const { assertAllowedLicenseExpression } = await import('../generate-runtime-inventory.mjs');
  const policy = {
    allowedSpdxLicenses: ['Apache-2.0', 'GPL-2.0-only', 'MIT'],
    allowedSpdxExceptions: ['Classpath-exception-2.0'],
    allowedLicenseRefs: ['LicenseRef-Reviewed'],
    reviewedNonRestrictedLicenseRefs: ['LicenseRef-Reviewed'],
    restrictedLicenseRefs: [],
  };

  assert.equal(
    assertAllowedLicenseExpression(
      'MIT OR (GPL-2.0-only WITH Classpath-exception-2.0)',
      policy,
    ),
    'MIT OR (GPL-2.0-only WITH Classpath-exception-2.0)',
  );
  assert.equal(
    assertAllowedLicenseExpression('LicenseRef-Reviewed', policy),
    'LicenseRef-Reviewed',
  );
  assert.throws(
    () => assertAllowedLicenseExpression('custom permissive license text', policy),
    /invalid SPDX|not allowed/i,
  );
  assert.throws(
    () => assertAllowedLicenseExpression('LicenseRef-Forged', policy),
    /LicenseRef-Forged.*not allowed/i,
  );
  assert.throws(
    () => assertAllowedLicenseExpression('MIT AND', policy),
    /invalid SPDX/i,
  );
  assert.throws(
    () => assertAllowedLicenseExpression('LicenseRef-Unreviewed', {
      ...policy,
      allowedLicenseRefs: ['LicenseRef-Unreviewed'],
      reviewedNonRestrictedLicenseRefs: [],
    }),
    /LicenseRef-Unreviewed.*neither restricted nor reviewed/i,
  );
});

test('compound SPDX expressions cannot bypass restricted approval', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  for (const expression of [
    'MIT AND LicenseRef-Proprietary',
    'MIT OR LicenseRef-Proprietary',
  ]) {
    const fixture = await makeInventoryFixture(t);
    const policyPath = path.join(fixture.repoRoot, 'packaging/license-policy.json');
    const policy = JSON.parse(await fs.promises.readFile(policyPath, 'utf8'));
    policy.classifications['npm:@vendor/proprietary-runtime'] = expression;
    await writeJson(policyPath, policy);

    await assert.rejects(
      generateRuntimeInventory({ platform: 'macos-arm64', ...fixture }),
      /redistribution approval required.*LicenseRef-Proprietary/i,
    );
  }
});

test('ambiguous BSD classifier is rejected without evidence-backed policy classification', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  const approval = await writeExactApproval(fixture);
  const policyPath = path.join(fixture.repoRoot, 'packaging/license-policy.json');
  const policy = JSON.parse(await fs.promises.readFile(policyPath, 'utf8'));
  delete policy.classifications['python:no-license-metadata'];
  await writeJson(policyPath, policy);
  const metadataPath = path.join(
    fixture.runtimeRoot,
    'python/lib/python3.13/site-packages/no_license_metadata-1.2.3.dist-info/METADATA',
  );
  await writeFile(metadataPath, [
    'Metadata-Version: 2.3',
    'Name: no-license-metadata',
    'Version: 1.2.3',
    'Classifier: License :: OSI Approved :: BSD License',
    '',
  ].join('\n'));

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /forbidden|UNKNOWN|ambiguous BSD/i,
  );
  assert.ok(approval.approvalId);
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

test('Node runtime BOM schema requires locked distributable license notices', () => {
  const schema = JSON.parse(
    fs.readFileSync('packaging/schemas/node-runtime-bom.schema.json', 'utf8'),
  );
  assert.ok(schema.required.includes('licenseNotices'));
  assert.deepEqual(
    schema.$defs.licenseNotice.required,
    ['package', 'version', 'tarball', 'archivePath', 'sourcePath', 'payloadPath', 'sha256'],
  );
  assert.deepEqual(
    schema.$defs.licenseNotice.properties.tarball.required,
    ['url', 'integrity', 'sha256', 'bytes'],
  );
  assert.ok(schema.$defs.evidence.oneOf.some((candidate) => (
    candidate.properties?.kind?.const === 'payload-file'
  )));
});

test('python standalone BOM is locked and enumerates evidence-backed components', () => {
  const bom = JSON.parse(fs.readFileSync('packaging/python-standalone-bom.json', 'utf8'));
  const runtimeLock = JSON.parse(fs.readFileSync('packaging/runtime-lock.json', 'utf8'));
  assert.equal(bom.schemaVersion, 1);
  assert.equal(bom.pythonVersion, runtimeLock.python.version);
  assert.equal(bom.distributionRelease, runtimeLock.python.distributionRelease);
  assert.equal(bom.releaseCommit, runtimeLock.python.releaseCommit);

  for (const platform of ['macos-arm64', 'windows-x64']) {
    const inventory = bom.platforms[platform];
    const metadata = runtimeLock.python.metadataAssets[platform];
    assert.equal(inventory.metadataSource.url, metadata.url);
    assert.equal(inventory.metadataSource.sha256, metadata.sha256);
    assert.equal(inventory.metadataSource.pythonJson.path, 'python/PYTHON.json');
    assert.equal(inventory.metadataSource.pythonJson.sha256, metadata.pythonJsonSha256);
    assert.ok(inventory.components.length > 10, `${platform} BOM is unexpectedly aggregate`);
    assert.equal(
      new Set(inventory.components.map(({ name }) => name.toLowerCase())).size,
      inventory.components.length,
    );
    for (const component of inventory.components) {
      const expectedComponentKeys = [
        'disposition',
        'evidenceOrigins',
        'licenseDeclared',
        'licenseEvidence',
        'name',
        ...(component.payloadEvidence ? ['payloadEvidence'] : []),
        'relationship',
        'source',
        'version',
      ];
      assert.deepEqual(
        Object.keys(component).sort(),
        expectedComponentKeys.sort(),
      );
      assert.ok(!component.name.startsWith('runtime:cpython'));
      assert.equal(component.disposition, 'payload');
      assert.ok(['STATIC_LINK', 'DYNAMIC_LINK', 'CONTAINS'].includes(component.relationship));
      assert.notEqual(component.licenseDeclared, 'UNKNOWN');
      assert.match(component.source.sha256, /^[a-f0-9]{64}$/);
      assert.ok(['archive', 'runtime-file'].includes(component.source.kind));
      assert.ok(component.licenseEvidence.length > 0);
      for (const evidence of component.licenseEvidence) {
        if (evidence.kind === 'source-archive-member') {
          assert.deepEqual(
            Object.keys(evidence).sort(),
            ['archiveSha256', 'kind', 'memberSha256', 'path'],
          );
          assert.match(evidence.archiveSha256, /^[a-f0-9]{64}$/);
          assert.match(evidence.memberSha256, /^[a-f0-9]{64}$/);
        } else {
          assert.deepEqual(Object.keys(evidence).sort(), ['kind', 'path', 'sha256']);
          assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
        }
      }
    }
  }

  const macNames = new Set(bom.platforms['macos-arm64'].components.map(({ name }) => name));
  const windowsNames = new Set(bom.platforms['windows-x64'].components.map(({ name }) => name));
  assert.ok(macNames.has('libuuid'));
  assert.ok(!windowsNames.has('libuuid'), 'Windows uses RPCRT4 instead of bundled libuuid');
  assert.ok(!macNames.has('zlib'), 'macOS uses the system zlib');
  assert.ok(windowsNames.has('zlib'), 'Windows statically embeds zlib');
  assert.ok(macNames.has('openssl-3'));
  assert.ok(!macNames.has('openssl-1.1'), 'stale metadata must not invent OpenSSL 1.1 payload');
});

test('Node runtime BOM partitions every upstream LICENSE heading exactly once', () => {
  const bom = JSON.parse(fs.readFileSync('packaging/node-runtime-bom.json', 'utf8'));
  const expectedHeadings = [
    'Acorn', 'c-ares', 'merve', 'ittapi', 'amaro', 'swc', 'ICU', 'libuv', 'LIEF',
    'llhttp', 'corepack', 'undici', 'postject', 'OpenSSL', 'Punycode.js', 'V8',
    'SipHash', 'zlib', 'simdjson', 'simdutf', 'ada', 'minimatch', 'npm', 'GYP',
    'inspector_protocol', 'jinja2', 'markupsafe', 'cpplint.py', 'gypi_to_gn.py',
    'gtest', 'nghttp2', 'large_pages', 'caja', 'brotli', 'zstd', 'HdrHistogram',
    'node-heapdump', 'rimraf', 'uvwasi', 'ngtcp2', 'nghttp3', 'node-fs-extra',
    'on-exit-leak-free', 'sonic-boom',
  ];
  const payloadHeadings = bom.payloadComponents.flatMap(({ licenseEvidence }) => (
    (Array.isArray(licenseEvidence) ? licenseEvidence : [licenseEvidence])
      .filter(({ kind }) => kind === 'license-section')
      .map(({ heading }) => heading)
  ));
  const excludedHeadings = bom.excludedLicenseSections.map(({ heading }) => heading);

  assert.equal(bom.schemaVersion, 1);
  assert.equal(bom.nodeVersion, '24.17.0');
  assert.equal(
    bom.sourceAsset.sha256,
    'a7ab562ed2369a29c68b72fa00e3103bcdfe37063dff799c6acc8e404e275fcd',
  );
  assert.deepEqual([...payloadHeadings, ...excludedHeadings].sort(), expectedHeadings.sort());
  assert.equal(new Set([...payloadHeadings, ...excludedHeadings]).size, 44);
  assert.equal(
    bom.platforms['macos-arm64'].licenseFile.sha256,
    '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18',
  );
  assert.equal(
    bom.platforms['windows-x64'].licenseFile.sha256,
    '8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c',
  );
  assert.equal(bom.platforms['macos-arm64'].processVersions.node, '24.17.0');
  assert.equal(bom.platforms['macos-arm64'].processVersions.sqlite, '3.53.0');
  assert.equal(
    bom.payloadComponents.find(({ name }) => name === 'icu').licenseDeclared,
    'LicenseRef-Node-ICU-Bundle',
  );
  assert.equal(
    bom.payloadComponents.find(({ name }) => name === 'v8').licenseDeclared,
    'LicenseRef-Node-V8-Bundle',
  );
  assert.equal(bom.payloadComponents.find(({ name }) => name === 'acorn-walk').version, '8.3.5');
  assert.equal(
    bom.payloadComponents.find(({ name }) => name === 'libuv').licenseDeclared,
    'MIT AND BSD-2-Clause AND ISC',
  );
  assert.equal(
    bom.payloadComponents.find(({ name }) => name === 'minimatch').licenseDeclared,
    'BlueOak-1.0.0',
  );
  assert.equal(bom.payloadComponents.find(({ name }) => name === 'nbytes').version, '0.1.4');
  assert.equal(bom.payloadComponents.find(({ name }) => name === 'ncrypto').version, '0.0.1');
  assert.equal(bom.payloadComponents.find(({ name }) => name === 'punycode').version, '2.1.0');
  assert.equal(
    bom.payloadComponents.find(({ name }) => name === 'inspector-protocol').version,
    '0+rev.1b1bcbbe060e8c8cd8704f00f78978c50991b307',
  );
});

test('Node LICENSE sections preserve exact bytes for LicenseRef extraction', async () => {
  const { parseNodeLicenseSections } = await import('../generate-runtime-inventory.mjs');
  const first = [
    '- ICU, located at deps/icu-small, is licensed as follows:',
    '  """ICU fixture terms"""',
    '',
  ].join('\r\n');
  const second = [
    '- V8, located at deps/v8, is licensed as follows:',
    '  """V8 fixture terms"""',
    '',
  ].join('\r\n');

  assert.deepEqual(parseNodeLicenseSections(first + second), [
    { heading: 'ICU', sourceSubpath: 'deps/icu-small', text: first },
    { heading: 'V8', sourceSubpath: 'deps/v8', text: second },
  ]);
});

test('Node LicenseRef sections become staged payload evidence and SPDX extracted text', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  const bomPath = path.join(fixture.repoRoot, 'packaging/node-runtime-bom.json');
  const bom = JSON.parse(await fs.promises.readFile(bomPath, 'utf8'));
  const acorn = bom.payloadComponents.find(({ name }) => name === 'acorn-and-acorn-walk');
  acorn.licenseDeclared = 'LicenseRef-Node-Fixture';
  await writeJson(bomPath, bom);
  const policyPath = path.join(fixture.repoRoot, 'packaging/license-policy.json');
  const policy = JSON.parse(await fs.promises.readFile(policyPath, 'utf8'));
  policy.allowedLicenseRefs.push('LicenseRef-Node-Fixture');
  policy.reviewedNonRestrictedLicenseRefs.push('LicenseRef-Node-Fixture');
  await writeJson(policyPath, policy);

  const manifest = await generateRuntimeInventory({
    platform: 'macos-arm64',
    licenseApprovalPath: fixture.approvalPath,
    ...fixture,
  });
  const evidencePath = 'licenses/extracted/LicenseRef-Node-Fixture.txt';
  const nodeLicense = await fs.promises.readFile(path.join(fixture.runtimeRoot, 'node/LICENSE'), 'utf8');
  const sectionText = nodeLicense.slice(nodeLicense.indexOf('- Acorn,'));
  const sectionSha256 = createHash('sha256').update(sectionText).digest('hex');
  assert.ok(
    manifest.components.find(({ name }) => name === 'node-runtime:acorn-and-acorn-walk')
      .licenseEvidence.some((record) => (
        record.kind === 'payload-file'
        && record.path === evidencePath
        && record.sha256 === sectionSha256
      )),
  );
  assert.equal(await fs.promises.readFile(path.join(fixture.runtimeRoot, evidencePath), 'utf8'), sectionText);
  const licenses = JSON.parse(await fs.promises.readFile(
    path.join(fixture.runtimeRoot, 'license-inventory.json'),
    'utf8',
  ));
  assert.deepEqual(
    licenses.extractedLicenses.find(({ licenseId }) => licenseId === 'LicenseRef-Node-Fixture'),
    {
      licenseId: 'LicenseRef-Node-Fixture',
      name: 'Node Fixture',
      extractedText: sectionText,
      evidence: { path: evidencePath, sha256: sectionSha256 },
    },
  );
});

test('Node runtime BOM enumerates every package embedded in the minimatch bundle', () => {
  const bom = JSON.parse(fs.readFileSync('packaging/node-runtime-bom.json', 'utf8'));
  const indexEvidence = {
    kind: 'source-file',
    path: 'deps/minimatch/index.js',
    sha256: '23f1e425aa0813670574fe2c0241f591ef5463aacf2a23e3284654a49245fd4c',
  };
  const lockEvidence = {
    kind: 'source-file',
    path: 'deps/minimatch/package-lock.json',
    sha256: '6e435625a4a49c45ab3174604f308f7e1d2a961da3af6ef63508dc317b982b23',
  };
  const expectedNotices = [
    {
      package: 'brace-expansion',
      version: '5.0.5',
      tarball: {
        url: 'https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.5.tgz',
        integrity: 'sha512-VZznLgtwhn+Mact9tfiwx64fA9erHH/MCXEUfB/0bX/6Fz6ny5EGTXYltMocqg4xFAQZtnO3DHWWXi8RiuN7cQ==',
        sha256: 'e919c0ac902f05c2b3bbd31fd71af6c8ddfd74fadc85321231184d39ca990f31',
        bytes: 7894,
      },
      archivePath: 'package/LICENSE',
      sourcePath: 'packaging/licenses/node-runtime/brace-expansion-5.0.5-LICENSE.txt',
      payloadPath: 'licenses/node-runtime/brace-expansion-5.0.5-LICENSE.txt',
      sha256: '9c63a23124d68cd30cd316a94a1a0bca34f032786df6df69fc4b5f136bac8d2e',
    },
    {
      package: 'balanced-match',
      version: '4.0.4',
      tarball: {
        url: 'https://registry.npmjs.org/balanced-match/-/balanced-match-4.0.4.tgz',
        integrity: 'sha512-BLrgEcRTwX2o6gGxGOCNyMvGSp35YofuYzw9h1IMTRmKqttAZZVU67bdb9Pr2vUHA8+j3i2tJfjO6C6+4myGTA==',
        sha256: '9025508d9125eee531bbc49ce3ae560183975ad595f058c378bd56af4152fb16',
        bytes: 4199,
      },
      archivePath: 'package/LICENSE.md',
      sourcePath: 'packaging/licenses/node-runtime/balanced-match-4.0.4-LICENSE.txt',
      payloadPath: 'licenses/node-runtime/balanced-match-4.0.4-LICENSE.txt',
      sha256: 'd408f38ffa3355c5faec517153295338892eb0f1ea43f57874bb23c6075979b5',
    },
  ];
  const expected = [
    {
      name: 'minimatch',
      version: '10.2.5',
      licenseDeclared: 'BlueOak-1.0.0',
      sourceSubpath: 'deps/minimatch',
    },
    {
      name: 'brace-expansion',
      version: '5.0.5',
      licenseDeclared: 'MIT',
      sourceSubpath: 'deps/minimatch/index.js',
      notice: expectedNotices[0],
    },
    {
      name: 'balanced-match',
      version: '4.0.4',
      licenseDeclared: 'MIT',
      sourceSubpath: 'deps/minimatch/index.js',
      notice: expectedNotices[1],
    },
  ];

  assert.deepEqual(bom.licenseNotices, expectedNotices);
  for (const notice of expectedNotices) {
    const bytes = fs.readFileSync(notice.sourcePath);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), notice.sha256);
    assert.match(bytes.toString('utf8'), /Copyright .*Julian Gruber/);
    assert.match(bytes.toString('utf8'), /Permission is hereby granted/);
  }

  for (const locked of expected) {
    const component = bom.payloadComponents.find(({ name }) => name === locked.name);
    assert.ok(component, `${locked.name} is missing from the Node runtime BOM`);
    assert.equal(component.version, locked.version);
    assert.equal(component.licenseDeclared, locked.licenseDeclared);
    assert.equal(component.sourceSubpath, locked.sourceSubpath);
    const evidence = Array.isArray(component.licenseEvidence)
      ? component.licenseEvidence
      : [component.licenseEvidence];
    assert.deepEqual(
      evidence.find(({ kind, path: evidencePath }) => (
        kind === indexEvidence.kind && evidencePath === indexEvidence.path
      )),
      indexEvidence,
      `${locked.name} does not lock the bundled source file`,
    );
    assert.deepEqual(
      evidence.find(({ kind, path: evidencePath }) => (
        kind === lockEvidence.kind && evidencePath === lockEvidence.path
      )),
      lockEvidence,
      `${locked.name} does not lock the dependency record`,
    );
    if (locked.notice) {
      assert.deepEqual(
        evidence.find(({ kind, path: evidencePath }) => (
          kind === 'payload-file' && evidencePath === locked.notice.payloadPath
        )),
        {
          kind: 'payload-file',
          path: locked.notice.payloadPath,
          sha256: locked.notice.sha256,
        },
        `${locked.name} does not require its bundled MIT notice`,
      );
    }
  }

  const minimatchEvidence = bom.payloadComponents
    .find(({ name }) => name === 'minimatch')
    .licenseEvidence;
  assert.ok(minimatchEvidence.some((record) => (
    record.kind === 'license-section'
    && record.heading === 'minimatch'
    && record.sourceSubpath === 'deps/minimatch'
  )));
});

test('Node runtime inventory fails closed when a bundled license notice is missing or tampered', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  for (const failure of ['missing', 'tampered']) {
    const fixture = await makeInventoryFixture(t);
    await writeExactApproval(fixture);
    const noticePath = fixture.nodeNoticePaths[0];
    if (failure === 'missing') {
      await fs.promises.rm(noticePath);
    } else {
      await fs.promises.writeFile(noticePath, 'tampered notice\n');
    }

    await assert.rejects(
      generateRuntimeInventory({
        platform: 'macos-arm64',
        licenseApprovalPath: fixture.approvalPath,
        ...fixture,
      }),
      /Node license notice payload.*(?:missing|SHA-256)/i,
    );
    assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'runtime-manifest.json')), false);
  }
});

test('Node runtime inventory binds each notice lock to the exact component version and payload', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  const bomPath = path.join(fixture.repoRoot, 'packaging/node-runtime-bom.json');
  const bom = JSON.parse(await fs.promises.readFile(bomPath, 'utf8'));
  bom.payloadComponents.find(({ name }) => name === 'brace-expansion').version = '5.0.4';
  await writeJson(bomPath, bom);

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /Node license notice.*(?:component|version|binding)/i,
  );
  assert.equal(fs.existsSync(path.join(fixture.runtimeRoot, 'runtime-manifest.json')), false);
});

test('Node runtime inventory fails closed on LICENSE digest or heading partition drift', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  const licensePath = path.join(fixture.runtimeRoot, 'node/LICENSE');
  await fs.promises.appendFile(licensePath, 'tampered\n');
  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /Node.*LICENSE.*SHA-256|license file.*digest/i,
  );

  const fixture2 = await makeInventoryFixture(t);
  await writeExactApproval(fixture2);
  const licensePath2 = path.join(fixture2.runtimeRoot, 'node/LICENSE');
  await fs.promises.appendFile(
    licensePath2,
    '- Unclassified, located at deps/unclassified, is licensed as follows:\n  """MIT"""\n',
  );
  const changed = await fs.promises.readFile(licensePath2);
  const changedSha256 = createHash('sha256').update(changed).digest('hex');
  const bomPath = path.join(fixture2.repoRoot, 'packaging/node-runtime-bom.json');
  const bom = JSON.parse(await fs.promises.readFile(bomPath, 'utf8'));
  bom.sourceAsset.license.sha256 = changedSha256;
  bom.platforms['macos-arm64'].licenseFile.sha256 = changedSha256;
  await writeJson(bomPath, bom);
  const runtimeLockPath = path.join(fixture2.repoRoot, 'packaging/runtime-lock.json');
  const runtimeLock = JSON.parse(await fs.promises.readFile(runtimeLockPath, 'utf8'));
  runtimeLock.node.sourceAsset.licenseSha256 = changedSha256;
  await writeJson(runtimeLockPath, runtimeLock);
  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture2.approvalPath,
      ...fixture2,
    }),
    /Node.*LICENSE.*(?:unclassified|partition|missing)/i,
  );
});

test('Node runtime inventory verifies actual process.versions against the BOM', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  const bomPath = path.join(fixture.repoRoot, 'packaging/node-runtime-bom.json');
  const bom = JSON.parse(await fs.promises.readFile(bomPath, 'utf8'));
  bom.platforms['macos-arm64'].processVersions.node = '24.16.0';
  await writeJson(bomPath, bom);

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /process\.versions.*node.*24\.16\.0.*24\.17\.0|Node.*version.*does not match/i,
  );
});

test('Node runtime inventory rejects source BOM drift from runtime-lock', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  const bomPath = path.join(fixture.repoRoot, 'packaging/node-runtime-bom.json');
  const bom = JSON.parse(await fs.promises.readFile(bomPath, 'utf8'));
  bom.sourceAsset.sha256 = 'b'.repeat(64);
  await writeJson(bomPath, bom);

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /Node.*source.*(?:runtime lock|does not match)/i,
  );
});

test('runtime inventory rejects CPython BOM metadata that drifts from the locked source', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  const bomPath = path.join(fixture.repoRoot, 'packaging/python-standalone-bom.json');
  const bom = JSON.parse(await fs.promises.readFile(bomPath, 'utf8'));
  bom.platforms['macos-arm64'].metadataSource.pythonJson.sha256 = 'b'.repeat(64);
  await writeJson(bomPath, bom);

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /PYTHON\.json provenance mismatch/i,
  );
});

test('runtime inventory verifies runtime-file BOM digests against the actual payload', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  const bomPath = path.join(fixture.repoRoot, 'packaging/python-standalone-bom.json');
  const bom = JSON.parse(await fs.promises.readFile(bomPath, 'utf8'));
  const component = bom.platforms['macos-arm64'].components[0];
  component.source = {
    kind: 'runtime-file',
    path: 'python/runtime-evidence.bin',
    sha256: 'b'.repeat(64),
  };
  component.licenseEvidence.push({
    kind: 'payload-file',
    path: 'python/runtime-evidence.bin',
    sha256: 'b'.repeat(64),
  });
  await writeJson(bomPath, bom);
  await writeFile(path.join(fixture.runtimeRoot, 'python/runtime-evidence.bin'), 'digest drift');

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      ...fixture,
    }),
    /runtime-file.*SHA-256.*does not match/i,
  );
});

test('runtime inventory never trusts a caller-supplied Python evidence verifier', async (t) => {
  const { generateRuntimeInventory } = await import('../generate-runtime-inventory.mjs');
  const fixture = await makeInventoryFixture(t);
  await writeExactApproval(fixture);
  await fs.promises.rm(fixture.pythonLicensePath);

  const forgedEvidence = {
    verifyStagedPythonStandaloneNotices() {},
    payloadRecordForEvidence(_platform, evidence) {
      return {
        kind: 'payload-file',
        path: `licenses/forged/${evidence.path}`,
        sha256: evidence.sha256 ?? evidence.memberSha256,
      };
    },
  };

  await assert.rejects(
    generateRuntimeInventory({
      platform: 'macos-arm64',
      licenseApprovalPath: fixture.approvalPath,
      pythonEvidence: forgedEvidence,
      ...fixture,
    }),
    /Missing staged Python standalone notice/i,
  );
});

test('license policy explicitly forbids UNKNOWN', () => {
  const policy = JSON.parse(fs.readFileSync('packaging/license-policy.json', 'utf8'));
  assert.equal(policy.schemaVersion, 1);
  assert.ok(policy.forbidden.includes('UNKNOWN'));
  assert.ok(policy.restrictedLicenseRefs.includes('LicenseRef-Anthropic-Agent-SDK-Terms'));
  assert.ok(policy.restrictedLicenseRefs.includes(
    'LicenseRef-Anthropic-Claude-Code-Legal-Agreements',
  ));
  assert.ok(policy.restrictedLicenseRefs.includes('LicenseRef-Microsoft-Visual-Cpp-Runtime'));
  assert.ok(policy.restrictedLicenseRefs.includes('LicenseRef-Node-ICU-Bundle'));
  assert.ok(policy.restrictedLicenseRefs.includes('LicenseRef-Node-V8-Bundle'));
  assert.ok(policy.restrictedLicenseRefs.includes('LicenseRef-Itcl-4.3.5'));
  assert.ok(policy.restrictedLicenseRefs.includes('LicenseRef-Tcl-Thread-3.0.4'));
  assert.ok(policy.restrictedLicenseRefs.includes('LicenseRef-Tix-8.4.3.6'));
  assert.deepEqual(policy.reviewedNonRestrictedLicenseRefs, ['LicenseRef-SQLite-Public-Domain']);
  assert.equal(policy.trustedApprovals.length, 6);
  assert.ok(policy.trustedApprovals.every(
    (approval) => approval.approvalId === 'OWNER-APPROVED-2026-07-18',
  ));
  assert.ok(policy.allowedLicenseRefs.includes('LicenseRef-Anthropic-Agent-SDK-Terms'));
  assert.ok(policy.allowedLicenseRefs.includes(
    'LicenseRef-Anthropic-Claude-Code-Legal-Agreements',
  ));
  assert.ok(policy.allowedLicenseRefs.includes('LicenseRef-Microsoft-Visual-Cpp-Runtime'));
  assert.ok(policy.allowedLicenseRefs.includes('LicenseRef-SQLite-Public-Domain'));
  assert.ok(policy.allowedSpdxLicenses.includes('MIT'));
  assert.equal(
    policy.classifications['npm:@anthropic-ai/claude-agent-sdk'],
    'LicenseRef-Anthropic-Agent-SDK-Terms',
  );
  assert.equal(
    policy.classifications['npm:@anthropic-ai/claude-agent-sdk-darwin-arm64'],
    'LicenseRef-Anthropic-Claude-Code-Legal-Agreements',
  );
  assert.ok(Object.values(policy.classifications).every((license) => license !== 'UNKNOWN'));
});
