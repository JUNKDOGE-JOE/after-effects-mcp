import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { crc32, createGunzip, inflateRawSync } from 'node:zlib';

const MIB = 1024 * 1024;

export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * MIB,
  maxComponentBytes: 64,
  maxDecompressedBytes: 256 * MIB,
  maxDepth: 16,
  maxEntries: 10_000,
  maxEntryBytes: 128 * MIB,
  maxPathBytes: 180,
  maxSymlinks: 16,
  maxTotalBytes: 256 * MIB,
});

const EXACT_LIMIT_KEYS = Object.freeze([
  'expectedArchiveBytes',
  'expectedCanonicalEntryCount',
  'expectedDecompressedBytes',
  'expectedManifestSha256',
  'expectedMaxEntryBytes',
  'expectedRawEntryCount',
  'expectedRegularBytes',
  'expectedSymlinkCount',
]);

function unsafe(message, cause) {
  const error = new Error(`unsafe archive: ${message}`, cause ? { cause } : undefined);
  error.code = 'UNSAFE_RUNTIME_ARCHIVE';
  return error;
}

function resolveLimits(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw unsafe('limits must be an object');
  }
  const allowed = new Set([...Object.keys(DEFAULT_ARCHIVE_LIMITS), ...EXACT_LIMIT_KEYS]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) throw unsafe(`unknown archive limit key: ${name}`);
  }
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...overrides };
  for (const name of Object.keys(DEFAULT_ARCHIVE_LIMITS)) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0) {
      throw unsafe(`${name} must be a positive safe integer`);
    }
  }
  for (const name of EXACT_LIMIT_KEYS.filter((candidate) => candidate !== 'expectedManifestSha256')) {
    if (limits[name] !== undefined && (!Number.isSafeInteger(limits[name]) || limits[name] < 0)) {
      throw unsafe(`${name} must be a non-negative safe integer`);
    }
  }
  if (
    limits.expectedManifestSha256 !== undefined
    && !/^[a-f0-9]{64}$/.test(limits.expectedManifestSha256)
  ) {
    throw unsafe('expectedManifestSha256 must be a lowercase SHA-256 digest');
  }
  return limits;
}

function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

function readAsciiField(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  const nul = field.indexOf(0);
  const end = nul === -1 ? field.length : nul;
  for (let index = 0; index < end; index += 1) {
    if (field[index] < 0x20 || field[index] > 0x7e) {
      throw unsafe(`${label} contains non-ASCII or control bytes`);
    }
  }
  if (nul !== -1) {
    for (let index = nul + 1; index < field.length; index += 1) {
      if (field[index] !== 0 && (field[index] < 0x20 || field[index] > 0x7e)) {
        throw unsafe(`${label} has non-printable padding after its NUL terminator`);
      }
    }
  }
  return field.toString('ascii', 0, end);
}

