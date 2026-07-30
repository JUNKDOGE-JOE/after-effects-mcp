import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createMacosAdapter } from '../src/cep/platform/macos.js';
import { createRuntimeManager } from '../src/cep/runtimeManager.js';

const execFileAsync = promisify(execFile);
// These fixtures execute POSIX launchers and intentionally model macOS path semantics.
const macosRuntimeTest = process.platform === 'win32' ? test.skip : test;
const DEVELOPMENT_CORE_BOOTSTRAP = [
  'import runpy,sys',
  'sys.path.insert(0,sys.argv[1])',
  'sys.path.insert(0,sys.argv[2])',
  'runpy.run_module("ae_mcp",run_name="__main__")',
].join(';');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath) {
  return sha256(await fs.promises.readFile(filePath));
}

async function writeFile(root, relative, contents, mode = 0o644) {
  const target = path.join(root, ...relative.split('/'));
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, contents, { mode });
  await fs.promises.chmod(target, mode);
  return target;
}

async function inventory(root, prefix = '', values = []) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = path.join(root, entry.name);
    const info = await fs.promises.lstat(target);
    if (entry.isDirectory()) {
      await inventory(target, relative, values);
    } else {
      const bytes = entry.isSymbolicLink()
        ? Buffer.from(await fs.promises.readlink(target), 'utf8')
        : await fs.promises.readFile(target);
      values.push({
        path: relative,
        sha256: sha256(bytes),
        size: bytes.length,
        mode: (info.mode & 0o777).toString(8).padStart(4, '0'),
        type: entry.isSymbolicLink() ? 'symlink' : 'file',
      });
    }
  }
  return values;
}

function adapter(home) {
  return createMacosAdapter({
    platform: 'darwin',
    arch: 'arm64',
    home,
    temp: os.tmpdir(),
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    fs,
    spawnImpl() { throw new Error('not expected'); },
    now: () => Date.now(),
  });
}

async function packageFixture(base, {
  version,
  sourceCommitSha,
  marker,
  launcherVersion = 'v1',
}) {
  const extensionRoot = path.join(base, `AE MCP 插件 ${version}`);
  const runtimeRoot = path.join(extensionRoot, 'runtime', 'macos-arm64');
  const pythonVersioned = await writeFile(
    runtimeRoot,
    'python/bin/python3.13',
    `#!/bin/sh\nprintf 'core-started:${marker}:%s\\n' "$*"\n`,
    0o755,
  );
  const python = path.join(runtimeRoot, 'python', 'bin', 'python3');
  await fs.promises.symlink(path.basename(pythonVersioned), python);
  await writeFile(runtimeRoot, 'python/site-packages/ae_mcp/__init__.py', `MARKER = ${JSON.stringify(marker)}\n`);
  await writeFile(runtimeRoot, 'node/bin/node', '#!/bin/sh\nexit 0\n', 0o755);
  await writeFile(runtimeRoot, 'node/host/package.json', '{"private":true}\n');
  await writeFile(runtimeRoot, 'licenses/许可 notice.txt', `license ${marker}\n`);
  const files = await inventory(runtimeRoot);
  const runtimeManifest = {
    schemaVersion: 1,
    platform: 'macos-arm64',
    node: { version: '24.17.0', assetSha256: 'a'.repeat(64) },
    python: { version: '3.13.14', distributionRelease: '20260610', assetSha256: 'b'.repeat(64) },
    licenseApprovals: [],
    components: [{ name: 'fixture', version: '1', license: 'MIT', source: 'fixture', sha256: 'c'.repeat(64) }],
    files,
  };
  const runtimeManifestPath = await writeFile(
    runtimeRoot,
    'runtime-manifest.json',
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
  );
  const launcher = await writeFile(
    extensionRoot,
    'platform/macos-arm64/bin/ae-mcp',
    [
      '#!/bin/sh',
      `# fixture-launcher:${launcherVersion}`,
      'set -eu',
      'base="${AE_MCP_HOME:-$HOME/.ae-mcp}"',
      'relative="$(/bin/cat "$base/runtime/current")"',
      'case "$relative" in ""|/*|*..*) exit 78 ;; esac',
      'case "$relative" in generations/g-*) runtime="$base/runtime/$relative/runtime" ;; *) runtime="$base/runtime/$relative" ;; esac',
      'exec "$runtime/python/bin/python3" -B -I -m ae_mcp "$@"',
      '',
    ].join('\n'),
    0o755,
  );
  const runtimeManifestSha256 = await sha256File(runtimeManifestPath);
  const launcherSha256 = await sha256File(launcher);
  const inventoryByPath = new Map(files.map((record) => [record.path, record]));
  const nodeRecord = inventoryByPath.get('node/bin/node');
  const pythonRecord = inventoryByPath.get('python/bin/python3');
  await writeFile(extensionRoot, 'bundle-manifest.json', `${JSON.stringify({
    schemaVersion: 1,
    version,
    platform: 'macos-arm64',
    sourceCommitSha,
    runtime: {
      nodeVersion: '24.17.0',
      pythonVersion: '3.13.14',
      manifestSha256: runtimeManifestSha256,
      sbomSha256: 'd'.repeat(64),
      licenseInventorySha256: 'e'.repeat(64),
    },
    helper: { helperId: 'com.junkdoge.ae-mcp.platform-helper', manifestSha256: 'f'.repeat(64) },
    files: [
      {
        path: 'platform/macos-arm64/bin/ae-mcp', type: 'file', size: (await fs.promises.stat(launcher)).size,
        mode: '0755', sha256: launcherSha256,
      },
      {
        path: 'runtime/macos-arm64/runtime-manifest.json', type: 'file',
        size: (await fs.promises.stat(runtimeManifestPath)).size, mode: '0644', sha256: runtimeManifestSha256,
      },
      {
        ...nodeRecord,
        path: `runtime/macos-arm64/${nodeRecord.path}`,
      },
      {
        ...pythonRecord,
        path: `runtime/macos-arm64/${pythonRecord.path}`,
      },
    ],
  }, null, 2)}\n`);
  return {
    extensionRoot,
    launcher,
    launcherSha256,
    runtimeManifestSha256,
    runtimeRoot,
    python,
    sourceCommitSha,
    version,
  };
}

