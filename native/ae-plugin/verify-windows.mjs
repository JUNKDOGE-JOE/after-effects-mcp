#!/usr/bin/env node

// Windows .aex (PE32+ DLL) verifier for the AeMcpNative AEGP plug-in.
// Parses PE headers, the export table, and the resource tree without
// third-party dependencies, and fails closed on every mismatch: wrong
// architecture, missing/extra exports, missing or altered PiPL resource,
// missing product-version or source-revision binding. Emits the canonical
// verification receipt.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const EXPECTED_MACHINE_X64 = 0x8664;
const EXPECTED_ENTRY_EXPORT = 'AeMcpNativeMain';
const PIPL_RESOURCE_TYPE = 'PiPL';
const PIPL_RESOURCE_ID = 16000;
const RT_VERSION = 16;
const MAX_PE_BYTES = 64 * 1024 * 1024;
const MAX_SECTIONS = 96;
const MAX_RESOURCE_NODES = 4096;
const PIPL_HEADER_BYTES = 10;
const PIPL_PROPERTY_HEADER_BYTES = 16;
const VS_FIXED_FILE_INFO_BYTES = 52;
const VS_FIXED_FILE_INFO_SIGNATURE = 0xfeef04bd;
const VERSION_STRING_TABLE_KEY = '040904E4';
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const PIPL_PROPERTIES = new Map([
  ['dnik', { label: 'Kind', payload: Buffer.from('xgEA', 'ascii') }],
  [
    'eman',
    {
      label: 'Name',
      payload: Buffer.from('\x18After Effects MCP Native\0\0\0', 'latin1'),
    },
  ],
  [
    'gtac',
    {
      label: 'Category',
      payload: Buffer.from('\x0eGeneral Plugin\0', 'latin1'),
    },
  ],
  ['srev', { label: 'Version', payload: Buffer.from([0x00, 0x00, 0x01, 0x00]) }],
  ['4668', { label: 'CodeWin64', payload: Buffer.from('AeMcpNativeMain\0', 'ascii') }],
]);
const CLI_USAGE = `Usage: node native/ae-plugin/verify-windows.mjs --artifact <absolute-path> \\
  [--output <receipt-path>] [--product-version <x.y.z>]
`;

function verifyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fail(message) {
  throw verifyError('AE_PLUGIN_VERIFY_FAILED', message);
}

function normalizeVerifyError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('AE_')) return error;
  return verifyError('AE_PLUGIN_VERIFY_IO_FAILED', 'artifact access failed during verification');
}

function align4(value) {
  return Math.ceil(value / 4) * 4;
}

function assertRange(bytes, offset, size, label, limit = bytes.length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size)
      || offset < 0 || size < 0 || limit < 0 || limit > bytes.length
      || offset > limit - size) {
    fail(`truncated ${label}`);
  }
}

function assertZeroPadding(bytes, start, end, label) {
  assertRange(bytes, start, end - start, label);
  for (let offset = start; offset < end; offset += 1) {
    if (bytes[offset] !== 0) fail(`${label} must be zero-filled`);
  }
}

function readAscii(bytes, offset, maximum = 260) {
  let end = offset;
  while (end < bytes.length && end - offset < maximum && bytes[end] !== 0) end += 1;
  if (end - offset >= maximum) fail('unbounded string in PE structure');
  return bytes.subarray(offset, end).toString('ascii');
}

function parsePeHeaders(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    fail('not a PE artifact (MZ header missing)');
  }
  const peStart = bytes.readUInt32LE(0x3c);
  if (peStart < 0x40 || peStart + 24 > bytes.length
      || bytes.readUInt32LE(peStart) !== 0x00004550) {
    fail('not a PE artifact (PE signature missing)');
  }
  const machine = bytes.readUInt16LE(peStart + 4);
  const sectionCount = bytes.readUInt16LE(peStart + 6);
  const optionalSize = bytes.readUInt16LE(peStart + 20);
  const characteristics = bytes.readUInt16LE(peStart + 22);
  if (sectionCount < 1 || sectionCount > MAX_SECTIONS) fail('implausible PE section count');
  const optionalStart = peStart + 24;
  if (optionalStart + optionalSize > bytes.length) fail('truncated PE optional header');
  const magic = bytes.readUInt16LE(optionalStart);
  if (magic !== 0x20b) fail('not a PE32+ (64-bit) optional header');
  const exportRva = bytes.readUInt32LE(optionalStart + 112);
  const exportSize = bytes.readUInt32LE(optionalStart + 116);
  const resourceRva = bytes.readUInt32LE(optionalStart + 112 + 16);
  const resourceSize = bytes.readUInt32LE(optionalStart + 112 + 20);
  const sections = [];
  let cursor = optionalStart + optionalSize;
  for (let index = 0; index < sectionCount; index += 1, cursor += 40) {
    if (cursor + 40 > bytes.length) fail('truncated PE section table');
    const name = readAscii(bytes, cursor, 8);
    sections.push({
      name,
      virtualSize: bytes.readUInt32LE(cursor + 8),
      virtualAddress: bytes.readUInt32LE(cursor + 12),
      rawSize: bytes.readUInt32LE(cursor + 16),
      rawPointer: bytes.readUInt32LE(cursor + 20),
    });
  }
  return {
    machine,
    characteristics,
    sections,
    export: { rva: exportRva, size: exportSize },
    resource: { rva: resourceRva, size: resourceSize },
  };
}

