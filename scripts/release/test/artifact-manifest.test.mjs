import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSigningPlan } from '../../package/signing-plan.mjs';
import { canonicalJson } from '../../package/lib/manifest.mjs';
import {
  buildLicenseInventory,
  buildRuntimeSpdx,
} from '../../package/lib/runtime-evidence.mjs';
import {
  buildArtifactManifest,
  canonicalStringify,
  MAX_ARTIFACT_MANIFEST_BYTES,
  MAX_EVIDENCE_JSON_BYTES,
  serializeArtifactManifest,
  sha256File,
  validateArtifactManifestStructure,
  verifyArtifactManifest,
} from '../artifact-manifest.mjs';

const FINAL_ROOT_SHA256 = '8'.repeat(64);
const ZXP_CERTIFICATE_FINGERPRINT = '7'.repeat(64);
const PRODUCT_SCENARIOS = [
  'clean-install-and-upgrade-rollback',
  'permission-denial-and-recovery',
  'persistence',
  'provider-header-routing',
  'tool-library',
];

function signingSteps(platform, outputDigests) {
  const steps = [];
  let current = FINAL_ROOT_SHA256;
  for (const step of buildSigningPlan(platform).steps) {
    const inputSha256 = current;
    if (step.id === 'sign-zxp') current = outputDigests.zxp;
    if (step.id === 'build-dmg') current = outputDigests.dmg;
    steps.push({ id: step.id, inputSha256, outputSha256: current, exitCode: 0 });
  }
  return steps;
}

