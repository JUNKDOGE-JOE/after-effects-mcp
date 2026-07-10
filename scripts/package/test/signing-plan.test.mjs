import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertNestedNativeCoverage,
  assertSigningPaths,
  buildSigningPlan,
  redactSigningCommand,
  validateSigningSliceEvidence,
} from '../signing-plan.mjs';
import { buildZxp } from '../build-zxp.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function identityFor(platform, ids) {
  if (ids[0] === 'sign-zxp') return { zxpVerified: true };
  if (ids[0] === 'build-dmg') {
    return {
      certificateFingerprint: 'd'.repeat(64),
      developerIdTeamId: 'TESTTEAM01',
      notarySubmissionId: '12345678-1234-4234-8234-123456789abc',
      stapledTicketVerified: true,
      gatekeeperVerified: true,
    };
  }
  if (platform === 'macos-arm64') {
    return {
      certificateFingerprint: 'd'.repeat(64),
      developerIdTeamId: 'TESTTEAM01',
    };
  }
  return {
    authenticodeSignerThumbprint: 'E'.repeat(40),
    timestampVerified: true,
  };
}

function chainedSlice(platform, ids, identity = identityFor(platform, ids)) {
  let inputSha256 = SHA_A;
  return {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SHA_A,
    verifiedIdentity: identity,
    steps: ids.map((id, index) => {
      const outputSha256 = index === ids.length - 1 ? SHA_C : SHA_B;
      const step = { id, inputSha256, outputSha256, exitCode: 0 };
      inputSha256 = outputSha256;
      return step;
    }),
  };
}

test('mac Phase 0 plan signs inward to outward', () => {
  assert.deepEqual(buildSigningPlan('macos-arm64').steps.map((step) => step.id), [
    'sign-helper', 'sign-xpc', 'sign-addon', 'sign-launcher',
    'verify-nested', 'sign-zxp', 'verify-zxp', 'build-dmg',
    'sign-dmg', 'notarize-dmg', 'staple-dmg', 'verify-gatekeeper',
  ]);
});

test('windows Phase 0 plan signs every shipped PE before the ZXP', () => {
  assert.deepEqual(buildSigningPlan('windows-x64').steps.map((step) => step.id), [
    'sign-helper', 'sign-addon', 'sign-launcher',
    'verify-authenticode', 'sign-zxp', 'verify-zxp',
  ]);
});

test('reserved XPC and addon slots cannot claim a mutation', () => {
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const plan = buildSigningPlan(platform);
    for (const id of ['sign-xpc', 'sign-addon']) {
      const step = plan.steps.find((candidate) => candidate.id === id);
      if (step) assert.deepEqual(step.mutates, []);
    }
  }
});

test('verification and notarization steps cannot claim byte mutations', () => {
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const plan = buildSigningPlan(platform);
    for (const step of plan.steps) {
      if (step.id.startsWith('verify-') || step.id === 'notarize-dmg') {
        assert.deepEqual(step.mutates, []);
      }
    }
  }
});

test('plans are immutable and reject unsupported platforms', () => {
  const plan = buildSigningPlan('macos-arm64');
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.steps), true);
  assert.equal(Object.isFrozen(plan.steps[0]), true);
  assert.equal(Object.isFrozen(plan.steps[0].mutates), true);
  assert.throws(() => buildSigningPlan('linux-x64'), {
    code: 'SIGNING_PLATFORM_UNSUPPORTED',
  });
});

test('signing paths must be absolute, distinct, and non-overlapping', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-signing-paths-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const output = path.join(root, 'output');
  const evidence = path.join(root, 'evidence.json');
  assert.doesNotThrow(() => assertSigningPaths({ source, outputs: [output, evidence] }));
  assert.throws(() => assertSigningPaths({ source: 'relative', outputs: [output] }), {
    code: 'SIGNING_PATH_ABSOLUTE_REQUIRED',
  });
  assert.throws(() => assertSigningPaths({ source, outputs: [source] }), {
    code: 'SIGNING_PATH_OVERLAP',
  });
  assert.throws(() => assertSigningPaths({ source, outputs: [path.join(source, 'inside')] }), {
    code: 'SIGNING_PATH_OVERLAP',
  });
  assert.throws(() => assertSigningPaths({ source, outputs: [output, path.join(output, 'inside')] }), {
    code: 'SIGNING_PATH_OVERLAP',
  });
  await fs.promises.mkdir(source);
  const alias = path.join(root, 'source-alias');
  await fs.promises.symlink(source, alias, 'dir');
  assert.throws(() => assertSigningPaths({ source, outputs: [path.join(alias, 'inside')] }), {
    code: 'SIGNING_PATH_OVERLAP',
  });
});