async function harness(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-runtime-manager-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const home = path.join(root, '用户 Home with spaces');
  await fs.promises.mkdir(home, { recursive: true });
  return { root, home, platform: adapter(home) };
}

async function managedDirectoryCounts(runtimeRoot) {
  const generations = await fs.promises.readdir(path.join(runtimeRoot, 'generations'));
  const layersRoot = path.join(runtimeRoot, 'layers');
  const layerDigests = await fs.promises.readdir(layersRoot);
  let layers = 0;
  for (const digest of layerDigests) {
    layers += (await fs.promises.readdir(path.join(layersRoot, digest))).length;
  }
  return { generations: generations.length, layers };
}

function managerFor(h, extensionRoot, options = {}) {
  return createRuntimeManager({
    platform: h.platform,
    extensionRoot,
    cryptoImpl: crypto,
    randomBytes: crypto.randomBytes,
    environment: {},
    ...options,
  });
}

async function developmentExtension(h) {
  const extensionRoot = path.join(h.root, 'AE MCP development extension');
  await writeFile(extensionRoot, '.debug', '<ExtensionList />\n');
  return extensionRoot;
}

async function developmentCheckout(h, marker = 'development') {
  const checkout = path.join(h.root, 'source checkout');
  await writeFile(checkout, 'pyproject.toml', '[tool.uv]\n');
  await writeFile(checkout, 'packages/core/ae_mcp/__main__.py', 'def main(): pass\n');
  await writeFile(checkout, 'packages/bridge/ae_mcp_bridge/__init__.py', '');
  const interpreter = await writeFile(
    checkout,
    '.venv/bin/python3',
    `#!/bin/sh\nprintf 'development-core:${marker}:%s\\n' "$*"\n`,
    0o755,
  );
  return { checkout, interpreter };
}

