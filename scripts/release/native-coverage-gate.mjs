#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertPortableRelativePath,
  canonicalJson,
  sha256Bytes,
} from '../package/lib/manifest.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const APPROVAL_ID = /^NATIVE-RELEASE-[A-Z0-9-]+$/;
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_IMPLEMENTATION_BYTES = 16 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;

export const NATIVE_RELEASE_REQUIRED_IMPLEMENTATION = Object.freeze([
  '.github/workflows/build-rc.yml',
  '.github/workflows/platform-foundation-ci.yml',
  'packaging/product-acceptance-coverage.json',
  'scripts/package/build-platform-helper.mjs',
  'scripts/package/test/verify-final-native-signatures.test.mjs',
  'scripts/package/verify-final-native-signatures.mjs',
  'scripts/release/artifact-manifest.mjs',
  'scripts/release/native-coverage-gate.mjs',
  'scripts/release/test/verify-product-acceptance-coverage.test.mjs',
  'scripts/release/verify-product-acceptance-coverage.mjs',
]);

export const NATIVE_RELEASE_EVIDENCE_PRODUCERS = Object.freeze({
  'helper-build-reviewed': 'scripts/package/build-platform-helper.mjs',
  'macos-ae25-ae26-hardware-reviewed': 'scripts/release/verify-product-acceptance-coverage.mjs',
  'macos-final-native-signature-coverage-reviewed': 'scripts/package/verify-final-native-signatures.mjs',
  'persistence-upgrade-rollback-permission-acceptance-reviewed': 'scripts/release/verify-product-acceptance-coverage.mjs',
  'provider-header-routing-acceptance-reviewed': 'scripts/release/verify-product-acceptance-coverage.mjs',
  'tool-library-acceptance-reviewed': 'scripts/release/verify-product-acceptance-coverage.mjs',
  'windows-ae25-ae26-hardware-reviewed': 'scripts/release/verify-product-acceptance-coverage.mjs',
  'windows-final-native-signature-coverage-reviewed': 'scripts/package/verify-final-native-signatures.mjs',
});

const REQUIRED_GATES = Object.freeze(
  Object.keys(NATIVE_RELEASE_EVIDENCE_PRODUCERS).sort(comparePortableUtf8),
);

export const NATIVE_RELEASE_EVIDENCE_PATHS = Object.freeze(Object.fromEntries(
  REQUIRED_GATES.map((gate) => [
    gate,
    `packaging/evidence/native-coverage/${gate}.json`,
  ]),
));

// Compatibility for callers that only need the immutable path contract. Presence
// alone is deliberately no longer accepted as release coverage.
export const NATIVE_RELEASE_REQUIRED_FILES = NATIVE_RELEASE_REQUIRED_IMPLEMENTATION;

function comparePortableUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function gateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function asBytes(value, code, label) {
  if (!(value instanceof Uint8Array)) {
    throw gateError(code, `${label} must be supplied as actual bytes`);
  }
  return Buffer.from(value);
}

function portablePath(relative) {
  try {
    assertPortableRelativePath(relative, 'NATIVE_COVERAGE_PATH_INVALID');
  } catch {
    throw gateError('NATIVE_COVERAGE_POLICY_INVALID', 'native coverage path is invalid');
  }
  if (relative !== relative.normalize('NFC')) {
    throw gateError('NATIVE_COVERAGE_POLICY_INVALID', 'native coverage path is not NFC normalized');
  }
  return relative;
}

function exactPortableList(actual, expected) {
  if (actual.length !== expected.length) return false;
  return actual.every((item, index) => item === expected[index]);
}

function portableAliasKey(relative) {
  return relative.normalize('NFC').toLowerCase();
}

function reviewedSubjectSha256(reviewedImplementation) {
  return sha256Bytes(Buffer.from(canonicalJson(reviewedImplementation), 'utf8'));
}

function validatePolicyEnvelope(policy) {
  const topKeys = ['approvals', 'reviewedImplementation', 'schemaVersion', 'status'];
  if (!exactKeys(policy, topKeys)
      || policy.schemaVersion !== 2
      || !['approved', 'blocked'].includes(policy.status)
      || !Array.isArray(policy.approvals)
      || !Array.isArray(policy.reviewedImplementation)) {
    throw gateError('NATIVE_COVERAGE_POLICY_INVALID', 'native coverage policy is invalid');
  }

  if (policy.status === 'blocked') {
    if (policy.approvals.length !== 0 || policy.reviewedImplementation.length !== 0) {
      throw gateError(
        'NATIVE_COVERAGE_POLICY_INVALID',
        'blocked native coverage policy must not carry latent approvals',
      );
    }
    throw gateError(
      'NATIVE_COVERAGE_APPROVAL_REQUIRED',
      'native helper, final per-file signature coverage, and hardware evidence remain blocked',
    );
  }
}

