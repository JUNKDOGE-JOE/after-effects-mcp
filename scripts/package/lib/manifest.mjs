import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PLATFORM_IDS = new Set(['macos-arm64', 'windows-x64']);
export const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const NATIVE_PLUGIN_MANIFEST_PATH = 'artifacts/native-plugin/macos-arm64/native-plugin-manifest.json';

export function bundleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortedValue(value), null, 2)}\n`;
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function comparePortableUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameStableMetadata(left, right) {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function assertStableRegularStats(stats, expectedStats, filePath) {
  if (!stats.isFile()) {
    throw bundleError('BUNDLE_SPECIAL_FILE', `regular file required: ${filePath}`);
  }
  if (stats.nlink !== 1) {
    throw bundleError('BUNDLE_HARDLINK_FORBIDDEN', `hard-linked file is forbidden: ${filePath}`);
  }
  if (expectedStats && !sameStableMetadata(stats, expectedStats)) {
    throw bundleError('BUNDLE_SOURCE_CHANGED', `file changed during verification: ${filePath}`);
  }
}

async function openStableRegularFile(filePath, expectedStats) {
  const pathStats = expectedStats ?? await fs.promises.lstat(filePath);
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw bundleError('BUNDLE_SYMLINK_UNSAFE', `refusing to follow a symlink: ${filePath}`);
  }
  assertStableRegularStats(pathStats, expectedStats, filePath);
  let handle;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw bundleError('BUNDLE_SYMLINK_UNSAFE', `refusing to follow a symlink: ${filePath}`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    assertStableRegularStats(before, pathStats, filePath);
    return { handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertUnchangedRegularFile(before, after, filePath) {
  assertStableRegularStats(after, before, filePath);
}

export async function sha256File(filePath, { expectedStats } = {}) {
  const { handle, before } = await openStableRegularFile(filePath, expectedStats);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    assertUnchangedRegularFile(before, await handle.stat(), filePath);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function copyRegularFileStable(source, destination, { expectedStats } = {}) {
  let sourceHandle;
  let destinationHandle;
  let destinationCreated = false;
  try {
    const opened = await openStableRegularFile(source, expectedStats);
    sourceHandle = opened.handle;
    const { before } = opened;
    destinationHandle = await fs.promises.open(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      before.mode & 0o777,
    );
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        );
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    assertUnchangedRegularFile(before, await sourceHandle.stat(), source);
    await destinationHandle.close();
    destinationHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;
    if (process.platform !== 'win32') await fs.promises.chmod(destination, before.mode & 0o777);
  } catch (error) {
    await destinationHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
    if (destinationCreated) await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function assertPortableRelativePath(relative, code = 'BUNDLE_PATH_INVALID') {
  if (typeof relative !== 'string'
      || relative.length === 0
      || relative.length > 1024
      || relative.includes('\\')
      || relative.includes('\0')
      || path.posix.isAbsolute(relative)) {
    throw bundleError(code, `invalid portable relative path: ${String(relative)}`);
  }
  const segments = relative.split('/');
  const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || /[<>:"|?*\u0000-\u001f]/.test(segment)
    || /[ .]$/.test(segment)
    || reservedWindowsName.test(segment)
  ))) {
    throw bundleError(code, `invalid portable relative path: ${relative}`);
  }
  return relative;
}

function portablePathKey(relative) {
  return relative.normalize('NFC').toLowerCase();
}

async function assertSafeSymlink(root, absolute, relative, expectedStats) {
  const before = await fs.promises.lstat(absolute);
  if (!before.isSymbolicLink()
      || (expectedStats && !sameStableMetadata(before, expectedStats))) {
    throw bundleError('BUNDLE_SOURCE_CHANGED', `symlink changed during verification: ${relative}`);
  }
  const target = await fs.promises.readlink(absolute);
  if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
    throw bundleError('BUNDLE_SYMLINK_UNSAFE', `absolute symlink is forbidden: ${relative}`);
  }
  const lexical = path.resolve(path.dirname(absolute), target);
  if (!isInside(root, lexical)) {
    throw bundleError('BUNDLE_SYMLINK_UNSAFE', `symlink escapes bundle root: ${relative}`);
  }
  let real;
  try {
    real = await fs.promises.realpath(lexical);
  } catch (error) {
    throw bundleError('BUNDLE_SYMLINK_UNSAFE', `symlink target is missing: ${relative}`);
  }
  const realRoot = await fs.promises.realpath(root);
  if (!isInside(realRoot, real) && real !== realRoot) {
    throw bundleError('BUNDLE_SYMLINK_UNSAFE', `symlink resolves outside bundle root: ${relative}`);
  }
  const repeatedTarget = await fs.promises.readlink(absolute);
  const after = await fs.promises.lstat(absolute);
  if (target !== repeatedTarget || !after.isSymbolicLink() || !sameStableMetadata(before, after)) {
    throw bundleError('BUNDLE_SOURCE_CHANGED', `symlink changed during verification: ${relative}`);
  }
  return target;
}

async function assertStableDirectory(directory, expectedStats) {
  const stats = await fs.promises.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw bundleError('BUNDLE_SPECIAL_FILE', `directory path is not stable: ${directory}`);
  }
  if (expectedStats && !sameStableMetadata(stats, expectedStats)) {
    throw bundleError('BUNDLE_SOURCE_CHANGED', `directory changed during verification: ${directory}`);
  }
  return stats;
}

export async function collectManifestEntries(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const omit = new Set(options.omit ?? []);
  const entries = [];
  const portablePaths = new Set();
  for (const omitted of omit) {
    assertPortableRelativePath(omitted);
    portablePaths.add(portablePathKey(omitted));
  }
  async function visit(directory, prefix = '', expectedDirectoryStats) {
    const directoryStats = await assertStableDirectory(directory, expectedDirectoryStats);
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePortableUtf8(left.name, right.name));
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      assertPortableRelativePath(relative);
      if (omit.has(relative)) continue;
      const portableKey = portablePathKey(relative);
      if (portablePaths.has(portableKey)) {
        throw bundleError('BUNDLE_PATH_COLLISION', `case or Unicode-colliding bundle path: ${relative}`);
      }
      portablePaths.add(portableKey);
      const absolute = path.join(directory, child.name);
      const stats = await fs.promises.lstat(absolute);
      if (stats.isDirectory()) {
        await visit(absolute, relative, stats);
      } else if (stats.isSymbolicLink()) {
        const linkTarget = await assertSafeSymlink(resolvedRoot, absolute, relative, stats);
        const bytes = Buffer.from(linkTarget, 'utf8');
        entries.push({
          path: relative,
          sha256: sha256Bytes(bytes),
          size: bytes.length,
          mode: (stats.mode & 0o777).toString(8).padStart(4, '0'),
          type: 'symlink',
          linkTarget,
        });
      } else if (stats.isFile()) {
        if (stats.nlink !== 1) {
          throw bundleError('BUNDLE_HARDLINK_FORBIDDEN', `hard-linked file is forbidden: ${relative}`);
        }
        entries.push({
          path: relative,
          sha256: await sha256File(absolute, { expectedStats: stats }),
          size: stats.size,
          mode: (stats.mode & 0o777).toString(8).padStart(4, '0'),
          type: 'file',
        });
      } else {
        throw bundleError('BUNDLE_SPECIAL_FILE', `special filesystem entry is forbidden: ${relative}`);
      }
    }
    await assertStableDirectory(directory, directoryStats);
  }
  await visit(resolvedRoot);
  entries.sort((left, right) => comparePortableUtf8(left.path, right.path));
  return entries;
}

export function validateBundleManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bundleError('BUNDLE_MANIFEST_INVALID', 'bundle manifest must be an object');
  }
  const exactTop = ['files', 'helper', 'platform', 'runtime', 'schemaVersion', 'sourceCommitSha', 'version'];
  const observedTop = Object.keys(value).sort();
  const expectedTop = Object.hasOwn(value, 'nativePlugin')
    ? [...exactTop, 'nativePlugin'].sort() : exactTop;
  if (JSON.stringify(observedTop) !== JSON.stringify(expectedTop)) {
    throw bundleError('BUNDLE_MANIFEST_INVALID', 'bundle manifest has unexpected fields');
  }
  if (value.schemaVersion !== 1
      || !PLATFORM_IDS.has(value.platform)
      || !SEMVER_PATTERN.test(value.version ?? '')
      || !SOURCE_SHA_PATTERN.test(value.sourceCommitSha ?? '')) {
    throw bundleError('BUNDLE_MANIFEST_INVALID', 'bundle manifest identity is invalid');
  }
  if (!value.runtime
      || JSON.stringify(Object.keys(value.runtime).sort())
        !== JSON.stringify([
          'licenseInventorySha256',
          'manifestSha256',
          'nodeVersion',
          'pythonVersion',
          'sbomSha256',
        ])
      || value.runtime.nodeVersion !== '24.17.0'
      || value.runtime.pythonVersion !== '3.13.14'
      || !SHA256_PATTERN.test(value.runtime.manifestSha256 ?? '')
      || !SHA256_PATTERN.test(value.runtime.sbomSha256 ?? '')
      || !SHA256_PATTERN.test(value.runtime.licenseInventorySha256 ?? '')) {
    throw bundleError('BUNDLE_MANIFEST_INVALID', 'bundle runtime identity is invalid');
  }
  if (!value.helper
      || JSON.stringify(Object.keys(value.helper).sort())
        !== JSON.stringify(['helperId', 'manifestSha256'])
      || value.helper.helperId !== 'com.junkdoge.ae-mcp.platform-helper'
      || !SHA256_PATTERN.test(value.helper.manifestSha256 ?? '')) {
    throw bundleError('BUNDLE_MANIFEST_INVALID', 'bundle helper identity is invalid');
  }
  if (Object.hasOwn(value, 'nativePlugin')) {
    if (value.platform !== 'macos-arm64'
        || !value.nativePlugin
        || JSON.stringify(Object.keys(value.nativePlugin).sort())
          !== JSON.stringify(['manifestPath', 'manifestSha256'])
        || value.nativePlugin.manifestPath !== NATIVE_PLUGIN_MANIFEST_PATH
        || !SHA256_PATTERN.test(value.nativePlugin.manifestSha256 ?? '')) {
      throw bundleError('BUNDLE_MANIFEST_INVALID', 'bundle native plug-in reference is invalid');
    }
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw bundleError('BUNDLE_MANIFEST_INVALID', 'bundle file inventory is empty');
  }
  let previous = '';
  const portablePaths = new Set();
  for (const entry of value.files) {
    assertPortableRelativePath(entry?.path, 'BUNDLE_MANIFEST_INVALID');
    const portableKey = portablePathKey(entry.path);
    if (portablePaths.has(portableKey)) {
      throw bundleError('BUNDLE_MANIFEST_INVALID', `case or Unicode-colliding bundle path: ${entry.path}`);
    }
    portablePaths.add(portableKey);
    const expectedKeys = entry?.type === 'symlink'
      ? ['linkTarget', 'mode', 'path', 'sha256', 'size', 'type']
      : ['mode', 'path', 'sha256', 'size', 'type'];
    if (!entry
        || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys)
        || !['file', 'symlink'].includes(entry.type)
        || !SHA256_PATTERN.test(entry.sha256 ?? '')
        || !Number.isSafeInteger(entry.size)
        || entry.size < 0
        || !/^[0-7]{4}$/.test(entry.mode ?? '')
        || (entry.type === 'symlink' && typeof entry.linkTarget !== 'string')) {
      throw bundleError('BUNDLE_MANIFEST_INVALID', `invalid bundle file entry: ${entry?.path ?? '<missing>'}`);
    }
    if (portablePathKey(entry.path) === portablePathKey('bundle-manifest.json')
        || comparePortableUtf8(entry.path, previous) <= 0) {
      throw bundleError('BUNDLE_MANIFEST_INVALID', `unsorted or duplicate bundle path: ${entry.path}`);
    }
    previous = entry.path;
  }
  return value;
}

async function readRegularFile(filePath, code) {
  let handle;
  try {
    const pathStats = await fs.promises.lstat(filePath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1) {
      throw bundleError(code, `JSON input is not one regular non-hard-linked file: ${filePath}`);
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1
        || before.dev !== pathStats.dev || before.ino !== pathStats.ino
        || before.size !== pathStats.size) {
      throw bundleError(code, `JSON input is not one regular non-hard-linked file: ${filePath}`);
    }
    if (before.size > 8 * 1024 * 1024) {
      throw bundleError(code, `JSON file is too large: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || bytes.length !== before.size) {
      throw bundleError(code, `JSON input changed while reading: ${filePath}`);
    }
    return bytes;
  } catch (error) {
    if (error?.code === code) throw error;
    throw bundleError(code, `required JSON file is missing: ${filePath}`);
  } finally {
    await handle?.close();
  }
}

