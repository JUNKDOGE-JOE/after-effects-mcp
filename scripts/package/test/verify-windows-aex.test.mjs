import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { verifyWindowsAex } from '../../../native/ae-plugin/verify-windows.mjs';

// The synthetic PE32+ fixture preserves the resource formats emitted by
// rc.exe, so malformed-resource tests exercise the parser rather than marker
// strings embedded in an arbitrary byte buffer.

const ENTRY = 'AeMcpNativeMain';
const SOURCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
const TEXT_RVA = 0x1000;
const TEXT_RAW_POINTER = 0x200;
const EXPORT_DIRECTORY_SIZE = 0x100;
const EXPORT_FUNCTIONS_OFFSET = 0x28;
const PIPL_PROPERTIES = [
  { vendor: 'MIB8', key: 'dnik', payload: Buffer.from('xgEA', 'ascii') },
  {
    vendor: 'MIB8',
    key: 'eman',
    payload: Buffer.from('\x18After Effects MCP Native\0\0\0', 'latin1'),
  },
  {
    vendor: 'MIB8',
    key: 'gtac',
    payload: Buffer.from('\x0eGeneral Plugin\0', 'latin1'),
  },
  { vendor: 'MIB8', key: 'srev', payload: Buffer.from([0x00, 0x00, 0x01, 0x00]) },
  { vendor: 'MIB8', key: '4668', payload: Buffer.from('AeMcpNativeMain\0', 'ascii') },
];

function align4(value) {
  return Math.ceil(value / 4) * 4;
}

function padding(length) {
  return Buffer.alloc(align4(length) - length);
}

function utf16z(value) {
  return Buffer.from(`${value}\0`, 'utf16le');
}

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

function piplProperty({ vendor, key, payload, reserved = 0, declaredLength }) {
  const header = Buffer.alloc(16);
  header.write(vendor, 0, 'latin1');
  header.write(key, 4, 'latin1');
  header.writeUInt32LE(reserved, 8);
  header.writeUInt32LE(declaredLength ?? payload.length, 12);
  return Buffer.concat([header, payload]);
}

function validPipl({
  version = 1,
  reserved = 0,
  properties = PIPL_PROPERTIES,
  propertyCount = properties.length,
  trailing = Buffer.alloc(0),
} = {}) {
  const header = Buffer.alloc(10);
  header.writeUInt16LE(version, 0);
  header.writeUInt32LE(reserved, 2);
  header.writeUInt32LE(propertyCount, 6);
  return Buffer.concat([header, ...properties.map(piplProperty), trailing]);
}

function versionBlock({ key, type, value = Buffer.alloc(0), children = [] }) {
  const keyBytes = utf16z(key);
  let body = Buffer.concat([Buffer.alloc(6), keyBytes]);
  body = Buffer.concat([body, padding(body.length), value]);
  if (children.length > 0) {
    body = Buffer.concat([body, padding(body.length)]);
    children.forEach((child, index) => {
      body = Buffer.concat([body, child]);
      if (index + 1 < children.length) body = Buffer.concat([body, padding(body.length)]);
    });
  }
  body.writeUInt16LE(body.length, 0);
  body.writeUInt16LE(type === 1 ? value.length / 2 : value.length, 2);
  body.writeUInt16LE(type, 4);
  return body;
}

function fixedFileInfo() {
  const value = Buffer.alloc(52);
  [
    0xfeef04bd,
    0x00010000,
    0x00010000,
    0,
    0x00010000,
    0,
    0x3f,
    0,
    0x00040004,
    2,
    0,
    0,
    0,
  ].forEach((field, index) => value.writeUInt32LE(field, index * 4));
  return value;
}

function versionString(key, value) {
  return versionBlock({ key, type: 1, value: utf16z(value) });
}