async function writeEvidence(root, candidateSha, artifacts) {
  const evidence = [];
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const files = Object.fromEntries(
      ['bundleManifest', 'runtimeInventory', 'sbom', 'licenses', 'signingReport', 'nativeSignatureEvidence']
        .map((kind) => [kind, join(root, `${platform}-${kind}.json`)]),
    );
    const component = {
      name: 'runtime:fixture',
      version: '1.0.0',
      license: 'MIT',
      source: 'fixture:runtime',
      sha256: '1'.repeat(64),
    };
    const runtimeInventory = {
      schemaVersion: 1,
      platform,
      node: { version: '24.17.0', assetSha256: '2'.repeat(64) },
      python: {
        version: '3.13.14',
        distributionRelease: '20260610',
        assetSha256: '3'.repeat(64),
      },
      licenseApprovals: [],
      components: [component],
      files: [{
        path: 'node/bin/node',
        sha256: '4'.repeat(64),
        size: 1,
        mode: platform === 'macos-arm64' ? '0755' : '0644',
        type: 'file',
      }],
    };
    const licenses = buildLicenseInventory({ platform, components: [component] });
    const sbom = buildRuntimeSpdx({ platform, components: [component] });
    await writeFile(files.runtimeInventory, canonicalJson(runtimeInventory));
    await writeFile(files.sbom, canonicalJson(sbom));
    await writeFile(files.licenses, canonicalJson(licenses));
    const runtimeManifestSha256 = await sha256File(files.runtimeInventory);
    const sbomSha256 = await sha256File(files.sbom);
    const licenseInventorySha256 = await sha256File(files.licenses);
    await writeFile(
      files.bundleManifest,
      canonicalJson({
        schemaVersion: 1,
        version: '0.9.1',
        platform,
        sourceCommitSha: candidateSha,
        runtime: {
          nodeVersion: '24.17.0',
          pythonVersion: '3.13.14',
          manifestSha256: runtimeManifestSha256,
          sbomSha256,
          licenseInventorySha256,
        },
        helper: {
          helperId: 'com.junkdoge.ae-mcp.platform-helper',
          manifestSha256: '5'.repeat(64),
        },
        files: [
          {
            path: `platform/${platform}/bin/ae-mcp${platform === 'windows-x64' ? '.exe' : ''}`,
            sha256: '9'.repeat(64), size: 1,
            mode: platform === 'macos-arm64' ? '0755' : '0644', type: 'file',
          },
          {
            path: `platform/${platform}/bin/ae-mcp-platform-helper${platform === 'windows-x64' ? '.exe' : ''}`,
            sha256: 'a'.repeat(64), size: 1,
            mode: platform === 'macos-arm64' ? '0755' : '0644', type: 'file',
          },
          {
            path: `platform/${platform}/helper-manifest.json`,
            sha256: '5'.repeat(64), size: 1, mode: '0644', type: 'file',
          },
        ].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
      }),
    );
    files.signedBundleManifest = join(root, `${platform}-signedBundleManifest.json`);
    await writeFile(files.signedBundleManifest, await readFile(files.bundleManifest));
    const sourceStageSha256 = await sha256File(files.bundleManifest);
    const outputs = [];
    const outputDigests = {};
    for (const artifact of artifacts.filter((item) => item.platform === platform)) {
      const digest = await sha256File(artifact.path);
      outputDigests[artifact.name.endsWith('.dmg') ? 'dmg' : 'zxp'] = digest;
      outputs.push({
        name: artifact.name,
        role: artifact.name.endsWith('.dmg') ? 'dmg' : 'zxp',
        sha256: digest,
      });
    }
    const identity = platform === 'macos-arm64'
      ? {
        certificateFingerprint: '6'.repeat(64),
        developerIdTeamId: 'ABCDE12345',
        notarySubmissionId: '123e4567-e89b-42d3-a456-426614174000',
        stapledTicketVerified: true,
        gatekeeperVerified: true,
        zxpCertificateFingerprint: ZXP_CERTIFICATE_FINGERPRINT,
        zxpPayloadSha256: FINAL_ROOT_SHA256,
        zxpVerified: true,
      }
      : {
        authenticodeSignerThumbprint: 'F'.repeat(40),
        timestampVerified: true,
        zxpCertificateFingerprint: ZXP_CERTIFICATE_FINGERPRINT,
        zxpPayloadSha256: FINAL_ROOT_SHA256,
        zxpVerified: true,
      };
    await writeFile(
      files.signingReport,
      canonicalStringify({
        schemaVersion: 1,
        platform,
        candidateSha,
        sourceStageSha256,
        signedBundleManifestSha256: await sha256File(files.signedBundleManifest),
        finalRootSha256: FINAL_ROOT_SHA256,
        result: 'PASS',
        steps: signingSteps(platform, outputDigests),
        outputs,
        identity,
      }),
    );
    const nativePaths = [
      `platform/${platform}/bin/ae-mcp${platform === 'windows-x64' ? '.exe' : ''}`,
      `platform/${platform}/bin/ae-mcp-platform-helper${platform === 'windows-x64' ? '.exe' : ''}`,
    ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    await writeFile(files.nativeSignatureEvidence, canonicalStringify({
      schemaVersion: 1,
      platform,
      candidateSha,
      result: 'PASS',
      signedBundleManifestSha256: await sha256File(files.signedBundleManifest),
      finalRootSha256: FINAL_ROOT_SHA256,
      discoveredNativeCount: nativePaths.length,
      files: nativePaths.map((itemPath, index) => ({
        path: itemPath,
        sha256: itemPath.includes('platform-helper') ? 'a'.repeat(64) : '9'.repeat(64),
        signatureKind: platform === 'macos-arm64' ? 'codesign' : 'authenticode',
        signerFingerprint: platform === 'macos-arm64' ? '6'.repeat(64) : 'f'.repeat(40),
        verified: true,
      })),
      artifacts: outputs.map(({ name, sha256 }) => ({ name, sha256 })),
    }));
    evidence.push({
      platform,
      bundleManifestPath: files.bundleManifest,
      signedBundleManifestPath: files.signedBundleManifest,
      runtimeInventoryPath: files.runtimeInventory,
      sbomPath: files.sbom,
      licensesPath: files.licenses,
      signingReportPath: files.signingReport,
      nativeSignatureEvidencePath: files.nativeSignatureEvidence,
    });
  }
  return evidence;
}

