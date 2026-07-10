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
    sourceAsset: {
      url: 'https://nodejs.org/dist/v24.17.0/node-v24.17.0.tar.xz',
      sha256: 'a7ab562ed2369a29c68b72fa00e3103bcdfe37063dff799c6acc8e404e275fcd',
      licenseSha256: '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18',
    },
    headers: {
      url: 'https://nodejs.org/dist/v24.17.0/node-v24.17.0-headers.tar.gz',
      sha256: 'ac60c4ba92204658efaac112efea5d3597348b011be679af0eec324d8c08915e',
    },
    assets: {
      'macos-arm64': {
        url: 'https://nodejs.org/dist/v24.17.0/node-v24.17.0-darwin-arm64.tar.gz',
        sha256: '4fc3266a3702eebc39cc37661cf4eeceeade307e242ab64e4d7ce7949197e11f',
        format: 'ustar-gzip',
        root: 'node-v24.17.0-darwin-arm64',
        archiveBytes: 51886390,
        rawEntryCount: 5729,
        regularBytes: 192431586,
        maxEntryBytes: 120591840,
        decompressedBytes: 196613120,
        manifestSha256: '784602bc5dab71a90be876c3893eab618a757c4a479ac61dc85f2186f066f8c8',
      },
      'windows-x64': {
        url: 'https://nodejs.org/dist/v24.17.0/node-v24.17.0-win-x64.zip',
        sha256: 'f2aa33b35b75aca5f3f7b85675a6f6423201053e9381911e64961f3bda2528ab',
        format: 'zip',
        root: 'node-v24.17.0-win-x64',
        archiveBytes: 36948900,
        rawEntryCount: 2404,
        regularBytes: 104985270,
        maxEntryBytes: 92299080,
        decompressedBytes: 104985270,
        manifestSha256: 'b37b79e3f9c13a9802b7fe46e6073a5990c9b258a7155b8f33ca2e36fccd2415',
      },
    },
  },
  python: {
    version: '3.13.14',
    distributionRelease: '20260610',
    releaseCommit: 'f1d7b92301235781d4de2493578773aaa413c0a5',
    assets: {
      'macos-arm64': {
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-aarch64-apple-darwin-install_only_stripped.tar.gz',
        sha256: '79daa8e9dea1e64ad50aebb05a807289023a474c2020b72361eb44d67fa2401e',
        format: 'ustar-gzip',
        root: 'python',
        archiveBytes: 25135839,
        rawEntryCount: 1643,
        regularBytes: 64244039,
        maxEntryBytes: 17456704,
        decompressedBytes: 65515520,
        manifestSha256: '6f4457ec5be9050f3f591def19e54552a95e1a2a77037d6c43a67b90d0386776',
      },
      'windows-x64': {
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-x86_64-pc-windows-msvc-install_only_stripped.tar.gz',
        sha256: '2933d50847057b9131ff89578a220b9206c40fd6bc34d0c12afb716bd9bf8fc9',
        format: 'ustar-gzip',
        root: 'python',
        archiveBytes: 21877900,
        rawEntryCount: 3283,
        regularBytes: 62502912,
        maxEntryBytes: 7981568,
        decompressedBytes: 65049600,
        manifestSha256: 'edb2d56f243af22ccebed5fc43ae736e584775c4290316b48a5deddb08b33d1d',
      },
    },
    metadataAssets: {
      'macos-arm64': {
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-aarch64-apple-darwin-pgo%2Blto-full.tar.zst',
        sha256: 'f8b07ffcaf10b1e3586665a848ad295a7d58453a248beac9da2f5f15861dad65',
        size: 58342192,
        expandedTarBytes: 260812800,
        expandedTarSha256: 'bd12df8109d84004fc606b6ad31eb290435c28f3bc1cb8d0a04a05b2a3af315a',
        pythonJsonSha256: '0b1dea1de856d336bf9fde9a290b971ee808f53067dff5ac5ed5f755a4c6ae43',
      },
      'windows-x64': {
        url: 'https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.13.14%2B20260610-x86_64-pc-windows-msvc-pgo-full.tar.zst',
        sha256: 'df646d34e8a0b4aca87b8a253053c7e4994ba94fe2aebd9beb74697cc8e7516b',
        size: 45399670,
        expandedTarBytes: 317552640,
        expandedTarSha256: 'f7baeba65d611c545a0911dc433ff46cb655df4779c77f1dfe9ad81854f180d0',
        pythonJsonSha256: '8eefa76eb09fcfa66cf15970536e3c2501f84e3a834bd3b5e3c688649db723f7',
      },
    },
  },
  claudeCli: {
    version: '2.1.174',
    sdkVersion: '0.3.174',
    assets: {
      'macos-arm64': {
        package: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
        binary: 'claude',
        mode: '0755',
        sha256: '20c5380b4423be9963c510f5464cc1f443235a9b4423179f9c01f28021b81bad',
      },
      'windows-x64': {
        package: '@anthropic-ai/claude-agent-sdk-win32-x64',
        binary: 'claude.exe',
        mode: 'regular-pe-x64',
        sha256: '6e18f7a62a5046606d84c875e2dcc01aa90950e002acf8d5994e2f214c1ab861',
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
    lock.node.sourceAsset,
    lock.node.headers,
    ...Object.values(lock.node.assets),
    ...Object.values(lock.python.assets),
    ...Object.values(lock.python.metadataAssets),
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
    expectedBytes: bytes.length,
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

test('locked download enforces the exact byte length while streaming', async (t) => {
  const { downloadLockedAsset } = await import('../lib/locked-download.mjs');
  const root = await makeTempDir(t);
  const bytes = Buffer.from('bounded-runtime-download', 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  for (const expectedBytes of [bytes.length - 1, bytes.length + 1]) {
    const destination = path.join(root, `asset-${expectedBytes}.bin`);
    await assert.rejects(
      downloadLockedAsset({
        url: `data:application/octet-stream;base64,${bytes.toString('base64')}`,
        sha256,
        expectedBytes,
        destination,
      }),
      /byte length|expectedBytes|download size/i,
    );
    assert.equal(fs.existsSync(destination), false);
  }
  assert.deepEqual(await fs.promises.readdir(root), []);
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

test('file inventory rejects escaping symlinks and special filesystem entries', async (t) => {
  const { inventoryFiles } = await import('../lib/files.mjs');
  const root = await makeTempDir(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  t.after(() => fs.promises.rm(outside, { force: true }));
  await fs.promises.writeFile(outside, 'outside');
  await fs.promises.symlink(outside, path.join(root, 'escape'));

  await assert.rejects(inventoryFiles(root), /symlink.*outside|escapes.*root/i);

  if (process.platform !== 'win32') {
    await fs.promises.rm(path.join(root, 'escape'));
    const { spawnSync } = await import('node:child_process');
    const fifo = path.join(root, 'named-pipe');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    await assert.rejects(inventoryFiles(root), /unsupported|special.*named-pipe/i);
  }
});

test('file inventory rejects absolute symlinks even when they currently resolve inside the root', {
  skip: process.platform === 'win32' ? 'Windows symlink creation requires an elevated fixture' : false,
}, async (t) => {
  const { inventoryFiles } = await import('../lib/files.mjs');
  const root = await makeTempDir(t);
  const target = path.join(root, 'inside.txt');
  await fs.promises.writeFile(target, 'inside');
  await fs.promises.symlink(target, path.join(root, 'absolute-link'));

  await assert.rejects(inventoryFiles(root), /absolute symlink/i);
});

test('file inventory uses locale-independent UTF-8 byte ordering', async (t) => {
  const { inventoryFiles } = await import('../lib/files.mjs');
  const root = await makeTempDir(t);
  for (const name of ['a.txt', 'é.txt', 'Z.txt']) {
    await fs.promises.writeFile(path.join(root, name), name);
  }

  const files = await inventoryFiles(root);
  assert.deepEqual(files.map((entry) => entry.path), ['Z.txt', 'a.txt', 'é.txt']);
});

test('file inventory fails closed if a regular file becomes a symlink before hashing', {
  skip: process.platform === 'win32' ? 'Windows symlink creation requires an elevated fixture' : false,
}, async (t) => {
  const { inventoryFiles } = await import('../lib/files.mjs');
  const root = await makeTempDir(t);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
  const target = path.join(root, 'payload.txt');
  t.after(() => fs.promises.rm(outside, { force: true }));
  await fs.promises.writeFile(outside, 'outside');
  await fs.promises.writeFile(target, 'inside');
  const originalLstat = fs.promises.lstat;
  let replaced = false;
  fs.promises.lstat = async (filePath, options) => {
    const stats = await originalLstat(filePath, options);
    if (!replaced && path.resolve(filePath) === path.resolve(target)) {
      replaced = true;
      await fs.promises.rm(target);
      await fs.promises.symlink(outside, target);
    }
    return stats;
  };
  try {
    await assert.rejects(inventoryFiles(root), /changed during inventory|symbolic link|ELOOP/i);
  } finally {
    fs.promises.lstat = originalLstat;
  }
  assert.equal(replaced, true);
});

test('file inventory rejects hard-linked regular files', async (t) => {
  const { inventoryFiles } = await import('../lib/files.mjs');
  const root = await makeTempDir(t);
  const first = path.join(root, 'first.txt');
  await fs.promises.writeFile(first, 'shared inode');
  await fs.promises.link(first, path.join(root, 'second.txt'));

  await assert.rejects(inventoryFiles(root), /hard-linked file|link count/i);
});

test('real malicious tar and zip are rejected before extracting outside the root', async (t) => {
  const { extractSingleRoot } = await import('../build-portable-runtime.mjs');
  const root = await makeTempDir(t);
  const tarPath = path.join(root, 'malicious.tar.gz');
  const zipPath = path.join(root, 'malicious.zip');
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const { spawnSync } = await import('node:child_process');
  const source = [
    'import io, sys, tarfile, zipfile',
    'tar_path, zip_path = sys.argv[1:3]',
    'with tarfile.open(tar_path, "w:gz") as archive:',
    '    safe = tarfile.TarInfo("python/ok.txt")',
    '    safe.size = 2',
    '    archive.addfile(safe, io.BytesIO(b"ok"))',
    '    evil = tarfile.TarInfo("../tar-owned.txt")',
    '    evil.size = 5',
    '    archive.addfile(evil, io.BytesIO(b"owned"))',
    'with zipfile.ZipFile(zip_path, "w") as archive:',
    '    archive.writestr("python/ok.txt", "ok")',
    '    archive.writestr("../zip-owned.txt", "owned")',
  ].join('\n');
  const generated = spawnSync(python, ['-c', source, tarPath, zipPath], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);

  for (const [archive, owned] of [
    [tarPath, path.join(root, 'tar-owned.txt')],
    [zipPath, path.join(root, 'zip-owned.txt')],
  ]) {
    const archiveBytes = (await fs.promises.stat(archive)).size;
    const archiveSha256 = createHash('sha256')
      .update(await fs.promises.readFile(archive))
      .digest('hex');
    await assert.rejects(
      extractSingleRoot({
        archive,
        extractionRoot: path.join(root, `extract-${path.extname(archive).slice(1)}`),
        destination: path.join(root, `runtime-${path.extname(archive).slice(1)}`),
        contract: {
          format: archive.endsWith('.zip') ? 'zip' : 'ustar-gzip',
          root: 'python',
          sha256: archiveSha256,
          archiveBytes,
          rawEntryCount: 2,
          regularBytes: 7,
          maxEntryBytes: 5,
          decompressedBytes: 1,
          manifestSha256: '0'.repeat(64),
        },
      }),
      /unsafe archive/i,
    );
    assert.equal(fs.existsSync(owned), false);
  }
});

test('locked extraction binds a structurally valid archive to its locked SHA-256', async (t) => {
  const { extractSingleRoot } = await import('../build-portable-runtime.mjs');
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archive = path.join(root, 'python.tar.gz');
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const { spawnSync } = await import('node:child_process');
  const generated = spawnSync(python, ['-c', [
    'import io, sys, tarfile',
    'with tarfile.open(sys.argv[1], "w:gz", format=tarfile.USTAR_FORMAT) as output:',
    '    entry = tarfile.TarInfo("python/bin/python")',
    '    entry.mode = 0o755',
    '    entry.size = 2',
    '    output.addfile(entry, io.BytesIO(b"ok"))',
  ].join('\n'), archive], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const inspection = await inspectLockedArchive({
    archivePath: archive,
    format: 'ustar-gzip',
    expectedRoot: 'python',
  });

  await assert.rejects(
    extractSingleRoot({
      archive,
      extractionRoot: path.join(root, 'staging'),
      destination: path.join(root, 'runtime-python'),
      contract: {
        format: inspection.format,
        root: inspection.expectedRoot,
        sha256: '0'.repeat(64),
        archiveBytes: inspection.metrics.archiveBytes,
        rawEntryCount: inspection.metrics.rawEntryCount,
        regularBytes: inspection.metrics.regularBytes,
        maxEntryBytes: inspection.metrics.maxEntryBytes,
        decompressedBytes: inspection.metrics.decompressedBytes,
        manifestSha256: inspection.manifestSha256,
      },
    }),
    /archive SHA-256 mismatch/i,
  );
  assert.equal(fs.existsSync(path.join(root, 'runtime-python')), false);
});

test('locked extraction verifies the canonical tree before publishing it', async (t) => {
  const { extractSingleRoot } = await import('../build-portable-runtime.mjs');
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archive = path.join(root, 'python.tar.gz');
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const { spawnSync } = await import('node:child_process');
  const generated = spawnSync(python, ['-c', [
    'import io, sys, tarfile',
    'with tarfile.open(sys.argv[1], "w:gz", format=tarfile.USTAR_FORMAT) as output:',
    '    entry = tarfile.TarInfo("python/bin/python")',
    '    entry.mode = 0o755',
    '    entry.size = 2',
    '    output.addfile(entry, io.BytesIO(b"ok"))',
  ].join('\n'), archive], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const inspection = await inspectLockedArchive({
    archivePath: archive,
    format: 'ustar-gzip',
    expectedRoot: 'python',
  });
  const contract = {
    format: inspection.format,
    root: inspection.expectedRoot,
    sha256: createHash('sha256').update(await fs.promises.readFile(archive)).digest('hex'),
    archiveBytes: inspection.metrics.archiveBytes,
    rawEntryCount: inspection.metrics.rawEntryCount,
    regularBytes: inspection.metrics.regularBytes,
    maxEntryBytes: inspection.metrics.maxEntryBytes,
    decompressedBytes: inspection.metrics.decompressedBytes,
    manifestSha256: inspection.manifestSha256,
  };
  const extractionRoot = path.join(root, 'staging');
  const destination = path.join(root, 'runtime-python');

  const publishedInspection = await extractSingleRoot({
    archive,
    extractionRoot,
    destination,
    contract,
  });

  assert.equal(publishedInspection.manifestSha256, inspection.manifestSha256);
  assert.equal(await fs.promises.readFile(path.join(destination, 'bin/python'), 'utf8'), 'ok');
  assert.equal(fs.existsSync(extractionRoot), false);
});

test('locked extraction uses one private snapshot across inspection and extraction', async (t) => {
  const { extractSingleRoot } = await import('../build-portable-runtime.mjs');
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archive = path.join(root, 'python.tar.gz');
  const extractionRoot = path.join(root, 'staging');
  const destination = path.join(root, 'runtime-python');
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const { spawnSync } = await import('node:child_process');
  const generated = spawnSync(python, ['-c', [
    'import io, sys, tarfile',
    'with tarfile.open(sys.argv[1], "w:gz", format=tarfile.USTAR_FORMAT) as output:',
    '    entry = tarfile.TarInfo("python/bin/python")',
    '    entry.mode = 0o755',
    '    entry.size = 2',
    '    output.addfile(entry, io.BytesIO(b"ok"))',
  ].join('\n'), archive], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const inspection = await inspectLockedArchive({
    archivePath: archive,
    format: 'ustar-gzip',
    expectedRoot: 'python',
  });
  const originalMkdir = fs.promises.mkdir;
  let mutated = false;
  fs.promises.mkdir = async (directory, options) => {
    const result = await originalMkdir(directory, options);
    if (!mutated && path.resolve(directory) === path.resolve(extractionRoot)) {
      mutated = true;
      await fs.promises.writeFile(archive, 'mutated after preflight');
    }
    return result;
  };
  try {
    await extractSingleRoot({
      archive,
      extractionRoot,
      destination,
      contract: {
        format: inspection.format,
        root: inspection.expectedRoot,
        sha256: createHash('sha256').update(await fs.promises.readFile(archive)).digest('hex'),
        archiveBytes: inspection.metrics.archiveBytes,
        rawEntryCount: inspection.metrics.rawEntryCount,
        regularBytes: inspection.metrics.regularBytes,
        maxEntryBytes: inspection.metrics.maxEntryBytes,
        decompressedBytes: inspection.metrics.decompressedBytes,
        manifestSha256: inspection.manifestSha256,
      },
    });
  } finally {
    fs.promises.mkdir = originalMkdir;
  }

  assert.equal(mutated, true);
  assert.equal(await fs.promises.readFile(path.join(destination, 'bin/python'), 'utf8'), 'ok');
});

test('locked extraction rolls back a published destination if final staging cleanup fails', async (t) => {
  const { extractSingleRoot } = await import('../build-portable-runtime.mjs');
  const { inspectLockedArchive } = await import('../lib/archive-preflight.mjs');
  const root = await makeTempDir(t);
  const archive = path.join(root, 'python.tar.gz');
  const extractionRoot = path.join(root, 'staging');
  const destination = path.join(root, 'runtime-python');
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const { spawnSync } = await import('node:child_process');
  const generated = spawnSync(python, ['-c', [
    'import io, sys, tarfile',
    'with tarfile.open(sys.argv[1], "w:gz", format=tarfile.USTAR_FORMAT) as output:',
    '    entry = tarfile.TarInfo("python/bin/python")',
    '    entry.mode = 0o755',
    '    entry.size = 2',
    '    output.addfile(entry, io.BytesIO(b"ok"))',
  ].join('\n'), archive], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const inspection = await inspectLockedArchive({
    archivePath: archive,
    format: 'ustar-gzip',
    expectedRoot: 'python',
  });
  const contract = {
    format: inspection.format,
    root: inspection.expectedRoot,
    sha256: createHash('sha256').update(await fs.promises.readFile(archive)).digest('hex'),
    archiveBytes: inspection.metrics.archiveBytes,
    rawEntryCount: inspection.metrics.rawEntryCount,
    regularBytes: inspection.metrics.regularBytes,
    maxEntryBytes: inspection.metrics.maxEntryBytes,
    decompressedBytes: inspection.metrics.decompressedBytes,
    manifestSha256: inspection.manifestSha256,
  };
  const originalRmdir = fs.promises.rmdir;
  let injected = false;
  fs.promises.rmdir = async (directory, options) => {
    if (!injected && path.resolve(directory) === path.resolve(extractionRoot)) {
      injected = true;
      const error = new Error('forced post-publication cleanup failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRmdir(directory, options);
  };
  try {
    await assert.rejects(
      extractSingleRoot({ archive, extractionRoot, destination, contract }),
      /forced post-publication cleanup failure/i,
    );
  } finally {
    fs.promises.rmdir = originalRmdir;
  }

  assert.equal(injected, true);
  assert.equal(fs.existsSync(destination), false);
  assert.equal(fs.existsSync(extractionRoot), false);
});

test('uv lock preflight rejects a stale pyproject before creating output', async (t) => {
  const { assertUvLockCurrent, buildPortableRuntime } = await import('../build-portable-runtime.mjs');
  const fixture = await makeTempDir(t);
  await fs.promises.copyFile('uv.lock', path.join(fixture, 'uv.lock'));
  const rootPyproject = (await fs.promises.readFile('pyproject.toml', 'utf8'))
    .replace('hatchling==1.31.0', 'hatchling==1.30.0');
  await fs.promises.writeFile(path.join(fixture, 'pyproject.toml'), rootPyproject);
  for (const project of BUILD_PROJECTS) {
    const destination = path.join(fixture, project);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.copyFile(project, destination);
  }

  await assert.rejects(
    assertUvLockCurrent(fixture),
    { code: 'UV_LOCK_STALE' },
  );
  const outDir = path.join(fixture, 'output', 'runtime');
  await assert.rejects(
    buildPortableRuntime({ platform: 'macos-arm64', outDir, repoRoot: fixture }),
    { code: 'UV_LOCK_STALE' },
  );
  assert.equal(fs.existsSync(outDir), false);
  assert.equal(fs.existsSync(path.dirname(outDir)), false);
});

test('Claude CLI payload requires the locked package, binary hash, mode, and version', async (t) => {
  const { assertClaudeCliPayload } = await import('../build-portable-runtime.mjs');
  const root = await makeTempDir(t);
  const repoRoot = path.join(root, 'repo');
  const runtimeRoot = path.join(root, 'runtime');
  const packageName = '@vendor/claude-cli-darwin-arm64';
  const packageRoot = path.join(runtimeRoot, 'node/sidecar/node_modules', packageName);
  const sdkRoot = path.join(runtimeRoot, 'node/sidecar/node_modules/@anthropic-ai/claude-agent-sdk');
  const binary = path.join(packageRoot, 'claude');
  const script = '#!/bin/sh\nprintf "2.1.174 (Claude Code)\\n"\n';
  await fs.promises.mkdir(packageRoot, { recursive: true });
  await fs.promises.writeFile(binary, script, { mode: 0o755 });
  await fs.promises.writeFile(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: packageName, version: '0.3.174' })}\n`,
  );
  await fs.promises.mkdir(sdkRoot, { recursive: true });
  await fs.promises.writeFile(
    path.join(sdkRoot, 'package.json'),
    `${JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: '0.3.174' })}\n`,
  );
  await fs.promises.mkdir(path.join(repoRoot, 'plugin/sidecar'), { recursive: true });
  await fs.promises.writeFile(
    path.join(repoRoot, 'plugin/sidecar/package-lock.json'),
    `${JSON.stringify({
      packages: {
        'node_modules/@anthropic-ai/claude-agent-sdk': {
          version: '0.3.174',
          optionalDependencies: { [packageName]: '0.3.174' },
        },
        [`node_modules/${packageName}`]: { version: '0.3.174', optional: true },
      },
    })}\n`,
  );
  const runtimeLock = {
    claudeCli: {
      version: '2.1.174',
      sdkVersion: '0.3.174',
      assets: {
        'macos-arm64': {
          package: packageName,
          binary: 'claude',
          mode: '0755',
          sha256: createHash('sha256').update(script).digest('hex'),
        },
      },
    },
  };

  assert.equal(
    await assertClaudeCliPayload({ platform: 'macos-arm64', repoRoot, runtimeRoot, runtimeLock }),
    '2.1.174 (Claude Code)',
  );
  runtimeLock.claudeCli.assets['macos-arm64'].sha256 = '0'.repeat(64);
  await assert.rejects(
    assertClaudeCliPayload({ platform: 'macos-arm64', repoRoot, runtimeRoot, runtimeLock }),
    /Claude CLI.*SHA-256/i,
  );
  await fs.promises.rm(packageRoot, { recursive: true, force: true });
  await assert.rejects(
    assertClaudeCliPayload({ platform: 'macos-arm64', repoRoot, runtimeRoot, runtimeLock }),
    /required Claude CLI package.*missing/i,
  );
});

test('portable runtime copies the reviewed sidecar entrypoints beside its locked dependencies', async (t) => {
  const { copySidecarEntrypoints } = await import('../build-portable-runtime.mjs');
  const root = await makeTempDir(t);
  const repoRoot = path.join(root, 'repo');
  const runtimeRoot = path.join(root, 'runtime');
  const sourceRoot = path.join(repoRoot, 'plugin/sidecar');
  const destinationRoot = path.join(runtimeRoot, 'node/sidecar');
  await fs.promises.mkdir(sourceRoot, { recursive: true });
  await fs.promises.mkdir(path.join(destinationRoot, 'node_modules'), { recursive: true });
  await fs.promises.writeFile(path.join(sourceRoot, 'agent-sidecar.mjs'), 'export const agent = true;\n');
  await fs.promises.writeFile(path.join(sourceRoot, 'lib.mjs'), 'export const library = true;\n');

  await copySidecarEntrypoints({ repoRoot, runtimeRoot });

  assert.equal(
    await fs.promises.readFile(path.join(destinationRoot, 'agent-sidecar.mjs'), 'utf8'),
    'export const agent = true;\n',
  );
  assert.equal(
    await fs.promises.readFile(path.join(destinationRoot, 'lib.mjs'), 'utf8'),
    'export const library = true;\n',
  );
  assert.equal(fs.existsSync(path.join(destinationRoot, 'current')), false);
});

test('portable runtime pruning removes bundled package managers but keeps runtime payloads', async (t) => {
  const { pruneBundledRuntimeTools } = await import('../build-portable-runtime.mjs');
  const runtimeRoot = await makeTempDir(t);
  const removed = [
    'node/lib/node_modules/npm/index.js',
    'node/lib/node_modules/corepack/index.js',
    'node/bin/npm',
    'node/bin/npx',
    'node/bin/corepack',
    'python/bin/pip',
    'python/bin/pip3',
    'python/lib/python3.13/ensurepip/__init__.py',
    'python/lib/python3.13/site-packages/pip/__init__.py',
    'python/lib/python3.13/site-packages/pip-26.1.2.dist-info/METADATA',
    'python/lib/python3.13/site-packages/setuptools/__init__.py',
    'python/lib/python3.13/site-packages/setuptools-80.0.0.dist-info/METADATA',
  ];
  for (const relative of removed) {
    const destination = path.join(runtimeRoot, relative);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, 'remove');
  }
  const retained = [
    'node/bin/node',
    'python/bin/python3.13',
    'python/lib/python3.13/LICENSE.txt',
    'python/lib/python3.13/site-packages/runtime_dependency/__init__.py',
  ];
  for (const relative of retained) {
    const destination = path.join(runtimeRoot, relative);
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.writeFile(destination, 'keep');
  }

  await pruneBundledRuntimeTools({ runtimeRoot, platform: 'macos-arm64' });

  for (const relative of removed) assert.equal(fs.existsSync(path.join(runtimeRoot, relative)), false);
  for (const relative of retained) assert.equal(fs.existsSync(path.join(runtimeRoot, relative)), true);
});

test('portable builder copies a locked Node license notice into the runtime payload', async (t) => {
  const { copyNodeRuntimeLicenseNotices } = await import('../build-portable-runtime.mjs');
  const root = await makeTempDir(t);
  const repoRoot = path.join(root, 'repo');
  const runtimeRoot = path.join(root, 'runtime');
  const notice = Buffer.from('MIT License\n\nCopyright Fixture\n', 'utf8');
  const noticeSha256 = createHash('sha256').update(notice).digest('hex');
  const sourcePath = 'packaging/licenses/node-runtime/fixture-1.0.0-LICENSE.txt';
  const payloadPath = 'licenses/node-runtime/fixture-1.0.0-LICENSE.txt';
  await fs.promises.mkdir(path.join(repoRoot, 'packaging/licenses/node-runtime'), {
    recursive: true,
  });
  await fs.promises.writeFile(path.join(repoRoot, sourcePath), notice);
  await fs.promises.writeFile(
    path.join(repoRoot, 'packaging/node-runtime-bom.json'),
    `${JSON.stringify({
      licenseNotices: [{
        package: 'fixture',
        version: '1.0.0',
        tarball: {
          url: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
          sha256: 'b'.repeat(64),
          bytes: 1,
        },
        archivePath: 'package/LICENSE',
        sourcePath,
        payloadPath,
        sha256: noticeSha256,
      }],
    }, null, 2)}\n`,
  );

  await copyNodeRuntimeLicenseNotices({ repoRoot, runtimeRoot });

  assert.deepEqual(await fs.promises.readFile(path.join(runtimeRoot, payloadPath)), notice);
});

test('portable builder rejects a repository Node notice whose SHA-256 drifted', async (t) => {
  const { copyNodeRuntimeLicenseNotices } = await import('../build-portable-runtime.mjs');
  const root = await makeTempDir(t);
  const repoRoot = path.join(root, 'repo');
  const runtimeRoot = path.join(root, 'runtime');
  const sourcePath = 'packaging/licenses/node-runtime/fixture-1.0.0-LICENSE.txt';
  const payloadPath = 'licenses/node-runtime/fixture-1.0.0-LICENSE.txt';
  await fs.promises.mkdir(path.join(repoRoot, 'packaging/licenses/node-runtime'), {
    recursive: true,
  });
  await fs.promises.writeFile(path.join(repoRoot, sourcePath), 'tampered notice\n');
  await fs.promises.writeFile(
    path.join(repoRoot, 'packaging/node-runtime-bom.json'),
    `${JSON.stringify({
      licenseNotices: [{
        package: 'fixture',
        version: '1.0.0',
        tarball: {
          url: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
          sha256: 'b'.repeat(64),
          bytes: 1,
        },
        archivePath: 'package/LICENSE',
        sourcePath,
        payloadPath,
        sha256: createHash('sha256').update('expected notice\n').digest('hex'),
      }],
    }, null, 2)}\n`,
  );

  await assert.rejects(
    copyNodeRuntimeLicenseNotices({ repoRoot, runtimeRoot }),
    /Node license notice.*SHA-256/i,
  );
  assert.equal(fs.existsSync(path.join(runtimeRoot, payloadPath)), false);
});

test('portable builder rejects a Node notice lock that escapes repository paths', async (t) => {
  const { copyNodeRuntimeLicenseNotices } = await import('../build-portable-runtime.mjs');
  const root = await makeTempDir(t);
  const repoRoot = path.join(root, 'repo');
  const runtimeRoot = path.join(root, 'runtime');
  const outside = path.join(root, 'outside-LICENSE.txt');
  const notice = Buffer.from('outside notice\n', 'utf8');
  await fs.promises.mkdir(path.join(repoRoot, 'packaging'), { recursive: true });
  await fs.promises.writeFile(outside, notice);
  await fs.promises.writeFile(
    path.join(repoRoot, 'packaging/node-runtime-bom.json'),
    `${JSON.stringify({
      licenseNotices: [{
        package: 'fixture',
        version: '1.0.0',
        tarball: {
          url: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
          sha256: 'b'.repeat(64),
          bytes: 1,
        },
        archivePath: 'package/LICENSE',
        sourcePath: '../outside-LICENSE.txt',
        payloadPath: 'licenses/node-runtime/fixture-1.0.0-LICENSE.txt',
        sha256: createHash('sha256').update(notice).digest('hex'),
      }],
    }, null, 2)}\n`,
  );

  await assert.rejects(
    copyNodeRuntimeLicenseNotices({ repoRoot, runtimeRoot }),
    /invalid Node license notice|escapes repository/i,
  );
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'licenses')), false);
});

test('portable builder rejects symlinked Node notice source or destination ancestors', {
  skip: process.platform === 'win32' ? 'Windows symlink creation requires an elevated fixture' : false,
}, async (t) => {
  const { copyNodeRuntimeLicenseNotices } = await import('../build-portable-runtime.mjs');
  const root = await makeTempDir(t);
  const notice = Buffer.from('locked notice\n', 'utf8');
  const sourcePath = 'packaging/licenses/node-runtime/fixture-1.0.0-LICENSE.txt';
  const payloadPath = 'licenses/node-runtime/fixture-1.0.0-LICENSE.txt';

  async function writeBom(repoRoot) {
    await fs.promises.mkdir(path.join(repoRoot, 'packaging'), { recursive: true });
    await fs.promises.writeFile(
      path.join(repoRoot, 'packaging/node-runtime-bom.json'),
      `${JSON.stringify({
        licenseNotices: [{
          package: 'fixture',
          version: '1.0.0',
          tarball: {
            url: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
            integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
            sha256: 'b'.repeat(64),
            bytes: 1,
          },
          archivePath: 'package/LICENSE',
          sourcePath,
          payloadPath,
          sha256: createHash('sha256').update(notice).digest('hex'),
        }],
      }, null, 2)}\n`,
    );
  }

  const sourceRepo = path.join(root, 'source-repo');
  const sourceRuntime = path.join(root, 'source-runtime');
  const outsideSources = path.join(root, 'outside-sources');
  await writeBom(sourceRepo);
  await fs.promises.mkdir(path.join(outsideSources, 'node-runtime'), { recursive: true });
  await fs.promises.writeFile(
    path.join(outsideSources, 'node-runtime/fixture-1.0.0-LICENSE.txt'),
    notice,
  );
  await fs.promises.symlink(outsideSources, path.join(sourceRepo, 'packaging/licenses'));
  await assert.rejects(
    copyNodeRuntimeLicenseNotices({ repoRoot: sourceRepo, runtimeRoot: sourceRuntime }),
    /Node license notice.*symlink.*ancestor/i,
  );
  assert.equal(fs.existsSync(path.join(sourceRuntime, 'licenses')), false);

  const destinationRepo = path.join(root, 'destination-repo');
  const destinationRuntime = path.join(root, 'destination-runtime');
  const outsideDestination = path.join(root, 'outside-destination');
  await writeBom(destinationRepo);
  await fs.promises.mkdir(path.join(destinationRepo, 'packaging/licenses/node-runtime'), {
    recursive: true,
  });
  await fs.promises.writeFile(path.join(destinationRepo, sourcePath), notice);
  await fs.promises.mkdir(destinationRuntime, { recursive: true });
  await fs.promises.mkdir(outsideDestination, { recursive: true });
  await fs.promises.symlink(outsideDestination, path.join(destinationRuntime, 'licenses'));
  await assert.rejects(
    copyNodeRuntimeLicenseNotices({
      repoRoot: destinationRepo,
      runtimeRoot: destinationRuntime,
    }),
    /Node license notice.*symlink.*ancestor/i,
  );
  assert.equal(
    fs.existsSync(path.join(outsideDestination, 'node-runtime/fixture-1.0.0-LICENSE.txt')),
    false,
  );
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
