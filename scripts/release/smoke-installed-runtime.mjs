import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  open,
  readdir,
  readlink,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalStringify, sha256File } from './artifact-manifest.mjs';
import { validateRuntimeManifest } from '../package/lib/runtime-manifest.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const PLATFORMS = new Set(['macos-arm64', 'windows-x64']);
const VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const RPC_TIMEOUT_MS = 30_000;
const TOOL_CHECKS = [
  ['ae.status', 'ae_status'],
  ['ae.diagnose', 'ae_diagnose'],
  ['ae.previewFrame', 'ae_previewFrame'],
  ['ae.snapshot', 'ae_snapshot'],
];

const { values } = parseArgs({
  strict: true,
  options: Object.fromEntries([
    'launcher', 'runtime-manifest', 'expected-platform', 'expected-version',
    'expected-runtime-manifest-sha256', 'expected-launcher-sha256',
    'expected-ae-major', 'out',
  ].map((name) => [name, { type: 'string' }])),
});

function required(name) {
  const value = String(values[name] || '');
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function readRegularFileSnapshot(filePath, maximumBytes = MAX_JSON_BYTES) {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximumBytes)) {
    throw new Error(`required regular file is invalid: ${filePath}`);
  }
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error(`required regular file changed identity: ${filePath}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!unchanged(opened, after) || BigInt(bytes.length) !== opened.size) {
      throw new Error(`required regular file changed while reading: ${filePath}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function verifyRuntimeFiles(runtimeRoot, manifest) {
  const realRoot = await realpath(runtimeRoot);
  const bundledPython = manifest.platform === 'macos-arm64'
    ? 'python/bin/python3'
    : 'python/python.exe';
  if (!manifest.files.some((entry) => entry.path === bundledPython && entry.type === 'file')) {
    throw new Error('runtime manifest does not contain the bundled Python entrypoint');
  }

  const declaredPaths = new Set(manifest.files.map((entry) => entry.path));
  const pendingDirectories = [{ absolute: runtimeRoot, relative: '' }];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const name of await readdir(directory.absolute)) {
      const absolute = path.join(directory.absolute, name);
      const relative = path.posix.join(
        directory.relative,
        String(name).split(path.sep).join('/'),
      );
      const stats = await lstat(absolute);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        pendingDirectories.push({ absolute, relative });
        continue;
      }
      // The manifest cannot hash itself. Every other file, symlink, or special
      // leaf must be declared so installed smoke cannot ignore injected code.
      if (relative !== 'runtime-manifest.json' && !declaredPaths.has(relative)) {
        throw new Error(`unmanifested runtime entry: ${relative}`);
      }
      if (!stats.isFile() && !stats.isSymbolicLink()) {
        throw new Error(`unsupported runtime entry: ${relative}`);
      }
    }
  }

  for (const entry of manifest.files) {
    const absolute = path.join(runtimeRoot, ...entry.path.split('/'));
    const stats = await lstat(absolute);
    if (entry.type === 'file') {
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== entry.size) {
        throw new Error(`runtime file metadata mismatch: ${entry.path}`);
      }
      const realFile = await realpath(absolute);
      if (!isWithin(realRoot, realFile)) {
        throw new Error(`runtime file escapes selected runtime: ${entry.path}`);
      }
      if (await sha256File(absolute) !== entry.sha256) {
        throw new Error(`runtime file digest mismatch: ${entry.path}`);
      }
      continue;
    }

    if (!stats.isSymbolicLink()) {
      throw new Error(`runtime symlink metadata mismatch: ${entry.path}`);
    }
    const targetBefore = await readlink(absolute);
    const targetBytes = Buffer.from(targetBefore, 'utf8');
    if (path.isAbsolute(targetBefore)
        || targetBytes.length !== entry.size
        || digestBytes(targetBytes) !== entry.sha256) {
      throw new Error(`runtime symlink digest mismatch: ${entry.path}`);
    }
    const resolvedTarget = await realpath(path.resolve(path.dirname(absolute), targetBefore));
    const targetAfter = await readlink(absolute);
    if (!isWithin(realRoot, resolvedTarget) || targetAfter !== targetBefore) {
      throw new Error(`runtime symlink escapes or changed: ${entry.path}`);
    }
  }
}

function expectedLauncherName(platform) {
  return platform === 'windows-x64' ? 'ae-mcp.exe' : 'ae-mcp';
}