async function makeFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateSha = 'a'.repeat(40);
  const artifacts = [
    {
      name: 'ae-mcp-panel-v0.9.1-macos-arm64.dmg', path: join(root, 'ae-mcp-panel-v0.9.1-macos-arm64.dmg'), platform: 'macos-arm64',
      artifactId: '100', role: 'install', bytes: 'mac-dmg-bytes',
    },
    {
      name: 'ae-mcp-panel-v0.9.1-macos-arm64.zxp', path: join(root, 'ae-mcp-panel-v0.9.1-macos-arm64.zxp'), platform: 'macos-arm64',
      artifactId: '101', role: 'payload', bytes: 'mac-zxp-bytes',
    },
    {
      name: 'ae-mcp-panel-v0.9.1-windows-x64.zxp', path: join(root, 'ae-mcp-panel-v0.9.1-windows-x64.zxp'), platform: 'windows-x64',
      artifactId: '102', role: 'install', bytes: 'win-zxp-bytes',
    },
  ];
  for (const artifact of artifacts) await writeFile(artifact.path, artifact.bytes);
  const productAcceptanceEvidencePath = join(root, 'product-acceptance-evidence.json');
  await writeFile(productAcceptanceEvidencePath, canonicalStringify({
    schemaVersion: 1,
    candidateSha,
    result: 'PASS',
    coverage: PRODUCT_SCENARIOS.map((id, index) => ({
      id,
      result: 'PASS',
      evidenceSha256: String(index + 1).repeat(64),
    })),
  }));
  return {
    root,
    artifactPath: artifacts[1].path,
    artifacts: artifacts.map(({ bytes: _bytes, ...artifact }) => artifact),
    candidateSha,
    productAcceptanceEvidencePath,
    evidence: await writeEvidence(root, candidateSha, artifacts),
  };
}

