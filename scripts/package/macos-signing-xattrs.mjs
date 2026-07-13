#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const XATTR = '/usr/bin/xattr';
const XATTR_DESCRIPTOR_PATH = '/dev/fd/3';
const MAX_XATTR_OUTPUT_BYTES = 1024 * 1024;
const RETAINED_XATTR = 'com.apple.provenance';

export const MACOS_SIGNING_REMOVABLE_XATTRS = Object.freeze([
  'com.apple.FinderInfo',
  'com.apple.ResourceFork',
  'com.apple.TextEncoding',
  'com.apple.fileprovider.dir#N',
  'com.apple.fileprovider.fpfs#P',
  'com.apple.quarantine',
]);

const REMOVABLE = new Set(MACOS_SIGNING_REMOVABLE_XATTRS);

function xattrError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function entryType(stats) {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'unsupported';
}

function entryIdentity(stats) {
  return Object.freeze({
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    type: entryType(stats),
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.nlink === right.nlink
    && left.type === right.type;
}

function assertSafeEntry(stats, relative) {
  const type = entryType(stats);
  if (stats.isSymbolicLink()
      || !['directory', 'file'].includes(type)
      || (type === 'file' && stats.nlink !== 1)) {
    throw xattrError(
      'SIGNING_XATTR_UNSAFE_ENTRY',
      `pre-sign xattr scan found an unsafe entry: ${relative}`,
    );
  }
  return entryIdentity(stats);
}

async function lstatOrChanged(absolute) {
  try {
    return await fs.promises.lstat(absolute);
  } catch (_error) {
    throw xattrError(
      'SIGNING_XATTR_SOURCE_CHANGED',
      'pre-sign xattr source changed during verification',
    );
  }
}

async function collectEntries(root) {
  const entries = [];
  async function visit(absolute, relative) {
    const stats = await fs.promises.lstat(absolute).catch(() => null);
    if (!stats) {
      throw xattrError(
        'SIGNING_XATTR_UNSAFE_ENTRY',
        `pre-sign xattr scan found an unsafe entry: ${relative}`,
      );
    }
    const identity = assertSafeEntry(stats, relative);
    if (relative === '.' && identity.type !== 'directory') {
      throw xattrError(
        'SIGNING_XATTR_UNSAFE_ENTRY',
        'pre-sign xattr signing root must be a directory',
      );
    }
    entries.push({ absolute, relative, identity });
    if (!stats.isDirectory()) return;
    const children = await fs.promises.readdir(absolute, { withFileTypes: true });
    children.sort((left, right) => compareUtf8(left.name, right.name));
    for (const child of children) {
      const childRelative = relative === '.' ? child.name : `${relative}/${child.name}`;
      await visit(path.join(absolute, child.name), childRelative);
    }
    const after = entryIdentity(await lstatOrChanged(absolute));
    if (!sameIdentity(identity, after)) {
      throw xattrError(
        'SIGNING_XATTR_SOURCE_CHANGED',
        'pre-sign xattr source changed during traversal',
      );
    }
  }
  await visit(root, '.');
  return entries;
}

function assertSameEntries(expected, actual) {
  if (expected.length !== actual.length) {
    throw xattrError(
      'SIGNING_XATTR_SOURCE_CHANGED',
      'pre-sign xattr entry set changed during verification',
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].relative !== actual[index].relative
        || !sameIdentity(expected[index].identity, actual[index].identity)) {
      throw xattrError(
        'SIGNING_XATTR_SOURCE_CHANGED',
        'pre-sign xattr entry identity changed during verification',
      );
    }
  }
}

async function openStableEntry(entry) {
  const before = entryIdentity(await lstatOrChanged(entry.absolute));
  if (!sameIdentity(entry.identity, before)) {
    throw xattrError(
      'SIGNING_XATTR_SOURCE_CHANGED',
      'pre-sign xattr entry changed before descriptor binding',
    );
  }
  let handle;
  try {
    const directoryFlag = entry.identity.type === 'directory'
      ? (fs.constants.O_DIRECTORY ?? 0)
      : 0;
    handle = await fs.promises.open(
      entry.absolute,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | directoryFlag,
    );
  } catch (_error) {
    throw xattrError(
      'SIGNING_XATTR_SOURCE_CHANGED',
      'pre-sign xattr entry could not be bound without link traversal',
    );
  }
  const opened = entryIdentity(await handle.stat());
  if (!sameIdentity(entry.identity, opened)) {
    await handle.close();
    throw xattrError(
      'SIGNING_XATTR_SOURCE_CHANGED',
      'pre-sign xattr entry changed while binding its descriptor',
    );
  }
  return handle;
}

async function withStableEntry(entry, operation) {
  const handle = await openStableEntry(entry);
  try {
    const result = await operation(handle);
    const openedAfter = entryIdentity(await handle.stat());
    const pathAfter = entryIdentity(await lstatOrChanged(entry.absolute));
    if (!sameIdentity(entry.identity, openedAfter)
        || !sameIdentity(entry.identity, pathAfter)) {
      throw xattrError(
        'SIGNING_XATTR_SOURCE_CHANGED',
        'pre-sign xattr entry changed during descriptor-bound operation',
      );
    }
    return result;
  } finally {
    await handle.close();
  }
}

async function execXattrWithHandle(file, args, { fileHandle, discardStdout = false }) {
  return new Promise((resolve, reject) => {
    let failure;
    const stdout = [];
    let stdoutBytes = 0;
    const child = spawn(file, args, {
      stdio: ['ignore', discardStdout ? 'ignore' : 'pipe', 'pipe', fileHandle.fd],
    });
    child.stdout?.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_XATTR_OUTPUT_BYTES) {
        failure = new Error('xattr output exceeded its reviewed limit');
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      if (failure || code !== 0) {
        reject(failure ?? new Error('xattr returned a non-zero exit status'));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: '' });
    });
  });
}

