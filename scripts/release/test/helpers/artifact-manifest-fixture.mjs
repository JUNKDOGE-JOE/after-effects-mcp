import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSigningPlan } from '../../../package/signing-plan.mjs';
import { canonicalJson } from '../../../package/lib/manifest.mjs';
import {
  buildLicenseInventory,
  buildRuntimeSpdx,
} from '../../../package/lib/runtime-evidence.mjs';
import { canonicalStringify, sha256File } from '../../artifact-manifest.mjs';

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
        version: '0.9.2',
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
      files: nativePaths.map((itemPath) => ({
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

export async function makeArtifactManifestFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateSha = 'a'.repeat(40);
  const artifacts = [
    {
      name: 'ae-mcp-panel-v0.9.2-macos-arm64.dmg', path: join(root, 'ae-mcp-panel-v0.9.2-macos-arm64.dmg'), platform: 'macos-arm64',
      artifactId: '100', role: 'install', bytes: 'mac-dmg-bytes',
    },
    {
      name: 'ae-mcp-panel-v0.9.2-macos-arm64.zxp', path: join(root, 'ae-mcp-panel-v0.9.2-macos-arm64.zxp'), platform: 'macos-arm64',
      artifactId: '101', role: 'payload', bytes: 'mac-zxp-bytes',
    },
    {
      name: 'ae-mcp-panel-v0.9.2-windows-x64.zxp', path: join(root, 'ae-mcp-panel-v0.9.2-windows-x64.zxp'), platform: 'windows-x64',
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
