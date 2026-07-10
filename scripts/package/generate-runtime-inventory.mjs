import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseRuntimeInventoryArgs } from './lib/args.mjs';
import {
  inventoryFiles,
  pathExists,
  readJson,
  sha256Directory,
  sha256File,
  writeJsonAtomically,
} from './lib/files.mjs';

const WORKSPACE_WHEELS = [
  { distribution: 'ae-mcp', prefix: 'ae_mcp-', source: 'workspace:packages/core' },
  { distribution: 'ae-mcp-bridge', prefix: 'ae_mcp_bridge-', source: 'workspace:packages/bridge' },
  {
    distribution: 'ae-mcp-snapshot-mss',
    prefix: 'ae_mcp_snapshot_mss-',
    source: 'workspace:packages/snapshot-mss',
  },
];

function normalizePackageName(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

function parseUvLock(lockText) {
  const packages = new Map();
  const pattern = /\[\[package\]\]\s*\n([\s\S]*?)(?=\n\[\[package\]\]|$)/g;
  for (const match of lockText.matchAll(pattern)) {
    const name = match[1].match(/^name = "([^"]+)"/m)?.[1];
    const version = match[1].match(/^version = "([^"]+)"/m)?.[1];
    if (name && version) packages.set(normalizePackageName(name), { name, version });
  }
  return packages;
}

function parseMetadata(text) {
  const values = new Map();
  let currentKey;
  for (const line of text.split(/\r?\n/)) {
    if (!line) break;
    if (/^[ \t]/.test(line) && currentKey) {
      const currentValues = values.get(currentKey);
      currentValues[currentValues.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    currentKey = line.slice(0, separator);
    const list = values.get(currentKey) ?? [];
    list.push(line.slice(separator + 1).trim());
    values.set(currentKey, list);
  }
  return {
    first(key) {
      return values.get(key)?.[0] ?? '';
    },
    all(key) {
      return values.get(key) ?? [];
    },
  };
}

function classifierLicense(classifiers) {
  for (const classifier of classifiers) {
    if (/MIT License/i.test(classifier)) return 'MIT';
    if (/Python Software Foundation License/i.test(classifier)) return 'PSF-2.0';
    if (/Mozilla Public License 2\.0/i.test(classifier)) return 'MPL-2.0';
    if (/Apache Software License/i.test(classifier)) return 'Apache-2.0';
    if (/BSD License/i.test(classifier)) return 'BSD-3-Clause';
    if (/ISC License/i.test(classifier)) return 'ISC';
  }
  return '';
}

function normalizeLicense(rawLicense, classifiers = []) {
  const classified = classifierLicense(classifiers);
  const raw = Array.isArray(rawLicense)
    ? rawLicense.join(' OR ')
    : typeof rawLicense === 'object' && rawLicense
      ? rawLicense.type ?? ''
      : String(rawLicense ?? '').trim();
  if (!raw || /SEE LICENSE|UNKNOWN|UNLICENSED|All rights reserved/i.test(raw)) {
    return classified || 'UNKNOWN';
  }
  if (/^MIT License$/i.test(raw)) return 'MIT';
  if (/^BSD License$/i.test(raw)) return 'BSD-3-Clause';
  if (/^Apache Software License$/i.test(raw)) return 'Apache-2.0';
  if (raw.length > 160 || raw.includes('\n')) return classified || 'UNKNOWN';
  return raw;
}

async function scanNodeModules(nodeModulesRoot, relativeNodeModules = 'node_modules') {
  if (!(await pathExists(nodeModulesRoot))) return [];
  const packages = [];
  const entries = await fs.promises.readdir(nodeModulesRoot, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

  async function addPackage(packageDir, lockKey) {
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!(await pathExists(packageJsonPath))) return;
    packages.push({ packageDir, lockKey, packageJson: await readJson(packageJsonPath) });
    packages.push(...await scanNodeModules(
      path.join(packageDir, 'node_modules'),
      path.posix.join(lockKey, 'node_modules'),
    ));
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.bin') continue;
    if (entry.name.startsWith('@')) {
      const scopeRoot = path.join(nodeModulesRoot, entry.name);
      const scopedEntries = await fs.promises.readdir(scopeRoot, { withFileTypes: true });
      scopedEntries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
      for (const scoped of scopedEntries) {
        if (!scoped.isDirectory()) continue;
        const packageName = `${entry.name}/${scoped.name}`;
        await addPackage(
          path.join(scopeRoot, scoped.name),
          path.posix.join(relativeNodeModules, packageName),
        );
      }
    } else {
      await addPackage(
        path.join(nodeModulesRoot, entry.name),
        path.posix.join(relativeNodeModules, entry.name),
      );
    }
  }
  return packages;
}

function parseRecordPath(line) {
  if (!line.startsWith('"')) return line.split(',', 1)[0];
  let value = '';
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === '"') {
      if (line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        return value;
      }
    } else {
      value += line[index];
    }
  }
  throw new Error(`invalid Python RECORD line: ${line}`);
}

