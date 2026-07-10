import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildArtifactManifest,
  serializeArtifactManifest,
} from '../artifact-manifest.mjs';
import { validateAttestation } from '../attestation.mjs';
import { makeArtifactManifestFixture } from './helpers/artifact-manifest-fixture.mjs';

const MACOS_PASS_COMMANDS = [
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
];

const WINDOWS_PASS_COMMANDS = [
  'Get-FileHash -Algorithm SHA256 and bind manifest',
  'Get-AuthenticodeSignature for every packaged executable',
  'install exact signed ZXP',
  'AE 25 installed-runtime smoke',
  'AE 26 installed-runtime smoke',
];

function successfulCommands(labels) {
  return labels.map((command) => ({ command, exitCode: 0 }));
}

const valid = {
  schemaVersion: 1,
  platform: 'windows-x64',
  result: 'PASS',
  candidateSha: 'b'.repeat(40),
  workflowRunId: '42',
  artifactId: '101',
  artifactName: 'ae-mcp-panel-v0.9.1-windows-x64.zxp',
  artifactSha256: 'c'.repeat(64),
  osVersion: 'Windows 10.0.26100',
  codexVersion: '0.144.0-alpha.4',
  ae: [
    { major: 25, version: '25.6.0', result: 'PASS' },
    { major: 26, version: '26.3.0', result: 'PASS' },
  ],
  commands: successfulCommands(WINDOWS_PASS_COMMANDS),
  failures: [],
};

test('PASS requires both AE majors and exact artifact identity', () => {
  const expected = {
    platform: 'windows-x64',
    candidateSha: valid.candidateSha,
    workflowRunId: '42',
    artifactId: '101',
    artifactName: valid.artifactName,
    artifactSha256: valid.artifactSha256,
  };
  assert.deepEqual(validateAttestation(valid, expected), []);
  assert.match(validateAttestation({ ...valid, ae: valid.ae.slice(0, 1) }, {})[0], /AE 25 and 26/);
  assert.match(
    validateAttestation(
      { ...valid, artifactSha256: 'd'.repeat(64) },
      { artifactSha256: valid.artifactSha256 },
    )[0],
    /digest/,
  );
  assert.match(
    validateAttestation(valid, { workflowRunId: '43' }).join('\n'),
    /workflow run id mismatch/,
  );
  assert.match(
    validateAttestation(valid, { artifactName: 'different.zxp' }).join('\n'),
    /artifact name mismatch/,
  );
});

test('FAIL report remains structurally valid and carries evidence', () => {
  const report = {
    ...valid,
    result: 'FAIL',
    osVersion: 'unsupported lab image',
    ae: [{ major: 25, version: '99.0', result: 'FAIL' }],
    commands: [{ command: 'partial diagnostic', exitCode: 1 }],
    failures: ['panel did not load'],
  };
  assert.deepEqual(validateAttestation(report, {}), []);
});

test('PASS enforces the supported OS matrix and AE version-major binding', () => {
  assert.match(
    validateAttestation({ ...valid, osVersion: 'Windows 10.0.26099' }).join('\n'),
    /supported Windows version/,
  );
  assert.match(
    validateAttestation({ ...valid, osVersion: 'macOS 15.0' }).join('\n'),
    /supported Windows version/,
  );
  assert.match(
    validateAttestation({
      ...valid,
      ae: [
        { major: 25, version: '26.0.0', result: 'PASS' },
        valid.ae[1],
      ],
    }).join('\n'),
    /AE 25 version/,
  );

  const macos = {
    ...valid,
    platform: 'macos-arm64',
    artifactName: 'ae-mcp-panel-v0.9.1-macos-arm64.dmg',
    osVersion: 'macOS 14.0',
    commands: successfulCommands(MACOS_PASS_COMMANDS),
  };
  assert.deepEqual(validateAttestation(macos), []);
  assert.match(
    validateAttestation({ ...macos, osVersion: 'macOS 13.6' }).join('\n'),
    /supported macOS version/,
  );
  assert.match(
    validateAttestation({ ...macos, osVersion: 'Windows 10.0.26100' }).join('\n'),
    /supported macOS version/,
  );
});

test('PASS requires the exact unique verifier command-label set', () => {
  assert.match(
    validateAttestation({ ...valid, commands: valid.commands.slice(1) }).join('\n'),
    /exact platform verifier command set/,
  );
  assert.match(
    validateAttestation({ ...valid, commands: [...valid.commands, valid.commands[0]] }).join('\n'),
    /unique verifier command labels/,
  );
  assert.match(
    validateAttestation({
      ...valid,
      commands: [...valid.commands, { command: 'unapproved verifier', exitCode: 0 }],
    }).join('\n'),
    /exact platform verifier command set/,
  );
});

test('attestation validation rejects ambiguity and unexpected fields', () => {
  const duplicateAe = {
    ...valid,
    ae: [...valid.ae, { major: 25, version: '25.6.0', result: 'PASS' }],
  };
  assert.match(validateAttestation(duplicateAe).join('\n'), /AE majors must be unique/);
  assert.match(
    validateAttestation({ ...valid, unexpected: true }).join('\n'),
    /unexpected attestation fields/,
  );
  assert.match(
    validateAttestation({ ...valid, commands: [{ command: '   ', exitCode: 0 }] }).join('\n'),
    /invalid commands/,
  );
});

