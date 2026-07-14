#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODULE_PATH = fileURLToPath(import.meta.url);
const EXPECTED_FILES = new Set([
  'Contents/Info.plist',
  'Contents/MacOS/AeMcpNative',
  'Contents/Resources/AeMcpNative.rsrc',
  'Contents/_CodeSignature/CodeResources',
]);
const MANAGED_DISABLED_BUNDLE = /^\.AeMcpNative\.(?:stage|backup|failed|replaced)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.disabled$/u;
const MAX_DIRECTORY_DEPTH = 8;
const MAX_ENTRIES = 32;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 160 * 1024 * 1024;

function verificationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function command(tool, args) {
  try {
    return execFileSync(tool, args, {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw verificationError(
      'AE_PLUGIN_VERIFY_TOOL_FAILED',
      `native plug-in verification tool failed: ${path.basename(tool)}`,
    );
  }
}

function commandCombined(tool, args) {
  const result = spawnSync(tool, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw verificationError(
      'AE_PLUGIN_VERIFY_TOOL_FAILED',
      `native plug-in verification tool failed: ${path.basename(tool)}`,
    );
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw verificationError('AE_PLUGIN_LAYOUT_INVALID', 'plug-in path escaped its bundle');
  }
}

async function collectFiles(root) {
  const rootReal = await fs.promises.realpath(root);
  const files = [];
  let observedEntries = 0;
  let totalBytes = 0;
  async function visit(directory, depth) {
    if (depth > MAX_DIRECTORY_DEPTH) {
      throw verificationError('AE_PLUGIN_LAYOUT_INVALID', 'plug-in bundle nesting is too deep');
    }
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    observedEntries += entries.length;
    if (observedEntries > MAX_ENTRIES) {
      throw verificationError('AE_PLUGIN_LAYOUT_INVALID', 'plug-in bundle has too many entries');
    }
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const stats = await fs.promises.lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw verificationError('AE_PLUGIN_LAYOUT_INVALID', 'plug-in bundle contains a symlink');
      }
      assertInside(rootReal, candidate);
      if (stats.isDirectory()) {
        await visit(candidate, depth + 1);
      } else if (stats.isFile() && stats.nlink === 1) {
        if (stats.size < 0 || stats.size > MAX_FILE_BYTES
            || totalBytes + stats.size > MAX_TOTAL_BYTES) {
          throw verificationError('AE_PLUGIN_LAYOUT_INVALID', 'plug-in bundle file budget exceeded');
        }
        totalBytes += stats.size;
        const relative = path.relative(rootReal, candidate).split(path.sep).join('/');
        const bytes = await fs.promises.readFile(candidate);
        if (bytes.length !== stats.size) {
          throw verificationError('AE_PLUGIN_LAYOUT_INVALID', 'plug-in bundle changed during verification');
        }
        files.push({ path: relative, mode: stats.mode & 0o777, bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        throw verificationError(
          'AE_PLUGIN_LAYOUT_INVALID',
          'plug-in bundle contains a hard link or special filesystem entry',
        );
      }
    }
  }
  await visit(rootReal, 0);
  return { rootReal, files };
}

function assertPiplProperty(resourceBytes, key, expectedPayload) {
  const marker = Buffer.from(`8BIM${key}`, 'ascii');
  const offsets = [];
  for (let offset = resourceBytes.indexOf(marker); offset >= 0;
    offset = resourceBytes.indexOf(marker, offset + 1)) {
    offsets.push(offset);
  }
  if (offsets.length !== 1) {
    throw verificationError('AE_PLUGIN_PIPL_INVALID', `PiPL ${key} property is missing or ambiguous`);
  }
  const payloadHeader = offsets[0] + marker.length;
  if (payloadHeader + 8 + expectedPayload.length > resourceBytes.length
      || resourceBytes.readUInt32BE(payloadHeader) !== 0
      || resourceBytes.readUInt32BE(payloadHeader + 4) !== expectedPayload.length
      || !resourceBytes.subarray(
        payloadHeader + 8,
        payloadHeader + 8 + expectedPayload.length,
      ).equals(expectedPayload)) {
    throw verificationError('AE_PLUGIN_PIPL_INVALID', `PiPL ${key} property payload is invalid`);
  }
}

function plistValue(plist, key) {
  return command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]).trim();
}

