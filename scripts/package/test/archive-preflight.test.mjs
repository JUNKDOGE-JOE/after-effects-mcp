import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

async function makeTempDir(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-archive-preflight-'));
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));
  return root;
}

function writeAscii(buffer, offset, length, value) {
  const encoded = Buffer.from(value, 'ascii');
  assert.ok(encoded.length <= length, `${value} exceeds ${length} bytes`);
  encoded.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  writeAscii(buffer, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function makeTarHeader({
  name,
  type = '0',
  data = Buffer.alloc(0),
  target = '',
  mode = 0o644,
  nameTailAfterNul = '',
  mutateHeader,
}) {
  const header = Buffer.alloc(512);
  writeAscii(header, 0, 100, name);
  if (nameTailAfterNul) {
    writeAscii(header, Buffer.byteLength(name, 'ascii') + 1, 99 - name.length, nameTailAfterNul);
  }
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, data.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeAscii(header, 156, 1, type);
  writeAscii(header, 157, 100, target);
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');
  mutateHeader?.(header);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function makeTarGzip(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    blocks.push(makeTarHeader({ ...entry, data }), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 1 });
}

function makeZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'ascii');
    const data = Buffer.from(entry.data ?? '');
    const method = entry.method ?? (data.length === 0 ? 0 : 8);
    const encoded = method === 8 ? deflateRawSync(data) : data;
    const compressed = entry.compressedSuffix
      ? Buffer.concat([encoded, Buffer.from(entry.compressedSuffix)])
      : encoded;
    const checksum = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method === 8 ? 20 : 10, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localRecords.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method === 8 ? 20 : 10, 4);
    central.writeUInt16LE(method === 8 ? 20 : 10, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.name.endsWith('/') ? 0x10 : 0x20, 38);
    central.writeUInt32LE(localOffset, 42);
    centralRecords.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localRecords, centralDirectory, eocd]);
}

test('inspects strict ustar-gzip and resolves a direct internal symlink', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archivePath = path.join(root, 'python.tar.gz');
  const archive = makeTarGzip([
    { name: 'python/bin/python', type: '2', target: 'python3.13', mode: 0o777 },
    { name: 'python/bin/python3.13', data: 'bin', mode: 0o755 },
  ]);
  await fs.promises.writeFile(archivePath, archive);

  const result = await inspectLockedArchive({
    archivePath,
    format: 'ustar-gzip',
    expectedRoot: 'python',
    limits: { expectedArchiveBytes: archive.length },
  });

  assert.equal(result.format, 'ustar-gzip');
  assert.equal(result.expectedRoot, 'python');
  assert.deepEqual(result.entries, [
    { path: 'python', type: 'directory' },
    { path: 'python/bin', type: 'directory' },
    {
      path: 'python/bin/python',
      resolvedTarget: 'python/bin/python3.13',
      target: 'python3.13',
      type: 'symlink',
    },
    { path: 'python/bin/python3.13', size: 3, type: 'file' },
  ]);
  assert.deepEqual(result.metrics, {
    archiveBytes: archive.length,
    canonicalEntryCount: 4,
    decompressedBytes: 2560,
    maxEntryBytes: 3,
    rawEntryCount: 2,
    regularBytes: 3,
    symlinkCount: 1,
  });
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
});

test('uses the first NUL as the ustar name terminator for locked Python archives', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archivePath = path.join(root, 'python-padding.tar.gz');
  const archive = makeTarGzip([
    {
      name: 'python/bin/python.exe',
      nameTailAfterNul: 'on.exe',
      data: 'MZ',
    },
  ]);
  await fs.promises.writeFile(archivePath, archive);

  const result = await inspectLockedArchive({
    archivePath,
    format: 'ustar-gzip',
    expectedRoot: 'python',
  });

  assert.ok(result.entries.some((entry) => entry.path === 'python/bin/python.exe'));
});