function validVersionInfo(productVersion = '9.9.9', options = {}) {
  const sourceCommit = options.sourceCommit ?? SOURCE_COMMIT;
  const strings = options.strings ?? [
    ['FileDescription', 'After Effects MCP Native'],
    ['OriginalFilename', 'AeMcpNative.aex'],
    ['ProductName', 'After Effects MCP Native'],
    ['ProductVersion', productVersion],
    ['SourceCommit', sourceCommit],
  ];
  const stringTable = versionBlock({
    key: '040904E4',
    type: 1,
    children: strings.map(([key, value]) => versionString(key, value)),
  });
  const stringFileInfo = versionBlock({
    key: 'StringFileInfo',
    type: 1,
    children: [stringTable],
  });
  const translation = Buffer.alloc(4);
  translation.writeUInt16LE(0x0409, 0);
  translation.writeUInt16LE(1252, 2);
  const varFileInfo = versionBlock({
    key: 'VarFileInfo',
    type: 1,
    children: [versionBlock({ key: 'Translation', type: 0, value: translation })],
  });
  return versionBlock({
    key: 'VS_VERSION_INFO',
    type: 0,
    value: fixedFileInfo(),
    children: options.rootChildren ?? [stringFileInfo, varFileInfo],
  });
}

function versionBlockOffset(bytes, key) {
  const keyOffset = bytes.indexOf(utf16z(key));
  assert.notEqual(keyOffset, -1, `missing fixture key ${key}`);
  return keyOffset - 6;
}

const IMPORT_DIRECTORY_OFFSET = 0x80;
const IMPORT_NAME_OFFSET = 0x100;

function buildPe({
  machine = 0x8664,
  characteristics = 0x2022,
  exportNames = [ENTRY],
  pipl = validPipl(),
  versionInfo = validVersionInfo(),
  importedDlls = null,
  textSectionName = '.text',
} = {}) {
  const dos = Buffer.alloc(0x80);
  dos.writeUInt16LE(0x5a4d, 0);
  dos.writeUInt32LE(0x80, 0x3c);

  const textRaw = Buffer.alloc(0x200);
  if (importedDlls !== null) {
    // One 20-byte descriptor per DLL plus a null terminator, with each module
    // name string packed after IMPORT_NAME_OFFSET in the same .text section.
    let descriptor = IMPORT_DIRECTORY_OFFSET;
    let nameCursor = IMPORT_NAME_OFFSET;
    for (const dll of importedDlls) {
      textRaw.writeUInt32LE(TEXT_RVA + nameCursor, descriptor + 12);
      textRaw.write(`${dll}\0`, nameCursor, 'ascii');
      descriptor += 20;
      nameCursor += dll.length + 1;
    }
  }
  if (exportNames !== null) {
    const functionsOffset = EXPORT_FUNCTIONS_OFFSET;
    const namesOffset = functionsOffset + exportNames.length * 4;
    const ordinalsOffset = namesOffset + exportNames.length * 4;
    const stringsOffset = align4(ordinalsOffset + exportNames.length * 2);
    textRaw.writeUInt32LE(1, 16);
    textRaw.writeUInt32LE(exportNames.length, 20);
    textRaw.writeUInt32LE(exportNames.length, 24);
    textRaw.writeUInt32LE(TEXT_RVA + functionsOffset, 28);
    textRaw.writeUInt32LE(TEXT_RVA + namesOffset, 32);
    textRaw.writeUInt32LE(TEXT_RVA + ordinalsOffset, 36);
    exportNames.forEach((name, index) => {
      const functionOffset = 0x180 + index * 4;
      const stringOffset = stringsOffset + index * 0x20;
      textRaw.writeUInt32LE(TEXT_RVA + functionOffset, functionsOffset + index * 4);
      textRaw.writeUInt32LE(TEXT_RVA + stringOffset, namesOffset + index * 4);
      textRaw.writeUInt16LE(index, ordinalsOffset + index * 2);
      textRaw.write(name, stringOffset, 'ascii');
      textRaw[functionOffset] = 0xc3;
    });
  }
  const rsrcRaw = buildResourceTree({ pipl, versionInfo });

  const optionalSize = 240;
  const headerSize = 0x80 + 4 + 20 + optionalSize + 2 * 40;
  const textRawPointer = TEXT_RAW_POINTER;
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
    bytes.writeUInt32LE(TEXT_RVA, optional + 112);
    bytes.writeUInt32LE(EXPORT_DIRECTORY_SIZE, optional + 116);
  }
  if (importedDlls !== null) {
    bytes.writeUInt32LE(TEXT_RVA + IMPORT_DIRECTORY_OFFSET, optional + 112 + 8);
    bytes.writeUInt32LE((importedDlls.length + 1) * 20, optional + 112 + 12);
  }
  bytes.writeUInt32LE(0x2000, optional + 112 + 16);
  bytes.writeUInt32LE(rsrcRaw.length, optional + 112 + 20);

  let section = optional + optionalSize;
  // textSectionName exercises the fixed-width 8-byte section-name field; the
  // static-CRT '.fptable' section fills all 8 bytes with no NUL terminator.
  bytes.write(textSectionName.slice(0, 8), section, 'ascii');
  bytes.writeUInt32LE(0x200, section + 8);
  bytes.writeUInt32LE(TEXT_RVA, section + 12);
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
  assert.equal(validPipl().length, 158);
  assert.equal(validVersionInfo('0.9.2').length, 632);
  const artifact = await fixturePath(t, buildPe());
  const result = await verifyWindowsAex({
    artifactPath: artifact,
    expectedCommit: SOURCE_COMMIT,
    expectedProductVersion: '9.9.9',
  });
  assert.equal(result.result, 'PASS');
  assert.equal(result.architecture, 'x64');
  assert.equal(result.entryExport, ENTRY);
  assert.equal(result.bytes, (await fs.promises.stat(artifact)).size);
  assert.equal(result.sourceCommit, SOURCE_COMMIT);
  assert.equal(result.productVersion, '9.9.9');
  assert.equal(result.receipt.sourceCommit, result.sourceCommit);
  assert.equal(result.receipt.productVersion, result.productVersion);
  const bytes = await fs.promises.readFile(artifact);
  assert.equal(
    result.artifactSha256,
    crypto.createHash('sha256').update(bytes).digest('hex'),
  );
  assert.equal(result.receipt.sdk.claimedVersion, '25.6.61');
});

