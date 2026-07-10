import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const EXPECTED_RUNTIME_LOCK = {
  schemaVersion: 1,
  node: {
    version: '24.17.0',
    headers: {
      url: 'https://nodejs.org/dist/v24.17.0/node-v24.17.0-headers.tar.gz',
      sha256: 'ac60c4ba92204658efaac112efea5d3597348b011be679af0eec324d8c08915e',
    },
    assets: {
      'macos-arm64': {
        url: 'https://nodejs.org/dist/v24.17.0/node-v24.17.0-darwin-arm64.tar.gz',
        sha256: '4fc3266a3702eebc39cc37661cf4eeceeade307e242ab64e4d7ce7949197e11f',
      },
      'windows-x64': {
        url: 'https://nodejs.org/dist/v24.17.0/node-v24.17.0-win-x64.zip',
        sha256: 'f2aa33b35b75aca5f3f7b85675a6f6423201053e9381911e64961f3bda2528ab',
      },
    },
  },
  python: {
    version: '3.13.14',
    distributionRelease: '20260610',
    assets: {
      'macos-arm64': {
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-aarch64-apple-darwin-install_only_stripped.tar.gz',
        sha256: '79daa8e9dea1e64ad50aebb05a807289023a474c2020b72361eb44d67fa2401e',
      },
      'windows-x64': {
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
        sha256: '2933d50847057b9131ff89578a220b9206c40fd6bc34d0c12afb716bd9bf8fc9',
      },
    },
  },
};

const BUILD_PROJECTS = [
  'packages/core/pyproject.toml',
  'packages/bridge/pyproject.toml',
  'packages/snapshot-mss/pyproject.toml',
];

async function makeTempDir(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-runtime-lock-'));
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));
  return root;
}

