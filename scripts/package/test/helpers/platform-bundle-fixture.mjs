import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson } from '../../lib/manifest.mjs';

export const SOURCE_COMMIT_SHA = '0123456789abcdef0123456789abcdef01234567';
export const PRODUCT_VERSION = '0.10.2';

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(filePath) {
  return sha256Bytes(await fs.promises.readFile(filePath));
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
    children.sort((left, right) => Buffer.compare(
      Buffer.from(left.name, 'utf8'),
      Buffer.from(right.name, 'utf8'),
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
    '<ExtensionManifest ExtensionBundleId="com.aemcp.panel" ExtensionBundleVersion="0.10.2">',
    '  <ExtensionList><Extension Id="com.aemcp.panel" Version="0.10.2" /></ExtensionList>',
    '  <ExecutionEnvironment><HostList><Host Name="AEFT" Version="[23.0,26.9]" />',
    '  </HostList></ExecutionEnvironment>',
    '</ExtensionManifest>',
    '',
  ].join('\n'));
  await writeFixtureFile(plugin, 'client/index.html', '<main id="root"></main>\n');
  await writeFixtureFile(plugin, 'client/dist/app.js', 'globalThis.AE_MCP_FIXTURE = true;\n');
  await writeFixtureFile(plugin, 'host/server.js', 'export const fixture = true;\n');
  await writeFixtureFile(plugin, 'host/stdio-shim.js', 'export const fixtureShim = true;\n');
  await writeFixtureFile(plugin, 'host/package.json', `${JSON.stringify({
    name: 'ae-mcp-host',
    version: PRODUCT_VERSION,
    dependencies: { express: '4.22.2' },
  })}\n`);
  await writeFixtureFile(plugin, 'host/package-lock.json', `${JSON.stringify({
    name: 'ae-mcp-host',
    version: PRODUCT_VERSION,
    lockfileVersion: 3,
    packages: {
      '': { name: 'ae-mcp-host', version: PRODUCT_VERSION, dependencies: { express: '4.22.2' } },
      'node_modules/express': { name: 'express', version: '4.22.2' },
    },
  })}\n`);
  await writeFixtureFile(plugin, 'host/node_modules/express/package.json', `${JSON.stringify({
    name: 'express',
    version: '4.22.2',
    main: 'index.js',
  })}\n`);
  await writeFixtureFile(plugin, 'host/node_modules/express/index.js', 'module.exports = () => {};\n');
  await writeFixtureFile(plugin, 'host/mcp/generated/native_exec.generated.json', '{}\n');
  await writeFixtureFile(plugin, 'host/mcp/generated/aegp-rpc.schema.json', '{}\n');
  await writeFixtureFile(plugin, 'host/mcp/skills_bundled/manifest.json', '{}\n');
  await writeFixtureFile(plugin, 'host/mcp/skills_bundled/fixture.json', '{}\n');
  await writeFixtureFile(plugin, 'jsx/runtime.jsx', '// fixture\n');
  await writeFixtureFile(plugin, 'icons/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
  await writeFixtureFile(plugin, 'shared/chat-attachments.mjs', 'export const fixture = true;\n');
  await writeFixtureFile(plugin, 'shared/tool-approval.mjs', 'export const fixture = true;\n');
}

async function writePackaging(repoRoot) {
  await writeFixtureFile(repoRoot, 'packaging/support-matrix.json', `${JSON.stringify({
    schemaVersion: 1,
    platforms: {
      'macos-arm64': { minOsVersion: '14.0', arch: 'arm64', rosetta: false },
      'windows-x64': { minOsVersion: '11.0.26100', arch: 'x64' },
    },
    afterEffects: { majors: [23, 24, 25, 26], manifestRange: '[23.0,26.9]' },
  }, null, 2)}\n`);
}

export async function makeStageHarness(t, platform = 'macos-arm64', overrides = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-platform-stage-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const outDir = path.join(root, 'stage');
  await fs.promises.mkdir(repoRoot, { recursive: true });
  await writePlugin(repoRoot);
  await writePackaging(repoRoot);
  const input = {
    platform,
    version: PRODUCT_VERSION,
    outDir,
    repoRoot,
    sourceCommitSha: SOURCE_COMMIT_SHA,
    verificationProfile: 'release-audit',
    ...overrides,
  };
  return {
    root,
    repoRoot,
    outDir,
    input,
    verifyInput: {
      root: outDir,
      platform,
      version: PRODUCT_VERSION,
      verificationProfile: 'release-audit',
      candidateRepoRoot: repoRoot,
    },
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

export async function inventoryFixtureTree(root, omitted = new Set()) {
  return inventory(root, omitted);
}

export async function rewriteStageManifests(h) {
  const bundleManifestPath = path.join(h.outDir, 'bundle-manifest.json');
  const bundleManifest = JSON.parse(await fs.promises.readFile(bundleManifestPath, 'utf8'));
  bundleManifest.files = await inventory(h.outDir, new Set(['bundle-manifest.json']));
  await fs.promises.writeFile(bundleManifestPath, canonicalJson(bundleManifest));
}