function validateApprovedPolicy(policy) {
  validatePolicyEnvelope(policy);

  if (policy.reviewedImplementation.length === 0 && policy.approvals.length === 0) {
    throw gateError(
      'NATIVE_COVERAGE_IMPLEMENTATION_INCOMPLETE',
      'approved status alone does not supply the reviewed native implementation or evidence',
    );
  }

  const reviewedPaths = [];
  const aliases = new Set();
  for (const entry of policy.reviewedImplementation) {
    if (!exactKeys(entry, ['path', 'sha256'])
        || typeof entry.path !== 'string'
        || !SHA256.test(entry.sha256 || '')) {
      throw gateError('NATIVE_COVERAGE_POLICY_INVALID', 'reviewed implementation entry is invalid');
    }
    portablePath(entry.path);
    const alias = portableAliasKey(entry.path);
    if (aliases.has(alias)) {
      throw gateError('NATIVE_COVERAGE_POLICY_INVALID', 'reviewed implementation path alias is duplicated');
    }
    aliases.add(alias);
    reviewedPaths.push(entry.path);
  }
  if (!exactPortableList(reviewedPaths, NATIVE_RELEASE_REQUIRED_IMPLEMENTATION)
      || !exactPortableList(
        [...reviewedPaths].sort(comparePortableUtf8),
        NATIVE_RELEASE_REQUIRED_IMPLEMENTATION,
      )) {
    throw gateError(
      'NATIVE_COVERAGE_POLICY_INVALID',
      'reviewed implementation must exactly match the sorted native coverage contract',
    );
  }

  const subjectSha256 = reviewedSubjectSha256(policy.reviewedImplementation);
  const approvalIds = new Set();
  const approvalGates = [];
  for (const approval of policy.approvals) {
    if (!exactKeys(approval, [
      'approvalId',
      'evidencePath',
      'evidenceSha256',
      'gate',
      'subjectSha256',
    ])
        || typeof approval.gate !== 'string'
        || typeof approval.approvalId !== 'string'
        || !APPROVAL_ID.test(approval.approvalId)
        || typeof approval.evidencePath !== 'string'
        || !SHA256.test(approval.evidenceSha256 || '')
        || !SHA256.test(approval.subjectSha256 || '')) {
      throw gateError('NATIVE_COVERAGE_POLICY_INVALID', 'native coverage approval is invalid');
    }
    portablePath(approval.evidencePath);
    if (approval.evidencePath !== NATIVE_RELEASE_EVIDENCE_PATHS[approval.gate]
        || approval.subjectSha256 !== subjectSha256
        || approvalIds.has(approval.approvalId)) {
      throw gateError(
        'NATIVE_COVERAGE_POLICY_INVALID',
        'native coverage approval is outside the reviewed subject or evidence contract',
      );
    }
    approvalIds.add(approval.approvalId);
    approvalGates.push(approval.gate);
  }
  if (!exactPortableList(approvalGates, REQUIRED_GATES)) {
    throw gateError(
      'NATIVE_COVERAGE_POLICY_INVALID',
      'native coverage approvals must exactly match the sorted reviewed gate set',
    );
  }
  return subjectSha256;
}

function validateExactByteMap(files, expectedPaths, code, label) {
  if (!(files instanceof Map)) {
    throw gateError(code, `${label} byte map is missing`);
  }
  const paths = [...files.keys()];
  const actual = new Set(paths);
  if (paths.some((relative) => typeof relative !== 'string')
      || paths.length !== expectedPaths.length
      || actual.size !== expectedPaths.length
      || expectedPaths.some((relative) => !actual.has(relative))) {
    throw gateError(code, `${label} byte map does not exactly match the reviewed paths`);
  }
}

