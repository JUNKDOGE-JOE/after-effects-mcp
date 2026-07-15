import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson } from '../../lib/manifest.mjs';
import { buildLicenseInventory, buildRuntimeSpdx } from '../../lib/runtime-evidence.mjs';

export const SOURCE_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
export const PRODUCT_VERSION = '0.9.2';

const NATIVE_PLUGIN_ROOT = 'artifacts/native-plugin/macos-arm64';
const NATIVE_PLUGIN_MANIFEST = `${NATIVE_PLUGIN_ROOT}/native-plugin-manifest.json`;
const NATIVE_PLUGIN_PAYLOAD = `${NATIVE_PLUGIN_ROOT}/payload`;
const NATIVE_PLUGIN_RECEIPT = `${NATIVE_PLUGIN_PAYLOAD}/build-receipt.json`;
const NATIVE_PLUGIN_BUNDLE = `${NATIVE_PLUGIN_PAYLOAD}/AeMcpNative.plugin`;
const NATIVE_EXECUTABLE = `${NATIVE_PLUGIN_BUNDLE}/Contents/MacOS/AeMcpNative`;

const FIXTURE_PROTOCOL = canonicalJson({
  schemaVersion: 1,
  title: 'Synthetic AEGP RPC fixture',
});

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(filePath) {
  return sha256Bytes(await fs.promises.readFile(filePath));
}

export function machoArm64Bytes() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(2, 12);
  return bytes;
}

export function machoX64Bytes() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x01000007, 4);
  bytes.writeUInt32LE(0, 8);
  bytes.writeUInt32LE(2, 12);
  return bytes;
}

export function peX64Bytes() {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'binary');
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

export async function writeFixtureFile(root, relative, contents, mode = 0o644) {
  const destination = path.join(root, ...relative.split('/'));
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  await fs.promises.writeFile(destination, contents, { mode });
  if (process.platform !== 'win32') await fs.promises.chmod(destination, mode);
  return destination;
}

async function inventory(root, omitted = new Set()) {
  const rows = [];
  async function visit(directory, prefix = '') {
    const children = await fs.promises.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => (
      Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8'))
    ));
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      if (omitted.has(relative)) continue;
      const absolute = path.join(directory, child.name);
      const stats = await fs.promises.lstat(absolute);
      if (stats.isDirectory()) {
        await visit(absolute, relative);
      } else if (stats.isSymbolicLink()) {
        const target = await fs.promises.readlink(absolute);
        const bytes = Buffer.from(target, 'utf8');
        rows.push({
          path: relative,
          sha256: sha256Bytes(bytes),
          size: bytes.length,
          mode: (stats.mode & 0o777).toString(8).padStart(4, '0'),
          type: 'symlink',
          linkTarget: target,
        });
      } else if (stats.isFile()) {
        rows.push({
          path: relative,
          sha256: await sha256File(absolute),
          size: stats.size,
          mode: (stats.mode & 0o777).toString(8).padStart(4, '0'),
          type: 'file',
        });
      }
    }
  }
  await visit(root);
  return rows;
}

