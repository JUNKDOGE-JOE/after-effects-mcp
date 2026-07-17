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
  const python = await writeFile(
    runtimeRoot,
    'python/bin/python3',
    `#!/bin/sh\nprintf 'core-started:${marker}:%s\\n' "$*"\n`,
    0o755,
  );
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
      'exec "$base/runtime/$relative/python/bin/python3" -B -I -m ae_mcp "$@"',
      '',
    ].join('\n'),
    0o755,
  );
  const runtimeManifestSha256 = await sha256File(runtimeManifestPath);
  const launcherSha256 = await sha256File(launcher);
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
    ],
  }, null, 2)}\n`);
  return { extensionRoot, runtimeRoot, python };
}

async function harness(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-runtime-manager-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const home = path.join(root, '用户 Home with spaces');
  await fs.promises.mkdir(home, { recursive: true });
  return { root, home, platform: adapter(home) };
}

function managerFor(h, extensionRoot, options = {}) {
  return createRuntimeManager({
    platform: h.platform,
    extensionRoot,
    cryptoImpl: crypto,
    randomBytes: crypto.randomBytes,
    ...options,
  });
}

test('clean macOS install activates and starts the bundled core without PATH tools', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'clean',
  });
  const manager = managerFor(h, payload.extensionRoot);

  const result = await manager.ensureReady();

  assert.equal(result.action, 'install');
  assert.equal(result.launcher, path.join(h.home, '.ae-mcp', 'bin', 'ae-mcp'));
  assert.match(await fs.promises.readFile(h.platform.paths.currentPointer, 'utf8'), /^0\.9\.3-[0-9a-f]{40}\/macos-arm64\n$/);
  const launched = await execFileAsync(result.launcher, ['--fixture'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:clean:-B -I -m ae_mcp --fixture/);
  const node = await manager.resolveNode();
  assert.equal(node.nodePath, path.join(h.platform.paths.runtimeRoot, result.relative, 'node', 'bin', 'node'));
  assert.equal(node.runtime.relative, result.relative);
  assert.equal(node.runtime.sourceCommitSha, result.sourceCommitSha);
  assert.equal(node.executable.source, 'runtime-manager');
  assert.equal((await manager.inspect()).ok, true);
});

test('upgrade, downgrade, and rollback atomically select verified versions', async (t) => {
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
  assert.equal((await two.rollback()).version, '0.9.3');
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

test('a corrupt current runtime falls back once, then a later call repairs from the offline payload', async (t) => {
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
  const current = (await fs.promises.readFile(h.platform.paths.currentPointer, 'utf8')).trim();
  await fs.promises.appendFile(path.join(h.platform.paths.runtimeRoot, current, 'python', 'bin', 'python3'), '# corrupt\n');

  const fallback = await two.ensureReady();

  assert.equal(fallback.action, 'fallback');
  assert.equal(fallback.version, '0.9.3');
  assert.equal(fallback.diagnostics[0].code, 'RUNTIME_CURRENT_INVALID_FALLBACK');
  const launched = await execFileAsync(h.platform.paths.launcher, ['--fallback'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:one:-B -I -m ae_mcp --fallback/);
  assert.equal((await two.inspect()).ok, true);
  await assert.rejects(fs.promises.readFile(h.platform.paths.previousPointer), { code: 'ENOENT' });
  const next = await two.ensureReady();
  assert.notEqual(next.action, 'fallback');
  assert.equal(next.version, '0.10.0');
  assert.equal((await two.inspect()).ok, true);
});

test('a launcher contract change cannot publish a mixed launcher/runtime selection', async (t) => {
  const h = await harness(t);
  const v1 = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'one', launcherVersion: 'v1',
  });
  const v2 = await packageFixture(h.root, {
    version: '0.10.0', sourceCommitSha: '2'.repeat(40), marker: 'two', launcherVersion: 'v2',
  });
  const one = managerFor(h, v1.extensionRoot);
  const two = managerFor(h, v2.extensionRoot);
  const installed = await one.ensureReady();
  const pointerBefore = await fs.promises.readFile(h.platform.paths.currentPointer, 'utf8');
  const launcherBefore = await fs.promises.readFile(h.platform.paths.launcher);

  await assert.rejects(two.ensureReady(), { code: 'RUNTIME_LAUNCHER_MIGRATION_REQUIRED' });

  assert.equal(await fs.promises.readFile(h.platform.paths.currentPointer, 'utf8'), pointerBefore);
  assert.deepEqual(await fs.promises.readFile(h.platform.paths.launcher), launcherBefore);
  const launched = await execFileAsync(installed.launcher, ['--unchanged'], {
    env: { HOME: h.home, AE_MCP_HOME: h.platform.paths.configRoot, PATH: '/usr/bin:/bin' },
  });
  assert.match(launched.stdout, /core-started:one:-B -I -m ae_mcp --unchanged/);
});

test('a corrupt extension update retains the previously verified active runtime', async (t) => {
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

test('repair creates a fresh verified generation and uninstall removes active pointers', async (t) => {
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
  assert.equal((await manager.uninstall()).action, 'uninstall');
  await assert.rejects(fs.promises.readFile(h.platform.paths.currentPointer), { code: 'ENOENT' });
  await assert.rejects(fs.promises.readFile(h.platform.paths.previousPointer), { code: 'ENOENT' });
  await assert.rejects(fs.promises.lstat(h.platform.paths.launcher), { code: 'ENOENT' });
});

test('concurrent panel launches serialize on the process-safe runtime lock', async (t) => {
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

test('concurrent cold-start checks on one panel share a single RuntimeManager activation', async (t) => {
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

test('a held lock fails with an actionable bounded diagnostic', async (t) => {
  const h = await harness(t);
  const payload = await packageFixture(h.root, {
    version: '0.9.3', sourceCommitSha: '1'.repeat(40), marker: 'locked',
  });
  await fs.promises.mkdir(h.platform.paths.runtimeRoot, { recursive: true });
  await fs.promises.writeFile(path.join(h.platform.paths.runtimeRoot, '.runtime-manager.lock'), '{}\n');
  let clock = 0;
  const manager = managerFor(h, payload.extensionRoot, {
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
