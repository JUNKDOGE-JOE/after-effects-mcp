import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { buildSigningPlan } from '../package/signing-plan.mjs';
import { canonicalStringify } from './artifact-manifest.mjs';
import { validateReleaseStepEvidence } from './run-signing-plan.mjs';

export { canonicalStringify } from './artifact-manifest.mjs';

const CANDIDATE_SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CERTIFICATE_FINGERPRINT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const TEAM_ID = /^[A-Z0-9]{10}$/;
const NOTARY_SUBMISSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
const MAC_IDENTITY_KEYS = new Set([
  'certificateFingerprint',
  'developerIdTeamId',
  'gatekeeperVerified',
  'notarySubmissionId',
  'stapledTicketVerified',
  'zxpCertificateFingerprint',
  'zxpPayloadSha256',
  'zxpVerified',
]);
const WINDOWS_IDENTITY_KEYS = new Set([
  'authenticodeSignerThumbprint',
  'timestampVerified',
  'zxpCertificateFingerprint',
  'zxpPayloadSha256',
  'zxpVerified',
]);
const MAX_SIGNED_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function assertSigningOutputStat(stat) {
  if (stat.isSymbolicLink()) throw new Error('signing output must not be a symbolic link');
  if (!stat.isFile()) throw new Error('signing output must be a regular file');
  if (stat.nlink !== 1n) throw new Error('signing output hard link count must be one');
  if (stat.size <= 0n || stat.size > BigInt(MAX_SIGNED_OUTPUT_BYTES)) {
    throw new Error('signing output exceeds the size limit');
  }
}

export async function hashVerifiedSigningOutput(path, { afterOpen } = {}) {
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('invalid signing output path');
  const before = await lstat(path, { bigint: true });
  await assertSigningOutputStat(before);

  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === 'ELOOP') throw new Error('signing output failed nofollow validation');
    throw new Error('unable to open signing output');
  }

  try {
    const opened = await handle.stat({ bigint: true });
    await assertSigningOutputStat(opened);
    if (!sameFileIdentity(before, opened)) {
      throw new Error('signing output identity changed while opening');
    }
    if (afterOpen) await afterOpen();

    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Number(opened.size)));
    let position = 0;
    while (position < Number(opened.size)) {
      const length = Math.min(chunk.length, Number(opened.size) - position);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) throw new Error('signing output changed while reading');
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }

    const afterDescriptor = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!sameFileState(opened, afterDescriptor) || !sameFileState(opened, afterPath)) {
      throw new Error('signing output changed while reading');
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

function assertExactKeys(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (Object.keys(value).some((key) => !allowedKeys.has(key)) || Object.keys(value).length !== allowedKeys.size) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
}

function normalizeIdentity(platform, identity) {
  if (platform === 'macos-arm64') {
    assertExactKeys(identity, MAC_IDENTITY_KEYS, 'Mac signing identity');
    if (!CERTIFICATE_FINGERPRINT.test(identity.certificateFingerprint || '')) {
      throw new Error('Mac certificate fingerprint is invalid');
    }
    if (!TEAM_ID.test(identity.developerIdTeamId || '')) {
      throw new Error('Developer ID Team ID is invalid');
    }
    if (!NOTARY_SUBMISSION_ID.test(identity.notarySubmissionId || '')) {
      throw new Error('notary submission ID is invalid');
    }
    if (identity.stapledTicketVerified !== true) {
      throw new Error('stapled ticket verification is required');
    }
    if (identity.gatekeeperVerified !== true) {
      throw new Error('Gatekeeper verification is required');
    }
    if (identity.zxpVerified !== true) {
      throw new Error('ZXP verification is required');
    }
    if (!DIGEST.test(identity.zxpCertificateFingerprint || '')
        || !DIGEST.test(identity.zxpPayloadSha256 || '')) {
      throw new Error('audited ZXP certificate and payload digests are required');
    }
    return {
      certificateFingerprint: identity.certificateFingerprint.toLowerCase(),
      developerIdTeamId: identity.developerIdTeamId,
      gatekeeperVerified: true,
      notarySubmissionId: identity.notarySubmissionId.toLowerCase(),
      stapledTicketVerified: true,
      zxpCertificateFingerprint: identity.zxpCertificateFingerprint,
      zxpPayloadSha256: identity.zxpPayloadSha256,
      zxpVerified: true,
    };
  }

  assertExactKeys(identity, WINDOWS_IDENTITY_KEYS, 'Windows signing identity');
  if (!/^[a-f0-9]{40}$/i.test(identity.authenticodeSignerThumbprint || '')) {
    throw new Error('Authenticode signer thumbprint is invalid');
  }
  if (identity.timestampVerified !== true) {
    throw new Error('Authenticode timestamp verification is required');
  }
  if (identity.zxpVerified !== true) {
    throw new Error('ZXP verification is required');
  }
  if (!DIGEST.test(identity.zxpCertificateFingerprint || '')
      || !DIGEST.test(identity.zxpPayloadSha256 || '')) {
    throw new Error('audited ZXP certificate and payload digests are required');
  }
  return {
    authenticodeSignerThumbprint: identity.authenticodeSignerThumbprint.toLowerCase(),
    timestampVerified: true,
    zxpCertificateFingerprint: identity.zxpCertificateFingerprint,
    zxpPayloadSha256: identity.zxpPayloadSha256,
    zxpVerified: true,
  };
}

function expectedOutputRoles(platform) {
  return platform === 'macos-arm64' ? ['dmg', 'zxp'] : ['zxp'];
}

function expectedOutputName(platform, role) {
  return `ae-mcp-panel-v0.9.1-${platform}.${role}`;
}

function validateIdentityFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('signing report input must be an object');
  }
  if (!PLATFORMS.has(input.platform)) throw new Error('invalid signing report platform');
  if (!CANDIDATE_SHA.test(input.candidateSha || '')) throw new Error('invalid candidate SHA');
  if (!DIGEST.test(input.sourceStageSha256 || '')) throw new Error('invalid source stage digest');
  if (!DIGEST.test(input.signedBundleManifestSha256 || '')) {
    throw new Error('invalid signed bundle manifest digest');
  }
  if (!DIGEST.test(input.finalRootSha256 || '')) throw new Error('invalid final root digest');
  if (!input.plan || input.plan.platform !== input.platform) {
    throw new Error('foundation signing plan platform mismatch');
  }
}

