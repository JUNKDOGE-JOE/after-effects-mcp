import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { verifyWindowsAex } from '../../../native/ae-plugin/verify-windows.mjs';

// Minimal synthetic PE32+ fixtures exercising the verifier without a real
// .aex. Layout: DOS stub (0x80) | PE sig + COFF + optional (240) | two
// section headers | .text raw (export directory + names) | .rsrc raw
// (resource tree + payloads).

const ENTRY = 'AeMcpNativeMain';

function buildResourceTree({ pipl, versionInfo }) {
  const chunks = [];
  const cursor = { offset: 0 };
  function push(buffer) {
    chunks.push({ offset: cursor.offset, buffer });
    cursor.offset += buffer.length;
  }
  function directory(entries) {
    const named = entries.filter((entry) => typeof entry.name === 'string').length;
    const ids = entries.length - named;
    const buffer = Buffer.alloc(16 + entries.length * 8);
    buffer.writeUInt16LE(named, 12);
    buffer.writeUInt16LE(ids, 14);
    return { buffer, entries };
  }

  // Layout plan with fixed offsets inside the .rsrc section.
  const rootEntries = pipl === null
    ? [{ name: 16, isDirectory: true, target: 'versionId' }]
    : [
        { name: 'PiPL', nameOffset: 'typeString', isDirectory: true, target: 'types' },
        { name: 16, isDirectory: true, target: 'versionId' },
      ];
  const typeStringLength = pipl === null ? 0 : 2 + 'PiPL'.length * 2;
  const rootSize = 16 + rootEntries.length * 8;
  const dirSize = 16 + 1 * 8;
  const rootOffset = 0;
  const typesOffset = rootOffset + rootSize;
  const piplIdOffset = typesOffset + (pipl === null ? 0 : dirSize);
  const piplLangOffset = piplIdOffset + dirSize;
  const versionIdOffset = pipl === null ? typesOffset : piplLangOffset + dirSize;
  const versionLangOffset = versionIdOffset + dirSize;
  const dataEntrySize = 16;
  const piplDataOffset = versionLangOffset + dirSize;
  const versionDataOffset = piplDataOffset + (pipl === null ? 0 : dataEntrySize);
  const typeStringOffset = versionDataOffset + dataEntrySize;
  const payloadOffset = typeStringOffset + typeStringLength;

  const piplRva = 0x2000 + payloadOffset;
  const versionRva = piplRva + (pipl ? pipl.length : 0);

  function dirBuffer(entries) {
    const { buffer } = directory(entries);
    entries.forEach((entry, index) => {
      const nameField = typeof entry.name === 'string'
        ? 0x80000000 | entry.nameOffset
        : entry.name;
      buffer.writeUInt32LE(nameField >>> 0, 16 + index * 8);
      const target = entry.isDirectory
        ? 0x80000000 | entry.target
        : entry.target;
      buffer.writeUInt32LE(target >>> 0, 16 + index * 8 + 4);
    });
    return buffer;
  }

  const plan = [];
  plan.push({
    offset: rootOffset,
    buffer: dirBuffer(rootEntries.map((entry) => ({
      name: entry.name === 'PiPL' ? 'PiPL' : entry.name,
      nameOffset: typeStringOffset,
      isDirectory: true,
      target: entry.name === 'PiPL' ? typesOffset : versionIdOffset,
    }))),
  });
  if (pipl !== null) {
    plan.push({ offset: typesOffset, buffer: dirBuffer([
      { name: 16000, isDirectory: true, target: piplIdOffset },
    ]) });
    plan.push({ offset: piplIdOffset, buffer: dirBuffer([
      { name: 0x409, isDirectory: false, target: piplDataOffset },
    ]) });
    const piplData = Buffer.alloc(16);
    piplData.writeUInt32LE(piplRva, 0);
    piplData.writeUInt32LE(pipl.length, 4);
    plan.push({ offset: piplDataOffset, buffer: piplData });
    const typeString = Buffer.alloc(typeStringLength);
    typeString.writeUInt16LE('PiPL'.length, 0);
    typeString.write('PiPL', 2, 'utf16le');
    plan.push({ offset: typeStringOffset, buffer: typeString });
    plan.push({ offset: payloadOffset, buffer: pipl });
  }
  plan.push({ offset: versionIdOffset, buffer: dirBuffer([
    { name: 1, isDirectory: true, target: versionLangOffset },
  ]) });
  plan.push({ offset: versionLangOffset, buffer: dirBuffer([
    { name: 0x409, isDirectory: false, target: versionDataOffset },
  ]) });
  const versionData = Buffer.alloc(16);
  versionData.writeUInt32LE(versionInfo ? versionRva : 0, 0);
  versionData.writeUInt32LE(versionInfo ? versionInfo.length : 0, 4);
  plan.push({ offset: versionDataOffset, buffer: versionData });
  if (versionInfo) {
    plan.push({
      offset: payloadOffset + (pipl ? pipl.length : 0),
      buffer: versionInfo,
    });
  }

  const total = payloadOffset + (pipl ? pipl.length : 0) + (versionInfo ? versionInfo.length : 0);
  const section = Buffer.alloc(Math.max(total, 0x200));
  for (const { offset, buffer } of plan) buffer.copy(section, offset);
  return section;
}