function portablePathEqual(left, right, platform) {
  const normalize = (value) => path.resolve(value).normalize('NFC');
  const leftValue = normalize(left);
  const rightValue = normalize(right);
  return platform === 'windows-x64'
    ? leftValue.toLowerCase() === rightValue.toLowerCase()
    : leftValue === rightValue;
}

async function resolveInstalledRuntime(input) {
  const manifestPath = path.resolve(input.manifestPath);
  if (path.basename(manifestPath) !== 'runtime-manifest.json') {
    throw new Error('runtime manifest path must end in runtime-manifest.json');
  }
  const runtimeRoot = path.dirname(manifestPath);
  const versionRoot = path.dirname(runtimeRoot);
  const runtimeDirectory = path.dirname(versionRoot);
  const base = path.dirname(runtimeDirectory);
  if (path.basename(runtimeRoot) !== input.platform) throw new Error('platform mismatch in runtime path');
  if (path.basename(versionRoot) !== input.version) throw new Error('version mismatch in runtime path');
  if (path.basename(runtimeDirectory) !== 'runtime') throw new Error('runtime path is outside runtime home');

  const manifestBytes = await readRegularFileSnapshot(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('runtime manifest is not valid JSON');
  }
  if (manifest.platform !== input.platform) throw new Error('platform mismatch in runtime manifest');
  validateRuntimeManifest(manifest, input.platform, { code: 'INSTALLED_RUNTIME_MANIFEST_INVALID' });

  const selected = `${input.version}/${input.platform}`;
  const pointerBytes = await readRegularFileSnapshot(path.join(runtimeDirectory, 'current'), 1024);
  const pointer = pointerBytes.toString('utf8');
  if (![selected, `${selected}\n`, `${selected}\r\n`].includes(pointer)) {
    throw new Error('atomic current pointer does not select the requested runtime');
  }

  const launcher = path.resolve(input.launcher);
  const expectedLauncher = path.join(base, 'bin', expectedLauncherName(input.platform));
  if (!portablePathEqual(launcher, expectedLauncher, input.platform)) {
    throw new Error('stable launcher is outside the selected runtime home');
  }
  const launcherStats = await lstat(launcher);
  if (!launcherStats.isFile() || launcherStats.isSymbolicLink()
      || (input.platform === 'macos-arm64' && (launcherStats.mode & 0o111) === 0)) {
    throw new Error('stable launcher is missing or not executable');
  }

  await verifyRuntimeFiles(runtimeRoot, manifest);
  return {
    base,
    launcher,
    launcherSha256: await sha256File(launcher),
    manifest,
    manifestSha256: digestBytes(manifestBytes),
    runtimeRoot,
  };
}

function sanitizedEnvironment(base, platform) {
  const source = process.env;
  const allowed = [
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  ];
  const env = {};
  for (const key of allowed) {
    if (typeof source[key] === 'string' && source[key]) env[key] = source[key];
  }
  env.AE_MCP_HOME = base;
  if (platform === 'windows-x64') {
    const profile = path.dirname(base);
    const windows = source.SystemRoot || source.WINDIR || 'C:\\Windows';
    env.USERPROFILE = profile;
    env.HOME = profile;
    env.TEMP = source.TEMP || source.TMP || tmpdir();
    env.TMP = env.TEMP;
    env.PATH = [
      path.join(windows, 'System32'),
      windows,
      path.join(windows, 'System32', 'Wbem'),
    ].join(';');
  } else {
    const home = path.dirname(base);
    env.HOME = home;
    if (source.USER) env.USER = source.USER;
    if (source.LOGNAME) env.LOGNAME = source.LOGNAME;
    env.TMPDIR = tmpdir();
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  }
  return env;
}

function createNdjsonRpc(child) {
  let nextId = 1;
  let buffer = '';
  let closed = false;
  const pending = new Map();

  function rejectAll(message) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
      pending.delete(id);
    }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_JSON_BYTES) {
      rejectAll('installed launcher emitted an oversized MCP response');
      child.kill();
      return;
    }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        rejectAll('installed launcher emitted invalid MCP JSON');
        child.kill();
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`MCP ${entry.method} failed`));
      else entry.resolve(message.result);
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', () => rejectAll('installed stable launcher could not be started'));
  child.on('exit', (code) => {
    closed = true;
    if (pending.size) rejectAll(`installed stable launcher exited during MCP smoke (${String(code)})`);
  });

  function send(message) {
    if (closed || !child.stdin.writable) throw new Error('installed stable launcher is not writable');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { method, resolve, reject, timer });
      try {
        const message = { jsonrpc: '2.0', id, method };
        if (params !== undefined) message.params = params;
        send(message);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  function notify(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    send(message);
  }

  return { request, notify };
}