function parseEvidence(bytes, approval, subjectSha256, reviewedHashes) {
  let evidence;
  const text = bytes.toString('utf8');
  try {
    evidence = JSON.parse(text);
  } catch {
    throw gateError('NATIVE_COVERAGE_EVIDENCE_INVALID', 'native coverage evidence is not JSON');
  }
  if (text !== canonicalJson(evidence)
      || !exactKeys(evidence, [
        'approvalId',
        'gate',
        'producerPath',
        'producerSha256',
        'schemaVersion',
        'subjectSha256',
        'verdict',
      ])
      || evidence.schemaVersion !== 1
      || evidence.gate !== approval.gate
      || evidence.approvalId !== approval.approvalId
      || evidence.subjectSha256 !== subjectSha256
      || evidence.verdict !== 'APPROVED') {
    throw gateError('NATIVE_COVERAGE_EVIDENCE_INVALID', 'native coverage evidence contract is invalid');
  }

  const producerPath = NATIVE_RELEASE_EVIDENCE_PRODUCERS[approval.gate];
  if (evidence.producerPath !== producerPath
      || evidence.producerSha256 !== reviewedHashes.get(producerPath)) {
    throw gateError(
      'NATIVE_COVERAGE_EVIDENCE_INVALID',
      'native coverage evidence producer is not the reviewed implementation',
    );
  }
}

export function assertNativeReleaseCoverageGate({
  policy,
  implementationFiles,
  evidenceFiles,
} = {}) {
  const subjectSha256 = validateApprovedPolicy(policy);
  const reviewedHashes = new Map(policy.reviewedImplementation.map((entry) => [
    entry.path,
    entry.sha256,
  ]));

  validateExactByteMap(
    implementationFiles,
    NATIVE_RELEASE_REQUIRED_IMPLEMENTATION,
    'NATIVE_COVERAGE_IMPLEMENTATION_INCOMPLETE',
    'reviewed implementation',
  );
  for (const entry of policy.reviewedImplementation) {
    const bytes = asBytes(
      implementationFiles.get(entry.path),
      'NATIVE_COVERAGE_IMPLEMENTATION_INCOMPLETE',
      entry.path,
    );
    if (bytes.byteLength <= 0
        || bytes.byteLength > MAX_IMPLEMENTATION_BYTES
        || sha256Bytes(bytes) !== entry.sha256) {
      throw gateError(
        'NATIVE_COVERAGE_IMPLEMENTATION_INCOMPLETE',
        `reviewed implementation bytes do not match: ${entry.path}`,
      );
    }
  }

  const expectedEvidencePaths = policy.approvals.map((approval) => approval.evidencePath);
  validateExactByteMap(
    evidenceFiles,
    expectedEvidencePaths,
    'NATIVE_COVERAGE_EVIDENCE_INVALID',
    'native coverage evidence',
  );
  for (const approval of policy.approvals) {
    const bytes = asBytes(
      evidenceFiles.get(approval.evidencePath),
      'NATIVE_COVERAGE_EVIDENCE_INVALID',
      approval.evidencePath,
    );
    if (bytes.byteLength <= 0
        || bytes.byteLength > MAX_EVIDENCE_BYTES
        || sha256Bytes(bytes) !== approval.evidenceSha256) {
      throw gateError(
        'NATIVE_COVERAGE_EVIDENCE_INVALID',
        `native coverage evidence bytes do not match: ${approval.evidencePath}`,
      );
    }
    parseEvidence(bytes, approval, subjectSha256, reviewedHashes);
  }
  return true;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function sameStableMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function assertDirectoryChain(root, relative, code) {
  const snapshots = [];
  let current = root;
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.promises.lstat(current);
    } catch {
      throw gateError(code, `repository parent directory is missing: ${relative}`);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw gateError(code, `repository parent directory is unsafe: ${relative}`);
    }
    snapshots.push([current, stats]);
  }
  return snapshots;
}

async function assertDirectoryChainUnchanged(snapshots, code, relative) {
  for (const [directory, before] of snapshots) {
    let after;
    try {
      after = await fs.promises.lstat(directory);
    } catch {
      throw gateError(code, `repository parent directory changed: ${relative}`);
    }
    if (!after.isDirectory() || after.isSymbolicLink() || !sameStableMetadata(before, after)) {
      throw gateError(code, `repository parent directory changed: ${relative}`);
    }
  }
}