test('windows aex verifier accepts OS-only imports (static CRT build)', async (t) => {
  const artifact = await fixturePath(t, buildPe({
    importedDlls: ['KERNEL32.dll', 'USER32.dll', 'bcrypt.dll'],
  }));
  const result = await verifyWindowsAex({ artifactPath: artifact });
  assert.equal(result.result, 'PASS');
});

test('windows aex verifier rejects a dynamic C runtime import (/MD regression)', async (t) => {
  for (const crt of ['MSVCP140.dll', 'VCRUNTIME140.dll', 'ucrtbase.dll', 'api-ms-win-crt-runtime-l1-1-0.dll']) {
    const artifact = await fixturePath(t, buildPe({
      importedDlls: ['KERNEL32.dll', crt],
    }));
    await assert.rejects(
      verifyWindowsAex({ artifactPath: artifact }),
      (error) => error.code === 'AE_PLUGIN_VERIFY_FAILED' && /static CRT/u.test(error.message),
      `expected rejection for ${crt}`,
    );
  }
});

test('windows aex verifier accepts a full 8-byte section name (static-CRT .fptable)', async (t) => {
  // A NUL-terminated read of an 8-char section name would overrun into the
  // next field and previously failed as "unbounded string" — the /MT link's
  // '.fptable' section triggers exactly this. Names use up to 8 bytes.
  const artifact = await fixturePath(t, buildPe({ textSectionName: '.fptable' }));
  const result = await verifyWindowsAex({ artifactPath: artifact });
  assert.equal(result.result, 'PASS');
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

test('windows aex verifier validates every export address table and the function RVA', async (t) => {
  const directory = TEXT_RAW_POINTER;
  const functions = TEXT_RAW_POINTER + EXPORT_FUNCTIONS_OFFSET;
  const names = functions + 4;
  const ordinals = names + 4;
  const cases = [
    ['functions-zero', (bytes) => bytes.writeUInt32LE(0, directory + 28), /address tables/u],
    ['functions-unmapped', (bytes) => bytes.writeUInt32LE(0x70000000, directory + 28), /function table RVA/u],
    ['names-zero', (bytes) => bytes.writeUInt32LE(0, directory + 32), /address tables/u],
    ['names-unmapped', (bytes) => bytes.writeUInt32LE(0x70000000, directory + 32), /name table RVA/u],
    ['ordinals-zero', (bytes) => bytes.writeUInt32LE(0, directory + 36), /address tables/u],
    ['ordinals-unmapped', (bytes) => bytes.writeUInt32LE(0x70000000, directory + 36), /ordinal table RVA/u],
    ['ordinal-out-of-bounds', (bytes) => bytes.writeUInt16LE(1, ordinals), /ordinal/u],
    ['function-null', (bytes) => bytes.writeUInt32LE(0, functions), /null function RVA/u],
    ['function-unmapped', (bytes) => bytes.writeUInt32LE(0x70000000, functions), /function RVA/u],
    ['function-forwarder', (bytes) => bytes.writeUInt32LE(TEXT_RVA + 0x80, functions), /forwarded export/u],
  ];
  for (const [name, mutate, expected] of cases) {
    const bytes = buildPe();
    mutate(bytes);
    const artifact = await fixturePath(t, bytes, `${name}.aex`);
    await assert.rejects(verifyWindowsAex({ artifactPath: artifact }), expected);
  }
});

test('windows aex verifier rejects missing and malformed PiPL headers', async (t) => {
  const missing = await fixturePath(t, buildPe({ pipl: null }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: missing }),
    /PiPL resource 16000 is missing/u,
  );

  for (const [name, pipl] of [
    ['version', validPipl({ version: 2 })],
    ['reserved', validPipl({ reserved: 1 })],
    ['missing', validPipl({ properties: PIPL_PROPERTIES.slice(0, 4) })],
    [
      'missing-record',
      validPipl({ properties: PIPL_PROPERTIES.slice(0, 4), propertyCount: 5 }),
    ],
    ['extra', validPipl({ properties: [...PIPL_PROPERTIES, PIPL_PROPERTIES[0]] })],
    [
      'extra-record',
      validPipl({ properties: [...PIPL_PROPERTIES, PIPL_PROPERTIES[0]], propertyCount: 5 }),
    ],
  ]) {
    const artifact = await fixturePath(t, buildPe({ pipl }), `${name}.aex`);
    await assert.rejects(verifyWindowsAex({ artifactPath: artifact }), /PiPL/u);
  }
});

test('windows aex verifier rejects invalid PiPL property records and identity payloads', async (t) => {
  const invalidVendor = [
    { ...PIPL_PROPERTIES[0], vendor: 'EVIL' },
    ...PIPL_PROPERTIES.slice(1),
  ];
  const invalidReserved = [
    { ...PIPL_PROPERTIES[0], reserved: 1 },
    ...PIPL_PROPERTIES.slice(1),
  ];
  const invalidLength = [
    { ...PIPL_PROPERTIES[0], declaredLength: 3 },
    ...PIPL_PROPERTIES.slice(1),
  ];
  const outOfBounds = [
    { ...PIPL_PROPERTIES[0], declaredLength: 0xfffc },
    ...PIPL_PROPERTIES.slice(1),
  ];
  const alteredName = Buffer.from(PIPL_PROPERTIES[1].payload);
  alteredName[alteredName.indexOf('Native')] ^= 0x01;
  const invalidIdentity = [
    PIPL_PROPERTIES[0],
    { ...PIPL_PROPERTIES[1], payload: alteredName },
    ...PIPL_PROPERTIES.slice(2),
  ];
  const duplicate = [
    ...PIPL_PROPERTIES.slice(0, 4),
    PIPL_PROPERTIES[0],
  ];
  for (const [name, pipl] of [
    ['vendor', validPipl({ properties: invalidVendor })],
    ['reserved', validPipl({ properties: invalidReserved })],
    ['unaligned-length', validPipl({ properties: invalidLength })],
    ['out-of-bounds', validPipl({ properties: outOfBounds })],
    ['identity', validPipl({ properties: invalidIdentity })],
    ['duplicate', validPipl({ properties: duplicate })],
    ['trailing', validPipl({ trailing: Buffer.from([0]) })],
  ]) {
    const artifact = await fixturePath(t, buildPe({ pipl }), `${name}.aex`);
    await assert.rejects(verifyWindowsAex({ artifactPath: artifact }), /PiPL/u);
  }
});

test('windows aex verifier rejects PiPL identity markers outside real properties', async (t) => {
  const header = Buffer.alloc(10);
  header.writeUInt16LE(1, 0);
  header.writeUInt32LE(5, 6);
  const markers = Buffer.from([
    'MIB8',
    'dnik',
    'xgEA',
    'eman',
    'gtac',
    'srev',
    '4668',
    'After Effects MCP Native',
    'General Plugin',
    'AeMcpNativeMain',
  ].join(''), 'ascii');
  const artifact = await fixturePath(t, buildPe({
    pipl: Buffer.concat([header, markers]),
  }));
  await assert.rejects(verifyWindowsAex({ artifactPath: artifact }), /PiPL/u);
});

test('windows aex verifier binds the parsed ProductVersion value', async (t) => {
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

  const decoy = validVersionInfo('4.5.6', {
    strings: [
      ['FileDescription', 'After Effects MCP Native 1.2.3'],
      ['OriginalFilename', 'AeMcpNative.aex'],
      ['ProductName', 'After Effects MCP Native'],
      ['ProductVersion', '4.5.6'],
      ['SourceCommit', SOURCE_COMMIT],
    ],
  });
  assert.notEqual(decoy.indexOf(Buffer.from('1.2.3', 'utf16le')), -1);
  const decoyArtifact = await fixturePath(t, buildPe({ versionInfo: decoy }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: decoyArtifact, expectedProductVersion: '1.2.3' }),
    /does not bind the expected product version/u,
  );
});

