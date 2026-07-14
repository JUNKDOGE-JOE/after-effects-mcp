#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPortableRelativePath,
  canonicalJson,
  readJsonFile,
  sha256Bytes,
  sha256File,
} from './lib/manifest.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_POLICY_PATH = path.resolve(path.dirname(MODULE_PATH), '../../packaging/ae-sdk-inputs.json');
const PLATFORM_IDS = new Set(['macos-arm64', 'windows-x64']);
const CLAIMED_SDK_VERSION = '25.6.61';
const MAX_TRACKED_FILES = 100_000;
const MAX_ROOT_ENTRIES = 20_000;
const MAX_ROOT_DEPTH = 32;
const MAX_ROOT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ROOT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_TRACKED_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_TRACKED_BLOB_TOTAL_BYTES = 64 * 1024 * 1024;

export const AE_SDK_POLICY_CANONICAL_SHA256 =
  '1056af19202883c4dd481ba953fb98f18f046cba35be94409d20ff01e5f89efb';

const SDK_ONLY_PATH = new RegExp([
  String.raw`(?:^|\/)(?:AfterEffectsSDK_[^/]+|ae25\.6_61\.64bit\.AfterEffectsSDK)(?:\/|$)`,
  String.raw`(?:^|\/)(?:After_Effects_SDK_Guide\.pdf|AE_GeneralPlug(?:Old)?\.h|AE_IO\.h|SPBasic\.h|AEGP_SuiteHandler\.h|AE_General\.r|PiPLtool\.exe)$`,
  String.raw`(?:^|\/)Examples\/(?:Util\/entry\.h|AEGP\/(?:Commando|ProjDumper)(?:\/|$))`,
].join('|'), 'i');

function sdkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidPolicy() {
  throw sdkError(
    'AE_SDK_POLICY_INVALID',
    'the After Effects SDK input policy is malformed or differs from the reviewed lock',
  );
}

