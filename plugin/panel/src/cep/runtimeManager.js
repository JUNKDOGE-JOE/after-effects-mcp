const RUNTIME_PLATFORM = 'macos-arm64';
const LOCK_NAME = '.runtime-manager.lock';
const INSTALL_RECORD = 'install-record.json';
const GENERATION_LAUNCHER = 'ae-mcp-launcher';
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class RuntimeManagerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeManagerError';
    this.code = code;
    this.details = details;
  }
}

function failure(code, message, details) {
  throw new RuntimeManagerError(code, message, details);
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort());
}

function portablePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024
      || value.includes('\\') || value.includes('\0') || value.startsWith('/')) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function pointerValue(value, platformId = RUNTIME_PLATFORM) {
  const text = String(value || '').trim();
  const parts = text.split('/');
  if (!portablePath(text) || parts.length !== 2 || parts[1] !== platformId) return '';
  return text;
}

function compareSemver(left, right) {
  const numbers = (value) => String(value).split(/[+-]/, 1)[0].split('.').map(Number);
  const a = numbers(left);
  const b = numbers(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function modeOf(stats) {
  return (stats.mode & 0o777).toString(8).padStart(4, '0');
}

function runtimeError(error, fallbackCode = 'RUNTIME_MANAGER_FAILED') {
  if (error instanceof RuntimeManagerError) return error;
  return new RuntimeManagerError(fallbackCode, String(error?.message || error), {
    causeCode: typeof error?.code === 'string' ? error.code : undefined,
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRandomBytes(size) {
  const requireImpl = globalThis.window?.cep_node?.require
    || globalThis.window?.require
    || globalThis.require;
  if (typeof requireImpl !== 'function') {
    failure('RUNTIME_CRYPTO_UNAVAILABLE', 'CEP Node crypto is unavailable');
  }
  return requireImpl('crypto').randomBytes(size);
}

function randomHex(randomBytes, size = 8) {
  return Buffer.from(randomBytes(size)).toString('hex');
}

export function createRuntimeManager({
  platform,
  extensionRoot,
  fsImpl,
  cryptoImpl,
  randomBytes = defaultRandomBytes,
  now = () => Date.now(),
  sleep = defaultSleep,
  pid = Number(globalThis.window?.cep_node?.process?.pid || globalThis.process?.pid || 0),
  lockTimeoutMs = 10000,
  lockPollMs = 25,
} = {}) {
  if (!platform || platform.id !== RUNTIME_PLATFORM) {
    failure('RUNTIME_PLATFORM_UNSUPPORTED', 'RuntimeManager currently supports Apple Silicon macOS only');
  }
  if (!platform.paths || !platform.fs || !extensionRoot) {
    failure('RUNTIME_MANAGER_INPUT_INVALID', 'RuntimeManager requires a platform adapter and extension root');
  }
  const fs = fsImpl || platform.fs;
  const paths = platform.paths;
  const promises = fs.promises;
  if (!promises) failure('RUNTIME_FILESYSTEM_UNAVAILABLE', 'CEP Node filesystem promises are unavailable');
  const crypto = cryptoImpl || (() => {
    const requireImpl = globalThis.window?.cep_node?.require
      || globalThis.window?.require
      || globalThis.require;
    return typeof requireImpl === 'function' ? requireImpl('crypto') : null;
  })();
  if (!crypto || typeof crypto.createHash !== 'function') {
    failure('RUNTIME_CRYPTO_UNAVAILABLE', 'CEP Node crypto is unavailable');
  }

  const root = paths.runtimeRoot;
  const lockPath = paths.join([root, LOCK_NAME]);
  const packageManifestPath = paths.join([extensionRoot, 'bundle-manifest.json']);
  const packagedRuntimeRoot = paths.join([extensionRoot, 'runtime', platform.id]);
  const packagedRuntimeManifest = paths.join([packagedRuntimeRoot, 'runtime-manifest.json']);
  const packagedLauncher = paths.join([extensionRoot, 'platform', platform.id, 'bin', 'ae-mcp']);

  async function sha256File(filePath) {
    const info = await promises.lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink?.() || info.nlink !== 1) {
      failure('RUNTIME_FILE_INVALID', 'Runtime payload requires an ordinary file', { path: filePath });
    }
    const bytes = await promises.readFile(filePath);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  }

  async function readJson(filePath, code) {
    try {
      const info = await promises.lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink?.() || info.nlink !== 1) {
        failure(code, 'Runtime metadata is not an ordinary file', { path: filePath });
      }
      return JSON.parse(String(await promises.readFile(filePath, 'utf8')));
    } catch (error) {
      if (error instanceof RuntimeManagerError) throw error;
      failure(code, 'Runtime metadata is missing or invalid', { path: filePath });
    }
  }

  async function ordinaryFileSignal(
    filePath,
    code,
    {
      executable = false,
      expectedMode,
      expectedSize,
    } = {},
  ) {
    let info;
    try {
      info = await promises.lstat(filePath);
    } catch (error) {
      failure(code, 'Trusted local runtime metadata is missing', { path: filePath });
    }
    if (!info.isFile() || info.isSymbolicLink?.() || info.nlink !== 1
        || (executable && (info.mode & 0o111) === 0)
        || (expectedMode && modeOf(info) !== expectedMode)
        || (Number.isSafeInteger(expectedSize) && info.size !== expectedSize)) {
      failure(code, 'Trusted local runtime metadata changed', {
        path: filePath,
        size: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
      });
    }
    return {
      path: filePath,
      size: info.size,
      mtimeMs: Math.trunc(info.mtimeMs),
      mode: modeOf(info),
    };
  }

  async function executableSignal(
    filePath,
    code,
    {
      rootDirectory,
      expectedMode,
      expectedSize,
      expectedType,
    } = {},
  ) {
    let info;
    try {
      info = await promises.lstat(filePath);
    } catch (error) {
      failure(code, 'Trusted local runtime entrypoint is missing', { path: filePath });
    }
    const type = info.isSymbolicLink?.() ? 'symlink' : 'file';
    if ((expectedType && type !== expectedType)
        || (expectedMode && modeOf(info) !== expectedMode)
        || (Number.isSafeInteger(expectedSize) && info.size !== expectedSize)) {
      failure(code, 'Trusted local runtime entrypoint metadata changed', {
        path: filePath,
        size: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
      });
    }
    if (type === 'file') {
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o111) === 0) {
        failure(code, 'Trusted local runtime entrypoint changed', { path: filePath });
      }
      return {
        path: filePath,
        type,
        size: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
        mode: modeOf(info),
      };
    }
    let target;
    let targetInfo;
    try {
      target = await promises.readlink(filePath);
      const resolved = paths.resolve([paths.dirname(filePath), target]);
      if (!rootDirectory || paths.isAbsolute(target) || !paths.contains(rootDirectory, resolved)) {
        failure(code, 'Trusted local runtime entrypoint symlink is unsafe', { path: filePath });
      }
      targetInfo = await promises.lstat(resolved);
    } catch (error) {
      if (error instanceof RuntimeManagerError) throw error;
      failure(code, 'Trusted local runtime entrypoint symlink is invalid', { path: filePath });
    }
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink?.() || targetInfo.nlink !== 1
        || (targetInfo.mode & 0o111) === 0) {
      failure(code, 'Trusted local runtime entrypoint target changed', { path: filePath });
    }
    return {
      path: filePath,
      type,
      size: targetInfo.size,
      mtimeMs: Math.trunc(targetInfo.mtimeMs),
      mode: modeOf(targetInfo),
      linkTarget: target,
      linkSize: info.size,
      linkMtimeMs: Math.trunc(info.mtimeMs),
    };
  }

  function validateRuntimeManifest(value) {
    if (!value || value.schemaVersion !== 1 || value.platform !== platform.id
        || value.node?.version !== '24.17.0' || value.python?.version !== '3.13.14'
        || !Array.isArray(value.files) || value.files.length === 0) {
      failure('RUNTIME_MANIFEST_INVALID', 'Runtime manifest identity is invalid');
    }
    const seen = new Set();
    let previous = '';
    for (const record of value.files) {
      if (!exactKeys(record, ['mode', 'path', 'sha256', 'size', 'type'])
          || !portablePath(record.path) || !['file', 'symlink'].includes(record.type)
          || !SHA256.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 0
          || !/^[0-7]{4}$/.test(record.mode) || seen.has(record.path)
          || (previous && compareUtf8(record.path, previous) <= 0)) {
        failure('RUNTIME_MANIFEST_INVALID', 'Runtime manifest file inventory is invalid');
      }
      seen.add(record.path);
      previous = record.path;
    }
    return value;
  }

  async function actualRuntimePaths(directory, prefix = '', values = []) {
    const entries = await promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!portablePath(relative)) failure('RUNTIME_FILE_INVALID', 'Runtime contains an unsafe path');
      const absolute = paths.join([directory, entry.name]);
      const info = await promises.lstat(absolute);
      if (info.isDirectory() && !info.isSymbolicLink?.()) {
        await actualRuntimePaths(absolute, relative, values);
      } else if (relative !== 'runtime-manifest.json') {
        values.push(relative);
      }
    }
    return values;
  }

  async function verifyRuntime(directory, expectedManifestSha256) {
    const manifestPath = paths.join([directory, 'runtime-manifest.json']);
    if (expectedManifestSha256 && await sha256File(manifestPath) !== expectedManifestSha256) {
      failure('RUNTIME_HASH_MISMATCH', 'Runtime manifest digest does not match its install record');
    }
    const manifest = validateRuntimeManifest(await readJson(manifestPath, 'RUNTIME_MANIFEST_INVALID'));
    const expectedPaths = manifest.files.map((record) => record.path);
    const actualPaths = (await actualRuntimePaths(directory)).sort(compareUtf8);
    if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
      failure('RUNTIME_INCOMPLETE', 'Runtime file inventory is incomplete or contains unexpected files');
    }
    for (const record of manifest.files) {
      const absolute = paths.join([directory, ...record.path.split('/')]);
      const info = await promises.lstat(absolute);
      if (modeOf(info) !== record.mode) {
        failure('RUNTIME_METADATA_MISMATCH', 'Runtime file mode does not match the manifest', { path: record.path });
      }
      let bytes;
      if (record.type === 'symlink') {
        if (!info.isSymbolicLink?.()) failure('RUNTIME_METADATA_MISMATCH', 'Runtime symlink is missing', { path: record.path });
        const target = await promises.readlink(absolute);
        const lexical = paths.resolve([paths.dirname(absolute), target]);
        if (paths.isAbsolute(target) || !paths.contains(directory, lexical)) {
          failure('RUNTIME_SYMLINK_UNSAFE', 'Runtime symlink escapes its version directory', { path: record.path });
        }
        bytes = Buffer.from(target, 'utf8');
      } else {
        if (!info.isFile() || info.isSymbolicLink?.() || info.nlink !== 1) {
          failure('RUNTIME_METADATA_MISMATCH', 'Runtime ordinary file is missing', { path: record.path });
        }
        bytes = await promises.readFile(absolute);
      }
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (bytes.length !== record.size || digest !== record.sha256) {
        failure('RUNTIME_HASH_MISMATCH', 'Runtime file digest does not match the manifest', { path: record.path });
      }
    }
    return manifest;
  }

  function validateBundleManifest(value) {
    if (!value || value.schemaVersion !== 1 || value.platform !== platform.id
        || !SEMVER.test(value.version || '') || !SOURCE_SHA.test(value.sourceCommitSha || '')
        || !SHA256.test(value.runtime?.manifestSha256 || '')
        || !Array.isArray(value.files) || value.files.length === 0) {
      failure('RUNTIME_BUNDLE_INVALID', 'Packaged runtime bundle manifest is invalid');
    }
    const byPath = new Map();
    for (const record of value.files) {
      if (!portablePath(record?.path) || !SHA256.test(record?.sha256 || '')
          || !['file', 'symlink'].includes(record?.type) || byPath.has(record.path)) {
        failure('RUNTIME_BUNDLE_INVALID', 'Packaged runtime bundle inventory is invalid');
      }
      byPath.set(record.path, record);
    }
    return { manifest: value, byPath };
  }

  async function inspectPackagedPayload() {
    const { manifest, byPath } = validateBundleManifest(
      await readJson(packageManifestPath, 'RUNTIME_BUNDLE_INVALID'),
    );
    const runtimeManifestRelative = `runtime/${platform.id}/runtime-manifest.json`;
    const launcherRelative = `platform/${platform.id}/bin/ae-mcp`;
    const nodeRelative = `runtime/${platform.id}/node/bin/node`;
    const pythonRelative = `runtime/${platform.id}/python/bin/python3`;
    const runtimeRecord = byPath.get(runtimeManifestRelative);
    const launcherRecord = byPath.get(launcherRelative);
    const nodeRecord = byPath.get(nodeRelative);
    const pythonRecord = byPath.get(pythonRelative);
    if (!runtimeRecord || runtimeRecord.type !== 'file'
        || runtimeRecord.sha256 !== manifest.runtime.manifestSha256
        || !Number.isSafeInteger(runtimeRecord.size) || runtimeRecord.size <= 0
        || !launcherRecord || launcherRecord.type !== 'file'
        || !Number.isSafeInteger(launcherRecord.size) || launcherRecord.size <= 0
        || !nodeRecord || nodeRecord.type !== 'file'
        || !Number.isSafeInteger(nodeRecord.size) || nodeRecord.size <= 0
        || !pythonRecord || !['file', 'symlink'].includes(pythonRecord.type)
        || !Number.isSafeInteger(pythonRecord.size) || pythonRecord.size <= 0) {
      failure('RUNTIME_BUNDLE_INVALID', 'Packaged runtime entrypoints or stable launcher are not declared');
    }
    const runtimeManifestSignal = await ordinaryFileSignal(
      packagedRuntimeManifest,
      'RUNTIME_BUNDLE_METADATA_CHANGED',
      { expectedMode: runtimeRecord.mode, expectedSize: runtimeRecord.size },
    );
    const launcherSignal = await ordinaryFileSignal(
      packagedLauncher,
      'RUNTIME_BUNDLE_METADATA_CHANGED',
      {
        executable: true,
        expectedMode: launcherRecord.mode,
        expectedSize: launcherRecord.size,
      },
    );
    const nodeSignal = await ordinaryFileSignal(
      paths.join([packagedRuntimeRoot, 'node', 'bin', 'node']),
      'RUNTIME_BUNDLE_METADATA_CHANGED',
      {
        executable: true,
        expectedMode: nodeRecord.mode,
        expectedSize: nodeRecord.size,
      },
    );
    const pythonSignal = await executableSignal(
      paths.join([packagedRuntimeRoot, 'python', 'bin', 'python3']),
      'RUNTIME_BUNDLE_METADATA_CHANGED',
      {
        rootDirectory: packagedRuntimeRoot,
        expectedMode: pythonRecord.mode,
        expectedSize: pythonRecord.size,
        expectedType: pythonRecord.type,
      },
    );
    return {
      version: manifest.version,
      sourceCommitSha: manifest.sourceCommitSha,
      runtimeManifestSha256: manifest.runtime.manifestSha256,
      launcherSha256: launcherRecord.sha256,
      signals: {
        runtimeManifest: runtimeManifestSignal,
        launcher: launcherSignal,
        node: nodeSignal,
        python: pythonSignal,
      },
    };
  }

  async function verifyPackagedPayload() {
    const { manifest, byPath } = validateBundleManifest(
      await readJson(packageManifestPath, 'RUNTIME_BUNDLE_INVALID'),
    );
    const runtimeManifestRelative = `runtime/${platform.id}/runtime-manifest.json`;
    const launcherRelative = `platform/${platform.id}/bin/ae-mcp`;
    const runtimeRecord = byPath.get(runtimeManifestRelative);
    const launcherRecord = byPath.get(launcherRelative);
    if (!runtimeRecord || runtimeRecord.type !== 'file'
        || runtimeRecord.sha256 !== manifest.runtime.manifestSha256
        || !launcherRecord || launcherRecord.type !== 'file') {
      failure('RUNTIME_BUNDLE_INVALID', 'Packaged runtime or stable launcher is not declared');
    }
    if (await sha256File(packagedRuntimeManifest) !== runtimeRecord.sha256
        || await sha256File(packagedLauncher) !== launcherRecord.sha256) {
      failure('RUNTIME_BUNDLE_CORRUPT', 'Packaged runtime or stable launcher failed SHA-256 verification');
    }
    await verifyRuntime(packagedRuntimeRoot, manifest.runtime.manifestSha256);
    return {
      version: manifest.version,
      sourceCommitSha: manifest.sourceCommitSha,
      runtimeManifestSha256: manifest.runtime.manifestSha256,
      launcherSha256: launcherRecord.sha256,
    };
  }

  function installRecordPath(relative) {
    return paths.join([root, relative.split('/')[0], INSTALL_RECORD]);
  }

  function generationLauncherPath(relative) {
    return paths.join([root, relative.split('/')[0], GENERATION_LAUNCHER]);
  }

  function validateInstallRecord(record, normalized) {
    if (!exactKeys(record, [
      'installedAt', 'launcherSha256', 'platform', 'relative', 'runtimeManifestSha256',
      'schemaVersion', 'sourceCommitSha', 'version',
    ]) || record.schemaVersion !== 1 || record.platform !== platform.id
        || record.relative !== normalized || !SEMVER.test(record.version)
        || !SOURCE_SHA.test(record.sourceCommitSha)
        || !SHA256.test(record.runtimeManifestSha256) || !SHA256.test(record.launcherSha256)
        || !Number.isSafeInteger(record.installedAt) || record.installedAt < 0) {
      failure('RUNTIME_INSTALL_RECORD_INVALID', 'Runtime install record is invalid');
    }
    return record;
  }

  async function inspectInstalled(relative) {
    const normalized = pointerValue(relative, platform.id);
    if (!normalized) failure('RUNTIME_POINTER_INVALID', 'Runtime pointer is invalid');
    const record = validateInstallRecord(
      await readJson(installRecordPath(normalized), 'RUNTIME_INSTALL_RECORD_INVALID'),
      normalized,
    );
    const directory = paths.join([root, ...normalized.split('/')]);
    const signals = {
      runtimeManifest: await ordinaryFileSignal(
        paths.join([directory, 'runtime-manifest.json']),
        'RUNTIME_TRUST_SIGNAL_CHANGED',
        {},
      ),
      launcher: await ordinaryFileSignal(
        generationLauncherPath(normalized),
        'RUNTIME_TRUST_SIGNAL_CHANGED',
        { executable: true, expectedMode: '0755' },
      ),
      node: await ordinaryFileSignal(
        paths.join([directory, 'node', 'bin', 'node']),
        'RUNTIME_TRUST_SIGNAL_CHANGED',
        { executable: true },
      ),
      python: await executableSignal(
        paths.join([directory, 'python', 'bin', 'python3']),
        'RUNTIME_TRUST_SIGNAL_CHANGED',
        { rootDirectory: directory },
      ),
    };
    return {
      relative: normalized,
      directory,
      launcher: generationLauncherPath(normalized),
      record,
      signals,
    };
  }

  async function verifyInstalled(relative) {
    const selected = await inspectInstalled(relative);
    const { record, directory } = selected;
    await verifyRuntime(directory, record.runtimeManifestSha256);
    const launcher = selected.launcher;
    const launcherInfo = await promises.lstat(launcher);
    if (!launcherInfo.isFile() || launcherInfo.isSymbolicLink?.() || launcherInfo.nlink !== 1
        || modeOf(launcherInfo) !== '0755' || await sha256File(launcher) !== record.launcherSha256) {
      failure('RUNTIME_LAUNCHER_CORRUPT', 'Runtime generation launcher failed verification');
    }
    return selected;
  }

  async function pointerState(pointerPath) {
    try {
      const info = await promises.lstat(pointerPath);
      if (!info.isFile() || info.isSymbolicLink?.() || info.nlink !== 1) {
        return { exists: true, ok: false, code: 'RUNTIME_POINTER_INVALID' };
      }
      const relative = pointerValue(await promises.readFile(pointerPath, 'utf8'), platform.id);
      if (!relative) return { exists: true, ok: false, code: 'RUNTIME_POINTER_INVALID' };
      try {
        return { exists: true, ok: true, ...(await inspectInstalled(relative)) };
      } catch (error) {
        const normalized = runtimeError(error);
        return { exists: true, ok: false, relative, code: normalized.code, detail: normalized.message };
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return { exists: false, ok: false, code: 'RUNTIME_POINTER_MISSING' };
      throw error;
    }
  }

  async function atomicWrite(filePath, value, mode = 0o600) {
    await promises.mkdir(paths.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = paths.join([
      paths.dirname(filePath),
      `.${paths.basename(filePath)}.${pid}.${randomHex(randomBytes)}.tmp`,
    ]);
    try {
      await promises.writeFile(temporary, value, { flag: 'wx', mode });
      await promises.rename(temporary, filePath);
    } finally {
      await promises.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function writePointer(pointerPath, relative) {
    const normalized = pointerValue(relative, platform.id);
    if (!normalized) failure('RUNTIME_POINTER_INVALID', 'Refused to write an invalid runtime pointer');
    await atomicWrite(pointerPath, `${normalized}\n`);
  }

  async function removePointer(pointerPath) {
    await promises.rm(pointerPath, { force: true });
  }

  async function copyTree(source, destination) {
    await promises.mkdir(destination, { recursive: true, mode: 0o700 });
    const entries = await promises.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      const from = paths.join([source, entry.name]);
      const to = paths.join([destination, entry.name]);
      const info = await promises.lstat(from);
      if (info.isDirectory() && !info.isSymbolicLink?.()) {
        await copyTree(from, to);
      } else if (info.isSymbolicLink?.()) {
        await promises.symlink(await promises.readlink(from), to);
      } else if (info.isFile() && info.nlink === 1) {
        await promises.copyFile(from, to, fs.constants?.COPYFILE_EXCL);
        await promises.chmod(to, info.mode & 0o777);
      } else {
        failure('RUNTIME_FILE_INVALID', 'Packaged runtime contains an unsupported filesystem entry');
      }
    }
  }

  async function installLauncher(selected) {
    try {
      const source = await ordinaryFileSignal(
        selected.launcher,
        'RUNTIME_LAUNCHER_CORRUPT',
        { executable: true, expectedMode: '0755' },
      );
      await ordinaryFileSignal(
        paths.launcher,
        'RUNTIME_LAUNCHER_CORRUPT',
        { executable: true, expectedMode: '0755', expectedSize: source.size },
      );
      return;
    } catch (error) {
      if (!(error instanceof RuntimeManagerError) && error?.code !== 'ENOENT') throw error;
    }
    await promises.mkdir(paths.binRoot, { recursive: true, mode: 0o700 });
    const bytes = await promises.readFile(selected.launcher);
    await atomicWrite(paths.launcher, bytes, 0o755);
    await promises.chmod(paths.launcher, 0o755);
    await ordinaryFileSignal(
      paths.launcher,
      'RUNTIME_LAUNCHER_CORRUPT',
      { executable: true, expectedMode: '0755', expectedSize: bytes.length },
    );
  }

  function assertLauncherTransitionCompatible(selected, current) {
    if (!current?.ok || current.relative === selected.relative) return;
    if (current.record.launcherSha256 !== selected.record.launcherSha256) {
      failure(
        'RUNTIME_LAUNCHER_MIGRATION_REQUIRED',
        'The stable launcher contract changed; keep the active runtime until a dedicated launcher migration is available',
        {
          currentSourceCommitSha: current.record.sourceCommitSha,
          selectedSourceCommitSha: selected.record.sourceCommitSha,
        },
      );
    }
  }

  async function installPackaged(packaged, { repair = false } = {}) {
    const identity = `${packaged.version}-${packaged.sourceCommitSha}`;
    let runtimeId = identity;
    const normalRelative = `${runtimeId}/${platform.id}`;
    try {
      const existing = await verifyInstalled(normalRelative);
      if (!repair && existing.record.runtimeManifestSha256 === packaged.runtimeManifestSha256) return existing;
      runtimeId = `${identity}-repair-${randomHex(randomBytes, 6)}`;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof RuntimeManagerError)) throw error;
      try {
        await promises.lstat(paths.join([root, identity]));
        runtimeId = `${identity}-repair-${randomHex(randomBytes, 6)}`;
      } catch (missing) {
        if (missing?.code !== 'ENOENT') throw missing;
      }
    }
    const relative = `${runtimeId}/${platform.id}`;
    const temporary = paths.join([root, `.stage-${runtimeId}-${randomHex(randomBytes, 6)}`]);
    const finalRoot = paths.join([root, runtimeId]);
    try {
      await promises.mkdir(root, { recursive: true, mode: 0o700 });
      await promises.mkdir(temporary, { mode: 0o700 });
      await copyTree(packagedRuntimeRoot, paths.join([temporary, platform.id]));
      await promises.copyFile(
        packagedLauncher,
        paths.join([temporary, GENERATION_LAUNCHER]),
        fs.constants?.COPYFILE_EXCL,
      );
      await promises.chmod(paths.join([temporary, GENERATION_LAUNCHER]), 0o755);
      const record = {
        schemaVersion: 1,
        platform: platform.id,
        version: packaged.version,
        sourceCommitSha: packaged.sourceCommitSha,
        runtimeManifestSha256: packaged.runtimeManifestSha256,
        launcherSha256: packaged.launcherSha256,
        relative,
        installedAt: Math.max(0, Math.floor(now())),
      };
      await promises.writeFile(
        paths.join([temporary, INSTALL_RECORD]),
        `${JSON.stringify(record, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      await verifyRuntime(paths.join([temporary, platform.id]), packaged.runtimeManifestSha256);
      if (await sha256File(paths.join([temporary, GENERATION_LAUNCHER])) !== packaged.launcherSha256) {
        failure('RUNTIME_LAUNCHER_CORRUPT', 'Staged runtime launcher failed verification');
      }
      await promises.rename(temporary, finalRoot);
      return verifyInstalled(relative);
    } catch (error) {
      await promises.rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw runtimeError(error, 'RUNTIME_INSTALL_FAILED');
    }
  }

  async function activate(selected, previous) {
    if (previous?.ok && previous.relative !== selected.relative) {
      await writePointer(paths.previousPointer, previous.relative);
    } else {
      await removePointer(paths.previousPointer);
    }
    await writePointer(paths.currentPointer, selected.relative);
  }

  async function acquireLock() {
    await promises.mkdir(root, { recursive: true, mode: 0o700 });
    const deadline = now() + lockTimeoutMs;
    while (true) {
      try {
        const handle = await promises.open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ pid, acquiredAt: Math.floor(now()) })}\n`);
        } catch (error) {
          await handle.close().catch(() => {});
          await promises.rm(lockPath, { force: true }).catch(() => {});
          throw error;
        }
        await handle.close();
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (now() >= deadline) {
          failure('RUNTIME_MANAGER_LOCKED', 'Another panel is updating the runtime; retry after it finishes');
        }
        await sleep(lockPollMs);
      }
    }
  }

  async function withLock(callback) {
    await acquireLock();
    try {
      return await callback();
    } finally {
      await promises.rm(lockPath, { force: true }).catch(() => {});
    }
  }

  let readinessPromise = null;

  function ensureReady() {
    if (readinessPromise) return readinessPromise;
    const pending = withLock(async () => {
      let current = await pointerState(paths.currentPointer);
      const previous = await pointerState(paths.previousPointer);
      if (!current.ok && previous.ok) {
        await installLauncher(previous);
        await writePointer(paths.currentPointer, previous.relative);
        await removePointer(paths.previousPointer);
        return {
          ok: true,
          action: 'fallback',
          launcher: paths.launcher,
          relative: previous.relative,
          version: previous.record.version,
          sourceCommitSha: previous.record.sourceCommitSha,
          diagnostics: [{
            code: 'RUNTIME_CURRENT_INVALID_FALLBACK',
            message: 'The current runtime was invalid; RuntimeManager activated the previous verified runtime once.',
            failedCode: current.code,
          }],
        };
      }
      let packaged;
      try {
        packaged = await inspectPackagedPayload();
      } catch (error) {
        if (!current.ok) throw error;
        await installLauncher(current);
        return {
          ok: true,
          action: 'retained',
          launcher: paths.launcher,
          relative: current.relative,
          version: current.record.version,
          sourceCommitSha: current.record.sourceCommitSha,
          diagnostics: [{
            code: 'RUNTIME_PACKAGED_PAYLOAD_INVALID_ACTIVE_RETAINED',
            message: 'The extension runtime payload was invalid; RuntimeManager retained the previously verified active runtime.',
            failedCode: error?.code || 'RUNTIME_PACKAGED_PAYLOAD_INVALID',
          }],
        };
      }
      const declaredRuntimeMatches = current.ok
        && current.record.version === packaged.version
        && current.record.runtimeManifestSha256 === packaged.runtimeManifestSha256
        && current.record.launcherSha256 === packaged.launcherSha256;
      const trustedSignalsMatch = declaredRuntimeMatches
        && current.signals.runtimeManifest.size === packaged.signals.runtimeManifest.size
        && current.signals.launcher.size === packaged.signals.launcher.size
        && current.signals.node.size === packaged.signals.node.size
        && current.signals.python.size === packaged.signals.python.size
        && current.signals.python.type === packaged.signals.python.type
        && current.signals.python.linkTarget === packaged.signals.python.linkTarget;
      if (trustedSignalsMatch) {
        await installLauncher(current);
        return {
          ok: true, action: 'ready', launcher: paths.launcher, relative: current.relative,
          version: current.record.version,
          sourceCommitSha: current.record.sourceCommitSha,
          packagedSourceCommitSha: packaged.sourceCommitSha,
          trustSignals: current.signals,
          diagnostics: current.record.sourceCommitSha === packaged.sourceCommitSha ? [] : [{
            code: 'RUNTIME_SOURCE_REVISION_DIFFERENT_TRUSTED',
            message: 'The unchanged installed runtime was reused across an advisory source revision change.',
          }],
        };
      }
      if (declaredRuntimeMatches) {
        current = {
          ...current,
          ok: false,
          code: 'RUNTIME_TRUST_SIGNAL_CHANGED',
          detail: 'A bounded runtime size or metadata signal changed.',
        };
      }
      packaged = await verifyPackagedPayload();
      const selected = await installPackaged(packaged);
      assertLauncherTransitionCompatible(selected, current);
      await installLauncher(selected);
      await activate(selected, current);
      const action = current.ok
        ? (compareSemver(packaged.version, current.record.version) < 0 ? 'downgrade' : 'upgrade')
        : (current.exists ? 'repair' : 'install');
      return {
        ok: true, action, launcher: paths.launcher, relative: selected.relative,
        version: selected.record.version, sourceCommitSha: selected.record.sourceCommitSha,
        diagnostics: current.exists && !current.ok ? [{
          code: 'RUNTIME_CURRENT_REPAIRED',
          message: 'The active runtime was invalid and no verified previous runtime was available; the packaged runtime was repaired offline.',
          failedCode: current.code,
        }] : [],
      };
    });
    const shared = pending.finally(() => {
      if (readinessPromise === shared) readinessPromise = null;
    });
    readinessPromise = shared;
    return shared;
  }

  async function repair() {
    return withLock(async () => {
      const packaged = await verifyPackagedPayload();
      const current = await pointerState(paths.currentPointer);
      const selected = await installPackaged(packaged, { repair: true });
      assertLauncherTransitionCompatible(selected, current);
      await installLauncher(selected);
      await activate(selected, current);
      return {
        ok: true, action: 'repair', launcher: paths.launcher, relative: selected.relative,
        version: selected.record.version, sourceCommitSha: selected.record.sourceCommitSha,
        diagnostics: [],
      };
    });
  }

  async function rollback() {
    return withLock(async () => {
      const current = await pointerState(paths.currentPointer);
      const previous = await pointerState(paths.previousPointer);
      if (!previous.ok) failure('RUNTIME_ROLLBACK_UNAVAILABLE', 'No verified previous runtime is available');
      assertLauncherTransitionCompatible(previous, current);
      await installLauncher(previous);
      await writePointer(paths.currentPointer, previous.relative);
      if (current.ok && current.relative !== previous.relative) await writePointer(paths.previousPointer, current.relative);
      else await removePointer(paths.previousPointer);
      return {
        ok: true, action: 'rollback', launcher: paths.launcher, relative: previous.relative,
        version: previous.record.version, sourceCommitSha: previous.record.sourceCommitSha,
        diagnostics: [],
      };
    });
  }

  async function uninstall() {
    return withLock(async () => {
      await removePointer(paths.currentPointer);
      await removePointer(paths.previousPointer);
      await promises.rm(paths.launcher, { force: true });
      const entries = await promises.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const recordPath = paths.join([root, entry.name, INSTALL_RECORD]);
        try {
          const record = await readJson(recordPath, 'RUNTIME_INSTALL_RECORD_INVALID');
          if (record?.schemaVersion === 1 && record.platform === platform.id) {
            await promises.rm(paths.join([root, entry.name]), { recursive: true, force: true });
          }
        } catch (error) {
          // Unknown directories are not owned by RuntimeManager and are retained.
        }
      }
      return { ok: true, action: 'uninstall', launcher: paths.launcher, relative: '', diagnostics: [] };
    });
  }

  async function inspect() {
    const current = await pointerState(paths.currentPointer);
    const previous = await pointerState(paths.previousPointer);
    let launcher = { ok: false, code: 'RUNTIME_LAUNCHER_MISSING', path: paths.launcher };
    try {
      const info = await promises.lstat(paths.launcher);
      const sourceSize = current.ok ? current.signals.launcher.size : info.size;
      launcher = info.isFile() && !info.isSymbolicLink?.() && info.nlink === 1
          && modeOf(info) === '0755' && info.size === sourceSize
        ? { ok: true, path: paths.launcher }
        : { ok: false, code: 'RUNTIME_LAUNCHER_INVALID', path: paths.launcher };
    } catch (error) {
      if (error?.code !== 'ENOENT') launcher = { ok: false, code: 'RUNTIME_LAUNCHER_INVALID', path: paths.launcher };
    }
    return { ok: current.ok && launcher.ok, current, previous, launcher };
  }

  async function resolveNode() {
    const selected = await ensureReady();
    const nodePath = paths.join([
      root,
      ...selected.relative.split('/'),
      'node',
      'bin',
      'node',
    ]);
    const info = await promises.lstat(nodePath);
    if (!info.isFile() || info.isSymbolicLink?.() || info.nlink !== 1 || (info.mode & 0o111) === 0) {
      failure('RUNTIME_NODE_INVALID', 'The verified runtime Node entrypoint is unavailable');
    }
    return {
      ok: true,
      nodePath,
      version: '24.17.0',
      runtime: selected,
      executable: {
        ok: true,
        id: 'node',
        path: nodePath,
        argsPrefix: [],
        source: 'runtime-manager',
        version: '24.17.0',
        arch: 'arm64',
      },
    };
  }

  return Object.freeze({ ensureReady, inspect, repair, resolveNode, rollback, uninstall });
}

export const _runtimeManagerInternals = Object.freeze({ pointerValue, compareSemver });
