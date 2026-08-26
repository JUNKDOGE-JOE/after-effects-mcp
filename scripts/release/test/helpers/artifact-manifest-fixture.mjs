import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalJson } from '../../../package/lib/manifest.mjs';
import { canonicalStringify, sha256File } from '../../artifact-manifest.mjs';

export const PRODUCT_VERSION = '0.10.3';
export const PRODUCT_SCENARIOS = [
  'clean-install-and-upgrade-rollback',
  'permission-denial-and-recovery',
  'persistence',
  'provider-header-routing',
  'tool-library',
];

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function directBundleManifest(platform, candidateSha) {
  return {
    schemaVersion: 1,
    version: PRODUCT_VERSION,
    platform,
    sourceCommitSha: candidateSha,
    files: [{
      path: 'host/server.js',
      sha256: '1'.repeat(64),
      size: 1,
      mode: '0644',
      type: 'file',
    }],
  };
}

function stepEvidence(platform, zxpSha, dmgSha) {
  const steps = [
    { id: 'freeze-signed-manifests', inputSha256: '0'.repeat(64), outputSha256: '8'.repeat(64) },
    { id: 'sign-zxp', inputSha256: '8'.repeat(64), outputSha256: zxpSha },
    { id: 'verify-zxp', inputSha256: zxpSha, outputSha256: zxpSha },
  ];
  if (platform === 'macos-arm64') {
    steps.push(
      { id: 'build-dmg', inputSha256: zxpSha, outputSha256: dmgSha },
      { id: 'sign-dmg', inputSha256: dmgSha, outputSha256: dmgSha },
      { id: 'notarize-dmg', inputSha256: dmgSha, outputSha256: dmgSha },
      { id: 'staple-dmg', inputSha256: dmgSha, outputSha256: dmgSha },
      { id: 'verify-gatekeeper', inputSha256: dmgSha, outputSha256: dmgSha },
    );
  }
  return steps.map((step) => ({ ...step, exitCode: 0 }));
}

async function writePlatformEvidence(root, platform, candidateSha, artifacts) {
  const name = platform;
  const paths = Object.fromEntries([
    'bundleManifest',
    'signedBundleManifest',
    'nativeSignatureEvidence',
    'signingReport',
  ].map((kind) => [kind, join(root, `${name}-${kind}.json`)]));
  const bundle = directBundleManifest(platform, candidateSha);
  const bundleBytes = Buffer.from(canonicalJson(bundle), 'utf8');
  await writeFile(paths.bundleManifest, bundleBytes);
  await writeFile(paths.signedBundleManifest, bundleBytes);
  const signedBundleManifestSha256 = sha256Bytes(bundleBytes);
  const outputs = artifacts
    .filter((item) => item.platform === platform)
    .map((item) => ({
      name: item.name,
      role: item.role,
      sha256: sha256Bytes(Buffer.from(item.bytes, 'utf8')),
    }));
  const zxpSha = outputs.find((item) => item.role === 'zxp').sha256;
  const dmgSha = outputs.find((item) => item.role === 'dmg')?.sha256 ?? zxpSha;
  const identity = platform === 'macos-arm64'
    ? {
      certificateFingerprint: '6'.repeat(64),
      developerIdTeamId: 'ABCDE12345',
      notarySubmissionId: '123e4567-e89b-42d3-a456-426614174000',
      stapledTicketVerified: true,
      gatekeeperVerified: true,
      zxpCertificateFingerprint: '7'.repeat(64),
      zxpPayloadSha256: '8'.repeat(64),
      zxpVerified: true,
    }
    : {
      authenticodeSignerThumbprint: 'F'.repeat(40),
      timestampVerified: true,
      zxpCertificateFingerprint: '7'.repeat(64),
      zxpPayloadSha256: '8'.repeat(64),
      zxpVerified: true,
    };
  await writeFile(paths.signingReport, canonicalStringify({
    schemaVersion: 1,
    platform,
    candidateSha,
    sourceStageSha256: '2'.repeat(64),
    signedBundleManifestSha256,
    finalRootSha256: '8'.repeat(64),
    result: 'PASS',
    steps: stepEvidence(platform, zxpSha, dmgSha),
    outputs,
    identity,
  }));
  await writeFile(paths.nativeSignatureEvidence, canonicalJson({
    schemaVersion: 1,
    platform,
    candidateSha,
    discoveredNativeCount: 0,
    files: [],
    finalRootSha256: '8'.repeat(64),
    result: 'PASS',
    signedBundleManifestSha256,
    artifacts: outputs,
  }));
  return {
    platform,
    bundleManifestPath: paths.bundleManifest,
    signedBundleManifestPath: paths.signedBundleManifest,
    nativeSignatureEvidencePath: paths.nativeSignatureEvidence,
    signingReportPath: paths.signingReport,
  };
}

export async function makeArtifactManifestFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateSha = 'a'.repeat(40);
  const artifacts = [
    {
      name: `ae-mcp-panel-v${PRODUCT_VERSION}-macos-arm64.dmg`,
      path: join(root, `ae-mcp-panel-v${PRODUCT_VERSION}-macos-arm64.dmg`),
      platform: 'macos-arm64',
      artifactId: '100',
      role: 'dmg',
      bytes: 'mac-dmg-bytes',
    },
    {
      name: `ae-mcp-panel-v${PRODUCT_VERSION}-macos-arm64.zxp`,
      path: join(root, `ae-mcp-panel-v${PRODUCT_VERSION}-macos-arm64.zxp`),
      platform: 'macos-arm64',
      artifactId: '101',
      role: 'zxp',
      bytes: 'mac-zxp-bytes',
    },
    {
      name: `ae-mcp-panel-v${PRODUCT_VERSION}-windows-x64.zxp`,
      path: join(root, `ae-mcp-panel-v${PRODUCT_VERSION}-windows-x64.zxp`),
      platform: 'windows-x64',
      artifactId: '102',
      role: 'zxp',
      bytes: 'win-zxp-bytes',
    },
  ];
  for (const artifact of artifacts) await writeFile(artifact.path, artifact.bytes);
  const productAcceptanceEvidencePath = join(root, 'product-acceptance-evidence.json');
  await writeFile(productAcceptanceEvidencePath, canonicalJson({
    schemaVersion: 1,
    candidateSha,
    result: 'PASS',
    coverage: PRODUCT_SCENARIOS.map((id, index) => ({
      id,
      result: 'PASS',
      evidenceSha256: String(index + 1).repeat(64),
    })),
  }));
  const evidence = [];
  for (const platform of ['macos-arm64', 'windows-x64']) {
    evidence.push(await writePlatformEvidence(root, platform, candidateSha, artifacts));
  }
  return {
    root,
    artifactPath: artifacts[1].path,
    artifacts,
    candidateSha,
    productAcceptanceEvidencePath,
    evidence,
    async artifactDigest(name) {
      return sha256File(join(root, name));
    },
    async bundleBytes(platform) {
      return readFile(join(root, `${platform}-bundleManifest.json`));
    },
  };
}