function rvaToOffset(headers, rva, size, label) {
  if (rva === 0) return null;
  for (const section of headers.sections) {
    const span = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva + size <= section.virtualAddress + span) {
      const offset = section.rawPointer + (rva - section.virtualAddress);
      return offset;
    }
  }
  fail(`${label} RVA does not map into any section`);
}

function parseExports(bytes, headers) {
  if (headers.export.rva === 0) fail('PE artifact has no export directory');
  if (headers.export.size < 40) fail('PE export directory is truncated');
  const offset = rvaToOffset(
    headers,
    headers.export.rva,
    headers.export.size,
    'export directory',
  );
  if (offset + 40 > bytes.length) fail('truncated export directory');
  const functionCount = bytes.readUInt32LE(offset + 20);
  const nameCount = bytes.readUInt32LE(offset + 24);
  const functionsRva = bytes.readUInt32LE(offset + 28);
  const namesRva = bytes.readUInt32LE(offset + 32);
  const ordinalsRva = bytes.readUInt32LE(offset + 36);
  if (functionCount !== 1 || nameCount !== 1) {
    fail(`unexpected executable entry surface: ${functionCount} function(s), ${nameCount} name(s)`);
  }
  if (functionsRva === 0 || namesRva === 0 || ordinalsRva === 0) {
    fail('export address tables must all be present');
  }
  const functionsOffset = rvaToOffset(headers, functionsRva, 4, 'export function table');
  const namesOffset = rvaToOffset(headers, namesRva, 4, 'export name table');
  const ordinalsOffset = rvaToOffset(headers, ordinalsRva, 2, 'export ordinal table');
  if (functionsOffset + 4 > bytes.length
      || namesOffset + 4 > bytes.length
      || ordinalsOffset + 2 > bytes.length) {
    fail('truncated export address tables');
  }
  const ordinal = bytes.readUInt16LE(ordinalsOffset);
  if (ordinal >= functionCount || ordinal !== 0) {
    fail('export name ordinal must select bounded function index 0');
  }
  const functionRva = bytes.readUInt32LE(functionsOffset + ordinal * 4);
  if (functionRva === 0) fail('entry export has a null function RVA');
  const exportEnd = headers.export.rva + headers.export.size;
  if (functionRva >= headers.export.rva && functionRva < exportEnd) {
    fail('entry export must not be a forwarded export');
  }
  const functionOffset = rvaToOffset(headers, functionRva, 1, 'entry export function');
  if (functionOffset >= bytes.length) fail('truncated entry export function');
  const nameRva = bytes.readUInt32LE(namesOffset);
  const nameOffset = rvaToOffset(headers, nameRva, EXPECTED_ENTRY_EXPORT.length + 1, 'export name');
  const name = readAscii(bytes, nameOffset);
  if (name !== EXPECTED_ENTRY_EXPORT) {
    fail(`unexpected entry export: ${JSON.stringify(name)}`);
  }
  return name;
}

