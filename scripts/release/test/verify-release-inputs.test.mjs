import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildSigningPlan } from '../../package/signing-plan.mjs';
import { canonicalJson } from '../../package/lib/manifest.mjs';
import {
  buildLicenseInventory,
  buildRuntimeSpdx,
} from '../../package/lib/runtime-evidence.mjs';

import {
  buildArtifactManifest,
  canonicalStringify,
  sha256File,
  verifyArtifactManifest,
} from '../artifact-manifest.mjs';
import {
  reconcileAttestationState,
  verifyReleaseInputs,
} from '../verify-release-inputs.mjs';

const candidateSha = 'd'.repeat(40);
const PASS_COMMANDS = {
  'macos-arm64': [
    'bind installed runtime manifest to RC bundle',
    'shasum -a 256 artifact and bind manifest',
    'codesign --verify --deep --strict',
    'spctl --assess',
    'xcrun stapler validate',
    'mount exact notarized DMG',
    'verify exact ZXP payload from DMG',
    'extract exact signed ZXP for launcher binding',
    'bind installed stable launcher to signed ZXP',
    'install exact signed ZXP',
    'AE 25 installed-runtime smoke',
    'AE 26 installed-runtime smoke',
  ],
  'windows-x64': [
    'Get-FileHash -Algorithm SHA256 and bind manifest',
    'Get-AuthenticodeSignature for every packaged executable',
    'install exact signed ZXP',
    'AE 25 installed-runtime smoke',
    'AE 26 installed-runtime smoke',
  ],
};
const PASS_OS = {
  'macos-arm64': 'macOS 14.0',
  'windows-x64': 'Windows 10.0.26100',
};
const FINAL_ROOT_SHA256 = '8'.repeat(64);
const PRODUCT_SCENARIOS = [
  'clean-install-and-upgrade-rollback',
  'permission-denial-and-recovery',
  'persistence',
  'provider-header-routing',
  'tool-library',
];

function signingSteps(platform, outputDigests) {
  let current = FINAL_ROOT_SHA256;
  return buildSigningPlan(platform).steps.map((step) => {
    const inputSha256 = current;
    if (step.id === 'sign-zxp') current = outputDigests.zxp;
    if (step.id === 'build-dmg') current = outputDigests.dmg;
    return { id: step.id, inputSha256, outputSha256: current, exitCode: 0 };
  });
}

function commandEvidence(platform, result) {
  return result === 'PASS'
    ? PASS_COMMANDS[platform].map((command) => ({ command, exitCode: 0 }))
    : [{ command: 'partial diagnostic', exitCode: 1 }];
}

const manifest = {
  schemaVersion: 1,
  version: '0.9.2',
  candidateSha,
  workflowRunId: '42',
  artifacts: [
    {
      platform: 'macos-arm64', role: 'install', artifactId: '100',
      name: 'mac.dmg', sha256: 'a'.repeat(64),
    },
    {
      platform: 'windows-x64', role: 'install', artifactId: '101',
      name: 'win.zxp', sha256: 'b'.repeat(64),
    },
  ],
};

function report(platform, result, updatedAt, overrides = {}) {
  const artifact = manifest.artifacts.find((item) => item.platform === platform);
  return {
    deleted: false,
    updatedAt,
    report: {
      schemaVersion: 1,
      platform,
      result,
      candidateSha,
      workflowRunId: '42',
      artifactId: artifact.artifactId,
      artifactName: artifact.name,
      artifactSha256: artifact.sha256,
      osVersion: PASS_OS[platform],
      codexVersion: '0.144.0-alpha.4',
      ae: [
        { major: 25, version: '25.6', result },
        { major: 26, version: '26.3', result },
      ],
      commands: commandEvidence(platform, result),
      failures: result === 'PASS' ? [] : ['smoke failed'],
      ...overrides,
    },
  };
}