macosRuntimeTest('development checkout bypasses manifests, generations, pointers, and RuntimeManager lock', async (t) => {
  const h = await harness(t);
  const extensionRoot = await developmentExtension(h);
  const checkout = await developmentCheckout(h);
  const current = 'sentinel-current\n';
  const previous = 'sentinel-previous\n';
  await fs.promises.mkdir(h.platform.paths.runtimeRoot, { recursive: true });
  await fs.promises.writeFile(h.platform.paths.currentPointer, current);
  await fs.promises.writeFile(h.platform.paths.previousPointer, previous);
  let lockOpenCalls = 0;
  const trackedPromises = new Proxy(fs.promises, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === 'open') {
        return async function trackedOpen(targetPath, ...args) {
          if (path.resolve(String(targetPath))
              === path.join(h.platform.paths.runtimeRoot, '.runtime-manager.lock')) {
            lockOpenCalls += 1;
          }
          return value.call(target, targetPath, ...args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const manager = managerFor(h, extensionRoot, {
    fsImpl: { ...fs, promises: trackedPromises },
    environment: { AE_MCP_DEV_RUNTIME: checkout.checkout },
  });

  const selected = await manager.ensureReady();
  const canonicalCheckout = await fs.promises.realpath(checkout.checkout);
  const canonicalInterpreter = path.join(canonicalCheckout, '.venv', 'bin', 'python3');

  assert.equal(selected.action, 'development-runtime');
  assert.equal(selected.developmentRuntime, true);
  assert.equal(selected.checkoutPath, canonicalCheckout);
  assert.equal(selected.cwd, canonicalCheckout);
  assert.equal(selected.launcher, canonicalInterpreter);
  assert.deepEqual(selected.args, [
    '-B',
    '-I',
    '-c',
    DEVELOPMENT_CORE_BOOTSTRAP,
    path.join(canonicalCheckout, 'packages', 'core'),
    path.join(canonicalCheckout, 'packages', 'bridge'),
  ]);
  assert.equal(selected.interpreter.path, canonicalInterpreter);
  assert.equal(selected.interpreter.resolvedPath, canonicalInterpreter);
  assert.equal(selected.diagnostics[0].code, 'RUNTIME_DEVELOPMENT_RUNTIME_SELECTED');
  assert.equal(lockOpenCalls, 0);
  assert.equal(await fs.promises.readFile(h.platform.paths.currentPointer, 'utf8'), current);
  assert.equal(await fs.promises.readFile(h.platform.paths.previousPointer, 'utf8'), previous);
  await assert.rejects(
    fs.promises.lstat(path.join(h.platform.paths.runtimeRoot, 'generations')),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    fs.promises.lstat(path.join(h.platform.paths.runtimeRoot, '.runtime-manager.lock')),
    { code: 'ENOENT' },
  );
  const launched = await execFileAsync(selected.launcher, selected.args);
  assert.match(launched.stdout, /development-core:development:-B -I -c/);
  assert.match(launched.stdout, /packages\/core/);
  assert.match(launched.stdout, /packages\/bridge/);
  const inspected = await manager.inspect();
  assert.equal(inspected.ok, true);
  assert.equal(inspected.developmentRuntime, true);
  assert.equal(inspected.checkoutPath, canonicalCheckout);
});

macosRuntimeTest('unset development runtime keeps the packaged RuntimeManager path unchanged', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'production',
  });
  const manager = managerFor(h, payload.extensionRoot, { environment: {} });

  const selected = await manager.ensureReady();

  assert.equal(selected.action, 'install');
  assert.equal(selected.developmentRuntime, undefined);
  assert.equal(selected.launcher, h.platform.paths.launcher);
  assert.match(await fs.promises.readFile(h.platform.paths.currentPointer, 'utf8'), /^generations\/g-/);
});

macosRuntimeTest('a packaged release build refuses AE_MCP_DEV_RUNTIME without falling back', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'release',
  });
  const checkout = await developmentCheckout(h, 'release');
  const manager = managerFor(h, payload.extensionRoot, {
    environment: { AE_MCP_DEV_RUNTIME: checkout.checkout },
  });

  await assert.rejects(
    manager.ensureReady(),
    (error) => error?.code === 'RUNTIME_DEVELOPMENT_RUNTIME_RELEASE_REFUSED',
  );
  await assert.rejects(fs.promises.lstat(h.platform.paths.runtimeRoot), { code: 'ENOENT' });
});

macosRuntimeTest('an invalid development checkout fails closed with a structured code', async (t) => {
  const h = await harness(t);
  const extensionRoot = await developmentExtension(h);
  const missingCheckout = path.join(h.root, 'missing checkout');
  const manager = managerFor(h, extensionRoot, {
    environment: { AE_MCP_DEV_RUNTIME: missingCheckout },
  });

  await assert.rejects(
    manager.ensureReady(),
    (error) => error?.code === 'RUNTIME_DEVELOPMENT_RUNTIME_INVALID'
      && /usable source checkout/i.test(error.message),
  );
  const inspected = await manager.inspect();
  assert.equal(inspected.ok, false);
  assert.equal(inspected.code, 'RUNTIME_DEVELOPMENT_RUNTIME_INVALID');
  await assert.rejects(fs.promises.lstat(h.platform.paths.runtimeRoot), { code: 'ENOENT' });
});

async function seedLegacyGeneration(h, payload) {
  const generation = `${payload.version}-${payload.sourceCommitSha}`;
  const relative = `${generation}/macos-arm64`;
  const generationRoot = path.join(h.platform.paths.runtimeRoot, generation);
  await fs.promises.mkdir(generationRoot, { recursive: true });
  await fs.promises.cp(
    payload.runtimeRoot,
    path.join(generationRoot, 'macos-arm64'),
    { recursive: true, preserveTimestamps: true, verbatimSymlinks: true },
  );
  await fs.promises.copyFile(payload.launcher, path.join(generationRoot, 'ae-mcp-launcher'));
  await fs.promises.chmod(path.join(generationRoot, 'ae-mcp-launcher'), 0o755);
  await fs.promises.writeFile(path.join(generationRoot, 'install-record.json'), `${JSON.stringify({
    schemaVersion: 1,
    version: payload.version,
    platform: 'macos-arm64',
    sourceCommitSha: payload.sourceCommitSha,
    runtimeManifestSha256: payload.runtimeManifestSha256,
    launcherSha256: payload.launcherSha256,
    relative,
    installedAt: Date.now(),
  }, null, 2)}\n`);
  await fs.promises.mkdir(h.platform.paths.binRoot, { recursive: true });
  await fs.promises.copyFile(payload.launcher, h.platform.paths.launcher);
  await fs.promises.chmod(h.platform.paths.launcher, 0o755);
  await fs.promises.writeFile(h.platform.paths.currentPointer, `${relative}\n`);
  return { generationRoot, relative };
}