function exactObject(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validateAeSdkPolicy(value) {
  if (!exactObject(value, ['schemaVersion', 'sdk'])
      || value.schemaVersion !== 1
      || !exactObject(value.sdk, [
        'acquisition',
        'antiVendoring',
        'byteIdentityMeaning',
        'claimedBitness',
        'claimedBuild',
        'claimedVersion',
        'compatibility',
        'extractedRoot',
        'layoutSentinels',
        'licenseReview',
        'name',
        'platforms',
        'rootVerification',
      ])
      || !Array.isArray(value.sdk.layoutSentinels)
      || !exactObject(value.sdk.platforms, [...PLATFORM_IDS])
      || value.sdk.compatibility?.afterEffects25 !== 'unknown'
      || value.sdk.compatibility?.afterEffects26 !== 'unknown'
      || value.sdk.licenseReview?.defaultPolicy !== 'deny-unless-scope-approved'
      || value.sdk.licenseReview?.operatorAttestation?.status !== 'recorded'
      || value.sdk.licenseReview?.operatorAttestation?.actualLocationStored !== false
      || value.sdk.licenseReview?.termsEvidence?.approvalId !== null) {
    invalidPolicy();
  }

  let digest;
  try {
    digest = sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
  } catch {
    invalidPolicy();
  }
  if (digest !== AE_SDK_POLICY_CANONICAL_SHA256) invalidPolicy();
  return value;
}

export async function loadAeSdkPolicy(policyPath = DEFAULT_POLICY_PATH) {
  try {
    return validateAeSdkPolicy(await readJsonFile(policyPath, 'AE_SDK_POLICY_INVALID'));
  } catch (error) {
    if (error?.code === 'AE_SDK_POLICY_INVALID') invalidPolicy();
    throw error;
  }
}

function sameStableFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function ensurePlatform(policy, platform) {
  if (!PLATFORM_IDS.has(platform) || !policy.sdk.platforms[platform]) {
    throw sdkError(
      'AE_SDK_PLATFORM_UNSUPPORTED',
      'unsupported After Effects SDK platform; expected macos-arm64 or windows-x64',
    );
  }
  return policy.sdk.platforms[platform];
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function realDirectory(directory, code, message) {
  try {
    const before = await fs.promises.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('not a directory');
    const real = await fs.promises.realpath(directory);
    const after = await fs.promises.lstat(directory);
    const realStats = await fs.promises.lstat(real);
    if (!after.isDirectory()
        || after.isSymbolicLink()
        || !realStats.isDirectory()
        || realStats.isSymbolicLink()
        || !sameDirectorySnapshot(before, after)
        || before.dev !== realStats.dev
        || before.ino !== realStats.ino) {
      throw new Error('directory changed while resolving');
    }
    return real;
  } catch {
    throw sdkError(code, message);
  }
}

async function resolveRepositoryRoot(repoRoot) {
  return realDirectory(
    repoRoot,
    'AE_SDK_REPOSITORY_INVALID',
    'repository root must be an existing non-symlink directory',
  );
}

function assertOutsideRepository(repoRoot, candidate) {
  if (isInside(repoRoot, candidate)) {
    throw sdkError(
      'AE_SDK_INPUT_INSIDE_REPOSITORY',
      'After Effects SDK inputs must remain outside the repository',
    );
  }
}

export async function verifyAeSdkArchive({
  archivePath,
  platform,
  policy,
  repoRoot = process.cwd(),
}) {
  const lockedPolicy = validateAeSdkPolicy(policy);
  const record = ensurePlatform(lockedPolicy, platform).archive;
  const verification = await verifyArchiveAgainstRecord({ archivePath, record, repoRoot });
  return Object.freeze({
    schemaVersion: 1,
    platform,
    archiveVerification: verification.archiveVerification,
    byteIdentityMeaning: lockedPolicy.sdk.byteIdentityMeaning,
    claimedVersion: lockedPolicy.sdk.claimedVersion,
    fileNameHintMatched: verification.fileNameHintMatched,
    sdkRootReady: false,
  });
}

function validateArchiveRecord(record) {
  if (!exactObject(record, ['bytes', 'fileNameHint', 'sha256'])
      || !Number.isSafeInteger(record.bytes)
      || record.bytes < 1
      || typeof record.fileNameHint !== 'string'
      || !record.fileNameHint
      || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) {
    throw sdkError('AE_SDK_POLICY_INVALID', 'SDK archive record is invalid');
  }
}

export async function verifyArchiveAgainstRecord({
  archivePath,
  record,
  repoRoot = process.cwd(),
}) {
  if (!archivePath) {
    throw sdkError(
      'AE_SDK_ARCHIVE_REQUIRED',
      'AE_SDK_ARCHIVE or --archive is required',
    );
  }
  validateArchiveRecord(record);
  const repository = await resolveRepositoryRoot(repoRoot);

  let stats;
  let archive;
  try {
    stats = await fs.promises.lstat(archivePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw new Error('not one regular file');
    }
    archive = await fs.promises.realpath(archivePath);
  } catch {
    throw sdkError(
      'AE_SDK_ARCHIVE_INVALID',
      'SDK archive must be one existing regular, non-linked file',
    );
  }
  assertOutsideRepository(repository, archive);
  if (stats.size !== record.bytes) {
    throw sdkError(
      'AE_SDK_ARCHIVE_INVALID',
      'SDK archive size does not match the reviewed byte identity',
    );
  }

  let digest;
  try {
    digest = await sha256File(archive, { expectedStats: stats });
  } catch {
    throw sdkError(
      'AE_SDK_ARCHIVE_INVALID',
      'SDK archive changed or became unsafe during verification',
    );
  }
  if (digest !== record.sha256) {
    throw sdkError(
      'AE_SDK_ARCHIVE_INVALID',
      'SDK archive SHA-256 does not match the reviewed byte identity',
    );
  }

  return Object.freeze({
    archiveVerification: 'sha256-verified',
    fileNameHintMatched: path.basename(archive) === record.fileNameHint,
  });
}

function sameDirectorySnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function collectSafeRootLayout(root) {
  const entries = new Map();
  const fileRecords = [];
  const fileSnapshots = [];
  const portableKeys = new Set();
  let totalFileBytes = 0;

  async function visit(directory, prefix, depth) {
    if (depth > MAX_ROOT_DEPTH) {
      throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root exceeds the safe directory depth');
    }
    const before = await fs.promises.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root contains an unsafe directory');
    }
    const children = await fs.promises.opendir(directory);
    for await (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      try {
        assertPortableRelativePath(relative, 'AE_SDK_LAYOUT_INVALID');
      } catch {
        throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root contains a non-portable path');
      }
      const portableKey = relative.normalize('NFC').toLowerCase();
      if (portableKeys.has(portableKey)) {
        throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root contains colliding paths');
      }
      portableKeys.add(portableKey);
      if (entries.size >= MAX_ROOT_ENTRIES) {
        throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root exceeds the safe entry count');
      }
      const absolute = path.join(directory, child.name);
      const stats = await fs.promises.lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root must not contain symbolic links');
      }
      if (stats.isDirectory()) {
        entries.set(relative, 'directory');
        await visit(absolute, relative, depth + 1);
      } else if (stats.isFile()) {
        if (stats.nlink !== 1) {
          throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root must not contain hard-linked files');
        }
        if (stats.size > MAX_ROOT_FILE_BYTES
            || totalFileBytes + stats.size > MAX_ROOT_TOTAL_BYTES) {
          throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root exceeds the safe file-byte limits');
        }
        totalFileBytes += stats.size;
        entries.set(relative, 'file');
        fileRecords.push({
          path: relative,
          type: 'file',
          size: stats.size,
          sha256: await sha256File(absolute, { expectedStats: stats }),
        });
        fileSnapshots.push({ absolute, stats });
      } else {
        throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root must not contain special files');
      }
    }
    const after = await fs.promises.lstat(directory);
    if (!after.isDirectory() || !sameDirectorySnapshot(before, after)) {
      throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root changed during layout verification');
    }
  }

  try {
    await visit(root, '', 0);
    for (const snapshot of fileSnapshots) {
      const after = await fs.promises.lstat(snapshot.absolute);
      if (!after.isFile()
          || after.isSymbolicLink()
          || !sameStableFileSnapshot(snapshot.stats, after)) {
        throw sdkError(
          'AE_SDK_LAYOUT_INVALID',
          'SDK root file changed after it was hashed',
        );
      }
    }
  } catch (error) {
    if (error?.code === 'AE_SDK_LAYOUT_INVALID') throw error;
    throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK root is unreadable or changed during verification');
  }
  fileRecords.sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
  return { entries, fileRecords };
}

