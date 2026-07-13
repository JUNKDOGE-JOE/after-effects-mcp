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
  assemblePhase0SigningEvidence,
  phase0FinalArtifactPath,
  verifyPhase0SigningEvidence,
  writePhase0SigningEvidence,
} from '../verify-signing-evidence.mjs';
import {
  assertHelperRejected,
  validateRejectedResponse,
} from '../assert-helper-rejected.mjs';

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
      zxp: {
        zxpCertificateFingerprint: 'e'.repeat(64),
        zxpPayloadSha256: 'f'.repeat(64),
        zxpVerified: true,
      },
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
    zxp: {
      zxpCertificateFingerprint: 'e'.repeat(64),
      zxpPayloadSha256: 'f'.repeat(64),
      zxpVerified: true,
    },
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

test('Phase 0 evidence fixes manifest freezing between nested signing and ZXP signing', async (t) => {
  const reordered = await makeSigningEvidence(t, 'windows-x64');
  const freezeIndex = reordered.evidence.steps.findIndex(
    (step) => step.id === 'freeze-signed-manifests',
  );
  [reordered.evidence.steps[freezeIndex], reordered.evidence.steps[freezeIndex + 1]] = [
    reordered.evidence.steps[freezeIndex + 1],
    reordered.evidence.steps[freezeIndex],
  ];
  await writeCanonical(reordered.evidencePath, reordered.evidence);
  await assert.rejects(() => verifyPhase0SigningEvidence({
    evidencePath: reordered.evidencePath,
    expectedPlatform: 'windows-x64',
    expectedStageSha256: SOURCE_STAGE_SHA,
  }), { code: 'SIGNING_STEP_ORDER_INVALID' });

  const malformed = await makeSigningEvidence(t, 'macos-arm64');
  malformed.evidence.steps.find(
    (step) => step.id === 'freeze-signed-manifests',
  ).unexpected = true;
  await writeCanonical(malformed.evidencePath, malformed.evidence);
  await assert.rejects(() => verifyPhase0SigningEvidence({
    evidencePath: malformed.evidencePath,
    expectedPlatform: 'macos-arm64',
    expectedStageSha256: SOURCE_STAGE_SHA,
  }), { code: 'SIGNING_STEP_INVALID' });
});

test('Phase 0 assembler consumes real freeze evidence between nested and ZXP slices', async (t) => {
  const platform = 'windows-x64';
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-phase0-assemble-'));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const outputRoot = path.join(temp, 'build', 'phase0', 'signing', platform);
  await fs.promises.mkdir(outputRoot, { recursive: true });
  const finalArtifact = phase0FinalArtifactPath({ outputRoot, platform });
  const finalBytes = Buffer.from('signed-windows-assembler\n', 'utf8');
  await fs.promises.writeFile(finalArtifact, finalBytes);
  const steps = buildSteps(platform, sha256Bytes(finalBytes));
  const identities = aggregateIdentity(platform);
  const nestedPath = path.join(outputRoot, 'nested-evidence.json');
  const freezePath = path.join(outputRoot, 'freeze-evidence.json');
  const zxpPath = path.join(outputRoot, 'zxp-evidence.json');
  await writeCanonical(nestedPath, {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    steps: steps.slice(0, 4),
    verifiedIdentity: identities.nested,
  });
  await writeCanonical(freezePath, {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    step: steps[4],
  });
  await writeCanonical(zxpPath, {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    steps: steps.slice(5),
    verifiedIdentity: identities.zxp,
  });

  const evidence = await assemblePhase0SigningEvidence({
    outputRoot,
    platform,
    sliceEvidencePaths: [nestedPath, zxpPath],
    freezeEvidencePath: freezePath,
    sourceStageSha256: SOURCE_STAGE_SHA,
    verifiedAt: '2026-07-10T00:00:00.000Z',
  });
  assert.deepEqual(evidence.steps.map((step) => step.id), [
    'sign-helper',
    'sign-addon',
    'sign-launcher',
    'verify-authenticode',
    'freeze-signed-manifests',
    'sign-zxp',
    'verify-zxp',
  ]);
  assert.equal(evidence.steps[4].inputSha256, evidence.steps[3].outputSha256);
  assert.equal(evidence.steps[5].inputSha256, evidence.steps[4].outputSha256);
});

test('Phase 0 assembler rejects noncanonical, malformed, or unbound freeze evidence', async (t) => {
  const platform = 'windows-x64';
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-phase0-freeze-'));
  t.after(() => fs.promises.rm(temp, { recursive: true, force: true }));
  const outputRoot = path.join(temp, 'build', 'phase0', 'signing', platform);
  await fs.promises.mkdir(outputRoot, { recursive: true });
  const finalArtifact = phase0FinalArtifactPath({ outputRoot, platform });
  const finalBytes = Buffer.from('signed-windows-freeze-contract\n', 'utf8');
  await fs.promises.writeFile(finalArtifact, finalBytes);
  const steps = buildSteps(platform, sha256Bytes(finalBytes));
  const identities = aggregateIdentity(platform);
  const nestedPath = path.join(outputRoot, 'nested-evidence.json');
  const freezePath = path.join(outputRoot, 'freeze-evidence.json');
  const zxpPath = path.join(outputRoot, 'zxp-evidence.json');
  await writeCanonical(nestedPath, {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    steps: steps.slice(0, 4),
    verifiedIdentity: identities.nested,
  });
  await writeCanonical(zxpPath, {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    steps: steps.slice(5),
    verifiedIdentity: identities.zxp,
  });

  const assemble = () => assemblePhase0SigningEvidence({
    outputRoot,
    platform,
    sliceEvidencePaths: [nestedPath, zxpPath],
    freezeEvidencePath: freezePath,
    sourceStageSha256: SOURCE_STAGE_SHA,
    verifiedAt: '2026-07-10T00:00:00.000Z',
  });

  await fs.promises.writeFile(freezePath, JSON.stringify({
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    step: steps[4],
  }, null, 2));
  await assert.rejects(assemble, { code: 'PHASE0_EVIDENCE_NONCANONICAL' });

  await writeCanonical(freezePath, {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    step: steps[4],
    unexpected: true,
  });
  await assert.rejects(assemble, { code: 'SIGNING_STEP_INVALID' });

  await writeCanonical(freezePath, {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    step: { ...steps[4], inputSha256: 'f'.repeat(64) },
  });
  await assert.rejects(assemble, { code: 'SIGNING_DIGEST_CHAIN_INVALID' });

  await writeCanonical(freezePath, {
    schemaVersion: 1,
    platform,
    sourceStageSha256: SOURCE_STAGE_SHA,
    step: { ...steps[4], outputSha256: 'e'.repeat(64) },
  });
  await assert.rejects(assemble, { code: 'SIGNING_DIGEST_CHAIN_INVALID' });
});

