import { createHash, X509Certificate } from 'node:crypto';
import path from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

import {
  inventoryFiles,
  readRegularFileSnapshot,
  sha256Directory,
} from './files.mjs';
import { signingError } from '../signing-plan.mjs';

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const MIMETYPE = Buffer.from('application/vnd.adobe.air-ucf-package+zip', 'ascii');
const SHA256 = /^[a-f0-9]{64}$/;

function invalid(message, cause) {
  const error = signingError('SIGNING_ZXP_ARCHIVE_INVALID', message);
  if (cause) error.cause = cause;
  return error;
}

function assertRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0 || offset + length > buffer.length) {
    throw invalid(`truncated or overflowing ZXP ${label}`);
  }
}

function readName(buffer, offset, length, flags, label) {
  assertRange(buffer, offset, length, label);
  const bytes = buffer.subarray(offset, offset + length);
  if ((flags & 0x800) === 0 && bytes.some((byte) => byte > 0x7f)) {
    throw invalid(`ZXP ${label} is non-ASCII without the UTF-8 flag`);
  }
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalid(`ZXP ${label} is not valid UTF-8`, error);
  }
  if (Buffer.from(value, 'utf8').compare(bytes) !== 0 || value.normalize('NFC') !== value) {
    throw invalid(`ZXP ${label} is not canonical UTF-8`);
  }
  return value;
}

function validateExtra(buffer, offset, length, label) {
  assertRange(buffer, offset, length, `${label} extra field`);
  const seen = new Set();
  let cursor = offset;
  const end = offset + length;
  while (cursor < end) {
    assertRange(buffer, cursor, 4, `${label} extra header`);
    const identifier = buffer.readUInt16LE(cursor);
    const dataLength = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    assertRange(buffer, cursor, dataLength, `${label} extra payload`);
    if (identifier === 0x0001 || seen.has(identifier)) {
      throw invalid(`unsupported or duplicate ZXP extra field 0x${identifier.toString(16)}`);
    }
    seen.add(identifier);
    cursor += dataLength;
  }
  if (cursor !== end) throw invalid(`malformed ZXP extra field in ${label}`);
}

function validatePortablePath(name, directory) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\\')
      || name.startsWith('/') || path.win32.isAbsolute(name)
      || /[\0-\x1f\x7f]/.test(name) || directory !== name.endsWith('/')) {
    throw invalid(`unsafe ZXP member path: ${JSON.stringify(name)}`);
  }
  const trimmed = directory ? name.slice(0, -1) : name;
  const components = trimmed.split('/');
  if (components.length === 0 || components.some((component) => (
    component.length === 0
      || component === '.'
      || component === '..'
      || component.endsWith('.')
      || component.endsWith(' ')
      || /[<>:"|?*]/.test(component)
  ))) {
    throw invalid(`non-portable ZXP member path: ${JSON.stringify(name)}`);
  }
}

function inflateEntry(compressed, record) {
  if (record.method === 0) {
    if (record.compressedSize !== record.uncompressedSize) {
      throw invalid(`stored ZXP entry has mismatched sizes: ${record.name}`);
    }
    return compressed;
  }
  try {
    const inflated = inflateRawSync(compressed, {
      info: true,
      maxOutputLength: Math.max(1, Math.min(MAX_ENTRY_BYTES + 1, record.uncompressedSize + 1)),
    });
    if (inflated.engine.bytesWritten !== compressed.length) {
      throw invalid(`ZXP deflate payload has trailing bytes: ${record.name}`);
    }
    return inflated.buffer;
  } catch (error) {
    if (error?.code === 'SIGNING_ZXP_ARCHIVE_INVALID') throw error;
    throw invalid(`cannot inflate ZXP entry: ${record.name}`, error);
  }
}

function entryType(versionMadeBy, externalAttributes, directory) {
  const origin = versionMadeBy >>> 8;
  if (origin === 3) {
    const unixMode = externalAttributes >>> 16;
    const kind = unixMode & 0o170000;
    if (directory && kind !== 0o040000) throw invalid('ZXP directory has invalid Unix mode');
    if (!directory && ![0o100000, 0o120000].includes(kind)) {
      throw invalid('ZXP file has an unsupported Unix type');
    }
    return {
      mode: (unixMode & 0o777).toString(8).padStart(4, '0'),
      type: kind === 0o120000 ? 'symlink' : directory ? 'directory' : 'file',
    };
  }
  if (origin !== 0) throw invalid(`unsupported ZXP creator system: ${origin}`);
  const dosAttributes = externalAttributes & 0xff;
  if (directory !== ((dosAttributes & 0x10) !== 0)) {
    throw invalid('ZXP DOS directory attributes do not match the member name');
  }
  return { mode: null, type: directory ? 'directory' : 'file' };
}

