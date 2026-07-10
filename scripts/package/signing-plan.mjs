import fs from 'node:fs';
import path from 'node:path';

import {
  readCanonicalJsonFile,
  writeCanonicalJson,
} from './lib/manifest.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);

function signingError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function freezeStep(id, mutates) {
  return Object.freeze({ id, mutates: Object.freeze([...mutates]) });
}

const PLANS = Object.freeze({
  'macos-arm64': Object.freeze({
    platform: 'macos-arm64',
    steps: Object.freeze([
      freezeStep('sign-helper', ['platform/macos-arm64/bin/ae-mcp-platform-helper']),
      // Reserved category slots. The CEP architecture has no XPC or native addon today.
      freezeStep('sign-xpc', []),
      freezeStep('sign-addon', []),
      freezeStep('sign-launcher', ['platform/macos-arm64/bin/ae-mcp']),
      freezeStep('verify-nested', []),
      freezeStep('freeze-signed-manifests', [
        'platform/macos-arm64/helper-manifest.json',
        'bundle-manifest.json',
      ]),
      freezeStep('sign-zxp', ['artifact/zxp']),
      freezeStep('verify-zxp', []),
      freezeStep('build-dmg', ['artifact/dmg']),
      freezeStep('sign-dmg', ['artifact/dmg']),
      freezeStep('notarize-dmg', []),
      freezeStep('staple-dmg', ['artifact/dmg']),
      freezeStep('verify-gatekeeper', []),
    ]),
  }),
  'windows-x64': Object.freeze({
    platform: 'windows-x64',
    steps: Object.freeze([
      freezeStep('sign-helper', ['platform/windows-x64/bin/ae-mcp-platform-helper.exe']),
      // Fixed compatibility slot; a native addon is forbidden by the current architecture.
      freezeStep('sign-addon', []),
      freezeStep('sign-launcher', ['platform/windows-x64/bin/ae-mcp.exe']),
      freezeStep('verify-authenticode', []),
      freezeStep('freeze-signed-manifests', [
        'platform/windows-x64/helper-manifest.json',
        'bundle-manifest.json',
      ]),
      freezeStep('sign-zxp', ['artifact/zxp']),
      freezeStep('verify-zxp', []),
    ]),
  }),
});

export const SIGNING_STEP_IDS = Object.freeze([
  'sign-helper',
  'sign-xpc',
  'sign-addon',
  'sign-launcher',
  'verify-nested',
  'freeze-signed-manifests',
  'sign-zxp',
  'verify-zxp',
  'build-dmg',
  'sign-dmg',
  'notarize-dmg',
  'staple-dmg',
  'verify-gatekeeper',
  'verify-authenticode',
]);

export function buildSigningPlan(platform) {
  const plan = PLANS[platform];
  if (!plan) {
    throw signingError(
      'SIGNING_PLATFORM_UNSUPPORTED',
      `unsupported signing platform: ${String(platform)}`,
    );
  }
  return plan;
}

function pathFlavor(filePath) {
  if (path.win32.isAbsolute(filePath) && !path.isAbsolute(filePath)) return path.win32;
  return path;
}