async function writePlugin(repoRoot) {
  const plugin = path.join(repoRoot, 'plugin');
  await writeFixtureFile(plugin, 'CSXS/manifest.xml', [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ExtensionManifest ExtensionBundleId="com.aemcp.panel" ExtensionBundleVersion="0.9.2">',
    '  <ExtensionList><Extension Id="com.aemcp.panel" Version="0.9.2" /></ExtensionList>',
    '  <ExecutionEnvironment><HostList><Host Name="AEFT" Version="[25.0,26.9]" /></HostList></ExecutionEnvironment>',
    '</ExtensionManifest>',
    '',
  ].join('\n'));
  await writeFixtureFile(plugin, 'client/index.html', '<main id="root"></main>\n');
  await writeFixtureFile(plugin, 'client/dist/app.js', 'globalThis.AE_MCP_FIXTURE = true;\n');
  await writeFixtureFile(plugin, 'host/server.js', 'export const fixture = true;\n');
  await writeFixtureFile(plugin, 'host/server.test.js', 'throw new Error("development only");\n');
  await writeFixtureFile(plugin, 'host/node_modules/dev-only/index.js', 'development only\n');
  await writeFixtureFile(plugin, 'sidecar/agent-sidecar.mjs', 'export const fixture = true;\n');
  await writeFixtureFile(plugin, 'sidecar/test/fixture.test.mjs', 'throw new Error("development only");\n');
  await writeFixtureFile(plugin, 'sidecar/node_modules/dev-only/index.js', 'development only\n');
  await writeFixtureFile(plugin, 'jsx/runtime.jsx', '// fixture\n');
  await writeFixtureFile(plugin, 'icons/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  await writeFixtureFile(plugin, 'panel/src/main.jsx', 'throw new Error("source only");\n');
  await writeFixtureFile(plugin, '.debug', '.debug-port=9080\n');
}

async function writeRuntime(repoRoot, platform) {
  const root = path.join(repoRoot, 'build', 'runtime', platform);
  const nativeBytes = platform === 'macos-arm64' ? machoArm64Bytes() : peX64Bytes();
  if (platform === 'macos-arm64') {
    await writeFixtureFile(root, 'node/bin/node', nativeBytes, 0o755);
    await writeFixtureFile(root, 'python/bin/python3.13', nativeBytes, 0o755);
    await fs.promises.symlink('python3.13', path.join(root, 'python', 'bin', 'python3'));
  } else {
    await writeFixtureFile(root, 'node/node.exe', nativeBytes, 0o644);
    await writeFixtureFile(root, 'python/python.exe', nativeBytes, 0o644);
  }
  await writeFixtureFile(root, 'node/host/package.json', `${JSON.stringify({
    name: 'ae-mcp-host',
    version: '0.9.2',
    dependencies: { express: '4.22.1' },
  })}\n`);
  await writeFixtureFile(root, 'node/host/package-lock.json', '{}\n');
  await writeFixtureFile(root, 'node/host/node_modules/express/package.json', `${JSON.stringify({
    name: 'express',
    version: '4.22.1',
    main: 'index.js',
  })}\n`);
  await writeFixtureFile(root, 'node/host/node_modules/express/index.js', 'module.exports = () => {};\n');
  await writeFixtureFile(root, 'node/sidecar/node_modules/sdk/index.js', 'export default {};\n');
  const claudePackage = platform === 'macos-arm64'
    ? '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
    : '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe';
  await writeFixtureFile(
    root,
    `node/sidecar/node_modules/${claudePackage}`,
    nativeBytes,
    platform === 'macos-arm64' ? 0o755 : 0o644,
  );
  await writeFixtureFile(root, 'python/site-packages/ae_mcp/__init__.py', '__version__ = "0.9.2"\n');
  await writeFixtureFile(root, 'licenses/NOTICE.txt', 'fixture license\n');
  const licenseApprovals = [];
  const components = [{
    name: 'fixture',
    version: '1.0.0',
    license: 'MIT',
    source: 'fixture',
    sha256: 'c'.repeat(64),
  }];
  await writeFixtureFile(
    root,
    'sbom.spdx.json',
    canonicalJson(buildRuntimeSpdx({ platform, components })),
  );
  await writeFixtureFile(
    root,
    'license-inventory.json',
    canonicalJson(buildLicenseInventory({ platform, components, licenseApprovals })),
  );
  const files = (await inventory(root)).map(({ linkTarget: _linkTarget, ...entry }) => entry);
  await writeFixtureFile(root, 'runtime-manifest.json', `${JSON.stringify({
    schemaVersion: 1,
    platform,
    node: { version: '24.17.0', assetSha256: 'a'.repeat(64) },
    python: {
      version: '3.13.14', distributionRelease: '20260610', assetSha256: 'b'.repeat(64),
    },
    licenseApprovals,
    components,
    files,
  }, null, 2)}\n`);
  return root;
}

async function writeHelper(repoRoot, platform) {
  const root = path.join(repoRoot, 'build', 'helper', platform);
  const nativeBytes = platform === 'macos-arm64' ? machoArm64Bytes() : peX64Bytes();
  const definitions = platform === 'macos-arm64'
    ? [
      {
        path: 'bin/ae-mcp-platform-helper', architecture: 'macho-arm64',
        bytes: nativeBytes, mode: 0o755,
      },
      {
        path: 'bin/ae-mcp', architecture: 'script',
        bytes: Buffer.from('#!/bin/sh\nexit 0\n', 'utf8'), mode: 0o755,
      },
    ]
    : [
      {
        path: 'bin/ae-mcp-platform-helper.exe', architecture: 'pe-x64',
        bytes: nativeBytes, mode: 0o644,
      },
      { path: 'bin/ae-mcp.exe', architecture: 'pe-x64', bytes: nativeBytes, mode: 0o644 },
    ];
  for (const definition of definitions) {
    await writeFixtureFile(root, definition.path, definition.bytes, definition.mode);
  }
  await writeFixtureFile(root, 'helper-manifest.json', `${JSON.stringify({
    schemaVersion: 1,
    platform,
    helperId: 'com.junkdoge.ae-mcp.platform-helper',
    entrypoints: {
      helper: definitions[0].path,
      launcher: definitions[1].path,
    },
    files: await Promise.all(definitions.map(async ({ path: relative, architecture }) => ({
      path: relative,
      architecture,
      sha256: await sha256File(path.join(root, ...relative.split('/'))),
    }))),
  }, null, 2)}\n`);
  return root;
}

async function writePackaging(repoRoot) {
  await writeFixtureFile(repoRoot, 'packaging/support-matrix.json', `${JSON.stringify({
    schemaVersion: 1,
    platforms: {
      'macos-arm64': { minOsVersion: '14.0', arch: 'arm64', rosetta: false },
      'windows-x64': { minOsVersion: '11.0.26100', arch: 'x64' },
    },
    afterEffects: { majors: [25, 26], manifestRange: '[25.0,26.9]' },
  }, null, 2)}\n`);
  await writeFixtureFile(
    repoRoot,
    'packages/core/ae_mcp/skills_bundled/fixture.json',
    '{"name":"fixture-tool"}\n',
  );
  await writeFixtureFile(
    repoRoot,
    'packaging/ae-sdk-inputs.json',
    canonicalJson({
      schemaVersion: 1,
      sdk: {
        name: 'Adobe After Effects C/C++ Plug-in SDK',
        claimedVersion: '25.6.61',
        claimedBuild: 61,
        platforms: {
          'macos-arm64': {
            archive: { sha256: 'd'.repeat(64) },
            rootContentLock: {
              status: 'canonical-file-tree-verified',
              sha256: 'e'.repeat(64),
            },
          },
        },
      },
    }),
  );
  await writeFixtureFile(
    repoRoot,
    'native/ae-plugin/protocol/aegp-rpc.schema.json',
    FIXTURE_PROTOCOL,
  );
}

async function writeNativePluginFixture(h) {
  const nativePluginRoot = path.join(h.root, 'native-plugin-build');
  const bundleRoot = path.join(nativePluginRoot, 'AeMcpNative.plugin');
  const executableBytes = Buffer.concat([
    machoArm64Bytes(),
    Buffer.from(`fixture:${SOURCE_COMMIT_SHA}`, 'ascii'),
  ]);
  const piplBytes = Buffer.from(
    'fixture-pipl:16000:AEgx:AeMcpNativeMain:compatibility=65536',
    'ascii',
  );
  const bundleFiles = [
    ['Contents/Info.plist', [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleIdentifier</key><string>dev.aemcp.native-plugin</string>',
      '<key>CFBundleShortVersionString</key><string>0.9.2</string>',
      '<key>CFBundleExecutable</key><string>AeMcpNative</string>',
      '<key>CFBundlePackageType</key><string>AEgx</string>',
      '</dict></plist>',
      '',
    ].join('\n'), 0o644],
    ['Contents/MacOS/AeMcpNative', executableBytes, 0o755],
    ['Contents/PkgInfo', Buffer.from('AEgxFXTC', 'ascii'), 0o644],
    ['Contents/Resources/AeMcpNative.rsrc', piplBytes, 0o644],
    ['Contents/_CodeSignature/CodeResources', 'synthetic ad-hoc signature\n', 0o644],
  ];
  for (const [relative, bytes, mode] of bundleFiles) {
    await writeFixtureFile(bundleRoot, relative, bytes, mode);
  }

  const executableSha256 = sha256Bytes(executableBytes);
  const piplSha256 = sha256Bytes(piplBytes);
  const artifact = {
    schemaVersion: 1,
    bundleName: 'AeMcpNative.plugin',
    platform: 'macos-arm64',
    architecture: 'arm64',
    bundleType: 'AEgx',
    entryPoint: 'AeMcpNativeMain',
    fileCount: 5,
    bundleTreeSha256: sha256Bytes(Buffer.from(canonicalJson(
      bundleFiles.map(([relative, bytes, mode]) => ({
        path: relative,
        sha256: sha256Bytes(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)),
        mode,
      })),
    ), 'utf8')),
    executableSha256,
    piplSha256,
    codeSignature: 'ad-hoc-verified',
  };
  const receipt = {
    schemaVersion: 1,
    productVersion: PRODUCT_VERSION,
    artifact,
    sourceCommit: SOURCE_COMMIT_SHA,
    source: {
      commit: SOURCE_COMMIT_SHA,
      repositoryClean: true,
    },
    protocolSchemaSha256: sha256Bytes(Buffer.from(FIXTURE_PROTOCOL, 'utf8')),
    sdk: {
      name: 'Adobe After Effects C/C++ Plug-in SDK',
      claimedVersion: '25.6.61',
      claimedBuild: 61,
      materialIncluded: false,
      archiveVerification: 'sha256-verified',
      rootVerification: 'layout-and-content-verified',
      inputProvenance: 'archive-byte-identity-plus-canonical-root-content',
    },
    build: {
      configuration: 'development',
      signing: 'ad-hoc',
      distributionApproved: false,
      runtimeEvidence: false,
      compatibilityEvidence: false,
    },
  };
  await writeFixtureFile(
    nativePluginRoot,
    'build-receipt.json',
    `${JSON.stringify(receipt, null, 2)}\n`,
    0o600,
  );

  const verifyMacPlugin = async ({ bundlePath, expectedProductVersion }) => {
    if (path.basename(bundlePath) !== 'AeMcpNative.plugin'
        || expectedProductVersion !== PRODUCT_VERSION
        || await sha256File(path.join(bundlePath, 'Contents/MacOS/AeMcpNative'))
          !== executableSha256
        || await sha256File(path.join(
          bundlePath,
          'Contents/Resources/AeMcpNative.rsrc',
        )) !== piplSha256) {
      const error = new Error('synthetic native verifier rejected the bundle');
      error.code = 'AE_PLUGIN_FIXTURE_INVALID';
      throw error;
    }
    return structuredClone(artifact);
  };

  h.nativePluginRoot = nativePluginRoot;
  h.input.inputs = { ...h.input.inputs, nativePluginRoot };
  h.input.dependencies = { verifyMacPlugin };
  h.verifyInput = {
    ...h.verifyInput,
    candidateRepoRoot: h.repoRoot,
    dependencies: { verifyMacPlugin },
  };
  h.nativePath = (relative = '') => path.join(
    h.outDir,
    ...NATIVE_PLUGIN_ROOT.split('/'),
    ...(relative ? relative.split('/') : []),
  );
  h.nativeManifest = () => JSON.parse(
    fs.readFileSync(path.join(h.outDir, ...NATIVE_PLUGIN_MANIFEST.split('/')), 'utf8'),
  );
  h.mutateNativeReceipt = async (mutate) => {
    const receiptPath = path.join(h.outDir, ...NATIVE_PLUGIN_RECEIPT.split('/'));
    const receipt = JSON.parse(await fs.promises.readFile(receiptPath, 'utf8'));
    mutate(receipt);
    await fs.promises.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const manifestPath = path.join(h.outDir, ...NATIVE_PLUGIN_MANIFEST.split('/'));
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
    manifest.artifact.receiptSha256 = await sha256File(receiptPath);
    await fs.promises.writeFile(manifestPath, canonicalJson(manifest));
    await rewriteStageManifests(h);
  };
  h.nativeExecutablePath = path.join(h.outDir, ...NATIVE_EXECUTABLE.split('/'));
  return h;
}

