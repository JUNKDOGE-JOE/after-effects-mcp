import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalJson,
  sha256Bytes,
} from '../../package/lib/manifest.mjs';
import {
  assertNativeReleaseCoverageGate,
  NATIVE_RELEASE_EVIDENCE_PATHS,
  NATIVE_RELEASE_EVIDENCE_PRODUCERS,
  NATIVE_RELEASE_REQUIRED_IMPLEMENTATION,
} from '../native-coverage-gate.mjs';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const GATE_SCRIPT = path.join(REPOSITORY_ROOT, 'scripts', 'release', 'native-coverage-gate.mjs');

const requiredImplementationPaths = [...NATIVE_RELEASE_REQUIRED_IMPLEMENTATION];
const producerByGate = Object.freeze({ ...NATIVE_RELEASE_EVIDENCE_PRODUCERS });

const requiredGates = Object.keys(producerByGate).sort(portableCompare);
const evidencePathByGate = Object.freeze({ ...NATIVE_RELEASE_EVIDENCE_PATHS });

function portableCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function implementationBytes() {
  return new Map(requiredImplementationPaths.map((relative) => [
    relative,
    Buffer.from(`reviewed fixture bytes for ${relative}\n`, 'utf8'),
  ]));
}

function reviewedFromBytes(files) {
  return requiredImplementationPaths.map((relative) => ({
    path: relative,
    sha256: sha256Bytes(files.get(relative)),
  }));
}

function subjectSha256(reviewedImplementation) {
  return sha256Bytes(Buffer.from(canonicalJson(reviewedImplementation), 'utf8'));
}

function buildApprovals(reviewedImplementation, mutateEvidence) {
  const subject = subjectSha256(reviewedImplementation);
  const reviewedHashes = new Map(reviewedImplementation.map((entry) => [entry.path, entry.sha256]));
  const evidenceFiles = new Map();
  const approvals = requiredGates.map((gate, index) => {
    const approvalId = `NATIVE-RELEASE-${index + 1}`;
    const producerPath = producerByGate[gate];
    const document = {
      approvalId,
      gate,
      producerPath,
      producerSha256: reviewedHashes.get(producerPath),
      schemaVersion: 1,
      subjectSha256: subject,
      verdict: 'APPROVED',
    };
    mutateEvidence?.({ document, gate, index });
    const evidencePath = evidencePathByGate[gate];
    const bytes = Buffer.from(canonicalJson(document), 'utf8');
    evidenceFiles.set(evidencePath, bytes);
    return {
      gate,
      approvalId,
      evidencePath,
      evidenceSha256: sha256Bytes(bytes),
      subjectSha256: subject,
    };
  });
  return { approvals, evidenceFiles };
}

function approvedFixture() {
  const implementationFiles = implementationBytes();
  const reviewedImplementation = reviewedFromBytes(implementationFiles);
  const { approvals, evidenceFiles } = buildApprovals(reviewedImplementation);
  return {
    implementationFiles,
    evidenceFiles,
    policy: {
      approvals,
      reviewedImplementation,
      schemaVersion: 2,
      status: 'approved',
    },
  };
}

function expectedFailure(code, action) {
  assert.throws(action, (error) => error?.code === code);
}

async function writeRegular(root, relative, bytes) {
  const destination = path.join(root, ...relative.split('/'));
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.writeFile(destination, bytes);
  return destination;
}

async function makeRoot(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-native-gate-'));
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));
  return root;
}

async function runGate(root, policyPath = path.join(root, 'packaging', 'native-coverage-approvals.json')) {
  try {
    const result = await execFileAsync(process.execPath, [
      GATE_SCRIPT,
      '--root', root,
      '--policy', policyPath,
    ]);
    return { ...result, exitCode: 0 };
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      exitCode: error.code,
    };
  }
}

