#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalJson,
  readCanonicalJsonFile,
  sha256File,
  writeCanonicalJson,
} from '../package/lib/manifest.mjs';
import {
  buildSigningPlan,
  readSigningSliceEvidence,
  signingError,
  validateSigningSliceEvidence,
} from '../package/signing-plan.mjs';

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
    throw phase0Error('PHASE0_EVIDENCE_INVALID', `${field} must be a lowercase SHA-256 digest`);
  }
}

function assertPhase0Root(outputRoot, platform) {
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) {
    throw phase0Error('PHASE0_OUTPUT_ROOT_INVALID', 'disposable output root must be absolute');
  }
  const parts = path.resolve(outputRoot).split(path.sep).filter(Boolean);
  const suffix = parts.slice(-4);
  if (JSON.stringify(suffix) !== JSON.stringify(['build', 'phase0', 'signing', platform])) {
    throw phase0Error(
      'PHASE0_OUTPUT_ROOT_INVALID',
      `disposable output root must end in build/phase0/signing/${platform}`,
    );
  }
}

export function phase0FinalArtifactPath({ outputRoot, platform }) {
  buildSigningPlan(platform);
  return path.join(
    outputRoot,
    platform === 'macos-arm64'
      ? 'ae-mcp-panel-phase0-macos-arm64.dmg'
      : 'ae-mcp-panel-phase0-windows-x64.zxp',
  );
}

function validatePhase0Envelope(evidence, expectedPlatform, expectedStageSha256) {
  const exactTop = [
    'schemaVersion',
    'platform',
    'sourceStageSha256',
    'disposableOutputRoot',
    'steps',
    'verifiedIdentity',
    'verifiedAt',
    'publicationAttempted',
  ];
  if (!exactKeys(evidence, exactTop) || evidence.schemaVersion !== 1) {
    throw phase0Error('PHASE0_EVIDENCE_INVALID', 'invalid Phase 0 signing evidence envelope');
  }
  if (evidence.publicationAttempted !== false) {
    throw phase0Error(
      'PHASE0_PUBLICATION_FORBIDDEN',
      'Phase 0 signing output cannot claim or attempt publication',
    );
  }
  if (evidence.platform !== expectedPlatform) {
    throw phase0Error('PHASE0_PLATFORM_MISMATCH', 'Phase 0 signing platform does not match');
  }
  assertSha256(evidence.sourceStageSha256, 'sourceStageSha256');
  if (evidence.sourceStageSha256 !== expectedStageSha256) {
    throw phase0Error('PHASE0_STAGE_DIGEST_MISMATCH', 'source stage digest does not match');
  }
  if (typeof evidence.verifiedAt !== 'string'
      || Number.isNaN(Date.parse(evidence.verifiedAt))
      || new Date(evidence.verifiedAt).toISOString() !== evidence.verifiedAt) {
    throw phase0Error('PHASE0_EVIDENCE_INVALID', 'verifiedAt must be canonical UTC time');
  }
  assertPhase0Root(evidence.disposableOutputRoot, expectedPlatform);
}