test('Phase 0 runners execute manifest freezing before ZXP signing', async () => {
  for (const relative of [
    'scripts/phase0/run-signing-probe-macos.sh',
    'scripts/phase0/run-signing-probe-windows.ps1',
  ]) {
    const source = await fs.promises.readFile(relative, 'utf8');
    const nested = source.indexOf(relative.endsWith('.sh')
      ? 'sign-macos-nested.sh'
      : 'sign-windows-nested.ps1');
    const freeze = source.indexOf('freeze-signed-manifests.mjs');
    const zxp = source.indexOf('build-zxp.mjs');
    const zxpInvocationEnd = source.indexOf('zxp-evidence.json', zxp);
    assert.ok(nested >= 0 && nested < freeze, `${relative} freezes after nested signing`);
    assert.ok(freeze < zxp, `${relative} freezes before ZXP signing`);
    assert.ok(zxpInvocationEnd > zxp, `${relative} has a bounded ZXP invocation`);
    assert.match(source, /freeze-evidence\.json/);
    assert.match(
      source.slice(zxp, zxpInvocationEnd),
      /--source-stage-sha256/,
      `${relative} binds the ZXP slice to the unsigned source-stage digest`,
    );
  }
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
  assert.deepEqual(schema.$defs.helperEvidence.required, [
    'schemaVersion',
    'kind',
    'platform',
    'helperIdentity',
    'afterEffects',
    'backendAccess',
    'signingOutputSha256',
    'adversarialCases',
  ]);
  assert.deepEqual(schema.$defs.helperEvidence.properties.afterEffects.required, ['25', '26']);
  assert.deepEqual(schema.$defs.helperEvidence.properties.backendAccess.required, ['secret', 'capture']);
  assert.equal(schema.$defs.stepId.enum.includes('freeze-signed-manifests'), true);
  assert.equal(schema.$defs.signingEvidence.properties.steps.minItems, 7);
  assert.equal(schema.$defs.signingEvidence.properties.steps.maxItems, 13);
  assert.deepEqual(schema.$defs.zxpIdentity.required, [
    'zxpCertificateFingerprint',
    'zxpPayloadSha256',
    'zxpVerified',
  ]);
});

test('adversarial helper probe uses the addon and requires measured zero backend access', async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-helper-rejected-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const loaded = [];
  const requests = [];
  let closes = 0;
  const result = await assertHelperRejected({
    platform: 'macos-arm64',
    root,
    method: 'secret.get',
    loadAddon(addonPath) {
      loaded.push(addonPath);
      return {
        createTransport() {
          return {
            async request(jsonUtf8) {
              const request = JSON.parse(jsonUtf8);
              requests.push(request);
              return JSON.stringify({
                protocolVersion: 1,
                id: request.id,
                ok: false,
                error: {
                  code: 'HELPER_UNAUTHORIZED',
                  message: 'caller rejected before access; backendAccessCount=0',
                  retryable: false,
                },
              });
            },
            async close() { closes += 1; },
          };
        },
      };
    },
  });
  assert.match(loaded[0], /lib[\\/]ae-mcp-platform-helper-transport\.node$/);
  assert.deepEqual(requests, [{
    protocolVersion: 1,
    id: 1,
    method: 'secret.get',
    params: { reference: 'forged' },
  }]);
  assert.deepEqual(result, { code: 'HELPER_UNAUTHORIZED', backendAccessCount: 0 });
  assert.equal(closes, 1);
});

test('adversarial rejection evidence fails closed for success, nonzero, or unmeasured access', () => {
  const base = {
    protocolVersion: 1,
    id: 1,
    ok: false,
    error: {
      code: 'HELPER_UNAUTHORIZED',
      message: 'caller rejected before access; backendAccessCount=0',
      retryable: false,
    },
  };
  assert.deepEqual(validateRejectedResponse(base, 1), {
    code: 'HELPER_UNAUTHORIZED',
    backendAccessCount: 0,
  });
  assert.throws(() => validateRejectedResponse({ ...base, ok: true, result: {} }, 1), {
    code: 'PHASE0_HELPER_REJECTION_INVALID',
  });
  assert.throws(() => validateRejectedResponse({
    ...base,
    error: { ...base.error, message: 'caller rejected' },
  }, 1), { code: 'PHASE0_HELPER_REJECTION_INVALID' });
  assert.throws(() => validateRejectedResponse({
    ...base,
    error: { ...base.error, message: 'caller rejected; backendAccessCount=1' },
  }, 1), { code: 'PHASE0_HELPER_REJECTION_INVALID' });
});