export async function makeStageHarness(t, platform = 'macos-arm64', overrides = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-platform-stage-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const outDir = path.join(root, 'stage');
  await fs.promises.mkdir(repoRoot, { recursive: true });
  await writePlugin(repoRoot);
  await writePackaging(repoRoot);
  const runtimeRoot = await writeRuntime(repoRoot, platform);
  const helperRoot = await writeHelper(repoRoot, platform);
  const input = {
    platform,
    version: PRODUCT_VERSION,
    outDir,
    repoRoot,
    sourceCommitSha: SOURCE_COMMIT_SHA,
    ...overrides,
  };
  return {
    root,
    repoRoot,
    outDir,
    runtimeRoot,
    helperRoot,
    input,
    verifyInput: { root: outDir, platform, version: PRODUCT_VERSION },
    exists(relative) {
      return fs.existsSync(path.join(outDir, ...relative.split('/')));
    },
    manifest() {
      return JSON.parse(fs.readFileSync(path.join(outDir, 'bundle-manifest.json'), 'utf8'));
    },
    async flipByte(relative) {
      const target = path.join(outDir, ...relative.split('/'));
      const bytes = await fs.promises.readFile(target);
      bytes[bytes.length - 1] ^= 0xff;
      await fs.promises.writeFile(target, bytes);
    },
  };
}