macosRuntimeTest('clean macOS install activates and starts the bundled core without PATH tools', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'clean',
  });
  const manager = managerFor(h, payload.extensionRoot);

  const result = await manager.ensureReady();

  assert.equal(result.action, 'install');
  assert.equal(result.launcher, path.join(h.home, '.ae-mcp', 'bin', 'ae-mcp'));
  assert.match(
    await fs.promises.readFile(h.platform.paths.currentPointer, 'utf8'),
    /^generations\/g-[0-9a-f]{16}\n$/,
  );
  assert.doesNotMatch(result.relative, /1{40}/);
  assert.equal(result.componentReceipt.sourceRevisionRole, 'advisory');
  assert.equal(result.componentReceipt.canonicalPath.includes('/layers/'), true);
  assert.equal(result.componentReceipt.stableLauncher.canonicalPath, result.launcher);
  assert.equal(
    result.componentReceipt.stableLauncher.installReceiptPath,
    path.join(h.platform.paths.runtimeRoot, 'stable-launcher-record.json'),
  );
  assert.equal(result.componentReceipt.stableLauncher.signal.path, result.launcher);
  assert.equal(result.componentReceipt.stableLauncher.signal.size > 0, true);
  assert.equal(result.componentReceipt.stableLauncher.signal.mtimeMs > 0, true);
  assert.equal(result.lifecycle.generations.created, 1);
  assert.equal(result.lifecycle.layers.created, 1);
  const launched = await execFileAsync(result.launcher, ['--fixture'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:clean:-B -I -m ae_mcp --fixture/);
  const node = await manager.resolveNode();
  assert.equal(node.nodePath, path.join(result.componentReceipt.canonicalPath, 'node', 'bin', 'node'));
  assert.equal(node.runtime.relative, result.relative);
  assert.equal(node.runtime.sourceCommitSha, result.sourceCommitSha);
  assert.equal(node.executable.source, 'runtime-manager');
  assert.equal((await manager.inspect()).ok, true);
});

macosRuntimeTest('a readable schema-v1 generation migrates forward without deleting the legacy runtime', async (t) => {
  const h = await harness(t);
  const v1 = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'legacy',
  });
  const v2 = await packageFixture(h.root, {
    version: '0.10.0', sourceCommitSha: '2'.repeat(40), marker: 'upgraded',
  });
  const legacy = await seedLegacyGeneration(h, v1);
  const manager = managerFor(h, v1.extensionRoot);
  const before = await manager.inspect();
  assert.equal(before.current.ok, true, JSON.stringify(before.current));

  const migrated = await manager.ensureReady();

  assert.equal(migrated.action, 'migrate');
  assert.match(migrated.relative, /^generations\/g-[0-9a-f]{16}$/);
  assert.equal(
    (await fs.promises.readFile(h.platform.paths.previousPointer, 'utf8')).trim(),
    legacy.relative,
  );
  assert.equal((await fs.promises.lstat(legacy.generationRoot)).isDirectory(), true);
  assert.equal(migrated.lifecycle.layers.created, 1);
  assert.equal((await manager.inspect()).previous.record.schemaVersion, 1);
  const stableReceipt = JSON.parse(await fs.promises.readFile(
    path.join(h.platform.paths.runtimeRoot, 'stable-launcher-record.json'),
    'utf8',
  ));
  assert.equal(stableReceipt.canonicalPath, h.platform.paths.launcher);
  assert.equal(stableReceipt.signal.path, h.platform.paths.launcher);
  assert.equal(stableReceipt.signal.size > 0, true);
  assert.equal(stableReceipt.signal.mtimeMs > 0, true);

  const upgraded = await managerFor(h, v2.extensionRoot).ensureReady();

  assert.equal(upgraded.action, 'upgrade');
  assert.equal(upgraded.lifecycle.generations.reclaimed, 1);
  await assert.rejects(fs.promises.lstat(legacy.generationRoot), { code: 'ENOENT' });
  const uninstalled = await manager.uninstall();
  assert.equal(uninstalled.lifecycle.generations.reclaimed, 2);
  assert.equal(uninstalled.lifecycle.layers.reclaimed, 2);
  assert.equal(uninstalled.lifecycle.logicalBytes.reclaimed > 0, true);
  assert.equal(uninstalled.lifecycle.physicalBytes.reclaimed > 0, true);
});

