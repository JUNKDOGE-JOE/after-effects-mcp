import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSigningPlan } from '../../package/signing-plan.mjs';
import { sha256Directory } from '../../package/lib/files.mjs';
import { stagePlatformBundle } from '../../package/stage-platform-bundle.mjs';
import { makeStageHarness } from '../../package/test/helpers/platform-bundle-fixture.mjs';
import {
  buildReleaseSigningCommands,
  copyVerifiedStage,
  readCanonicalSigningEvidence,
  readStableSigningManifest,
  redactReleaseSigningCommand,
  runReleaseSigning,
  validateReleaseEvidenceEnvelope,
  validateReleaseStepEvidence,
} from '../run-signing-plan.mjs';
import {
  buildSigningReport,
  canonicalStringify,
  hashVerifiedSigningOutput,
  writeSigningReport,
} from '../signing-report.mjs';

const MAC_STEP_IDS = [
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
];

const WINDOWS_STEP_IDS = [
  'sign-helper',
  'sign-addon',
  'sign-launcher',
  'verify-authenticode',
  'freeze-signed-manifests',
  'sign-zxp',
  'verify-zxp',
];
const ZXP_CERTIFICATE_FINGERPRINT = '7'.repeat(64);
const ZXP_PAYLOAD_SHA256 = '8'.repeat(64);

function zxpIdentity() {
  return {
    zxpCertificateFingerprint: ZXP_CERTIFICATE_FINGERPRINT,
    zxpPayloadSha256: ZXP_PAYLOAD_SHA256,
    zxpVerified: true,
  };
}

