#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const NODE_HEADERS_SHA256 = 'ac60c4ba92204658efaac112efea5d3597348b011be679af0eec324d8c08915e';
const NODE_IMPORT_LIBRARY_SHA256 = '4ab42af597bc4f0957e9e2dcd5db18bdf223406a0c8e0b6be0f28e57977b808b';
const NODE_HEADERS_ROOT = 'node-v24.17.0';
const SUPPORTED_PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
const HELPER_ID = 'com.junkdoge.ae-mcp.platform-helper';
const KEYCHAIN_ACCOUNT_PATTERN = '^provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[a-z][a-z0-9_-]{0,31}:v1$';

function helperError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`unknown argument: ${argument}`);
    const equals = argument.indexOf('=');
    const key = equals === -1 ? argument : argument.slice(0, equals);
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (!value || value.startsWith('--') || options.has(key)) {
      throw new Error(`unknown argument or missing value: ${key}`);
    }
    options.set(key, value);
  }
  return options;
}

export function parseBuildPlatformHelperArgs(argv) {
  const options = parseOptions(argv);
  for (const key of options.keys()) {
    if (!['--platform', '--out'].includes(key)) throw new Error(`unknown argument: ${key}`);
  }
  const platform = options.get('--platform');
  const outDir = options.get('--out');
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`unsupported platform: ${platform ?? '<missing>'}`);
  }
  if (!outDir) throw new Error('--out is required');
  return { platform, outDir };
}