macosRuntimeTest('upgrade, downgrade, and rollback atomically select verified versions', async (t) => {
  const h = await harness(t);
  const v1 = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'one',
  });
  const v2 = await packageFixture(h.root, {
    version: '0.10.0', sourceCommitSha: '2'.repeat(40), marker: 'two',
  });
  const one = managerFor(h, v1.extensionRoot);
  const two = managerFor(h, v2.extensionRoot);

  await one.ensureReady();
  assert.equal((await two.ensureReady()).action, 'upgrade');
  const rollback = await two.rollback();
  assert.equal(rollback.version, '0.9.3');
  assert.equal(rollback.lifecycle.generations.reused, 1);
  assert.equal(rollback.lifecycle.layers.reused, 1);
  let launched = await execFileAsync(h.platform.paths.launcher, ['--rollback'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:one:-B -I -m ae_mcp --rollback/);
  assert.equal((await two.inspect()).ok, true);
  assert.equal((await two.ensureReady()).action, 'upgrade');
  launched = await execFileAsync(h.platform.paths.launcher, ['--upgrade'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:two:-B -I -m ae_mcp --upgrade/);
  assert.equal((await one.ensureReady()).action, 'downgrade');
  launched = await execFileAsync(h.platform.paths.launcher, ['--downgrade'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:one:-B -I -m ae_mcp --downgrade/);
  const state = await one.inspect();
  assert.equal(state.current.record.version, '0.9.3');
  assert.equal(state.previous.record.version, '0.10.0');
});

macosRuntimeTest('GC retains current and previous while reclaiming only stale owned schema-v2 state', async (t) => {
  const h = await harness(t);
  const v1 = await packageFixture(path.join(h.root, 'v1'), {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'one',
  });
  const v2 = await packageFixture(path.join(h.root, 'v2'), {
    version: '0.10.0', sourceCommitSha: '2'.repeat(40), marker: 'two',
  });
  const v3 = await packageFixture(path.join(h.root, 'v3'), {
    version: '0.11.0', sourceCommitSha: '3'.repeat(40), marker: 'three',
  });
  const first = await managerFor(h, v1.extensionRoot).ensureReady();
  await managerFor(h, v2.extensionRoot).ensureReady();
  const runtimeRoot = h.platform.paths.runtimeRoot;
  const untouched = [
    path.join(runtimeRoot, 'evidence', 'keep.json'),
    path.join(runtimeRoot, 'fixtures', 'keep.aep'),
    path.join(runtimeRoot, 'issue169-bundle', 'keep.txt'),
    path.join(runtimeRoot, 'locks', 'retained.lock'),
    path.join(runtimeRoot, '.stage-generation-g-in-progress', 'keep.txt'),
    path.join(runtimeRoot, `0.8.0-${'9'.repeat(40)}`, 'keep.txt'),
    path.join(runtimeRoot, 'generations', 'g-aaaaaaaaaaaaaaaa', 'keep.txt'),
    path.join(
      runtimeRoot,
      'layers',
      'f'.repeat(64),
      'i-bbbbbbbbbbbbbbbb',
      'keep.txt',
    ),
  ];
  for (const marker of untouched) {
    await fs.promises.mkdir(path.dirname(marker), { recursive: true });
    await fs.promises.writeFile(marker, 'retain\n');
  }

  const upgraded = await managerFor(h, v3.extensionRoot).ensureReady();
  const state = await managerFor(h, v3.extensionRoot).inspect();

  assert.equal(upgraded.action, 'upgrade');
  assert.equal(state.current.record.version, '0.11.0');
  assert.equal(state.previous.record.version, '0.10.0');
  assert.equal(upgraded.lifecycle.generations.reclaimed, 1);
  assert.equal(upgraded.lifecycle.layers.reclaimed, 0);
  assert.equal(upgraded.lifecycle.logicalBytes.reclaimed > 0, true);
  assert.equal(upgraded.lifecycle.physicalBytes.reclaimed > 0, true);
  await assert.rejects(
    fs.promises.lstat(path.join(runtimeRoot, first.relative)),
    { code: 'ENOENT' },
  );
  assert.equal((await fs.promises.lstat(first.componentReceipt.canonicalPath)).isDirectory(), true);
  for (const marker of untouched) {
    assert.equal(await fs.promises.readFile(marker, 'utf8'), 'retain\n');
  }
  await fs.promises.rm(
    path.join(runtimeRoot, 'generations', 'g-aaaaaaaaaaaaaaaa'),
    { recursive: true },
  );
  const collected = await managerFor(h, v3.extensionRoot).ensureReady();
  assert.equal(collected.lifecycle.generations.reused, 1);
  assert.equal(collected.lifecycle.layers.reused, 1);
  assert.equal(collected.lifecycle.layers.reclaimed, 1);
  await assert.rejects(
    fs.promises.lstat(first.componentReceipt.canonicalPath),
    { code: 'ENOENT' },
  );
});

macosRuntimeTest('a corrupt current layer falls back to the verified previous generation', async (t) => {
  const h = await harness(t);
  const v1 = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'one',
  });
  const v2 = await packageFixture(h.root, {
    version: '0.10.0', sourceCommitSha: '2'.repeat(40), marker: 'two',
  });
  const one = managerFor(h, v1.extensionRoot);
  const two = managerFor(h, v2.extensionRoot);
  await one.ensureReady();
  await two.ensureReady();
  const current = (await two.inspect()).current;
  await fs.promises.appendFile(path.join(current.directory, 'python', 'bin', 'python3'), '# corrupt\n');

  const fallback = await two.ensureReady();

  assert.equal(fallback.action, 'fallback');
  assert.equal(fallback.version, '0.9.3');
  assert.equal(fallback.lifecycle.generations.reused, 1);
  assert.equal(fallback.lifecycle.layers.reused, 1);
  assert.equal(fallback.lifecycle.generations.reclaimed, 1);
  assert.equal(fallback.lifecycle.layers.reclaimed, 1);
  assert.equal(fallback.diagnostics[0].code, 'RUNTIME_CURRENT_INVALID_FALLBACK');
  const launched = await execFileAsync(h.platform.paths.launcher, ['--repaired'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:one:-B -I -m ae_mcp --repaired/);
  assert.equal((await two.inspect()).ok, true);
  await assert.rejects(fs.promises.readFile(h.platform.paths.previousPointer), { code: 'ENOENT' });
  const next = await two.ensureReady();
  assert.equal(next.action, 'upgrade');
  assert.equal(next.version, '0.10.0');
  assert.equal((await two.inspect()).ok, true);
});