function plan(platform, ids) {
  const foundationPlan = buildSigningPlan(platform);
  assert.deepEqual(foundationPlan.steps.map((step) => step.id), ids);
  return foundationPlan;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceFor(signingPlan, finalDigests = {}, initialSha256 = '1'.repeat(64)) {
  let current = initialSha256;
  return signingPlan.steps.map((step, index) => {
    const inputSha256 = current;
    let outputSha256 = inputSha256;
    if (step.mutates.length > 0) {
      const followingNoOpOverrides = [];
      for (let cursor = index + 1; cursor < signingPlan.steps.length; cursor += 1) {
        const following = signingPlan.steps[cursor];
        if (following.mutates.length > 0) break;
        if (finalDigests[following.id]) followingNoOpOverrides.push(finalDigests[following.id]);
      }
      outputSha256 = finalDigests[step.id]
        || followingNoOpOverrides[0]
        || ((index + 2) % 16).toString(16).repeat(64);
    }
    if (finalDigests[step.id] && finalDigests[step.id] !== outputSha256) {
      throw new Error(`fixture override for ${step.id} breaks a no-op boundary`);
    }
    current = outputSha256;
    return { id: step.id, inputSha256, outputSha256, exitCode: 0 };
  });
}

test('verified stage copy preserves manifest-bound internal relative symlinks verbatim', async (t) => {
  const h = await makeStageHarness(t, 'macos-arm64');
  await stagePlatformBundle(h.input);
  const signingRoot = join(h.root, 'signed-copy');
  await mkdir(signingRoot);
  await copyVerifiedStage({
    stageRoot: h.outDir,
    signingRoot,
    platform: 'macos-arm64',
    version: '0.9.1',
    candidateSha: h.input.sourceCommitSha,
  });
  assert.equal(
    await readlink(join(signingRoot, 'runtime/macos-arm64/python/bin/python3')),
    'python3.13',
  );
});

test('Mac release invokes only the reviewed foundation signing entry points', () => {
  assert.deepEqual(buildSigningPlan('macos-arm64').steps.map((step) => step.id), MAC_STEP_IDS);
  const commands = buildReleaseSigningCommands({
    platform: 'macos-arm64',
    candidateSha: 'a'.repeat(40),
    version: '0.9.1',
    stageRoot: '/work/unsigned',
    signingRoot: '/work/signed',
    outRoot: '/work/out',
  });

  assert.deepEqual(commands.map((command) => command.label), [
    'sign-macos-nested',
    'sign-zxp',
    'package-macos-dmg',
  ]);
  assert.deepEqual(commands.map((command) => command.file), [
    'bash',
    process.execPath,
    'bash',
  ]);
  assert.match(commands[1].evidencePath, /\/zxp-evidence\.json$/);
  assert.equal(commands[2].args.includes(commands[1].evidencePath), false);
});

test('Windows release invokes only the reviewed foundation signing entry points', () => {
  assert.deepEqual(buildSigningPlan('windows-x64').steps.map((step) => step.id), WINDOWS_STEP_IDS);
  const commands = buildReleaseSigningCommands({
    platform: 'windows-x64',
    candidateSha: 'b'.repeat(40),
    version: '0.9.1',
    stageRoot: 'C:\\work\\unsigned',
    signingRoot: 'C:\\work\\signed',
    outRoot: 'C:\\work\\out',
  });

  assert.deepEqual(commands.map((command) => command.label), [
    'sign-windows-nested',
    'sign-zxp',
  ]);
  assert.deepEqual(commands.map((command) => command.file), [
    'pwsh',
    process.execPath,
  ]);
  assert.match(commands[1].evidencePath, /\\zxp-evidence\.json$/);
});

test('reports reject reordered evidence and command audits redact secret arguments', () => {
  const signingPlan = plan('windows-x64', WINDOWS_STEP_IDS);
  const evidence = evidenceFor(signingPlan);

  assert.doesNotThrow(() => validateReleaseStepEvidence(signingPlan, evidence));
  assert.throws(
    () => validateReleaseStepEvidence(signingPlan, evidence.toReversed()),
    /step order/,
  );

  const command = {
    file: process.execPath,
    args: ['scripts/package/build-zxp.mjs', '--password', 'zxp-secret'],
    label: 'sign-zxp',
    secretArgIndexes: [2],
  };
  const audit = redactReleaseSigningCommand(command);
  assert.equal(JSON.stringify(audit).includes('zxp-secret'), false);
  assert.equal(audit.args[2], '<redacted>');
});

test('release validation accepts the public Mac signing step contract', () => {
  const signingPlan = plan('macos-arm64', MAC_STEP_IDS);
  const evidence = evidenceFor(signingPlan);
  assert.doesNotThrow(() => validateReleaseStepEvidence(signingPlan, evidence));
});

test('command construction rejects mutable identities and overlapping roots', () => {
  const valid = {
    platform: 'macos-arm64',
    candidateSha: 'a'.repeat(40),
    version: '0.9.1',
    stageRoot: '/work/unsigned',
    signingRoot: '/work/signed',
    outRoot: '/work/out',
  };
  assert.throws(
    () => buildReleaseSigningCommands({ ...valid, version: '0.9.2' }),
    /version/,
  );
  assert.throws(
    () => buildReleaseSigningCommands({ ...valid, candidateSha: 'A'.repeat(40) }),
    /candidate/,
  );
  assert.throws(
    () => buildReleaseSigningCommands({ ...valid, signingRoot: '/work/unsigned/signed' }),
    /overlap/,
  );
  assert.throws(
    () => buildReleaseSigningCommands({ ...valid, outRoot: 'relative/out' }),
    /absolute/,
  );
});

test('step evidence rejects missing, duplicate, non-zero, malformed, or secret-bearing records', () => {
  const signingPlan = plan('windows-x64', WINDOWS_STEP_IDS);
  const evidence = evidenceFor(signingPlan);
  assert.throws(
    () => validateReleaseStepEvidence(signingPlan, evidence.slice(1)),
    /step order/,
  );
  assert.throws(
    () => validateReleaseStepEvidence(signingPlan, [evidence[0], evidence[0], ...evidence.slice(2)]),
    /step order/,
  );
  assert.throws(
    () => validateReleaseStepEvidence(signingPlan, evidence.map((item, index) => (index === 0 ? { ...item, exitCode: 1 } : item))),
    /non-zero/,
  );
  assert.throws(
    () => validateReleaseStepEvidence(signingPlan, evidence.map((item, index) => (index === 0 ? { ...item, inputSha256: 'bad' } : item))),
    /invalid digest/,
  );
  const sentinel = 'RAW-STDOUT-MUST-NOT-LEAK';
  assert.throws(
    () => validateReleaseStepEvidence(signingPlan, evidence.map((item, index) => (index === 0 ? { ...item, rawStdout: sentinel } : item))),
    (error) => !error.message.includes(sentinel),
  );

  const brokenChain = structuredClone(evidence);
  brokenChain[4].inputSha256 = 'f'.repeat(64);
  assert.throws(
    () => validateReleaseStepEvidence(signingPlan, brokenChain),
    /digest chain/,
  );

  const noOpMutation = structuredClone(evidence);
  noOpMutation[1].outputSha256 = 'e'.repeat(64);
  noOpMutation[2].inputSha256 = 'e'.repeat(64);
  assert.throws(
    () => validateReleaseStepEvidence(signingPlan, noOpMutation),
    /mutation boundary/,
  );
});

test('Mac signing report is canonical, hashes final outputs, and contains no paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-report-'));
  const zxpPath = join(root, 'ae-mcp-panel-v0.9.1-macos-arm64.zxp');
  const dmgPath = join(root, 'ae-mcp-panel-v0.9.1-macos-arm64.dmg');
  const reportPath = join(root, 'signing-report.json');
  await writeFile(zxpPath, 'signed-zxp');
  await writeFile(dmgPath, 'signed-dmg');
  const signingPlan = plan('macos-arm64', MAC_STEP_IDS);
  const report = await buildSigningReport({
    platform: 'macos-arm64',
    candidateSha: 'a'.repeat(40),
    sourceStageSha256: 'b'.repeat(64),
    signedBundleManifestSha256: '6'.repeat(64),
    finalRootSha256: ZXP_PAYLOAD_SHA256,
    plan: signingPlan,
    stepEvidence: evidenceFor(signingPlan, {
      'verify-zxp': sha256('signed-zxp'),
      'verify-gatekeeper': sha256('signed-dmg'),
    }),
    outputs: [
      { role: 'dmg', path: dmgPath },
      { role: 'zxp', path: zxpPath },
    ],
    identity: {
      certificateFingerprint: 'c'.repeat(64),
      developerIdTeamId: 'ABCDE12345',
      notarySubmissionId: '123e4567-e89b-42d3-a456-426614174000',
      stapledTicketVerified: true,
      gatekeeperVerified: true,
      ...zxpIdentity(),
    },
  });

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.result, 'PASS');
  assert.equal(report.signedBundleManifestSha256, '6'.repeat(64));
  assert.equal(report.finalRootSha256, ZXP_PAYLOAD_SHA256);
  assert.deepEqual(report.outputs.map((output) => output.role), ['dmg', 'zxp']);
  assert.equal(report.outputs.find((output) => output.role === 'zxp').sha256, sha256('signed-zxp'));
  assert.equal(JSON.stringify(report).includes(root), false);
  assert.equal(
    canonicalStringify({ z: 1, a: { d: 2, b: 1 } }),
    '{"a":{"b":1,"d":2},"z":1}\n',
  );
  await writeSigningReport(reportPath, report);
  assert.equal(await readFile(reportPath, 'utf8'), canonicalStringify(report));
  const duplicateOutputReport = {
    ...report,
    outputs: [
      report.outputs.find((output) => output.role === 'zxp'),
      report.outputs.find((output) => output.role === 'zxp'),
    ],
  };
  await assert.rejects(
    writeSigningReport(join(root, 'duplicate-output-report.json'), duplicateOutputReport),
    /outputs.*missing|duplicated/i,
  );
  await assert.rejects(
    writeSigningReport(join(root, 'truncated-step-report.json'), {
      ...report,
      steps: report.steps.slice(1),
    }),
    /step order/i,
  );
  await assert.rejects(
    writeSigningReport(join(root, 'unbound-output-report.json'), {
      ...report,
      outputs: report.outputs.map((output) => (
        output.role === 'zxp' ? { ...output, sha256: 'f'.repeat(64) } : output
      )),
    }),
    /ZXP.*verified evidence/i,
  );
});