test('repository policy is canonical schema v2 and remains explicitly fail closed', async () => {
  const policyText = await fs.promises.readFile(
    path.join(REPOSITORY_ROOT, 'packaging', 'native-coverage-approvals.json'),
    'utf8',
  );
  const policy = JSON.parse(policyText);
  assert.equal(policyText, canonicalJson(policy));
  assert.deepEqual(policy, {
    approvals: [],
    reviewedImplementation: [],
    schemaVersion: 2,
    status: 'blocked',
  });
  expectedFailure('NATIVE_COVERAGE_APPROVAL_REQUIRED', () => (
    assertNativeReleaseCoverageGate({ policy })
  ));
});

test('approved schema v2 requires real reviewed bytes and evidence bytes', () => {
  const fixture = approvedFixture();
  assert.doesNotThrow(() => assertNativeReleaseCoverageGate(fixture));
});

test('byte-map iteration order cannot change the canonical reviewed subject', () => {
  const fixture = approvedFixture();
  fixture.implementationFiles = new Map([...fixture.implementationFiles].reverse());
  fixture.evidenceFiles = new Map([...fixture.evidenceFiles].reverse());
  assert.doesNotThrow(() => assertNativeReleaseCoverageGate(fixture));
});

test('old schema v1 can never approve native coverage', () => {
  const fixture = approvedFixture();
  fixture.policy.schemaVersion = 1;
  delete fixture.policy.reviewedImplementation;
  fixture.policy.approvals = fixture.policy.approvals.map((approval) => ({
    gate: approval.gate,
    approvalId: approval.approvalId,
    evidenceSha256: approval.evidenceSha256,
  }));
  expectedFailure('NATIVE_COVERAGE_POLICY_INVALID', () => assertNativeReleaseCoverageGate(fixture));
});

test('arbitrary 64-hex implementation declarations do not replace actual byte hashing', () => {
  const fixture = approvedFixture();
  fixture.policy.reviewedImplementation[0].sha256 = 'a'.repeat(64);
  const rebuilt = buildApprovals(fixture.policy.reviewedImplementation);
  fixture.policy.approvals = rebuilt.approvals;
  fixture.evidenceFiles = rebuilt.evidenceFiles;
  expectedFailure(
    'NATIVE_COVERAGE_IMPLEMENTATION_INCOMPLETE',
    () => assertNativeReleaseCoverageGate(fixture),
  );
});

test('an inventory of filenames without actual bytes never approves', () => {
  const fixture = approvedFixture();
  fixture.implementationFiles = new Map(requiredImplementationPaths.map((relative) => [relative, true]));
  expectedFailure(
    'NATIVE_COVERAGE_IMPLEMENTATION_INCOMPLETE',
    () => assertNativeReleaseCoverageGate(fixture),
  );
});

for (const [name, mutate] of [
  ['missing', (items) => items.slice(1)],
  ['extra', (items) => [...items, { path: 'scripts/release/unreviewed.mjs', sha256: 'b'.repeat(64) }]],
  ['out-of-order', (items) => [items[1], items[0], ...items.slice(2)]],
  ['duplicate', (items) => [...items.slice(0, -1), items[0]]],
  ['case-alias', (items) => [{ ...items[0], path: '.GITHUB/workflows/build-rc.yml' }, ...items.slice(1)]],
]) {
  test(`${name} reviewed implementation entries are rejected`, () => {
    const fixture = approvedFixture();
    fixture.policy.reviewedImplementation = mutate(fixture.policy.reviewedImplementation);
    expectedFailure('NATIVE_COVERAGE_POLICY_INVALID', () => assertNativeReleaseCoverageGate(fixture));
  });
}

test('path traversal cannot enter the reviewed implementation', () => {
  const fixture = approvedFixture();
  fixture.policy.reviewedImplementation[0] = {
    ...fixture.policy.reviewedImplementation[0],
    path: '../outside/build-rc.yml',
  };
  expectedFailure('NATIVE_COVERAGE_POLICY_INVALID', () => assertNativeReleaseCoverageGate(fixture));
});