function parseJsonBytes(bytes, filePath, code) {
  if (bytes.length > 8 * 1024 * 1024) throw bundleError(code, `JSON file is too large: ${filePath}`);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw bundleError(code, `invalid JSON file: ${filePath}`);
  }
}

export async function readJsonFile(filePath, code = 'BUNDLE_MANIFEST_INVALID') {
  return parseJsonBytes(await readRegularFile(filePath, code), filePath, code);
}

export async function readCanonicalJsonFile(filePath) {
  const code = 'BUNDLE_MANIFEST_INVALID';
  const bytes = await readRegularFile(filePath, code);
  const value = parseJsonBytes(bytes, filePath, code);
  if (!bytes.equals(Buffer.from(canonicalJson(value), 'utf8'))) {
    throw bundleError('BUNDLE_MANIFEST_NONCANONICAL', `JSON file is not canonical: ${filePath}`);
  }
  return value;
}

export async function writeCanonicalJson(filePath, value) {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await fs.promises.rename(temporary, filePath);
}

export async function copyTree(sourceRoot, destinationRoot, options = {}) {
  const source = path.resolve(sourceRoot);
  const destination = path.resolve(destinationRoot);
  const filter = options.filter ?? (() => true);
  async function visit(
    sourceDirectory,
    destinationDirectory,
    prefix = '',
    expectedDirectoryStats,
  ) {
    const directoryStats = await assertStableDirectory(sourceDirectory, expectedDirectoryStats);
    await fs.promises.mkdir(destinationDirectory, { recursive: true });
    const children = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
    children.sort((left, right) => comparePortableUtf8(left.name, right.name));
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      assertPortableRelativePath(relative);
      if (!filter(relative, child)) continue;
      const sourcePath = path.join(sourceDirectory, child.name);
      const destinationPath = path.join(destinationDirectory, child.name);
      const stats = await fs.promises.lstat(sourcePath);
      if (stats.isDirectory()) {
        await visit(sourcePath, destinationPath, relative, stats);
      } else if (stats.isSymbolicLink()) {
        const target = await assertSafeSymlink(source, sourcePath, relative, stats);
        await fs.promises.symlink(target, destinationPath);
      } else if (stats.isFile()) {
        await copyRegularFileStable(sourcePath, destinationPath, { expectedStats: stats });
      } else {
        throw bundleError('BUNDLE_SPECIAL_FILE', `special filesystem entry is forbidden: ${relative}`);
      }
    }
    await assertStableDirectory(sourceDirectory, directoryStats);
  }
  await visit(source, destination);
}
