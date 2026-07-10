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

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

async function collectEntries(root, options = {}) {
  const excluded = new Set(options.excludeDirectoryNames ?? []);
  const entries = [];

  async function visit(directory, relativeDirectory = '') {
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
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
      } else if (stats.isFile() || stats.isSymbolicLink()) {
        entries.push({ absolute, relative, stats });
      }
    }
  }

  await visit(root);
  entries.sort((left, right) => left.relative.localeCompare(right.relative, 'en'));
  return entries;
}

export async function sha256Directory(root, options = {}) {
  const hash = createHash('sha256');
  const entries = await collectEntries(root, options);
  for (const entry of entries) {
    if (entry.stats.isSymbolicLink()) {
      const target = await fs.promises.readlink(entry.absolute);
      const digest = createHash('sha256').update(target).digest('hex');
      hash.update(`symlink\0${entry.relative}\0${digest}\n`);
    } else {
      hash.update(`file\0${entry.relative}\0${await sha256File(entry.absolute)}\n`);
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
      ? Buffer.from(await fs.promises.readlink(entry.absolute), 'utf8')
      : null;
    files.push({
      path: entry.relative,
      sha256: symbolicLink
        ? createHash('sha256').update(value).digest('hex')
        : await sha256File(entry.absolute),
      size: symbolicLink ? value.length : entry.stats.size,
      mode: (entry.stats.mode & 0o777).toString(8).padStart(4, '0'),
      type: symbolicLink ? 'symlink' : 'file',
    });
  }
  return files;
}

export async function writeJsonAtomically(destination, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await fs.promises.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  try {
    try {
      await fs.promises.link(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await fs.promises.readFile(destination);
      if (!existing.equals(bytes)) {
        throw new Error(`destination already exists with different content: ${destination}`);
      }
    }
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
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