test('each gate has one fixed root-relative evidence path', () => {
  const fixture = approvedFixture();
  fixture.policy.approvals[0].evidencePath = '../forged-evidence.json';
  expectedFailure('NATIVE_COVERAGE_POLICY_INVALID', () => assertNativeReleaseCoverageGate(fixture));
});

test('evidence content hash is recomputed from actual bytes', () => {
  const fixture = approvedFixture();
  const evidencePath = fixture.policy.approvals[0].evidencePath;
  fixture.evidenceFiles.set(evidencePath, Buffer.from('{"forged":true}\n', 'utf8'));
  expectedFailure('NATIVE_COVERAGE_EVIDENCE_INVALID', () => assertNativeReleaseCoverageGate(fixture));
});

test('canonical evidence from a fake producer is rejected even when its hash matches', () => {
  const fixture = approvedFixture();
  const { approvals, evidenceFiles } = buildApprovals(
    fixture.policy.reviewedImplementation,
    ({ document, index }) => {
      if (index === 0) document.producerPath = 'scripts/release/artifact-manifest.mjs';
    },
  );
  fixture.policy.approvals = approvals;
  fixture.evidenceFiles = evidenceFiles;
  expectedFailure('NATIVE_COVERAGE_EVIDENCE_INVALID', () => assertNativeReleaseCoverageGate(fixture));
});

test('evidence producer hash must match its reviewed implementation bytes', () => {
  const fixture = approvedFixture();
  const { approvals, evidenceFiles } = buildApprovals(
    fixture.policy.reviewedImplementation,
    ({ document, index }) => {
      if (index === 0) document.producerSha256 = 'c'.repeat(64);
    },
  );
  fixture.policy.approvals = approvals;
  fixture.evidenceFiles = evidenceFiles;
  expectedFailure('NATIVE_COVERAGE_EVIDENCE_INVALID', () => assertNativeReleaseCoverageGate(fixture));
});

test('empty evidence is rejected even when the declared digest is exact', () => {
  const fixture = approvedFixture();
  const evidencePath = fixture.policy.approvals[0].evidencePath;
  const empty = Buffer.alloc(0);
  fixture.evidenceFiles.set(evidencePath, empty);
  fixture.policy.approvals[0].evidenceSha256 = sha256Bytes(empty);
  expectedFailure('NATIVE_COVERAGE_EVIDENCE_INVALID', () => assertNativeReleaseCoverageGate(fixture));
});

test('every approval subject binds the canonical reviewed implementation digest', () => {
  const fixture = approvedFixture();
  fixture.policy.approvals[0].subjectSha256 = 'd'.repeat(64);
  expectedFailure('NATIVE_COVERAGE_POLICY_INVALID', () => assertNativeReleaseCoverageGate(fixture));
});

test('blocked CLI policy does not require the not-yet-approved implementation to exist', async (t) => {
  const root = await makeRoot(t);
  const policy = {
    approvals: [],
    reviewedImplementation: [],
    schemaVersion: 2,
    status: 'blocked',
  };
  await writeRegular(root, 'packaging/native-coverage-approvals.json', canonicalJson(policy));
  const result = await runGate(root);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /^NATIVE_COVERAGE_APPROVAL_REQUIRED:/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

test('changing only blocked status to approved fails closed on missing implementation', async (t) => {
  const root = await makeRoot(t);
  const policy = {
    approvals: [],
    reviewedImplementation: [],
    schemaVersion: 2,
    status: 'approved',
  };
  await writeRegular(root, 'packaging/native-coverage-approvals.json', canonicalJson(policy));
  const result = await runGate(root);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /^NATIVE_COVERAGE_IMPLEMENTATION_INCOMPLETE:/);
});

test('CLI rejects symlinked reviewed implementation instead of following it', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires a privileged Windows test runner');
    return;
  }
  const root = await makeRoot(t);
  const fixture = approvedFixture();
  const symlinkedPath = requiredImplementationPaths[0];
  for (const [relative, bytes] of fixture.implementationFiles) {
    if (relative !== symlinkedPath) await writeRegular(root, relative, bytes);
  }
  for (const [relative, bytes] of fixture.evidenceFiles) {
    await writeRegular(root, relative, bytes);
  }
  const target = await writeRegular(root, 'real-build-rc.yml', fixture.implementationFiles.get(symlinkedPath));
  const link = path.join(root, ...symlinkedPath.split('/'));
  await fs.promises.mkdir(path.dirname(link), { recursive: true });
  await fs.promises.symlink(path.relative(path.dirname(link), target), link);
  await writeRegular(root, 'packaging/native-coverage-approvals.json', canonicalJson(fixture.policy));

  const result = await runGate(root);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /^NATIVE_COVERAGE_IMPLEMENTATION_INCOMPLETE:/);
});