test('windows aex verifier binds one strict parsed SourceCommit value', async (t) => {
  const matching = await fixturePath(t, buildPe());
  const result = await verifyWindowsAex({
    artifactPath: matching,
    expectedCommit: SOURCE_COMMIT,
  });
  assert.equal(result.sourceCommit, SOURCE_COMMIT);
  assert.equal(result.receipt.sourceCommit, SOURCE_COMMIT);

  const differentCommit = 'f'.repeat(40);
  const mismatch = await fixturePath(t, buildPe({
    versionInfo: validVersionInfo('9.9.9', { sourceCommit: differentCommit }),
  }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: mismatch, expectedCommit: SOURCE_COMMIT }),
    /does not bind the expected source commit/u,
  );

  const decoy = validVersionInfo('9.9.9', {
    sourceCommit: differentCommit,
    strings: [
      ['FileDescription', `After Effects MCP Native ${SOURCE_COMMIT}`],
      ['ProductVersion', '9.9.9'],
      ['SourceCommit', differentCommit],
    ],
  });
  const decoyArtifact = await fixturePath(t, buildPe({ versionInfo: decoy }));
  await assert.rejects(
    verifyWindowsAex({ artifactPath: decoyArtifact, expectedCommit: SOURCE_COMMIT }),
    /does not bind the expected source commit/u,
  );
});