test('Windows signing report requires verified Authenticode, timestamp, and ZXP evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-report-'));
  const zxpPath = join(root, 'ae-mcp-panel-v0.9.1-windows-x64.zxp');
  await writeFile(zxpPath, 'windows-zxp');
  const signingPlan = plan('windows-x64', WINDOWS_STEP_IDS);
  const input = {
    platform: 'windows-x64',
    candidateSha: 'd'.repeat(40),
    sourceStageSha256: 'e'.repeat(64),
    signedBundleManifestSha256: '6'.repeat(64),
    finalRootSha256: ZXP_PAYLOAD_SHA256,
    plan: signingPlan,
    stepEvidence: evidenceFor(signingPlan, { 'verify-zxp': sha256('windows-zxp') }),
    outputs: [{ role: 'zxp', path: zxpPath }],
    identity: {
      authenticodeSignerThumbprint: 'f'.repeat(40),
      timestampVerified: true,
      ...zxpIdentity(),
    },
  };
  const report = await buildSigningReport(input);
  assert.equal(report.identity.authenticodeSignerThumbprint, 'f'.repeat(40));
  await assert.rejects(
    buildSigningReport({
      ...input,
      identity: { ...input.identity, timestampVerified: false },
    }),
    /timestamp verification/,
  );
});

test('signing reports and command audits never serialize signing secret sentinels', async () => {
  const sentinels = [
    'APPLE-IDENTITY-SENTINEL',
    'NOTARY-PROFILE-SENTINEL',
    'WINDOWS-CERT-SENTINEL',
    'TIMESTAMP-URL-SENTINEL',
    'ZXP-CMD-SENTINEL',
    'ZXP-CERT-SENTINEL',
    'ZXP-PASSWORD-SENTINEL',
  ];
  const args = sentinels.flatMap((value, index) => [`--secret-${index}`, value]);
  const audit = redactReleaseSigningCommand({
    file: process.execPath,
    args,
    label: 'secret-redaction-probe',
    secretArgIndexes: sentinels.map((_, index) => index * 2 + 1),
  });
  const serializedAudit = JSON.stringify(audit);
  for (const sentinel of sentinels) assert.equal(serializedAudit.includes(sentinel), false);

  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-report-'));
  const zxpPath = join(root, 'ae-mcp-panel-v0.9.1-windows-x64.zxp');
  await writeFile(zxpPath, 'windows-zxp');
  const signingPlan = plan('windows-x64', WINDOWS_STEP_IDS);
  await assert.rejects(
    buildSigningReport({
      platform: 'windows-x64',
      candidateSha: 'd'.repeat(40),
      sourceStageSha256: 'e'.repeat(64),
      signedBundleManifestSha256: '6'.repeat(64),
      finalRootSha256: ZXP_PAYLOAD_SHA256,
      plan: signingPlan,
      stepEvidence: evidenceFor(signingPlan, { 'verify-zxp': sha256('windows-zxp') }),
      outputs: [{ role: 'zxp', path: zxpPath }],
      identity: {
        authenticodeSignerThumbprint: 'f'.repeat(40),
        timestampVerified: true,
        ...zxpIdentity(),
        password: sentinels.at(-1),
      },
    }),
    (error) => sentinels.every((sentinel) => !error.message.includes(sentinel)),
  );
});