test('CLI rejects symlinked evidence instead of following it', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires a privileged Windows test runner');
    return;
  }
  const root = await makeRoot(t);
  const fixture = approvedFixture();
  for (const [relative, bytes] of fixture.implementationFiles) {
    await writeRegular(root, relative, bytes);
  }
  const symlinkedPath = fixture.policy.approvals[0].evidencePath;
  for (const [relative, bytes] of fixture.evidenceFiles) {
    if (relative !== symlinkedPath) await writeRegular(root, relative, bytes);
  }
  const target = await writeRegular(root, 'packaging/evidence/native-coverage/real-evidence.json', fixture.evidenceFiles.get(symlinkedPath));
  const link = path.join(root, ...symlinkedPath.split('/'));
  await fs.promises.mkdir(path.dirname(link), { recursive: true });
  await fs.promises.symlink(path.basename(target), link);
  await writeRegular(root, 'packaging/native-coverage-approvals.json', canonicalJson(fixture.policy));

  const result = await runGate(root);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /^NATIVE_COVERAGE_EVIDENCE_INVALID:/);
});

test('CLI rejects hard-linked evidence even when its bytes and hash match', async (t) => {
  const root = await makeRoot(t);
  const fixture = approvedFixture();
  for (const [relative, bytes] of fixture.implementationFiles) {
    await writeRegular(root, relative, bytes);
  }
  const linkedPath = fixture.policy.approvals[0].evidencePath;
  for (const [relative, bytes] of fixture.evidenceFiles) {
    if (relative !== linkedPath) await writeRegular(root, relative, bytes);
  }
  const target = await writeRegular(root, 'packaging/evidence/native-coverage/hardlink-target.json', fixture.evidenceFiles.get(linkedPath));
  const link = path.join(root, ...linkedPath.split('/'));
  await fs.promises.link(target, link);
  await writeRegular(root, 'packaging/native-coverage-approvals.json', canonicalJson(fixture.policy));

  const result = await runGate(root);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /^NATIVE_COVERAGE_EVIDENCE_INVALID:/);
});

test('CLI refuses a policy selector outside the supplied root', async (t) => {
  const root = await makeRoot(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside-policy.json`);
  t.after(() => fs.promises.rm(outside, { force: true }));
  await fs.promises.writeFile(outside, canonicalJson({
    approvals: [],
    reviewedImplementation: [],
    schemaVersion: 2,
    status: 'blocked',
  }));
  const result = await runGate(root, outside);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /^NATIVE_COVERAGE_ARGUMENT_INVALID:/);
});

test('RC workflow runs the direct candidate packaging contracts', async () => {
  const workflow = await fs.promises.readFile(
    path.join(REPOSITORY_ROOT, '.github', 'workflows', 'build-rc.yml'),
    'utf8',
  );
  assert.match(workflow, /actions\/setup-node/);
  assert.match(workflow, /verify-windows-zxp-stage\.test\.mjs/);
  assert.match(workflow, /zxp-payload-audit\.test\.mjs/);
  assert.doesNotMatch(workflow, /python|uv|sidecar|runtime|helper/iu);
});