test('windows aex verifier rejects missing, duplicate, and malformed SourceCommit values', async (t) => {
  const variants = [
    ['missing', validVersionInfo('9.9.9', {
      strings: [['ProductVersion', '9.9.9']],
    })],
    ['duplicate', validVersionInfo('9.9.9', {
      strings: [
        ['ProductVersion', '9.9.9'],
        ['SourceCommit', SOURCE_COMMIT],
        ['SourceCommit', 'f'.repeat(40)],
      ],
    })],
    ['uppercase', validVersionInfo('9.9.9', { sourceCommit: SOURCE_COMMIT.toUpperCase() })],
    ['short', validVersionInfo('9.9.9', { sourceCommit: SOURCE_COMMIT.slice(1) })],
    ['non-hex', validVersionInfo('9.9.9', { sourceCommit: `${SOURCE_COMMIT.slice(0, 39)}g` })],
  ];
  for (const [name, versionInfo] of variants) {
    const artifact = await fixturePath(t, buildPe({ versionInfo }), `${name}.aex`);
    await assert.rejects(verifyWindowsAex({ artifactPath: artifact }), /SourceCommit|duplicate/u);
  }
});

test('windows aex verifier rejects malformed VERSIONINFO headers and fixed values', async (t) => {
  const wrongLength = validVersionInfo();
  wrongLength.writeUInt16LE(wrongLength.length - 1, 0);
  const wrongValueLength = validVersionInfo();
  wrongValueLength.writeUInt16LE(50, 2);
  const wrongType = validVersionInfo();
  wrongType.writeUInt16LE(1, 4);
  const wrongKey = validVersionInfo();
  wrongKey.writeUInt16LE('X'.charCodeAt(0), 6);
  const wrongPadding = validVersionInfo();
  wrongPadding[38] = 1;
  const wrongFixedSignature = validVersionInfo();
  wrongFixedSignature.writeUInt32LE(0, 40);
  for (const [name, versionInfo] of [
    ['length', wrongLength],
    ['value-length', wrongValueLength],
    ['type', wrongType],
    ['key', wrongKey],
    ['padding', wrongPadding],
    ['fixed-signature', wrongFixedSignature],
  ]) {
    const artifact = await fixturePath(t, buildPe({ versionInfo }), `${name}.aex`);
    await assert.rejects(verifyWindowsAex({ artifactPath: artifact }), /VERSION|VS_/u);
  }
});