async function resolveSdkRoot({ rootInput, extractedRoot, repository }) {
  if (!rootInput) {
    throw sdkError('AE_SDK_ROOT_REQUIRED', 'AE_SDK_ROOT or --root is required');
  }
  const input = await realDirectory(
    rootInput,
    'AE_SDK_LAYOUT_INVALID',
    'SDK root input must be an existing non-symlink directory',
  );
  assertOutsideRepository(repository, input);

  let root = input;
  if (path.basename(input) !== extractedRoot) {
    root = await realDirectory(
      path.join(input, extractedRoot),
      'AE_SDK_LAYOUT_INVALID',
      'SDK root input must be the exact extracted root or its direct parent',
    );
  }
  if (path.basename(root) !== extractedRoot) {
    throw sdkError('AE_SDK_LAYOUT_INVALID', 'SDK extracted root name does not match the lock');
  }
  assertOutsideRepository(repository, root);
  return root;
}

export async function verifyAeSdkRoot({
  rootInput,
  platform,
  policy,
  repoRoot = process.cwd(),
}) {
  const lockedPolicy = validateAeSdkPolicy(policy);
  const platformRecord = ensurePlatform(lockedPolicy, platform);
  const verification = await verifyRootAgainstRecord({
    rootInput,
    extractedRoot: lockedPolicy.sdk.extractedRoot,
    sentinels: [...lockedPolicy.sdk.layoutSentinels, platformRecord.buildSentinel],
    contentLock: platformRecord.rootContentLock,
    repoRoot,
  });
  return Object.freeze({ schemaVersion: 1, platform, ...verification });
}