export async function buildSigningReport(input) {
  validateIdentityFields(input);
  validateReleaseStepEvidence(input.plan, input.stepEvidence);
  const identity = normalizeIdentity(input.platform, input.identity);
  if (identity.zxpPayloadSha256 !== input.finalRootSha256) {
    throw new Error('audited ZXP payload does not match the frozen final root');
  }
  const requiredRoles = expectedOutputRoles(input.platform);
  if (!Array.isArray(input.outputs) || input.outputs.length !== requiredRoles.length) {
    throw new Error('final signing outputs are missing or duplicated');
  }

  const outputRecords = [];
  const seenRoles = new Set();
  for (const output of input.outputs) {
    if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).some((key) => !['path', 'role'].includes(key))) {
      throw new Error('invalid final signing output');
    }
    if (!requiredRoles.includes(output.role) || seenRoles.has(output.role)) {
      throw new Error('final signing outputs are missing or duplicated');
    }
    if (typeof output.path !== 'string' || output.path.includes('\0') || basename(output.path) !== expectedOutputName(input.platform, output.role)) {
      throw new Error(`invalid ${output.role} output name`);
    }
    seenRoles.add(output.role);
    outputRecords.push({
      name: basename(output.path),
      role: output.role,
      sha256: await hashVerifiedSigningOutput(output.path),
    });
  }
  outputRecords.sort((left, right) => left.role.localeCompare(right.role));

  const zxpDigest = outputRecords.find((output) => output.role === 'zxp').sha256;
  const zxpEvidence = input.stepEvidence.find((step) => step.id === 'verify-zxp');
  if (!zxpEvidence || zxpEvidence.outputSha256 !== zxpDigest) {
    throw new Error('post-signing ZXP bytes do not match verified evidence');
  }
  if (input.platform === 'macos-arm64') {
    const dmgDigest = outputRecords.find((output) => output.role === 'dmg').sha256;
    const gatekeeperEvidence = input.stepEvidence.find((step) => step.id === 'verify-gatekeeper');
    if (!gatekeeperEvidence || gatekeeperEvidence.outputSha256 !== dmgDigest) {
      throw new Error('post-signing DMG bytes do not match verified evidence');
    }
  }

  return {
    schemaVersion: 1,
    platform: input.platform,
    candidateSha: input.candidateSha,
    sourceStageSha256: input.sourceStageSha256,
    signedBundleManifestSha256: input.signedBundleManifestSha256,
    finalRootSha256: input.finalRootSha256,
    result: 'PASS',
    steps: input.stepEvidence.map((step) => ({
      id: step.id,
      inputSha256: step.inputSha256,
      outputSha256: step.outputSha256,
      exitCode: 0,
    })),
    outputs: outputRecords,
    identity,
  };
}

