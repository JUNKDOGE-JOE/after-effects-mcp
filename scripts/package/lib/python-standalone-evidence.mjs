import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const PLATFORM_NAMES = ['macos-arm64', 'windows-x64'];
const ENTRY_KINDS = new Set([
  'python-json',
  'metadata-file',
  'source-file',
  'source-archive-member',
]);
const BUNDLED_KINDS = new Set([
  'metadata-file',
  'source-file',
  'source-archive-member',
]);
const MAX_BUNDLE_ENTRIES = 512;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_COMPRESSED_ENTRY_BYTES =
  MAX_ENTRY_BYTES + (Math.ceil(MAX_ENTRY_BYTES / 0xffff) * 5) + 18;
const MAX_TOTAL_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ORIGIN_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_METADATA_TAR_BYTES = 512 * 1024 * 1024;
const EVIDENCE_CONTENT_CHUNK_CHARS = 16 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});
export const CPYTHON_LICENSE_OVERLAY_V1 = Object.freeze({
  observed: Object.freeze(['Python-2.0', 'CNRI-Python']),
  normalized: 'Python-2.0',
  rationale:
    'SPDX Python-2.0 is the composite Python license and already includes the CNRI agreement represented separately by python-build-standalone metadata.',
});
export const TCL_LIBRARY_PATHS_OVERLAY_V1 = Object.freeze({
  rationale:
    'PYTHON.json records Tcl library directory ABI labels; reviewed component versions are locked by the Python standalone BOM.',
  platforms: Object.freeze({
    'macos-arm64': Object.freeze({
      observed: Object.freeze(['itcl4.3.5', 'thread3.0.4', 'tk9.0']),
      components: Object.freeze([
        Object.freeze({ name: 'itcl', version: '4.3.5', paths: Object.freeze(['itcl4.3.5']) }),
        Object.freeze({
          name: 'tcl-thread',
          version: '3.0.4',
          paths: Object.freeze(['thread3.0.4']),
        }),
        Object.freeze({ name: 'tk', version: '9.0.3', paths: Object.freeze(['tk9.0']) }),
      ]),
    }),
    'windows-x64': Object.freeze({
      observed: Object.freeze(['dde1.4', 'reg1.3', 'tcl8.6', 'tk8.6', 'tcl8', 'tix8.4.3']),
      components: Object.freeze([
        Object.freeze({
          name: 'tcl',
          version: '8.6.12',
          paths: Object.freeze(['dde1.4', 'reg1.3', 'tcl8.6', 'tcl8']),
        }),
        Object.freeze({ name: 'tk', version: '8.6.12', paths: Object.freeze(['tk8.6']) }),
        Object.freeze({ name: 'tix', version: '8.4.3.6', paths: Object.freeze(['tix8.4.3']) }),
      ]),
    }),
  }),
});

const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');

function crc32(content) {
  let value = 0xffffffff;
  for (const byte of content) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function canonicalStoredGzip(content) {
  const bytes = Buffer.from(content);
  const chunks = [Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff])];
  if (bytes.length === 0) {
    chunks.push(Buffer.from([0x01, 0x00, 0x00, 0xff, 0xff]));
  } else {
    for (let offset = 0; offset < bytes.length; offset += 0xffff) {
      const length = Math.min(0xffff, bytes.length - offset);
      const block = Buffer.allocUnsafe(5 + length);
      block[0] = offset + length === bytes.length ? 0x01 : 0x00;
      block.writeUInt16LE(length, 1);
      block.writeUInt16LE((~length) & 0xffff, 3);
      bytes.copy(block, 5, offset, offset + length);
      chunks.push(block);
    }
  }
  const footer = Buffer.allocUnsafe(8);
  footer.writeUInt32LE(crc32(bytes), 0);
  footer.writeUInt32LE(bytes.length >>> 0, 4);
  chunks.push(footer);
  return Buffer.concat(chunks);
}

export function encodePythonStandaloneEvidenceContent(content) {
  return canonicalStoredGzip(content).toString('base64');
}

export function chunkPythonStandaloneEvidenceContent(encodedContent) {
  if (typeof encodedContent !== 'string' || encodedContent.length === 0) {
    throw new Error('Encoded Python standalone evidence content must be a non-empty string');
  }
  const chunks = [];
  for (let offset = 0; offset < encodedContent.length; offset += EVIDENCE_CONTENT_CHUNK_CHARS) {
    chunks.push(encodedContent.slice(offset, offset + EVIDENCE_CONTENT_CHUNK_CHARS));
  }
  return chunks;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function jsonEquivalent(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) =>
      key === rightKeys[index] && jsonEquivalent(left[key], right[key]));
}

function isSecureArchiveOrigin(origin) {
  if (!hasExactKeys(origin, ['url', 'sha256']) || !SHA256_PATTERN.test(origin.sha256)) {
    return false;
  }
  try {
    const url = new URL(origin.url);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

function validateEntryShape(entry) {
  if (!hasExactKeys(entry, [
    'platforms',
    'kind',
    'origin',
    'memberPath',
    'sha256',
    'size',
    'encoding',
    'content',
  ])) {
    throw new Error('Invalid evidence entry fields');
  }
  if (!Array.isArray(entry.platforms)
      || entry.platforms.length === 0
      || entry.platforms.length > PLATFORM_NAMES.length
      || new Set(entry.platforms).size !== entry.platforms.length
      || entry.platforms.some((platform) => !PLATFORM_NAMES.includes(platform))
      || entry.platforms.some((platform, index) =>
        index > 0
        && PLATFORM_NAMES.indexOf(entry.platforms[index - 1]) >= PLATFORM_NAMES.indexOf(platform))) {
    throw new Error('Invalid evidence entry platforms');
  }
  if (!ENTRY_KINDS.has(entry.kind)) throw new Error('Invalid evidence entry kind');
  if (!isSecureArchiveOrigin(entry.origin)) throw new Error('Invalid evidence entry HTTPS origin');
  if (!SHA256_PATTERN.test(entry.sha256)) throw new Error('Invalid evidence entry SHA-256');
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_ENTRY_BYTES) {
    throw new Error('Evidence entry size limit exceeded');
  }
  const maxEncodedLength = Math.ceil(MAX_COMPRESSED_ENTRY_BYTES / 3) * 4;
  if (entry.encoding !== 'gzip-base64'
      || !Array.isArray(entry.content)
      || entry.content.length === 0
      || entry.content.length > Math.ceil(maxEncodedLength / EVIDENCE_CONTENT_CHUNK_CHARS)
      || entry.content.some((chunk, index) =>
        typeof chunk !== 'string'
        || chunk.length === 0
        || chunk.length > EVIDENCE_CONTENT_CHUNK_CHARS
        || (index < entry.content.length - 1
          && chunk.length !== EVIDENCE_CONTENT_CHUNK_CHARS))
      || entry.content.reduce((total, chunk) => total + chunk.length, 0) > maxEncodedLength) {
    throw new Error('Invalid evidence entry encoded content');
  }
  validateEvidenceMemberPath(entry.memberPath);
}

function readJson(value, defaultPath) {
  if (value !== undefined) {
    return typeof value === 'string'
      ? JSON.parse(fs.readFileSync(value, 'utf8'))
      : value;
  }
  return JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
}

function sameOrigin(actual, expected) {
  return actual?.url === expected?.url && actual?.sha256 === expected?.sha256;
}

function originKey(origin) {
  return `${origin.url}\0${origin.sha256}`;
}

function recordSha256(record) {
  return record.kind === 'source-archive-member'
    ? record.memberSha256
    : record.sha256;
}

function validateBomEvidenceRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Invalid BOM evidence record');
  }
  if (record.kind === 'source-archive-member') {
    if (!hasExactKeys(record, ['kind', 'path', 'archiveSha256', 'memberSha256'])
        || !SHA256_PATTERN.test(record.archiveSha256)
        || !SHA256_PATTERN.test(record.memberSha256)) {
      throw new Error('Invalid source archive member evidence record');
    }
  } else if (['metadata-file', 'source-file', 'payload-file'].includes(record.kind)) {
    if (!hasExactKeys(record, ['kind', 'path', 'sha256'])
        || !SHA256_PATTERN.test(record.sha256)) {
      throw new Error(`Invalid ${record.kind} evidence record`);
    }
  } else {
    throw new Error(`Unsupported BOM evidence kind: ${record.kind}`);
  }
  validateEvidenceMemberPath(record.path);
}