test('write-attestation binds exact artifact bytes and requires a complete manifest', async (t) => {
  const fixture = await makeArtifactManifestFixture(t);
  const root = fixture.root;
  const artifact = fixture.artifacts.find((item) => item.platform === 'windows-x64');
  const artifactName = artifact.name;
  const artifactPath = artifact.path;
  const manifestPath = join(root, 'artifact-manifest.json');
  const outPath = join(root, 'windows-attestation.json');
  const commentOutPath = join(root, 'windows-comment.utf8');
  const candidateSha = fixture.candidateSha;
  const manifest = await buildArtifactManifest({
    version: '0.9.1',
    candidateSha,
    workflowRunId: '42',
    artifacts: fixture.artifacts,
    evidence: fixture.evidence,
    productAcceptanceEvidencePath: fixture.productAcceptanceEvidencePath,
  });
  await writeFile(manifestPath, serializeArtifactManifest(manifest));
  const artifactSha256 = artifact.sha256 ?? manifest.artifacts.find(
    (item) => item.name === artifactName,
  ).sha256;

  const baseArgs = [
      'scripts/release/write-attestation.mjs',
      '--platform', 'windows-x64',
      '--candidate-sha', candidateSha,
      '--run-id', '42',
      '--artifact-id', artifact.artifactId,
      '--artifact', artifactPath,
      '--manifest', manifestPath,
      '--os-version', 'Windows 10.0.26100',
      '--codex-version', '0.144.0-alpha.4',
      '--ae25-version', '25.6.0',
      '--ae25-result', 'PASS',
      '--commands-json', JSON.stringify(successfulCommands(WINDOWS_PASS_COMMANDS)),
      '--failures-json', '[]',
      '--out', outPath,
      '--comment-out', commentOutPath,
  ];

  const missingAe26 = spawnSync(process.execPath, baseArgs, { encoding: 'utf8' });
  assert.notEqual(missingAe26.status, 0);

  const pass = spawnSync(process.execPath, [
      ...baseArgs,
      '--ae26-version', '26.3.0',
      '--ae26-result', 'PASS',
  ]);
  assert.equal(pass.status, 0, pass.stderr);
  const report = JSON.parse(await readFile(outPath, 'utf8'));
  assert.equal(report.result, 'PASS');
  assert.equal(report.candidateSha, candidateSha);
  assert.equal(report.artifactSha256, artifactSha256);
  const commentBytes = await readFile(commentOutPath);
  assert.deepEqual(pass.stdout, commentBytes);
  if (process.platform !== 'win32') {
    assert.equal((await stat(commentOutPath)).mode & 0o777, 0o600);
  }

  const secondPass = spawnSync(process.execPath, [
      ...baseArgs,
      '--ae26-version', '26.3.0',
      '--ae26-result', 'PASS',
  ], { encoding: 'utf8' });
  assert.notEqual(secondPass.status, 0);
  assert.match(secondPass.stderr, /EEXIST|already exists/i);
  assert.deepEqual(JSON.parse(await readFile(outPath, 'utf8')), report);

  const blockedOut = join(root, 'blocked-attestation.json');
  const blockedComment = join(root, 'blocked-comment.utf8');
  await writeFile(blockedComment, 'preexisting');
  const blocked = spawnSync(process.execPath, [
      ...baseArgs.filter((value, index, all) => (
        !['--out', '--comment-out'].includes(all[index - 1])
        && !['--out', '--comment-out'].includes(value)
      )),
      '--out', blockedOut,
      '--comment-out', blockedComment,
      '--ae26-version', '26.3.0',
      '--ae26-result', 'PASS',
  ]);
  assert.notEqual(blocked.status, 0);
  await assert.rejects(readFile(blockedOut), { code: 'ENOENT' });
  assert.equal(await readFile(blockedComment, 'utf8'), 'preexisting');

  const failWithoutEvidence = spawnSync(process.execPath, [
      ...baseArgs,
      '--ae26-version', '26.3.0',
      '--ae26-result', 'FAIL',
  ], { encoding: 'utf8' });
  assert.notEqual(failWithoutEvidence.status, 0);
  assert.match(failWithoutEvidence.stderr, /FAIL requires failure evidence/);

  const malformedManifest = structuredClone(manifest);
  delete malformedManifest.evidence[0].nativeSignatureEvidence;
  const malformedPath = join(root, 'malformed-manifest.json');
  await writeFile(malformedPath, Buffer.from(JSON.stringify(malformedManifest)));
  const malformed = spawnSync(process.execPath, [
    ...baseArgs.map((value) => value === manifestPath ? malformedPath : value),
    '--ae26-version', '26.3.0',
    '--ae26-result', 'PASS',
  ], { encoding: 'utf8' });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /manifest|evidence/i);
});
