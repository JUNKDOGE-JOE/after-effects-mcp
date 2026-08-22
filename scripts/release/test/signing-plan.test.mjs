import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSigningPlan } from '../../package/signing-plan.mjs';
import {
  buildReleaseSigningCommands,
  redactReleaseSigningCommand,
  validateReleaseStepEvidence,
} from '../run-signing-plan.mjs';

const CANDIDATE_SHA = 'a'.repeat(40);
const DIGEST_A = '1'.repeat(64);
const DIGEST_B = '2'.repeat(64);
const DIGEST_C = '3'.repeat(64);

async function signingInput(t, platform) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ae-mcp-release-signing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = {
    platform,
    version: '0.10.0',
    candidateSha: CANDIDATE_SHA,
    stageRoot: path.join(root, 'stage'),
    signingRoot: path.join(root, 'signing'),
    outRoot: path.join(root, 'out'),
  };
  return { input, root };
}

test('release signing commands expose one direct ZXP command per platform', async (t) => {
  const windows = await signingInput(t, 'windows-x64');
  const windowsCommands = buildReleaseSigningCommands(windows.input, {
    sourceStageSha256: DIGEST_A,
  });
  assert.deepEqual(windowsCommands.map((item) => item.label), ['sign-zxp']);
  assert.deepEqual(windowsCommands[0].expectedStepIds, ['sign-zxp', 'verify-zxp']);
  assert.doesNotMatch(windowsCommands[0].args.join(' '), /python|sidecar|runtime|helper/iu);

  const mac = await signingInput(t, 'macos-arm64');
  const macCommands = buildReleaseSigningCommands({
    ...mac.input,
    stageRoot: '/tmp/ae-mcp-stage',
    signingRoot: '/tmp/ae-mcp-signing',
    outRoot: '/tmp/ae-mcp-out',
  }, { sourceStageSha256: DIGEST_A });
  assert.deepEqual(macCommands.map((item) => item.label), ['sign-zxp', 'package-macos-dmg']);
});

test('release evidence follows freeze, direct ZXP, then verification order', () => {
  const plan = buildSigningPlan('windows-x64');
  const evidence = [
    { id: 'freeze-signed-manifests', inputSha256: DIGEST_A, outputSha256: DIGEST_B, exitCode: 0 },
    { id: 'sign-zxp', inputSha256: DIGEST_B, outputSha256: DIGEST_C, exitCode: 0 },
    { id: 'verify-zxp', inputSha256: DIGEST_C, outputSha256: DIGEST_C, exitCode: 0 },
  ];
  assert.doesNotThrow(() => validateReleaseStepEvidence(plan, evidence));
  assert.throws(() => validateReleaseStepEvidence(plan, evidence.slice(1)), /step order/iu);
});

test('release command redaction preserves the direct command shape', () => {
  const command = {
    label: 'sign-zxp',
    args: ['ZXPSignCmd', '-sign', 'stage', 'out.zxp', 'certificate.p12'],
    secretArgIndexes: [4],
  };
  assert.deepEqual(redactReleaseSigningCommand(command).args, [
    'ZXPSignCmd',
    '-sign',
    'stage',
    'out.zxp',
    '<redacted>',
  ]);
});