async function hashPythonDistribution({ distInfo, runtimeRoot, sitePackages }) {
  const recordPath = path.join(distInfo, 'RECORD');
  const lines = (await fs.promises.readFile(recordPath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const recordName = parseRecordPath(line);
    const absolute = path.resolve(sitePackages, recordName.split('/').join(path.sep));
    const relativeToRuntime = path.relative(runtimeRoot, absolute);
    if (relativeToRuntime.startsWith('..') || path.isAbsolute(relativeToRuntime)) {
      throw new Error(`Python RECORD path escapes runtime root: ${recordName}`);
    }
    const stats = await fs.promises.lstat(absolute);
    const digest = stats.isSymbolicLink()
      ? createHash('sha256').update(await fs.promises.readlink(absolute)).digest('hex')
      : await sha256File(absolute);
    entries.push(`${recordName}\0${digest}`);
  }
  entries.sort((left, right) => left.localeCompare(right, 'en'));
  return createHash('sha256').update(`${entries.join('\n')}\n`).digest('hex');
}

async function findSitePackages(runtimeRoot, platform) {
  const candidate = platform === 'windows-x64'
    ? path.join(runtimeRoot, 'python', 'Lib', 'site-packages')
    : path.join(runtimeRoot, 'python', 'lib', 'python3.13', 'site-packages');
  if (!(await pathExists(candidate))) {
    throw new Error(`portable Python site-packages not found: ${candidate}`);
  }
  return candidate;
}

async function loadApprovals(licenseApprovalPath) {
  if (!licenseApprovalPath) return [];
  const document = await readJson(licenseApprovalPath);
  if (document.schemaVersion !== 1 || !Array.isArray(document.approvals)) {
    throw new Error('license approval document must use schemaVersion 1 and an approvals array');
  }
  const required = ['package', 'version', 'sourceSha256', 'licenseRef', 'approvalId'];
  for (const approval of document.approvals) {
    const keys = Object.keys(approval).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...required].sort())) {
      throw new Error(`license approval must contain exactly: ${required.join(', ')}`);
    }
    if (!/^[a-f0-9]{64}$/.test(approval.sourceSha256)) {
      throw new Error(`invalid approval sourceSha256 for ${approval.package}`);
    }
    if (!approval.licenseRef.startsWith('LicenseRef-') || !approval.approvalId) {
      throw new Error(`invalid legal approval for ${approval.package}`);
    }
  }
  return document.approvals;
}

function requireRestrictedApproval({ component, packageName, policy, approvals, usedApprovals }) {
  if (!policy.restrictedLicenseRefs.includes(component.license)) return;
  const candidates = approvals.filter((approval) => approval.package === packageName);
  const expected = {
    package: packageName,
    version: component.version,
    sourceSha256: component.sha256,
    licenseRef: component.license,
  };
  const exact = candidates.find((approval) => (
    approval.version === expected.version
    && approval.sourceSha256 === expected.sourceSha256
    && approval.licenseRef === expected.licenseRef
  ));
  if (!exact) {
    if (candidates.length === 0) {
      throw new Error(`redistribution approval required for restricted package ${packageName}`);
    }
    const candidate = candidates[0];
    const mismatches = ['version', 'sourceSha256', 'licenseRef']
      .filter((field) => candidate[field] !== expected[field]);
    throw new Error(
      `approval does not match restricted package ${packageName}: ${mismatches.join(', ')}`,
    );
  }
  usedApprovals.set(`${exact.package}\0${exact.approvalId}`, exact);
}

