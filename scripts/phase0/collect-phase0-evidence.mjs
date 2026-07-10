#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  readCanonicalJsonFile,
  sha256File,
  writeCanonicalJson,
} from '../package/lib/manifest.mjs';
import { buildSigningPlan, signingError } from '../package/signing-plan.mjs';
import { verifyPhase0SigningEvidence } from './verify-signing-evidence.mjs';

const PLATFORM_IDS = ['macos-arm64', 'windows-x64'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function phase0Error(code, message) {
  return signingError(code, message);
}

function exactKeys(value, expected) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function assertSha256(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw phase0Error('PHASE0_HELPER_EVIDENCE_INVALID', `${field} must be a SHA-256 digest`);
  }
}

export function validateHelperPhase0Evidence(evidence, expectedPlatform) {
  const keys = [
    'schemaVersion',
    'kind',
    'platform',
    'helperIdentity',
    'afterEffects',
    'backendAccess',
    'signingOutputSha256',
    'adversarialCases',
  ];
  if (!exactKeys(evidence, keys)
      || evidence.schemaVersion !== 1
      || evidence.kind !== 'helper-platform'
      || !PLATFORM_IDS.includes(evidence.platform)
      || (expectedPlatform !== undefined && evidence.platform !== expectedPlatform)
      || typeof evidence.helperIdentity !== 'string'
      || evidence.helperIdentity.length < 1
      || evidence.helperIdentity.length > 256) {
    throw phase0Error('PHASE0_HELPER_EVIDENCE_INVALID', 'invalid helper evidence envelope');
  }
  if (!exactKeys(evidence.afterEffects, ['25', '26'])) {
    throw phase0Error('PHASE0_HELPER_EVIDENCE_INVALID', 'AE 25 and AE 26 results are required');
  }
  for (const major of ['25', '26']) {
    if (!exactKeys(evidence.afterEffects[major], ['result'])
        || evidence.afterEffects[major].result !== 'PASS') {
      throw phase0Error('PHASE0_HELPER_EVIDENCE_INVALID', `AE ${major} must pass`);
    }
  }
  if (!exactKeys(evidence.backendAccess, ['secret', 'capture'])) {
    throw phase0Error('PHASE0_HELPER_EVIDENCE_INVALID', 'secret and capture counters are required');
  }
  for (const backend of ['secret', 'capture']) {
    const counters = evidence.backendAccess[backend];
    if (!exactKeys(counters, ['authorized', 'rejectedBeforeAccess'])
        || !Number.isSafeInteger(counters.authorized)
        || counters.authorized < 1
        || !Number.isSafeInteger(counters.rejectedBeforeAccess)
        || counters.rejectedBeforeAccess < 1) {
      throw phase0Error('PHASE0_HELPER_EVIDENCE_INVALID', `${backend} counters are invalid`);
    }
  }
  assertSha256(evidence.signingOutputSha256, 'signingOutputSha256');
  if (!Array.isArray(evidence.adversarialCases) || evidence.adversarialCases.length < 1) {
    throw phase0Error('PHASE0_HELPER_EVIDENCE_INVALID', 'adversarial results are required');
  }
  const ids = new Set();
  for (const item of evidence.adversarialCases) {
    if (!exactKeys(item, ['id', 'result', 'backendAccessCount'])
        || typeof item.id !== 'string'
        || item.id.length < 1
        || item.result !== 'REJECTED'
        || item.backendAccessCount !== 0
        || ids.has(item.id)) {
      throw phase0Error('PHASE0_HELPER_EVIDENCE_INVALID', 'invalid adversarial result');
    }
    ids.add(item.id);
  }
  return evidence;
}

function validatePlatformInputs(helperEvidencePaths, signingEvidencePaths) {
  if (!Array.isArray(helperEvidencePaths)
      || !Array.isArray(signingEvidencePaths)
      || helperEvidencePaths.length !== 2
      || signingEvidencePaths.length !== 2) {
    throw phase0Error(
      'PHASE0_PLATFORM_SET_INVALID',
      'exactly two helper and two signing evidence files are required',
    );
  }
}

async function readPair(helperPath, signingPath) {
  const signingEvidenceSha256 = await sha256File(signingPath);
  const helper = validateHelperPhase0Evidence(await readCanonicalJsonFile(helperPath));
  const signing = await readCanonicalJsonFile(signingPath);
  buildSigningPlan(signing.platform);
  if (helper.platform !== signing.platform) {
    throw phase0Error(
      'PHASE0_PLATFORM_PAIR_MISMATCH',
      'helper and signing evidence platform IDs do not match',
    );
  }
  if (helper.signingOutputSha256 !== signingEvidenceSha256) {
    throw phase0Error(
      'PHASE0_SIGNING_OUTPUT_MISMATCH',
      'helper evidence does not bind the paired signing evidence bytes',
    );
  }
  await verifyPhase0SigningEvidence({
    evidencePath: path.resolve(signingPath),
    expectedPlatform: signing.platform,
    expectedStageSha256: signing.sourceStageSha256,
  });
  if (await sha256File(signingPath) !== signingEvidenceSha256) {
    throw phase0Error('PHASE0_EVIDENCE_DIGEST_MISMATCH', 'signing evidence changed while merging');
  }
  return { helper, signing, signingEvidenceSha256 };
}