function resourceDirectoryEntries(bytes, base, offset, depth, budget) {
  if (depth > 8 || budget.count >= MAX_RESOURCE_NODES) fail('resource tree is not bounded');
  budget.count += 1;
  if (offset + 16 > bytes.length) fail('truncated resource directory');
  const named = bytes.readUInt16LE(offset + 12);
  const ids = bytes.readUInt16LE(offset + 14);
  const entries = [];
  let cursor = offset + 16;
  const total = named + ids;
  if (total > 256) fail('resource directory entry count is not bounded');
  for (let index = 0; index < total; index += 1, cursor += 8) {
    if (cursor + 8 > bytes.length) fail('truncated resource directory entry');
    const rawName = bytes.readUInt32LE(cursor);
    const rawTarget = bytes.readUInt32LE(cursor + 4);
    let name;
    if ((rawName & 0x80000000) !== 0) {
      const stringOffset = base + (rawName & 0x7fffffff);
      if (stringOffset + 2 > bytes.length) fail('truncated resource type string');
      const length = bytes.readUInt16LE(stringOffset);
      if (length > 64 || stringOffset + 2 + length * 2 > bytes.length) {
        fail('resource type string is not bounded');
      }
      name = bytes.subarray(stringOffset + 2, stringOffset + 2 + length * 2)
        .toString('utf16le');
    } else {
      name = rawName & 0xffff;
    }
    entries.push({
      name,
      isDirectory: (rawTarget & 0x80000000) !== 0,
      target: rawTarget & 0x7fffffff,
    });
  }
  return entries;
}

function findResource(bytes, headers, typeName, resourceId) {
  if (headers.resource.rva === 0) fail('PE artifact has no resource section');
  const base = rvaToOffset(headers, headers.resource.rva, 16, 'resource root');
  const budget = { count: 0 };
  const types = resourceDirectoryEntries(bytes, base, base, 0, budget);
  // rc.exe uppercases custom string type names ("PiPL" compiles to "PIPL").
  const type = typeof typeName === 'string'
    ? types.find((entry) => typeof entry.name === 'string'
        && entry.name.toUpperCase() === typeName.toUpperCase())
    : types.find((entry) => entry.name === typeName);
  if (!type?.isDirectory) return null;
  const ids = resourceDirectoryEntries(bytes, base, base + type.target, 1, budget);
  const id = ids.find((entry) => entry.name === resourceId);
  if (!id?.isDirectory) return null;
  const languages = resourceDirectoryEntries(bytes, base, base + id.target, 2, budget);
  if (languages.length !== 1 || languages[0].isDirectory) {
    fail('resource must resolve to exactly one language entry');
  }
  const dataOffset = base + languages[0].target;
  if (dataOffset + 16 > bytes.length) fail('truncated resource data entry');
  const dataRva = bytes.readUInt32LE(dataOffset);
  const dataSize = bytes.readUInt32LE(dataOffset + 4);
  if (dataSize < 16 || dataSize > 64 * 1024) fail('resource payload is not bounded');
  const dataStart = rvaToOffset(headers, dataRva, dataSize, 'resource payload');
  if (dataStart + dataSize > bytes.length) fail('truncated resource payload');
  return bytes.subarray(dataStart, dataStart + dataSize);
}

function assertPiplResource(bytes) {
  assertRange(bytes, 0, PIPL_HEADER_BYTES, 'PiPL header');
  if (bytes.readUInt16LE(0) !== 0x0001) fail('PiPL resource version word mismatch');
  if (bytes.readUInt32LE(2) !== 0) fail('PiPL resource header reserved field must be zero');
  const propertyCount = bytes.readUInt32LE(6);
  if (propertyCount !== PIPL_PROPERTIES.size) {
    fail('PiPL resource must declare exactly five properties');
  }

  const seen = new Set();
  let cursor = PIPL_HEADER_BYTES;
  for (let index = 0; index < propertyCount; index += 1) {
    if ((cursor - PIPL_HEADER_BYTES) % 4 !== 0) {
      fail('PiPL property header is not aligned');
    }
    assertRange(bytes, cursor, PIPL_PROPERTY_HEADER_BYTES, 'PiPL property header');
    if (!bytes.subarray(cursor, cursor + 4).equals(Buffer.from('MIB8', 'ascii'))) {
      fail('PiPL property vendor must be 8BIM');
    }
    const key = bytes.subarray(cursor + 4, cursor + 8).toString('latin1');
    const expected = PIPL_PROPERTIES.get(key);
    if (!expected) fail(`PiPL resource has unexpected property key ${JSON.stringify(key)}`);
    if (seen.has(key)) fail(`PiPL resource has duplicate ${expected.label} property`);
    if (bytes.readUInt32LE(cursor + 8) !== 0) {
      fail(`PiPL ${expected.label} property reserved field must be zero`);
    }
    const payloadLength = bytes.readUInt32LE(cursor + 12);
    if (payloadLength === 0 || payloadLength % 4 !== 0) {
      fail(`PiPL ${expected.label} property payload length is not aligned`);
    }
    const payloadStart = cursor + PIPL_PROPERTY_HEADER_BYTES;
    assertRange(bytes, payloadStart, payloadLength, `PiPL ${expected.label} property payload`);
    const payload = bytes.subarray(payloadStart, payloadStart + payloadLength);
    if (payloadLength !== expected.payload.length || !payload.equals(expected.payload)) {
      fail(`PiPL ${expected.label} property payload is invalid`);
    }
    seen.add(key);
    cursor = payloadStart + payloadLength;
  }
  if (seen.size !== PIPL_PROPERTIES.size) fail('PiPL resource is missing a required property');
  if (cursor !== bytes.length) fail('PiPL resource has trailing data');
}