function evidenceKey(platform, kind, memberPath) {
  return `${platform}\0${kind}\0${memberPath}`;
}

export function validateEvidenceMemberPath(memberPath) {
  const unsafe = (reason) => {
    throw new Error(`Unsafe evidence member path (${reason}): ${String(memberPath)}`);
  };
  if (typeof memberPath !== 'string' || memberPath.length === 0 || memberPath.length > 1024) {
    unsafe('invalid length');
  }
  if (memberPath !== memberPath.normalize('NFC')) unsafe('non-canonical Unicode');
  if (memberPath.startsWith('/') || memberPath.startsWith('\\') || /^[A-Za-z]:/.test(memberPath)) {
    unsafe('absolute path');
  }
  if (memberPath.includes('\\') || /[\0-\x1f\x7f]/.test(memberPath)) {
    unsafe('non-portable character');
  }
  const segments = memberPath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') unsafe('path traversal');
    if (segment.endsWith('.') || segment.endsWith(' ') || segment.includes(':')) {
      unsafe('non-portable segment');
    }
    const stem = segment.split('.')[0].toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      unsafe('reserved Windows name');
    }
  }
  return memberPath;
}

function decodeEntry(entry) {
  if (entry.encoding !== 'gzip-base64') {
    throw new Error(`Unsupported evidence encoding for ${entry.memberPath}`);
  }
  const encodedContent = entry.content.join('');
  const compressed = Buffer.from(encodedContent, 'base64');
  if (compressed.toString('base64') !== encodedContent) {
    throw new Error(`Evidence content is not canonical base64 for ${entry.memberPath}`);
  }
  if (compressed.length > MAX_COMPRESSED_ENTRY_BYTES) {
    throw new Error(`Evidence compressed size limit exceeded for ${entry.memberPath}`);
  }
  let bytes;
  try {
    bytes = zlib.gunzipSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch (error) {
    throw new Error(`Evidence decompression failed or exceeded limits for ${entry.memberPath}`, {
      cause: error,
    });
  }
  const canonicalCompressed = canonicalStoredGzip(bytes);
  if (!compressed.equals(canonicalCompressed)
      || !jsonEquivalent(entry.content, chunkPythonStandaloneEvidenceContent(encodedContent))) {
    throw new Error(`Evidence content is not deterministic gzip for ${entry.memberPath}`);
  }
  if (bytes.length !== entry.size) {
    throw new Error(`Evidence size mismatch for ${entry.memberPath}`);
  }
  if (sha256(bytes) !== entry.sha256) {
    throw new Error(`Evidence SHA-256 mismatch for ${entry.memberPath}`);
  }
  return bytes;
}

function ensureDirectoryNoSymlink(directory, mode = 0o755) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { mode });
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe notice staging directory: ${directory}`);
  }
}

function noticePayloadPath(platform, record) {
  return validateEvidenceMemberPath(
    `licenses/python-standalone/${platform}/${record.kind}/${record.path}`,
  );
}

function stagedNoticeDirectory(directory, kind) {
  let stat;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Missing staged Python standalone notice ${kind}: ${directory}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Symlink in staged Python standalone notice ${kind}: ${directory}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Non-directory staged Python standalone notice ${kind}: ${directory}`);
  }
  return stat;
}

function stagedNoticeAncestors(root, platformRoot) {
  const ancestors = [root];
  let current = root;
  for (const segment of ['licenses', 'python-standalone', path.basename(platformRoot)]) {
    current = path.join(current, segment);
    ancestors.push(current);
  }
  return ancestors.map((directory, index) => ({
    directory,
    stat: stagedNoticeDirectory(directory, index === 0 ? 'root' : 'ancestor'),
  }));
}

function stagedNoticeItemAncestors(platformRoot, absolutePath) {
  const relativeParent = path.relative(platformRoot, path.dirname(absolutePath));
  if (relativeParent === '') return [];
  let current = platformRoot;
  return relativeParent.split(path.sep).map((segment) => {
    current = path.join(current, segment);
    return {
      directory: current,
      stat: stagedNoticeDirectory(current, 'ancestor'),
    };
  });
}

function verifyStagedDirectorySnapshots(snapshots) {
  for (const snapshot of snapshots) {
    const current = stagedNoticeDirectory(snapshot.directory, 'ancestor');
    if (!sameFileIdentity(snapshot.stat, current)) {
      throw new Error(
        `Staged Python standalone notice ancestor changed: ${snapshot.directory}`,
      );
    }
  }
}