test('release runner copies the verified stage, executes reviewed commands without a shell, and builds evidence-bound report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-run-'));
  const stageRoot = join(root, 'unsigned');
  const signingRoot = join(root, 'signed');
  const outRoot = join(root, 'out');
  await mkdir(stageRoot);
  await mkdir(signingRoot);
  await mkdir(outRoot);
  const candidateSha = 'a'.repeat(40);
  const bundleManifest = `${JSON.stringify({
    schemaVersion: 1,
    version: '0.9.1',
    platform: 'macos-arm64',
    sourceCommitSha: candidateSha,
    files: [],
  })}\n`;
  await writeFile(join(stageRoot, 'bundle-manifest.json'), bundleManifest);
  await writeFile(join(stageRoot, 'unsigned-payload.txt'), 'must-remain-unsigned');

  const sourceStageSha256 = sha256(bundleManifest);
  const initialRootSha256 = await sha256Directory(stageRoot);
  const zxpBytes = 'signed-zxp-from-runner';
  const dmgBytes = 'signed-dmg-from-runner';
  const signingPlan = plan('macos-arm64', MAC_STEP_IDS);
  const allEvidence = evidenceFor(signingPlan, {
    'sign-helper': initialRootSha256,
    'sign-launcher': initialRootSha256,
    'freeze-signed-manifests': initialRootSha256,
    'verify-zxp': sha256(zxpBytes),
    'verify-gatekeeper': sha256(dmgBytes),
  }, initialRootSha256);
  const evidenceByName = new Map([
    ['nested-signing-evidence.json', {
      schemaVersion: 1,
      platform: 'macos-arm64',
      sourceStageSha256,
      steps: allEvidence.slice(0, 5),
      verifiedIdentity: {
        certificateFingerprint: 'c'.repeat(64),
        developerIdTeamId: 'ABCDE12345',
      },
    }],
    ['zxp-evidence.json', {
      schemaVersion: 1,
      platform: 'macos-arm64',
      sourceStageSha256,
      steps: allEvidence.slice(6, 8),
      verifiedIdentity: {
        ...zxpIdentity(),
        zxpPayloadSha256: initialRootSha256,
      },
    }],
    ['dmg-signing-evidence.json', {
      schemaVersion: 1,
      platform: 'macos-arm64',
      sourceStageSha256,
      steps: allEvidence.slice(8),
      verifiedIdentity: {
        certificateFingerprint: 'c'.repeat(64),
        developerIdTeamId: 'ABCDE12345',
        notarySubmissionId: '123e4567-e89b-42d3-a456-426614174000',
        stapledTicketVerified: true,
        gatekeeperVerified: true,
      },
    }],
  ]);
  const commandAudit = [];
  const verifiedRoots = [];
  const validatedSlices = [];
  const execFileImpl = async (file, args, options) => {
    commandAudit.push({ file, args: [...args], options: { ...options } });
    const outputIndex = args.findIndex((arg) => arg === '--out');
    if (outputIndex !== -1) {
      const outputPath = args[outputIndex + 1];
      await writeFile(outputPath, outputPath.endsWith('.dmg') ? dmgBytes : zxpBytes);
    }
  };
  const report = await runReleaseSigning(
    {
      platform: 'macos-arm64',
      candidateSha,
      version: '0.9.1',
      stageRoot,
      signingRoot,
      outRoot,
    },
    {
      execFileImpl,
      environment: {
        PATH: '/reviewed/bin',
        AE_MCP_APPLE_SIGNING_IDENTITY: 'APPLE-IDENTITY-SENTINEL',
        AE_MCP_APPLE_CERT_FINGERPRINT_SHA256: 'c'.repeat(64),
        AE_MCP_APPLE_TEAM_ID: 'ABCDE12345',
        AE_MCP_NOTARY_KEYCHAIN_PATH: '/reviewed/notary.keychain-db',
        AE_MCP_NOTARY_KEYCHAIN_PROFILE: 'reviewed-notary-profile',
        AE_MCP_ZXP_CERT_FINGERPRINT_SHA256: '7'.repeat(64),
        AE_MCP_ZXP_CERT_PASSWORD: 'ZXP-PASSWORD-SENTINEL',
        AE_MCP_ZXP_CERT_PATH: '/reviewed/zxp.p12',
        AE_MCP_ZXP_SIGN_CMD: '/reviewed/ZXPSignCmd',
        AE_MCP_ZXP_SIGN_CMD_SHA256: '9'.repeat(64),
        UNRELATED_SECRET: 'MUST-NOT-REACH-ANY-COMMAND',
      },
      readEvidence: async (path) => structuredClone(evidenceByName.get(path.split('/').at(-1))),
      buildSigningPlanImpl: () => signingPlan,
      validateSigningSliceEvidenceImpl: (input) => {
        validatedSlices.push(input.expectedStepIds);
        assert.equal(input.expectedStageSha256, sourceStageSha256);
        assert.equal(input.expectedInputSha256, input.evidence.steps[0].inputSha256);
      },
      verifyPlatformBundleImpl: async (input) => {
        verifiedRoots.push(input.root);
        assert.equal(input.platform, 'macos-arm64');
        assert.equal(input.version, '0.9.1');
        assert.equal(input.sourceCommitSha, candidateSha);
      },
      freezeSignedManifestsImpl: async (freezeInput) => {
        assert.equal(freezeInput.sourceStageSha256, sourceStageSha256);
        return {
          sourceStageSha256,
          signedBundleManifestSha256: sourceStageSha256,
          finalRootSha256: initialRootSha256,
        };
      },
    },
  );

  assert.equal(report.sourceStageSha256, sourceStageSha256);
  assert.equal(report.result, 'PASS');
  assert.deepEqual(commandAudit.map((item) => item.options.shell), [false, false, false]);
  assert.deepEqual(commandAudit.map((item) => item.file), ['bash', process.execPath, 'bash']);
  assert.equal(commandAudit.every((item) => !Object.hasOwn(item.options.env, 'UNRELATED_SECRET')), true);
  assert.equal(Object.hasOwn(commandAudit[0].options.env, 'AE_MCP_ZXP_CERT_PASSWORD'), false);
  assert.equal(commandAudit[0].options.env.AE_MCP_APPLE_SIGNING_IDENTITY, 'APPLE-IDENTITY-SENTINEL');
  assert.equal(commandAudit[1].options.env.AE_MCP_ZXP_CERT_PASSWORD, 'ZXP-PASSWORD-SENTINEL');
  assert.equal(Object.hasOwn(commandAudit[1].options.env, 'AE_MCP_APPLE_SIGNING_IDENTITY'), false);
  assert.equal(commandAudit[2].options.env.AE_MCP_NOTARY_KEYCHAIN_PROFILE, 'reviewed-notary-profile');
  assert.equal(Object.hasOwn(commandAudit[2].options.env, 'AE_MCP_ZXP_CERT_PASSWORD'), false);
  assert.equal(await readFile(join(stageRoot, 'unsigned-payload.txt'), 'utf8'), 'must-remain-unsigned');
  assert.equal(await readFile(join(signingRoot, 'unsigned-payload.txt'), 'utf8'), 'must-remain-unsigned');
  assert.deepEqual((await readdir(stageRoot)).sort(), ['bundle-manifest.json', 'unsigned-payload.txt']);
  assert.equal(report.signedBundleManifestSha256, sourceStageSha256);
  assert.equal(report.finalRootSha256, initialRootSha256);
  assert.deepEqual(verifiedRoots, [stageRoot, signingRoot, stageRoot]);
  assert.deepEqual(validatedSlices, [
    MAC_STEP_IDS.slice(0, 5),
    MAC_STEP_IDS.slice(6, 8),
    MAC_STEP_IDS.slice(8),
  ]);
});

test('command construction rejects roots that overlap through a symlinked parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-path-'));
  const stageRoot = join(root, 'unsigned');
  const aliasRoot = join(root, 'stage-alias');
  await mkdir(stageRoot);
  await symlink(stageRoot, aliasRoot);

  assert.throws(
    () => buildReleaseSigningCommands({
      platform: 'macos-arm64',
      candidateSha: 'a'.repeat(40),
      version: '0.9.1',
      stageRoot,
      signingRoot: join(aliasRoot, 'signed'),
      outRoot: join(root, 'out'),
    }),
    /overlap/,
  );
});

test('command construction refuses a non-empty signing root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-nonempty-'));
  const stageRoot = join(root, 'unsigned');
  const signingRoot = join(root, 'signed');
  const outRoot = join(root, 'out');
  await mkdir(stageRoot);
  await mkdir(signingRoot);
  await mkdir(outRoot);
  await writeFile(join(signingRoot, 'stale-candidate.bin'), 'must-not-reuse');

  assert.throws(
    () => buildReleaseSigningCommands({
      platform: 'macos-arm64',
      candidateSha: 'a'.repeat(40),
      version: '0.9.1',
      stageRoot,
      signingRoot,
      outRoot,
    }),
    /signing root must be empty/,
  );
});