function parseXattrNames(rawOutput) {
  const raw = String(rawOutput ?? '');
  if (raw.length === 0) return [];
  if (!raw.endsWith('\n') || raw.endsWith('\n\n') || raw.includes('\r')) {
    throw xattrError(
      'SIGNING_XATTR_OUTPUT_INVALID',
      'xattr inspection returned an ambiguous attribute list',
    );
  }
  const names = raw.slice(0, -1).split('\n');
  if (names.some((name) => (
    name.length === 0 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)
  )) || new Set(names).size !== names.length) {
    throw xattrError(
      'SIGNING_XATTR_OUTPUT_INVALID',
      'xattr inspection returned an ambiguous attribute list',
    );
  }
  return names.sort(compareUtf8);
}

async function readXattrNames(entry, execFileImpl) {
  try {
    const result = await withStableEntry(entry, (fileHandle) => execFileImpl(
      XATTR,
      [XATTR_DESCRIPTOR_PATH],
      { fileHandle, absolute: entry.absolute, relative: entry.relative },
    ));
    return parseXattrNames(result?.stdout);
  } catch (_error) {
    if (['SIGNING_XATTR_OUTPUT_INVALID', 'SIGNING_XATTR_SOURCE_CHANGED'].includes(_error?.code)) {
      throw _error;
    }
    throw xattrError('SIGNING_XATTR_TOOL_FAILED', 'xattr inspection failed before signing');
  }
}

async function assertXattrExists(entry, attribute, execFileImpl) {
  try {
    await withStableEntry(entry, (fileHandle) => execFileImpl(
      XATTR,
      ['-p', attribute, XATTR_DESCRIPTOR_PATH],
      {
        fileHandle,
        absolute: entry.absolute,
        relative: entry.relative,
        discardStdout: true,
      },
    ));
  } catch (_error) {
    if (_error?.code === 'SIGNING_XATTR_SOURCE_CHANGED') throw _error;
    throw xattrError(
      'SIGNING_XATTR_OUTPUT_INVALID',
      'xattr inspection did not identify an exact attribute name',
    );
  }
}

async function removeXattr(entry, attribute, execFileImpl) {
  try {
    await withStableEntry(entry, (fileHandle) => execFileImpl(
      XATTR,
      ['-d', attribute, XATTR_DESCRIPTOR_PATH],
      { fileHandle, absolute: entry.absolute, relative: entry.relative },
    ));
  } catch (_error) {
    if (_error?.code === 'SIGNING_XATTR_SOURCE_CHANGED') throw _error;
    throw xattrError('SIGNING_XATTR_TOOL_FAILED', 'xattr cleanup failed before signing');
  }
}

export async function prepareMacosSigningXattrs({
  root,
  execFileImpl = execXattrWithHandle,
}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw xattrError('SIGNING_PATH_ABSOLUTE_REQUIRED', 'xattr signing root must be absolute');
  }
  const entries = await collectEntries(root);
  const initial = [];
  for (const entry of entries) {
    initial.push({
      ...entry,
      attributes: await readXattrNames(entry, execFileImpl),
    });
  }

  for (const entry of initial) {
    const forbidden = entry.attributes.find((attribute) => (
      attribute !== RETAINED_XATTR && !REMOVABLE.has(attribute)
    ));
    if (forbidden) {
      throw xattrError(
        'SIGNING_XATTR_FORBIDDEN',
        `pre-sign xattr policy rejected ${forbidden} at ${entry.relative}`,
      );
    }
    for (const attribute of entry.attributes) {
      await assertXattrExists(entry, attribute, execFileImpl);
    }
  }

  assertSameEntries(entries, await collectEntries(root));

  const removed = [];
  for (const entry of initial) {
    for (const attribute of entry.attributes) {
      if (!REMOVABLE.has(attribute)) continue;
      await removeXattr(entry, attribute, execFileImpl);
      removed.push({ path: entry.relative, attribute });
    }
  }

  const secondEntries = await collectEntries(root);
  assertSameEntries(entries, secondEntries);
  const retained = [];
  for (const entry of secondEntries) {
    const attributes = await readXattrNames(entry, execFileImpl);
    const unexpected = attributes.find((attribute) => attribute !== RETAINED_XATTR);
    if (unexpected) {
      throw xattrError(
        'SIGNING_XATTR_CLEANUP_FAILED',
        `pre-sign xattr cleanup did not converge at ${entry.relative}`,
      );
    }
    if (attributes.includes(RETAINED_XATTR)) {
      retained.push({ path: entry.relative, attribute: RETAINED_XATTR });
    }
  }
  assertSameEntries(entries, await collectEntries(root));

  return {
    schemaVersion: 1,
    policy: 'macos-signing-xattrs-v1',
    removed,
    retained,
  };
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--root' || !argv[1]) {
    throw xattrError('SIGNING_ARGUMENT_INVALID', 'expected --root <absolute-signing-root>');
  }
  return { root: argv[1] };
}

async function main(argv) {
  const audit = await prepareMacosSigningXattrs(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(audit)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.code ?? 'SIGNING_XATTR_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