export async function verifyMacPlugin({
  bundlePath,
  allowManagedDisabledName = false,
}) {
  const bundleName = bundlePath ? path.basename(bundlePath) : '';
  const nameIsAllowed = bundleName === 'AeMcpNative.plugin'
    || (allowManagedDisabledName && MANAGED_DISABLED_BUNDLE.test(bundleName));
  if (!nameIsAllowed) {
    throw verificationError(
      'AE_PLUGIN_LAYOUT_INVALID',
      'expected an AeMcpNative.plugin bundle path',
    );
  }
  const bundleStats = await fs.promises.lstat(bundlePath).catch(() => null);
  if (!bundleStats?.isDirectory() || bundleStats.isSymbolicLink()) {
    throw verificationError('AE_PLUGIN_LAYOUT_INVALID', 'plug-in bundle is missing or symbolic');
  }
  const { rootReal, files } = await collectFiles(bundlePath);
  const observed = new Set(files.map((record) => record.path));
  if (observed.size !== EXPECTED_FILES.size
      || [...EXPECTED_FILES].some((expected) => !observed.has(expected))) {
    throw verificationError('AE_PLUGIN_LAYOUT_INVALID', 'plug-in bundle file set is not exact');
  }

  const plist = path.join(rootReal, 'Contents', 'Info.plist');
  const executable = path.join(rootReal, 'Contents', 'MacOS', 'AeMcpNative');
  const resource = path.join(rootReal, 'Contents', 'Resources', 'AeMcpNative.rsrc');
  command('/usr/bin/plutil', ['-lint', plist]);
  const requiredPlist = {
    CFBundleExecutable: 'AeMcpNative',
    CFBundleIdentifier: 'dev.aemcp.native-plugin',
    CFBundlePackageType: 'AEgx',
    CFBundleShortVersionString: '0.1.0',
    CFBundleVersion: '1',
    LSMinimumSystemVersion: '14.0',
  };
  for (const [key, expected] of Object.entries(requiredPlist)) {
    if (plistValue(plist, key) !== expected) {
      throw verificationError('AE_PLUGIN_PLIST_INVALID', `unexpected ${key} in native plug-in`);
    }
  }

  const fileOutput = command('/usr/bin/file', [executable]);
  if (!fileOutput.includes('Mach-O 64-bit bundle arm64')) {
    throw verificationError('AE_PLUGIN_ARCH_INVALID', 'native plug-in is not an arm64 Mach-O bundle');
  }
  const exported = command('/usr/bin/nm', ['-gU', executable])
    .trim().split(/\r?\n/u).filter(Boolean).map((line) => line.trim().split(/\s+/u).at(-1));
  if (JSON.stringify(exported) !== JSON.stringify(['_AeMcpNativeMain'])) {
    throw verificationError('AE_PLUGIN_EXPORT_INVALID', 'native plug-in exports an unexpected symbol set');
  }

  const deRez = command('/usr/bin/xcrun', ['--find', 'DeRez']).trim();
  const resourceDump = command(deRez, ['-useDF', resource]);
  const resourceBytes = await fs.promises.readFile(resource);
  if (!resourceDump.includes("data 'PiPL' (16000)")) {
    throw verificationError('AE_PLUGIN_PIPL_INVALID', 'native plug-in PiPL is missing required metadata');
  }
  assertPiplProperty(resourceBytes, 'kind', Buffer.from('AEgx', 'ascii'));
  const entryPoint = Buffer.from('AeMcpNativeMain', 'ascii');
  assertPiplProperty(
    resourceBytes,
    'ma64',
    Buffer.concat([Buffer.from([entryPoint.length]), entryPoint]),
  );
  command('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', rootReal]);
  const signature = commandCombined(
    '/usr/bin/codesign',
    ['--display', '--verbose=4', rootReal],
  );
  if (!/^Signature=adhoc$/mu.test(signature)
      || !/^TeamIdentifier=not set$/mu.test(signature)) {
    throw verificationError(
      'AE_PLUGIN_SIGNATURE_INVALID',
      'native development plug-in must have an ad-hoc signature without a team identity',
    );
  }

  const canonicalTree = JSON.stringify(files);
  const executableRecord = files.find((record) => record.path === 'Contents/MacOS/AeMcpNative');
  const resourceRecord = files.find((record) => record.path === 'Contents/Resources/AeMcpNative.rsrc');
  return Object.freeze({
    schemaVersion: 1,
    bundleName: 'AeMcpNative.plugin',
    platform: 'macos-arm64',
    architecture: 'arm64',
    bundleType: 'AEgx',
    entryPoint: 'AeMcpNativeMain',
    fileCount: files.length,
    bundleTreeSha256: sha256(Buffer.from(canonicalTree, 'utf8')),
    executableSha256: executableRecord.sha256,
    piplSha256: resourceRecord.sha256,
    codeSignature: 'ad-hoc-verified',
  });
}

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== '--bundle' || !path.isAbsolute(argv[1])) {
    throw verificationError(
      'AE_PLUGIN_ARGUMENT_INVALID',
      'usage: verify-macos.mjs --bundle /absolute/path/AeMcpNative.plugin',
    );
  }
  return argv[1];
}

function publicError(error) {
  const structured = typeof error?.code === 'string' && error.code.startsWith('AE_');
  return {
    ok: false,
    error: {
      code: structured ? error.code : 'AE_PLUGIN_VERIFY_FAILED',
      message: structured && typeof error?.message === 'string'
        ? error.message : 'native plug-in verification failed without exposing local paths',
    },
  };
}

if (path.resolve(process.argv[1] ?? '') === MODULE_PATH) {
  try {
    const result = await verifyMacPlugin({ bundlePath: parseCli(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
    process.exitCode = 1;
  }
}