test('release runner sanitizes evidence reader failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-evidence-error-'));
  const stageRoot = join(root, 'unsigned');
  const signingRoot = join(root, 'signed');
  const outRoot = join(root, 'out');
  await mkdir(stageRoot);
  await mkdir(signingRoot);
  await mkdir(outRoot);
  const candidateSha = 'a'.repeat(40);
  await writeFile(join(stageRoot, 'bundle-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    version: '0.9.1',
    platform: 'macos-arm64',
    sourceCommitSha: candidateSha,
    files: [],
  })}\n`);
  const sentinel = 'EVIDENCE-RAW-SECRET-MUST-NOT-LEAK';

  await assert.rejects(
    runReleaseSigning(
      {
        platform: 'macos-arm64',
        candidateSha,
        version: '0.9.1',
        stageRoot,
        signingRoot,
        outRoot,
      },
      {
        execFileImpl: async () => {},
        readEvidence: async () => {
          throw new Error(sentinel);
        },
        buildSigningPlanImpl: () => plan('macos-arm64', MAC_STEP_IDS),
        verifyPlatformBundleImpl: async () => {},
      },
    ),
    (error) => /sign-macos-nested.*evidence/.test(error.message) && !error.message.includes(sentinel),
  );
});

test('signing output hashing rejects symlinks and hardlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-output-links-'));
  const targetPath = join(root, 'target.zxp');
  const symlinkPath = join(root, 'symlink.zxp');
  const hardlinkPath = join(root, 'hardlink.zxp');
  await writeFile(targetPath, 'signed-output');
  await symlink(targetPath, symlinkPath);
  await link(targetPath, hardlinkPath);

  await assert.rejects(hashVerifiedSigningOutput(symlinkPath), /symbolic link|nofollow/i);
  await assert.rejects(hashVerifiedSigningOutput(hardlinkPath), /hard link|link count/i);
});

test('signing output hashing fails closed if the pathname is swapped after open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-output-race-'));
  const outputPath = join(root, 'candidate.zxp');
  const movedPath = join(root, 'opened.zxp');
  await writeFile(outputPath, 'original-signed-output');

  await assert.rejects(
    hashVerifiedSigningOutput(outputPath, {
      afterOpen: async () => {
        await rename(outputPath, movedPath);
        await writeFile(outputPath, 'replacement-output');
      },
    }),
    /changed while reading|identity changed/i,
  );
});

test('canonical signing evidence reader rejects links, oversized input, and pathname swaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-evidence-files-'));
  const evidence = {
    schemaVersion: 1,
    platform: 'macos-arm64',
    sourceStageSha256: 'a'.repeat(64),
    steps: [{
      id: 'sign-helper',
      inputSha256: 'b'.repeat(64),
      outputSha256: 'c'.repeat(64),
      exitCode: 0,
    }],
    verifiedIdentity: { developerIdTeamId: 'ABCDE12345' },
  };
  const targetPath = join(root, 'target.json');
  const symlinkPath = join(root, 'symlink.json');
  const hardlinkPath = join(root, 'hardlink.json');
  await writeFile(targetPath, canonicalStringify(evidence));
  await symlink(targetPath, symlinkPath);
  await link(targetPath, hardlinkPath);
  await assert.rejects(readCanonicalSigningEvidence(symlinkPath), /symbolic link|nofollow/i);
  await assert.rejects(readCanonicalSigningEvidence(hardlinkPath), /hard link|link count/i);

  const oversizedPath = join(root, 'oversized.json');
  await writeFile(oversizedPath, canonicalStringify({
    ...evidence,
    verifiedIdentity: { padding: 'x'.repeat(1024 * 1024) },
  }));
  await assert.rejects(readCanonicalSigningEvidence(oversizedPath), /size limit/i);

  const racePath = join(root, 'race.json');
  const movedPath = join(root, 'opened.json');
  await writeFile(racePath, canonicalStringify(evidence));
  await assert.rejects(
    readCanonicalSigningEvidence(racePath, {
      afterOpen: async () => {
        await rename(racePath, movedPath);
        await writeFile(racePath, canonicalStringify({ ...evidence, platform: 'windows-x64' }));
      },
    }),
    /changed while reading|identity changed/i,
  );
});

test('release evidence envelope accepts only the exact verifiedIdentity contract', () => {
  const expected = {
    platform: 'macos-arm64',
    sourceStageSha256: 'a'.repeat(64),
  };
  const envelope = {
    schemaVersion: 1,
    platform: 'macos-arm64',
    sourceStageSha256: expected.sourceStageSha256,
    steps: [{
      id: 'sign-zxp',
      inputSha256: 'b'.repeat(64),
      outputSha256: 'c'.repeat(64),
      exitCode: 0,
    }],
    verifiedIdentity: zxpIdentity(),
  };
  assert.deepEqual(validateReleaseEvidenceEnvelope(envelope, expected), zxpIdentity());
  const aliased = structuredClone(envelope);
  aliased.identity = aliased.verifiedIdentity;
  delete aliased.verifiedIdentity;
  assert.throws(
    () => validateReleaseEvidenceEnvelope(aliased, expected),
    /invalid signing evidence envelope/,
  );
});

test('stable signing manifest reads reject links and pathname swaps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-manifest-files-'));
  const manifestBytes = `${JSON.stringify({ schemaVersion: 1 })}\n`;
  const targetPath = join(root, 'target.json');
  const symlinkPath = join(root, 'symlink.json');
  const hardlinkPath = join(root, 'hardlink.json');
  await writeFile(targetPath, manifestBytes);
  await symlink(targetPath, symlinkPath);
  await link(targetPath, hardlinkPath);
  await assert.rejects(readStableSigningManifest(symlinkPath), /symbolic link|nofollow/i);
  await assert.rejects(readStableSigningManifest(hardlinkPath), /hard link|link count/i);

  const racePath = join(root, 'race.json');
  const movedPath = join(root, 'opened.json');
  await writeFile(racePath, manifestBytes);
  await assert.rejects(
    readStableSigningManifest(racePath, {
      afterOpen: async () => {
        await rename(racePath, movedPath);
        await writeFile(racePath, `${JSON.stringify({ schemaVersion: 2 })}\n`);
      },
    }),
    /changed while reading|identity changed/i,
  );
});

test('release runner verifies the copied unsigned tree before executing a signing command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-signing-copy-verification-'));
  const stageRoot = join(root, 'unsigned');
  const signingRoot = join(root, 'signed');
  const outRoot = join(root, 'out');
  await mkdir(stageRoot);
  await mkdir(signingRoot);
  await mkdir(outRoot);
  const candidateSha = 'a'.repeat(40);
  await writeFile(join(stageRoot, 'bundle-manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    version: '0.9.1',
    platform: 'macos-arm64',
    sourceCommitSha: candidateSha,
    files: [],
  })}\n`);
  await writeFile(join(stageRoot, 'payload.txt'), 'tampered-copy-fixture');
  let commandCount = 0;
  const verifierSentinel = 'FOUNDATION-VERIFIER-RAW-DETAIL';

  await assert.rejects(
    runReleaseSigning(
      {
        platform: 'macos-arm64',
        candidateSha,
        version: '0.9.1',
        stageRoot,
        signingRoot,
        outRoot,
      },
      {
        buildSigningPlanImpl: () => plan('macos-arm64', MAC_STEP_IDS),
        execFileImpl: async () => {
          commandCount += 1;
        },
        readEvidence: async () => {
          throw new Error('must not read evidence');
        },
        verifyPlatformBundleImpl: async ({ root: verifiedRoot }) => {
          assert.equal(verifiedRoot, signingRoot);
          throw new Error(verifierSentinel);
        },
      },
    ),
    (error) => /copied unsigned stage failed verification/.test(error.message)
      && !error.message.includes(verifierSentinel),
  );
  assert.equal(commandCount, 0);
});