export async function makeNativeStageHarness(t, platform = 'macos-arm64', overrides = {}) {
  return writeNativePluginFixture(await makeStageHarness(t, platform, overrides));
}

export async function inventoryFixtureTree(root, omitted = new Set()) {
  return inventory(root, omitted);
}

export async function rewriteStageManifests(h, { helper = false } = {}) {
  const runtimeRoot = path.join(h.outDir, 'runtime', h.input.platform);
  const runtimeManifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
  const runtimeManifest = JSON.parse(await fs.promises.readFile(runtimeManifestPath, 'utf8'));
  runtimeManifest.files = (await inventory(
    runtimeRoot,
    new Set(['runtime-manifest.json']),
  )).map(({ linkTarget: _linkTarget, ...entry }) => entry);
  await fs.promises.writeFile(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`);

  const helperRoot = path.join(h.outDir, 'platform', h.input.platform);
  const helperManifestPath = path.join(helperRoot, 'helper-manifest.json');
  if (helper) {
    const helperManifest = JSON.parse(await fs.promises.readFile(helperManifestPath, 'utf8'));
    for (const record of helperManifest.files) {
      record.sha256 = await sha256File(path.join(helperRoot, ...record.path.split('/')));
    }
    await fs.promises.writeFile(helperManifestPath, `${JSON.stringify(helperManifest, null, 2)}\n`);
  }

  const bundleManifestPath = path.join(h.outDir, 'bundle-manifest.json');
  const bundleManifest = JSON.parse(await fs.promises.readFile(bundleManifestPath, 'utf8'));
  bundleManifest.runtime.manifestSha256 = await sha256File(runtimeManifestPath);
  bundleManifest.runtime.sbomSha256 = await sha256File(path.join(runtimeRoot, 'sbom.spdx.json'));
  bundleManifest.runtime.licenseInventorySha256 = await sha256File(
    path.join(runtimeRoot, 'license-inventory.json'),
  );
  bundleManifest.helper.manifestSha256 = await sha256File(helperManifestPath);
  if (bundleManifest.nativePlugin) {
    bundleManifest.nativePlugin.manifestSha256 = await sha256File(
      path.join(h.outDir, ...NATIVE_PLUGIN_MANIFEST.split('/')),
    );
  }
  bundleManifest.files = await inventory(h.outDir, new Set(['bundle-manifest.json']));
  await fs.promises.writeFile(bundleManifestPath, canonicalJson(bundleManifest));
}
