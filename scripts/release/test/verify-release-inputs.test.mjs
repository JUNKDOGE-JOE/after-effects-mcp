import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcileAttestationState,
  verifyReleaseInputs,
} from '../verify-release-inputs.mjs';

const CANDIDATE_SHA = 'd'.repeat(40);
const WINDOWS_COMMANDS = [
  'Get-FileHash -Algorithm SHA256 and bind manifest',
  'Get-AuthenticodeSignature for packaged AEX',
  'verify direct ZXP payload',
];
const MAC_COMMANDS = [
  'shasum -a 256 artifact and bind manifest',
  'codesign --verify --deep --strict',
  'spctl --assess',
  'xcrun stapler validate',
  'mount exact notarized DMG',
  'verify exact ZXP payload from DMG',
  'verify direct ZXP payload',
  'verify AEGP signature',
];

function artifact(platform, id) {
  return {
    artifactId: String(id),
    name: `ae-mcp-panel-v0.9.6-${platform}.zxp`,
    platform,
    role: 'zxp',
    sha256: String(id).repeat(64).slice(0, 64),
  };
}

function report(platform, item, result = 'PASS') {
  return {
    schemaVersion: 1,
    platform,
    result,
    candidateSha: CANDIDATE_SHA,
    workflowRunId: '42',
    artifactId: item.artifactId,
    artifactName: item.name,
    artifactSha256: item.sha256,
    osVersion: platform === 'macos-arm64' ? 'macOS 14.0' : 'Windows 10.0.26100',
    codexVersion: '0.144.0',
    ae: result === 'PASS'
      ? [
        { major: 25, version: '25.6.0', result: 'PASS' },
        { major: 26, version: '26.3.0', result: 'PASS' },
      ]
      : [{ major: 25, version: '25.6.0', result: 'FAIL' }],
    commands: (platform === 'macos-arm64' ? MAC_COMMANDS : WINDOWS_COMMANDS)
      .map((command) => ({ command, exitCode: 0 })),
    failures: result === 'PASS' ? [] : ['direct payload check failed'],
  };
}

function fixture() {
  const mac = artifact('macos-arm64', 101);
  const windows = artifact('windows-x64', 102);
  const manifest = {
    schemaVersion: 1,
    version: '0.9.6',
    candidateSha: CANDIDATE_SHA,
    workflowRunId: '42',
    artifacts: [mac, windows],
  };
  return {
    manifest,
    attestations: [
      { updatedAt: 1, report: report('macos-arm64', mac) },
      { updatedAt: 2, report: report('windows-x64', windows) },
    ],
  };
}

test('release input verification accepts one current PASS for each direct ZXP', () => {
  const input = fixture();
  assert.deepEqual(verifyReleaseInputs({
    candidateSha: CANDIDATE_SHA,
    mainSha: CANDIDATE_SHA,
    ...input,
  }), []);
});

test('a prior FAIL attestation rejects the candidate even after a later PASS', () => {
  const input = fixture();
  const mac = input.manifest.artifacts[0];
  input.attestations.unshift({
    updatedAt: 0,
    report: report('macos-arm64', mac, 'FAIL'),
  });
  assert.match(
    verifyReleaseInputs({ candidateSha: CANDIDATE_SHA, mainSha: CANDIDATE_SHA, ...input }).join('\n'),
    /macos-arm64 candidate was rejected by FAIL/,
  );
});

test('attestation state only advances on newer valid direct evidence', () => {
  const input = fixture();
  const item = input.manifest.artifacts[1];
  const base = {
    action: 'created',
    candidateSha: CANDIDATE_SHA,
    platform: 'windows-x64',
    artifactId: item.artifactId,
    artifactSha256: item.sha256,
    commentId: '7',
    updatedAt: 10,
    report: report('windows-x64', item),
  };
  const state = reconcileAttestationState(null, base);
  assert.equal(state.conclusion, 'success');
  assert.equal(state.activeCommentId, '7');
  const older = reconcileAttestationState(state, { ...base, updatedAt: 9, commentId: '8' });
  assert.equal(older.activeCommentId, '7');
  const deleted = reconcileAttestationState(state, { ...base, action: 'deleted' });
  assert.equal(deleted.activeCommentId, null);
});
