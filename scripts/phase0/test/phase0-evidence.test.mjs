import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson, sha256Bytes, sha256File } from '../../package/lib/manifest.mjs';
import { buildSigningPlan } from '../../package/signing-plan.mjs';
import {
  mergePhase0Evidence,
  validateMergedPhase0Evidence,
} from '../collect-phase0-evidence.mjs';
import {
  phase0FinalArtifactPath,
  verifyPhase0SigningEvidence,
  writePhase0SigningEvidence,
} from '../verify-signing-evidence.mjs';

const SOURCE_STAGE_SHA = 'a'.repeat(64);

async function writeCanonical(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, canonicalJson(value), { flag: 'w' });
}

function buildSteps(platform, finalSha256) {
  const plan = buildSigningPlan(platform);
  const lastMutation = plan.steps.findLastIndex((step) => step.mutates.length > 0);
  let prior = SOURCE_STAGE_SHA;
  return plan.steps.map((step, index) => {
    const inputSha256 = prior;
    if (step.mutates.length > 0) {
      prior = index === lastMutation
        ? finalSha256
        : ((index + 1).toString(16).repeat(64)).slice(0, 64);
    }
    return { id: step.id, inputSha256, outputSha256: prior, exitCode: 0 };
  });
}

function aggregateIdentity(platform) {
  if (platform === 'macos-arm64') {
    return {
      nested: {
        certificateFingerprint: 'd'.repeat(64),
        developerIdTeamId: 'TESTTEAM01',
      },
      zxp: { zxpVerified: true },
      dmg: {
        certificateFingerprint: 'd'.repeat(64),
        developerIdTeamId: 'TESTTEAM01',
        notarySubmissionId: '12345678-1234-4234-8234-123456789abc',
        stapledTicketVerified: true,
        gatekeeperVerified: true,
      },
    };
  }
  return {
    nested: {
      authenticodeSignerThumbprint: 'E'.repeat(40),
      timestampVerified: true,
    },
    zxp: { zxpVerified: true },
  };
}

async function makeSigningEvidence(t, platform = 'macos-arm64') {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-phase0-signing-'));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const outputRoot = path.join(temp, 'build', 'phase0', 'signing', platform);
  await fs.promises.mkdir(outputRoot, { recursive: true });
  const finalArtifact = phase0FinalArtifactPath({ outputRoot, platform });
  const finalBytes = Buffer.from(`signed-${platform}\n`, 'utf8');
  await fs.promises.writeFile(finalArtifact, finalBytes);
  const evidencePath = path.join(outputRoot, 'phase0-signing-evidence.json');
  const evidence = {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    disposableOutputRoot: outputRoot,
    steps: buildSteps(platform, sha256Bytes(finalBytes)),
    verifiedIdentity: aggregateIdentity(platform),
    verifiedAt: '2026-07-10T00:00:00.000Z',
    publicationAttempted: false,
  };
  await writePhase0SigningEvidence({ evidencePath, evidence });
  return { temp, outputRoot, finalArtifact, evidencePath, evidence };
}

function validHelperEvidence(platform, signingOutputSha256) {
  return {
    schemaVersion: 1,
    kind: 'helper-platform',
    platform,
    helperIdentity: 'com.junkdoge.ae-mcp.platform-helper',
    afterEffects: {
      '25': { result: 'PASS' },
      '26': { result: 'PASS' },
    },
    backendAccess: {
      secret: { authorized: 1, rejectedBeforeAccess: 1 },
      capture: { authorized: 1, rejectedBeforeAccess: 1 },
    },
    signingOutputSha256,
    adversarialCases: [
      { id: 'direct-launch', result: 'REJECTED', backendAccessCount: 0 },
    ],
  };
}

test('valid Phase 0 signing evidence is canonical, ordered, and bound to final bytes', async (t) => {
  const fixture = await makeSigningEvidence(t);
  await assert.doesNotReject(() => verifyPhase0SigningEvidence({
    evidencePath: fixture.evidencePath,
    expectedPlatform: 'macos-arm64',
    expectedStageSha256: SOURCE_STAGE_SHA,
    expectedIdentity: fixture.evidence.verifiedIdentity,
  }));
  const bytes = await fs.promises.readFile(fixture.evidencePath, 'utf8');
  assert.equal(bytes, canonicalJson(JSON.parse(bytes)));
});

test('Phase 0 output cannot claim publication', async (t) => {
  const fixture = await makeSigningEvidence(t);
  fixture.evidence.publicationAttempted = true;
  await writeCanonical(fixture.evidencePath, fixture.evidence);
  await assert.rejects(() => verifyPhase0SigningEvidence({
    evidencePath: fixture.evidencePath,
    expectedPlatform: 'macos-arm64',
    expectedStageSha256: SOURCE_STAGE_SHA,
  }), { code: 'PHASE0_PUBLICATION_FORBIDDEN' });
});