test('runtime lock pins exact redistributable bytes', () => {
  const lock = JSON.parse(fs.readFileSync('packaging/runtime-lock.json', 'utf8'));
  assert.deepEqual(lock, EXPECTED_RUNTIME_LOCK);

  for (const asset of [
    lock.node.headers,
    ...Object.values(lock.node.assets),
    ...Object.values(lock.python.assets),
  ]) {
    assert.match(asset.url, /^https:\/\//);
    assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  }
});

test('runtime npm inputs are exact direct pins in manifests and lockfiles', () => {
  const hostManifest = JSON.parse(fs.readFileSync('plugin/host/package.json', 'utf8'));
  const hostLock = JSON.parse(fs.readFileSync('plugin/host/package-lock.json', 'utf8'));
  const sidecarManifest = JSON.parse(fs.readFileSync('plugin/sidecar/package.json', 'utf8'));
  const sidecarLock = JSON.parse(fs.readFileSync('plugin/sidecar/package-lock.json', 'utf8'));

  assert.equal(hostManifest.dependencies.express, '4.22.1');
  assert.equal(hostLock.packages[''].dependencies.express, '4.22.1');
  assert.equal(hostLock.packages['node_modules/express'].version, '4.22.1');
  assert.equal(sidecarManifest.dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.174');
  assert.equal(sidecarLock.packages[''].dependencies['@anthropic-ai/claude-agent-sdk'], '0.3.174');
  assert.equal(
    sidecarLock.packages['node_modules/@anthropic-ai/claude-agent-sdk'].version,
    '0.3.174',
  );
});

test('argument parsing accepts only the supported portable runtime contract', async () => {
  const { parsePortableRuntimeArgs } = await import('../lib/args.mjs');

  assert.deepEqual(
    parsePortableRuntimeArgs(['--platform', 'macos-arm64', '--out', 'build/runtime/macos-arm64']),
    { platform: 'macos-arm64', outDir: 'build/runtime/macos-arm64' },
  );
  assert.deepEqual(
    parsePortableRuntimeArgs(['--out=build/runtime/windows-x64', '--platform=windows-x64']),
    { platform: 'windows-x64', outDir: 'build/runtime/windows-x64' },
  );
  assert.throws(
    () => parsePortableRuntimeArgs(['--platform', 'linux-x64', '--out', 'runtime']),
    /unsupported platform/i,
  );
  assert.throws(() => parsePortableRuntimeArgs(['--platform', 'macos-arm64']), /--out/);
  assert.throws(
    () => parsePortableRuntimeArgs(['--platform', 'macos-arm64', '--out', 'runtime', '--force']),
    /unknown argument/i,
  );
});

test('locked download publishes only bytes matching the expected SHA-256', async (t) => {
  const { downloadLockedAsset } = await import('../lib/locked-download.mjs');
  const root = await makeTempDir(t);
  const bytes = Buffer.from('portable-runtime-byte-contract\n', 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const destination = path.join(root, 'asset.bin');

  await downloadLockedAsset({
    url: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
    sha256,
    destination,
  });

  assert.deepEqual(await fs.promises.readFile(destination), bytes);
  assert.deepEqual(await fs.promises.readdir(root), ['asset.bin']);
});

test('locked download removes unverified bytes and never replaces a destination', async (t) => {
  const { downloadLockedAsset } = await import('../lib/locked-download.mjs');
  const root = await makeTempDir(t);
  const bytes = Buffer.from('tampered-runtime-asset', 'utf8');
  const destination = path.join(root, 'asset.bin');

  await assert.rejects(
    downloadLockedAsset({
      url: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
      sha256: '0'.repeat(64),
      destination,
    }),
    /SHA-256 mismatch/i,
  );
  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(await fs.promises.readdir(root), []);

  await fs.promises.writeFile(destination, 'existing');
  await assert.rejects(
    downloadLockedAsset({
      url: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      destination,
    }),
    /already exists/i,
  );
  assert.equal(await fs.promises.readFile(destination, 'utf8'), 'existing');
});

test('directory publication is a same-parent atomic rename with no partial output', async (t) => {
  const { createSiblingTempDirectory, publishDirectoryAtomically } = await import('../lib/files.mjs');
  const root = await makeTempDir(t);
  const destination = path.join(root, 'runtime');
  const temporary = await createSiblingTempDirectory(destination);
  await fs.promises.writeFile(path.join(temporary, 'complete.txt'), 'complete');

  await publishDirectoryAtomically({ temporary, destination });

  assert.equal(await fs.promises.readFile(path.join(destination, 'complete.txt'), 'utf8'), 'complete');
  assert.equal(fs.existsSync(temporary), false);

  const secondTemporary = await createSiblingTempDirectory(destination);
  t.after(() => fs.promises.rm(secondTemporary, { force: true, recursive: true }));
  await assert.rejects(
    publishDirectoryAtomically({ temporary: secondTemporary, destination }),
    /already exists/i,
  );
  assert.equal(fs.existsSync(secondTemporary), true);
});

test('build backend validation rejects an unpinned three-project fixture', async (t) => {
  const { assertWorkspaceBuildBackendsLocked } = await import('../build-portable-runtime.mjs');
  const fixture = await makeTempDir(t);
  await fs.promises.copyFile('uv.lock', path.join(fixture, 'uv.lock'));

  for (const project of BUILD_PROJECTS) {
    const destination = path.join(fixture, project);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const source = await fs.promises.readFile(project, 'utf8');
    const unpinned = source.replace(
      /requires = \["hatchling(?:==1\.31\.0)?"\]/,
      'requires = ["hatchling"]',
    );
    assert.match(unpinned, /requires = \["hatchling"\]/);
    await fs.promises.writeFile(destination, unpinned);
  }

  assert.throws(
    () => assertWorkspaceBuildBackendsLocked(fixture),
    { code: 'UNLOCKED_BUILD_BACKEND' },
  );
});

test('repository build backend closure locks hatchling 1.31.0 with SHA-256', async () => {
  const { assertWorkspaceBuildBackendsLocked } = await import('../build-portable-runtime.mjs');
  const closure = assertWorkspaceBuildBackendsLocked(process.cwd());
  const byName = new Map(closure.map((item) => [item.name.toLowerCase(), item]));
  const hatchling = byName.get('hatchling');

  assert.equal(hatchling?.version, '1.31.0');
  assert.ok(
    hatchling.hashes.includes('aac80bec8b6fe35e8480f1c335be8910fa210a0e6f735a139be205dadcacb544'),
  );
  assert.ok(closure.length > 1, 'expected the complete transitive build-tool closure');
  for (const item of closure) {
    assert.ok(item.hashes.length > 0, `${item.name} has no locked SHA-256`);
    for (const hash of item.hashes) assert.match(hash, /^[a-f0-9]{64}$/);
    for (const dependency of item.dependencies) {
      const normalized = dependency.toLowerCase().replace(/[-_.]+/g, '-');
      assert.ok(byName.has(normalized), `${item.name} dependency ${dependency} is absent`);
    }
  }
});