function normalizedPath(filePath) {
  const flavor = pathFlavor(filePath);
  let resolved = flavor.resolve(filePath);
  if (flavor !== path.win32 || process.platform === 'win32') {
    const missing = [];
    let existing = resolved;
    while (!fs.existsSync(existing)) {
      const parent = flavor.dirname(existing);
      if (parent === existing) break;
      missing.unshift(flavor.basename(existing));
      existing = parent;
    }
    if (fs.existsSync(existing)) {
      resolved = flavor.join(fs.realpathSync.native(existing), ...missing);
    }
  }
  const root = flavor.parse(resolved).root;
  const normalized = resolved === root ? root : resolved.replace(/[\\/]+$/, '');
  return flavor === path.win32 ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(left, right) {
  const leftFlavor = pathFlavor(left);
  const rightFlavor = pathFlavor(right);
  if (leftFlavor !== rightFlavor) return false;
  const leftNormalized = normalizedPath(left);
  const rightNormalized = normalizedPath(right);
  if (leftNormalized === rightNormalized) return true;
  const separator = leftFlavor.sep;
  return leftNormalized.startsWith(`${rightNormalized}${separator}`)
    || rightNormalized.startsWith(`${leftNormalized}${separator}`);
}

export function assertSigningPaths({ source, outputs }) {
  if (typeof source !== 'string'
      || !(path.isAbsolute(source) || path.win32.isAbsolute(source))) {
    throw signingError('SIGNING_PATH_ABSOLUTE_REQUIRED', 'signing source must be absolute');
  }
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw signingError('SIGNING_PATH_INVALID', 'at least one signing output path is required');
  }
  const all = [source, ...outputs];
  for (const candidate of all) {
    if (typeof candidate !== 'string'
        || !(path.isAbsolute(candidate) || path.win32.isAbsolute(candidate))) {
      throw signingError(
        'SIGNING_PATH_ABSOLUTE_REQUIRED',
        'all signing source and output paths must be absolute',
      );
    }
  }
  for (let left = 0; left < all.length; left += 1) {
    for (let right = left + 1; right < all.length; right += 1) {
      if (pathsOverlap(all[left], all[right])) {
        throw signingError(
          'SIGNING_PATH_OVERLAP',
          'signing source and output paths must be distinct and non-overlapping',
        );
      }
    }
  }
}

function portablePath(value) {
  return String(value).replaceAll('\\', '/');
}

export function assertNestedNativeCoverage({ nativePaths, verifiedPaths }) {
  if (!Array.isArray(nativePaths) || !Array.isArray(verifiedPaths)) {
    throw signingError('SIGNING_NATIVE_COVERAGE_INVALID', 'native coverage lists are required');
  }
  const native = nativePaths.map(portablePath);
  const verified = new Set(verifiedPaths.map(portablePath));
  if (native.some((candidate) => candidate.toLowerCase().endsWith('.node'))) {
    throw signingError(
      'SIGNING_NATIVE_ADDON_FORBIDDEN',
      'native addons are forbidden by the CEP platform-helper architecture',
    );
  }
  const unsigned = native.filter((candidate) => !verified.has(candidate));
  if (unsigned.length > 0 || verified.size !== new Set(native).size) {
    throw signingError(
      'SIGNING_UNSIGNED_NESTED_CODE',
      `nested native code is not fully verified: ${unsigned.join(', ')}`,
    );
  }
}

const SENSITIVE_NAME = /(?:password|certificate|cert(?:ificate)?-?path|token|keychain(?:-?profile)?|credential)/i;

export function redactSigningCommand(command) {
  if (!command || typeof command !== 'object' || !Array.isArray(command.args)) {
    throw signingError('SIGNING_COMMAND_INVALID', 'signing command must contain an argument array');
  }
  const explicit = new Set(command.secretArgIndexes ?? []);
  const redactedArgs = command.args.map((argument, index) => {
    const text = String(argument);
    if (explicit.has(index)) return '<redacted>';
    if (index > 0 && SENSITIVE_NAME.test(String(command.args[index - 1]))) return '<redacted>';
    const equals = text.indexOf('=');
    if (equals > 0 && SENSITIVE_NAME.test(text.slice(0, equals))) {
      return `${text.slice(0, equals + 1)}<redacted>`;
    }
    return argument;
  });
  return { ...command, args: redactedArgs };
}

function exactKeys(value, expected) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sameJson(left, right) {
  const sort = (value) => {
    if (Array.isArray(value)) return value.map(sort);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]));
    }
    return value;
  };
  return JSON.stringify(sort(left)) === JSON.stringify(sort(right));
}

function assertSha256(value, code, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw signingError(code, `${field} must be a lowercase SHA-256 digest`);
  }
}