function validPipl() {
  const body = Buffer.alloc(64);
  body.writeUInt16LE(0x0001, 0);
  body.writeUInt32LE(5, 6);
  body.write('MIB8dnikxgEAemangtacsrev4668', 10, 'ascii');
  const tail = Buffer.concat([
    body,
    Buffer.from('After Effects MCP Native\0General Plugin\0AeMcpNativeMain\0', 'ascii'),
  ]);
  return tail;
}

function validVersionInfo(productVersion = '9.9.9') {
  return Buffer.concat([
    Buffer.from('VS_VERSION_INFO\0', 'utf16le'),
    Buffer.from(productVersion, 'utf16le'),
    Buffer.from('\0', 'utf16le'),
  ]);
}

function buildPe({
  machine = 0x8664,
  characteristics = 0x2022,
  exportNames = [ENTRY],
  pipl = validPipl(),
  versionInfo = validVersionInfo(),
} = {}) {
  const dos = Buffer.alloc(0x80);
  dos.writeUInt16LE(0x5a4d, 0);
  dos.writeUInt32LE(0x80, 0x3c);

  const textRaw = Buffer.alloc(0x200);
  if (exportNames !== null) {
    textRaw.writeUInt32LE(exportNames.length, 20);
    textRaw.writeUInt32LE(exportNames.length, 24);
    textRaw.writeUInt32LE(0x1000 + 0x28, 32); // AddressOfNames
    exportNames.forEach((name, index) => {
      const stringOffset = 0x28 + exportNames.length * 4 + index * 0x20;
      textRaw.writeUInt32LE(0x1000 + stringOffset, 0x28 + index * 4);
      textRaw.write(name, stringOffset, 'ascii');
    });
  }
  const rsrcRaw = buildResourceTree({ pipl, versionInfo });

  const optionalSize = 240;
  const headerSize = 0x80 + 4 + 20 + optionalSize + 2 * 40;
  const textRawPointer = 0x200;
  const rsrcRawPointer = 0x400;
  const bytes = Buffer.alloc(0x400 + rsrcRaw.length);
  dos.copy(bytes, 0);

  const pe = 0x80;
  bytes.writeUInt32LE(0x00004550, pe);
  bytes.writeUInt16LE(machine, pe + 4);
  bytes.writeUInt16LE(2, pe + 6);
  bytes.writeUInt32LE(optionalSize, pe + 20);
  bytes.writeUInt16LE(characteristics, pe + 22);
  const optional = pe + 24;
  bytes.writeUInt16LE(0x20b, optional);
  if (exportNames !== null) {
    bytes.writeUInt32LE(0x1000, optional + 112);
    bytes.writeUInt32LE(0x200, optional + 116);
  }
  bytes.writeUInt32LE(0x2000, optional + 112 + 16);
  bytes.writeUInt32LE(rsrcRaw.length, optional + 112 + 20);

  let section = optional + optionalSize;
  bytes.write('.text', section, 'ascii');
  bytes.writeUInt32LE(0x200, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x200, section + 16);
  bytes.writeUInt32LE(textRawPointer, section + 20);
  section += 40;
  bytes.write('.rsrc', section, 'ascii');
  bytes.writeUInt32LE(rsrcRaw.length, section + 8);
  bytes.writeUInt32LE(0x2000, section + 12);
  bytes.writeUInt32LE(rsrcRaw.length, section + 16);
  bytes.writeUInt32LE(rsrcRawPointer, section + 20);

  textRaw.copy(bytes, textRawPointer);
  rsrcRaw.copy(bytes, rsrcRawPointer);
  assert.ok(headerSize <= textRawPointer);
  return bytes;
}