test('Phase 0 evidence rejects missing digests and step reordering', async (t) => {
  const missing = await makeSigningEvidence(t);
  delete missing.evidence.steps[0].inputSha256;
  await writeCanonical(missing.evidencePath, missing.evidence);
  await assert.rejects(() => verifyPhase0SigningEvidence({
    evidencePath: missing.evidencePath,
    expectedPlatform: 'macos-arm64',
    expectedStageSha256: SOURCE_STAGE_SHA,
  }), { code: 'SIGNING_STEP_DIGEST_INVALID' });

  const reordered = await makeSigningEvidence(t, 'windows-x64');
  [reordered.evidence.steps[0], reordered.evidence.steps[1]] = [
    reordered.evidence.steps[1], reordered.evidence.steps[0],
  ];
  await writeCanonical(reordered.evidencePath, reordered.evidence);
  await assert.rejects(() => verifyPhase0SigningEvidence({
    evidencePath: reordered.evidencePath,
    expectedPlatform: 'windows-x64',
    expectedStageSha256: SOURCE_STAGE_SHA,
  }), { code: 'SIGNING_STEP_ORDER_INVALID' });
});

test('Phase 0 evidence cannot omit a nested-signing category', async (t) => {
  const fixture = await makeSigningEvidence(t, 'windows-x64');
  fixture.evidence.steps = fixture.evidence.steps.filter((step) => step.id !== 'sign-launcher');
  await writeCanonical(fixture.evidencePath, fixture.evidence);
  await assert.rejects(() => verifyPhase0SigningEvidence({
    evidencePath: fixture.evidencePath,
    expectedPlatform: 'windows-x64',
    expectedStageSha256: SOURCE_STAGE_SHA,
  }), { code: 'PHASE0_UNSIGNED_NESTED_CODE' });
});

test('Phase 0 evidence rejects identity mismatch and post-signing byte changes', async (t) => {
  const identity = await makeSigningEvidence(t);
  await assert.rejects(() => verifyPhase0SigningEvidence({
    evidencePath: identity.evidencePath,
    expectedPlatform: 'macos-arm64',
    expectedStageSha256: SOURCE_STAGE_SHA,
    expectedIdentity: {
      ...identity.evidence.verifiedIdentity,
      nested: {
        ...identity.evidence.verifiedIdentity.nested,
        developerIdTeamId: 'WRONGTEAM1',
      },
    },
  }), { code: 'PHASE0_IDENTITY_MISMATCH' });

  const changed = await makeSigningEvidence(t, 'windows-x64');
  await fs.promises.appendFile(changed.finalArtifact, 'changed');
  await assert.rejects(() => verifyPhase0SigningEvidence({
    evidencePath: changed.evidencePath,
    expectedPlatform: 'windows-x64',
    expectedStageSha256: SOURCE_STAGE_SHA,
  }), { code: 'PHASE0_OUTPUT_CHANGED' });
});

test('Phase 0 evidence path must be inside its platform signing root', async (t) => {
  const fixture = await makeSigningEvidence(t);
  const outside = path.join(fixture.temp, 'outside', 'phase0-signing-evidence.json');
  await writeCanonical(outside, fixture.evidence);
  await assert.rejects(() => verifyPhase0SigningEvidence({
    evidencePath: outside,
    expectedPlatform: 'macos-arm64',
    expectedStageSha256: SOURCE_STAGE_SHA,
  }), { code: 'PHASE0_EVIDENCE_PATH_FORBIDDEN' });
});

test('merged helper evidence binds both platforms by digest without embedding signing evidence', async (t) => {
  const mac = await makeSigningEvidence(t, 'macos-arm64');
  const windows = await makeSigningEvidence(t, 'windows-x64');
  const helperDir = path.join(mac.temp, 'helpers');
  const helperPaths = [
    path.join(helperDir, 'macos-helper.json'),
    path.join(helperDir, 'windows-helper.json'),
  ];
  await writeCanonical(
    helperPaths[0],
    validHelperEvidence('macos-arm64', await sha256File(mac.evidencePath)),
  );
  await writeCanonical(
    helperPaths[1],
    validHelperEvidence('windows-x64', await sha256File(windows.evidencePath)),
  );
  const outPath = path.join(mac.temp, 'platform-helper.json');
  await mergePhase0Evidence({
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [mac.evidencePath, windows.evidencePath],
    outPath,
  });
  await assert.doesNotReject(() => validateMergedPhase0Evidence({
    evidencePath: outPath,
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [mac.evidencePath, windows.evidencePath],
  }));
  const mergedText = await fs.promises.readFile(outPath, 'utf8');
  const merged = JSON.parse(mergedText);
  assert.equal(mergedText, canonicalJson(merged));
  assert.deepEqual(Object.keys(merged.platforms).sort(), ['macos-arm64', 'windows-x64']);
  assert.equal(mergedText.includes('verifiedIdentity'), false);
  assert.equal(mergedText.includes('"steps"'), false);
});