function assertFullPlanSteps(evidence, platform) {
  const expectedStepIds = buildSigningPlan(platform).steps.map((step) => step.id);
  if (!Array.isArray(evidence.steps)) {
    throw phase0Error('PHASE0_EVIDENCE_INVALID', 'Phase 0 signing steps are required');
  }
  const actualIds = evidence.steps.map((step) => step?.id);
  if (actualIds.length !== expectedStepIds.length) {
    throw phase0Error(
      'PHASE0_UNSIGNED_NESTED_CODE',
      'Phase 0 evidence omitted a required signing or verification category',
    );
  }
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedStepIds)) {
    throw phase0Error('SIGNING_STEP_ORDER_INVALID', 'Phase 0 signing steps are reordered');
  }
  for (const step of evidence.steps) {
    if (typeof step?.inputSha256 !== 'string'
        || typeof step?.outputSha256 !== 'string'
        || !SHA256_PATTERN.test(step.inputSha256)
        || !SHA256_PATTERN.test(step.outputSha256)) {
      throw phase0Error('SIGNING_STEP_DIGEST_INVALID', 'Phase 0 step digest is missing or invalid');
    }
  }
  for (let index = 1; index < evidence.steps.length; index += 1) {
    if (evidence.steps[index]?.inputSha256 !== evidence.steps[index - 1]?.outputSha256) {
      throw phase0Error('SIGNING_DIGEST_CHAIN_INVALID', 'Phase 0 signing digest chain is broken');
    }
  }
  const definitions = signingSliceDefinitions(platform);
  if (!exactKeys(evidence.verifiedIdentity, definitions.map((item) => item.key))) {
    throw phase0Error('SIGNING_IDENTITY_INVALID', 'Phase 0 aggregate identity is invalid');
  }
  let cursor = 0;
  for (const [index, definition] of definitions.entries()) {
    if (index === 1) {
      const freezeStep = evidence.steps[cursor];
      if (!exactKeys(freezeStep, ['id', 'inputSha256', 'outputSha256', 'exitCode'])
          || freezeStep.id !== 'freeze-signed-manifests'
          || freezeStep.exitCode !== 0) {
        throw phase0Error(
          'SIGNING_STEP_INVALID',
          'manifest-freeze evidence is missing or malformed',
        );
      }
      cursor += 1;
    }
    const steps = evidence.steps.slice(cursor, cursor + definition.ids.length);
    validateSigningSliceEvidence({
      evidence: {
        schemaVersion: evidence.schemaVersion,
        platform: evidence.platform,
        sourceStageSha256: evidence.sourceStageSha256,
        steps,
        verifiedIdentity: evidence.verifiedIdentity[definition.key],
      },
      platform,
      expectedStepIds: steps.map((step) => step.id),
      expectedInputSha256: steps[0].inputSha256,
      expectedStageSha256: evidence.sourceStageSha256,
    });
    cursor += definition.ids.length;
  }
  if (cursor !== evidence.steps.length) {
    throw phase0Error('PHASE0_UNSIGNED_NESTED_CODE', 'Phase 0 signing coverage is incomplete');
  }
  if (platform === 'macos-arm64') {
    const nested = evidence.verifiedIdentity.nested;
    const dmg = evidence.verifiedIdentity.dmg;
    if (nested.certificateFingerprint !== dmg.certificateFingerprint
        || nested.developerIdTeamId !== dmg.developerIdTeamId) {
      throw phase0Error('PHASE0_IDENTITY_MISMATCH', 'Mac nested and DMG identities do not match');
    }
  }
}

function signingSliceDefinitions(platform) {
  return platform === 'macos-arm64'
    ? [
      {
        key: 'nested',
        ids: ['sign-helper', 'sign-xpc', 'sign-addon', 'sign-launcher', 'verify-nested'],
      },
      { key: 'zxp', ids: ['sign-zxp', 'verify-zxp'] },
      {
        key: 'dmg',
        ids: ['build-dmg', 'sign-dmg', 'notarize-dmg', 'staple-dmg', 'verify-gatekeeper'],
      },
    ]
    : [
      {
        key: 'nested',
        ids: ['sign-helper', 'sign-addon', 'sign-launcher', 'verify-authenticode'],
      },
      { key: 'zxp', ids: ['sign-zxp', 'verify-zxp'] },
    ];
}

function assertEvidenceLocation(evidencePath, evidence) {
  if (typeof evidencePath !== 'string' || !path.isAbsolute(evidencePath)) {
    throw phase0Error('PHASE0_EVIDENCE_PATH_FORBIDDEN', 'evidence path must be absolute');
  }
  const expected = path.join(evidence.disposableOutputRoot, 'phase0-signing-evidence.json');
  if (path.resolve(evidencePath) !== path.resolve(expected)) {
    throw phase0Error(
      'PHASE0_EVIDENCE_PATH_FORBIDDEN',
      'signing evidence must be the canonical file inside its disposable output root',
    );
  }
}