async function fixturePath(t, bytes, name = 'fixture.aex') {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-pe-fixture-'));
  t.after(() => fs.promises.rm(directory, { force: true, recursive: true }));
  const file = path.join(directory, name);
  await fs.promises.writeFile(file, bytes);
  return file;
}

test('windows aex verifier accepts a well-formed x64 plugin fixture', async (t) => {
  const artifact = await fixturePath(t, buildPe());
  const result = await verifyWindowsAex({ artifactPath: artifact });
  assert.equal(result.result, 'PASS');
  assert.equal(result.architecture, 'x64');
  assert.equal(result.entryExport, ENTRY);
  const bytes = await fs.promises.readFile(artifact);
  assert.equal(
    result.artifactSha256,
    crypto.createHash('sha256').update(bytes).digest('hex'),
  );
  assert.equal(result.receipt.sdk.claimedVersion, '25.6.61');
});

test('windows aex verifier rejects non-x64 architectures', async (t) => {
  for (const machine of [0x14c, 0xaa64]) {
    const artifact = await fixturePath(t, buildPe({ machine }));
    await assert.rejects(
      verifyWindowsAex({ artifactPath: artifact }),
      /unexpected PE machine/u,
    );
  }
});

test('windows aex verifier rejects non-DLL images and missing exports', async (t) => {
  const executable = await fixturePath(t, buildPe({ characteristics: 0x0102 }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: executable }),
    /not a DLL/u,
  );
  const noExports = await fixturePath(t, buildPe({ exportNames: null }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: noExports }),
    /no export directory/u,
  );
});

test('windows aex verifier rejects extra entry surface and wrong export names', async (t) => {
  const extra = await fixturePath(t, buildPe({ exportNames: [ENTRY, 'EvilExtra'] }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: extra }),
    /unexpected executable entry surface/u,
  );
  const renamed = await fixturePath(t, buildPe({ exportNames: ['NotTheEntry'] }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: renamed }),
    /unexpected entry export/u,
  );
});

test('windows aex verifier rejects missing or altered PiPL resources', async (t) => {
  const missing = await fixturePath(t, buildPe({ pipl: null }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: missing }),
    /PiPL resource 16000 is missing/u,
  );
  const altered = validPipl();
  altered[6] ^= 0xff; // corrupt the property-count word at offset 6
  await assert.rejects(
    verifyWindowsAex({ artifactPath: await fixturePath(t, buildPe({ pipl: altered })) }),
    /PiPL resource must declare exactly five properties/u,
  );
  const renamed = validPipl();
  const swapped = Buffer.from(renamed);
  swapped.write('After Effects MCP Renamed', swapped.indexOf('After Effects MCP Native'), 'ascii');
  await assert.rejects(
    verifyWindowsAex({ artifactPath: await fixturePath(t, buildPe({ pipl: swapped })) }),
    /identity marker/u,
  );
});

test('windows aex verifier binds the expected product version when provided', async (t) => {
  const matching = await fixturePath(t, buildPe({ versionInfo: validVersionInfo('1.2.3') }));
  const result = await verifyWindowsAex({
    artifactPath: matching,
    expectedProductVersion: '1.2.3',
  });
  assert.equal(result.result, 'PASS');
  const mismatched = await fixturePath(t, buildPe({ versionInfo: validVersionInfo('4.5.6') }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: mismatched, expectedProductVersion: '1.2.3' }),
    /does not bind the expected product version/u,
  );
});

test('windows aex verifier rejects truncated and non-PE inputs', async (t) => {
  const garbage = await fixturePath(t, Buffer.alloc(2048, 0x41));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: garbage }),
    /not a PE artifact/u,
  );
  const truncated = buildPe().subarray(0, 0x480);
  await assert.rejects(
    verifyWindowsAex({ artifactPath: await fixturePath(t, truncated) }),
    /truncated|does not map/u,
  );
});