test('merge fails closed for missing, swapped, or digest-mismatched signing evidence', async (t) => {
  const mac = await makeSigningEvidence(t, 'macos-arm64');
  const windows = await makeSigningEvidence(t, 'windows-x64');
  const helperDir = path.join(mac.temp, 'helpers');
  const helperPaths = [path.join(helperDir, 'mac.json'), path.join(helperDir, 'win.json')];
  await writeCanonical(
    helperPaths[0],
    validHelperEvidence('macos-arm64', await sha256File(mac.evidencePath)),
  );
  await writeCanonical(
    helperPaths[1],
    validHelperEvidence('windows-x64', await sha256File(windows.evidencePath)),
  );
  const outPath = path.join(mac.temp, 'platform-helper.json');

  await assert.rejects(() => mergePhase0Evidence({
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [mac.evidencePath],
    outPath,
  }), { code: 'PHASE0_PLATFORM_SET_INVALID' });

  await assert.rejects(() => mergePhase0Evidence({
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [windows.evidencePath, mac.evidencePath],
    outPath,
  }), { code: 'PHASE0_PLATFORM_PAIR_MISMATCH' });

  await mergePhase0Evidence({
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [mac.evidencePath, windows.evidencePath],
    outPath,
  });
  await fs.promises.appendFile(windows.evidencePath, '\n');
  await assert.rejects(() => validateMergedPhase0Evidence({
    evidencePath: outPath,
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [mac.evidencePath, windows.evidencePath],
  }), { code: 'PHASE0_EVIDENCE_DIGEST_MISMATCH' });
});

test('helper signingOutputSha256 must bind the paired signing evidence in both gates', async (t) => {
  const mac = await makeSigningEvidence(t, 'macos-arm64');
  const windows = await makeSigningEvidence(t, 'windows-x64');
  const helperDir = path.join(mac.temp, 'bound-helpers');
  const helperPaths = [path.join(helperDir, 'mac.json'), path.join(helperDir, 'win.json')];
  const macSigningSha = await sha256File(mac.evidencePath);
  const windowsSigningSha = await sha256File(windows.evidencePath);
  await writeCanonical(
    helperPaths[0],
    validHelperEvidence('macos-arm64', '0'.repeat(64)),
  );
  await writeCanonical(
    helperPaths[1],
    validHelperEvidence('windows-x64', windowsSigningSha),
  );
  const outPath = path.join(mac.temp, 'bound-platform-helper.json');
  await assert.rejects(() => mergePhase0Evidence({
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [mac.evidencePath, windows.evidencePath],
    outPath,
  }), { code: 'PHASE0_SIGNING_OUTPUT_MISMATCH' });

  await writeCanonical(
    helperPaths[0],
    validHelperEvidence('macos-arm64', macSigningSha),
  );
  await mergePhase0Evidence({
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [mac.evidencePath, windows.evidencePath],
    outPath,
  });
  await writeCanonical(
    helperPaths[0],
    validHelperEvidence('macos-arm64', '0'.repeat(64)),
  );
  const merged = JSON.parse(await fs.promises.readFile(outPath, 'utf8'));
  merged.platforms['macos-arm64'].helperEvidenceSha256 = await sha256File(helperPaths[0]);
  await writeCanonical(outPath, merged);
  await assert.rejects(() => validateMergedPhase0Evidence({
    evidencePath: outPath,
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [mac.evidencePath, windows.evidencePath],
  }), { code: 'PHASE0_SIGNING_OUTPUT_MISMATCH' });
});

test('merged re-validation requires each supported source platform exactly once', async (t) => {
  const mac = await makeSigningEvidence(t, 'macos-arm64');
  const windows = await makeSigningEvidence(t, 'windows-x64');
  const helperDir = path.join(mac.temp, 'unique-helpers');
  const helperPaths = [path.join(helperDir, 'mac.json'), path.join(helperDir, 'win.json')];
  await writeCanonical(
    helperPaths[0],
    validHelperEvidence('macos-arm64', await sha256File(mac.evidencePath)),
  );
  await writeCanonical(
    helperPaths[1],
    validHelperEvidence('windows-x64', await sha256File(windows.evidencePath)),
  );
  const outPath = path.join(mac.temp, 'unique-platform-helper.json');
  await mergePhase0Evidence({
    helperEvidencePaths: helperPaths,
    signingEvidencePaths: [mac.evidencePath, windows.evidencePath],
    outPath,
  });
  await assert.rejects(() => validateMergedPhase0Evidence({
    evidencePath: outPath,
    helperEvidencePaths: [helperPaths[0], helperPaths[0]],
    signingEvidencePaths: [mac.evidencePath, mac.evidencePath],
  }), { code: 'PHASE0_PLATFORM_SET_INVALID' });
});

test('Phase 0 schema declares helper, signing, and merged evidence variants', async () => {
  const schema = JSON.parse(await fs.promises.readFile(
    'packaging/schemas/phase0-evidence.schema.json',
    'utf8',
  ));
  assert.equal(schema.$defs.signingEvidence.title, 'Phase0SigningEvidenceV1');
  assert.equal(schema.$defs.helperEvidence.title, 'Phase0HelperEvidenceV1');
  assert.equal(schema.$defs.mergedEvidence.title, 'Phase0MergedEvidenceV1');
  assert.equal(schema.oneOf.length, 3);
});