async function readStableRepositoryFile(root, realRoot, relative, { code, maxBytes }) {
  try {
    portablePath(relative);
  } catch {
    throw gateError(code, `repository file path is invalid: ${relative}`);
  }
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!isInside(root, absolute)) {
    throw gateError(code, `repository file escapes root: ${relative}`);
  }
  const directories = await assertDirectoryChain(root, relative, code);

  let pathStats;
  try {
    pathStats = await fs.promises.lstat(absolute);
  } catch {
    throw gateError(code, `repository file is missing: ${relative}`);
  }
  if (!pathStats.isFile()
      || pathStats.isSymbolicLink()
      || pathStats.nlink !== 1
      || pathStats.size <= 0
      || pathStats.size > maxBytes) {
    throw gateError(code, `repository file is not one bounded regular file: ${relative}`);
  }

  let realFile;
  try {
    realFile = await fs.promises.realpath(absolute);
  } catch {
    throw gateError(code, `repository file cannot be resolved: ${relative}`);
  }
  if (!isInside(realRoot, realFile)) {
    throw gateError(code, `repository file resolves outside root: ${relative}`);
  }

  let handle;
  try {
    handle = await fs.promises.open(
      absolute,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat();
    if (!before.isFile()
        || before.nlink !== 1
        || !sameStableMetadata(pathStats, before)) {
      throw gateError(code, `repository file changed before reading: ${relative}`);
    }

    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (bytesRead === 0) {
        throw gateError(code, `repository file was truncated while reading: ${relative}`);
      }
      position += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, position);
    if (extraBytes !== 0) {
      throw gateError(code, `repository file grew while reading: ${relative}`);
    }

    const afterHandle = await handle.stat();
    const afterPath = await fs.promises.lstat(absolute);
    const realAfter = await fs.promises.realpath(absolute);
    if (!sameStableMetadata(before, afterHandle)
        || !sameStableMetadata(pathStats, afterPath)
        || realAfter !== realFile) {
      throw gateError(code, `repository file changed while reading: ${relative}`);
    }
    await assertDirectoryChainUnchanged(directories, code, relative);
    return bytes;
  } catch (error) {
    if (error?.code?.startsWith?.('NATIVE_COVERAGE_')) throw error;
    throw gateError(code, `repository file cannot be read safely: ${relative}`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertStableRoot(root) {
  let stats;
  try {
    stats = await fs.promises.lstat(root);
  } catch {
    throw gateError('NATIVE_COVERAGE_ARGUMENT_INVALID', 'repository root is missing');
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw gateError('NATIVE_COVERAGE_ARGUMENT_INVALID', 'repository root is not one directory');
  }
  try {
    return await fs.promises.realpath(root);
  } catch {
    throw gateError('NATIVE_COVERAGE_ARGUMENT_INVALID', 'repository root cannot be resolved');
  }
}

export async function runNativeReleaseCoverageGate({ root, policyPath }) {
  const resolvedRoot = path.resolve(root);
  const resolvedPolicy = path.resolve(policyPath);
  const expectedPolicy = path.join(resolvedRoot, 'packaging', 'native-coverage-approvals.json');
  if (resolvedPolicy !== expectedPolicy) {
    throw gateError('NATIVE_COVERAGE_ARGUMENT_INVALID', 'native coverage policy path is not reviewed');
  }
  const realRoot = await assertStableRoot(resolvedRoot);
  const policyBytes = await readStableRepositoryFile(
    resolvedRoot,
    realRoot,
    'packaging/native-coverage-approvals.json',
    { code: 'NATIVE_COVERAGE_POLICY_INVALID', maxBytes: MAX_POLICY_BYTES },
  );
  const policyText = policyBytes.toString('utf8');
  let policy;
  try {
    policy = JSON.parse(policyText);
  } catch {
    throw gateError('NATIVE_COVERAGE_POLICY_INVALID', 'native coverage policy is not JSON');
  }
  if (policyText !== canonicalJson(policy)) {
    throw gateError('NATIVE_COVERAGE_POLICY_INVALID', 'native coverage policy is not canonical');
  }

  validateApprovedPolicy(policy);
  const implementationFiles = new Map();
  for (const relative of NATIVE_RELEASE_REQUIRED_IMPLEMENTATION) {
    implementationFiles.set(relative, await readStableRepositoryFile(
      resolvedRoot,
      realRoot,
      relative,
      { code: 'NATIVE_COVERAGE_IMPLEMENTATION_INCOMPLETE', maxBytes: MAX_IMPLEMENTATION_BYTES },
    ));
  }
  const evidenceFiles = new Map();
  for (const approval of policy.approvals) {
    evidenceFiles.set(approval.evidencePath, await readStableRepositoryFile(
      resolvedRoot,
      realRoot,
      approval.evidencePath,
      { code: 'NATIVE_COVERAGE_EVIDENCE_INVALID', maxBytes: MAX_EVIDENCE_BYTES },
    ));
  }
  return assertNativeReleaseCoverageGate({ policy, implementationFiles, evidenceFiles });
}

async function main(argv) {
  if (argv.length !== 4 || argv[0] !== '--root' || argv[2] !== '--policy') {
    throw gateError('NATIVE_COVERAGE_ARGUMENT_INVALID', 'expected --root and --policy');
  }
  await runNativeReleaseCoverageGate({ root: argv[1], policyPath: argv[3] });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.code ?? 'NATIVE_COVERAGE_GATE_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