macosRuntimeTest('a changed receipt signal escalates to full verification and reuses valid content', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'signal',
  });
  const first = managerFor(h, payload.extensionRoot);
  const installed = await first.ensureReady();
  const selectedRuntime = installed.componentReceipt.canonicalPath;
  const nodePath = path.join(selectedRuntime, 'node', 'bin', 'node');
  const nodeInfo = await fs.promises.stat(nodePath);
  await fs.promises.utimes(nodePath, nodeInfo.atime, new Date(nodeInfo.mtimeMs + 2000));
  let payloadReads = 0;
  const countedPromises = new Proxy(fs.promises, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === 'readFile') {
        return async function counted(targetPath, ...args) {
          const resolved = path.resolve(String(targetPath));
          if (resolved === selectedRuntime || resolved.startsWith(`${selectedRuntime}${path.sep}`)) {
            payloadReads += 1;
          }
          return value.call(target, targetPath, ...args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const manager = managerFor(h, payload.extensionRoot, {
    fsImpl: { ...fs, promises: countedPromises },
  });

  const repaired = await manager.ensureReady();

  assert.equal(repaired.action, 'repair');
  assert.equal(repaired.componentReceipt.layerId, installed.componentReceipt.layerId);
  assert.notEqual(repaired.relative, installed.relative);
  assert.equal(repaired.lifecycle.layers.reused, 1);
  assert.equal(repaired.lifecycle.generations.created, 1);
  assert.equal(repaired.lifecycle.generations.reclaimed, 1);
  assert.equal(payloadReads > 0, true);
});

macosRuntimeTest('a launcher contract change cannot publish a mixed launcher/runtime selection', async (t) => {
  const h = await harness(t);
  const v1 = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'one', launcherVersion: 'v1',
  });
  const v2 = await packageFixture(h.root, {
    version: '0.10.0', sourceCommitSha: '2'.repeat(40), marker: 'two', launcherVersion: 'v2',
  });
  const one = managerFor(h, v1.extensionRoot);
  const incompatible = managerFor(h, v2.extensionRoot);
  const installed = await one.ensureReady();
  const pointerBefore = await fs.promises.readFile(h.platform.paths.currentPointer, 'utf8');
  const launcherBefore = await fs.promises.readFile(h.platform.paths.launcher);
  const before = await managedDirectoryCounts(h.platform.paths.runtimeRoot);

  await assert.rejects(
    incompatible.ensureReady(),
    { code: 'RUNTIME_LAUNCHER_MIGRATION_REQUIRED' },
  );
  assert.deepEqual(await managedDirectoryCounts(h.platform.paths.runtimeRoot), before);

  assert.equal(await fs.promises.readFile(h.platform.paths.currentPointer, 'utf8'), pointerBefore);
  assert.deepEqual(await fs.promises.readFile(h.platform.paths.launcher), launcherBefore);
  await assert.rejects(
    incompatible.repair(),
    { code: 'RUNTIME_LAUNCHER_MIGRATION_REQUIRED' },
  );
  assert.deepEqual(await managedDirectoryCounts(h.platform.paths.runtimeRoot), before);
  const launched = await execFileAsync(installed.launcher, ['--unchanged'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:one:-B -I -m ae_mcp --unchanged/);
});

macosRuntimeTest('a corrupt extension update retains the previously verified active runtime', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'retained',
  });
  const manager = managerFor(h, payload.extensionRoot);
  const installed = await manager.ensureReady();
  await fs.promises.appendFile(path.join(payload.extensionRoot, 'bundle-manifest.json'), 'corrupt update');

  const retained = await manager.ensureReady();

  assert.equal(retained.action, 'retained');
  assert.equal(retained.relative, installed.relative);
  assert.equal(retained.sourceCommitSha, '1'.repeat(40));
  assert.equal(retained.diagnostics[0].code, 'RUNTIME_PACKAGED_PAYLOAD_INVALID_ACTIVE_RETAINED');
  assert.equal((await manager.inspect()).ok, true);
  const launched = await execFileAsync(retained.launcher, ['--after-corrupt-update'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:retained:-B -I -m ae_mcp --after-corrupt-update/);
});