function validateRootRecord({ extractedRoot, sentinels, contentLock }) {
  try {
    assertPortableRelativePath(extractedRoot, 'AE_SDK_POLICY_INVALID');
  } catch {
    throw sdkError('AE_SDK_POLICY_INVALID', 'SDK extracted root record is invalid');
  }
  if (extractedRoot.includes('/')
      || !Array.isArray(sentinels)
      || sentinels.length === 0
      || sentinels.some((sentinel) => (
        !exactObject(sentinel, ['path', 'type'])
        || !['file', 'directory'].includes(sentinel.type)
      ))) {
    throw sdkError('AE_SDK_POLICY_INVALID', 'SDK layout sentinel record is invalid');
  }
  for (const sentinel of sentinels) {
    try {
      assertPortableRelativePath(sentinel.path, 'AE_SDK_POLICY_INVALID');
    } catch {
      throw sdkError('AE_SDK_POLICY_INVALID', 'SDK layout sentinel path is invalid');
    }
  }
  if (!exactObject(contentLock, ['fileBytes', 'fileCount', 'sha256', 'status'])
      || !['canonical-file-tree-verified', 'pending-windows-extraction-evidence']
        .includes(contentLock.status)) {
    throw sdkError('AE_SDK_POLICY_INVALID', 'SDK root content lock is invalid');
  }
  if (contentLock.status === 'canonical-file-tree-verified') {
    if (!Number.isSafeInteger(contentLock.fileCount) || contentLock.fileCount < 1
        || !Number.isSafeInteger(contentLock.fileBytes) || contentLock.fileBytes < 1
        || !/^[a-f0-9]{64}$/.test(contentLock.sha256 ?? '')) {
      throw sdkError('AE_SDK_POLICY_INVALID', 'SDK root content lock is invalid');
    }
  } else if (contentLock.fileCount !== null
      || contentLock.fileBytes !== null
      || contentLock.sha256 !== null) {
    throw sdkError('AE_SDK_POLICY_INVALID', 'pending SDK root content evidence must be empty');
  }
}

export async function verifyRootAgainstRecord({
  rootInput,
  extractedRoot,
  sentinels,
  contentLock,
  repoRoot = process.cwd(),
}) {
  validateRootRecord({ extractedRoot, sentinels, contentLock });
  const repository = await resolveRepositoryRoot(repoRoot);
  const root = await resolveSdkRoot({
    rootInput,
    extractedRoot,
    repository,
  });
  const { entries, fileRecords } = await collectSafeRootLayout(root);
  for (const sentinel of sentinels) {
    if (entries.get(sentinel.path) !== sentinel.type) {
      throw sdkError(
        'AE_SDK_LAYOUT_INVALID',
        'SDK root is missing a required native build layout sentinel',
      );
    }
  }
  const fileBytes = fileRecords.reduce((total, record) => total + record.size, 0);
  const fileTreeSha256 = sha256Bytes(Buffer.from(canonicalJson(fileRecords), 'utf8'));
  const contentVerified = contentLock.status === 'canonical-file-tree-verified';
  if (contentVerified
      && (fileRecords.length !== contentLock.fileCount
        || fileBytes !== contentLock.fileBytes
        || fileTreeSha256 !== contentLock.sha256)) {
    throw sdkError(
      'AE_SDK_LAYOUT_INVALID',
      'SDK root content does not match the canonical platform file-tree lock',
    );
  }

  return Object.freeze({
    rootVerification: contentVerified ? 'layout-and-content-verified' : 'layout-verified',
    provenanceVerified: false,
    contentVerified,
    contentEvidence: contentVerified
      ? 'canonical-file-tree-verified'
      : 'pending-platform-extraction-evidence',
    entryCount: entries.size,
  });
}

export async function verifyAeSdkInput({
  archivePath,
  rootInput,
  platform,
  policy,
  repoRoot = process.cwd(),
}) {
  if (!rootInput) {
    throw sdkError('AE_SDK_ROOT_REQUIRED', 'AE_SDK_ROOT or --root is required');
  }
  if (!archivePath) {
    throw sdkError('AE_SDK_ARCHIVE_REQUIRED', 'AE_SDK_ARCHIVE or --archive is required');
  }
  const archive = await verifyAeSdkArchive({ archivePath, platform, policy, repoRoot });
  const root = await verifyAeSdkRoot({ rootInput, platform, policy, repoRoot });
  return combineAeSdkEvidence({ archive, root, platform });
}

export function combineAeSdkEvidence({ archive, root, platform }) {
  if (root?.contentVerified !== true) {
    throw sdkError(
      'AE_SDK_CONTENT_EVIDENCE_PENDING',
      'canonical SDK root content evidence is required before this platform may build',
    );
  }
  if (archive?.schemaVersion !== 1
      || root?.schemaVersion !== 1
      || archive.platform !== platform
      || root.platform !== platform
      || archive?.archiveVerification !== 'sha256-verified'
      || root.rootVerification !== 'layout-and-content-verified'
      || archive.claimedVersion !== CLAIMED_SDK_VERSION
      || !PLATFORM_IDS.has(platform)) {
    throw sdkError('AE_SDK_POLICY_INVALID', 'SDK combined verification evidence is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    platform,
    archiveVerification: archive.archiveVerification,
    rootVerification: root.rootVerification,
    provenance: 'archive-byte-identity-plus-canonical-root-content',
    claimedVersion: archive.claimedVersion,
    sdkRootReady: true,
  });
}