function parseZxp(buffer) {
  if (buffer.length < 22) throw invalid('truncated ZXP end-of-central-directory record');
  const eocd = buffer.length - 22;
  if (buffer.readUInt32LE(eocd) !== 0x06054b50
      || buffer.readUInt16LE(eocd + 4) !== 0
      || buffer.readUInt16LE(eocd + 6) !== 0
      || buffer.readUInt16LE(eocd + 8) !== buffer.readUInt16LE(eocd + 10)
      || buffer.readUInt16LE(eocd + 20) !== 0) {
    throw invalid('ZXP must be one uncommented non-ZIP64 archive');
  }
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0 || count === 0xffff || count > MAX_ENTRIES
      || centralOffset === 0xffffffff || centralSize === 0xffffffff
      || centralOffset + centralSize !== eocd) {
    throw invalid('ZXP central directory identity is invalid');
  }

  const records = [];
  const portableNames = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    assertRange(buffer, cursor, 46, `central header ${index}`);
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw invalid(`invalid ZXP central header ${index}`);
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
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const internalAttributes = buffer.readUInt16LE(cursor + 36);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if (versionNeeded > 20 || ![0, 0x800].includes(flags) || ![0, 8].includes(method)
        || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
        || uncompressedSize > MAX_ENTRY_BYTES || commentLength !== 0 || diskStart !== 0
        || ![0, 1].includes(internalAttributes) || localOffset === 0xffffffff) {
      throw invalid(`unsupported ZXP feature at central entry ${index}`);
    }
    const nameOffset = cursor + 46;
    const extraOffset = nameOffset + nameLength;
    const name = readName(buffer, nameOffset, nameLength, flags, 'member name');
    validateExtra(buffer, extraOffset, extraLength, `central entry ${name}`);
    const directory = name.endsWith('/');
    validatePortablePath(name, directory);
    const portableKey = name.toLocaleLowerCase('en-US');
    if (portableNames.has(portableKey)) throw invalid(`duplicate portable ZXP path: ${name}`);
    portableNames.add(portableKey);
    const identity = entryType(versionMadeBy, externalAttributes, directory);
    records.push({
      checksum,
      compressedSize,
      directory,
      flags,
      identity,
      localOffset,
      method,
      name,
      uncompressedSize,
      versionNeeded,
    });
    cursor = extraOffset + extraLength + commentLength;
  }
  if (cursor !== eocd) throw invalid('ZXP central directory size is inconsistent');

  const ranges = [];
  const entries = [];
  let total = 0;
  for (const record of records) {
    assertRange(buffer, record.localOffset, 30, `local header ${record.name}`);
    if (buffer.readUInt32LE(record.localOffset) !== 0x04034b50) {
      throw invalid(`invalid ZXP local header: ${record.name}`);
    }
    const nameLength = buffer.readUInt16LE(record.localOffset + 26);
    const extraLength = buffer.readUInt16LE(record.localOffset + 28);
    const nameOffset = record.localOffset + 30;
    const extraOffset = nameOffset + nameLength;
    const localName = readName(buffer, nameOffset, nameLength, record.flags, 'local member name');
    validateExtra(buffer, extraOffset, extraLength, `local entry ${localName}`);
    if (buffer.readUInt16LE(record.localOffset + 4) !== record.versionNeeded
        || buffer.readUInt16LE(record.localOffset + 6) !== record.flags
        || buffer.readUInt16LE(record.localOffset + 8) !== record.method
        || buffer.readUInt32LE(record.localOffset + 14) !== record.checksum
        || buffer.readUInt32LE(record.localOffset + 18) !== record.compressedSize
        || buffer.readUInt32LE(record.localOffset + 22) !== record.uncompressedSize
        || localName !== record.name) {
      throw invalid(`ZXP central/local metadata mismatch: ${record.name}`);
    }
    const dataOffset = extraOffset + extraLength;
    const dataEnd = dataOffset + record.compressedSize;
    if (dataEnd > centralOffset) throw invalid(`ZXP entry overlaps its central directory: ${record.name}`);
    ranges.push({ start: record.localOffset, end: dataEnd });
    const data = inflateEntry(buffer.subarray(dataOffset, dataEnd), record);
    if (data.length !== record.uncompressedSize || (crc32(data) >>> 0) !== record.checksum) {
      throw invalid(`ZXP entry integrity mismatch: ${record.name}`);
    }
    total += data.length;
    if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) {
      throw invalid('ZXP decompressed payload exceeds the total limit');
    }
    entries.push({ ...record.identity, data, name: record.name });
  }
  ranges.sort((left, right) => left.start - right.start);
  let localCursor = 0;
  for (const range of ranges) {
    if (range.start !== localCursor || range.end < range.start) {
      throw invalid('ZXP local records overlap or contain an unreferenced gap');
    }
    localCursor = range.end;
  }
  if (localCursor !== centralOffset) throw invalid('ZXP contains unreferenced local bytes');
  return entries;
}