macosRuntimeTest('repair creates a fresh verified generation and uninstall removes active pointers', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'repair',
  });
  const manager = managerFor(h, payload.extensionRoot);
  const installed = await manager.ensureReady();
  const repaired = await manager.repair();

  assert.equal(repaired.action, 'repair');
  assert.notEqual(repaired.relative, installed.relative);
  assert.equal((await manager.rollback()).relative, installed.relative);
  const runtimeRoot = h.platform.paths.runtimeRoot;
  const adversarial = [
    path.join(runtimeRoot, 'unowned-minimal'),
    path.join(runtimeRoot, 'unowned-corrupt'),
    path.join(runtimeRoot, 'unowned-v1-like'),
  ];
  for (const directory of adversarial) await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(
    path.join(adversarial[0], 'install-record.json'),
    JSON.stringify({ schemaVersion: 1, platform: 'macos-arm64' }),
  );
  await fs.promises.writeFile(
    path.join(adversarial[1], 'install-record.json'),
    '{"schemaVersion":1',
  );
  await fs.promises.writeFile(
    path.join(adversarial[2], 'install-record.json'),
    JSON.stringify({
      schemaVersion: 1,
      owner: 'not-runtime-manager',
      platform: 'macos-arm64',
      version: '0.9.3',
      installedAt: 1,
      relative: 'unowned-v1-like/macos-arm64',
      sourceCommitSha: '1'.repeat(40),
      runtimeManifestSha256: '2'.repeat(64),
      launcherSha256: '3'.repeat(64),
    }),
  );
  const uninstalled = await manager.uninstall();
  assert.equal(uninstalled.action, 'uninstall');
  assert.equal(uninstalled.lifecycle.generations.reclaimed, 2);
  assert.equal(uninstalled.lifecycle.layers.reclaimed, 2);
  assert.equal(uninstalled.lifecycle.logicalBytes.reclaimed > 0, true);
  assert.equal(uninstalled.lifecycle.physicalBytes.reclaimed > 0, true);
  for (const directory of adversarial) {
    assert.equal((await fs.promises.lstat(directory)).isDirectory(), true);
  }
  await assert.rejects(fs.promises.readFile(h.platform.paths.currentPointer), { code: 'ENOENT' });
  await assert.rejects(fs.promises.readFile(h.platform.paths.previousPointer), { code: 'ENOENT' });
  await assert.rejects(fs.promises.lstat(h.platform.paths.launcher), { code: 'ENOENT' });
});

macosRuntimeTest('concurrent panel launches serialize on the process-safe runtime lock', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'concurrent',
  });
  const first = managerFor(h, payload.extensionRoot);
  const second = managerFor(h, payload.extensionRoot);

  const results = await Promise.all([first.ensureReady(), second.ensureReady()]);

  assert.deepEqual(results.map((value) => value.action).sort(), ['install', 'ready']);
  assert.equal((await first.inspect()).ok, true);
  await assert.rejects(fs.promises.lstat(path.join(h.platform.paths.runtimeRoot, '.runtime-manager.lock')), { code: 'ENOENT' });
});

macosRuntimeTest('concurrent cold-start checks on one panel share a single RuntimeManager activation', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'shared-cold-start',
  });
  const manager = managerFor(h, payload.extensionRoot);

  const aeMcpCheck = manager.ensureReady();
  const nodeCheck = manager.ensureReady();

  assert.strictEqual(aeMcpCheck, nodeCheck);
  const [first, second] = await Promise.all([aeMcpCheck, nodeCheck]);
  assert.equal(first.action, 'install');
  assert.deepEqual(second, first);
  assert.equal((await manager.inspect()).ok, true);
});

macosRuntimeTest('a dead lock owner is archived and activation proceeds', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'dead-owner',
  });
  const lockPath = path.join(h.platform.paths.runtimeRoot, '.runtime-manager.lock');
  const deadOwner = { pid: 999999, acquiredAt: 1 };
  await fs.promises.mkdir(h.platform.paths.runtimeRoot, { recursive: true });
  await fs.promises.writeFile(lockPath, `${JSON.stringify(deadOwner)}\n`);
  const manager = managerFor(h, payload.extensionRoot, {
    isProcessAlive(ownerPid) {
      assert.equal(ownerPid, deadOwner.pid);
      return false;
    },
  });

  const selected = await manager.ensureReady();

  assert.equal(selected.action, 'install');
  await assert.rejects(fs.promises.lstat(lockPath), { code: 'ENOENT' });
  const entries = await fs.promises.readdir(h.platform.paths.runtimeRoot);
  const archive = entries.find((entry) => entry.startsWith('.runtime-manager.stale-lock.'));
  assert.ok(archive);
  assert.deepEqual(
    JSON.parse(await fs.promises.readFile(path.join(h.platform.paths.runtimeRoot, archive), 'utf8')),
    deadOwner,
  );
});