function readVersionKey(bytes, start, end, label) {
  if (start % 2 !== 0) fail(`${label} key is not UTF-16 aligned`);
  let cursor = start;
  let codeUnits = 0;
  while (cursor + 2 <= end && codeUnits <= 128) {
    if (bytes.readUInt16LE(cursor) === 0) {
      return {
        key: bytes.subarray(start, cursor).toString('utf16le'),
        end: cursor + 2,
      };
    }
    cursor += 2;
    codeUnits += 1;
  }
  fail(`${label} key is missing a bounded UTF-16 terminator`);
}

function parseVersionBlock(bytes, start, limit, label) {
  if (start % 4 !== 0) fail(`${label} is not DWORD aligned`);
  assertRange(bytes, start, 6, `${label} header`, limit);
  const length = bytes.readUInt16LE(start);
  const valueLength = bytes.readUInt16LE(start + 2);
  const type = bytes.readUInt16LE(start + 4);
  if (length < 8) fail(`${label} length is invalid`);
  const end = start + length;
  if (end > limit) fail(`${label} length exceeds its parent`);
  if (type !== 0 && type !== 1) fail(`${label} type is invalid`);
  const parsedKey = readVersionKey(bytes, start + 6, end, label);
  const valueStart = align4(parsedKey.end);
  if (valueStart > end) fail(`${label} key padding exceeds the block`);
  assertZeroPadding(bytes, parsedKey.end, valueStart, `${label} key padding`);
  const valueBytes = type === 1 ? valueLength * 2 : valueLength;
  assertRange(bytes, valueStart, valueBytes, `${label} value`, end);
  return {
    start,
    end,
    key: parsedKey.key,
    type,
    valueLength,
    valueStart,
    valueEnd: valueStart + valueBytes,
  };
}

function versionChildrenStart(bytes, block, label) {
  const start = align4(block.valueEnd);
  if (start > block.end) fail(`${label} value padding exceeds the block`);
  assertZeroPadding(bytes, block.valueEnd, start, `${label} value padding`);
  return start;
}

function parseVersionChildren(bytes, start, end, label) {
  const children = new Map();
  let cursor = start;
  while (cursor < end) {
    const child = parseVersionBlock(bytes, cursor, end, `${label} child`);
    if (children.has(child.key)) fail(`${label} has duplicate child key ${JSON.stringify(child.key)}`);
    children.set(child.key, child);
    cursor = child.end;
    if (cursor < end) {
      const aligned = align4(cursor);
      if (aligned > end) fail(`${label} child alignment exceeds the block`);
      assertZeroPadding(bytes, cursor, aligned, `${label} child padding`);
      cursor = aligned;
    }
  }
  if (cursor !== end) fail(`${label} children do not fill the block`);
  return children;
}

function assertFixedFileInfo(bytes, block) {
  if (block.type !== 0 || block.valueLength !== VS_FIXED_FILE_INFO_BYTES) {
    fail('VS_VERSION_INFO must contain one VS_FIXEDFILEINFO value');
  }
  const expectedFields = [
    [0, VS_FIXED_FILE_INFO_SIGNATURE, 'signature'],
    [4, 0x00010000, 'structure version'],
    [8, 0x00010000, 'file version MS'],
    [12, 0, 'file version LS'],
    [16, 0x00010000, 'product version MS'],
    [20, 0, 'product version LS'],
    [24, 0x3f, 'file flags mask'],
    [28, 0, 'file flags'],
    [32, 0x00040004, 'file OS'],
    [36, 2, 'file type'],
    [40, 0, 'file subtype'],
    [44, 0, 'file date MS'],
    [48, 0, 'file date LS'],
  ];
  for (const [offset, expected, label] of expectedFields) {
    if (bytes.readUInt32LE(block.valueStart + offset) !== expected) {
      fail(`VS_FIXEDFILEINFO ${label} mismatch`);
    }
  }
}