test('native coverage rejects an unsigned nested binary and all native addons', () => {
  assert.doesNotThrow(() => assertNestedNativeCoverage({
    nativePaths: ['bin/helper', 'bin/launcher'],
    verifiedPaths: ['bin/launcher', 'bin/helper'],
  }));
  assert.throws(() => assertNestedNativeCoverage({
    nativePaths: ['bin/helper', 'bin/launcher', 'transport/surprise.dylib'],
    verifiedPaths: ['bin/helper', 'bin/launcher'],
  }), { code: 'SIGNING_UNSIGNED_NESTED_CODE' });
  assert.throws(() => assertNestedNativeCoverage({
    nativePaths: ['bin/helper', 'transport/forbidden.node'],
    verifiedPaths: ['bin/helper', 'transport/forbidden.node'],
  }), { code: 'SIGNING_NATIVE_ADDON_FORBIDDEN' });
});

test('slice evidence requires exact contiguous order and digest chaining', () => {
  const ids = ['sign-helper', 'sign-xpc', 'sign-addon', 'sign-launcher', 'verify-nested'];
  const evidence = chainedSlice('macos-arm64', ids);
  evidence.steps[0].outputSha256 = SHA_B;
  evidence.steps[1].inputSha256 = SHA_B;
  evidence.steps[1].outputSha256 = SHA_B;
  evidence.steps[2].inputSha256 = SHA_B;
  evidence.steps[2].outputSha256 = SHA_B;
  evidence.steps[3].inputSha256 = SHA_B;
  evidence.steps[3].outputSha256 = SHA_C;
  evidence.steps[4].inputSha256 = SHA_C;
  evidence.steps[4].outputSha256 = SHA_C;
  assert.doesNotThrow(() => validateSigningSliceEvidence({
    evidence,
    platform: 'macos-arm64',
    expectedStepIds: ids,
    expectedInputSha256: SHA_A,
    expectedStageSha256: SHA_A,
    expectedIdentity: identityFor('macos-arm64', ids),
  }));

  const reordered = structuredClone(evidence);
  [reordered.steps[0], reordered.steps[1]] = [reordered.steps[1], reordered.steps[0]];
  assert.throws(() => validateSigningSliceEvidence({
    evidence: reordered,
    platform: 'macos-arm64',
    expectedStepIds: ids,
  }), { code: 'SIGNING_STEP_ORDER_INVALID' });

  const missingDigest = structuredClone(evidence);
  delete missingDigest.steps[0].inputSha256;
  assert.throws(() => validateSigningSliceEvidence({
    evidence: missingDigest,
    platform: 'macos-arm64',
    expectedStepIds: ids,
  }), { code: 'SIGNING_STEP_DIGEST_INVALID' });

  const brokenChain = structuredClone(evidence);
  brokenChain.steps[3].inputSha256 = SHA_C;
  assert.throws(() => validateSigningSliceEvidence({
    evidence: brokenChain,
    platform: 'macos-arm64',
    expectedStepIds: ids,
  }), { code: 'SIGNING_DIGEST_CHAIN_INVALID' });
});

test('no-op categories and verification steps must preserve their input digest', () => {
  const ids = ['sign-helper', 'sign-addon', 'sign-launcher', 'verify-authenticode'];
  const evidence = chainedSlice('windows-x64', ids);
  evidence.steps[0].outputSha256 = SHA_B;
  evidence.steps[1].inputSha256 = SHA_B;
  evidence.steps[1].outputSha256 = SHA_C;
  evidence.steps[2].inputSha256 = SHA_C;
  evidence.steps[2].outputSha256 = SHA_C;
  evidence.steps[3].inputSha256 = SHA_C;
  evidence.steps[3].outputSha256 = SHA_C;
  assert.throws(() => validateSigningSliceEvidence({
    evidence,
    platform: 'windows-x64',
    expectedStepIds: ids,
  }), { code: 'SIGNING_MUTATION_BOUNDARY_INVALID' });
});