function validateMergedEnvelope(evidence) {
  if (!exactKeys(evidence, ['schemaVersion', 'kind', 'platforms'])
      || evidence.schemaVersion !== 1
      || evidence.kind !== 'platform-helper'
      || !exactKeys(evidence.platforms, PLATFORM_IDS)) {
    throw phase0Error('PHASE0_MERGED_EVIDENCE_INVALID', 'invalid merged Phase 0 evidence');
  }
  for (const platform of PLATFORM_IDS) {
    const record = evidence.platforms[platform];
    if (!exactKeys(record, [
      'helperEvidenceSha256',
      'signingEvidenceSha256',
      'sourceStageSha256',
    ])) {
      throw phase0Error('PHASE0_MERGED_EVIDENCE_INVALID', `invalid ${platform} digest record`);
    }
    for (const [field, value] of Object.entries(record)) assertSha256(value, field);
  }
}

export async function mergePhase0Evidence({
  helperEvidencePaths,
  signingEvidencePaths,
  outPath,
}) {
  validatePlatformInputs(helperEvidencePaths, signingEvidencePaths);
  if (typeof outPath !== 'string' || !path.isAbsolute(outPath)) {
    throw phase0Error('PHASE0_ARGUMENT_INVALID', 'merged evidence output must be absolute');
  }
  const platforms = {};
  for (let index = 0; index < 2; index += 1) {
    const helperPath = path.resolve(helperEvidencePaths[index]);
    const signingPath = path.resolve(signingEvidencePaths[index]);
    const { helper, signing, signingEvidenceSha256 } = await readPair(helperPath, signingPath);
    if (platforms[helper.platform]) {
      throw phase0Error('PHASE0_PLATFORM_SET_INVALID', 'platform evidence is duplicated');
    }
    platforms[helper.platform] = {
      helperEvidenceSha256: await sha256File(helperPath),
      signingEvidenceSha256,
      sourceStageSha256: signing.sourceStageSha256,
    };
  }
  if (!PLATFORM_IDS.every((platform) => platforms[platform])) {
    throw phase0Error('PHASE0_PLATFORM_SET_INVALID', 'both supported platforms are required');
  }
  const merged = { schemaVersion: 1, kind: 'platform-helper', platforms };
  validateMergedEnvelope(merged);
  await writeCanonicalJson(outPath, merged);
  return merged;
}

export async function validateMergedPhase0Evidence({
  evidencePath,
  helperEvidencePaths,
  signingEvidencePaths,
}) {
  validatePlatformInputs(helperEvidencePaths, signingEvidencePaths);
  const evidence = await readCanonicalJsonFile(evidencePath);
  validateMergedEnvelope(evidence);
  const seenPlatforms = new Set();
  for (let index = 0; index < 2; index += 1) {
    const helperPath = path.resolve(helperEvidencePaths[index]);
    const signingPath = path.resolve(signingEvidencePaths[index]);
    const helper = validateHelperPhase0Evidence(await readCanonicalJsonFile(helperPath));
    if (seenPlatforms.has(helper.platform)) {
      throw phase0Error('PHASE0_PLATFORM_SET_INVALID', 'source platform evidence is duplicated');
    }
    seenPlatforms.add(helper.platform);
    const record = evidence.platforms[helper.platform];
    const signingEvidenceSha256 = await sha256File(signingPath);
    if (!record
        || record.helperEvidenceSha256 !== await sha256File(helperPath)
        || record.signingEvidenceSha256 !== signingEvidenceSha256) {
      throw phase0Error(
        'PHASE0_EVIDENCE_DIGEST_MISMATCH',
        'merged Phase 0 evidence digest does not match its source file',
      );
    }
    if (helper.signingOutputSha256 !== signingEvidenceSha256) {
      throw phase0Error(
        'PHASE0_SIGNING_OUTPUT_MISMATCH',
        'helper evidence does not bind the paired signing evidence bytes',
      );
    }
    const signing = await readCanonicalJsonFile(signingPath);
    if (signing.platform !== helper.platform) {
      throw phase0Error('PHASE0_PLATFORM_PAIR_MISMATCH', 'source platform pair does not match');
    }
    if (record.sourceStageSha256 !== signing.sourceStageSha256) {
      throw phase0Error('PHASE0_EVIDENCE_DIGEST_MISMATCH', 'source stage digest does not match');
    }
    await verifyPhase0SigningEvidence({
      evidencePath: signingPath,
      expectedPlatform: signing.platform,
      expectedStageSha256: signing.sourceStageSha256,
    });
    if (await sha256File(signingPath) !== signingEvidenceSha256) {
      throw phase0Error('PHASE0_EVIDENCE_DIGEST_MISMATCH', 'signing evidence changed during validation');
    }
  }
  if (!PLATFORM_IDS.every((platform) => seenPlatforms.has(platform))) {
    throw phase0Error('PHASE0_PLATFORM_SET_INVALID', 'both source platforms are required exactly once');
  }
  return evidence;
}

function parseMergeCli(argv) {
  const mergeIndex = argv.indexOf('--merge');
  const signingIndex = argv.indexOf('--signing-evidence');
  const outIndex = argv.indexOf('--out');
  if (mergeIndex !== 0
      || signingIndex !== 3
      || outIndex !== 6
      || argv.length !== 8) {
    throw phase0Error(
      'PHASE0_ARGUMENT_INVALID',
      'expected --merge <mac-helper> <win-helper> --signing-evidence <mac-signing> <win-signing> --out <path>',
    );
  }
  return {
    helperEvidencePaths: [path.resolve(argv[1]), path.resolve(argv[2])],
    signingEvidencePaths: [path.resolve(argv[4]), path.resolve(argv[5])],
    outPath: path.resolve(argv[7]),
  };
}

async function main(argv) {
  await mergePhase0Evidence(parseMergeCli(argv));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : 'PHASE0_COLLECTION_FAILED';
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
