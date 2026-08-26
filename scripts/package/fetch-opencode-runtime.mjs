#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_REDIRECTS = 5;

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateRuntimeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object'
      || typeof manifest.version !== 'string'
      || typeof manifest.url !== 'string'
      || !SHA256.test(manifest.sha256 || '')
      || !Number.isSafeInteger(manifest.sizeBytes)
      || manifest.sizeBytes <= 0
      || manifest.binary !== 'opencode.exe') {
    throw runtimeError('OPENCODE_RUNTIME_MANIFEST_INVALID', 'OpenCode runtime manifest is invalid');
  }
  return manifest;
}

export async function verifyDownloadedArtifact({ filePath, manifest, fsPromises = fs.promises }) {
  validateRuntimeManifest(manifest);
  try {
    const [stats, bytes] = await Promise.all([
      fsPromises.stat(filePath),
      fsPromises.readFile(filePath),
    ]);
    if (!stats.isFile() || stats.size !== manifest.sizeBytes || bytes.length !== manifest.sizeBytes) {
      throw runtimeError('OPENCODE_RUNTIME_SIZE_MISMATCH', 'OpenCode runtime download size does not match the pinned manifest');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== manifest.sha256) {
      throw runtimeError('OPENCODE_RUNTIME_HASH_MISMATCH', 'OpenCode runtime download SHA-256 does not match the pinned manifest');
    }
  } catch (error) {
    await fsPromises.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
}

function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      const redirect = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && redirect) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          reject(runtimeError('OPENCODE_RUNTIME_REDIRECT_LIMIT', 'OpenCode runtime download exceeded redirect limit'));
          return;
        }
        download(new URL(redirect, url), destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(runtimeError('OPENCODE_RUNTIME_DOWNLOAD_FAILED', `OpenCode runtime download returned HTTP ${response.statusCode}`));
        return;
      }
      pipeline(response, fs.createWriteStream(destination, { flags: 'wx' })).then(resolve, reject);
    });
    request.once('error', reject);
  });
}

async function hasValidReceipt(stagingRoot, manifest) {
  try {
    const [receiptBytes, binary] = await Promise.all([
      fs.promises.readFile(path.join(stagingRoot, 'staged.json'), 'utf8'),
      fs.promises.lstat(path.join(stagingRoot, manifest.binary)),
    ]);
    const receipt = JSON.parse(receiptBytes);
    return binary.isFile() && !binary.isSymbolicLink()
      && receipt.version === manifest.version
      && receipt.sha256 === manifest.sha256
      && typeof receipt.stagedAt === 'string';
  } catch {
    return false;
  }
}

export async function fetchOpenCodeRuntime({
  manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-runtime.json'),
  stagingRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime-staging', 'opencode'),
  force = false,
  execFileImpl = execFile,
} = {}) {
  const manifest = validateRuntimeManifest(JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')));
  if (!force && await hasValidReceipt(stagingRoot, manifest)) {
    return { staged: false, stagingRoot, version: manifest.version };
  }

  const stagingParent = path.dirname(stagingRoot);
  await fs.promises.mkdir(stagingParent, { recursive: true });
  const archive = path.join(stagingParent, `.opencode-${process.pid}-${randomUUID()}.zip`);
  const extracted = path.join(stagingParent, `.opencode-${process.pid}-${randomUUID()}`);
  try {
    await download(manifest.url, archive);
    await verifyDownloadedArtifact({ filePath: archive, manifest });
    await fs.promises.mkdir(extracted, { recursive: true });
    // Zip extraction needs bsdtar. On Windows, Git for Windows often puts MSYS
    // GNU tar first on PATH, which cannot read zip archives and parses the
    // drive-letter colon in absolute paths as a remote host spec — so pin the
    // System32 bsdtar and keep the arguments cwd-relative.
    const tarExecutable = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    await execFileImpl(tarExecutable, ['-xf', path.basename(archive), '-C', path.basename(extracted), manifest.binary], {
      cwd: stagingParent,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const binary = path.join(extracted, manifest.binary);
    const stats = await fs.promises.lstat(binary);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw runtimeError('OPENCODE_RUNTIME_EXTRACT_INVALID', 'OpenCode runtime archive did not contain one regular opencode.exe');
    }
    await fs.promises.writeFile(path.join(extracted, 'staged.json'), `${JSON.stringify({
      version: manifest.version,
      sha256: manifest.sha256,
      stagedAt: new Date().toISOString(),
    })}\n`, { flag: 'wx', mode: 0o600 });
    await fs.promises.rm(stagingRoot, { recursive: true, force: true });
    await fs.promises.rename(extracted, stagingRoot);
    return { staged: true, stagingRoot, version: manifest.version };
  } catch (error) {
    await fs.promises.rm(extracted, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.promises.rm(archive, { force: true }).catch(() => {});
  }
}

function parseCli(argv) {
  if (argv.length === 0) return { force: false };
  if (argv.length === 1 && argv[0] === '--force') return { force: true };
  throw runtimeError('OPENCODE_RUNTIME_ARGUMENT_INVALID', 'only --force is supported');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  fetchOpenCodeRuntime(parseCli(process.argv.slice(2))).then((result) => {
    process.stdout.write(result.staged
      ? `OpenCode runtime staged: ${result.version}\n`
      : `OpenCode runtime already staged: ${result.version}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code ?? 'OPENCODE_RUNTIME_FETCH_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