test('rejects base-256 values in ustar ownership metadata', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archivePath = path.join(root, 'base256.tar.gz');
  const archive = makeTarGzip([
    {
      name: 'python/bin/python3.13',
      data: 'bin',
      mutateHeader(header) {
        header.fill(0, 108, 116);
        header[108] = 0x80;
      },
    },
  ]);
  await fs.promises.writeFile(archivePath, archive);

  await assert.rejects(
    inspectLockedArchive({ archivePath, format: 'ustar-gzip', expectedRoot: 'python' }),
    /unsafe archive.*(?:base-256|uid)/i,
  );
});

test('rejects an archive that does not materialize the expected root', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archivePath = path.join(root, 'empty.tar.gz');
  await fs.promises.writeFile(archivePath, makeTarGzip([]));

  await assert.rejects(
    inspectLockedArchive({ archivePath, format: 'ustar-gzip', expectedRoot: 'python' }),
    /unsafe archive.*expected root/i,
  );
});

test('rejects unknown archive limit keys instead of silently weakening the contract', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archivePath = path.join(root, 'limits.tar.gz');
  await fs.promises.writeFile(
    archivePath,
    makeTarGzip([{ name: 'python/bin/python3.13', data: 'bin' }]),
  );

  await assert.rejects(
    inspectLockedArchive({
      archivePath,
      format: 'ustar-gzip',
      expectedRoot: 'python',
      limits: { maxEntryByte: 1 },
    }),
    /unsafe archive.*unknown.*maxEntryByte/i,
  );
});

test('rejects portable-path, link, collision, hardlink, and special-entry attacks', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const cases = [
    ['absolute', [{ name: '/tmp/owned', data: 'owned' }]],
    ['traversal', [{ name: 'python/../owned', data: 'owned' }]],
    ['drive', [{ name: 'C:/owned.exe', data: 'owned' }]],
    ['unc', [{ name: '\\\\server\\share\\owned', data: 'owned' }]],
    ['ads', [{ name: 'python/owned.txt:stream', data: 'owned' }]],
    ['device', [{ name: 'python/CON.txt', data: 'owned' }]],
    ['trailing-dot', [{ name: 'python/owned.', data: 'owned' }]],
    ['empty-segment', [{ name: 'python//owned', data: 'owned' }]],
    ['case-fold', [
      { name: 'python/A.txt', data: 'A' },
      { name: 'python/a.txt', data: 'a' },
    ]],
    ['file-parent', [
      { name: 'python/a', data: 'file' },
      { name: 'python/a/child', data: 'child' },
    ]],
    ['escaping-symlink', [
      { name: 'python/bin/python', type: '2', target: '../../owned' },
      { name: 'python/bin/python3.13', data: 'bin' },
    ]],
    ['symlink-chain', [
      { name: 'python/bin/python', type: '2', target: 'python3' },
      { name: 'python/bin/python3', type: '2', target: 'python3.13' },
      { name: 'python/bin/python3.13', data: 'bin' },
    ]],
    ['hardlink', [
      { name: 'python/bin/python3.13', data: 'bin' },
      { name: 'python/bin/python', type: '1', target: 'python/bin/python3.13' },
    ]],
    ['fifo', [{ name: 'python/pipe', type: '6' }]],
    ['pax', [{ name: 'python/pax', type: 'x' }]],
  ];

  for (const [name, entries] of cases) {
    const archivePath = path.join(root, `${name}.tar.gz`);
    await fs.promises.writeFile(archivePath, makeTarGzip(entries));
    await assert.rejects(
      inspectLockedArchive({ archivePath, format: 'ustar-gzip', expectedRoot: 'python' }),
      /unsafe archive/i,
      name,
    );
  }
});