function runGit(repoRoot, args, options = {}) {
  let output;
  try {
    output = execFileSync(
      'git',
      ['-C', repoRoot, ...args],
      {
        encoding: null,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        ...options,
      },
    );
  } catch {
    throw sdkError(
      'AE_SDK_REPOSITORY_INVALID',
      'cannot enumerate tracked repository files for SDK policy verification',
    );
  }
  return output;
}

function decodeGitPath(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw sdkError('AE_SDK_REPOSITORY_INVALID', 'tracked Git path is not valid UTF-8');
  }
}

function trackedBlobRecords(repoRoot) {
  const output = runGit(repoRoot, ['ls-files', '--cached', '--stage', '-z']);
  const records = [];
  let offset = 0;
  while (offset < output.length) {
    const nul = output.indexOf(0, offset);
    if (nul === -1) {
      throw sdkError('AE_SDK_REPOSITORY_INVALID', 'tracked Git index output is malformed');
    }
    const record = output.subarray(offset, nul);
    offset = nul + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) {
      throw sdkError('AE_SDK_REPOSITORY_INVALID', 'tracked Git index record is malformed');
    }
    const identity = record.subarray(0, tab).toString('ascii');
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}|[a-f0-9]{64}) 0$/.exec(identity);
    if (!match) {
      throw sdkError(
        'AE_SDK_REPOSITORY_INVALID',
        'tracked Git index contains an unsupported mode or unresolved merge entry',
      );
    }
    if (match[1] === '160000') {
      throw sdkError(
        'AE_SDK_REPOSITORY_INVALID',
        'submodules are not covered by the SDK anti-vendoring policy',
      );
    }
    records.push({
      mode: match[1],
      objectId: match[2],
      path: decodeGitPath(record.subarray(tab + 1)),
    });
  }
  if (records.length > MAX_TRACKED_FILES) {
    throw sdkError('AE_SDK_REPOSITORY_INVALID', 'tracked repository file count exceeds policy limit');
  }
  return records;
}

function gitBlobMetadata(repoRoot, objectIds) {
  if (objectIds.length === 0) return { metadata: new Map(), totalBytes: 0 };
  const output = runGit(
    repoRoot,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    { input: `${objectIds.join('\n')}\n` },
  ).toString('ascii').trimEnd().split('\n');
  if (output.length !== objectIds.length) {
    throw sdkError('AE_SDK_REPOSITORY_INVALID', 'Git blob metadata count is inconsistent');
  }
  const metadata = new Map();
  let totalBytes = 0;
  for (let index = 0; index < objectIds.length; index += 1) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(output[index]);
    const bytes = Number(match?.[2]);
    if (!match
        || match[1] !== objectIds[index]
        || !Number.isSafeInteger(bytes)
        || bytes < 0
        || bytes > MAX_TRACKED_BLOB_BYTES
        || totalBytes + bytes > MAX_TRACKED_BLOB_TOTAL_BYTES) {
      throw sdkError(
        'AE_SDK_REPOSITORY_INVALID',
        'tracked Git blob metadata exceeds policy bounds or is malformed',
      );
    }
    totalBytes += bytes;
    metadata.set(match[1], { bytes });
  }
  return { metadata, totalBytes };
}

function readGitBlobs(repoRoot, objectIds, metadata, totalBytes) {
  if (objectIds.length === 0) return new Map();
  const output = runGit(
    repoRoot,
    ['cat-file', '--batch'],
    {
      input: `${objectIds.join('\n')}\n`,
      maxBuffer: totalBytes + (objectIds.length * 160) + 1024,
    },
  );
  const blobs = new Map();
  let offset = 0;
  for (const objectId of objectIds) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) {
      throw sdkError('AE_SDK_REPOSITORY_INVALID', 'Git blob batch output is truncated');
    }
    const header = output.subarray(offset, newline).toString('ascii');
    const expectedBytes = metadata.get(objectId)?.bytes;
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(header);
    if (!match || match[1] !== objectId || Number(match[2]) !== expectedBytes) {
      throw sdkError('AE_SDK_REPOSITORY_INVALID', 'Git blob batch header is inconsistent');
    }
    const start = newline + 1;
    const end = start + expectedBytes;
    if (end >= output.length || output[end] !== 0x0a) {
      throw sdkError('AE_SDK_REPOSITORY_INVALID', 'Git blob batch payload is truncated');
    }
    blobs.set(objectId, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length) {
    throw sdkError('AE_SDK_REPOSITORY_INVALID', 'Git blob batch output has trailing bytes');
  }
  return blobs;
}