function readVersionString(bytes, block, label) {
  if (block.type !== 1 || block.valueLength < 1 || block.valueEnd !== block.end) {
    fail(`${label} must contain exactly one UTF-16 string value`);
  }
  if (bytes.readUInt16LE(block.valueEnd - 2) !== 0) {
    fail(`${label} string value is not terminated`);
  }
  for (let cursor = block.valueStart; cursor < block.valueEnd - 2; cursor += 2) {
    if (bytes.readUInt16LE(cursor) === 0) fail(`${label} string value has embedded data after NUL`);
  }
  return bytes.subarray(block.valueStart, block.valueEnd - 2).toString('utf16le');
}

function parseStringFileInfo(bytes, block) {
  if (block.type !== 1 || block.valueLength !== 0) {
    fail('StringFileInfo block header is invalid');
  }
  const tables = parseVersionChildren(
    bytes,
    versionChildrenStart(bytes, block, 'StringFileInfo'),
    block.end,
    'StringFileInfo',
  );
  if (tables.size !== 1 || !tables.has(VERSION_STRING_TABLE_KEY)) {
    fail(`StringFileInfo must contain exactly the ${VERSION_STRING_TABLE_KEY} StringTable`);
  }
  const table = tables.get(VERSION_STRING_TABLE_KEY);
  if (table.type !== 1 || table.valueLength !== 0) fail('StringTable block header is invalid');
  const strings = parseVersionChildren(
    bytes,
    versionChildrenStart(bytes, table, 'StringTable'),
    table.end,
    'StringTable',
  );
  if (!strings.has('ProductVersion')) fail('StringTable ProductVersion value is missing');
  if (!strings.has('SourceCommit')) fail('StringTable SourceCommit value is missing');
  let productVersion = null;
  let sourceCommit = null;
  for (const [key, entry] of strings) {
    const value = readVersionString(bytes, entry, `StringTable ${JSON.stringify(key)}`);
    if (key === 'ProductVersion') productVersion = value;
    if (key === 'SourceCommit') sourceCommit = value;
  }
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    fail('StringTable SourceCommit must be exactly 40 lowercase hexadecimal characters');
  }
  return { productVersion, sourceCommit };
}

function assertVarFileInfo(bytes, block) {
  if (block.type !== 1 || block.valueLength !== 0) fail('VarFileInfo block header is invalid');
  const variables = parseVersionChildren(
    bytes,
    versionChildrenStart(bytes, block, 'VarFileInfo'),
    block.end,
    'VarFileInfo',
  );
  if (variables.size !== 1 || !variables.has('Translation')) {
    fail('VarFileInfo must contain exactly one Translation value');
  }
  const translation = variables.get('Translation');
  if (translation.type !== 0 || translation.valueLength !== 4
      || translation.valueEnd !== translation.end
      || bytes.readUInt16LE(translation.valueStart) !== 0x0409
      || bytes.readUInt16LE(translation.valueStart + 2) !== 1252) {
    fail('VarFileInfo Translation value is invalid');
  }
}

function assertVersionResource(bytes, expectedProductVersion, expectedCommit) {
  const root = parseVersionBlock(bytes, 0, bytes.length, 'VS_VERSION_INFO');
  if (root.end !== bytes.length || root.key !== 'VS_VERSION_INFO') {
    fail('VERSIONINFO root block is invalid or has trailing data');
  }
  assertFixedFileInfo(bytes, root);
  const children = parseVersionChildren(
    bytes,
    versionChildrenStart(bytes, root, 'VS_VERSION_INFO'),
    root.end,
    'VS_VERSION_INFO',
  );
  if (children.size !== 2
      || !children.has('StringFileInfo') || !children.has('VarFileInfo')) {
    fail('VS_VERSION_INFO must contain StringFileInfo and VarFileInfo');
  }
  const identity = parseStringFileInfo(bytes, children.get('StringFileInfo'));
  assertVarFileInfo(bytes, children.get('VarFileInfo'));
  if (typeof expectedProductVersion === 'string' && expectedProductVersion.length > 0
      && identity.productVersion !== expectedProductVersion) {
    fail('VERSIONINFO resource does not bind the expected product version');
  }
  if (expectedCommit !== undefined && identity.sourceCommit !== expectedCommit) {
    fail('VERSIONINFO resource does not bind the expected source commit');
  }
  return identity;
}