test('windows aex verifier rejects malformed VERSIONINFO children and duplicate keys', async (t) => {
  const childLength = validVersionInfo();
  childLength.writeUInt16LE(7, versionBlockOffset(childLength, 'StringFileInfo'));
  const valueLength = validVersionInfo();
  const productOffset = versionBlockOffset(valueLength, 'ProductVersion');
  valueLength.writeUInt16LE(valueLength.readUInt16LE(productOffset + 2) + 1, productOffset + 2);
  const childPadding = validVersionInfo();
  const descriptionOffset = versionBlockOffset(childPadding, 'FileDescription');
  const descriptionEnd = descriptionOffset + childPadding.readUInt16LE(descriptionOffset);
  childPadding[descriptionEnd] = 1;
  const duplicate = validVersionInfo('1.2.3', {
    strings: [
      ['FileDescription', 'After Effects MCP Native'],
      ['ProductVersion', '1.2.3'],
      ['ProductVersion', '9.9.9'],
      ['SourceCommit', SOURCE_COMMIT],
    ],
  });
  const missing = validVersionInfo('1.2.3', {
    strings: [
      ['FileDescription', 'After Effects MCP Native 1.2.3'],
      ['SourceCommit', SOURCE_COMMIT],
    ],
  });
  const trailing = Buffer.concat([validVersionInfo(), Buffer.from('9.9.9', 'utf16le')]);
  for (const [name, versionInfo] of [
    ['child-length', childLength],
    ['value-length', valueLength],
    ['child-padding', childPadding],
    ['duplicate', duplicate],
    ['missing', missing],
    ['trailing', trailing],
  ]) {
    const artifact = await fixturePath(t, buildPe({ versionInfo }), `${name}.aex`);
    await assert.rejects(verifyWindowsAex({ artifactPath: artifact }), /VERSION|String/u);
  }
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
