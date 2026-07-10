import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export async function pathExists(filePath) {
  try {
    await fs.promises.lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
}

export function comparePortableUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink
  );
}

async function openRegularFileNoFollow(filePath) {
  const pathStats = await fs.promises.lstat(filePath);
  if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1) {
    throw new Error(`refusing to read a non-regular file or symbolic link: ${filePath}`);
  }
  let handle;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new Error(`refusing to read a symbolic link: ${filePath}`, { cause: error });
    }
    throw error;
  }
  const openedStats = await handle.stat();
  if (!openedStats.isFile() || !sameFileIdentity(pathStats, openedStats)) {
    await handle.close();
    throw new Error(`file changed before opening without link traversal: ${filePath}`);
  }
  return handle;
}

export async function sha256File(filePath, options = {}) {
  const handle = await openRegularFileNoFollow(filePath);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`refusing to hash a non-regular file: ${filePath}`);
    if (options.expectedStats && !sameFileIdentity(before, options.expectedStats)) {
      throw new Error(`file changed during inventory before hashing: ${filePath}`);
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      !sameFileIdentity(before, after)
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`file changed during inventory while hashing: ${filePath}`);
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

export async function readRegularFileSnapshot(filePath, options = {}) {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error(`invalid regular file snapshot limit: ${maxBytes}`);
  }
  const handle = await openRegularFileNoFollow(filePath);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`refusing to read a non-regular file: ${filePath}`);
    if (options.expectedStats && !sameFileIdentity(before, options.expectedStats)) {
      throw new Error(`file changed before taking a snapshot: ${filePath}`);
    }
    if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maxBytes) {
      throw new Error(`regular file exceeds snapshot limit: ${filePath}`);
    }
    const bytes = Buffer.allocUnsafe(before.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (bytesRead === 0) break;
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      position !== bytes.length
      || !sameFileIdentity(before, after)
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`file changed while taking a snapshot: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function collectEntries(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  const excluded = new Set(options.excludeDirectoryNames ?? []);
  const entries = [];

  async function visit(directory, relativeDirectory = '') {
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => comparePortableUtf8(left.name, right.name));
    for (const child of children) {
      if (child.isDirectory() && excluded.has(child.name)) continue;
      const absolute = path.join(directory, child.name);
      const relative = path.posix.join(
        ...relativeDirectory.split(path.sep).filter(Boolean),
        child.name,
      );
      const stats = await fs.promises.lstat(absolute);
      if (stats.isDirectory()) {
        await visit(absolute, path.join(relativeDirectory, child.name));
      } else if (stats.isSymbolicLink()) {
        const target = await fs.promises.readlink(absolute);
        if (path.posix.isAbsolute(target) || path.win32.isAbsolute(target)) {
          throw new Error(`absolute symlink is not portable: ${relative} -> ${target}`);
        }
        const resolvedTarget = path.resolve(path.dirname(absolute), target);
        const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
        if (
          path.isAbsolute(relativeTarget)
          || relativeTarget === '..'
          || relativeTarget.startsWith(`..${path.sep}`)
        ) {
          throw new Error(`symlink escapes inventory root: ${relative} -> ${target}`);
        }
        entries.push({ absolute, relative, stats, target });
      } else if (stats.isFile()) {
        if (stats.nlink !== 1) {
          throw new Error(`hard-linked file is forbidden in inventory: ${relative}`);
        }
        entries.push({ absolute, relative, stats });
      } else {
        throw new Error(`unsupported special filesystem entry: ${relative}`);
      }
    }
  }

  await visit(root);
  entries.sort((left, right) => comparePortableUtf8(left.relative, right.relative));
  return entries;
}

async function stableSymlinkTarget(entry) {
  const before = await fs.promises.lstat(entry.absolute);
  if (!before.isSymbolicLink() || !sameFileIdentity(before, entry.stats)) {
    throw new Error(`symlink changed during inventory: ${entry.relative}`);
  }
  const target = await fs.promises.readlink(entry.absolute);
  const after = await fs.promises.lstat(entry.absolute);
  if (!after.isSymbolicLink() || !sameFileIdentity(before, after) || target !== entry.target) {
    throw new Error(`symlink changed during inventory: ${entry.relative}`);
  }
  return target;
}

export async function sha256Directory(root, options = {}) {
  const hash = createHash('sha256');
  const entries = await collectEntries(root, options);
  for (const entry of entries) {
    if (entry.stats.isSymbolicLink()) {
      const target = await stableSymlinkTarget(entry);
      const digest = createHash('sha256').update(target).digest('hex');
      hash.update(`symlink\0${entry.relative}\0${digest}\n`);
    } else {
      hash.update(
        `file\0${entry.relative}\0${await sha256File(entry.absolute, { expectedStats: entry.stats })}\n`,
      );
    }
  }
  return hash.digest('hex');
}

export async function inventoryFiles(root, options = {}) {
  const omitted = new Set(options.omitRelativePaths ?? []);
  const files = [];
  for (const entry of await collectEntries(root, options)) {
    if (omitted.has(entry.relative)) continue;
    const symbolicLink = entry.stats.isSymbolicLink();
    const value = symbolicLink
      ? Buffer.from(await stableSymlinkTarget(entry), 'utf8')
      : null;
    files.push({
      path: entry.relative,
      sha256: symbolicLink
        ? createHash('sha256').update(value).digest('hex')
        : await sha256File(entry.absolute, { expectedStats: entry.stats }),
      size: symbolicLink ? value.length : entry.stats.size,
      mode: (entry.stats.mode & 0o777).toString(8).padStart(4, '0'),
      type: symbolicLink ? 'symlink' : 'file',
    });
  }
  return files;
}

export async function writeBytesAtomically(destination, value, options = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.promises.writeFile(temporary, bytes, {
    flag: 'wx',
    mode: options.mode ?? 0o600,
  });
  try {
    try {
      await fs.promises.link(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readRegularFileSnapshot(destination, {
        maxBytes: Math.max(1, bytes.length),
      });
      if (!existing.equals(bytes)) {
        throw new Error(`destination already exists with different content: ${destination}`);
      }
    }
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

export async function writeJsonAtomically(destination, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await writeBytesAtomically(destination, bytes);
}

export async function createSiblingTempDirectory(destination) {
  const resolved = path.resolve(destination);
  const parent = path.dirname(resolved);
  await fs.promises.mkdir(parent, { recursive: true });
  return fs.promises.mkdtemp(path.join(parent, `.${path.basename(resolved)}.tmp-`));
}

export async function publishDirectoryAtomically({ temporary, destination }) {
  const resolvedTemporary = path.resolve(temporary);
  const resolvedDestination = path.resolve(destination);
  if (path.dirname(resolvedTemporary) !== path.dirname(resolvedDestination)) {
    throw new Error('atomic directory publication requires a same-parent temporary directory');
  }
  if (await pathExists(resolvedDestination)) {
    throw new Error(`destination already exists: ${resolvedDestination}`);
  }
  await fs.promises.rename(resolvedTemporary, resolvedDestination);
}