function looksLikeSdkArchive(bytes) {
  const isZip = bytes.length >= 4
    && (bytes.readUInt32LE(0) === 0x04034b50 || bytes.readUInt32LE(0) === 0x06054b50);
  return isZip && [
    'AfterEffectsSDK_',
    'ae25.6_61.64bit.AfterEffectsSDK',
    'After_Effects_SDK_Guide.pdf',
    'AE_GeneralPlug.h',
  ].some((marker) => bytes.includes(Buffer.from(marker, 'utf8')));
}

function isGitLfsPointer(bytes) {
  if (bytes.length > 2048) return false;
  const text = bytes.toString('utf8');
  return /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(text);
}

function validateTrackedPolicyControl({ records, blobs, policy, policyPath }) {
  if (!policyPath) return;
  let portablePolicyPath;
  try {
    portablePolicyPath = assertPortableRelativePath(policyPath, 'AE_SDK_REPOSITORY_INVALID');
  } catch {
    throw sdkError('AE_SDK_REPOSITORY_INVALID', 'tracked SDK policy path is invalid');
  }
  const record = records.find((candidate) => candidate.path === portablePolicyPath);
  const bytes = record?.mode === '120000' ? undefined : blobs.get(record?.objectId);
  if (!bytes) {
    throw sdkError(
      'AE_SDK_REPOSITORY_INVALID',
      'the reviewed SDK policy must be present as one tracked regular file',
    );
  }
  let trackedPolicy;
  try {
    trackedPolicy = validateAeSdkPolicy(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw sdkError(
      'AE_SDK_REPOSITORY_INVALID',
      'the tracked SDK policy differs from the reviewed control data',
    );
  }
  if (canonicalJson(trackedPolicy) !== canonicalJson(policy)) {
    throw sdkError(
      'AE_SDK_REPOSITORY_INVALID',
      'the worktree and tracked SDK policies do not describe the same reviewed input',
    );
  }
}

export async function verifyRepositoryHasNoVendoredAeSdk({
  repoRoot = process.cwd(),
  policy,
}) {
  const lockedPolicy = validateAeSdkPolicy(policy);
  const forbiddenRecords = [];
  for (const record of Object.values(lockedPolicy.sdk.platforms)) {
    for (const locked of [record.archive, record.innerPayload]) {
      forbiddenRecords.push({ bytes: locked.bytes, sha256: locked.sha256 });
    }
  }
  return scanTrackedRepositoryForSdkMaterial({
    repoRoot,
    forbiddenRecords,
    expectedPolicy: lockedPolicy,
    policyPath: 'packaging/ae-sdk-inputs.json',
  });
}

export async function scanTrackedRepositoryForSdkMaterial({
  repoRoot = process.cwd(),
  forbiddenRecords,
  expectedPolicy,
  policyPath,
}) {
  if (!Array.isArray(forbiddenRecords)
      || forbiddenRecords.length === 0
      || forbiddenRecords.some((record) => (
        !exactObject(record, ['bytes', 'sha256'])
        || !Number.isSafeInteger(record.bytes)
        || record.bytes < 1
        || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '')
      ))) {
    throw sdkError('AE_SDK_POLICY_INVALID', 'SDK forbidden-byte record is invalid');
  }
  const repository = await resolveRepositoryRoot(repoRoot);
  const forbiddenBySize = new Map();
  for (const locked of forbiddenRecords) {
    const digests = forbiddenBySize.get(locked.bytes) ?? new Set();
    digests.add(locked.sha256);
    forbiddenBySize.set(locked.bytes, digests);
  }

  const records = trackedBlobRecords(repository);
  const portablePaths = new Set();
  for (const { path: relative } of records) {
    try {
      assertPortableRelativePath(relative, 'AE_SDK_REPOSITORY_INVALID');
    } catch {
      throw sdkError('AE_SDK_REPOSITORY_INVALID', 'tracked repository path is not portable');
    }
    if (SDK_ONLY_PATH.test(relative)) {
      throw sdkError('AE_SDK_VENDORED', 'tracked repository content contains an SDK-only path');
    }
    const portableKey = relative.normalize('NFC').toLowerCase();
    if (portablePaths.has(portableKey)) {
      throw sdkError('AE_SDK_REPOSITORY_INVALID', 'tracked Git paths collide portably');
    }
    portablePaths.add(portableKey);
  }

  const objectIds = [...new Set(
    records.filter((record) => record.mode !== '120000').map((record) => record.objectId),
  )];
  const { metadata, totalBytes } = gitBlobMetadata(repository, objectIds);
  const blobs = readGitBlobs(repository, objectIds, metadata, totalBytes);
  validateTrackedPolicyControl({
    records,
    blobs,
    policy: expectedPolicy,
    policyPath,
  });
  for (const bytes of blobs.values()) {
    if (isGitLfsPointer(bytes)) {
      throw sdkError(
        'AE_SDK_REPOSITORY_INVALID',
        'Git LFS pointers are not covered by the SDK anti-vendoring policy',
      );
    }
    const forbiddenDigests = forbiddenBySize.get(bytes.length);
    if (forbiddenDigests?.has(sha256Bytes(bytes))) {
      throw sdkError('AE_SDK_VENDORED', 'tracked repository content matches locked SDK bytes');
    }
    if (looksLikeSdkArchive(bytes)) {
      throw sdkError(
        'AE_SDK_VENDORED',
        'tracked repository content contains a recognizable SDK archive',
      );
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    repositoryVerification: 'no-tracked-sdk-material',
    trackedFileCount: records.length,
  });
}

function parseLongOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw sdkError('AE_SDK_ARGUMENT_INVALID', 'only named command options are accepted');
    }
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const value = equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (equals === -1) index += 1;
    if (!value || value.startsWith('--') || options.has(name)) {
      throw sdkError('AE_SDK_ARGUMENT_INVALID', `invalid or duplicate option: ${name}`);
    }
    options.set(name, value);
  }
  return options;
}

export function parseAeSdkInputArgs(argv, environment = process.env) {
  const [command, ...rest] = argv;
  if (!['verify-archive', 'verify-root', 'verify-input', 'verify-repository'].includes(command)) {
    throw sdkError('AE_SDK_ARGUMENT_INVALID', 'a supported SDK verification command is required');
  }
  const options = parseLongOptions(rest);
  const allowedByCommand = {
    'verify-archive': new Set(['--platform', '--archive', '--repo-root']),
    'verify-root': new Set(['--platform', '--root', '--repo-root']),
    'verify-input': new Set(['--platform', '--archive', '--root', '--repo-root']),
    'verify-repository': new Set(['--repo-root']),
  };
  const allowed = allowedByCommand[command];
  for (const name of options.keys()) {
    if (!allowed.has(name)) {
      throw sdkError('AE_SDK_ARGUMENT_INVALID', `unknown option: ${name}`);
    }
  }
  const parsed = {
    command,
    repoRoot: options.get('--repo-root') ?? process.cwd(),
  };
  if (command !== 'verify-repository') {
    parsed.platform = options.get('--platform');
    parsed.archivePath = options.get('--archive') ?? environment.AE_SDK_ARCHIVE;
    parsed.rootInput = options.get('--root') ?? environment.AE_SDK_ROOT;
  }
  return parsed;
}

async function runCli(argv) {
  const options = parseAeSdkInputArgs(argv);
  const policy = await loadAeSdkPolicy();
  if (options.command === 'verify-archive') {
    return verifyAeSdkArchive({ ...options, policy });
  }
  if (options.command === 'verify-root') {
    return verifyAeSdkRoot({ ...options, policy });
  }
  if (options.command === 'verify-input') {
    return verifyAeSdkInput({ ...options, policy });
  }
  return verifyRepositoryHasNoVendoredAeSdk({ ...options, policy });
}

function publicError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'AE_SDK_INTERNAL_ERROR';
  const message = typeof error?.message === 'string'
    ? error.message
    : 'After Effects SDK verification failed';
  return { ok: false, error: { code, message } };
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) {
  try {
    const result = await runCli(process.argv.slice(2));
    process.stdout.write(canonicalJson({ ok: true, result }));
  } catch (error) {
    process.stderr.write(canonicalJson(publicError(error)));
    process.exitCode = 1;
  }
}