test('manifest is canonical and binds exact artifact bytes', async (t) => {
  const fixture = await makeFixture(t);
  const manifest = await buildArtifactManifest({
    version: '0.9.1',
    candidateSha: fixture.candidateSha,
    workflowRunId: '42',
    artifacts: fixture.artifacts,
    evidence: fixture.evidence,
    productAcceptanceEvidencePath: fixture.productAcceptanceEvidencePath,
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(MAX_ARTIFACT_MANIFEST_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_EVIDENCE_JSON_BYTES, 8 * 1024 * 1024);
  assert.ok(manifest.evidence.every((record) => record.signedBundleManifest));
  assert.ok(manifest.evidence.every((record) => record.nativeSignatureEvidence));
  assert.equal(manifest.productAcceptanceEvidence.candidateSha, fixture.candidateSha);
  assert.match(manifest.artifacts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    canonicalStringify({ z: 1, a: { d: 2, b: 1 } }),
    '{"a":{"b":1,"d":2},"z":1}\n',
  );
  assert.deepEqual(await verifyArtifactManifest(manifest, fixture.root), []);
  assert.deepEqual(validateArtifactManifestStructure(manifest), []);
  assert.deepEqual(serializeArtifactManifest(manifest), Buffer.from(canonicalStringify(manifest)));

  const embeddedTamper = structuredClone(manifest);
  embeddedTamper.evidence[0].runtimeInventory.components.push({ unexpected: true });
  assert.match(
    (await verifyArtifactManifest(embeddedTamper, fixture.root)).join(' '),
    /evidence digest|runtime manifest/i,
  );

  await writeFile(join(fixture.root, 'ae-mcp-panel-v0.9.1-macos-arm64.dmg'), 'tampered');
  assert.deepEqual(
    await verifyArtifactManifest(manifest, fixture.root),
    ['sha256 mismatch: ae-mcp-panel-v0.9.1-macos-arm64.dmg'],
  );
});

test('pure manifest verifier rejects extra or missing exact-schema keys', async (t) => {
  const fixture = await makeFixture(t);
  const manifest = await buildArtifactManifest({
    version: '0.9.1',
    candidateSha: fixture.candidateSha,
    workflowRunId: '42',
    artifacts: fixture.artifacts,
    evidence: fixture.evidence,
    productAcceptanceEvidencePath: fixture.productAcceptanceEvidencePath,
  });

  for (const mutate of [
    (value) => { value.extra = true; },
    (value) => { delete value.productAcceptanceSha256; },
    (value) => { value.artifacts[0].extra = true; },
    (value) => { delete value.artifacts[0].role; },
    (value) => { value.evidence[0].extra = true; },
    (value) => { delete value.evidence[0].signedBundleManifest; },
    (value) => { value.evidence[0].sha256.extra = 'a'.repeat(64); },
    (value) => { delete value.evidence[0].sha256.nativeSignatureEvidence; },
    (value) => { value.productAcceptanceEvidence.extra = true; },
    (value) => { delete value.productAcceptanceEvidence.coverage; },
    (value) => { value.productAcceptanceEvidence.coverage[0].extra = true; },
    (value) => { delete value.productAcceptanceEvidence.coverage[0].evidenceSha256; },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    assert.notDeepEqual(validateArtifactManifestStructure(changed), []);
    assert.throws(() => serializeArtifactManifest(changed), /manifest|schema|evidence|artifact/i);
  }
});

test('serializer rejects an aggregate over 64 MiB even when every leaf is at most 8 MiB', () => {
  const leaf = 'x'.repeat(MAX_EVIDENCE_JSON_BYTES - 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(leaf)) <= MAX_EVIDENCE_JSON_BYTES);
  const aggregate = { leaves: Array.from({ length: 9 }, () => leaf) };
  assert.throws(
    () => serializeArtifactManifest(aggregate),
    /artifact manifest.*64 MiB|aggregate.*too large/i,
  );
  const builderSource = buildArtifactManifest.toString();
  assert.ok(
    builderSource.indexOf('serializeArtifactManifest(manifest)')
      < builderSource.lastIndexOf('return manifest'),
    'the builder must check final canonical aggregate bytes before returning',
  );
});

test('builder applies the 8 MiB bound to each evidence JSON leaf', async (t) => {
  const fixture = await makeFixture(t);
  await writeFile(
    fixture.evidence[0].runtimeInventoryPath,
    Buffer.alloc(MAX_EVIDENCE_JSON_BYTES + 1, 0x20),
  );
  await assert.rejects(
    buildArtifactManifest({
      version: '0.9.1',
      candidateSha: fixture.candidateSha,
      workflowRunId: '42',
      artifacts: fixture.artifacts,
      evidence: fixture.evidence,
      productAcceptanceEvidencePath: fixture.productAcceptanceEvidencePath,
    }),
    /evidence JSON must be one bounded regular file/i,
  );
});

test('manifest rejects mutable or malformed identity fields', async () => {
  await assert.rejects(
    buildArtifactManifest({
      version: 'v0.9.1',
      candidateSha: 'short',
      workflowRunId: '',
      artifacts: [],
    }),
    /invalid version|invalid candidate|at least one artifact/,
  );
});

test('builder requires unique artifacts and exactly one evidence record per platform', async (t) => {
  const fixture = await makeFixture(t);
  const artifact = {
    name: 'ae-mcp-panel-v0.9.1-macos-arm64.zxp',
    path: fixture.artifactPath,
    platform: 'macos-arm64',
    artifactId: '100',
    role: 'install',
  };
  const identity = {
    version: '0.9.1',
    candidateSha: fixture.candidateSha,
    workflowRunId: '42',
  };

  await assert.rejects(
    buildArtifactManifest({
      ...identity,
      artifacts: [artifact, { ...artifact, artifactId: '101' }],
      evidence: fixture.evidence,
    }),
    /artifact names must be unique/,
  );
  await assert.rejects(
    buildArtifactManifest({
      ...identity,
      artifacts: [artifact],
      evidence: fixture.evidence.slice(0, 1),
    }),
    /exactly one evidence record.*platform/,
  );
});

test('verification rejects traversal and symbolic-link artifact names fail closed', async (t) => {
  const fixture = await makeFixture(t);
  const manifest = await buildArtifactManifest({
    version: '0.9.1',
    candidateSha: fixture.candidateSha,
    workflowRunId: '42',
    artifacts: fixture.artifacts,
    evidence: fixture.evidence,
    productAcceptanceEvidencePath: fixture.productAcceptanceEvidencePath,
  });

  const traversal = structuredClone(manifest);
  const macZxp = traversal.artifacts.find(
    (item) => item.name === 'ae-mcp-panel-v0.9.1-macos-arm64.zxp',
  );
  macZxp.name = '../ae-mcp-panel-v0.9.1-macos-arm64.zxp';
  assert.deepEqual(
    await verifyArtifactManifest(traversal, fixture.root),
    [
      'invalid artifact name: ../ae-mcp-panel-v0.9.1-macos-arm64.zxp',
      'final native signature evidence artifact mismatch: macos-arm64',
    ],
  );

  if (process.platform !== 'win32') {
    const aliasName = 'ae-mcp-panel-v0.9.1-macos-arm64.zzz';
    await symlink(fixture.artifactPath, join(fixture.root, aliasName));
    const symbolicLink = structuredClone(manifest);
    symbolicLink.artifacts.find(
      (item) => item.name === 'ae-mcp-panel-v0.9.1-macos-arm64.zxp',
    ).name = aliasName;
    assert.deepEqual(
      await verifyArtifactManifest(symbolicLink, fixture.root),
      [
        'final native signature evidence artifact mismatch: macos-arm64',
        `untrusted artifact file: ${aliasName}`,
      ],
    );
  }

  const hardlink = join(fixture.root, 'hardlink.zxp');
  await link(fixture.artifactPath, hardlink);
  await assert.rejects(
    buildArtifactManifest({
      version: '0.9.1',
      candidateSha: fixture.candidateSha,
      workflowRunId: '42',
      artifacts: [{
        name: 'hardlink.zxp', path: hardlink, platform: 'macos-arm64',
        artifactId: '103', role: 'install',
      }],
      evidence: fixture.evidence,
    }),
    { code: 'AE_MCP_UNTRUSTED_FILE' },
  );
});

test('builder refuses symlinked evidence JSON instead of following it', {
  skip: process.platform === 'win32' ? 'Windows symlink creation requires an elevated fixture' : false,
}, async (t) => {
  const fixture = await makeFixture(t);
  const actual = fixture.evidence[0].bundleManifestPath;
  const alias = join(fixture.root, 'bundle-manifest-alias.json');
  await symlink(actual, alias);
  fixture.evidence[0].bundleManifestPath = alias;

  await assert.rejects(
    buildArtifactManifest({
      version: '0.9.1',
      candidateSha: fixture.candidateSha,
      workflowRunId: '42',
      artifacts: fixture.artifacts,
      evidence: fixture.evidence,
      productAcceptanceEvidencePath: fixture.productAcceptanceEvidencePath,
    }),
    { code: 'AE_MCP_UNTRUSTED_FILE' },
  );
});

test('builder and verifier bind every evidence digest and signed output to release bytes', async (t) => {
  const fixture = await makeFixture(t);
  const runtimeBytes = await readFile(fixture.evidence[0].runtimeInventoryPath, 'utf8');
  await writeFile(fixture.evidence[0].runtimeInventoryPath, `${runtimeBytes}\n`);
  await assert.rejects(
    buildArtifactManifest({
      version: '0.9.1',
      candidateSha: fixture.candidateSha,
      workflowRunId: '42',
      artifacts: fixture.artifacts,
      evidence: fixture.evidence,
      productAcceptanceEvidencePath: fixture.productAcceptanceEvidencePath,
    }),
    /not canonical.*runtimeInventory/i,
  );

  const second = await makeFixture(t);
  const signing = JSON.parse(await readFile(second.evidence[1].signingReportPath, 'utf8'));
  signing.outputs[0].sha256 = 'f'.repeat(64);
  await writeFile(second.evidence[1].signingReportPath, canonicalStringify(signing));
  await assert.rejects(
    buildArtifactManifest({
      version: '0.9.1',
      candidateSha: second.candidateSha,
      workflowRunId: '42',
      artifacts: second.artifacts,
      evidence: second.evidence,
      productAcceptanceEvidencePath: second.productAcceptanceEvidencePath,
    }),
    /signing report.*(?:output|ZXP)|ZXP bytes/i,
  );

  const third = await makeFixture(t);
  const manifest = await buildArtifactManifest({
    version: '0.9.1',
    candidateSha: third.candidateSha,
    workflowRunId: '42',
    artifacts: third.artifacts,
    evidence: third.evidence,
    productAcceptanceEvidencePath: third.productAcceptanceEvidencePath,
  });
  manifest.evidence[0].signingReport.outputs[0].sha256 = 'e'.repeat(64);
  assert.match(
    (await verifyArtifactManifest(manifest, third.root)).join(' '),
    /embedded evidence digest mismatch: signingReport/i,
  );
});