function validateExpectedSlice(platform, expectedStepIds) {
  if (!Array.isArray(expectedStepIds) || expectedStepIds.length === 0) {
    throw signingError('SIGNING_STEP_ORDER_INVALID', 'expected signing step IDs are required');
  }
  const full = buildSigningPlan(platform).steps.map((step) => step.id);
  const first = full.indexOf(expectedStepIds[0]);
  if (first < 0
      || JSON.stringify(full.slice(first, first + expectedStepIds.length))
        !== JSON.stringify(expectedStepIds)) {
    throw signingError('SIGNING_STEP_ORDER_INVALID', 'expected IDs are not a contiguous plan slice');
  }
}

function sliceKind(platform, ids) {
  const joined = ids.join(',');
  const kinds = platform === 'macos-arm64'
    ? new Map([
      ['sign-helper,sign-xpc,sign-addon,sign-launcher,verify-nested', 'nested'],
      ['sign-zxp,verify-zxp', 'zxp'],
      ['build-dmg,sign-dmg,notarize-dmg,staple-dmg,verify-gatekeeper', 'dmg'],
    ])
    : new Map([
      ['sign-helper,sign-addon,sign-launcher,verify-authenticode', 'nested'],
      ['sign-zxp,verify-zxp', 'zxp'],
    ]);
  const kind = kinds.get(joined);
  if (!kind) {
    throw signingError(
      'SIGNING_STEP_ORDER_INVALID',
      'signing evidence must contain one reviewed reusable-script slice',
    );
  }
  return kind;
}

function validateVerifiedIdentity(platform, kind, identity) {
  if (kind === 'zxp') {
    if (!exactKeys(identity, [
      'zxpCertificateFingerprint', 'zxpPayloadSha256', 'zxpVerified',
    ])
        || !/^[a-f0-9]{64}$/.test(identity.zxpCertificateFingerprint || '')
        || !/^[a-f0-9]{64}$/.test(identity.zxpPayloadSha256 || '')
        || identity.zxpVerified !== true) {
      throw signingError(
        'SIGNING_IDENTITY_INVALID',
        'ZXP identity must bind the audited certificate and payload',
      );
    }
    return;
  }
  if (platform === 'windows-x64') {
    if (!exactKeys(identity, ['authenticodeSignerThumbprint', 'timestampVerified'])
        || typeof identity.authenticodeSignerThumbprint !== 'string'
        || !/^[0-9A-F]{40}$/.test(identity.authenticodeSignerThumbprint)
        || identity.timestampVerified !== true) {
      throw signingError('SIGNING_IDENTITY_INVALID', 'invalid Authenticode identity evidence');
    }
    return;
  }
  const baseValid = identity
    && typeof identity === 'object'
    && typeof identity.certificateFingerprint === 'string'
    && /^[0-9a-f]{64}$/.test(identity.certificateFingerprint)
    && typeof identity.developerIdTeamId === 'string'
    && /^[A-Z0-9]{10}$/.test(identity.developerIdTeamId);
  if (kind === 'nested') {
    if (!baseValid || !exactKeys(identity, ['certificateFingerprint', 'developerIdTeamId'])) {
      throw signingError('SIGNING_IDENTITY_INVALID', 'invalid Developer ID identity evidence');
    }
    return;
  }
  if (!baseValid
      || !exactKeys(identity, [
        'certificateFingerprint',
        'developerIdTeamId',
        'notarySubmissionId',
        'stapledTicketVerified',
        'gatekeeperVerified',
      ])
      || typeof identity.notarySubmissionId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        identity.notarySubmissionId,
      )
      || identity.stapledTicketVerified !== true
      || identity.gatekeeperVerified !== true) {
    throw signingError('SIGNING_IDENTITY_INVALID', 'invalid notarized DMG identity evidence');
  }
}