function componentLicense({ componentName, rawLicense, classifiers, policy }) {
  const classified = policy.classifications[componentName]
    ?? normalizeLicense(rawLicense, classifiers);
  if (!classified || policy.forbidden.includes(classified)) {
    throw new Error(`forbidden or UNKNOWN license for ${componentName}`);
  }
  return classified;
}

async function npmComponents({ repoRoot, runtimeRoot, policy, approvals, usedApprovals }) {
  const components = [];
  for (const target of ['host', 'sidecar']) {
    const relativeLock = `plugin/${target}/package-lock.json`;
    const lock = await readJson(path.join(repoRoot, relativeLock));
    const installed = await scanNodeModules(
      path.join(runtimeRoot, 'node', target, 'node_modules'),
    );
    for (const item of installed) {
      const locked = lock.packages?.[item.lockKey];
      if (!locked) {
        throw new Error(`${item.packageJson.name} is not present in ${relativeLock}`);
      }
      if (item.packageJson.version !== locked.version) {
        throw new Error(
          `${item.packageJson.name} version ${item.packageJson.version} does not match ${relativeLock}`,
        );
      }
      const name = `npm:${item.packageJson.name}`;
      const component = {
        name,
        version: locked.version,
        license: componentLicense({
          componentName: name,
          rawLicense: item.packageJson.license ?? locked.license,
          policy,
        }),
        source: locked.integrity
          ? `${locked.resolved ?? `package-lock:${item.lockKey}`}#${locked.integrity}`
          : locked.resolved ?? `package-lock:${item.lockKey}`,
        sha256: await sha256Directory(item.packageDir, {
          excludeDirectoryNames: ['node_modules'],
        }),
      };
      requireRestrictedApproval({
        component,
        packageName: item.packageJson.name,
        policy,
        approvals,
        usedApprovals,
      });
      components.push(component);
    }
  }
  return components;
}

async function pythonComponents({ repoRoot, runtimeRoot, platform, policy }) {
  const uvPackages = parseUvLock(await fs.promises.readFile(path.join(repoRoot, 'uv.lock'), 'utf8'));
  const sitePackages = await findSitePackages(runtimeRoot, platform);
  const components = [];
  const entries = await fs.promises.readdir(sitePackages, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.dist-info')) continue;
    const distInfo = path.join(sitePackages, entry.name);
    const metadata = parseMetadata(await fs.promises.readFile(path.join(distInfo, 'METADATA'), 'utf8'));
    const packageName = metadata.first('Name');
    const version = metadata.first('Version');
    const locked = uvPackages.get(normalizePackageName(packageName));
    if (!locked || locked.version !== version) {
      throw new Error(`Python package ${packageName}==${version} is not present in frozen uv.lock`);
    }
    const name = `python:${packageName}`;
    components.push({
      name,
      version,
      license: componentLicense({
        componentName: name,
        rawLicense: metadata.first('License-Expression') || metadata.first('License'),
        classifiers: metadata.all('Classifier'),
        policy,
      }),
      source: `uv.lock:${locked.name}==${locked.version}`,
      sha256: await hashPythonDistribution({ distInfo, runtimeRoot, sitePackages }),
    });
  }
  return components;
}