function fingerprintFromSignature(bytes) {
  if (bytes.length === 0 || bytes.length > 1024 * 1024) {
    throw invalid('ZXP signature XML exceeds the supported size');
  }
  let xml;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalid('ZXP signature XML is not UTF-8', error);
  }
  const matches = [...xml.matchAll(/<X509Certificate>([A-Za-z0-9+/=\s]+)<\/X509Certificate>/g)];
  if (matches.length === 0) throw invalid('ZXP signature does not contain a signer certificate');
  const certificates = [];
  const fingerprints = new Set();
  for (const match of matches) {
    const encoded = match[1].replaceAll(/\s/g, '');
    const der = Buffer.from(encoded, 'base64');
    if (der.length === 0 || der.toString('base64') !== encoded) {
      throw invalid('ZXP signer certificate is not canonical base64');
    }
    let certificate;
    try {
      certificate = new X509Certificate(der);
    } catch (error) {
      throw invalid('ZXP signer certificate is invalid', error);
    }
    const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase();
    if (fingerprints.has(fingerprint)) throw invalid('ZXP certificate chain contains a duplicate');
    fingerprints.add(fingerprint);
    certificates.push({ certificate, fingerprint });
  }
  for (let index = 0; index + 1 < certificates.length; index += 1) {
    if (certificates[index].certificate.issuer !== certificates[index + 1].certificate.subject) {
      throw invalid('ZXP certificate chain is not ordered leaf to issuer');
    }
  }
  return certificates[0].fingerprint;
}

function comparableArchivePayload(entries) {
  const controls = new Map(entries.map((entry) => [entry.name, entry]));
  const signature = controls.get('META-INF/signatures.xml');
  const mimetype = controls.get('mimetype');
  if (!signature || signature.type !== 'file' || !mimetype || mimetype.type !== 'file'
      || !mimetype.data.equals(MIMETYPE)
      || entries.some((entry) => entry.name.startsWith('META-INF/')
        && !['META-INF/', 'META-INF/signatures.xml'].includes(entry.name))) {
    throw invalid('ZXP control entries are missing, duplicated, or invalid');
  }
  const payload = entries.filter((entry) => (
    entry.type !== 'directory'
      && entry.name !== 'META-INF/signatures.xml'
      && entry.name !== 'mimetype'
  )).map((entry) => ({
    mode: entry.mode,
    path: entry.name,
    sha256: createHash('sha256').update(entry.data).digest('hex'),
    size: entry.data.length,
    type: entry.type,
  }));
  payload.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { payload, signature };
}

function assertSamePayload(archiveFiles, sourceFiles) {
  if (archiveFiles.length !== sourceFiles.length) {
    throw signingError('SIGNING_ZXP_PAYLOAD_MISMATCH', 'ZXP payload entry count changed');
  }
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const archive = archiveFiles[index];
    const source = sourceFiles[index];
    if (archive.path !== source.path || archive.type !== source.type
        || archive.size !== source.size || archive.sha256 !== source.sha256
        || (archive.mode !== null && archive.mode !== source.mode)) {
      throw signingError('SIGNING_ZXP_PAYLOAD_MISMATCH', `ZXP payload changed: ${source.path}`);
    }
  }
}

export async function auditZxpPayload({
  zxpPath,
  signingRoot,
  expectedCertificateFingerprint,
}) {
  if (!path.isAbsolute(zxpPath) || !path.isAbsolute(signingRoot)
      || !SHA256.test(expectedCertificateFingerprint || '')) {
    throw signingError('SIGNING_ZXP_AUDIT_INPUT_INVALID', 'ZXP audit inputs are invalid');
  }
  const bytes = await readRegularFileSnapshot(zxpPath, { maxBytes: MAX_ARCHIVE_BYTES });
  const { payload, signature } = comparableArchivePayload(parseZxp(bytes));
  const source = await inventoryFiles(signingRoot);
  assertSamePayload(payload, source);
  const certificateFingerprint = fingerprintFromSignature(signature.data);
  if (certificateFingerprint !== expectedCertificateFingerprint) {
    throw signingError(
      'SIGNING_ZXP_CERTIFICATE_MISMATCH',
      'ZXP signer certificate fingerprint does not match the reviewed identity',
    );
  }
  return {
    certificateFingerprint,
    payloadSha256: await sha256Directory(signingRoot),
  };
}