function workflowJob(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow job is missing: ${name}`);
  const bodyStart = start + marker.length;
  const next = workflow.slice(bodyStart).search(/\n  [a-z][a-z0-9-]*:\n/);
  return next === -1
    ? workflow.slice(bodyStart)
    : workflow.slice(bodyStart, bodyStart + next);
}

test('both current platform PASS reports release the candidate', () => {
  assert.deepEqual(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest,
    attestations: [
      report('macos-arm64', 'PASS', 1),
      report('windows-x64', 'PASS', 1),
    ],
  }), []);
});

test('missing, stale, deleted, mismatched, or later FAIL blocks release', () => {
  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest,
    attestations: [report('windows-x64', 'PASS', 1)],
  })[0], /macos-arm64/);

  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: 'e'.repeat(40),
    manifest,
    attestations: [],
  })[0], /protected main/);

  const bad = report('windows-x64', 'PASS', 1, { artifactSha256: 'f'.repeat(64) });
  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest,
    attestations: [report('macos-arm64', 'PASS', 1), bad],
  }).join(' '), /digest/);

  const deleted = { ...report('macos-arm64', 'PASS', 2), deleted: true };
  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest,
    attestations: [
      report('macos-arm64', 'PASS', 1),
      deleted,
      report('windows-x64', 'PASS', 1),
    ],
  }).join(' '), /macos-arm64/);

  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest,
    attestations: [
      report('macos-arm64', 'PASS', 1),
      report('windows-x64', 'PASS', 1),
      report('windows-x64', 'FAIL', 2),
    ],
  }).join(' '), /windows-x64 candidate was rejected by FAIL/);

  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest,
    attestations: [
      report('macos-arm64', 'PASS', 1),
      report('windows-x64', 'FAIL', 2),
      report('windows-x64', 'PASS', 3),
    ],
  }).join(' '), /windows-x64 candidate was rejected by FAIL/);
});

test('editing or deleting active evidence cannot revive an older PASS', () => {
  const active = report('windows-x64', 'PASS', 2);
  const tombstone = {
    deleted: true,
    updatedAt: 3,
    platform: 'windows-x64',
    candidateSha,
    artifactId: '101',
    report: null,
  };
  const errors = verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest,
    attestations: [
      report('macos-arm64', 'PASS', 1),
      report('windows-x64', 'PASS', 1),
      active,
      tombstone,
    ],
  });
  assert.match(errors.join(' '), /windows-x64 current attestation is missing/);
});

test('release gate binds manifest identity, workflow run, artifact name, and one install per platform', () => {
  const wrongRun = report('windows-x64', 'PASS', 1, { workflowRunId: '43' });
  const wrongName = report('macos-arm64', 'PASS', 1, { artifactName: 'other.dmg' });
  const malformedManifest = structuredClone(manifest);
  malformedManifest.artifacts.push({ ...manifest.artifacts[0], artifactId: '999' });

  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest,
    attestations: [report('macos-arm64', 'PASS', 1), wrongRun],
  }).join(' '), /workflow run id mismatch/);
  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest,
    attestations: [wrongName, report('windows-x64', 'PASS', 1)],
  }).join(' '), /artifact name mismatch/);
  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest: malformedManifest,
    attestations: [],
  }).join(' '), /exactly one install artifact/);
});

function event(overrides = {}) {
  return {
    action: 'created',
    commentId: '500',
    updatedAt: 10,
    candidateSha,
    platform: 'windows-x64',
    artifactId: '101',
    artifactSha256: 'b'.repeat(64),
    runId: '700',
    runAttempt: 1,
    report: report('windows-x64', 'PASS', 10).report,
    ...overrides,
  };
}

test('reconciler makes deletion require fresh evidence and never falls back to an older PASS', () => {
  const passed = reconcileAttestationState(null, event());
  assert.equal(passed.conclusion, 'success');
  assert.equal(passed.activeCommentId, '500');
  assert.equal(passed.activeRunId, '700');
  assert.equal(passed.activeRunAttempt, 1);

  const deleted = reconcileAttestationState(passed, event({
    action: 'deleted', report: null, updatedAt: 11,
  }));
  assert.equal(deleted.conclusion, 'failure');
  assert.equal(deleted.activeCommentId, null);
  assert.equal(deleted.activeRunId, null);
  assert.equal(deleted.activeRunAttempt, 0);
  assert.equal(deleted.freshEvidenceAfter, 11);

  const stale = reconcileAttestationState(deleted, event({
    action: 'created', commentId: '499', updatedAt: 10,
  }));
  assert.equal(stale.conclusion, 'failure');
  assert.equal(stale.activeCommentId, null);

  const fresh = reconcileAttestationState(stale, event({
    action: 'created', commentId: '501', updatedAt: 12,
  }));
  assert.equal(fresh.conclusion, 'success');
  assert.equal(fresh.activeCommentId, '501');
});

test('unrelated and cross-platform events preserve active Check run provenance', () => {
  const passed = reconcileAttestationState(null, event());
  const unrelatedEdit = reconcileAttestationState(passed, event({
    action: 'edited', commentId: '999', updatedAt: 11, report: null,
    runId: '701', runAttempt: 1,
  }));
  assert.deepEqual(unrelatedEdit, passed);

  const otherPlatformEdit = reconcileAttestationState(passed, event({
    action: 'edited', commentId: '800', updatedAt: 12, report: null,
    runId: '702', runAttempt: 1,
  }));
  assert.deepEqual(otherPlatformEdit, passed);
});

test('a fully verified rerun of the same active event refreshes only its attempt', () => {
  const passed = reconcileAttestationState(null, event());
  const rerun = reconcileAttestationState(passed, event({
    runId: '700', runAttempt: 2,
  }));
  assert.equal(rerun.activeCommentId, '500');
  assert.equal(rerun.activeUpdatedAt, 10);
  assert.equal(rerun.activeRunId, '700');
  assert.equal(rerun.activeRunAttempt, 2);
});

test('a valid FAIL permanently rejects one candidate/artifact identity only', () => {
  const failedReport = report('windows-x64', 'FAIL', 11).report;
  const rejected = reconcileAttestationState(null, event({
    report: failedReport,
    updatedAt: 11,
  }));
  assert.equal(rejected.candidateRejected, true);
  assert.equal(rejected.conclusion, 'failure');

  const laterPass = reconcileAttestationState(rejected, event({
    commentId: '501', updatedAt: 12,
  }));
  assert.equal(laterPass.candidateRejected, true);
  assert.equal(laterPass.conclusion, 'failure');

  const newArtifact = reconcileAttestationState(rejected, event({
    artifactId: '102',
    artifactSha256: 'c'.repeat(64),
    report: {
      ...report('windows-x64', 'PASS', 13).report,
      artifactId: '102',
      artifactSha256: 'c'.repeat(64),
    },
    updatedAt: 13,
  }));
  assert.equal(newArtifact.candidateRejected, false);
  assert.equal(newArtifact.conclusion, 'success');
});

test('invalid edits fail the active Check but unrelated invalid comments do not erase it', () => {
  const passed = reconcileAttestationState(null, event());
  const unrelated = reconcileAttestationState(passed, event({
    action: 'edited', commentId: '999', updatedAt: 11, report: null,
  }));
  assert.deepEqual(unrelated, passed);

  const invalidActive = reconcileAttestationState(passed, event({
    action: 'edited', updatedAt: 12, report: null,
  }));
  assert.equal(invalidActive.activeCommentId, null);
  assert.equal(invalidActive.activeRunId, null);
  assert.equal(invalidActive.activeRunAttempt, 0);
  assert.equal(invalidActive.conclusion, 'failure');
  assert.equal(invalidActive.freshEvidenceAfter, 12);
});

test('pre-invalidated edits cannot restore PASS but a valid FAIL still rejects the candidate', () => {
  const passed = reconcileAttestationState(null, event());
  const preInvalidated = reconcileAttestationState(passed, event({
    action: 'edited', updatedAt: 11, report: null,
  }));
  assert.equal(preInvalidated.conclusion, 'failure');
  assert.equal(preInvalidated.freshEvidenceAfter, 11);

  const sameEditPass = reconcileAttestationState(preInvalidated, event({
    action: 'edited', updatedAt: 11,
  }));
  assert.equal(sameEditPass.conclusion, 'failure');
  assert.equal(sameEditPass.activeCommentId, null);

  const sameEditFail = reconcileAttestationState(preInvalidated, event({
    action: 'edited',
    updatedAt: 11,
    report: report('windows-x64', 'FAIL', 11).report,
  }));
  assert.equal(sameEditFail.candidateRejected, true);
  assert.equal(sameEditFail.conclusion, 'failure');
});

test('a delayed older FAIL still rejects after a newer PASS was reconciled first', () => {
  const newerPass = reconcileAttestationState(null, {
    candidateSha,
    platform: 'windows-x64',
    artifactId: '101',
    artifactSha256: 'b'.repeat(64),
    commentId: '500',
    action: 'edited',
    updatedAt: 20,
    report: report('windows-x64', 'PASS', 20).report,
  });
  assert.equal(newerPass.conclusion, 'success');

  const delayedFail = reconcileAttestationState(newerPass, {
    candidateSha,
    platform: 'windows-x64',
    artifactId: '101',
    artifactSha256: 'b'.repeat(64),
    commentId: '500',
    action: 'created',
    updatedAt: 10,
    report: report('windows-x64', 'FAIL', 10).report,
  });
  assert.equal(delayedFail.candidateRejected, true);
  assert.equal(delayedFail.conclusion, 'failure');
});

test('attestation workflow is default-branch trusted and handles the full comment lifecycle', async () => {
  const workflow = await readFile('.github/workflows/attestation.yml', 'utf8');
  assert.match(workflow, /issue_comment:\s*\n\s+types: \[created, edited, deleted\]/);
  assert.match(workflow, /actions: read\s+checks: write\s+contents: read\s+issues: read\s+pull-requests: read/);
  assert.match(workflow, /group: rc-attestation-\$\{\{ github\.event\.issue\.number \}\}-\$\{\{ github\.event\.comment\.id \}\}/);
  assert.match(workflow, /group: rc-attestation-\$\{\{ github\.event\.issue\.number \}\}-\$\{\{ github\.event\.comment\.id \}\}\s+queue: max\s+cancel-in-progress: false/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /default_branch[^\n]*===?[^\n]*['"]main['"]/);
  assert.match(workflow, /pulls\.get/);
  assert.match(workflow, /repos\.getBranch/);
  assert.match(workflow, /branch\.protected/);
  assert.match(workflow, /pr\.merged[\s\S]*pr\.base\.ref[\s\S]*pr\.merge_commit_sha/);
  assert.match(workflow, /origin\/main/);
  assert.match(workflow, /AE_MCP_RC_ATTESTORS/);
  assert.doesNotMatch(workflow, /pull_request_target/);
});

test('attestation workflow serializes every state mutation without delaying tombstones on environments', async () => {
  const workflow = await readFile('.github/workflows/attestation.yml', 'utf8');
  const parse = workflowJob(workflow, 'parse');
  assert.match(parse, /permissions:\s+contents: read[\s\S]*pull-requests: read/);
  assert.doesNotMatch(parse, /checks: write/);
  assert.doesNotMatch(parse, /checks\.(?:create|update)/,
    'parse must be read-only with respect to deterministic Checks');
  assert.match(parse, /validate_macos/);
  assert.match(parse, /validate_windows/);
  assert.match(parse, /\['edited', 'deleted'\]\.includes\(context\.payload\.action\)/);

  for (const platform of ['macos', 'windows']) {
    const platformId = platform === 'macos' ? 'macos-arm64' : 'windows-x64';
    const preinvalidate = workflowJob(workflow, `preinvalidate-${platform}`);
    const validate = workflowJob(workflow, `validate-${platform}`);
    const reconcile = workflowJob(workflow, `reconcile-${platform}`);

    assert.doesNotMatch(preinvalidate, /environment:/);
    assert.match(preinvalidate, /permissions:\s+checks: write\s+contents: read/);
    assert.match(preinvalidate, new RegExp(
      `group: rc-attestation-state-\\$\\{\\{ needs\\.parse\\.outputs\\.candidate_sha \\}\\}-${platformId}`,
    ));
    assert.match(preinvalidate, /queue: max\s+cancel-in-progress: false/);

    assert.match(validate, new RegExp(`environment: ${platform}-rc`));
    assert.match(validate, /permissions:\s+actions: read\s+contents: read[\s\S]*pull-requests: read/);
    assert.doesNotMatch(validate, /checks: write/);
    assert.doesNotMatch(validate, /checks\.(?:create|update)/,
      'protected environment validation must not mutate Check state');
    assert.match(validate, /verified_report/);

    assert.doesNotMatch(reconcile, /environment:/);
    assert.match(reconcile, /permissions:\s+checks: write\s+contents: read\s+issues: read\s+pull-requests: read/);
    assert.match(reconcile, new RegExp(
      `group: rc-attestation-state-\\$\\{\\{ needs\\.parse\\.outputs\\.candidate_sha \\}\\}-${platformId}`,
    ));
    assert.match(reconcile, /queue: max\s+cancel-in-progress: false/);
    assert.match(reconcile, /if: \$\{\{ always\(\)/);
  }

  const preinvalidateWriter = workflowJob(workflow, 'preinvalidate-macos');
  const reconcileWriter = workflowJob(workflow, 'reconcile-macos');
  assert.ok(preinvalidateWriter.indexOf('priorCheck()') < preinvalidateWriter.indexOf('checks.update'),
    'preinvalidate must re-read the latest state immediately before writing');
  assert.ok(reconcileWriter.indexOf('priorCheck()') < reconcileWriter.indexOf('checks.update'),
    'reconcile must re-read the latest state immediately before writing');
  assert.match(reconcileWriter, /issues\.getComment/,
    'a PASS must be checked against the current comment before it becomes active');
  assert.match(reconcileWriter, /VALIDATION_RESULT/);
  assert.match(reconcileWriter, /activeRunId/);
  assert.match(reconcileWriter, /activeRunAttempt/);
  assert.match(reconcileWriter, /canonicalStringify\(state\)\s*===\s*canonicalStringify\(previous\.state\)/,
    'an unrelated or cross-platform no-op must preserve the prior Check details URL');
});

test('attestation workflow pins actions and binds platform checks to immutable bytes', async () => {
  const workflow = await readFile('.github/workflows/attestation.yml', 'utf8');
  assert.match(workflow, /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/g);
  assert.match(workflow, /actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3/g);
  assert.doesNotMatch(workflow, /uses:\s+[^\n]+@v\d/);
  assert.match(workflow, /environment: macos-rc/);
  assert.match(workflow, /environment: windows-rc/);
  assert.match(workflow, /group: rc-attestation-state-\$\{\{ needs\.parse\.outputs\.candidate_sha \}\}-macos-arm64\s+queue: max\s+cancel-in-progress: false/g);
  assert.match(workflow, /group: rc-attestation-state-\$\{\{ needs\.parse\.outputs\.candidate_sha \}\}-windows-x64\s+queue: max\s+cancel-in-progress: false/g);
  assert.match(workflow, /macos-rc-attestation/);
  assert.match(workflow, /windows-rc-attestation/);
  assert.match(workflow, /ae-mcp-rc:\$\{candidateSha\}:\$\{platform\}/);
  assert.match(workflow, /ae-mcp-attestation-state:v1:/);
  assert.match(workflow, /reconcileAttestationState/);
  assert.match(workflow, /validateAttestation/);
  assert.match(workflow, /artifact-manifest-v0\.9\.2\.json/);
  assert.match(workflow, /sha256File/);
  assert.match(workflow, /artifact\.expired !== false/);
  assert.match(workflow, /artifact\.name !== report\.artifactName/);
  assert.match(workflow, /!Number\.isSafeInteger\(artifact\.size_in_bytes\)[\s\S]{0,100}artifact\.size_in_bytes <= 0/);
  assert.match(workflow, /!Number\.isSafeInteger\(manifestArtifact\.id\)[\s\S]{0,180}manifestArtifact\.expired !== false/);
  assert.match(workflow, /!Number\.isSafeInteger\(manifestArtifact\.size_in_bytes\)[\s\S]{0,100}manifestArtifact\.size_in_bytes <= 0/);
  assert.ok((workflow.match(/AE_MCP_RC_ATTESTORS/g) || []).length >= 2);
  assert.match(workflow, /author_allowed: \$\{\{ steps\.parse\.outputs\.author_allowed \}\}/);
  assert.match(workflow, /AUTHOR_ALLOWED: \$\{\{ needs\.parse\.outputs\.author_allowed \}\}/g);
  assert.match(workflow, /reconcileAttestationState\(previous\.state, \{/);
  assert.match(workflow, /freshEvidenceAfter/);
  assert.equal((workflow.match(/run-id: \$\{\{ steps\.metadata\.outputs\.run_id \}\}/g) || []).length, 2);
  assert.ok((workflow.match(/repository: \$\{\{ github\.repository \}\}/g) || []).length >= 4);
  assert.match(workflow, /run\.event !== 'workflow_dispatch'/);
  assert.match(workflow, /\['edited', 'deleted'\]\.includes\(context\.payload\.action\)/);
  assert.match(workflow, /serializeArtifactManifest/);
  assert.match(workflow, /MAX_ARTIFACT_MANIFEST_BYTES/);
  assert.doesNotMatch(workflow, /const digestFields = \[/);
});

test('attestation Check provenance is constrained and its same-App limitation is explicit', async () => {
  const workflow = await readFile('.github/workflows/attestation.yml', 'utf8');
  const writers = [
    workflowJob(workflow, 'preinvalidate-macos'),
    workflowJob(workflow, 'reconcile-macos'),
  ].join('\n');
  assert.equal((writers.match(/app\?\.id !== 15368/g) || []).length, 2);
  assert.equal((writers.match(/app\?\.slug !== 'github-actions'/g) || []).length, 2);

  const docs = await readFile('docs/WORKFLOW.md', 'utf8');
  assert.match(docs, /GitHub Actions App[^\n]*(?:共享|shared)/i);
  assert.match(docs, /checks:write/);
  assert.match(docs, /外部前置|external prerequisite/i);
});

test('attestation workflow does not interpolate or log untrusted comment bodies', async () => {
  const workflow = await readFile('.github/workflows/attestation.yml', 'utf8');
  assert.doesNotMatch(workflow, /\$\{\{\s*github\.event\.comment\.body\s*\}\}/);
  assert.doesNotMatch(workflow, /console\.log|core\.(?:debug|info|notice|warning)\([^\n]*(?:body|report)/);
  assert.doesNotMatch(workflow, /commands|failures|provider/i);
  assert.match(workflow, /48 \* 1024/);
  assert.match(workflow, /expected exactly one attestation marker/);
});

test('attestation and release readers share the aggregate manifest schema and size contract', async () => {
  const attestation = await readFile('.github/workflows/attestation.yml', 'utf8');
  const release = await readFile('.github/workflows/release.yml', 'utf8');

  assert.match(attestation, /MAX_ARTIFACT_MANIFEST_BYTES/);
  assert.match(attestation, /serializeArtifactManifest|validateArtifactManifestStructure/);
  assert.doesNotMatch(attestation, /manifestStat\.size > 8 \* 1024 \* 1024/);
  assert.doesNotMatch(attestation, /const digestFields = \[\s*['"]bundleManifest['"][\s\S]{0,240}['"]signingReport['"]\s*,?\s*\]/);
  assert.ok((release.match(/MAX_ARTIFACT_MANIFEST_BYTES/g) || []).length >= 6,
    'every release manifest reader must import and enforce the shared aggregate limit');
  assert.ok((release.match(/serializeArtifactManifest/g) || []).length >= 3,
    'every release manifest reader must use the shared structural serializer');
});

test('release promotion trusts protected main and downloads exact artifacts from one build run', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+candidate_sha:/);
  assert.match(workflow, /build_run_id:/);
  assert.match(workflow, /version:/);
  assert.match(workflow, /actions: read\s+checks: read\s+contents: write/);
  assert.match(workflow, /issues: read/);
  assert.match(workflow, /pull-requests: read/);
  assert.match(workflow, /environment: release-promotion/);
  assert.match(workflow, /group: release-v0\.9\.2\s+queue: max\s+cancel-in-progress: false/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/);
  assert.match(workflow, /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/);
  assert.match(workflow, /node-version: 24\.17\.0/);
  assert.match(workflow, /\[\[ "\$\(node --version\)" == 'v24\.17\.0' \]\]/);
  assert.match(workflow, /actions\/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3/g);
  assert.equal((workflow.match(/actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/g) || []).length, 4);
  assert.doesNotMatch(workflow, /uses:\s+[^\n]+@v\d/);
  assert.equal((workflow.match(/run-id: \$\{\{ steps\.resolve\.outputs\.build_run_id \}\}/g) || []).length, 4);
  assert.equal((workflow.match(/repository: \$\{\{ github\.repository \}\}/g) || []).length, 5);
  assert.equal((workflow.match(/github-token: \$\{\{ github\.token \}\}/g) || []).length, 4);
  for (const output of [
    'mac_dmg_artifact_id',
    'mac_zxp_artifact_id',
    'windows_zxp_artifact_id',
    'manifest_artifact_id',
  ]) {
    assert.match(workflow, new RegExp(`artifact-ids: \\$\\{\\{ steps\\.resolve\\.outputs\\.${output} \\}\\}`));
  }
  assert.match(workflow, /actions\.getWorkflowRun/);
  assert.match(workflow, /actions\.getWorkflow/);
  assert.match(workflow, /run\.workflow_id/);
  assert.match(workflow, /run\.event !== 'workflow_dispatch'/);
  assert.match(workflow, /run\.head_sha !== candidateSha/);
  assert.match(workflow, /run\.head_branch !== 'main'/);
  assert.match(workflow, /run\.run_attempt !== 1/);
  assert.match(workflow, /run\.status !== 'completed'/);
  assert.match(workflow, /run\.conclusion !== 'success'/);
  assert.match(workflow, /\.github\/workflows\/build-rc\.yml/);
  assert.match(workflow, /artifact\.expired/);
  assert.match(workflow, /branch\.protected/);
  assert.match(workflow, /origin\/main/);
  assert.match(workflow, /GITHUB_WORKFLOW_SHA/);
});

test('release promotion validates canonical bytes and deterministic attestation Check state before tag', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  const verifyIndex = workflow.indexOf('verifyArtifactManifest');
  const checksIndex = workflow.indexOf('listAllCheckRunsForRef');
  const tagIndex = workflow.indexOf('git.createTag');
  assert.ok(verifyIndex >= 0 && verifyIndex < tagIndex, 'byte verification must precede tag creation');
  assert.ok(checksIndex >= 0 && checksIndex < tagIndex, 'attestation verification must precede tag creation');
  assert.match(workflow, /canonicalStringify/);
  assert.match(workflow, /verifyArtifactManifest/);
  assert.match(workflow, /sha256File/);
  assert.match(workflow, /artifact-manifest-v0\.9\.2\.json/);
  assert.match(workflow, /ae-mcp-panel-v0\.9\.2-macos-arm64\.dmg/);
  assert.match(workflow, /ae-mcp-panel-v0\.9\.2-macos-arm64\.zxp/);
  assert.match(workflow, /ae-mcp-panel-v0\.9\.2-windows-x64\.zxp/);
  assert.match(workflow, /macos-rc-attestation/);
  assert.match(workflow, /windows-rc-attestation/);
  assert.match(workflow, /ae-mcp-rc:\$\{candidateSha\}:\$\{platform\}/);
  assert.match(workflow, /check\.app\?\.id !== 15368/);
  assert.match(workflow, /check\.app\?\.slug !== 'github-actions'/);
  assert.match(workflow, /duplicate deterministic attestation Check/);
  assert.match(workflow, /candidateRejected/);
  assert.match(workflow, /activeCommentId/);
  assert.match(workflow, /activeRunId/);
  assert.match(workflow, /activeRunAttempt/);
  assert.match(workflow, /freshEvidenceAfter/);
  assert.match(workflow, /state\.artifactId/);
  assert.match(workflow, /state\.artifactSha256/);
  assert.ok((workflow.match(/issues\.getComment/g) || []).length >= 2,
    'active PR comment must be fetched again before tag and publish');
  assert.ok((workflow.match(/pulls\.get/g) || []).length >= 2,
    'the comment PR must still be the merged protected-main candidate');
  assert.match(workflow, /pr\.merged !== true/);
  assert.match(workflow, /pr\.base\?\.ref !== 'main'/);
  assert.match(workflow, /pr\.merge_commit_sha !== candidateSha/);
  assert.match(workflow, /decodeAttestationComment/);
  assert.match(workflow, /validateAttestation/);
  assert.match(workflow, /AE_MCP_RC_ATTESTORS/);
  assert.match(workflow, /comment\.updated_at/);
  assert.match(workflow, /comment\.body/);
  assert.match(workflow, /comment\.user\?\.login/);
  assert.match(workflow, /active attestation comment was deleted or is unavailable/);
  assert.match(workflow, /active attestation comment timestamp mismatch/);
  assert.match(workflow, /active attestation comment body mismatch/);
  assert.match(workflow, /active attestation comment author mismatch/);
  assert.ok((workflow.match(/issues\.listComments/g) || []).length >= 2,
    'current PR comment history must be reconciled before tag and publish');
  assert.ok((workflow.match(/listAllWorkflowRunsForWorkflow/g) || []).length >= 2,
    'every latest attestation workflow attempt must be audited before tag and publish');
  assert.match(workflow, /current valid FAIL comment blocks promotion/);
  assert.ok((workflow.match(/latestByRun/g) || []).length >= 2);
  assert.ok((workflow.match(/run\.status !== 'completed' \|\| run\.conclusion !== 'success'/g) || []).length >= 2);
  assert.match(workflow, /signed-rc-build/);
  assert.match(workflow, /ae-mcp-build-lock:/);
  assert.match(workflow, /git\.createTag/);
  assert.match(workflow, /git\.createRef/);
  assert.match(workflow, /git\.getTag/);
  assert.match(workflow, /refs\/tags\/v0\.9\.2/);

  assert.doesNotMatch(workflow, /actions\/upload-artifact/);
  assert.doesNotMatch(workflow, /npm\s+(?:ci|install|run\s+build)|pip\s+install|uv\s+sync/);
  assert.doesNotMatch(workflow, /stage-platform-bundle|build-portable-runtime|build-platform-helper/);
  assert.doesNotMatch(
    workflow,
    /run-signing-plan|codesign|signtool|package-macos-dmg|ZXPSignCmd(?:\.exe)?\s+-(?:sign|verify)/i,
  );
});

test('release promotion resumes only an identical draft and verifies all assets before publication', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  const tagIndex = workflow.indexOf('git.createTag');
  const releaseIndex = workflow.indexOf('repos.createRelease');
  const snapshotIndex = workflow.indexOf('release-inventory.json');
  const publishIndex = workflow.lastIndexOf('repos.updateRelease');
  assert.ok(tagIndex >= 0 && tagIndex < releaseIndex, 'tag must precede draft release');
  assert.ok(releaseIndex < snapshotIndex && snapshotIndex < publishIndex,
    'draft assets must be snapshotted and reverified before publication');
  assert.match(workflow, /draft: true/);
  assert.ok((workflow.match(/repos\.listReleases/g) || []).length >= 4,
    'every draft lookup must enumerate releases and bind the persisted ID');
  assert.doesNotMatch(workflow, /repos\.getReleaseByTag/);
  assert.doesNotMatch(workflow, /repos\.getRelease\(/);
  assert.match(workflow, /core\.setOutput\('release_id', String\(release\.id\)\)/);
  assert.match(workflow, /RELEASE_ID: \$\{\{ steps\.release\.outputs\.release_id \}\}/g);
  assert.match(workflow, /releases\/\$\{releaseId\}\/assets\?name=\$\{name\}/);
  assert.match(workflow, /releases\/assets\/\$\{asset\.id\}/);
  assert.match(workflow, /exec\.exec\('curl'/g);
  assert.doesNotMatch(workflow, /gh release (?:upload|download)/);
  assert.match(workflow, /release\.draft/);
  assert.match(workflow, /target_commitish: candidateSha/);
  assert.match(workflow, /release\.prerelease/);
  assert.match(workflow, /already published/);
  assert.match(workflow, /missing assets cannot be added to a published release/);
  assert.match(workflow, /release asset inventory changed/);
  assert.ok((workflow.match(/repos\.listReleaseAssets/g) || []).length >= 4,
    'release asset IDs must be fetched again immediately before publication');
  assert.match(workflow, /release asset inventory changed immediately before publication/);
  assert.match(workflow, /release asset digest mismatch/);
  assert.ok((workflow.match(/\/immutable-releases/g) || []).length >= 2,
    'repository immutable releases must be checked before tag and publication');
  assert.match(workflow, /AE_MCP_RELEASE_ADMIN_TOKEN/);
  assert.match(workflow, /immutable\?\.enabled !== true/);
  assert.match(workflow, /published\.immutable !== true/);
  assert.match(workflow, /draft: false/);
  assert.doesNotMatch(workflow, /--clobber|deleteReleaseAsset|deleteRelease|deleteRef/);
});

test('unsigned local rehearsal binds both platform bytes and rejects tamper or later FAIL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-promotion-rehearsal-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const fixtures = [
    ['ae-mcp-panel-v0.9.2-macos-arm64.dmg', 'macos-arm64', '200', 'install'],
    ['ae-mcp-panel-v0.9.2-macos-arm64.zxp', 'macos-arm64', '201', 'payload'],
    ['ae-mcp-panel-v0.9.2-windows-x64.zxp', 'windows-x64', '202', 'install'],
  ];
  for (const [name] of fixtures) await writeFile(join(root, name), `unsigned fixture: ${name}\n`);
  const productAcceptanceEvidencePath = join(root, 'product-acceptance-evidence.json');
  await writeFile(productAcceptanceEvidencePath, canonicalStringify({
    schemaVersion: 1,
    candidateSha,
    result: 'PASS',
    coverage: PRODUCT_SCENARIOS.map((id, index) => ({
      id, result: 'PASS', evidenceSha256: String(index + 1).repeat(64),
    })),
  }));

  const evidence = [];
  for (const platform of ['macos-arm64', 'windows-x64']) {
    const runtimeInventoryPath = join(root, `${platform}-runtime.json`);
    const sbomPath = join(root, `${platform}-sbom.json`);
    const licensesPath = join(root, `${platform}-licenses.json`);
    const component = {
      name: 'runtime:fixture', version: '1.0.0', license: 'MIT',
      source: 'fixture:runtime', sha256: '1'.repeat(64),
    };
    const runtimeInventory = {
      schemaVersion: 1,
      platform,
      node: { version: '24.17.0', assetSha256: '2'.repeat(64) },
      python: {
        version: '3.13.14', distributionRelease: '20260610',
        assetSha256: '3'.repeat(64),
      },
      licenseApprovals: [],
      components: [component],
      files: [{
        path: 'node/bin/node', sha256: '4'.repeat(64), size: 1,
        mode: platform === 'macos-arm64' ? '0755' : '0644', type: 'file',
      }],
    };
    const licenses = buildLicenseInventory({ platform, components: [component] });
    const sbom = buildRuntimeSpdx({ platform, components: [component] });
    await writeFile(runtimeInventoryPath, canonicalJson(runtimeInventory));
    await writeFile(sbomPath, canonicalJson(sbom));
    await writeFile(licensesPath, canonicalJson(licenses));
    const bundleManifestPath = join(root, `${platform}-bundle.json`);
    await writeFile(bundleManifestPath, canonicalJson({
      schemaVersion: 1,
      version: '0.9.2',
      platform,
      sourceCommitSha: candidateSha,
      runtime: {
        nodeVersion: '24.17.0',
        pythonVersion: '3.13.14',
        manifestSha256: await sha256File(runtimeInventoryPath),
        sbomSha256: await sha256File(sbomPath),
        licenseInventorySha256: await sha256File(licensesPath),
      },
      helper: {
        helperId: 'com.junkdoge.ae-mcp.platform-helper',
        manifestSha256: '5'.repeat(64),
      },
      files: [
        {
          path: `platform/${platform}/bin/ae-mcp${platform === 'windows-x64' ? '.exe' : ''}`,
          sha256: '9'.repeat(64), size: 1,
          mode: platform === 'macos-arm64' ? '0755' : '0644', type: 'file',
        },
        {
          path: `platform/${platform}/bin/ae-mcp-platform-helper${platform === 'windows-x64' ? '.exe' : ''}`,
          sha256: 'a'.repeat(64), size: 1,
          mode: platform === 'macos-arm64' ? '0755' : '0644', type: 'file',
        },
        {
          path: `platform/${platform}/helper-manifest.json`, sha256: '5'.repeat(64),
          size: 1, mode: '0644', type: 'file',
        },
      ].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))),
    }));
    const signedBundleManifestPath = join(root, `${platform}-signed-bundle.json`);
    await writeFile(signedBundleManifestPath, await readFile(bundleManifestPath));
    const signingReportPath = join(root, `${platform}-signing.json`);
    const outputs = [];
    const outputDigests = {};
    for (const [name, fixturePlatform] of fixtures.filter((item) => item[1] === platform)) {
      const digest = await sha256File(join(root, name));
      outputDigests[name.endsWith('.dmg') ? 'dmg' : 'zxp'] = digest;
      outputs.push({
        name,
        role: name.endsWith('.dmg') ? 'dmg' : 'zxp',
        sha256: digest,
      });
    }
    outputs.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    const identity = platform === 'macos-arm64'
      ? {
        certificateFingerprint: '6'.repeat(64), developerIdTeamId: 'ABCDE12345',
        notarySubmissionId: '123e4567-e89b-42d3-a456-426614174000',
        stapledTicketVerified: true, gatekeeperVerified: true,
        zxpCertificateFingerprint: '7'.repeat(64),
        zxpPayloadSha256: FINAL_ROOT_SHA256, zxpVerified: true,
      }
      : {
        authenticodeSignerThumbprint: 'F'.repeat(40), timestampVerified: true,
        zxpCertificateFingerprint: '7'.repeat(64),
        zxpPayloadSha256: FINAL_ROOT_SHA256, zxpVerified: true,
      };
    await writeFile(signingReportPath, canonicalStringify({
      schemaVersion: 1,
      platform,
      candidateSha,
      result: 'PASS',
      sourceStageSha256: await sha256File(bundleManifestPath),
      signedBundleManifestSha256: await sha256File(signedBundleManifestPath),
      finalRootSha256: FINAL_ROOT_SHA256,
      steps: signingSteps(platform, outputDigests),
      outputs,
      identity,
    }));
    const nativeSignatureEvidencePath = join(root, `${platform}-native-signatures.json`);
    const nativePaths = [
      `platform/${platform}/bin/ae-mcp${platform === 'windows-x64' ? '.exe' : ''}`,
      `platform/${platform}/bin/ae-mcp-platform-helper${platform === 'windows-x64' ? '.exe' : ''}`,
    ].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    await writeFile(nativeSignatureEvidencePath, canonicalStringify({
      schemaVersion: 1,
      platform,
      candidateSha,
      result: 'PASS',
      signedBundleManifestSha256: await sha256File(signedBundleManifestPath),
      finalRootSha256: FINAL_ROOT_SHA256,
      discoveredNativeCount: nativePaths.length,
      files: nativePaths.map((itemPath) => ({
        path: itemPath,
        sha256: itemPath.includes('platform-helper') ? 'a'.repeat(64) : '9'.repeat(64),
        signatureKind: platform === 'macos-arm64' ? 'codesign' : 'authenticode',
        signerFingerprint: platform === 'macos-arm64' ? '6'.repeat(64) : 'f'.repeat(40),
        verified: true,
      })),
      artifacts: outputs.map(({ name, sha256 }) => ({ name, sha256 })),
    }));
    evidence.push({
      platform,
      bundleManifestPath,
      signedBundleManifestPath,
      runtimeInventoryPath,
      sbomPath,
      licensesPath,
      signingReportPath,
      nativeSignatureEvidencePath,
    });
  }

  const fixtureManifest = await buildArtifactManifest({
    version: '0.9.2',
    candidateSha,
    workflowRunId: '84',
    artifacts: fixtures.map(([name, platform, artifactId, role]) => ({
      name, platform, artifactId, role, path: join(root, name),
    })),
    evidence,
    productAcceptanceEvidencePath,
  });
  const fixtureReport = (platform, result, updatedAt) => {
    const artifact = fixtureManifest.artifacts.find((item) => (
      item.platform === platform && item.role === 'install'
    ));
    return {
      deleted: false,
      updatedAt,
      report: {
        schemaVersion: 1,
        platform,
        result,
        candidateSha,
        workflowRunId: '84',
        artifactId: artifact.artifactId,
        artifactName: artifact.name,
        artifactSha256: artifact.sha256,
        osVersion: PASS_OS[platform],
        codexVersion: 'rehearsal',
        ae: [
          { major: 25, version: '25.0', result },
          { major: 26, version: '26.0', result },
        ],
        commands: commandEvidence(platform, result),
        failures: result === 'PASS' ? [] : ['fixture failure'],
      },
    };
  };
  const passes = [
    fixtureReport('macos-arm64', 'PASS', 1),
    fixtureReport('windows-x64', 'PASS', 1),
  ];
  assert.deepEqual(await verifyArtifactManifest(fixtureManifest, root), []);
  assert.deepEqual(verifyReleaseInputs({
    candidateSha, mainSha: candidateSha, manifest: fixtureManifest, attestations: passes,
  }), []);

  await writeFile(join(root, 'ae-mcp-panel-v0.9.2-windows-x64.zxp'), 'tampered byte\n');
  assert.match((await verifyArtifactManifest(fixtureManifest, root)).join(' '), /sha256 mismatch/);

  const laterFail = fixtureReport('windows-x64', 'FAIL', 2);
  assert.match(verifyReleaseInputs({
    candidateSha,
    mainSha: candidateSha,
    manifest: fixtureManifest,
    attestations: [...passes, laterFail],
  }).join(' '), /windows-x64 attestation is not PASS/);
});