test('rejects tar checksum, terminator, and all resource-limit violations', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const valid = makeTarGzip([
    { name: 'python/a', data: 'aaa' },
    { name: 'python/b', data: 'bbb' },
  ]);
  const archivePath = path.join(root, 'limits.tar.gz');
  await fs.promises.writeFile(archivePath, valid);

  for (const limits of [
    { maxArchiveBytes: valid.length - 1 },
    { maxDecompressedBytes: 1024 },
    { maxEntries: 1 },
    { maxEntryBytes: 2 },
    { maxTotalBytes: 5 },
    { expectedRawEntryCount: 3 },
    { expectedRegularBytes: 7 },
    { expectedManifestSha256: '0'.repeat(64) },
  ]) {
    await assert.rejects(
      inspectLockedArchive({ archivePath, format: 'ustar-gzip', expectedRoot: 'python', limits }),
      /unsafe archive/i,
      JSON.stringify(limits),
    );
  }

  const raw = await import('node:zlib').then(({ gunzipSync }) => gunzipSync(valid));
  const badChecksum = Buffer.from(raw);
  badChecksum[0] ^= 1;
  const checksumPath = path.join(root, 'checksum.tar.gz');
  await fs.promises.writeFile(checksumPath, gzipSync(badChecksum));
  await assert.rejects(
    inspectLockedArchive({ archivePath: checksumPath, format: 'ustar-gzip', expectedRoot: 'python' }),
    /unsafe archive.*checksum/i,
  );

  const truncatedPath = path.join(root, 'truncated.tar.gz');
  await fs.promises.writeFile(truncatedPath, gzipSync(raw.subarray(0, raw.length - 512)));
  await assert.rejects(
    inspectLockedArchive({ archivePath: truncatedPath, format: 'ustar-gzip', expectedRoot: 'python' }),
    /unsafe archive.*(?:truncated|terminator)/i,
  );
});

test('inspects strict ZIP store/deflate records with matching CRC and sizes', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archivePath = path.join(root, 'node.zip');
  const archive = makeZip([
    { name: 'node-v24.17.0-win-x64/' },
    { name: 'node-v24.17.0-win-x64/node.exe', data: 'MZ', method: 8 },
  ]);
  await fs.promises.writeFile(archivePath, archive);

  const result = await inspectLockedArchive({
    archivePath,
    format: 'zip',
    expectedRoot: 'node-v24.17.0-win-x64',
    limits: { expectedArchiveBytes: archive.length },
  });

  assert.deepEqual(result.entries, [
    { path: 'node-v24.17.0-win-x64', type: 'directory' },
    { path: 'node-v24.17.0-win-x64/node.exe', size: 2, type: 'file' },
  ]);
  assert.deepEqual(result.metrics, {
    archiveBytes: archive.length,
    canonicalEntryCount: 2,
    decompressedBytes: 2,
    maxEntryBytes: 2,
    rawEntryCount: 2,
    regularBytes: 2,
    symlinkCount: 0,
  });
});

test('rejects trailing bytes hidden inside a ZIP deflate payload', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archivePath = path.join(root, 'trailing-deflate.zip');
  const archive = makeZip([
    {
      name: 'node-v24.17.0-win-x64/node.exe',
      data: 'MZ',
      method: 8,
      compressedSuffix: 'hidden',
    },
  ]);
  await fs.promises.writeFile(archivePath, archive);

  await assert.rejects(
    inspectLockedArchive({
      archivePath,
      format: 'zip',
      expectedRoot: 'node-v24.17.0-win-x64',
    }),
    /unsafe archive.*(?:trailing|compressed payload|consume)/i,
  );
});

test('rejects ZIP CRC, central/local, encryption, ZIP64, collision, and gap attacks', async (t) => {
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const original = makeZip([
    { name: 'node-v24.17.0-win-x64/node.exe', data: 'MZ', method: 0 },
  ]);
  const originalEocd = original.length - 22;
  const originalCentral = original.readUInt32LE(originalEocd + 16);
  const localNameLength = original.readUInt16LE(26);
  const localData = 30 + localNameLength;

  const corruptCrc = Buffer.from(original);
  corruptCrc[localData] ^= 1;

  const metadataMismatch = Buffer.from(original);
  metadataMismatch.writeUInt32LE(1, 22);

  const encrypted = Buffer.from(original);
  encrypted.writeUInt16LE(1, originalCentral + 8);

  const zip64 = Buffer.from(original);
  zip64.writeUInt16LE(0xffff, originalEocd + 10);

  const gap = Buffer.concat([
    original.subarray(0, originalCentral),
    Buffer.from([0]),
    original.subarray(originalCentral),
  ]);
  const gapEocd = gap.length - 22;
  gap.writeUInt32LE(originalCentral + 1, gapEocd + 16);

  const cases = [
    ['crc', corruptCrc],
    ['metadata-mismatch', metadataMismatch],
    ['encrypted', encrypted],
    ['zip64', zip64],
    ['gap', gap],
    ['case-fold', makeZip([
      { name: 'node-v24.17.0-win-x64/A.txt', data: 'A', method: 0 },
      { name: 'node-v24.17.0-win-x64/a.txt', data: 'a', method: 0 },
    ])],
  ];

  for (const [name, archive] of cases) {
    const archivePath = path.join(root, `${name}.zip`);
    await fs.promises.writeFile(archivePath, archive);
    await assert.rejects(
      inspectLockedArchive({
        archivePath,
        format: 'zip',
        expectedRoot: 'node-v24.17.0-win-x64',
      }),
      /unsafe archive/i,
      name,
    );
  }
});