test('signed RC workflow accepts only protected main and creates an irreversible per-SHA lock', async () => {
  const workflow = await readFile('.github/workflows/build-rc.yml', 'utf8');

  assert.match(workflow, /^name: Build signed RC$/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /candidate_sha:\s*\n\s+required: true\s*\n\s+type: string/);
  assert.match(workflow, /version:\s*\n\s+required: true\s*\n\s+type: string/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /checks: write/);
  assert.match(workflow, /group: build-rc-\$\{\{ inputs\.candidate_sha \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /group: build-rc-[^\n]+\n\s+queue: max\n\s+cancel-in-progress: false/);
  assert.ok(
    (workflow.match(/github\.run_attempt/g) || []).length >= 4,
    'a GitHub rerun must not reuse a successful guard to sign or manifest the candidate again',
  );
  assert.match(workflow, /RUN_ATTEMPT.*\n[\s\S]*?\[\[ "\$RUN_ATTEMPT" == ['"]1['"] \]\]/);
  assert.match(workflow, /PLATFORM_JOBS_OK: \$\{\{ github\.run_attempt == 1 &&/);

  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /VERSION.*0\.9\.1|0\.9\.1.*VERSION/);
  assert.match(workflow, /fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
  assert.match(workflow, /git rev-parse origin\/main/);
  assert.match(workflow, /main_sha.*CANDIDATE_SHA|CANDIDATE_SHA.*main_sha/);
  assert.match(workflow, /WORKFLOW_SHA/);
  assert.match(workflow, /\.github\/workflows\/build-rc\.yml/);
  assert.match(workflow, /github\.workflow_sha/);
  assert.match(workflow, /repos\.getContent/);
  assert.doesNotMatch(workflow, /fetch --no-tags origin ["']?\$GITHUB_WORKFLOW_SHA/);
  assert.match(workflow, /protected.*true|true.*protected/i);

  assert.match(workflow, /ae-mcp-build-lock:/);
  const lockBody = workflow.slice(workflow.indexOf('\n  lock:'), workflow.indexOf('\n  macos:'));
  assert.match(lockBody, /Checkout the exact candidate/);
  assert.match(lockBody, /ref: \$\{\{ needs\.guard\.outputs\.candidate_sha \}\}/);
  assert.match(lockBody, /listAllCheckRunsForRef/);
  assert.match(lockBody, /github-inventory\.mjs/);
  assert.doesNotMatch(lockBody, /github\.rest\.checks\.listForRef/);
  assert.match(workflow, /external_id/);
  assert.match(workflow, /priorLocks\.length > 0/);
  assert.match(workflow, /checks\.create/);
  assert.match(workflow, /name: ['"]signed-rc-build['"]/);
  assert.match(workflow, /status: ['"]in_progress['"]/);
  const guardStart = workflow.indexOf('\n  guard:');
  const macosPreflightStart = workflow.indexOf('\n  preflight-macos:');
  const windowsPreflightStart = workflow.indexOf('\n  preflight-windows:');
  const lockStart = workflow.indexOf('\n  lock:');
  const macosStart = workflow.indexOf('\n  macos:');
  assert.ok(
    guardStart >= 0
      && macosPreflightStart > guardStart
      && windowsPreflightStart > macosPreflightStart
      && lockStart > windowsPreflightStart
      && macosStart > lockStart,
    'the irreversible lock must be created only after both secret-free platform preflights',
  );
  assert.doesNotMatch(workflow.slice(guardStart, macosPreflightStart), /checks\.create/);
  assert.match(
    workflow.slice(lockStart, macosStart),
    /needs: \[guard, preflight-macos, preflight-windows\]/,
  );
  assert.match(workflow.slice(lockStart, macosStart), /github\.rest\.checks\.create/);
  assert.doesNotMatch(
    workflow.slice(macosPreflightStart, lockStart),
    /environment:\s*release-signing|secrets\./,
  );
  assert.match(workflow, /name: ae-mcp-zxpsigncmd-4\.1\.3-macos-x86_64/);
  assert.match(workflow, /name: ae-mcp-zxpsigncmd-4\.1\.3-windows-x64/);
  assert.equal((workflow.match(/retention-days: 1$/gm) || []).length, 0);
  assert.equal((workflow.match(/retention-days: 30$/gm) || []).length, 6);
  for (const toolName of [
    'ae-mcp-zxpsigncmd-4.1.3-macos-x86_64',
    'ae-mcp-zxpsigncmd-4.1.3-windows-x64',
  ]) {
    assert.match(
      workflow,
      new RegExp(`name: ${toolName.replaceAll('.', '\\.')}` + '[\\s\\S]{0,400}retention-days: 30'),
    );
  }
  assert.match(lockBody, /priorLocks\.length > 0/);
  assert.ok(
    lockBody.indexOf('listAllCheckRunsForRef') < lockBody.indexOf('checks.create'),
    'complete historical lock inventory must be checked before lock creation',
  );
  assert.ok(
    workflow.indexOf('ae-mcp-zxpsigncmd-4.1.3-windows-x64')
      < workflow.indexOf('github.rest.checks.create'),
    'both tool preflights must finish before the irreversible lock',
  );
  assert.match(workflow, /grep -Fq ['"]AE_MCP_NOTARY_KEYCHAIN_PATH['"]/);
  assert.ok(
    workflow.indexOf("grep -Fq 'AE_MCP_NOTARY_KEYCHAIN_PATH'")
      < workflow.indexOf('github.rest.checks.create'),
    'the explicit notary keychain contract must fail before creating the permanent lock',
  );
  assert.match(workflow, /packaging\/runtime-license-approvals\.json/);
  assert.match(workflow, /loadApprovals/);
  assert.match(workflow, /selected runtime redistribution approvals are incomplete/);
  assert.ok(
    workflow.indexOf('selected runtime redistribution approvals are incomplete')
      < workflow.indexOf('github.rest.checks.create'),
    'runtime redistribution approvals must fail before creating the permanent lock',
  );
  const approvalSelector = JSON.parse(
    await readFile('packaging/runtime-license-approvals.json', 'utf8'),
  );
  assert.equal(approvalSelector.schemaVersion, 1);
  assert.ok(Array.isArray(approvalSelector.approvals));
});

test('signed RC workflow uses pinned platform, signing, evidence, and finalization contracts', async () => {
  const workflow = await readFile('.github/workflows/build-rc.yml', 'utf8');

  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /runs-on: windows-2025/);
  assert.equal(
    (workflow.match(/actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/g) || []).length,
    6,
  );
  assert.equal((workflow.match(/node-version: ['"]?24\.17\.0/g) || []).length, 6);
  assert.equal(
    (workflow.match(/astral-sh\/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b/g) || []).length,
    2,
  );
  assert.equal((workflow.match(/version: ['"]?0\.11\.7/g) || []).length, 2);
  assert.equal((workflow.match(/enable-cache: ['"]?false/g) || []).length, 2);
  assert.match(workflow, /checksum: ['"]?66e37d91f839e12481d7b932a1eccbfe732560f42c1cfb89faddfa2454534ba8/);
  assert.match(workflow, /checksum: ['"]?fe0c7815acf4fc45f8a5eff58ed3cf7ae2e15c3cf1dceadbd10c816ec1690cc1/);
  assert.equal((workflow.match(/uv --version/g) || []).length, 2);
  assert.equal((workflow.match(/environment: release-signing/g) || []).length, 2);
  assert.match(workflow, /MACOSX_DEPLOYMENT_TARGET: ['"]?14\.0/);
  assert.match(workflow, /uname -m/);
  assert.match(workflow, /arm64/);
  assert.match(workflow, /PROCESSOR_ARCHITECTURE/);
  assert.match(workflow, /AMD64/);
  assert.match(workflow, /build\/runtime\/macos-arm64\/node\/bin.*GITHUB_PATH/);
  assert.match(workflow, /build\\runtime\\windows-x64\\node.*GITHUB_PATH/);
  const signingCalls = [...workflow.matchAll(/const report = await runReleaseSigning/g)]
    .map((match) => match.index);
  assert.ok(
    workflow.indexOf('build/runtime/macos-arm64/node/bin\" >> \"$GITHUB_PATH') < signingCalls[0],
    'bundled macOS Node must be on PATH before nested signing',
  );
  assert.ok(
    workflow.indexOf("build\\runtime\\windows-x64\\node') >> $env:GITHUB_PATH") < signingCalls[1],
    'bundled Windows Node must be on PATH before nested signing',
  );
  const macBuild = workflow.indexOf('- name: Build locked foundation inputs', workflow.indexOf('\n  macos:'));
  const macCredentials = workflow.indexOf('- name: Import ephemeral Developer ID', workflow.indexOf('\n  macos:'));
  const windowsBuild = workflow.indexOf('- name: Build locked foundation inputs', workflow.indexOf('\n  windows:'));
  const windowsCredentials = workflow.indexOf('- name: Import ephemeral Authenticode', workflow.indexOf('\n  windows:'));
  assert.ok(macBuild >= 0 && macBuild < macCredentials && macCredentials < signingCalls[0]);
  assert.ok(windowsBuild >= 0 && windowsBuild < windowsCredentials && windowsCredentials < signingCalls[1]);

  assert.match(workflow, /secrets\.AE_MCP_APPLE_CERT_P12_BASE64/);
  assert.match(workflow, /secrets\.AE_MCP_APPLE_CERT_PASSWORD/);
  assert.match(workflow, /secrets\.AE_MCP_WINDOWS_CERT_PFX_BASE64/);
  assert.match(workflow, /secrets\.AE_MCP_WINDOWS_CERT_PASSWORD/);
  assert.match(workflow, /secrets\.AE_MCP_WINDOWS_CERT_SHA1/);
  assert.equal(
    (workflow.match(/AE_MCP_ZXP_CERT_PASSWORD: \$\{\{ secrets\.AE_MCP_ZXP_CERT_PASSWORD \}\}/g) || []).length,
    2,
  );
  assert.equal(
    (workflow.match(/AE_MCP_ZXP_CERT_FINGERPRINT_SHA256: \$\{\{ vars\.AE_MCP_ZXP_CERT_FINGERPRINT_SHA256 \}\}/g) || []).length,
    3,
  );
  assert.match(workflow, /AE_MCP_ZXP_CERT_FINGERPRINT_SHA256[\s\S]*\^\[a-f0-9\]\{64\}\$/);
  assert.doesNotMatch(
    workflow,
    /^ {6}AE_MCP_ZXP_CERT_PASSWORD: \$\{\{ secrets\.AE_MCP_ZXP_CERT_PASSWORD \}\}/m,
    'the ZXP password must be scoped to the two signing steps, never the whole job',
  );
  assert.match(workflow, /certificate\.Thumbprint\.ToUpperInvariant\(\) -ne \$expectedThumbprint/);
  assert.match(workflow, /AE_MCP_WINDOWS_SIGNTOOL_PATH/);
  assert.ok((workflow.match(/-DeleteKey/g) || []).length >= 2);
  assert.match(workflow, /imported-certificates\.txt/);
  assert.doesNotMatch(workflow, /AE_MCP_APPLE_DEVELOPER_ID_P12|AE_MCP_WINDOWS_AUTHENTICODE_PFX/);
  assert.match(workflow, /vars\.AE_MCP_NOTARY_KEYCHAIN_PROFILE/);
  assert.match(workflow, /AE_MCP_NOTARY_KEYCHAIN_PROFILE.*ae-mcp-notary-ci|ae-mcp-notary-ci.*AE_MCP_NOTARY_KEYCHAIN_PROFILE/);
  assert.match(workflow, /AE_MCP_NOTARY_KEYCHAIN_PATH/);
  assert.doesNotMatch(
    workflow,
    /^    env:\n(?:      [^\n]*\n)*      [^\n]*\$\{\{\s*runner\.temp\s*\}\}/m,
    'runner context is invalid in job-level env and must not be used for signing paths',
  );
  assert.match(
    workflow,
    /printf ['"]AE_MCP_NOTARY_KEYCHAIN_PATH=%s\\n['"][\s\S]*?}\s*>> ['"]\$GITHUB_ENV['"]/,
  );
  assert.match(workflow, /AE_MCP_ZXP_CERT_PATH=%s\\n[\s\S]*?}\s*>> ['"]\$GITHUB_ENV['"]/);
  assert.match(workflow, /AE_MCP_ZXP_CERT_PATH=\$zxpCertificatePath['"] >> \$env:GITHUB_ENV/);
  assert.doesNotMatch(workflow, /vars\.AE_MCP_ZXP_SIGN_CMD_(?:MACOS|WINDOWS)/);
  assert.equal(
    (workflow.match(/ab5e4e3e53a42fad08e1225a22a991bb1ffe73f6/g) || []).length,
    2,
  );
  assert.match(workflow, /ZXPSignCMD\/4\.1\.3\/macOS\/ZXPSignCmd/);
  assert.match(workflow, /ZXPSignCMD\/4\.1\.3\/x64\/ZXPSignCmd\.exe/);
  assert.match(workflow, /bc773fae0b97416fc7a462e7dadcc00270428a9913480c9b78b5606ff1cfb095/);
  assert.match(workflow, /ffc2223167225ce61d024eb463fc5ad1a1be16133f99ef334a646f7311916c98/);
  assert.match(workflow, /curl --fail --silent --show-error --location/);
  assert.match(workflow, /Invoke-WebRequest/);
  assert.match(workflow, /AE_MCP_ZXP_SIGN_CMD=.*GITHUB_ENV|AE_MCP_ZXP_SIGN_CMD=%s\\n[\s\S]*GITHUB_ENV/);
  assert.equal(
    (workflow.match(/AE_MCP_ZXP_SIGN_CMD_SHA256=%s\\n/g) || []).length,
    1,
  );
  assert.match(workflow, /AE_MCP_ZXP_SIGN_CMD_SHA256=\$env:AE_MCP_ZXP_SIGN_CMD_SHA256/);
  assert.match(workflow, /shasum -a 256.*AE_MCP_ZXP_SIGN_CMD/);
  assert.match(workflow, /Get-FileHash.*AE_MCP_ZXP_SIGN_CMD.*SHA256/);
  assert.equal((workflow.match(/AE_MCP_RUNTIME_LICENSE_APPROVAL:/g) || []).length, 2);

  assert.equal((workflow.match(/stage-platform-bundle\.mjs/g) || []).length, 2);
  assert.ok((workflow.match(/verify-platform-bundle\.mjs/g) || []).length >= 2);
  assert.equal((workflow.match(/const report = await runReleaseSigning/g) || []).length, 2);
  assert.equal((workflow.match(/await writeSigningReport/g) || []).length, 2);
  assert.match(workflow, /buildArtifactManifest/);
  assert.match(workflow, /serializeArtifactManifest/);
  assert.match(workflow, /const manifestBytes = serializeArtifactManifest\(manifest\)/);
  assert.match(workflow, /writeFile\([^\n]+artifact-manifest-v0\.9\.1\.json[^\n]+manifestBytes/);
  assert.match(workflow, /verifyArtifactManifest/);
  assert.match(workflow, /role: ['"]install['"]/);
  assert.match(workflow, /role: ['"]payload['"]/);
  assert.match(workflow, /artifact-manifest-v0\.9\.1\.json/);
  assert.match(workflow, /retention-days: 30/);
  assert.match(workflow, /if: \$\{\{ always\(\).*needs\.lock\.result == ['"]success['"]/);
  assert.match(workflow, /steps\.reverify\.outcome/);
  assert.match(workflow, /checks\.update/);
  const firstUpload = workflow.indexOf('- name: Upload named macOS DMG and evidence');
  const macosDestroy = workflow.indexOf('- name: Destroy ephemeral macOS credentials before upload');
  const windowsUpload = workflow.indexOf('- name: Upload named Windows ZXP and evidence');
  const windowsDestroy = workflow.indexOf('- name: Destroy ephemeral Windows credentials before upload');
  assert.ok(macosDestroy >= 0 && macosDestroy < firstUpload);
  assert.ok(windowsDestroy >= 0 && windowsDestroy < windowsUpload);

  const requiredActions = [
    'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
    'actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
    'astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b',
  ];
  for (const action of requiredActions) assert.match(workflow, new RegExp(action.replace('/', '\\/')));
  for (const match of workflow.matchAll(/uses:\s*([^\s]+)/g)) {
    assert.match(match[1], /@[0-9a-f]{40}$/, `mutable action reference: ${match[1]}`);
  }

  assert.doesNotMatch(workflow, /npm install|pip install|uv tool install/i);
  assert.doesNotMatch(workflow, /pull_request_target|macos-latest/);
});

test('fast CI runs the release contract suite without adding a native release matrix', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /node --test scripts\/release\/test\/\*\.test\.mjs/);
  assert.doesNotMatch(workflow, /macos-15|macos-14-compat|windows-2025/);
});

test('foundation CI retains the required minimum-macOS job once its gated task lands', async (t) => {
  let workflow;
  try {
    workflow = await readFile('.github/workflows/platform-foundation-ci.yml', 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    t.todo('platform foundation Task 16 remains blocked on the separately approved helper work');
    return;
  }

  assert.match(workflow, /macos-14-compat:/);
  assert.match(workflow, /runs-on: macos-14|runs-on: \[self-hosted, macOS, ARM64, ae-mcp-macos-14\]/);
  assert.doesNotMatch(workflow, /macos-14-compat:[\s\S]*?continue-on-error:\s*true/);
});

test('foundation notarization explicitly consumes the temporary keychain path once fixed', async (t) => {
  const source = await readFile('scripts/package/package-macos-dmg.sh', 'utf8');
  if (!source.includes('AE_MCP_NOTARY_KEYCHAIN_PATH')) {
    t.todo('foundation notary submit still needs the separately reviewed explicit-keychain fix');
    return;
  }
  assert.match(source, /notarytool submit[\s\S]*--keychain-profile[\s\S]*--keychain ["']?\$AE_MCP_NOTARY_KEYCHAIN_PATH/);
});