async function workspaceWheelComponents({ runtimeRoot, policy }) {
  const wheelRoot = path.join(runtimeRoot, 'wheels');
  const wheelFiles = await fs.promises.readdir(wheelRoot);
  const components = [];
  for (const expected of WORKSPACE_WHEELS) {
    const matching = wheelFiles.filter((name) => (
      name.startsWith(expected.prefix) && name.endsWith('-py3-none-any.whl')
    ));
    if (matching.length !== 1) {
      throw new Error(`expected exactly one ${expected.distribution} workspace wheel`);
    }
    const wheelName = matching[0];
    const version = wheelName.slice(
      expected.prefix.length,
      -'-py3-none-any.whl'.length,
    );
    const componentName = `wheel:${expected.distribution}`;
    components.push({
      name: componentName,
      version,
      license: componentLicense({
        componentName: `python:${expected.distribution}`,
        rawLicense: 'MIT',
        policy,
      }),
      source: expected.source,
      sha256: await sha256File(path.join(wheelRoot, wheelName)),
    });
  }
  return components;
}

function sortComponents(components) {
  return components.sort((left, right) => (
    `${left.name}\0${left.version}\0${left.source}`
      .localeCompare(`${right.name}\0${right.version}\0${right.source}`, 'en')
  ));
}

export async function generateRuntimeInventory({
  platform,
  runtimeRoot,
  repoRoot,
  licenseApprovalPath,
}) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const supportMatrix = await readJson(path.join(resolvedRepoRoot, 'packaging/support-matrix.json'));
  if (!supportMatrix.platforms?.[platform]) throw new Error(`unsupported platform: ${platform}`);
  const runtimeLock = await readJson(path.join(resolvedRepoRoot, 'packaging/runtime-lock.json'));
  const policy = await readJson(path.join(resolvedRepoRoot, 'packaging/license-policy.json'));
  if (
    policy.schemaVersion !== 1
    || !Array.isArray(policy.forbidden)
    || !Array.isArray(policy.restrictedLicenseRefs)
    || typeof policy.classifications !== 'object'
  ) {
    throw new Error('invalid license policy');
  }
  const approvals = await loadApprovals(licenseApprovalPath);
  const usedApprovals = new Map();
  const nodeAsset = runtimeLock.node.assets[platform];
  const pythonAsset = runtimeLock.python.assets[platform];
  if (!nodeAsset || !pythonAsset) throw new Error(`runtime lock does not contain ${platform}`);

  const components = [
    {
      name: 'runtime:node',
      version: runtimeLock.node.version,
      license: 'MIT',
      source: nodeAsset.url,
      sha256: nodeAsset.sha256,
    },
    {
      name: 'runtime:cpython',
      version: runtimeLock.python.version,
      license: 'Python-2.0',
      source: pythonAsset.url,
      sha256: pythonAsset.sha256,
    },
    ...await npmComponents({
      repoRoot: resolvedRepoRoot,
      runtimeRoot: resolvedRuntimeRoot,
      policy,
      approvals,
      usedApprovals,
    }),
    ...await pythonComponents({
      repoRoot: resolvedRepoRoot,
      runtimeRoot: resolvedRuntimeRoot,
      platform,
      policy,
    }),
    ...await workspaceWheelComponents({ runtimeRoot: resolvedRuntimeRoot, policy }),
  ];

  const manifest = {
    schemaVersion: 1,
    platform,
    node: {
      version: runtimeLock.node.version,
      assetSha256: nodeAsset.sha256,
    },
    python: {
      version: runtimeLock.python.version,
      distributionRelease: runtimeLock.python.distributionRelease,
      assetSha256: pythonAsset.sha256,
    },
    licenseApprovals: [...usedApprovals.values()].sort((left, right) => (
      `${left.package}\0${left.approvalId}`.localeCompare(
        `${right.package}\0${right.approvalId}`,
        'en',
      )
    )),
    components: sortComponents(components),
    files: await inventoryFiles(resolvedRuntimeRoot, {
      omitRelativePaths: ['runtime-manifest.json'],
    }),
  };
  await writeJsonAtomically(path.join(resolvedRuntimeRoot, 'runtime-manifest.json'), manifest);
  return manifest;
}

async function main() {
  const input = parseRuntimeInventoryArgs(process.argv.slice(2));
  const manifest = await generateRuntimeInventory(input);
  process.stdout.write(`${path.join(path.resolve(input.runtimeRoot), 'runtime-manifest.json')}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