function readOctalField(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) throw unsafe(`${label} uses unsupported base-256 encoding`);
  const text = field.toString('ascii').replace(/\0[\0 ]*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) throw unsafe(`${label} is not canonical octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw unsafe(`${label} exceeds the safe integer range`);
  return value;
}

function parseTarHeader(header, limits) {
  const expectedChecksum = readOctalField(header, 148, 8, 'tar checksum');
  let actualChecksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actualChecksum !== expectedChecksum) {
    throw unsafe(`tar checksum mismatch: expected ${expectedChecksum}, received ${actualChecksum}`);
  }
  if (
    !header.subarray(257, 263).equals(Buffer.from('ustar\0', 'ascii'))
    || !header.subarray(263, 265).equals(Buffer.from('00', 'ascii'))
  ) {
    throw unsafe('only strict POSIX ustar headers are supported');
  }

  const name = readAsciiField(header, 0, 100, 'tar name');
  const prefix = readAsciiField(header, 345, 155, 'tar prefix');
  const archivePath = prefix ? `${prefix}/${name}` : name;
  const typeFlag = String.fromCharCode(header[156]);
  const size = readOctalField(header, 124, 12, 'tar size');
  const mode = readOctalField(header, 100, 8, 'tar mode');
  readOctalField(header, 108, 8, 'tar uid');
  readOctalField(header, 116, 8, 'tar gid');
  readOctalField(header, 136, 12, 'tar mtime');
  if ((mode & ~0o777) !== 0) throw unsafe(`tar entry has dangerous mode bits: ${archivePath}`);
  if (size > limits.maxEntryBytes) {
    throw unsafe(`entry exceeds maxEntryBytes (${size} > ${limits.maxEntryBytes}): ${archivePath}`);
  }

  if (typeFlag === '0' || typeFlag === '\0') {
    return { path: archivePath, size, type: 'file' };
  }
  if (typeFlag === '5') {
    if (size !== 0) throw unsafe(`directory has non-zero size: ${archivePath}`);
    return { path: archivePath, type: 'directory' };
  }
  if (typeFlag === '2') {
    if (size !== 0) throw unsafe(`symlink has non-zero size: ${archivePath}`);
    return {
      path: archivePath,
      target: readAsciiField(header, 157, 100, 'tar linkname'),
      type: 'symlink',
    };
  }
  if (typeFlag === '1') throw unsafe(`hardlinks are not supported: ${archivePath}`);
  throw unsafe(`special or unsupported tar type ${JSON.stringify(typeFlag)}: ${archivePath}`);
}

async function inspectUstarGzip(handle, limits) {
  const entries = [];
  let decompressedBytes = 0;
  let pending = Buffer.alloc(0);
  let remainingEntryBytes = 0;
  let zeroBlocks = 0;
  let ended = false;
  const input = handle.createReadStream({ autoClose: false, start: 0 });
  const gunzip = createGunzip();
  input.pipe(gunzip);

  try {
    for await (const chunk of gunzip) {
      decompressedBytes += chunk.length;
      if (decompressedBytes > limits.maxDecompressedBytes) {
        throw unsafe(
          `decompressed stream exceeds maxDecompressedBytes (${limits.maxDecompressedBytes})`,
        );
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

      while (pending.length > 0) {
        if (ended) {
          if (!isZeroBlock(pending)) throw unsafe('non-zero data follows the tar terminator');
          pending = Buffer.alloc(0);
          break;
        }
        if (remainingEntryBytes > 0) {
          const consumed = Math.min(remainingEntryBytes, pending.length);
          pending = pending.subarray(consumed);
          remainingEntryBytes -= consumed;
          continue;
        }
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (isZeroBlock(header)) {
          zeroBlocks += 1;
          if (zeroBlocks === 2) ended = true;
          continue;
        }
        if (zeroBlocks !== 0) throw unsafe('non-zero tar header follows an end marker');
        const entry = parseTarHeader(header, limits);
        entries.push(entry);
        if (entries.length > limits.maxEntries) {
          throw unsafe(`entry count exceeds maxEntries (${limits.maxEntries})`);
        }
        remainingEntryBytes = Math.ceil((entry.size ?? 0) / 512) * 512;
      }
    }
  } catch (error) {
    if (error?.code === 'UNSAFE_RUNTIME_ARCHIVE') throw error;
    throw unsafe(`cannot decode strict ustar-gzip: ${error.message}`, error);
  } finally {
    input.destroy();
    gunzip.destroy();
  }

  if (!ended || zeroBlocks < 2 || remainingEntryBytes !== 0 || pending.length !== 0) {
    throw unsafe('truncated tar stream or missing two-block terminator');
  }
  return { decompressedBytes, entries };
}

function assertBufferRange(buffer, offset, length, label) {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset + length > buffer.length
  ) {
    throw unsafe(`truncated or overflowing ZIP ${label}`);
  }
}

function readZipAscii(buffer, offset, length, label) {
  assertBufferRange(buffer, offset, length, label);
  const value = buffer.subarray(offset, offset + length);
  for (const byte of value) {
    if (byte < 0x20 || byte > 0x7e) {
      throw unsafe(`ZIP ${label} contains non-ASCII or control bytes`);
    }
  }
  return value.toString('ascii');
}

function validateZipExtra(buffer, offset, length, label) {
  assertBufferRange(buffer, offset, length, `${label} extra field`);
  let cursor = offset;
  const end = offset + length;
  let sawNtfs = false;
  while (cursor < end) {
    assertBufferRange(buffer, cursor, 4, `${label} extra header`);
    const identifier = buffer.readUInt16LE(cursor);
    const dataLength = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    assertBufferRange(buffer, cursor, dataLength, `${label} extra data`);
    if (identifier !== 0x000a || dataLength !== 32 || sawNtfs) {
      throw unsafe(`unsupported or duplicate ZIP extra field 0x${identifier.toString(16)}`);
    }
    if (
      buffer.readUInt32LE(cursor) !== 0
      || buffer.readUInt16LE(cursor + 4) !== 0x0001
      || buffer.readUInt16LE(cursor + 6) !== 24
    ) {
      throw unsafe(`malformed ZIP NTFS timestamp field in ${label}`);
    }
    sawNtfs = true;
    cursor += dataLength;
  }
  if (cursor !== end) throw unsafe(`malformed ZIP extra fields in ${label}`);
}

function inflateZipEntry(compressed, record, limits) {
  if (record.method === 0) {
    if (record.compressedSize !== record.uncompressedSize) {
      throw unsafe(`stored ZIP entry has mismatched sizes: ${record.name}`);
    }
    return compressed;
  }
  try {
    const inflated = inflateRawSync(compressed, {
      info: true,
      maxOutputLength: Math.max(1, Math.min(limits.maxEntryBytes + 1, record.uncompressedSize + 1)),
    });
    if (inflated.engine.bytesWritten !== compressed.length) {
      throw unsafe(`ZIP deflate payload has trailing bytes: ${record.name}`);
    }
    return inflated.buffer;
  } catch (error) {
    if (error?.code === 'UNSAFE_RUNTIME_ARCHIVE') throw error;
    throw unsafe(`cannot inflate ZIP entry ${record.name}: ${error.message}`, error);
  }
}

function inspectZip(buffer, limits) {
  if (buffer.length < 22) throw unsafe('truncated ZIP end-of-central-directory record');
  const eocdOffset = buffer.length - 22;
  if (buffer.readUInt32LE(eocdOffset) !== 0x06054b50) {
    throw unsafe('ZIP must end with an uncommented EOCD record');
  }
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const commentLength = buffer.readUInt16LE(eocdOffset + 20);
  if (
    diskNumber !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || commentLength !== 0
  ) {
    throw unsafe('multi-disk, ZIP64, or commented ZIP archives are unsupported');
  }
  if (entryCount > limits.maxEntries) {
    throw unsafe(`entry count exceeds maxEntries (${limits.maxEntries})`);
  }
  if (centralOffset + centralSize !== eocdOffset) {
    throw unsafe('ZIP central directory is not contiguous with EOCD');
  }

  const records = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertBufferRange(buffer, cursor, 46, 'central directory header');
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw unsafe(`invalid ZIP central directory signature at entry ${index}`);
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const versionNeeded = buffer.readUInt16LE(cursor + 6);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const fileCommentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const internalAttributes = buffer.readUInt16LE(cursor + 36);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (
      (versionMadeBy >>> 8) !== 0
      || versionNeeded > 20
      || flags !== 0
      || ![0, 8].includes(method)
      || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || fileCommentLength !== 0
      || diskStart !== 0
      || internalAttributes !== 0
      || localOffset === 0xffffffff
    ) {
      throw unsafe(`unsupported ZIP feature at central entry ${index}`);
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw unsafe(`entry exceeds maxEntryBytes: ZIP central entry ${index}`);
    }
    const nameOffset = cursor + 46;
    const extraOffset = nameOffset + nameLength;
    const name = readZipAscii(buffer, nameOffset, nameLength, 'entry name');
    validateZipExtra(buffer, extraOffset, extraLength, `central entry ${name}`);
    const directory = name.endsWith('/');
    if (
      (directory && externalAttributes !== 0x10)
      || (!directory && externalAttributes !== 0x20)
      || (directory && (compressedSize !== 0 || uncompressedSize !== 0 || checksum !== 0))
    ) {
      throw unsafe(`ZIP DOS attributes or directory payload are invalid: ${name}`);
    }
    records.push({
      checksum,
      compressedSize,
      directory,
      localOffset,
      method,
      name,
      uncompressedSize,
      versionNeeded,
    });
    cursor = extraOffset + extraLength + fileCommentLength;
  }
  if (cursor !== eocdOffset) throw unsafe('ZIP central directory size or entry count mismatch');

  const ranges = [];
  const entries = [];
  let regularBytes = 0;
  for (const record of records) {
    assertBufferRange(buffer, record.localOffset, 30, `local header ${record.name}`);
    if (buffer.readUInt32LE(record.localOffset) !== 0x04034b50) {
      throw unsafe(`invalid ZIP local header signature: ${record.name}`);
    }
    const versionNeeded = buffer.readUInt16LE(record.localOffset + 4);
    const flags = buffer.readUInt16LE(record.localOffset + 6);
    const method = buffer.readUInt16LE(record.localOffset + 8);
    const checksum = buffer.readUInt32LE(record.localOffset + 14);
    const compressedSize = buffer.readUInt32LE(record.localOffset + 18);
    const uncompressedSize = buffer.readUInt32LE(record.localOffset + 22);
    const nameLength = buffer.readUInt16LE(record.localOffset + 26);
    const extraLength = buffer.readUInt16LE(record.localOffset + 28);
    const nameOffset = record.localOffset + 30;
    const extraOffset = nameOffset + nameLength;
    const localName = readZipAscii(buffer, nameOffset, nameLength, 'local entry name');
    validateZipExtra(buffer, extraOffset, extraLength, `local entry ${localName}`);
    if (
      versionNeeded !== record.versionNeeded
      || flags !== 0
      || method !== record.method
      || checksum !== record.checksum
      || compressedSize !== record.compressedSize
      || uncompressedSize !== record.uncompressedSize
      || localName !== record.name
    ) {
      throw unsafe(`ZIP central/local metadata mismatch: ${record.name}`);
    }
    const dataOffset = extraOffset + extraLength;
    const dataEnd = dataOffset + record.compressedSize;
    if (dataEnd > centralOffset) throw unsafe(`ZIP local payload overlaps central directory: ${record.name}`);
    ranges.push({ end: dataEnd, start: record.localOffset });

    if (record.directory) {
      entries.push({ path: record.name, type: 'directory' });
      continue;
    }
    const output = inflateZipEntry(buffer.subarray(dataOffset, dataEnd), record, limits);
    if (output.length !== record.uncompressedSize) {
      throw unsafe(`ZIP uncompressed size mismatch: ${record.name}`);
    }
    if ((crc32(output) >>> 0) !== record.checksum) {
      throw unsafe(`ZIP CRC mismatch: ${record.name}`);
    }
    regularBytes += output.length;
    if (!Number.isSafeInteger(regularBytes) || regularBytes > limits.maxTotalBytes) {
      throw unsafe(`regular file bytes exceed maxTotalBytes (${limits.maxTotalBytes})`);
    }
    entries.push({ path: record.name, size: output.length, type: 'file' });
  }

  ranges.sort((left, right) => left.start - right.start);
  let localCursor = 0;
  for (const range of ranges) {
    if (range.start !== localCursor || range.end < range.start) {
      throw unsafe('ZIP local records overlap or contain unreferenced gaps');
    }
    localCursor = range.end;
  }
  if (localCursor !== centralOffset) {
    throw unsafe('ZIP contains unreferenced data before its central directory');
  }
  return { decompressedBytes: regularBytes, entries };
}

const PORTABLE_COMPONENT = /^[A-Za-z0-9._@+-]+$/;
const WINDOWS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

function validateComponent(component, limits, label) {
  if (
    !component
    || component === '.'
    || component === '..'
    || !PORTABLE_COMPONENT.test(component)
    || component.endsWith('.')
    || WINDOWS_DEVICE.test(component)
  ) {
    throw unsafe(`${label} has a non-portable component: ${JSON.stringify(component)}`);
  }
  if (Buffer.byteLength(component, 'ascii') > limits.maxComponentBytes) {
    throw unsafe(`${label} component exceeds maxComponentBytes: ${component}`);
  }
}

function normalizeMemberPath(entry, expectedRoot, limits) {
  if (typeof entry.path !== 'string' || entry.path.length === 0) {
    throw unsafe('entry path must be a non-empty string');
  }
  let value = entry.path;
  if (entry.type === 'directory' && value.endsWith('/')) value = value.slice(0, -1);
  if (
    !value
    || value.startsWith('/')
    || value.includes('\\')
    || value.includes(':')
    || Buffer.byteLength(value, 'utf8') !== value.length
    || !/^[A-Za-z0-9._@+\/-]+$/.test(value)
  ) {
    throw unsafe(`non-portable archive path: ${JSON.stringify(entry.path)}`);
  }
  const components = value.split('/');
  for (const component of components) validateComponent(component, limits, 'archive path');
  if (components[0] !== expectedRoot) {
    throw unsafe(`entry is outside expected root ${expectedRoot}: ${entry.path}`);
  }
  if (components.length > limits.maxDepth) {
    throw unsafe(`path exceeds maxDepth (${limits.maxDepth}): ${entry.path}`);
  }
  if (Buffer.byteLength(value, 'ascii') > limits.maxPathBytes) {
    throw unsafe(`path exceeds maxPathBytes (${limits.maxPathBytes}): ${entry.path}`);
  }
  return value;
}

function resolveSymlinkTarget(entry, expectedRoot, limits) {
  const target = entry.target;
  if (
    typeof target !== 'string'
    || !target
    || target.startsWith('/')
    || target.includes('\\')
    || target.includes(':')
    || Buffer.byteLength(target, 'utf8') !== target.length
  ) {
    throw unsafe(`non-portable symlink target: ${entry.path} -> ${JSON.stringify(target)}`);
  }
  const stack = path.posix.dirname(entry.path).split('/');
  for (const component of target.split('/')) {
    if (!component || component === '.') {
      throw unsafe(`non-canonical symlink target: ${entry.path} -> ${target}`);
    }
    if (component === '..') {
      if (stack.length <= 1) throw unsafe(`symlink escapes ${expectedRoot}: ${entry.path} -> ${target}`);
      stack.pop();
    } else {
      validateComponent(component, limits, 'symlink target');
      stack.push(component);
    }
  }
  if (stack[0] !== expectedRoot) {
    throw unsafe(`symlink escapes ${expectedRoot}: ${entry.path} -> ${target}`);
  }
  return stack.join('/');
}

function canonicalizeEntries(rawEntries, expectedRoot, limits) {
  validateComponent(expectedRoot, limits, 'expected root');
  const explicit = new Map();
  const materialized = new Map();
  const symlinks = [];

  function ensureDirectory(directoryPath) {
    const key = directoryPath.toLowerCase();
    const existing = materialized.get(key);
    if (existing) {
      if (existing.path !== directoryPath || existing.type !== 'directory') {
        throw unsafe(`case-fold or ancestor collision at ${directoryPath}`);
      }
      return;
    }
    materialized.set(key, { path: directoryPath, type: 'directory' });
  }

  for (const rawEntry of rawEntries) {
    const memberPath = normalizeMemberPath(rawEntry, expectedRoot, limits);
    const key = memberPath.toLowerCase();
    if (explicit.has(key)) throw unsafe(`duplicate or case-fold path: ${memberPath}`);
    explicit.set(key, memberPath);

    const components = memberPath.split('/');
    for (let index = 1; index < components.length; index += 1) {
      ensureDirectory(components.slice(0, index).join('/'));
    }

    const existing = materialized.get(key);
    if (rawEntry.type === 'directory') {
      if (existing && (existing.path !== memberPath || existing.type !== 'directory')) {
        throw unsafe(`file/directory or case-fold collision at ${memberPath}`);
      }
      materialized.set(key, { path: memberPath, type: 'directory' });
    } else {
      if (existing) throw unsafe(`entry collides with an implicit directory: ${memberPath}`);
      const entry = rawEntry.type === 'file'
        ? { path: memberPath, size: rawEntry.size, type: 'file' }
        : { path: memberPath, target: rawEntry.target, type: 'symlink' };
      materialized.set(key, entry);
      if (entry.type === 'symlink') symlinks.push(entry);
    }
  }

  for (const entry of symlinks) {
    const resolvedTarget = resolveSymlinkTarget(entry, expectedRoot, limits);
    const targetEntry = materialized.get(resolvedTarget.toLowerCase());
    if (
      !targetEntry
      || targetEntry.path !== resolvedTarget
      || targetEntry.type !== 'file'
    ) {
      throw unsafe(`symlink must point directly to an archive file: ${entry.path} -> ${entry.target}`);
    }
    entry.resolvedTarget = resolvedTarget;
  }

  const rootEntry = materialized.get(expectedRoot.toLowerCase());
  if (!rootEntry || rootEntry.path !== expectedRoot || rootEntry.type !== 'directory') {
    throw unsafe(`archive does not materialize expected root directory ${expectedRoot}`);
  }

  return [...materialized.values()].sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
}

function manifestDigest(format, expectedRoot, entries) {
  return createHash('sha256')
    .update(JSON.stringify({ entries, expectedRoot, format }))
    .digest('hex');
}

function assertExpectedMetric(limits, name, actual) {
  const expectedName = `expected${name[0].toUpperCase()}${name.slice(1)}`;
  if (limits[expectedName] !== undefined && limits[expectedName] !== actual) {
    throw unsafe(`${name} mismatch: expected ${limits[expectedName]}, received ${actual}`);
  }
}

export async function inspectLockedArchive({ archivePath, format, expectedRoot, limits: overrides }) {
  if (!['ustar-gzip', 'zip'].includes(format)) {
    throw unsafe(`unsupported locked archive format: ${format}`);
  }
  const limits = resolveLimits(overrides);
  const handle = await fs.promises.open(archivePath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw unsafe(`archive is not a regular file: ${archivePath}`);
    if (stats.size > limits.maxArchiveBytes) {
      throw unsafe(`archive exceeds maxArchiveBytes (${stats.size} > ${limits.maxArchiveBytes})`);
    }
    assertExpectedMetric(limits, 'archiveBytes', stats.size);

    const parsed = format === 'ustar-gzip'
      ? await inspectUstarGzip(handle, limits)
      : inspectZip(await handle.readFile(), limits);
    const regularEntries = parsed.entries.filter((entry) => entry.type === 'file');
    const regularBytes = regularEntries.reduce((total, entry) => total + entry.size, 0);
    if (!Number.isSafeInteger(regularBytes) || regularBytes > limits.maxTotalBytes) {
      throw unsafe(`regular file bytes exceed maxTotalBytes (${limits.maxTotalBytes})`);
    }
    const maxEntryBytes = regularEntries.reduce((maximum, entry) => Math.max(maximum, entry.size), 0);
    const symlinkCount = parsed.entries.filter((entry) => entry.type === 'symlink').length;
    if (symlinkCount > limits.maxSymlinks) {
      throw unsafe(`symlink count exceeds maxSymlinks (${limits.maxSymlinks})`);
    }
    const entries = canonicalizeEntries(parsed.entries, expectedRoot, limits);
    const manifestSha256 = manifestDigest(format, expectedRoot, entries);
    const metrics = {
      archiveBytes: stats.size,
      canonicalEntryCount: entries.length,
      decompressedBytes: parsed.decompressedBytes,
      maxEntryBytes,
      rawEntryCount: parsed.entries.length,
      regularBytes,
      symlinkCount,
    };
    for (const [name, value] of Object.entries(metrics)) assertExpectedMetric(limits, name, value);
    if (
      limits.expectedManifestSha256 !== undefined
      && limits.expectedManifestSha256 !== manifestSha256
    ) {
      throw unsafe(
        `manifestSha256 mismatch: expected ${limits.expectedManifestSha256}, received ${manifestSha256}`,
      );
    }
    return { entries, expectedRoot, format, manifestSha256, metrics };
  } finally {
    await handle.close();
  }
}

function isInsideRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function verifyExtractedArchive({ extractionRoot, inspection }) {
  if (
    !inspection
    || !['ustar-gzip', 'zip'].includes(inspection.format)
    || typeof inspection.expectedRoot !== 'string'
    || !Array.isArray(inspection.entries)
    || typeof inspection.manifestSha256 !== 'string'
    || manifestDigest(inspection.format, inspection.expectedRoot, inspection.entries)
      !== inspection.manifestSha256
  ) {
    throw unsafe('invalid or mutated archive inspection contract');
  }

  const extractionStats = await fs.promises.lstat(extractionRoot);
  if (!extractionStats.isDirectory() || extractionStats.isSymbolicLink()) {
    throw unsafe(`extraction root is not a real directory: ${extractionRoot}`);
  }
  const topLevel = await fs.promises.readdir(extractionRoot);
  if (topLevel.length !== 1 || topLevel[0] !== inspection.expectedRoot) {
    throw unsafe(`unexpected top-level extraction entries: ${topLevel.join(', ')}`);
  }

  const expected = new Map(inspection.entries.map((entry) => [entry.path, entry]));
  if (expected.size !== inspection.entries.length) {
    throw unsafe('inspection manifest contains duplicate paths');
  }
  const seen = new Set();
  const rootPath = path.join(extractionRoot, inspection.expectedRoot);
  const rootStats = await fs.promises.lstat(rootPath);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw unsafe(`expected archive root is not a real directory: ${inspection.expectedRoot}`);
  }
  const realRoot = await fs.promises.realpath(rootPath);

  async function visit(absolutePath, relativePath) {
    const stats = await fs.promises.lstat(absolutePath);
    const expectedEntry = expected.get(relativePath);
    if (!expectedEntry) throw unsafe(`unexpected extracted entry: ${relativePath}`);
    if (seen.has(relativePath)) throw unsafe(`duplicate extracted entry: ${relativePath}`);
    seen.add(relativePath);

    if (stats.isSymbolicLink()) {
      if (expectedEntry.type !== 'symlink') {
        throw unsafe(`extracted type mismatch at ${relativePath}`);
      }
      const target = await fs.promises.readlink(absolutePath);
      if (target !== expectedEntry.target) {
        throw unsafe(
          `extracted symlink target mismatch at ${relativePath}: expected ${expectedEntry.target}, received ${target}`,
        );
      }
      let realTarget;
      try {
        realTarget = await fs.promises.realpath(absolutePath);
      } catch (error) {
        throw unsafe(`extracted symlink is dangling at ${relativePath}`, error);
      }
      if (!isInsideRoot(realRoot, realTarget)) {
        throw unsafe(`extracted symlink escapes root at ${relativePath}`);
      }
      const targetStats = await fs.promises.stat(realTarget);
      if (!targetStats.isFile()) {
        throw unsafe(`extracted symlink does not resolve to a regular file at ${relativePath}`);
      }
      return;
    }
    if (stats.isDirectory()) {
      if (expectedEntry.type !== 'directory') {
        throw unsafe(`extracted type mismatch at ${relativePath}`);
      }
      const names = await fs.promises.readdir(absolutePath);
      names.sort();
      for (const name of names) {
        await visit(path.join(absolutePath, name), `${relativePath}/${name}`);
      }
      return;
    }
    if (stats.isFile()) {
      if (expectedEntry.type !== 'file' || stats.size !== expectedEntry.size) {
        throw unsafe(`extracted file type or size mismatch at ${relativePath}`);
      }
      if (stats.nlink !== 1) throw unsafe(`extracted hardlink is forbidden at ${relativePath}`);
      return;
    }
    throw unsafe(`extracted special filesystem entry is forbidden at ${relativePath}`);
  }

  await visit(rootPath, inspection.expectedRoot);
  if (seen.size !== expected.size) {
    const missing = [...expected.keys()].filter((entryPath) => !seen.has(entryPath));
    throw unsafe(`missing extracted entries: ${missing.join(', ')}`);
  }
  return {
    entries: inspection.entries.map((entry) => ({ ...entry })),
    manifestSha256: inspection.manifestSha256,
  };
}