test('verifies the extracted tree against the canonical archive manifest', async (t) => {
  const { inspectLockedArchive, verifyExtractedArchive } = await import(
    '../lib/archive-preflight.mjs'
  );
  const root = await makeTempDir(t);
  const archivePath = path.join(root, 'node.zip');
  const archive = makeZip([
    { name: 'node-v24.17.0-win-x64/node.exe', data: 'MZ', method: 0 },
  ]);
  await fs.promises.writeFile(archivePath, archive);
  const inspection = await inspectLockedArchive({
    archivePath,
    format: 'zip',
    expectedRoot: 'node-v24.17.0-win-x64',
  });
  const extractionRoot = path.join(root, 'extract');
  await fs.promises.mkdir(path.join(extractionRoot, inspection.expectedRoot), { recursive: true });
  await fs.promises.writeFile(
    path.join(extractionRoot, inspection.expectedRoot, 'node.exe'),
    'MZ',
  );

  const verified = await verifyExtractedArchive({ extractionRoot, inspection });

  assert.equal(verified.manifestSha256, inspection.manifestSha256);
  assert.deepEqual(verified.entries, inspection.entries);

  await fs.promises.writeFile(path.join(extractionRoot, 'unexpected.txt'), 'unexpected');
  await assert.rejects(
    verifyExtractedArchive({ extractionRoot, inspection }),
    /unsafe archive.*unexpected|extra/i,
  );
});

test('post-verifier preserves internal symlinks and rejects hardlink or chained escapes', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { inspectLockedArchive, verifyExtractedArchive } = await import(
    '../lib/archive-preflight.mjs'
  );
  const root = await makeTempDir(t);
  const archivePath = path.join(root, 'python.tar.gz');
  await fs.promises.writeFile(archivePath, makeTarGzip([
    { name: 'python/bin/python', type: '2', target: 'python3.13', mode: 0o777 },
    { name: 'python/bin/python3.13', data: 'bin', mode: 0o755 },
  ]));
  const inspection = await inspectLockedArchive({
    archivePath,
    format: 'ustar-gzip',
    expectedRoot: 'python',
  });
  const extractionRoot = path.join(root, 'extract');
  const bin = path.join(extractionRoot, 'python/bin');
  const target = path.join(bin, 'python3.13');
  await fs.promises.mkdir(bin, { recursive: true });
  await fs.promises.writeFile(target, 'bin');
  await fs.promises.symlink('python3.13', path.join(bin, 'python'));

  await verifyExtractedArchive({ extractionRoot, inspection });

  const outsideHardlink = path.join(root, 'outside-hardlink');
  await fs.promises.link(target, outsideHardlink);
  await assert.rejects(
    verifyExtractedArchive({ extractionRoot, inspection }),
    /unsafe archive.*hardlink/i,
  );
  await fs.promises.rm(outsideHardlink);

  const outsideFile = path.join(root, 'outside');
  await fs.promises.writeFile(outsideFile, 'bin');
  await fs.promises.rm(target);
  await fs.promises.symlink('../../../outside', target);
  await assert.rejects(
    verifyExtractedArchive({ extractionRoot, inspection }),
    /unsafe archive.*(?:escapes|type mismatch)/i,
  );
});
