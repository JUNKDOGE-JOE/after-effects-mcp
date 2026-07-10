import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalStringify } from '../artifact-manifest.mjs';
import { encodeAttestationComment } from '../comment-marker.mjs';

const WINDOWS_PASS_COMMANDS = [
  'Get-FileHash -Algorithm SHA256 and bind manifest',
  'Get-AuthenticodeSignature for every packaged executable',
  'install exact signed ZXP',
  'AE 25 installed-runtime smoke',
  'AE 26 installed-runtime smoke',
];

function report(result = 'PASS') {
  return {
    schemaVersion: 1,
    platform: 'windows-x64',
    result,
    candidateSha: 'b'.repeat(40),
    workflowRunId: '42',
    artifactId: '101',
    artifactName: 'ae-mcp-panel-v0.9.1-windows-x64.zxp',
    artifactSha256: 'c'.repeat(64),
    osVersion: 'Windows 10.0.26100',
    codexVersion: '0.144.0-alpha.4',
    ae: result === 'PASS'
      ? [
        { major: 25, version: '25.6.0', result: 'PASS' },
        { major: 26, version: '26.3.0', result: 'PASS' },
      ]
      : [{ major: 25, version: '25.6.0', result: 'FAIL' }],
    commands: result === 'PASS'
      ? WINDOWS_PASS_COMMANDS.map((command) => ({ command, exitCode: 0 }))
      : [{ command: 'partial diagnostic', exitCode: 1 }],
    failures: result === 'PASS' ? [] : ['panel did not load'],
  };
}

async function fixture(t, value = report()) {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-comment-validator-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const comment = join(root, 'comment.utf8');
  const reportPath = join(root, 'report.json');
  await writeFile(comment, encodeAttestationComment(value));
  await writeFile(reportPath, canonicalStringify(value));
  return { comment, reportPath, root, value };
}

function runValidator({ comment, reportPath, value, verifierExit = '0', overrides = [] }) {
  return spawnSync(process.execPath, [
    'scripts/release/validate-attestation-comment.mjs',
    '--comment', comment,
    '--report', reportPath,
    '--platform', value.platform,
    '--candidate-sha', value.candidateSha,
    '--run-id', value.workflowRunId,
    '--artifact-id', value.artifactId,
    '--artifact-name', value.artifactName,
    '--artifact-sha256', value.artifactSha256,
    '--verifier-exit', verifierExit,
    ...overrides,
  ]);
}

test('validator accepts one exact PASS body without reconstructing or writing output', async (t) => {
  const value = report();
  const input = await fixture(t, value);
  const beforeComment = await readFile(input.comment);
  const beforeReport = await readFile(input.reportPath);
  const result = runValidator({ ...input, value });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, 0);
  assert.deepEqual(await readFile(input.comment), beforeComment);
  assert.deepEqual(await readFile(input.reportPath), beforeReport);
});

test('validator accepts a complete FAIL for nonzero verifier exit but rejects PASS', async (t) => {
  const pass = await fixture(t, report('PASS'));
  const failedPass = runValidator({ ...pass, value: pass.value, verifierExit: '1' });
  assert.notEqual(failedPass.status, 0);
  assert.match(failedPass.stderr.toString(), /nonzero verifier exit.*FAIL/i);

  const fail = await fixture(t, report('FAIL'));
  const acceptedFail = runValidator({ ...fail, value: fail.value, verifierExit: '1' });
  assert.equal(acceptedFail.status, 0, acceptedFail.stderr.toString());
  assert.equal(acceptedFail.stdout.length, 0);
});

test('validator rejects malformed UTF-8, ambiguity, noncanonical reports, and identity mismatch', async (t) => {
  const input = await fixture(t, report());

  await writeFile(input.comment, Buffer.from([0xff, 0xfe]));
  assert.notEqual(runValidator({ ...input, value: input.value }).status, 0);

  await writeFile(input.comment, `${encodeAttestationComment(input.value)}${encodeAttestationComment(input.value)}`);
  assert.notEqual(runValidator({ ...input, value: input.value }).status, 0);

  await writeFile(input.comment, encodeAttestationComment(input.value));
  await writeFile(input.reportPath, `${JSON.stringify(input.value, null, 2)}\n`);
  assert.notEqual(runValidator({ ...input, value: input.value }).status, 0);

  await writeFile(input.reportPath, canonicalStringify(input.value));
  const mismatch = runValidator({
    ...input,
    value: input.value,
    overrides: ['--artifact-sha256', 'd'.repeat(64)],
  });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr.toString(), /artifact digest mismatch/i);
});
