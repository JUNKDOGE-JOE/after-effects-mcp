import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertSigningPaths,
  buildSigningPlan,
  redactSigningCommand,
  validateSigningSliceEvidence,
} from '../signing-plan.mjs';

const STAGE_SHA = 'a'.repeat(64);
const ZXP_SHA = 'b'.repeat(64);
const CERTIFICATE_SHA = 'c'.repeat(64);

function zxpEvidence(platform = 'windows-x64') {
  return {
    schemaVersion: 1,
    platform,
    sourceStageSha256: STAGE_SHA,
    steps: [
      { id: 'sign-zxp', inputSha256: STAGE_SHA, outputSha256: ZXP_SHA, exitCode: 0 },
      { id: 'verify-zxp', inputSha256: ZXP_SHA, outputSha256: ZXP_SHA, exitCode: 0 },
    ],
    verifiedIdentity: {
      zxpCertificateFingerprint: CERTIFICATE_SHA,
      zxpPayloadSha256: ZXP_SHA,
      zxpVerified: true,
    },
  };
}

test('both platforms use one direct ZXP signing boundary', () => {
  assert.deepEqual(buildSigningPlan('windows-x64').steps.map((step) => step.id), [
    'freeze-signed-manifests',
    'sign-zxp',
    'verify-zxp',
  ]);
  assert.deepEqual(buildSigningPlan('macos-arm64').steps.map((step) => step.id), [
    'freeze-signed-manifests',
    'sign-zxp',
    'verify-zxp',
    'build-dmg',
    'sign-dmg',
    'notarize-dmg',
    'staple-dmg',
    'verify-gatekeeper',
  ]);
  assert.throws(() => buildSigningPlan('linux-x64'), { code: 'SIGNING_PLATFORM_UNSUPPORTED' });
});

test('ZXP evidence validates the direct sign-then-verify slice', () => {
  const evidence = zxpEvidence();
  assert.deepEqual(validateSigningSliceEvidence({
    evidence,
    platform: 'windows-x64',
    expectedStepIds: ['sign-zxp', 'verify-zxp'],
    expectedInputSha256: STAGE_SHA,
    expectedStageSha256: STAGE_SHA,
    expectedIdentity: evidence.verifiedIdentity,
  }), evidence);

  assert.throws(() => validateSigningSliceEvidence({
    evidence: {
      ...evidence,
      steps: [evidence.steps[1], evidence.steps[0]],
    },
    platform: 'windows-x64',
    expectedStepIds: ['sign-zxp', 'verify-zxp'],
  }), { code: 'SIGNING_STEP_ORDER_INVALID' });
});

test('signing paths are absolute and non-overlapping', () => {
  const root = path.join(os.tmpdir(), 'ae-mcp-signing-plan');
  assert.doesNotThrow(() => assertSigningPaths({
    source: path.join(root, 'stage'),
    outputs: [path.join(root, 'out.zxp'), path.join(root, 'evidence.json')],
  }));
  assert.throws(() => assertSigningPaths({
    source: 'relative-stage',
    outputs: [path.join(root, 'out.zxp')],
  }), { code: 'SIGNING_PATH_ABSOLUTE_REQUIRED' });
  assert.throws(() => assertSigningPaths({
    source: path.join(root, 'stage'),
    outputs: [path.join(root, 'stage', 'nested.zxp')],
  }), { code: 'SIGNING_PATH_OVERLAP' });
});

test('signing command redaction covers named secret arguments', () => {
  const redacted = redactSigningCommand({
    executable: 'ZXPSignCmd',
    args: ['-sign', 'stage', 'out.zxp', '-tsa', 'https://tsa.example', '-credential', 'secret'],
  });
  assert.deepEqual(redacted.args, [
    '-sign',
    'stage',
    'out.zxp',
    '-tsa',
    'https://tsa.example',
    '-credential',
    '<redacted>',
  ]);
});