function verifyNoticePlan(runtimeRoot, platform, plan) {
  const root = path.resolve(runtimeRoot);
  const platformRoot = path.join(root, 'licenses', 'python-standalone', platform);
  const fixedAncestors = stagedNoticeAncestors(root, platformRoot);
  const records = [];
  for (const item of plan) {
    const absolutePath = path.resolve(root, item.payloadPath);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Notice path escapes runtime root: ${item.payloadPath}`);
    }
    let stat;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Missing staged Python standalone notice: ${item.payloadPath}`);
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Unsafe staged Python standalone notice: ${item.payloadPath}`);
    }
    const itemAncestors = stagedNoticeItemAncestors(platformRoot, absolutePath);
    if (stat.size !== item.size
        || sha256FileSync(absolutePath, stat.size) !== item.sha256) {
      throw new Error(
        `Staged Python standalone notice SHA-256 or size mismatch: ${item.payloadPath}`,
      );
    }
    verifyStagedDirectorySnapshots([...fixedAncestors, ...itemAncestors]);
    records.push({ kind: 'payload-file', path: item.payloadPath, sha256: item.sha256 });
  }
  const payloadPrefix = `licenses/python-standalone/${platform}/`;
  const expectedFiles = new Set(plan.map(({ payloadPath }) => {
    if (!payloadPath.startsWith(payloadPrefix)) {
      throw new Error(`Notice payload path is outside its platform root: ${payloadPath}`);
    }
    return payloadPath.slice(payloadPrefix.length).split('/').join(path.sep);
  }));
  const actualFiles = [];
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = path.join(relative, entry.name);
      const child = path.join(directory, entry.name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) {
        throw new Error(`Unsafe symlink in staged Python standalone notices: ${childRelative}`);
      }
      if (stat.isDirectory()) visit(child, childRelative);
      else if (stat.isFile()) actualFiles.push(childRelative);
      else throw new Error(`Unsafe special file in staged Python standalone notices: ${childRelative}`);
    }
  };
  visit(platformRoot);
  actualFiles.sort();
  const expectedSorted = [...expectedFiles].sort();
  if (actualFiles.length !== expectedSorted.length
      || actualFiles.some((value, index) => value !== expectedSorted[index])) {
    throw new Error(`Staged Python standalone notice inventory mismatch for ${platform}`);
  }
  return records;
}

function safeRuntimePath(runtimeRoot, relativePath, expectedType) {
  validateEvidenceMemberPath(relativePath);
  let current = runtimeRoot;
  const segments = relativePath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`Missing Python standalone payload evidence path: ${relativePath}`);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink is forbidden in Python standalone payload evidence: ${relativePath}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`Non-directory payload evidence parent: ${relativePath}`);
    }
    if (index === segments.length - 1) {
      if (expectedType === 'file' && !stat.isFile()) {
        throw new Error(`Payload evidence is not a regular file: ${relativePath}`);
      }
      if (expectedType === 'directory' && !stat.isDirectory()) {
        throw new Error(`Payload evidence is not a directory: ${relativePath}`);
      }
      return { absolutePath: current, stat };
    }
  }
  throw new Error(`Invalid empty Python standalone payload evidence path: ${relativePath}`);
}

function sha256FileSync(filePath, expectedSize) {
  const pathStat = fs.lstatSync(filePath, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`Payload file is not a regular non-symlink: ${filePath}`);
  }
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW)
    ? fs.constants.O_NOFOLLOW
    : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (noFollow !== 0 && ['EINVAL', 'ENOTSUP'].includes(error?.code)) {
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
    } else {
      throw error;
    }
  }
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let total = 0;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()
        || !sameFileIdentity(pathStat, before)
        || before.size !== BigInt(expectedSize)) {
      throw new Error(`Payload file snapshot changed before hashing: ${filePath}`);
    }
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > expectedSize) throw new Error(`Payload file grew while hashing: ${filePath}`);
      hash.update(buffer.subarray(0, count));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, after)) {
      throw new Error(`Payload file changed while hashing: ${filePath}`);
    }
    const pathAfter = fs.lstatSync(filePath, { bigint: true });
    if (!pathAfter.isFile()
        || pathAfter.isSymbolicLink()
        || !sameFileIdentity(after, pathAfter)) {
      throw new Error(`Payload file path changed while hashing: ${filePath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  if (total !== expectedSize) throw new Error(`Payload file changed size while hashing: ${filePath}`);
  return hash.digest('hex');
}

export function verifyPythonStandalonePayloadEvidence({ runtimeRoot, platform, bom }) {
  if (!PLATFORM_NAMES.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const resolvedBom = readJson(
    bom,
    'packaging/python-standalone-bom.json',
    'Python standalone BOM',
  );
  const root = path.resolve(runtimeRoot);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe runtime root for Python standalone payload evidence: ${runtimeRoot}`);
  }
  const results = [];
  for (const component of resolvedBom.platforms?.[platform]?.components ?? []) {
    if (component.payloadEvidence === undefined) continue;
    const payloadEvidence = component.payloadEvidence;
    if (!hasExactKeys(payloadEvidence, ['pkgIndex', 'subtreeManifest'])) {
      throw new Error(`Invalid payload evidence contract for ${component.name}`);
    }
    const pkgIndex = payloadEvidence.pkgIndex;
    const subtree = payloadEvidence.subtreeManifest;
    if (!hasExactKeys(pkgIndex, ['path', 'size', 'sha256'])
        || !hasExactKeys(subtree, ['path', 'entryCount', 'algorithm', 'sha256'])
        || !Number.isSafeInteger(pkgIndex.size)
        || pkgIndex.size <= 0
        || !SHA256_PATTERN.test(pkgIndex.sha256)
        || !Number.isSafeInteger(subtree.entryCount)
        || subtree.entryCount <= 0
        || !SHA256_PATTERN.test(subtree.sha256)
        || subtree.algorithm !== 'c-byte-sort-path-tab-size-tab-sha256-lf-v1') {
      throw new Error(`Invalid payload evidence values for ${component.name}`);
    }
    validateEvidenceMemberPath(pkgIndex.path);
    validateEvidenceMemberPath(subtree.path);
    if (!pkgIndex.path.startsWith(`${subtree.path}/`)) {
      throw new Error(`pkgIndex escapes locked subtree for ${component.name}`);
    }
    const pkg = safeRuntimePath(root, pkgIndex.path, 'file');
    if (pkg.stat.size !== pkgIndex.size
        || sha256FileSync(pkg.absolutePath, pkg.stat.size) !== pkgIndex.sha256) {
      throw new Error(`pkgIndex payload evidence mismatch for ${component.name}`);
    }
    const subtreeRoot = safeRuntimePath(root, subtree.path, 'directory').absolutePath;
    const rows = [];
    let totalBytes = 0;
    const visit = (directory) => {
      for (const name of fs.readdirSync(directory)) {
        const absolutePath = path.join(directory, name);
        const stat = fs.lstatSync(absolutePath);
        const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
        validateEvidenceMemberPath(relativePath);
        if (stat.isSymbolicLink()) {
          throw new Error(`Symlink is forbidden in payload subtree: ${relativePath}`);
        }
        if (stat.isDirectory()) {
          visit(absolutePath);
        } else if (stat.isFile()) {
          totalBytes += stat.size;
          if (!Number.isSafeInteger(totalBytes) || totalBytes > 1024 * 1024 * 1024) {
            throw new Error(`Payload subtree size limit exceeded for ${component.name}`);
          }
          rows.push({
            path: relativePath,
            size: stat.size,
            sha256: sha256FileSync(absolutePath, stat.size),
          });
          if (rows.length > 100_000) {
            throw new Error(`Payload subtree entry limit exceeded for ${component.name}`);
          }
        } else {
          throw new Error(`Special file is forbidden in payload subtree: ${relativePath}`);
        }
      }
    };
    visit(subtreeRoot);
    rows.sort((left, right) =>
      Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')));
    const canonical = rows
      .map((row) => `${row.path}\t${row.size}\t${row.sha256}\n`)
      .join('');
    const subtreeSha256 = sha256(Buffer.from(canonical, 'utf8'));
    if (rows.length !== subtree.entryCount || subtreeSha256 !== subtree.sha256) {
      throw new Error(`Payload subtree manifest mismatch for ${component.name}`);
    }
    results.push({
      component: component.name,
      entryCount: rows.length,
      pkgIndexSha256: pkgIndex.sha256,
      subtreeSha256,
    });
  }
  return results;
}

export function stagePythonStandaloneNotices({ runtimeRoot, platform, evidence }) {
  if (!evidence || typeof evidence._stageNoticePlan !== 'function') {
    throw new Error('A loaded Python standalone evidence verifier is required');
  }
  return evidence._stageNoticePlan({ runtimeRoot, platform });
}

function asRecord(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object map`);
  }
  return value;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readVerifiedArchiveSnapshot({
  filePath,
  expectedSha256,
  expectedSize,
  maxBytes = MAX_ORIGIN_ARCHIVE_BYTES,
}) {
  const absolutePath = path.resolve(filePath);
  const pathStat = fs.lstatSync(absolutePath, { bigint: true });
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`Origin archive is not a regular file: ${filePath}`);
  }
  const noFollow = Number.isInteger(fs.constants.O_NOFOLLOW)
    ? fs.constants.O_NOFOLLOW
    : 0;
  let descriptor;
  try {
    descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (noFollow !== 0 && ['EINVAL', 'ENOTSUP'].includes(error?.code)) {
      descriptor = fs.openSync(absolutePath, fs.constants.O_RDONLY);
    } else {
      throw error;
    }
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || !sameFileIdentity(pathStat, before)) {
      throw new Error(`Origin archive changed before snapshot: ${filePath}`);
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size)
        || size <= 0
        || size > maxBytes
        || (expectedSize !== undefined && size !== expectedSize)) {
      throw new Error(`Origin archive size mismatch: ${filePath}`);
    }
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (offset !== bytes.length || !sameFileSnapshot(before, after)) {
      throw new Error(`Origin archive changed while taking snapshot: ${filePath}`);
    }
    if (sha256(bytes) !== expectedSha256) {
      throw new Error(`Origin archive SHA-256 mismatch: ${filePath}`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function withPrivateArchiveSnapshot(bytes, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-mcp-python-origin-'));
  const snapshotPath = path.join(directory, 'archive.snapshot');
  try {
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    const descriptor = fs.openSync(snapshotPath, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, bytes);
      if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return callback(snapshotPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function verifiedOriginMembers(snapshotBytes, entries) {
  const members = new Map();
  withPrivateArchiveSnapshot(snapshotBytes, (snapshotPath) => {
    for (const entry of entries) {
      const bytes = extractArchiveMember({
        archivePath: snapshotPath,
        memberPath: entry.memberPath,
      });
      const bundled = decodeEntry(entry);
      if (!bytes.equals(bundled)) {
        throw new Error(`Origin member ${entry.memberPath} bytes mismatch`);
      }
      members.set(entry, bytes);
    }
  });
  return members;
}

function requireProvenanceRuntime() {
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 24 || typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error(
      'Python standalone provenance verification requires Node.js 24+ with '
      + 'node:zlib.zstdDecompressSync',
    );
  }
}

function collectVerifiedOriginMembers({
  bundle,
  runtimeLock,
  bom,
  metadataArchives,
  sourceArchives,
  requireAll,
}) {
  loadPythonStandaloneEvidence({ bundle, runtimeLock, bom });
  const metadataMappings = asRecord(metadataArchives, 'metadataArchives');
  const sourceMappings = asRecord(sourceArchives, 'sourceArchives');
  const provenanceRequested = requireAll === true
    || Object.keys(metadataMappings).length > 0
    || Object.keys(sourceMappings).length > 0;
  if (provenanceRequested) requireProvenanceRuntime();

  const expectedSourceOrigins = new Map();
  for (const entry of bundle.entries) {
    if (entry.kind === 'source-file' || entry.kind === 'source-archive-member') {
      const existing = expectedSourceOrigins.get(entry.origin.sha256);
      if (existing && !sameOrigin(existing, entry.origin)) {
        throw new Error(`Ambiguous source origin in evidence bundle: ${entry.origin.sha256}`);
      }
      expectedSourceOrigins.set(entry.origin.sha256, entry.origin);
    }
  }

  const memberBytes = new Map();
  const verified = new Set();
  for (const [platform, filePath] of Object.entries(metadataMappings)) {
    if (!PLATFORM_NAMES.includes(platform) || typeof filePath !== 'string') {
      throw new Error(`Unexpected metadata archive mapping: ${platform}`);
    }
    const expected = runtimeLock.python?.metadataAssets?.[platform];
    if (!expected) throw new Error(`Missing locked metadata origin for ${platform}`);
    const compressed = readVerifiedArchiveSnapshot({
      filePath,
      expectedSha256: expected.sha256,
      expectedSize: expected.size,
    });
    let expanded;
    try {
      expanded = zlib.zstdDecompressSync(compressed, {
        maxOutputLength: expected.expandedTarBytes,
      });
    } catch (error) {
      throw new Error(`Metadata zstd decompression failed for ${platform}: ${error.message}`, {
        cause: error,
      });
    }
    if (expanded.length !== expected.expandedTarBytes) {
      throw new Error(`Expanded metadata tar size mismatch for ${platform}`);
    }
    if (sha256(expanded) !== expected.expandedTarSha256) {
      throw new Error(`Expanded tar SHA-256 mismatch for ${platform}`);
    }
    const entries = bundle.entries.filter((entry) =>
      (entry.kind === 'python-json' || entry.kind === 'metadata-file')
      && entry.platforms.includes(platform));
    for (const entry of entries) {
      if (!sameOrigin(entry.origin, expected)) {
        throw new Error(`Metadata evidence origin mismatch for ${platform}:${entry.memberPath}`);
      }
    }
    for (const [entry, bytes] of verifiedOriginMembers(expanded, entries)) {
      memberBytes.set(entry, bytes);
    }
    verified.add(expected.sha256);
  }

  for (const [archiveSha256, filePath] of Object.entries(sourceMappings)) {
    if (!SHA256_PATTERN.test(archiveSha256) || typeof filePath !== 'string') {
      throw new Error(`Unexpected source archive mapping: ${archiveSha256}`);
    }
    if (!expectedSourceOrigins.has(archiveSha256)) {
      throw new Error(`Unreferenced source archive mapping: ${archiveSha256}`);
    }
    const snapshot = readVerifiedArchiveSnapshot({
      filePath,
      expectedSha256: archiveSha256,
    });
    const entries = bundle.entries.filter((entry) =>
      (entry.kind === 'source-file' || entry.kind === 'source-archive-member')
      && entry.origin.sha256 === archiveSha256);
    for (const [entry, bytes] of verifiedOriginMembers(snapshot, entries)) {
      memberBytes.set(entry, bytes);
    }
    verified.add(archiveSha256);
  }

  if (requireAll === true) {
    for (const platform of PLATFORM_NAMES) {
      const expected = runtimeLock.python?.metadataAssets?.[platform];
      if (!expected || !verified.has(expected.sha256)) {
        throw new Error(`Missing required metadata origin archive for ${platform}`);
      }
    }
    for (const archiveSha256 of expectedSourceOrigins.keys()) {
      if (!verified.has(archiveSha256)) {
        throw new Error(`Missing required source origin archive: ${archiveSha256}`);
      }
    }
  }
  return {
    memberBytes,
    summary: {
      entries: bundle.entries.length,
      originsVerified: verified.size,
      platforms: [...PLATFORM_NAMES],
    },
  };
}

export function verifyPythonStandaloneEvidenceOrigins(options = {}) {
  const bundle = readJson(
    options.bundle,
    'packaging/evidence/python-standalone/evidence-bundle.json',
    'evidence bundle',
  );
  const runtimeLock = readJson(
    options.runtimeLock,
    'packaging/runtime-lock.json',
    'runtime lock',
  );
  const bom = readJson(
    options.bom,
    'packaging/python-standalone-bom.json',
    'Python standalone BOM',
  );
  return collectVerifiedOriginMembers({
    bundle,
    runtimeLock,
    bom,
    metadataArchives: options.metadataArchives,
    sourceArchives: options.sourceArchives,
    requireAll: options.requireAll,
  }).summary;
}

function extractArchiveMember({ archivePath, memberPath }) {
  validateEvidenceMemberPath(memberPath);
  const tarExecutable = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : '/usr/bin/tar';
  const environment = process.platform === 'win32'
    ? {
      PATH: path.dirname(tarExecutable),
      SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
    }
    : { PATH: '/usr/bin:/bin' };
  const result = spawnSync(tarExecutable, ['-xOf', path.resolve(archivePath), memberPath], {
    encoding: null,
    env: environment,
    maxBuffer: MAX_ENTRY_BYTES + 64 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Could not read source archive member ${memberPath}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr ?? '').trim();
    throw new Error(`Could not read source archive member ${memberPath}: ${stderr}`);
  }
  return Buffer.from(result.stdout);
}

export function refreshPythonStandaloneEvidenceBundle(options = {}) {
  for (const forbidden of ['metadataRoots', 'readSourceArchiveMember']) {
    if (Object.hasOwn(options, forbidden)) {
      throw new Error(`Unverified provenance option is forbidden: ${forbidden}`);
    }
  }
  const bundle = readJson(
    options.bundle,
    'packaging/evidence/python-standalone/evidence-bundle.json',
    'evidence bundle',
  );
  const runtimeLock = readJson(
    options.runtimeLock,
    'packaging/runtime-lock.json',
    'runtime lock',
  );
  const bom = readJson(
    options.bom,
    'packaging/python-standalone-bom.json',
    'Python standalone BOM',
  );
  const { memberBytes } = collectVerifiedOriginMembers({
    bundle,
    runtimeLock,
    bom,
    metadataArchives: options.metadataArchives,
    sourceArchives: options.sourceArchives,
    requireAll: true,
  });
  const refreshedEntries = bundle.entries.map((entry) => {
    const bytes = memberBytes.get(entry);
    if (!bytes) throw new Error(`Missing verified origin member: ${entry.memberPath}`);
    if (bytes.length !== entry.size) {
      throw new Error(`Refreshed evidence size mismatch for ${entry.memberPath}`);
    }
    if (sha256(bytes) !== entry.sha256) {
      throw new Error(`Refreshed evidence SHA-256 mismatch for ${entry.memberPath}`);
    }
    return {
      ...entry,
      size: bytes.length,
      sha256: sha256(bytes),
      encoding: 'gzip-base64',
      content: chunkPythonStandaloneEvidenceContent(
        encodePythonStandaloneEvidenceContent(bytes),
      ),
    };
  });
  const refreshed = { ...bundle, entries: refreshedEntries };
  loadPythonStandaloneEvidence({ bundle: refreshed, runtimeLock, bom });
  return refreshed;
}

export function loadPythonStandaloneEvidence(options = {}) {
  const bundle = readJson(
    options.bundle,
    'packaging/evidence/python-standalone/evidence-bundle.json',
    'evidence bundle',
  );
  const runtimeLock = readJson(
    options.runtimeLock,
    'packaging/runtime-lock.json',
    'runtime lock',
  );
  const bom = readJson(
    options.bom,
    'packaging/python-standalone-bom.json',
    'Python standalone BOM',
  );
  if (bundle.schemaVersion !== 1
      || bundle.format !== 'python-standalone-evidence-gzip-base64-v1'
      || !Array.isArray(bundle.entries)) {
    throw new Error('Invalid Python standalone evidence bundle header');
  }
  if (!hasExactKeys(bundle, ['schemaVersion', 'format', 'reviewedOverlays', 'entries'])
      || bundle.entries.length === 0
      || bundle.entries.length > MAX_BUNDLE_ENTRIES) {
    throw new Error('Invalid Python standalone evidence bundle shape or entry count');
  }
  const overlay = bundle.reviewedOverlays?.cpythonLicense;
  const tclLibraryOverlay = bundle.reviewedOverlays?.tclLibraryPaths;
  const metadataLicensePathExclusions =
    bundle.reviewedOverlays?.metadataLicensePathExclusions;
  if (!hasExactKeys(bundle.reviewedOverlays, [
    'cpythonLicense',
    'tclLibraryPaths',
    'metadataLicensePathExclusions',
  ])
      || !hasExactKeys(overlay, ['observed', 'normalized', 'rationale'])
      || overlay.normalized !== CPYTHON_LICENSE_OVERLAY_V1.normalized
      || overlay.rationale !== CPYTHON_LICENSE_OVERLAY_V1.rationale
      || !Array.isArray(overlay.observed)
      || overlay.observed.length !== CPYTHON_LICENSE_OVERLAY_V1.observed.length
      || overlay.observed.some((value, index) =>
        value !== CPYTHON_LICENSE_OVERLAY_V1.observed[index])) {
    throw new Error('Invalid reviewed CPython license overlay');
  }
  if (!jsonEquivalent(tclLibraryOverlay, TCL_LIBRARY_PATHS_OVERLAY_V1)) {
    throw new Error('Invalid reviewed Tcl library path overlay');
  }
  if (!hasExactKeys(metadataLicensePathExclusions, PLATFORM_NAMES)) {
    throw new Error('Invalid reviewed metadata license path exclusion overlay');
  }
  for (const platform of PLATFORM_NAMES) {
    const exclusions = metadataLicensePathExclusions[platform];
    if (!Array.isArray(exclusions)) {
      throw new Error(`Invalid metadata license path exclusions for ${platform}`);
    }
    const paths = new Set();
    for (const exclusion of exclusions) {
      if (!hasExactKeys(exclusion, ['path', 'disposition', 'rationale'])
          || exclusion.disposition !== 'external-system-upstream-metadata-missing-member'
          || typeof exclusion.rationale !== 'string'
          || exclusion.rationale.trim().length < 20
          || typeof exclusion.path !== 'string'
          || !exclusion.path.startsWith('licenses/')) {
        throw new Error(`Invalid metadata license path exclusion for ${platform}`);
      }
      validateEvidenceMemberPath(`python/${exclusion.path}`);
      if (paths.has(exclusion.path)) {
        throw new Error(`Duplicate metadata license path exclusion for ${platform}`);
      }
      paths.add(exclusion.path);
    }
  }

  const indexed = new Map();
  const portableIdentities = new Map();
  let declaredTotalBytes = 0;
  for (const entry of bundle.entries) {
    validateEntryShape(entry);
    declaredTotalBytes += entry.size;
    if (!Number.isSafeInteger(declaredTotalBytes)
        || declaredTotalBytes > MAX_TOTAL_ENTRY_BYTES) {
      throw new Error('Python standalone evidence bundle total size limit exceeded');
    }
  }
  for (const entry of bundle.entries) {
    const bytes = decodeEntry(entry);
    for (const platform of entry.platforms) {
      const key = evidenceKey(platform, entry.kind, entry.memberPath);
      if (indexed.has(key)) {
        throw new Error(`Duplicate evidence entry for ${platform}:${entry.kind}:${entry.memberPath}`);
      }
      const portableKey = evidenceKey(
        platform,
        entry.kind.toLowerCase(),
        entry.memberPath.toLowerCase(),
      );
      if (portableIdentities.has(portableKey)) {
        throw new Error(
          `Portable duplicate evidence entry for ${platform}:${entry.kind}:${entry.memberPath}`,
        );
      }
      portableIdentities.set(portableKey, key);
      indexed.set(key, { bytes, entry });
    }
  }

  const sourceOriginsBySha = new Map();
  for (const bomPlatform of Object.values(bom.platforms ?? {})) {
    for (const component of bomPlatform.components ?? []) {
      const candidate = component.source;
      if (candidate?.kind !== 'archive') continue;
      const origin = { url: candidate.url, sha256: candidate.sha256 };
      if (!isSecureArchiveOrigin(origin)) {
        throw new Error(`Invalid BOM source archive origin for ${component.name}`);
      }
      const existing = sourceOriginsBySha.get(origin.sha256);
      if (existing && !sameOrigin(existing, origin)) {
        throw new Error(`Ambiguous BOM source archive origin for ${origin.sha256}`);
      }
      sourceOriginsBySha.set(origin.sha256, origin);
    }
  }

  const verifyEvidenceRecord = (platform, record, { content } = {}) => {
    if (!PLATFORM_NAMES.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
    validateBomEvidenceRecord(record);
    if (record.kind === 'payload-file') {
      if (content === undefined) {
        throw new Error(`Payload evidence content is required for ${record.path}`);
      }
      const bytes = Buffer.from(content);
      if (bytes.length === 0 || bytes.length > MAX_ENTRY_BYTES) {
        throw new Error(`Payload evidence size limit exceeded for ${record.path}`);
      }
      if (sha256(bytes) !== record.sha256) {
        throw new Error(`Payload evidence SHA-256 mismatch for ${record.path}`);
      }
      return bytes;
    }
    const match = indexed.get(evidenceKey(platform, record.kind, record.path));
    if (!match) {
      throw new Error(`Missing bundled evidence for ${platform}:${record.kind}:${record.path}`);
    }
    let expectedOrigin;
    if (record.kind === 'metadata-file') {
      expectedOrigin = runtimeLock.python.metadataAssets[platform];
    } else if (record.kind === 'source-archive-member') {
      expectedOrigin = sourceOriginsBySha.get(record.archiveSha256);
    } else {
      expectedOrigin = sourceOriginsBySha.get(match.entry.origin.sha256);
    }
    if (!sameOrigin(match.entry.origin, expectedOrigin)) {
      throw new Error(`Evidence origin mismatch for ${platform}:${record.path}`);
    }
    if (record.kind === 'source-archive-member'
        && record.archiveSha256 !== match.entry.origin.sha256) {
      throw new Error(`Evidence archive SHA-256 mismatch for ${platform}:${record.path}`);
    }
    if (recordSha256(record) !== match.entry.sha256) {
      throw new Error(`BOM evidence SHA-256 mismatch for ${platform}:${record.path}`);
    }
    return match.bytes;
  };

  const pythonJson = {};
  const licenseProjection = { cpython: {} };
  const componentProjection = { tclLibraries: {} };
  const noticePlans = Object.fromEntries(PLATFORM_NAMES.map((platform) => [platform, new Map()]));
  for (const platform of PLATFORM_NAMES) {
    const metadataAsset = runtimeLock.python?.metadataAssets?.[platform];
    const bomPlatform = bom.platforms?.[platform];
    if (!metadataAsset || !bomPlatform) {
      throw new Error(`Missing locked Python metadata for ${platform}`);
    }
    const pythonEntry = indexed.get(evidenceKey(platform, 'python-json', 'python/PYTHON.json'));
    if (!pythonEntry) {
      throw new Error(`Missing bundled PYTHON.json for ${platform}`);
    }
    if (!sameOrigin(pythonEntry.entry.origin, metadataAsset)
        || pythonEntry.entry.sha256 !== metadataAsset.pythonJsonSha256
        || pythonEntry.entry.sha256 !== bomPlatform.metadataSource?.pythonJson?.sha256) {
      throw new Error(`PYTHON.json provenance mismatch for ${platform}`);
    }
    pythonJson[platform] = JSON.parse(pythonEntry.bytes.toString('utf8'));
    const metadataSource = bomPlatform.metadataSource;
    if (!sameOrigin(metadataSource, metadataAsset)
        || !Number.isSafeInteger(metadataAsset.size)
        || metadataAsset.size <= 0
        || metadataAsset.size > MAX_ORIGIN_ARCHIVE_BYTES
        || metadataSource?.size !== metadataAsset.size
        || !Number.isSafeInteger(metadataAsset.expandedTarBytes)
        || metadataAsset.expandedTarBytes <= 0
        || metadataAsset.expandedTarBytes > MAX_EXPANDED_METADATA_TAR_BYTES
        || !SHA256_PATTERN.test(metadataAsset.expandedTarSha256)
        || metadataSource?.expandedTarBytes !== metadataAsset.expandedTarBytes
        || metadataSource?.expandedTarSha256 !== metadataAsset.expandedTarSha256) {
      throw new Error(`Python metadata source mismatch for ${platform}`);
    }
    if (pythonJson[platform].target_triple !== metadataSource?.targetTriple
        || !Array.isArray(metadataSource?.buildOptions)
        || metadataSource.buildOptions.length === 0
        || pythonJson[platform].build_options !== metadataSource.buildOptions.join('+')
        || metadataSource.pythonJson?.path !== 'python/PYTHON.json') {
      throw new Error(`PYTHON.json target/build options mismatch for ${platform}`);
    }
    const observedLicenses = pythonJson[platform].licenses;
    if (!Array.isArray(observedLicenses)
        || observedLicenses.length !== overlay.observed.length
        || observedLicenses.some((value, index) => value !== overlay.observed[index])) {
      throw new Error(`Observed CPython license metadata mismatch for ${platform}`);
    }
    const cpythonComponent = (bomPlatform.components ?? [])
      .find(({ name }) => name === 'cpython');
    if (!cpythonComponent
        || cpythonComponent.licenseDeclared !== overlay.normalized) {
      throw new Error(`Reviewed CPython license projection mismatch for ${platform}`);
    }
    const componentNames = new Map();
    for (const component of bomPlatform.components ?? []) {
      if (componentNames.has(component.name)) {
        throw new Error(`Duplicate Python standalone BOM component for ${platform}: ${component.name}`);
      }
      componentNames.set(component.name, component);
    }
    const expectedTclProjection = tclLibraryOverlay.platforms[platform];
    const observedTclPaths = pythonJson[platform].tcl_library_paths;
    if (!jsonEquivalent(observedTclPaths, expectedTclProjection.observed)) {
      throw new Error(`Observed Tcl library path partition mismatch for ${platform}`);
    }
    const partitionedPaths = new Set();
    const partitionedComponents = new Set();
    for (const expectedComponent of expectedTclProjection.components) {
      if (partitionedComponents.has(expectedComponent.name)) {
        throw new Error(`Duplicate reviewed Tcl component for ${platform}: ${expectedComponent.name}`);
      }
      partitionedComponents.add(expectedComponent.name);
      const actualComponent = componentNames.get(expectedComponent.name);
      if (!actualComponent || actualComponent.version !== expectedComponent.version) {
        throw new Error(
          `Missing or mismatched reviewed Tcl component for ${platform}: ${expectedComponent.name}`,
        );
      }
      for (const libraryPath of expectedComponent.paths) {
        validateEvidenceMemberPath(libraryPath);
        if (partitionedPaths.has(libraryPath)) {
          throw new Error(`Duplicate reviewed Tcl library path for ${platform}: ${libraryPath}`);
        }
        partitionedPaths.add(libraryPath);
      }
    }
    if (partitionedPaths.size !== observedTclPaths.length
        || observedTclPaths.some((libraryPath) => !partitionedPaths.has(libraryPath))) {
      throw new Error(`Incomplete reviewed Tcl library path partition for ${platform}`);
    }
    componentProjection.tclLibraries[platform] = Object.freeze({
      observed: Object.freeze([...expectedTclProjection.observed]),
      components: Object.freeze(expectedTclProjection.components.map((component) => Object.freeze({
        name: component.name,
        version: component.version,
        paths: Object.freeze([...component.paths]),
      }))),
    });

    const exclusionsByPath = new Map(metadataLicensePathExclusions[platform]
      .map((exclusion) => [exclusion.path, exclusion]));
    const usedExclusions = new Set();
    const verifyRawLicensePath = (rawPath, { allowMissingSystemLink = false } = {}) => {
      if (typeof rawPath !== 'string' || !rawPath.startsWith('licenses/')) {
        throw new Error(`Invalid PYTHON.json license path for ${platform}: ${String(rawPath)}`);
      }
      const memberPath = validateEvidenceMemberPath(`python/${rawPath}`);
      const match = indexed.get(evidenceKey(platform, 'metadata-file', memberPath));
      if (!match && allowMissingSystemLink && exclusionsByPath.has(rawPath)) {
        usedExclusions.add(rawPath);
        return memberPath;
      }
      if (!match || !sameOrigin(match.entry.origin, metadataAsset)) {
        throw new Error(`Missing bundled PYTHON.json license path for ${platform}: ${rawPath}`);
      }
      return memberPath;
    };
    const cpythonLicenseMember = verifyRawLicensePath(pythonJson[platform].license_path);
    if (!(cpythonComponent.licenseEvidence ?? []).some((record) =>
      record.kind === 'metadata-file' && record.path === cpythonLicenseMember)) {
      throw new Error(`CPython license_path does not match BOM evidence for ${platform}`);
    }
    const extensionGroups = pythonJson[platform].build_info?.extensions ?? {};
    if (!extensionGroups || typeof extensionGroups !== 'object' || Array.isArray(extensionGroups)) {
      throw new Error(`Invalid PYTHON.json extension metadata for ${platform}`);
    }
    for (const variants of Object.values(extensionGroups)) {
      if (!Array.isArray(variants)) {
        throw new Error(`Invalid PYTHON.json extension variants for ${platform}`);
      }
      for (const variant of variants) {
        if (variant.license_paths === undefined) continue;
        if (!Array.isArray(variant.license_paths)
            || new Set(variant.license_paths).size !== variant.license_paths.length) {
          throw new Error(`Invalid or duplicate PYTHON.json license_paths for ${platform}`);
        }
        const allowMissingSystemLink = Array.isArray(variant.links)
          && variant.links.length > 0
          && variant.links.every((link) => link?.system === true);
        for (const rawPath of variant.license_paths) {
          verifyRawLicensePath(rawPath, { allowMissingSystemLink });
        }
      }
    }
    if (usedExclusions.size !== exclusionsByPath.size) {
      throw new Error(`Unused metadata license path exclusion for ${platform}`);
    }
    licenseProjection.cpython[platform] = Object.freeze({
      observed: Object.freeze([...observedLicenses]),
      normalized: overlay.normalized,
      rationale: overlay.rationale,
    });

    for (const component of bomPlatform.components ?? []) {
      if (!Object.hasOwn(component, 'evidenceOrigins')
          || !Array.isArray(component.evidenceOrigins)) {
        throw new Error(
          `Component evidenceOrigins is required for ${platform}:${component.name}`,
        );
      }
      const allowedOrigins = new Map();
      for (const origin of component.evidenceOrigins) {
        if (!isSecureArchiveOrigin(origin)) {
          throw new Error(`Invalid component evidenceOrigins for ${platform}:${component.name}`);
        }
        const key = originKey(origin);
        if (allowedOrigins.has(key)) {
          throw new Error(`Duplicate component evidenceOrigins for ${platform}:${component.name}`);
        }
        allowedOrigins.set(key, origin);
      }
      const usedOrigins = new Set();
      for (const record of component.licenseEvidence ?? []) {
        validateBomEvidenceRecord(record);
        if (BUNDLED_KINDS.has(record.kind)) {
          const bytes = verifyEvidenceRecord(platform, record);
          const match = indexed.get(evidenceKey(platform, record.kind, record.path));
          const key = originKey(match.entry.origin);
          if (!allowedOrigins.has(key)) {
            throw new Error(
              `Bundle origin is not authorized by component evidenceOrigins for `
              + `${platform}:${component.name}:${record.path}`,
            );
          }
          usedOrigins.add(key);
          const payloadPath = noticePayloadPath(platform, record);
          const existing = noticePlans[platform].get(payloadPath.toLowerCase());
          const item = {
            bytes,
            payloadPath,
            sha256: recordSha256(record),
            size: bytes.length,
          };
          if (existing && (existing.payloadPath !== payloadPath
              || existing.sha256 !== item.sha256
              || !existing.bytes.equals(item.bytes))) {
            throw new Error(`Conflicting Python standalone notice destination: ${payloadPath}`);
          }
          noticePlans[platform].set(payloadPath.toLowerCase(), item);
        }
      }
      if (usedOrigins.size !== allowedOrigins.size) {
        throw new Error(`Unused component evidenceOrigins for ${platform}:${component.name}`);
      }
    }
  }

  const frozenPlans = Object.fromEntries(PLATFORM_NAMES.map((platform) => [
    platform,
    [...noticePlans[platform].values()].sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.payloadPath, 'utf8'),
        Buffer.from(right.payloadPath, 'utf8'),
      )),
  ]));

  const payloadRecordForEvidence = (platform, record) => {
    if (!PLATFORM_NAMES.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
    if (!BUNDLED_KINDS.has(record?.kind)) {
      throw new Error(`Only bundled license evidence can become a payload record: ${record?.kind}`);
    }
    verifyEvidenceRecord(platform, record);
    const payloadPath = noticePayloadPath(platform, record);
    const planItem = noticePlans[platform].get(payloadPath.toLowerCase());
    if (!planItem
        || planItem.payloadPath !== payloadPath
        || planItem.sha256 !== recordSha256(record)) {
      throw new Error(`Evidence record is not referenced by the ${platform} BOM: ${record.path}`);
    }
    return { kind: 'payload-file', path: payloadPath, sha256: planItem.sha256 };
  };

  const verifyStagedPythonStandaloneNotices = ({ runtimeRoot, platform }) => {
    if (!PLATFORM_NAMES.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
    return verifyNoticePlan(runtimeRoot, platform, frozenPlans[platform]);
  };

  const _stageNoticePlan = ({ runtimeRoot, platform }) => {
    if (!PLATFORM_NAMES.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
    const root = path.resolve(runtimeRoot);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Unsafe runtime root for Python standalone notices: ${runtimeRoot}`);
    }
    const licenses = path.join(root, 'licenses');
    const parent = path.join(licenses, 'python-standalone');
    ensureDirectoryNoSymlink(licenses);
    ensureDirectoryNoSymlink(parent);
    const target = path.join(parent, platform);
    if (fs.existsSync(target)) {
      return verifyNoticePlan(root, platform, frozenPlans[platform]);
    }

    const temporary = fs.mkdtempSync(path.join(parent, `.${platform}.tmp-`));
    try {
      for (const item of frozenPlans[platform]) {
        const payloadPrefix = `licenses/python-standalone/${platform}/`;
        if (!item.payloadPath.startsWith(payloadPrefix)) {
          throw new Error(`Notice payload path is outside its platform root: ${item.payloadPath}`);
        }
        const relative = item.payloadPath.slice(payloadPrefix.length).split('/').join(path.sep);
        const destination = path.join(temporary, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
        const descriptor = fs.openSync(destination, 'wx', 0o644);
        try {
          fs.writeFileSync(descriptor, item.bytes);
          if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o644);
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
      }
      fs.renameSync(temporary, target);
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      if (fs.existsSync(target)) {
        return verifyNoticePlan(root, platform, frozenPlans[platform]);
      }
      throw error;
    }
    return verifyNoticePlan(root, platform, frozenPlans[platform]);
  };

  return Object.freeze({
    _stageNoticePlan,
    componentProjection: Object.freeze({
      tclLibraries: Object.freeze(componentProjection.tclLibraries),
    }),
    licenseProjection: Object.freeze({
      cpython: Object.freeze(licenseProjection.cpython),
    }),
    payloadRecordForEvidence,
    pythonJson: Object.freeze(pythonJson),
    verifyStagedPythonStandaloneNotices,
    verifyEvidenceRecord,
  });
}

const CLI_HELP = `Usage:
  node scripts/package/lib/python-standalone-evidence.mjs verify [--bundle PATH] [--runtime-lock PATH] [--bom PATH] [--metadata-archive PLATFORM=PATH]... [--source-archive SHA256=PATH]...
  node scripts/package/lib/python-standalone-evidence.mjs refresh [--bundle PATH] [--runtime-lock PATH] [--bom PATH] --metadata-archive PLATFORM=PATH... --source-archive SHA256=PATH...

Normal verify performs no network access. Archive arguments add local provenance verification.
Refresh writes deterministic bundle JSON to stdout; it never downloads or overwrites the repository bundle.
`;

function parseCliMapping(value, label) {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`${label} must use KEY=PATH`);
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function parseCliOptions(argv) {
  const options = {
    metadataArchives: {},
    sourceArchives: {},
    requireAll: false,
  };
  const takeValue = (index, flag) => {
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    return argv[index + 1];
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--require-origin-archives') {
      options.requireAll = true;
      continue;
    }
    if (['--bundle', '--runtime-lock', '--bom'].includes(flag)) {
      const key = flag === '--runtime-lock' ? 'runtimeLock' : flag.slice(2);
      if (options[key] !== undefined) throw new Error(`Duplicate option: ${flag}`);
      options[key] = takeValue(index, flag);
      index += 1;
      continue;
    }
    const mappingTargets = {
      '--metadata-archive': 'metadataArchives',
      '--source-archive': 'sourceArchives',
    };
    const target = mappingTargets[flag];
    if (target) {
      const [key, value] = parseCliMapping(takeValue(index, flag), flag);
      if (Object.hasOwn(options[target], key)) {
        throw new Error(`Duplicate ${flag} mapping: ${key}`);
      }
      options[target][key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

export function pythonStandaloneEvidenceCli(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { exitCode: 0, stdout: CLI_HELP, stderr: '' };
  }
  if (argv[0] === 'verify') {
    try {
      const options = parseCliOptions(argv);
      const summary = verifyPythonStandaloneEvidenceOrigins(options);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify({
          command: 'verify',
          ...summary,
        }, null, 2)}\n`,
        stderr: '',
      };
    } catch (error) {
      return { exitCode: 1, stdout: '', stderr: `${error.message}\n` };
    }
  }
  if (argv[0] === 'refresh') {
    try {
      const options = parseCliOptions(argv);
      const refreshed = refreshPythonStandaloneEvidenceBundle(options);
      return {
        exitCode: 0,
        stdout: `${JSON.stringify(refreshed, null, 2)}\n`,
        stderr: '',
      };
    } catch (error) {
      return { exitCode: 1, stdout: '', stderr: `${error.message}\n` };
    }
  }
  return { exitCode: 2, stdout: '', stderr: `${CLI_HELP}\nUnknown command: ${argv[0]}\n` };
}

if (process.argv[1]
    && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = pythonStandaloneEvidenceCli();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