async function readCanonicalEvidence(evidencePath) {
  let evidence;
  try {
    evidence = await readCanonicalJsonFile(evidencePath);
  } catch (error) {
    if (error.code === 'BUNDLE_MANIFEST_NONCANONICAL') {
      throw phase0Error('PHASE0_EVIDENCE_NONCANONICAL', 'Phase 0 evidence is not canonical JSON');
    }
    throw error;
  }
  return evidence;
}

async function readFreezeStepEvidence({
  evidencePath,
  outputRoot,
  platform,
  sourceStageSha256,
}) {
  const resolvedPath = path.resolve(String(evidencePath ?? ''));
  const expectedPath = path.join(path.resolve(outputRoot), 'freeze-evidence.json');
  if (resolvedPath !== expectedPath) {
    throw phase0Error(
      'PHASE0_EVIDENCE_PATH_FORBIDDEN',
      'freeze evidence must be the canonical file inside the disposable output root',
    );
  }
  const evidence = await readCanonicalEvidence(resolvedPath);
  if (!exactKeys(evidence, ['schemaVersion', 'platform', 'sourceStageSha256', 'step'])
      || evidence.schemaVersion !== 1
      || evidence.platform !== platform
      || evidence.sourceStageSha256 !== sourceStageSha256
      || !exactKeys(evidence.step, ['id', 'inputSha256', 'outputSha256', 'exitCode'])
      || evidence.step.id !== 'freeze-signed-manifests'
      || evidence.step.exitCode !== 0) {
    throw phase0Error('SIGNING_STEP_INVALID', 'manifest-freeze evidence is malformed');
  }
  assertSha256(evidence.step.inputSha256, 'freeze step inputSha256');
  assertSha256(evidence.step.outputSha256, 'freeze step outputSha256');
  return evidence.step;
}

export async function verifyPhase0SigningEvidence({
  evidencePath,
  expectedPlatform,
  expectedStageSha256,
  expectedIdentity,
}) {
  buildSigningPlan(expectedPlatform);
  assertSha256(expectedStageSha256, 'expectedStageSha256');
  const resolvedEvidencePath = path.resolve(evidencePath);
  const evidence = await readCanonicalEvidence(resolvedEvidencePath);
  validatePhase0Envelope(evidence, expectedPlatform, expectedStageSha256);
  assertEvidenceLocation(resolvedEvidencePath, evidence);
  if (expectedIdentity !== undefined
      && canonicalJson(evidence.verifiedIdentity) !== canonicalJson(expectedIdentity)) {
    throw phase0Error('PHASE0_IDENTITY_MISMATCH', 'Phase 0 verified identity does not match');
  }
  assertFullPlanSteps(evidence, expectedPlatform);
  const finalArtifact = phase0FinalArtifactPath({
    outputRoot: evidence.disposableOutputRoot,
    platform: expectedPlatform,
  });
  const finalDigest = await sha256File(finalArtifact).catch((error) => {
    throw phase0Error('PHASE0_OUTPUT_CHANGED', `Phase 0 final output is unavailable: ${error.code ?? 'read'}`);
  });
  if (evidence.steps.at(-1).outputSha256 !== finalDigest) {
    throw phase0Error('PHASE0_OUTPUT_CHANGED', 'Phase 0 final output changed after signing');
  }
  return evidence;
}