export function validateSigningReport(report) {
  const topLevelKeys = new Set([
    'candidateSha',
    'finalRootSha256',
    'identity',
    'outputs',
    'platform',
    'result',
    'schemaVersion',
    'signedBundleManifestSha256',
    'sourceStageSha256',
    'steps',
  ]);
  assertExactKeys(report, topLevelKeys, 'signing report');
  if (report.schemaVersion !== 1 || report.result !== 'PASS' || !PLATFORMS.has(report.platform) || !CANDIDATE_SHA.test(report.candidateSha || '') || !DIGEST.test(report.sourceStageSha256 || '') || !DIGEST.test(report.signedBundleManifestSha256 || '') || !DIGEST.test(report.finalRootSha256 || '')) {
    throw new Error('invalid signing report identity');
  }
  const identity = normalizeIdentity(report.platform, report.identity);
  if (identity.zxpPayloadSha256 !== report.finalRootSha256) {
    throw new Error('audited ZXP payload does not match the frozen final root');
  }
  if (!Array.isArray(report.steps) || !Array.isArray(report.outputs)) {
    throw new Error('invalid signing report records');
  }
  for (const step of report.steps) {
    assertExactKeys(step, new Set(['exitCode', 'id', 'inputSha256', 'outputSha256']), 'signing report step');
    if (typeof step.id !== 'string' || !DIGEST.test(step.inputSha256 || '') || !DIGEST.test(step.outputSha256 || '') || step.exitCode !== 0) {
      throw new Error('invalid signing report step');
    }
  }
  validateReleaseStepEvidence(buildSigningPlan(report.platform), report.steps);
  const requiredRoles = expectedOutputRoles(report.platform);
  if (report.outputs.length !== requiredRoles.length) {
    throw new Error('signing report outputs are missing or duplicated');
  }
  const seenRoles = new Set();
  for (const output of report.outputs) {
    assertExactKeys(output, new Set(['name', 'role', 'sha256']), 'signing report output');
    if (!requiredRoles.includes(output.role) || seenRoles.has(output.role)) {
      throw new Error('signing report outputs are missing or duplicated');
    }
    if (output.name !== expectedOutputName(report.platform, output.role) || !DIGEST.test(output.sha256 || '')) {
      throw new Error('invalid signing report output');
    }
    seenRoles.add(output.role);
  }
  const zxpOutput = report.outputs.find((output) => output.role === 'zxp');
  const zxpEvidence = report.steps.find((step) => step.id === 'verify-zxp');
  if (!zxpOutput || !zxpEvidence || zxpEvidence.outputSha256 !== zxpOutput.sha256) {
    throw new Error('signing report ZXP bytes do not match verified evidence');
  }
  if (report.platform === 'macos-arm64') {
    const dmgOutput = report.outputs.find((output) => output.role === 'dmg');
    const gatekeeperEvidence = report.steps.find((step) => step.id === 'verify-gatekeeper');
    if (!dmgOutput || !gatekeeperEvidence
        || gatekeeperEvidence.outputSha256 !== dmgOutput.sha256) {
      throw new Error('signing report DMG bytes do not match verified evidence');
    }
  }
}

export async function writeSigningReport(path, report) {
  validateSigningReport(report);
  if (typeof path !== 'string' || path.includes('\0')) throw new Error('invalid signing report path');
  await writeFile(path, canonicalStringify(report), {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}