export async function verifyWindowsAex(input) {
  try {
    const artifactPath = input?.artifactPath;
    if (typeof artifactPath !== 'string' || !path.isAbsolute(artifactPath)) {
      throw verifyError('AE_PLUGIN_ARGUMENT_INVALID', '--artifact must be an absolute path');
    }
    const stats = await fs.promises.lstat(artifactPath).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink()
        || stats.size < 1024 || stats.size > MAX_PE_BYTES) {
      throw verifyError(
        'AE_PLUGIN_VERIFY_IO_FAILED',
        'artifact must be one bounded regular file',
      );
    }
    if (input?.expectedCommit !== undefined
        && !SOURCE_COMMIT_PATTERN.test(input.expectedCommit)) {
      throw verifyError(
        'AE_PLUGIN_ARGUMENT_INVALID',
        'expectedCommit must be exactly 40 lowercase hexadecimal characters',
      );
    }
    const bytes = await fs.promises.readFile(artifactPath);
    const headers = parsePeHeaders(bytes);
    if (headers.machine !== EXPECTED_MACHINE_X64) {
      fail(`unexpected PE machine: 0x${headers.machine.toString(16)} (expected x64)`);
    }
    if ((headers.characteristics & 0x2000) === 0) {
      fail('artifact is not a DLL');
    }
    const entryExport = parseExports(bytes, headers);
    const pipl = findResource(bytes, headers, PIPL_RESOURCE_TYPE, PIPL_RESOURCE_ID);
    if (pipl === null) fail('PiPL resource 16000 is missing');
    assertPiplResource(pipl);
    const version = findResource(bytes, headers, RT_VERSION, 1);
    if (version === null) fail('VERSIONINFO resource is missing');
    const versionIdentity = assertVersionResource(
      version,
      input?.expectedProductVersion,
      input?.expectedCommit,
    );
    const receipt = {
      schemaVersion: 1,
      artifact: path.basename(artifactPath),
      artifactSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      architecture: 'x64',
      entryExport,
      sourceCommit: versionIdentity.sourceCommit,
      productVersion: versionIdentity.productVersion,
      resources: ['PiPL/16000', 'VERSION/1'],
      sdk: {
        name: 'Adobe After Effects C/C++ Plug-in SDK',
        claimedVersion: '25.6.61',
        claimedBuild: 61,
        materialIncluded: false,
      },
    };
    return Object.freeze({
      result: 'PASS',
      artifactSha256: receipt.artifactSha256,
      bytes: receipt.bytes,
      architecture: 'x64',
      entryExport,
      sourceCommit: receipt.sourceCommit,
      productVersion: receipt.productVersion,
      receipt,
    });
  } catch (error) {
    throw normalizeVerifyError(error);
  }
}

function parseCli(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--artifact', '--output', '--product-version'].includes(name)
        || !value || options.has(name)) {
      throw verifyError(
        'AE_PLUGIN_ARGUMENT_INVALID',
        'expected unique --artifact, --output, and --product-version options',
      );
    }
    options.set(name, value);
    index += 2;
  }
  const artifact = options.get('--artifact');
  if (!artifact || !path.isAbsolute(artifact)) {
    throw verifyError('AE_PLUGIN_ARGUMENT_INVALID', '--artifact must be an absolute path');
  }
  const output = options.get('--output');
  if (output !== undefined && !path.isAbsolute(output)) {
    throw verifyError('AE_PLUGIN_ARGUMENT_INVALID', '--output must be an absolute path');
  }
  return {
    artifactPath: path.resolve(artifact),
    output: output ? path.resolve(output) : null,
    expectedProductVersion: options.get('--product-version'),
  };
}

function publicError(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'AE_PLUGIN_VERIFY_FAILED',
      message: typeof error?.message === 'string' ? error.message : 'native plug-in verification failed',
    },
  };
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(CLI_USAGE);
  } else {
    (async () => {
      try {
        const options = parseCli(argv);
        const result = await verifyWindowsAex(options);
        if (options.output) {
          await fs.promises.mkdir(path.dirname(options.output), { recursive: true });
          await fs.promises.writeFile(
            options.output,
            `${JSON.stringify(result.receipt, null, 2)}\n`,
            { flag: 'wx' },
          );
        }
        process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
        process.exitCode = 1;
      }
    })();
  }
}
