#!/usr/bin/env node

// Windows .aex (PE32+ DLL) verifier for the AeMcpNative AEGP plug-in.
// Parses PE headers, the export table, and the resource tree without
// third-party dependencies, and fails closed on every mismatch: wrong
// architecture, missing/extra exports, missing or altered PiPL resource,
// missing product-version binding. Emits the canonical verification receipt.

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
  const offset = rvaToOffset(headers, headers.export.rva, 40, 'export directory');
  if (offset + 40 > bytes.length) fail('truncated export directory');
  const functionCount = bytes.readUInt32LE(offset + 20);
  const nameCount = bytes.readUInt32LE(offset + 24);
  const namesRva = bytes.readUInt32LE(offset + 32);
  if (functionCount !== 1 || nameCount !== 1) {
    fail(`unexpected executable entry surface: ${functionCount} function(s), ${nameCount} name(s)`);
  }
  const namesOffset = rvaToOffset(headers, namesRva, 4, 'export name table');
  if (namesOffset + 4 > bytes.length) fail('truncated export name table');
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
  if (bytes.readUInt16LE(0) !== 0x0001) fail('PiPL resource version word mismatch');
  if (bytes.readUInt32LE(6) !== 5) fail('PiPL resource must declare exactly five properties');
  for (const marker of [
    'MIB8', 'dnik', 'xgEA', 'eman', 'gtac', 'srev', '4668',
    'After Effects MCP Native',
    'General Plugin',
    'AeMcpNativeMain',
  ]) {
    if (!bytes.includes(Buffer.from(marker, 'ascii'))) {
      fail(`PiPL resource is missing the ${JSON.stringify(marker)} identity marker`);
    }
  }
}

function assertVersionResource(bytes, expectedProductVersion) {
  if (typeof expectedProductVersion !== 'string' || expectedProductVersion.length === 0) {
    return;
  }
  const encoded = Buffer.from(expectedProductVersion, 'utf16le');
  if (!bytes.includes(encoded)) {
    fail('VERSIONINFO resource does not bind the expected product version');
  }
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
    assertVersionResource(version, input?.expectedProductVersion);
    const receipt = {
      schemaVersion: 1,
      artifact: path.basename(artifactPath),
      artifactSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      architecture: 'x64',
      entryExport,
      resources: ['PiPL/16000', 'VERSION/1'],
      sdk: {
        name: 'Adobe After Effects C/C++ Plug-in SDK',
        claimedVersion: '25.6.61',
        claimedBuild: 61,
        materialIncluded: false,
      },
      expectedSourceCommit: typeof input?.expectedCommit === 'string'
        ? input.expectedCommit
        : null,
    };
    return Object.freeze({
      result: 'PASS',
      artifactSha256: receipt.artifactSha256,
      architecture: 'x64',
      entryExport,
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
