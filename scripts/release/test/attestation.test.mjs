import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAttestation } from '../attestation.mjs';

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

function report(platform = 'windows-x64', result = 'PASS') {
  const name = `ae-mcp-panel-v0.10.0-${platform}.${platform === 'macos-arm64' ? 'dmg' : 'zxp'}`;
  return {
    schemaVersion: 1,
    platform,
    result,
    candidateSha: 'b'.repeat(40),
    workflowRunId: '42',
    artifactId: '101',
    artifactName: name,
    artifactSha256: 'c'.repeat(64),
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
    failures: result === 'PASS' ? [] : ['direct bundle verification failed'],
  };
}

test('PASS requires both AE majors and exact direct artifact identity', () => {
  const value = report();
  assert.deepEqual(validateAttestation(value, {
    platform: value.platform,
    candidateSha: value.candidateSha,
    workflowRunId: value.workflowRunId,
    artifactId: value.artifactId,
    artifactName: value.artifactName,
    artifactSha256: value.artifactSha256,
  }), []);
  assert.match(validateAttestation({ ...value, ae: value.ae.slice(0, 1) }).join('\n'), /AE 25 and 26/);
});

test('FAIL reports remain structurally valid with evidence', () => {
  assert.deepEqual(validateAttestation(report('windows-x64', 'FAIL')), []);
});

test('PASS enforces the supported OS matrix and exact verifier labels', () => {
  const value = report();
  assert.match(
    validateAttestation({ ...value, osVersion: 'Windows 10.0.26099' }).join('\n'),
    /supported Windows version/,
  );
  assert.match(
    validateAttestation({ ...value, commands: value.commands.slice(1) }).join('\n'),
    /exact platform verifier command set/,
  );
  assert.deepEqual(validateAttestation(report('macos-arm64')), []);
});