test('command redaction removes declared secrets without mutating the command', () => {
  const command = {
    file: 'ZXPSignCmd',
    args: ['-sign', '/input', '/out', '/cert.p12', 'super-secret'],
    secretArgIndexes: [3, 4],
  };
  const redacted = redactSigningCommand(command);
  assert.deepEqual(redacted.args, ['-sign', '/input', '/out', '<redacted>', '<redacted>']);
  assert.equal(JSON.stringify(redacted).includes('super-secret'), false);
  assert.equal(command.args[4], 'super-secret');
});

test('ZXP signer failures never expose credential arguments', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-zxp-redaction-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const signingRoot = path.join(root, 'signed');
  const command = path.join(root, 'ZXPSignCmd');
  const certificate = path.join(root, 'certificate.p12');
  await fs.promises.mkdir(signingRoot);
  await fs.promises.writeFile(path.join(signingRoot, 'bundle-manifest.json'), '{}\n');
  await fs.promises.writeFile(command, 'fixture');
  await fs.promises.writeFile(certificate, 'fixture');
  const sentinel = 'never-print-this-password';
  await assert.rejects(
    buildZxp({
      root: signingRoot,
      platform: 'macos-arm64',
      out: path.join(root, 'out.zxp'),
      evidence: path.join(root, 'zxp-evidence.json'),
      environment: {
        AE_MCP_ZXP_SIGN_CMD: command,
        AE_MCP_ZXP_CERT_PATH: certificate,
        AE_MCP_ZXP_CERT_PASSWORD: sentinel,
      },
      execFileImpl: async (_file, args) => {
        throw new Error(`simulated failure ${args.join(' ')}`);
      },
    }),
    (error) => {
      assert.equal(error.code, 'SIGNING_COMMAND_FAILED');
      assert.doesNotMatch(error.message, new RegExp(sentinel));
      return true;
    },
  );
});

test('reusable entry points cannot stage, release, publish, or require native addons', async () => {
  const files = [
    'scripts/package/sign-macos-nested.sh',
    'scripts/package/sign-windows-nested.ps1',
    'scripts/package/build-zxp.mjs',
    'scripts/package/package-macos-dmg.sh',
    'scripts/phase0/run-signing-probe-macos.sh',
    'scripts/phase0/run-signing-probe-windows.ps1',
  ];
  for (const relative of files) {
    const source = await fs.promises.readFile(relative, 'utf8');
    assert.doesNotMatch(source, /build-portable-runtime|stage-platform-bundle|git\s+tag|gh\s+release|\.node\b/i, relative);
  }
});

test('Phase 0 runners verify source, copied work, and unchanged source around signing', async () => {
  for (const [relative, copyMarker, signingMarker] of [
    ['scripts/phase0/run-signing-probe-macos.sh', 'ditto --noqtn', 'sign-macos-nested.sh'],
    ['scripts/phase0/run-signing-probe-windows.ps1', 'robocopy.exe', 'sign-windows-nested.ps1'],
  ]) {
    const source = await fs.promises.readFile(relative, 'utf8');
    const verificationOffsets = [...source.matchAll(/verify-platform-bundle\.mjs/g)]
      .map((match) => match.index);
    assert.equal(verificationOffsets.length, 3, `${relative} must run three bundle verifications`);
    const copyOffset = source.indexOf(copyMarker);
    const signingOffset = source.indexOf(signingMarker);
    assert.ok(verificationOffsets[0] < copyOffset, `${relative} verifies source before copying`);
    assert.ok(copyOffset < verificationOffsets[1], `${relative} verifies the copied work`);
    assert.ok(verificationOffsets[1] < signingOffset, `${relative} verifies work before signing`);
    assert.ok(signingOffset < verificationOffsets[2], `${relative} re-verifies source after signing`);
  }
});