export function validateHelperIdentityPolicy(policy, platform) {
  const mac = policy?.macos;
  const windows = policy?.windows;
  const commonValid = policy?.schemaVersion === 1
    && policy.helperId === HELPER_ID
    && policy.protocolVersion === 1
    && policy.maxMessageBytes === 65536;
  const macValid = platform === 'macos-arm64'
      && mac?.platform === platform
      && mac.minimumOsVersion === '14.0'
      && mac.architecture === 'arm64'
      && mac.machServiceName === HELPER_ID
      && mac.keychainService === 'com.junkdoge.ae-mcp'
      && mac.keychainAccountPattern === KEYCHAIN_ACCOUNT_PATTERN
      && mac.authorization?.publicConnectionIdentityOnly === true
      && mac.authorization?.processGenerationDoubleRead === true
      && mac.authorization?.positiveAuditSessionBinding === true
      && mac.authorization?.ancestrySnapshotCodeSnapshot === true
      && mac.authorization?.wholeChainFinalRead === true
      && mac.authorization?.currentUserOnly === true
      && mac.authorization?.nativeExecutionOnly === true
      && mac.authorization?.rejectionBackendAccessCount === 0
      && mac.caller?.adobeTeamId === 'JQ525L2MZD'
      && mac.caller?.afterEffectsBundleId === 'com.adobe.AfterEffects.application'
      && JSON.stringify(mac.caller?.afterEffectsMajors) === JSON.stringify([25, 26])
      && JSON.stringify(mac.caller?.directSigningIdentifiers) === JSON.stringify([
        'com.adobe.cep.CEPHtmlEngine',
      ]);
  const windowsValid = platform === 'windows-x64'
      && windows?.platform === platform
      && windows.minimumOsVersion === '11.0.26100'
      && windows.architecture === 'x64'
      && windows.pipeName === '\\\\.\\pipe\\com.junkdoge.ae-mcp.platform-helper'
      && windows.credentialTargetPrefix === 'com.junkdoge.ae-mcp/provider:'
      && windows.authorization?.currentUserOnly === true
      && windows.authorization?.nativeExecutionOnly === true
      && windows.authorization?.processGenerationDoubleRead === true
      && windows.authorization?.wholeChainFinalRead === true
      && windows.authorization?.authenticodeChainRequired === true
      && windows.authorization?.rejectionBackendAccessCount === 0
      && windows.caller?.publisherOrganization === 'Adobe Inc.'
      && windows.caller?.directImage === 'CEPHtmlEngine.exe'
      && windows.caller?.ancestorImage === 'AfterFX.exe'
      && JSON.stringify(windows.caller?.afterEffectsMajors) === JSON.stringify([25, 26]);
  if (!commonValid || (!macValid && !windowsValid)) {
    throw helperError('HELPER_IDENTITY_POLICY_INVALID', 'helper identity policy is invalid');
  }
  return policy;
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

export async function validateNodeHeadersArchive({ archivePath, extractedRoot }) {
  const digest = await sha256File(archivePath).catch(() => null);
  if (digest !== NODE_HEADERS_SHA256) {
    throw helperError(
      'HELPER_NODE_HEADERS_INVALID',
      'Node.js 24.17.0 headers archive is missing or does not match runtime-lock.json',
    );
  }
  if (extractedRoot === undefined) return null;
  const header = path.join(extractedRoot, NODE_HEADERS_ROOT, 'include', 'node', 'node_api.h');
  if (!fs.existsSync(header)) {
    throw helperError(
      'HELPER_NODE_HEADERS_INVALID',
      'locked Node.js 24.17.0 headers payload does not contain node_api.h',
    );
  }
  return path.dirname(header);
}

export async function prepareEmptyOutput(outDir) {
  try {
    await fs.promises.lstat(outDir);
    throw helperError('HELPER_OUTPUT_EXISTS', `helper output already exists: ${outDir}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.promises.mkdir(outDir, { recursive: false, mode: 0o700 });
  return outDir;
}

export async function buildHelperManifest(root, platform, definitions) {
  const files = [];
  for (const definition of definitions) {
    const target = path.join(root, ...definition.path.split('/'));
    const stats = await fs.promises.lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw helperError('HELPER_PAYLOAD_INVALID', `helper payload is not a regular file: ${definition.path}`);
    }
    files.push({
      path: definition.path,
      architecture: definition.architecture,
      sha256: await sha256File(target),
    });
  }
  return {
    schemaVersion: 1,
    platform,
    helperId: HELPER_ID,
    entrypoints: {
      helper: platform === 'windows-x64'
        ? 'bin/ae-mcp-platform-helper.exe'
        : 'bin/ae-mcp-platform-helper',
      launcher: platform === 'windows-x64' ? 'bin/ae-mcp.exe' : 'bin/ae-mcp',
    },
    files,
  };
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (cause) {
    throw helperError(
      'HELPER_BUILD_COMMAND_FAILED',
      `${path.basename(command)} failed while building the platform helper`,
    );
  }
}

async function copyFile(source, destination, mode) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
  await fs.promises.chmod(destination, mode);
}

export async function snapshotNodeHeadersArchive({ archivePath, scratchRoot }) {
  const snapshotRoot = path.join(scratchRoot, 'node-headers-archive');
  const snapshotArchive = path.join(snapshotRoot, 'node-v24.17.0-headers.tar.gz');
  await fs.promises.mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  await fs.promises.copyFile(
    path.resolve(archivePath),
    snapshotArchive,
    fs.constants.COPYFILE_EXCL,
  );
  await fs.promises.chmod(snapshotArchive, 0o600);
  const stats = await fs.promises.lstat(snapshotArchive);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw helperError(
      'HELPER_NODE_HEADERS_INVALID',
      'private Node.js headers archive snapshot is not a regular single-link file',
    );
  }
  return snapshotArchive;
}

export async function snapshotNodeImportLibrary({ libraryPath, scratchRoot }) {
  const snapshotRoot = path.join(scratchRoot, 'node-import-library');
  const snapshotLibrary = path.join(snapshotRoot, 'node.lib');
  await fs.promises.mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  await fs.promises.copyFile(
    path.resolve(libraryPath),
    snapshotLibrary,
    fs.constants.COPYFILE_EXCL,
  );
  await fs.promises.chmod(snapshotLibrary, 0o600);
  const stats = await fs.promises.lstat(snapshotLibrary);
  const digest = await sha256File(snapshotLibrary).catch(() => null);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || digest !== NODE_IMPORT_LIBRARY_SHA256) {
    throw helperError(
      'HELPER_NODE_IMPORT_LIBRARY_INVALID',
      'Node.js 24.17.0 x64 import library is missing or does not match runtime-lock.json',
    );
  }
  return snapshotLibrary;
}

async function extractNodeHeaders(archivePath, scratchRoot) {
  const extractionRoot = path.join(scratchRoot, 'node-headers');
  await fs.promises.mkdir(extractionRoot, { mode: 0o700 });
  const snapshotArchive = await snapshotNodeHeadersArchive({ archivePath, scratchRoot });
  await validateNodeHeadersArchive({ archivePath: snapshotArchive });
  const tar = process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar';
  await run(tar, ['-xzf', snapshotArchive, '-C', extractionRoot]);
  return validateNodeHeadersArchive({ archivePath: snapshotArchive, extractedRoot: extractionRoot });
}

async function verifyPeX64(filePath) {
  const bytes = await fs.promises.readFile(filePath);
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw helperError('HELPER_WINDOWS_OUTPUT_INVALID', 'Windows helper output is not a PE file');
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length
      || bytes.readUInt32LE(peOffset) !== 0x00004550
      || bytes.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw helperError('HELPER_WINDOWS_OUTPUT_INVALID', 'Windows helper output is not PE x64');
  }
}

async function buildWindowsPayload({
  repoRoot,
  scratchRoot,
  includeDir,
  importLibrary,
  temporary,
  environment,
}) {
  const sourceRoot = path.join(repoRoot, 'native/platform-helper/windows');
  const buildRoot = path.join(scratchRoot, 'windows-build');
  const cmake = environment.CMAKE ?? 'cmake.exe';
  await run(cmake, [
    '-S', sourceRoot,
    '-B', buildRoot,
    '-A', 'x64',
    `-DNODE_INCLUDE_DIR=${includeDir}`,
    `-DNODE_IMPORT_LIBRARY=${importLibrary}`,
    `-DCMAKE_INSTALL_PREFIX=${temporary}`,
  ], { cwd: repoRoot, env: environment });
  await run(cmake, ['--build', buildRoot, '--config', 'Release'], {
    cwd: repoRoot,
    env: environment,
  });
  await run(cmake, ['--install', buildRoot, '--config', 'Release'], {
    cwd: repoRoot,
    env: environment,
  });
}

function swiftEnvironment(scratchRoot, environment) {
  const result = {
    ...environment,
    CLANG_MODULE_CACHE_PATH: path.join(scratchRoot, 'clang-module-cache'),
    SWIFT_MODULECACHE_PATH: path.join(scratchRoot, 'swift-module-cache'),
    SWIFTPM_MODULECACHE_OVERRIDE: path.join(scratchRoot, 'swiftpm-module-cache'),
  };
  if (environment.AE_MCP_MACOS_SDK) result.SDKROOT = environment.AE_MCP_MACOS_SDK;
  const compatibility = environment.AE_MCP_SWIFT_INTERFACE_COMPILER_VERSION;
  if (compatibility) {
    result.SWIFTFLAGS = `-Xfrontend -interface-compiler-version -Xfrontend ${compatibility}`;
  }
  return result;
}

function swiftCompatibilityArgs(environment) {
  const compatibility = environment.AE_MCP_SWIFT_INTERFACE_COMPILER_VERSION;
  return compatibility
    ? ['-Xswiftc', '-Xfrontend', '-Xswiftc', '-interface-compiler-version', '-Xswiftc', '-Xfrontend', '-Xswiftc', compatibility]
    : [];
}

async function buildSwiftHelper({ repoRoot, scratchRoot, environment }) {
  const packagePath = path.join(repoRoot, 'native/platform-helper/macos');
  const swiftScratch = path.join(scratchRoot, 'swift-build');
  const executable = environment.SWIFT ?? 'swift';
  const common = [
    '--disable-sandbox',
    '--package-path', packagePath,
    '--scratch-path', swiftScratch,
    '-c', 'release',
    '--arch', 'arm64',
    ...swiftCompatibilityArgs(environment),
  ];
  const env = swiftEnvironment(scratchRoot, environment);
  await run(executable, ['build', ...common], { cwd: repoRoot, env });
  const { stdout } = await run(executable, ['build', ...common, '--show-bin-path'], {
    cwd: repoRoot,
    env,
  });
  const binary = path.join(stdout.trim(), 'ae-mcp-platform-helper');
  if (!fs.existsSync(binary)) {
    throw helperError('HELPER_SWIFT_OUTPUT_MISSING', 'Swift helper executable is missing');
  }
  return binary;
}

async function buildAddon({ repoRoot, scratchRoot, includeDir, environment, output }) {
  const sourceRoot = path.join(repoRoot, 'native/platform-helper/client-addon/src');
  const commonObject = path.join(scratchRoot, 'common.o');
  const macObject = path.join(scratchRoot, 'addon_macos.o');
  const { stdout } = await run('/usr/bin/xcrun', ['--find', 'clang++']);
  const compiler = stdout.trim();
  const sdkArgs = environment.AE_MCP_MACOS_SDK
    ? ['-isysroot', environment.AE_MCP_MACOS_SDK]
    : [];
  const compile = [
    '-std=c++20',
    '-target', 'arm64-apple-macos14.0',
    '-fPIC',
    ...sdkArgs,
    '-I', includeDir,
    '-I', sourceRoot,
  ];
  await run(compiler, [...compile, '-c', path.join(sourceRoot, 'common.cpp'), '-o', commonObject]);
  await run(compiler, [
    ...compile,
    '-fobjc-arc',
    '-c', path.join(sourceRoot, 'addon_macos.mm'),
    '-o', macObject,
  ]);
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  await run(compiler, [
    '-target', 'arm64-apple-macos14.0',
    ...sdkArgs,
    '-bundle',
    '-undefined', 'dynamic_lookup',
    '-framework', 'Foundation',
    commonObject,
    macObject,
    '-o', output,
  ]);
  await fs.promises.chmod(output, 0o755);
}

async function verifyArm64(filePath) {
  await run('/usr/bin/lipo', [filePath, '-verify_arch', 'arm64']);
}

export async function buildPlatformHelper({
  platform,
  outDir,
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
  environment = process.env,
}) {
  const hostSupported = platform === 'macos-arm64'
    ? process.platform === 'darwin' && process.arch === 'arm64'
    : platform === 'windows-x64' && process.platform === 'win32' && process.arch === 'x64';
  if (!hostSupported) {
    throw helperError(
      'HELPER_BUILD_HOST_UNSUPPORTED',
      `${platform} helper requires its native build host`,
    );
  }
  const destination = path.resolve(outDir);
  if (fs.existsSync(destination)) {
    throw helperError('HELPER_OUTPUT_EXISTS', `helper output already exists: ${destination}`);
  }
  const policy = JSON.parse(await fs.promises.readFile(
    path.join(repoRoot, 'packaging/helper-identity-policy.json'),
    'utf8',
  ));
  validateHelperIdentityPolicy(policy, platform);
  const archivePath = environment.AE_MCP_NODE_HEADERS_ARCHIVE;
  if (!archivePath) {
    throw helperError(
      'HELPER_NODE_HEADERS_REQUIRED',
      'AE_MCP_NODE_HEADERS_ARCHIVE must name the locked Node.js 24.17.0 headers archive',
    );
  }
  const importLibraryPath = platform === 'windows-x64'
    ? environment.AE_MCP_NODE_IMPORT_LIBRARY
    : null;
  if (platform === 'windows-x64' && !importLibraryPath) {
    throw helperError(
      'HELPER_NODE_IMPORT_LIBRARY_REQUIRED',
      'AE_MCP_NODE_IMPORT_LIBRARY must name the locked Node.js 24.17.0 x64 node.lib',
    );
  }

  const parent = path.dirname(destination);
  await fs.promises.mkdir(parent, { recursive: true });
  const scratchRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-helper-build-'));
  const temporary = await fs.promises.mkdtemp(path.join(parent, '.helper.tmp-'));
  let published = false;
  try {
    const includeDir = await extractNodeHeaders(archivePath, scratchRoot);
    if (platform === 'windows-x64') {
      const importLibrary = await snapshotNodeImportLibrary({
        libraryPath: importLibraryPath,
        scratchRoot,
      });
      await buildWindowsPayload({
        repoRoot,
        scratchRoot,
        includeDir,
        importLibrary,
        temporary,
        environment,
      });
      const definitions = [
        { path: 'bin/ae-mcp-platform-helper.exe', architecture: 'pe-x64' },
        { path: 'bin/ae-mcp.exe', architecture: 'pe-x64' },
        { path: 'lib/ae-mcp-platform-helper-transport.node', architecture: 'pe-x64' },
      ];
      for (const definition of definitions) {
        await verifyPeX64(path.join(temporary, ...definition.path.split('/')));
      }
      const manifest = await buildHelperManifest(temporary, platform, definitions);
      await fs.promises.writeFile(
        path.join(temporary, 'helper-manifest.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o644, flag: 'wx' },
      );
      await fs.promises.rename(temporary, destination);
      published = true;
      return manifest;
    }
    const swiftBinary = await buildSwiftHelper({ repoRoot, scratchRoot, environment });
    const helperPath = path.join(temporary, 'bin/ae-mcp-platform-helper');
    await copyFile(swiftBinary, helperPath, 0o755);

    const launcherPath = path.join(temporary, 'bin/ae-mcp');
    await fs.promises.writeFile(launcherPath, [
      '#!/bin/sh',
      'set -eu',
      'base="${AE_MCP_HOME:-$HOME/.ae-mcp}"',
      'relative="$(/bin/cat "$base/runtime/current")"',
      'case "$relative" in',
      '  ""|/*|*..*) exit 78 ;;',
      'esac',
      'exec "$base/runtime/$relative/python/bin/python3" -I -m ae_mcp "$@"',
      '',
    ].join('\n'), { mode: 0o755, flag: 'wx' });
    await fs.promises.chmod(launcherPath, 0o755);

    const addonPath = path.join(temporary, 'lib/ae-mcp-platform-helper-transport.node');
    await buildAddon({ repoRoot, scratchRoot, includeDir, environment, output: addonPath });

    const resourceRoot = path.join(
      repoRoot,
      'native/platform-helper/macos/Sources/PlatformHelperService/Resources',
    );
    const xpcRoot = path.join(temporary, `xpc/${HELPER_ID}.xpc/Contents`);
    const xpcExecutable = path.join(xpcRoot, 'MacOS/ae-mcp-platform-helper');
    await copyFile(swiftBinary, xpcExecutable, 0o755);
    await copyFile(path.join(resourceRoot, 'Info.plist'), path.join(xpcRoot, 'Info.plist'), 0o644);
    await copyFile(
      path.join(resourceRoot, 'PlatformHelper.entitlements'),
      path.join(temporary, 'metadata/PlatformHelper.entitlements'),
      0o644,
    );
    await copyFile(
      path.join(resourceRoot, `${HELPER_ID}.plist`),
      path.join(temporary, `launchd/${HELPER_ID}.plist`),
      0o644,
    );

    await verifyArm64(helperPath);
    await verifyArm64(addonPath);
    await verifyArm64(xpcExecutable);
    const definitions = [
      { path: 'bin/ae-mcp-platform-helper', architecture: 'macho-arm64' },
      { path: 'bin/ae-mcp', architecture: 'script' },
      { path: 'lib/ae-mcp-platform-helper-transport.node', architecture: 'macho-arm64' },
      {
        path: `xpc/${HELPER_ID}.xpc/Contents/MacOS/ae-mcp-platform-helper`,
        architecture: 'macho-arm64',
      },
      { path: `xpc/${HELPER_ID}.xpc/Contents/Info.plist`, architecture: 'data' },
      { path: 'metadata/PlatformHelper.entitlements', architecture: 'data' },
      { path: `launchd/${HELPER_ID}.plist`, architecture: 'data' },
    ];
    const manifest = await buildHelperManifest(temporary, platform, definitions);
    await fs.promises.writeFile(
      path.join(temporary, 'helper-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o644, flag: 'wx' },
    );
    await fs.promises.rename(temporary, destination);
    published = true;
    return manifest;
  } finally {
    await fs.promises.rm(scratchRoot, { recursive: true, force: true });
    if (!published) await fs.promises.rm(temporary, { recursive: true, force: true });
  }
}

async function main(argv) {
  const input = parseBuildPlatformHelperArgs(argv);
  await buildPlatformHelper(input);
  process.stdout.write(`platform helper built: ${input.platform}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? 'HELPER_BUILD_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