macosRuntimeTest('a malformed lock with a dead pid fails closed without archiving', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'malformed-lock',
  });
  const lockPath = path.join(h.platform.paths.runtimeRoot, '.runtime-manager.lock');
  const malformedOwner = { pid: 999999 };
  await fs.promises.mkdir(h.platform.paths.runtimeRoot, { recursive: true });
  await fs.promises.writeFile(lockPath, `${JSON.stringify(malformedOwner)}\n`);
  let clock = 0;
  const manager = managerFor(h, payload.extensionRoot, {
    isProcessAlive() {
      assert.fail('malformed lock must not be treated as a known owner');
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    lockTimeoutMs: 50,
    lockPollMs: 25,
  });

  await assert.rejects(
    manager.ensureReady(),
    (error) => error?.code === 'RUNTIME_MANAGER_LOCKED',
  );
  assert.deepEqual(
    JSON.parse(await fs.promises.readFile(lockPath, 'utf8')),
    malformedOwner,
  );
  const entries = await fs.promises.readdir(h.platform.paths.runtimeRoot);
  assert.equal(entries.filter((entry) => entry.startsWith('.runtime-manager.stale-lock.')).length, 0);
});

macosRuntimeTest('unchanged runtime receipt is reused across source revisions without a tree walk', async (t) => {
  const h = await harness(t);
  const firstPayload = await packageFixture(path.join(h.root, 'first'), {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'shared',
  });
  const secondPayload = await packageFixture(path.join(h.root, 'second'), {
    version: '0.9.3', sourceCommitSha: '2'.repeat(40), marker: 'shared',
  });
  const first = managerFor(h, firstPayload.extensionRoot);
  const installed = await first.ensureReady();
  const selectedRuntime = installed.componentReceipt.canonicalPath;
  const guardedPromises = new Proxy(fs.promises, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === 'readdir' || property === 'readFile') {
        return async function guarded(targetPath, ...args) {
          const resolved = path.resolve(String(targetPath));
          if (resolved === selectedRuntime || resolved.startsWith(`${selectedRuntime}${path.sep}`)) {
            throw new Error(`routine trusted reuse attempted runtime tree I/O: ${property} ${resolved}`);
          }
          return value.call(target, targetPath, ...args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const guardedFs = { ...fs, promises: guardedPromises };
  const second = managerFor(h, secondPayload.extensionRoot, { fsImpl: guardedFs });
  const generationLauncher = path.join(
    h.platform.paths.runtimeRoot,
    installed.relative,
    'ae-mcp-launcher',
  );
  const expectedLauncher = await fs.promises.readFile(generationLauncher);
  const driftedLauncher = Buffer.from(expectedLauncher);
  driftedLauncher[driftedLauncher.length - 1] ^= 1;
  await fs.promises.writeFile(h.platform.paths.launcher, driftedLauncher, { mode: 0o755 });
  await fs.promises.chmod(h.platform.paths.launcher, 0o755);

  const reused = await second.ensureReady();

  assert.equal(reused.action, 'ready');
  assert.equal(reused.relative, installed.relative);
  assert.equal(reused.sourceCommitSha, '1'.repeat(40));
  assert.equal(reused.packagedSourceCommitSha, '2'.repeat(40));
  assert.equal(reused.diagnostics[0].code, 'RUNTIME_SOURCE_REVISION_DIFFERENT_TRUSTED');
  assert.equal(reused.lifecycle.generations.reused, 1);
  assert.equal(reused.lifecycle.layers.reused, 1);
  assert.equal(reused.componentReceipt.stableLauncher.signal.path, reused.launcher);
  assert.deepEqual(await fs.promises.readFile(h.platform.paths.launcher), expectedLauncher);
  assert.equal((await second.inspect()).ok, true);
});

macosRuntimeTest('a held lock fails with an actionable bounded diagnostic', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'locked',
  });
  await fs.promises.mkdir(h.platform.paths.runtimeRoot, { recursive: true });
  const liveOwner = { pid: 12345, acquiredAt: 1 };
  await fs.promises.writeFile(
    path.join(h.platform.paths.runtimeRoot, '.runtime-manager.lock'),
    `${JSON.stringify(liveOwner)}\n`,
  );
  let clock = 0;
  const manager = managerFor(h, payload.extensionRoot, {
    isProcessAlive(ownerPid) {
      assert.equal(ownerPid, liveOwner.pid);
      return true;
    },
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    lockTimeoutMs: 50,
    lockPollMs: 10,
  });

  await assert.rejects(
    manager.ensureReady(),
    (error) => error?.code === 'RUNTIME_MANAGER_LOCKED' && /retry/i.test(error.message),
  );
});