export async function writePhase0SigningEvidence({ evidencePath, evidence }) {
  const resolvedEvidencePath = path.resolve(evidencePath);
  validatePhase0Envelope(evidence, evidence.platform, evidence.sourceStageSha256);
  assertEvidenceLocation(resolvedEvidencePath, evidence);
  assertFullPlanSteps(evidence, evidence.platform);
  await fs.promises.mkdir(path.dirname(resolvedEvidencePath), { recursive: true });
  await writeCanonicalJson(resolvedEvidencePath, evidence);
  try {
    return await verifyPhase0SigningEvidence({
      evidencePath: resolvedEvidencePath,
      expectedPlatform: evidence.platform,
      expectedStageSha256: evidence.sourceStageSha256,
      expectedIdentity: evidence.verifiedIdentity,
    });
  } catch (error) {
    await fs.promises.rm(resolvedEvidencePath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function assemblePhase0SigningEvidence({
  outputRoot,
  platform,
  sliceEvidencePaths,
  freezeEvidencePath,
  sourceStageSha256,
  verifiedAt = new Date().toISOString(),
}) {
  const definitions = platform === 'macos-arm64'
    ? [
      { key: 'nested', ids: ['sign-helper', 'sign-xpc', 'sign-addon', 'sign-launcher', 'verify-nested'] },
      { key: 'zxp', ids: ['sign-zxp', 'verify-zxp'] },
      { key: 'dmg', ids: ['build-dmg', 'sign-dmg', 'notarize-dmg', 'staple-dmg', 'verify-gatekeeper'] },
    ]
    : [
      { key: 'nested', ids: ['sign-helper', 'sign-addon', 'sign-launcher', 'verify-authenticode'] },
      { key: 'zxp', ids: ['sign-zxp', 'verify-zxp'] },
    ];
  if (!Array.isArray(sliceEvidencePaths) || sliceEvidencePaths.length !== definitions.length) {
    throw phase0Error('PHASE0_EVIDENCE_INVALID', 'all reusable signing slices are required');
  }
  const slices = [];
  for (let index = 0; index < definitions.length; index += 1) {
    slices.push(await readSigningSliceEvidence({
      evidencePath: path.resolve(sliceEvidencePaths[index]),
      platform,
      expectedStepIds: definitions[index].ids,
      expectedStageSha256: sourceStageSha256,
    }));
  }
  const freezeStep = await readFreezeStepEvidence({
    evidencePath: freezeEvidencePath,
    outputRoot,
    platform,
    sourceStageSha256,
  });
  if (freezeStep.inputSha256 !== slices[0].steps.at(-1).outputSha256
      || slices[1].steps[0].inputSha256 !== freezeStep.outputSha256) {
    throw phase0Error('SIGNING_DIGEST_CHAIN_INVALID', 'manifest-freeze evidence does not chain');
  }
  for (let index = 2; index < slices.length; index += 1) {
    if (slices[index].steps[0].inputSha256 !== slices[index - 1].steps.at(-1).outputSha256) {
      throw phase0Error('SIGNING_DIGEST_CHAIN_INVALID', 'reusable signing slices do not chain');
    }
  }
  const evidence = {
    schemaVersion: 1,
    platform,
    sourceStageSha256,
    disposableOutputRoot: path.resolve(outputRoot),
    steps: [
      ...slices[0].steps,
      freezeStep,
      ...slices.slice(1).flatMap((slice) => slice.steps),
    ],
    verifiedIdentity: Object.fromEntries(
      definitions.map((definition, index) => [definition.key, slices[index].verifiedIdentity]),
    ),
    verifiedAt,
    publicationAttempted: false,
  };
  const evidencePath = path.join(evidence.disposableOutputRoot, 'phase0-signing-evidence.json');
  return writePhase0SigningEvidence({ evidencePath, evidence });
}

function parseCli(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--evidence', '--platform', '--stage'].includes(name) || value === undefined) {
      throw phase0Error('PHASE0_ARGUMENT_INVALID', `invalid argument: ${String(name)}`);
    }
    if (values.has(name)) throw phase0Error('PHASE0_ARGUMENT_INVALID', `duplicate argument: ${name}`);
    values.set(name, value);
  }
  for (const required of ['--evidence', '--platform', '--stage']) {
    if (!values.has(required)) throw phase0Error('PHASE0_ARGUMENT_INVALID', `${required} is required`);
  }
  return Object.fromEntries(values);
}

async function main(argv) {
  const options = parseCli(argv);
  const stageRoot = path.resolve(options['--stage']);
  const stageManifestPath = path.join(stageRoot, 'bundle-manifest.json');
  const expectedStageSha256 = await sha256File(stageManifestPath);
  await verifyPhase0SigningEvidence({
    evidencePath: path.resolve(options['--evidence']),
    expectedPlatform: options['--platform'],
    expectedStageSha256,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === 'string' ? error.code : 'PHASE0_VERIFY_FAILED';
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
