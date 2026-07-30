const RUNTIME_PLATFORM = 'macos-arm64';
const LOCK_NAME = '.runtime-manager.lock';
const INSTALL_RECORD = 'install-record.json';
const LAYER_RECORD = 'layer-record.json';
const STABLE_LAUNCHER_RECORD = 'stable-launcher-record.json';
const GENERATION_LAUNCHER = 'ae-mcp-launcher';
const GENERATION_OWNER = 'ae-mcp-runtime-manager';
const GENERATION_ID = /^g-[0-9a-f]{16}$/;
const LAYER_INSTANCE_ID = /^i-[0-9a-f]{16}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEVELOPMENT_RUNTIME_ENV = 'AE_MCP_DEV_RUNTIME';
const DEVELOPMENT_CORE_BOOTSTRAP = [
  'import runpy,sys',
  'sys.path.insert(0,sys.argv[1])',
  'sys.path.insert(0,sys.argv[2])',
  'runpy.run_module("ae_mcp",run_name="__main__")',
].join(';');

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
  if (!portablePath(text) || parts.length !== 2) return '';
  if (parts[0] === 'generations' && GENERATION_ID.test(parts[1])) return text;
  return parts[1] === platformId ? text : '';
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

export function hasDevelopmentRuntimeOverride(environment = {}) {
  return typeof environment?.[DEVELOPMENT_RUNTIME_ENV] === 'string'
    && environment[DEVELOPMENT_RUNTIME_ENV].trim().length > 0;
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
  isProcessAlive = (ownerPid) => {
    const processApi = globalThis.window?.cep_node?.process || globalThis.process;
    try {
      processApi.kill(ownerPid, 0);
      return true;
    } catch (error) {
      return error?.code !== 'ESRCH';
    }
  },
  lockTimeoutMs = 10000,
  lockPollMs = 25,
  environment = platform?.env || globalThis.window?.cep_node?.process?.env || globalThis.process?.env || {},
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
  const stableLauncherRecordPath = paths.join([root, STABLE_LAUNCHER_RECORD]);
  const developmentMarkerPath = paths.join([extensionRoot, '.debug']);
  const developmentRuntimeInput = hasDevelopmentRuntimeOverride(environment)
    ? environment[DEVELOPMENT_RUNTIME_ENV].trim() : '';

  function developmentBuild() {
    return fs.existsSync(developmentMarkerPath) && !fs.existsSync(packageManifestPath);
  }

  async function selectDevelopmentRuntime() {
    if (!developmentRuntimeInput) return null;
    // This is deliberately the same development/release boundary used by the
    // panel's existing PATH fallback. A packaged extension must never accept
    // an unverified source checkout merely because its process has this env.
    if (!developmentBuild()) {
      failure(
        'RUNTIME_DEVELOPMENT_RUNTIME_RELEASE_REFUSED',
        `${DEVELOPMENT_RUNTIME_ENV} is refused by a packaged release build`,
      );
    }
    if (!paths.isAbsolute(developmentRuntimeInput)) {
      failure(
        'RUNTIME_DEVELOPMENT_RUNTIME_INVALID',
        `${DEVELOPMENT_RUNTIME_ENV} must name an absolute source checkout path`,
      );
    }

    let checkout;
    try {
      checkout = await promises.realpath(developmentRuntimeInput);
      const info = await promises.stat(checkout);
      if (!info.isDirectory()) throw new Error('not a directory');
    } catch {
      failure(
        'RUNTIME_DEVELOPMENT_RUNTIME_INVALID',
        `${DEVELOPMENT_RUNTIME_ENV} does not resolve to a usable source checkout`,
        { path: developmentRuntimeInput },
      );
    }

    const projectManifest = paths.join([checkout, 'pyproject.toml']);
    const coreRoot = paths.join([checkout, 'packages', 'core']);
    const coreEntrypoint = paths.join([coreRoot, 'ae_mcp', '__main__.py']);
    const bridgeRoot = paths.join([checkout, 'packages', 'bridge']);
    const bridgeEntrypoint = paths.join([bridgeRoot, 'ae_mcp_bridge', '__init__.py']);
    const interpreter = paths.join([checkout, '.venv', 'bin', 'python3']);
    let resolvedInterpreter;
    try {
      const [manifestInfo, entrypointInfo, bridgeInfo, interpreterInfo] = await Promise.all([
        promises.lstat(projectManifest),
        promises.lstat(coreEntrypoint),
        promises.lstat(bridgeEntrypoint),
        promises.lstat(interpreter),
      ]);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink?.()
          || !entrypointInfo.isFile() || entrypointInfo.isSymbolicLink?.()
          || !bridgeInfo.isFile() || bridgeInfo.isSymbolicLink?.()
          || (!interpreterInfo.isFile() && !interpreterInfo.isSymbolicLink?.())
          || (interpreterInfo.mode & 0o111) === 0) {
        throw new Error('required checkout entrypoint is invalid');
      }
      resolvedInterpreter = await promises.realpath(interpreter);
      const resolvedInfo = await promises.stat(resolvedInterpreter);
      if (!resolvedInfo.isFile() || (resolvedInfo.mode & 0o111) === 0) {
        throw new Error('resolved interpreter is not executable');
      }
    } catch {
      failure(
        'RUNTIME_DEVELOPMENT_RUNTIME_INVALID',
        `${DEVELOPMENT_RUNTIME_ENV} does not contain the Core/bridge entrypoints and an executable .venv/bin/python3`,
        { path: checkout },
      );
    }

    return {
      ok: true,
      action: 'development-runtime',
      developmentRuntime: true,
      checkoutPath: checkout,
      launcher: interpreter,
      args: ['-B', '-I', '-c', DEVELOPMENT_CORE_BOOTSTRAP, coreRoot, bridgeRoot],
      cwd: checkout,
      interpreter: {
        path: interpreter,
        resolvedPath: resolvedInterpreter,
      },
      diagnostics: [{
        code: 'RUNTIME_DEVELOPMENT_RUNTIME_SELECTED',
        message: `Development runtime selected from ${checkout}; no packaged runtime was verified or installed.`,
      }],
    };
  }

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

  function sameSignal(actual, expected) {
    if (!actual || !expected) return false;
    return actual.size === expected.size
      && actual.mtimeMs === expected.mtimeMs
      && actual.mode === expected.mode
      && actual.type === expected.type
      && actual.linkTarget === expected.linkTarget
      && actual.linkSize === expected.linkSize
      && actual.linkMtimeMs === expected.linkMtimeMs;
  }

  function emptyLifecycle() {
    return {
      generations: { created: 0, reused: 0, reclaimed: 0 },
      layers: { created: 0, reused: 0, reclaimed: 0 },
      logicalBytes: { created: 0, reclaimed: 0 },
      physicalBytes: { created: 0, reclaimed: 0 },
    };
  }

  function mergeLifecycle(...values) {
    const result = emptyLifecycle();
    for (const value of values) {
      if (!value) continue;
      for (const kind of ['generations', 'layers']) {
        for (const counter of ['created', 'reused', 'reclaimed']) {
          result[kind][counter] += Number(value[kind]?.[counter] || 0);
        }
      }
      for (const kind of ['logicalBytes', 'physicalBytes']) {
        for (const counter of ['created', 'reclaimed']) {
          result[kind][counter] += Number(value[kind]?.[counter] || 0);
        }
      }
    }
    return result;
  }

  async function treeUsage(directory) {
    let logicalBytes = 0;
    let physicalBytes = 0;
    const visit = async (current) => {
      const entries = await promises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = paths.join([current, entry.name]);
        const info = await promises.lstat(absolute);
        if (info.isDirectory() && !info.isSymbolicLink?.()) {
          await visit(absolute);
        } else {
          logicalBytes += info.size;
          physicalBytes += Number.isSafeInteger(info.blocks) ? info.blocks * 512 : info.size;
        }
      }
    };
    await visit(directory);
    return { logicalBytes, physicalBytes };
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
    return relative.startsWith('generations/')
      ? paths.join([root, ...relative.split('/'), INSTALL_RECORD])
      : paths.join([root, relative.split('/')[0], INSTALL_RECORD]);
  }

  function generationLauncherPath(relative) {
    return relative.startsWith('generations/')
      ? paths.join([root, ...relative.split('/'), GENERATION_LAUNCHER])
      : paths.join([root, relative.split('/')[0], GENERATION_LAUNCHER]);
  }

  function validateLegacyInstallRecord(record, normalized) {
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

  function validateLayerReference(value) {
    if (!exactKeys(value, ['id', 'instanceId', 'manifestSha256', 'relative'])
        || !SHA256.test(value.id) || value.manifestSha256 !== value.id
        || !LAYER_INSTANCE_ID.test(value.instanceId)
        || value.relative !== `layers/${value.id}/${value.instanceId}/${platform.id}`) {
      failure('RUNTIME_INSTALL_RECORD_INVALID', 'Runtime layer reference is invalid');
    }
    return value;
  }

  function validateGenerationRecord(record, normalized) {
    if (!exactKeys(record, [
      'generationId', 'installedAt', 'launcherSha256', 'launcherSignal', 'layer',
      'owner', 'platform', 'relative', 'schemaVersion', 'sourceCommitSha', 'version',
    ]) || record.schemaVersion !== 2 || record.owner !== GENERATION_OWNER
        || record.platform !== platform.id || record.relative !== normalized
        || normalized !== `generations/${record.generationId}`
        || !GENERATION_ID.test(record.generationId) || !SEMVER.test(record.version)
        || !SOURCE_SHA.test(record.sourceCommitSha) || !SHA256.test(record.launcherSha256)
        || !Number.isSafeInteger(record.installedAt) || record.installedAt < 0) {
      failure('RUNTIME_INSTALL_RECORD_INVALID', 'Runtime generation receipt is invalid');
    }
    validateLayerReference(record.layer);
    return record;
  }

  function validateLayerRecord(record, reference) {
    if (!exactKeys(record, [
      'id', 'installedAt', 'instanceId', 'logicalBytes', 'owner', 'physicalBytes',
      'platform', 'relative', 'schemaVersion', 'signals',
    ]) || record.schemaVersion !== 1 || record.owner !== GENERATION_OWNER
        || record.platform !== platform.id || record.id !== reference.id
        || record.instanceId !== reference.instanceId || record.relative !== reference.relative
        || !Number.isSafeInteger(record.installedAt) || record.installedAt < 0
        || !Number.isSafeInteger(record.logicalBytes) || record.logicalBytes <= 0
        || !Number.isSafeInteger(record.physicalBytes) || record.physicalBytes <= 0
        || !exactKeys(record.signals, ['node', 'python', 'runtimeManifest'])) {
      failure('RUNTIME_LAYER_RECORD_INVALID', 'Runtime layer receipt is invalid');
    }
    return record;
  }

  async function inspectLegacyInstalled(normalized) {
    const record = validateLegacyInstallRecord(
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

  async function layerSignals(directory) {
    return {
      runtimeManifest: await ordinaryFileSignal(
        paths.join([directory, 'runtime-manifest.json']),
        'RUNTIME_TRUST_SIGNAL_CHANGED',
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
  }

  async function inspectV2Installed(normalized) {
    const record = validateGenerationRecord(
      await readJson(installRecordPath(normalized), 'RUNTIME_INSTALL_RECORD_INVALID'),
      normalized,
    );
    const generationRoot = paths.join([root, ...normalized.split('/')]);
    const directory = paths.join([root, ...record.layer.relative.split('/')]);
    const layerRoot = paths.dirname(directory);
    const layerRecord = validateLayerRecord(
      await readJson(paths.join([layerRoot, LAYER_RECORD]), 'RUNTIME_LAYER_RECORD_INVALID'),
      record.layer,
    );
    const signals = {
      ...(await layerSignals(directory)),
      launcher: await ordinaryFileSignal(
        generationLauncherPath(normalized),
        'RUNTIME_TRUST_SIGNAL_CHANGED',
        { executable: true, expectedMode: '0755' },
      ),
    };
    if (!sameSignal(signals.runtimeManifest, layerRecord.signals.runtimeManifest)
        || !sameSignal(signals.node, layerRecord.signals.node)
        || !sameSignal(signals.python, layerRecord.signals.python)
        || !sameSignal(signals.launcher, record.launcherSignal)) {
      failure('RUNTIME_TRUST_SIGNAL_CHANGED', 'A runtime receipt path, size, or modification time changed');
    }
    const runtimeAlias = paths.join([generationRoot, 'runtime']);
    let target;
    try {
      const info = await promises.lstat(runtimeAlias);
      target = await promises.readlink(runtimeAlias);
      const resolved = paths.resolve([generationRoot, target]);
      if (!info.isSymbolicLink?.() || paths.isAbsolute(target)
          || !paths.contains(root, resolved) || !paths.same(resolved, directory)) {
        failure('RUNTIME_GENERATION_INVALID', 'Runtime generation layer alias is invalid');
      }
    } catch (error) {
      if (error instanceof RuntimeManagerError) throw error;
      failure('RUNTIME_GENERATION_INVALID', 'Runtime generation layer alias is missing');
    }
    return {
      relative: normalized,
      generationRoot,
      directory,
      launcher: generationLauncherPath(normalized),
      record,
      layerRecord,
      signals,
      schemaVersion: 2,
    };
  }

  async function inspectInstalled(relative) {
    const normalized = pointerValue(relative, platform.id);
    if (!normalized) failure('RUNTIME_POINTER_INVALID', 'Runtime pointer is invalid');
    return normalized.startsWith('generations/')
      ? inspectV2Installed(normalized)
      : inspectLegacyInstalled(normalized);
  }

  async function verifyInstalled(relative) {
    const selected = await inspectInstalled(relative);
    const { record, directory } = selected;
    await verifyRuntime(
      directory,
      record.schemaVersion === 2 ? record.layer.manifestSha256 : record.runtimeManifestSha256,
    );
    const launcher = selected.launcher;
    const launcherInfo = await promises.lstat(launcher);
    if (!launcherInfo.isFile() || launcherInfo.isSymbolicLink?.() || launcherInfo.nlink !== 1
        || modeOf(launcherInfo) !== '0755' || await sha256File(launcher) !== record.launcherSha256) {
      failure('RUNTIME_LAUNCHER_CORRUPT', 'Runtime generation launcher failed verification');
    }
    return selected;
  }

  function componentReceipt(selected) {
    const layerId = selected.record.schemaVersion === 2
      ? selected.record.layer.id
      : selected.record.runtimeManifestSha256;
    return {
      schemaVersion: 1,
      component: 'core-runtime',
      platform: platform.id,
      version: selected.record.version,
      sourceRevision: selected.record.sourceCommitSha,
      sourceRevisionRole: 'advisory',
      canonicalPath: selected.directory,
      installReceiptPath: installRecordPath(selected.relative),
      generation: selected.relative,
      layerId,
      signals: selected.signals,
      stableLauncher: {
        canonicalPath: paths.launcher,
        installReceiptPath: stableLauncherRecordPath,
        signal: selected.stableLauncherSignal,
      },
    };
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
    let source;
    try {
      source = await ordinaryFileSignal(
        selected.launcher,
        'RUNTIME_LAUNCHER_CORRUPT',
        { executable: true, expectedMode: '0755' },
      );
      const record = await readJson(stableLauncherRecordPath, 'RUNTIME_LAUNCHER_CORRUPT');
      if (!exactKeys(record, [
        'schemaVersion', 'owner', 'platform', 'canonicalPath', 'launcherSha256', 'signal',
      ]) || record.schemaVersion !== 1 || record.owner !== GENERATION_OWNER
          || record.platform !== platform.id || record.canonicalPath !== paths.launcher
          || record.launcherSha256 !== selected.record.launcherSha256) {
        failure('RUNTIME_LAUNCHER_CORRUPT', 'Stable launcher receipt is invalid');
      }
      const installed = await ordinaryFileSignal(
        paths.launcher,
        'RUNTIME_LAUNCHER_CORRUPT',
        { executable: true, expectedMode: '0755', expectedSize: source.size },
      );
      if (sameSignal(installed, record.signal)) {
        selected.stableLauncherSignal = installed;
        return;
      }
    } catch (error) {
      if (!(error instanceof RuntimeManagerError) && error?.code !== 'ENOENT') throw error;
    }
    await promises.mkdir(paths.binRoot, { recursive: true, mode: 0o700 });
    const bytes = await promises.readFile(selected.launcher);
    if (crypto.createHash('sha256').update(bytes).digest('hex')
        !== selected.record.launcherSha256) {
      failure('RUNTIME_LAUNCHER_CORRUPT', 'Runtime generation launcher failed verification');
    }
    await atomicWrite(paths.launcher, bytes, 0o755);
    await promises.chmod(paths.launcher, 0o755);
    const signal = await ordinaryFileSignal(
      paths.launcher,
      'RUNTIME_LAUNCHER_CORRUPT',
      { executable: true, expectedMode: '0755', expectedSize: bytes.length },
    );
    selected.stableLauncherSignal = signal;
    await atomicWrite(stableLauncherRecordPath, `${JSON.stringify({
      schemaVersion: 1,
      owner: GENERATION_OWNER,
      platform: platform.id,
      canonicalPath: paths.launcher,
      launcherSha256: selected.record.launcherSha256,
      signal,
    }, null, 2)}\n`);
  }

  function reusedLifecycle(selected) {
    return selected?.record?.schemaVersion === 2 ? {
      ...emptyLifecycle(),
      generations: { created: 0, reused: 1, reclaimed: 0 },
      layers: { created: 0, reused: 1, reclaimed: 0 },
    } : {
      ...emptyLifecycle(),
      generations: { created: 0, reused: 1, reclaimed: 0 },
    };
  }

  function assertLauncherTransitionCompatible(selected, current) {
    if (!current?.ok || current.relative === selected.relative) return;
    if (current.record.schemaVersion === 1 && selected.record.schemaVersion === 2) return;
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

  async function refreshLayerReceipt(layerRoot, record, directory) {
    const refreshed = {
      ...record,
      signals: await layerSignals(directory),
    };
    await atomicWrite(
      paths.join([layerRoot, LAYER_RECORD]),
      `${JSON.stringify(refreshed, null, 2)}\n`,
    );
    return refreshed;
  }

  async function findReusableLayer(layerId) {
    const contentRoot = paths.join([root, 'layers', layerId]);
    let entries;
    try {
      entries = await promises.readdir(contentRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    entries.sort((left, right) => compareUtf8(left.name, right.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || !LAYER_INSTANCE_ID.test(entry.name)) continue;
      const relative = `layers/${layerId}/${entry.name}/${platform.id}`;
      const reference = {
        id: layerId,
        instanceId: entry.name,
        manifestSha256: layerId,
        relative,
      };
      const layerRoot = paths.join([contentRoot, entry.name]);
      const directory = paths.join([root, ...relative.split('/')]);
      try {
        let record = validateLayerRecord(
          await readJson(paths.join([layerRoot, LAYER_RECORD]), 'RUNTIME_LAYER_RECORD_INVALID'),
          reference,
        );
        const signals = await layerSignals(directory);
        if (!sameSignal(signals.runtimeManifest, record.signals.runtimeManifest)
            || !sameSignal(signals.node, record.signals.node)
            || !sameSignal(signals.python, record.signals.python)) {
          await verifyRuntime(directory, layerId);
          record = await refreshLayerReceipt(layerRoot, record, directory);
        }
        return { reference, record, directory, lifecycle: {
          ...emptyLifecycle(),
          layers: { created: 0, reused: 1, reclaimed: 0 },
        } };
      } catch (error) {
        if (!(error instanceof RuntimeManagerError) && error?.code !== 'ENOENT') throw error;
      }
    }
    return null;
  }

  async function installLayer(packaged, { forceNew = false } = {}) {
    if (!forceNew) {
      const reusable = await findReusableLayer(packaged.runtimeManifestSha256);
      if (reusable) return reusable;
    }
    const layerId = packaged.runtimeManifestSha256;
    const instanceId = `i-${randomHex(randomBytes)}`;
    const relative = `layers/${layerId}/${instanceId}/${platform.id}`;
    const temporary = paths.join([root, `.stage-layer-${instanceId}-${randomHex(randomBytes, 6)}`]);
    const finalRoot = paths.join([root, 'layers', layerId, instanceId]);
    try {
      await promises.mkdir(root, { recursive: true, mode: 0o700 });
      await promises.mkdir(temporary, { mode: 0o700 });
      await copyTree(packagedRuntimeRoot, paths.join([temporary, platform.id]));
      const directory = paths.join([temporary, platform.id]);
      await verifyRuntime(directory, layerId);
      const usage = await treeUsage(directory);
      const record = {
        schemaVersion: 1,
        owner: GENERATION_OWNER,
        id: layerId,
        instanceId,
        platform: platform.id,
        relative,
        installedAt: Math.max(0, Math.floor(now())),
        logicalBytes: usage.logicalBytes,
        physicalBytes: usage.physicalBytes,
        signals: await layerSignals(directory),
      };
      await promises.writeFile(
        paths.join([temporary, LAYER_RECORD]),
        `${JSON.stringify(record, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      await promises.mkdir(paths.dirname(finalRoot), { recursive: true, mode: 0o700 });
      await promises.rename(temporary, finalRoot);
      const finalDirectory = paths.join([root, ...relative.split('/')]);
      const finalRecord = {
        ...record,
        signals: await layerSignals(finalDirectory),
      };
      await atomicWrite(
        paths.join([finalRoot, LAYER_RECORD]),
        `${JSON.stringify(finalRecord, null, 2)}\n`,
      );
      return {
        reference: { id: layerId, instanceId, manifestSha256: layerId, relative },
        record: finalRecord,
        directory: finalDirectory,
        lifecycle: {
          ...emptyLifecycle(),
          layers: { created: 1, reused: 0, reclaimed: 0 },
          logicalBytes: { created: usage.logicalBytes, reclaimed: 0 },
          physicalBytes: { created: usage.physicalBytes, reclaimed: 0 },
        },
      };
    } catch (error) {
      await promises.rm(temporary, { recursive: true, force: true }).catch(() => {});
      throw runtimeError(error, 'RUNTIME_INSTALL_FAILED');
    }
  }

  async function installPackaged(packaged, { repair = false } = {}) {
    const layer = await installLayer(packaged, { forceNew: repair });
    const generationId = `g-${randomHex(randomBytes)}`;
    const relative = `generations/${generationId}`;
    const temporary = paths.join([root, `.stage-generation-${generationId}-${randomHex(randomBytes, 6)}`]);
    const finalRoot = paths.join([root, ...relative.split('/')]);
    try {
      await promises.mkdir(temporary, { mode: 0o700 });
      await promises.copyFile(
        packagedLauncher,
        paths.join([temporary, GENERATION_LAUNCHER]),
        fs.constants?.COPYFILE_EXCL,
      );
      await promises.chmod(paths.join([temporary, GENERATION_LAUNCHER]), 0o755);
      await promises.symlink(`../../${layer.reference.relative}`, paths.join([temporary, 'runtime']));
      const launcherSignal = await ordinaryFileSignal(
        paths.join([temporary, GENERATION_LAUNCHER]),
        'RUNTIME_LAUNCHER_CORRUPT',
        { executable: true, expectedMode: '0755' },
      );
      const record = {
        schemaVersion: 2,
        owner: GENERATION_OWNER,
        generationId,
        platform: platform.id,
        version: packaged.version,
        sourceCommitSha: packaged.sourceCommitSha,
        layer: layer.reference,
        launcherSha256: packaged.launcherSha256,
        launcherSignal,
        relative,
        installedAt: Math.max(0, Math.floor(now())),
      };
      await promises.writeFile(
        paths.join([temporary, INSTALL_RECORD]),
        `${JSON.stringify(record, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
      );
      if (await sha256File(paths.join([temporary, GENERATION_LAUNCHER])) !== packaged.launcherSha256) {
        failure('RUNTIME_LAUNCHER_CORRUPT', 'Staged runtime launcher failed verification');
      }
      await promises.mkdir(paths.dirname(finalRoot), { recursive: true, mode: 0o700 });
      await promises.rename(temporary, finalRoot);
      const finalRecord = {
        ...record,
        launcherSignal: await ordinaryFileSignal(
          paths.join([finalRoot, GENERATION_LAUNCHER]),
          'RUNTIME_LAUNCHER_CORRUPT',
          { executable: true, expectedMode: '0755' },
        ),
      };
      await atomicWrite(
        paths.join([finalRoot, INSTALL_RECORD]),
        `${JSON.stringify(finalRecord, null, 2)}\n`,
      );
      const selected = await inspectInstalled(relative);
      const usage = await treeUsage(finalRoot);
      return {
        ...selected,
        lifecycle: mergeLifecycle(layer.lifecycle, {
          ...emptyLifecycle(),
          generations: { created: 1, reused: 0, reclaimed: 0 },
          logicalBytes: { created: usage.logicalBytes, reclaimed: 0 },
          physicalBytes: { created: usage.physicalBytes, reclaimed: 0 },
        }),
      };
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

  async function readOwnedGeneration(relative) {
    if (!relative?.startsWith('generations/')) return null;
    try {
      return validateGenerationRecord(
        await readJson(installRecordPath(relative), 'RUNTIME_INSTALL_RECORD_INVALID'),
        relative,
      );
    } catch (error) {
      if (error instanceof RuntimeManagerError || error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function reclaimOwnedState({ currentRelative, previousRelative, inProgressRelative }) {
    const lifecycle = emptyLifecycle();
    const retained = new Set(
      [currentRelative, previousRelative, inProgressRelative]
        .filter((value) => typeof value === 'string' && value.length > 0),
    );
    const referencedLayers = new Set();
    let layerGcSafe = true;
    const generationsRoot = paths.join([root, 'generations']);
    let entries = [];
    try {
      entries = await promises.readdir(generationsRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !GENERATION_ID.test(entry.name)) continue;
      const relative = `generations/${entry.name}`;
      const record = await readOwnedGeneration(relative);
      if (!record) {
        layerGcSafe = false;
        continue;
      }
      if (retained.has(relative)) {
        referencedLayers.add(record.layer.relative);
        continue;
      }
      const generationRoot = paths.join([generationsRoot, entry.name]);
      const usage = await treeUsage(generationRoot);
      await promises.rm(generationRoot, { recursive: true, force: true });
      lifecycle.generations.reclaimed += 1;
      lifecycle.logicalBytes.reclaimed += usage.logicalBytes;
      lifecycle.physicalBytes.reclaimed += usage.physicalBytes;
    }

    const legacyEntries = await promises.readdir(root, { withFileTypes: true });
    for (const entry of legacyEntries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')
          || entry.name === 'generations' || entry.name === 'layers') continue;
      const relative = `${entry.name}/${platform.id}`;
      if (retained.has(relative)) continue;
      try {
        validateLegacyInstallRecord(
          await readJson(
            paths.join([root, entry.name, INSTALL_RECORD]),
            'RUNTIME_INSTALL_RECORD_INVALID',
          ),
          relative,
        );
      } catch (error) {
        if (error instanceof RuntimeManagerError || error?.code === 'ENOENT') continue;
        throw error;
      }
      const legacyRoot = paths.join([root, entry.name]);
      const usage = await treeUsage(legacyRoot);
      await promises.rm(legacyRoot, { recursive: true, force: true });
      lifecycle.generations.reclaimed += 1;
      lifecycle.logicalBytes.reclaimed += usage.logicalBytes;
      lifecycle.physicalBytes.reclaimed += usage.physicalBytes;
    }
    if (!layerGcSafe) return lifecycle;

    const layersRoot = paths.join([root, 'layers']);
    let digests = [];
    try {
      digests = await promises.readdir(layersRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const digestEntry of digests) {
      if (!digestEntry.isDirectory() || !SHA256.test(digestEntry.name)) continue;
      const digestRoot = paths.join([layersRoot, digestEntry.name]);
      const instances = await promises.readdir(digestRoot, { withFileTypes: true });
      for (const instanceEntry of instances) {
        if (!instanceEntry.isDirectory() || !LAYER_INSTANCE_ID.test(instanceEntry.name)) continue;
        const relative = `layers/${digestEntry.name}/${instanceEntry.name}/${platform.id}`;
        if (referencedLayers.has(relative)) continue;
        const reference = {
          id: digestEntry.name,
          instanceId: instanceEntry.name,
          manifestSha256: digestEntry.name,
          relative,
        };
        const instanceRoot = paths.join([digestRoot, instanceEntry.name]);
        let record;
        try {
          record = validateLayerRecord(
            await readJson(paths.join([instanceRoot, LAYER_RECORD]), 'RUNTIME_LAYER_RECORD_INVALID'),
            reference,
          );
        } catch (error) {
          if (error instanceof RuntimeManagerError || error?.code === 'ENOENT') continue;
          throw error;
        }
        await promises.rm(instanceRoot, { recursive: true, force: true });
        lifecycle.layers.reclaimed += 1;
        lifecycle.logicalBytes.reclaimed += record.logicalBytes;
        lifecycle.physicalBytes.reclaimed += record.physicalBytes;
      }
    }
    return lifecycle;
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
        let owner;
        try {
          owner = JSON.parse(String(await promises.readFile(lockPath, 'utf8')));
        } catch {
          owner = null;
        }
        if (
          Number.isSafeInteger(owner?.pid)
          && owner.pid > 0
          && Number.isSafeInteger(owner?.acquiredAt)
          && owner.acquiredAt >= 0
          && !isProcessAlive(owner.pid)
        ) {
          const stalePath = paths.join([
            root,
            `.runtime-manager.stale-lock.${randomHex(randomBytes)}.json`,
          ]);
          try {
            await promises.rename(lockPath, stalePath);
            continue;
          } catch (reclaimError) {
            if (reclaimError?.code !== 'ENOENT') throw reclaimError;
          }
        }
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
    const pending = developmentRuntimeInput
      ? selectDevelopmentRuntime()
      : withLock(async () => {
      let current = await pointerState(paths.currentPointer);
      const previous = await pointerState(paths.previousPointer);
      if (!current.ok && previous.ok) {
        await installLauncher(previous);
        await writePointer(paths.currentPointer, previous.relative);
        await removePointer(paths.previousPointer);
        const reclaimed = await reclaimOwnedState({
          currentRelative: previous.relative,
          previousRelative: null,
          inProgressRelative: previous.relative,
        });
        return {
          ok: true,
          action: 'fallback',
          launcher: paths.launcher,
          relative: previous.relative,
          version: previous.record.version,
          sourceCommitSha: previous.record.sourceCommitSha,
          componentReceipt: componentReceipt(previous),
          lifecycle: mergeLifecycle(reusedLifecycle(previous), reclaimed),
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
        const reclaimed = await reclaimOwnedState({
          currentRelative: current.relative,
          previousRelative: previous.ok ? previous.relative : null,
          inProgressRelative: current.relative,
        });
        return {
          ok: true,
          action: 'retained',
          launcher: paths.launcher,
          relative: current.relative,
          version: current.record.version,
          sourceCommitSha: current.record.sourceCommitSha,
          componentReceipt: componentReceipt(current),
          lifecycle: mergeLifecycle(reusedLifecycle(current), reclaimed),
          diagnostics: [{
            code: 'RUNTIME_PACKAGED_PAYLOAD_INVALID_ACTIVE_RETAINED',
            message: 'The extension runtime payload was invalid; RuntimeManager retained the previously verified active runtime.',
            failedCode: error?.code || 'RUNTIME_PACKAGED_PAYLOAD_INVALID',
          }],
        };
      }
      const declaredRuntimeMatches = current.ok
        && current.record.version === packaged.version
        && (current.record.schemaVersion === 2
          ? current.record.layer.manifestSha256
          : current.record.runtimeManifestSha256) === packaged.runtimeManifestSha256
        && current.record.launcherSha256 === packaged.launcherSha256;
      const trustedSignalsMatch = declaredRuntimeMatches
        && current.record.schemaVersion === 2
        && current.signals.runtimeManifest.size === packaged.signals.runtimeManifest.size
        && current.signals.launcher.size === packaged.signals.launcher.size
        && current.signals.node.size === packaged.signals.node.size
        && current.signals.python.size === packaged.signals.python.size
        && current.signals.python.type === packaged.signals.python.type
        && current.signals.python.linkTarget === packaged.signals.python.linkTarget;
      if (trustedSignalsMatch) {
        await installLauncher(current);
        const reclaimed = await reclaimOwnedState({
          currentRelative: current.relative,
          previousRelative: previous.ok ? previous.relative : null,
          inProgressRelative: current.relative,
        });
        return {
          ok: true, action: 'ready', launcher: paths.launcher, relative: current.relative,
          version: current.record.version,
          sourceCommitSha: current.record.sourceCommitSha,
          packagedSourceCommitSha: packaged.sourceCommitSha,
          componentReceipt: componentReceipt(current),
          trustSignals: current.signals,
          lifecycle: mergeLifecycle(reusedLifecycle(current), reclaimed),
          diagnostics: current.record.sourceCommitSha === packaged.sourceCommitSha ? [] : [{
            code: 'RUNTIME_SOURCE_REVISION_DIFFERENT_TRUSTED',
            message: 'The unchanged installed runtime was reused across an advisory source revision change.',
          }],
        };
      }
      if (declaredRuntimeMatches && current.record.schemaVersion === 2) {
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
      const reclaimed = await reclaimOwnedState({
        currentRelative: selected.relative,
        previousRelative: current.ok ? current.relative : null,
        inProgressRelative: selected.relative,
      });
      const action = current.ok
        ? (current.record.schemaVersion === 1
          ? 'migrate'
          : (compareSemver(packaged.version, current.record.version) < 0 ? 'downgrade' : 'upgrade'))
        : (current.exists ? 'repair' : 'install');
      return {
        ok: true, action, launcher: paths.launcher, relative: selected.relative,
        version: selected.record.version, sourceCommitSha: selected.record.sourceCommitSha,
        componentReceipt: componentReceipt(selected),
        lifecycle: mergeLifecycle(selected.lifecycle, reclaimed),
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
    if (developmentRuntimeInput) {
      failure(
        'RUNTIME_DEVELOPMENT_RUNTIME_OPERATION_UNAVAILABLE',
        'Repair is unavailable while AE_MCP_DEV_RUNTIME selects a source checkout.',
      );
    }
    return withLock(async () => {
      const packaged = await verifyPackagedPayload();
      const current = await pointerState(paths.currentPointer);
      const selected = await installPackaged(packaged, { repair: true });
      assertLauncherTransitionCompatible(selected, current);
      await installLauncher(selected);
      await activate(selected, current);
      const reclaimed = await reclaimOwnedState({
        currentRelative: selected.relative,
        previousRelative: current.ok ? current.relative : null,
        inProgressRelative: selected.relative,
      });
      return {
        ok: true, action: 'repair', launcher: paths.launcher, relative: selected.relative,
        version: selected.record.version, sourceCommitSha: selected.record.sourceCommitSha,
        componentReceipt: componentReceipt(selected),
        lifecycle: mergeLifecycle(selected.lifecycle, reclaimed),
        diagnostics: [],
      };
    });
  }

  async function rollback() {
    if (developmentRuntimeInput) {
      failure(
        'RUNTIME_DEVELOPMENT_RUNTIME_OPERATION_UNAVAILABLE',
        'Rollback is unavailable while AE_MCP_DEV_RUNTIME selects a source checkout.',
      );
    }
    return withLock(async () => {
      const current = await pointerState(paths.currentPointer);
      const previous = await pointerState(paths.previousPointer);
      if (!previous.ok) failure('RUNTIME_ROLLBACK_UNAVAILABLE', 'No verified previous runtime is available');
      assertLauncherTransitionCompatible(previous, current);
      await installLauncher(previous);
      await writePointer(paths.currentPointer, previous.relative);
      if (current.ok && current.relative !== previous.relative) await writePointer(paths.previousPointer, current.relative);
      else await removePointer(paths.previousPointer);
      const reclaimed = await reclaimOwnedState({
        currentRelative: previous.relative,
        previousRelative: current.ok && current.relative !== previous.relative
          ? current.relative : null,
        inProgressRelative: previous.relative,
      });
      return {
        ok: true, action: 'rollback', launcher: paths.launcher, relative: previous.relative,
        version: previous.record.version, sourceCommitSha: previous.record.sourceCommitSha,
        componentReceipt: componentReceipt(previous),
        lifecycle: mergeLifecycle(reusedLifecycle(previous), reclaimed),
        diagnostics: [],
      };
    });
  }

  async function uninstall() {
    if (developmentRuntimeInput) {
      failure(
        'RUNTIME_DEVELOPMENT_RUNTIME_OPERATION_UNAVAILABLE',
        'Uninstall is unavailable while AE_MCP_DEV_RUNTIME selects a source checkout.',
      );
    }
    return withLock(async () => {
      await removePointer(paths.currentPointer);
      await removePointer(paths.previousPointer);
      await promises.rm(paths.launcher, { force: true });
      await promises.rm(stableLauncherRecordPath, { force: true });
      const reclaimed = await reclaimOwnedState({
        currentRelative: null,
        previousRelative: null,
        inProgressRelative: null,
      });
      return {
        ok: true,
        action: 'uninstall',
        launcher: paths.launcher,
        relative: '',
        lifecycle: reclaimed,
        diagnostics: [],
      };
    });
  }

  async function inspect() {
    if (developmentRuntimeInput) {
      try {
        const selected = await selectDevelopmentRuntime();
        return {
          ok: true,
          developmentRuntime: true,
          checkoutPath: selected.checkoutPath,
          interpreter: selected.interpreter,
          launcher: { ok: true, path: selected.launcher },
          diagnostics: selected.diagnostics,
        };
      } catch (error) {
        const normalized = runtimeError(error);
        return {
          ok: false,
          developmentRuntime: true,
          code: normalized.code,
          detail: normalized.message,
          launcher: { ok: false, code: normalized.code },
          diagnostics: [{ code: normalized.code, message: normalized.message }],
        };
      }
    }
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
    if (selected.developmentRuntime) {
      const node = await platform.resolveExecutable('node', {
        minimumVersion: '24.17.0',
        requiredArch: 'arm64',
      });
      if (!node.ok) {
        failure('RUNTIME_NODE_INVALID', 'A development runtime requires an available Node 24 arm64 executable');
      }
      return {
        ok: true,
        nodePath: node.path,
        version: node.version,
        runtime: selected,
        executable: {
          ...node,
          source: 'development-path',
        },
      };
    }
    const inspected = await inspectInstalled(selected.relative);
    const nodePath = paths.join([inspected.directory, 'node', 'bin', 'node']);
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