function parseToolPayload(result, label) {
  if (!result || result.isError === true || !Array.isArray(result.content)) {
    throw new Error(`${label} MCP check failed`);
  }
  const text = result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text;
  if (!text) throw new Error(`${label} returned no structured result`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid structured result`);
  }
  if (!payload || payload.ok !== true) throw new Error(`${label} did not report success`);
  return payload;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

async function runSmoke(installed, expected) {
  const child = spawn(installed.launcher, [], {
    cwd: installed.runtimeRoot,
    env: sanitizedEnvironment(installed.base, expected.platform),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rpc = createNdjsonRpc(child);
  const checks = [];
  try {
    const initialized = await rpc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'ae-mcp-rc-verifier', version: expected.version },
      capabilities: {},
    });
    if (!initialized || typeof initialized !== 'object') throw new Error('initialize returned no result');
    checks.push({ name: 'initialize', result: 'PASS' });
    rpc.notify('notifications/initialized');

    const listed = await rpc.request('tools/list', {});
    const names = new Set(Array.isArray(listed?.tools) ? listed.tools.map((tool) => tool?.name) : []);
    if (TOOL_CHECKS.some(([, name]) => !names.has(name))) {
      throw new Error('tools/list is missing an RC smoke tool');
    }
    checks.push({ name: 'tools/list', result: 'PASS' });

    let status;
    for (const [label, name] of TOOL_CHECKS) {
      const result = await rpc.request('tools/call', { name, arguments: {} });
      const payload = parseToolPayload(result, label);
      if (label === 'ae.status') status = payload;
      checks.push({ name: label, result: 'PASS' });
    }
    if (status.version !== expected.version) throw new Error('ae.status product version mismatch');
    if (Number(status.aeMajor) !== expected.aeMajor) throw new Error('ae.status AE major mismatch');
    if (status.runtimeManifestSha256 !== installed.manifestSha256) {
      throw new Error('ae.status runtime manifest digest mismatch');
    }
    return checks;
  } finally {
    await stopChild(child);
  }
}

const platform = required('expected-platform');
const version = required('expected-version');
const expectedRuntimeManifestSha256 = required('expected-runtime-manifest-sha256');
const expectedLauncherSha256 = required('expected-launcher-sha256');
const aeMajor = Number(required('expected-ae-major'));
if (!PLATFORMS.has(platform)) throw new Error('invalid expected platform');
if (!VERSION.test(version)) throw new Error('invalid expected version');
if (!DIGEST.test(expectedRuntimeManifestSha256)) {
  throw new Error('invalid expected runtime manifest digest');
}
if (!DIGEST.test(expectedLauncherSha256)) {
  throw new Error('invalid expected stable launcher digest');
}
if (![25, 26].includes(aeMajor)) throw new Error('invalid expected AE major');

const installedInput = {
  launcher: required('launcher'),
  manifestPath: required('runtime-manifest'),
  platform,
  version,
};
const installed = await resolveInstalledRuntime(installedInput);
if (installed.manifestSha256 !== expectedRuntimeManifestSha256) {
  throw new Error('installed runtime manifest digest mismatch');
}
if (installed.launcherSha256 !== expectedLauncherSha256) {
  throw new Error('installed stable launcher digest mismatch');
}
const checks = await runSmoke(installed, { platform, version, aeMajor });
const installedAfterSmoke = await resolveInstalledRuntime(installedInput);
if (installedAfterSmoke.manifestSha256 !== expectedRuntimeManifestSha256
    || installedAfterSmoke.launcherSha256 !== expectedLauncherSha256) {
  throw new Error('installed runtime or stable launcher changed during smoke');
}
if (checks.length !== 6 || checks.some((item) => item.result !== 'PASS')) {
  throw new Error('all six installed-runtime checks must pass');
}
const report = {
  schemaVersion: 1,
  platform,
  version,
  aeMajor,
  launcher: installed.launcher,
  launcherSha256: installed.launcherSha256,
  runtimeManifestSha256: installed.manifestSha256,
  checks,
};
const out = path.resolve(required('out'));
await writeFile(out, canonicalStringify(report), {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o600,
});
try {
  await chmod(out, 0o600);
} catch {
  // The Windows wrapper applies a user-only ACL to the evidence directory.
}