export function validateSigningSliceEvidence({
  evidence,
  platform,
  expectedStepIds,
  expectedInputSha256,
  expectedStageSha256,
  expectedIdentity,
}) {
  buildSigningPlan(platform);
  validateExpectedSlice(platform, expectedStepIds);
  const kind = sliceKind(platform, expectedStepIds);
  if (!exactKeys(evidence, [
    'schemaVersion', 'platform', 'sourceStageSha256', 'steps', 'verifiedIdentity',
  ])
      || evidence.schemaVersion !== 1
      || evidence.platform !== platform
      || !Array.isArray(evidence.steps)) {
    throw signingError('SIGNING_EVIDENCE_INVALID', 'invalid signing slice evidence envelope');
  }
  assertSha256(evidence.sourceStageSha256, 'SIGNING_STEP_DIGEST_INVALID', 'sourceStageSha256');
  if (expectedStageSha256 !== undefined && evidence.sourceStageSha256 !== expectedStageSha256) {
    throw signingError('SIGNING_STAGE_DIGEST_MISMATCH', 'source stage digest does not match');
  }
  validateVerifiedIdentity(platform, kind, evidence.verifiedIdentity);
  if (expectedIdentity !== undefined && !sameJson(evidence.verifiedIdentity, expectedIdentity)) {
    throw signingError('SIGNING_IDENTITY_MISMATCH', 'signing identity does not match');
  }
  const actualIds = evidence.steps.map((step) => step?.id);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedStepIds)) {
    throw signingError('SIGNING_STEP_ORDER_INVALID', 'signing evidence step order is invalid');
  }
  const planById = new Map(buildSigningPlan(platform).steps.map((step) => [step.id, step]));
  let priorOutput;
  for (const [index, step] of evidence.steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw signingError('SIGNING_STEP_INVALID', `invalid signing evidence step ${index}`);
    }
    if (!Object.hasOwn(step, 'inputSha256') || !Object.hasOwn(step, 'outputSha256')) {
      throw signingError('SIGNING_STEP_DIGEST_INVALID', `missing digest in signing step ${index}`);
    }
    if (!exactKeys(step, ['id', 'inputSha256', 'outputSha256', 'exitCode'])
        || step.exitCode !== 0) {
      throw signingError('SIGNING_STEP_INVALID', `invalid signing evidence step ${index}`);
    }
    assertSha256(step.inputSha256, 'SIGNING_STEP_DIGEST_INVALID', 'step inputSha256');
    assertSha256(step.outputSha256, 'SIGNING_STEP_DIGEST_INVALID', 'step outputSha256');
    if (index === 0 && expectedInputSha256 !== undefined
        && step.inputSha256 !== expectedInputSha256) {
      throw signingError('SIGNING_INPUT_DIGEST_MISMATCH', 'signing input digest does not match');
    }
    if (index > 0 && step.inputSha256 !== priorOutput) {
      throw signingError('SIGNING_DIGEST_CHAIN_INVALID', 'signing evidence digest chain is broken');
    }
    const planStep = planById.get(step.id);
    if (planStep.mutates.length === 0 && step.inputSha256 !== step.outputSha256) {
      throw signingError(
        'SIGNING_MUTATION_BOUNDARY_INVALID',
        `${step.id} is not permitted to mutate bytes`,
      );
    }
    priorOutput = step.outputSha256;
  }
  return evidence;
}

export async function readSigningSliceEvidence(input) {
  let evidence;
  try {
    evidence = await readCanonicalJsonFile(input.evidencePath);
  } catch (error) {
    if (error.code === 'BUNDLE_MANIFEST_NONCANONICAL') {
      throw signingError('SIGNING_EVIDENCE_NONCANONICAL', 'signing evidence must be canonical JSON');
    }
    throw error;
  }
  return validateSigningSliceEvidence({ ...input, evidence });
}

export async function writeSigningSliceEvidence({
  evidencePath,
  evidence,
  platform,
  expectedStepIds,
  expectedInputSha256,
  expectedStageSha256,
}) {
  if (typeof evidencePath !== 'string' || !path.isAbsolute(evidencePath)) {
    throw signingError('SIGNING_PATH_ABSOLUTE_REQUIRED', 'evidence path must be absolute');
  }
  validateSigningSliceEvidence({
    evidence,
    platform,
    expectedStepIds,
    expectedInputSha256,
    expectedStageSha256,
  });
  await writeCanonicalJson(evidencePath, evidence);
}

export { signingError };
