import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { parseRuntimeInventoryArgs } from './lib/args.mjs';
import {
  comparePortableUtf8,
  inventoryFiles,
  pathExists,
  readRegularFileSnapshot,
  readJson,
  sha256Directory,
  sha256File,
  writeJsonAtomically,
} from './lib/files.mjs';
import {
  loadPythonStandaloneEvidence,
  verifyPythonStandalonePayloadEvidence,
} from './lib/python-standalone-evidence.mjs';
import { writeRuntimeLicenseArtifacts } from './lib/runtime-license-artifacts.mjs';
import { validateRuntimeManifest } from './lib/runtime-manifest.mjs';

const WORKSPACE_WHEELS = [
  { distribution: 'ae-mcp', prefix: 'ae_mcp-', source: 'workspace:packages/core' },
  { distribution: 'ae-mcp-bridge', prefix: 'ae_mcp_bridge-', source: 'workspace:packages/bridge' },
  {
    distribution: 'ae-mcp-snapshot-mss',
    prefix: 'ae_mcp_snapshot_mss-',
    source: 'workspace:packages/snapshot-mss',
  },
];

const execFileAsync = promisify(execFile);

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
  const known = new Map([
    ['License :: OSI Approved :: Apache Software License', 'Apache-2.0'],
    ['License :: OSI Approved :: ISC License (ISCL)', 'ISC'],
    ['License :: OSI Approved :: MIT License', 'MIT'],
    ['License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)', 'MPL-2.0'],
    ['License :: OSI Approved :: Python Software Foundation License', 'PSF-2.0'],
  ]);
  for (const classifier of classifiers) {
    if (known.has(classifier)) return known.get(classifier);
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
  if (raw === 'MIT License') return 'MIT';
  if (raw === 'Apache Software License') return 'Apache-2.0';
  if (raw.length > 160 || raw.includes('\n')) return classified || 'UNKNOWN';
  return raw;
}

function tokenizeSpdx(expression) {
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    if (/\s/.test(expression[index])) {
      index += 1;
      continue;
    }
    if (expression[index] === '(' || expression[index] === ')') {
      tokens.push(expression[index]);
      index += 1;
      continue;
    }
    const identifier = expression.slice(index).match(/^[A-Za-z0-9][A-Za-z0-9.+-]*/)?.[0];
    if (!identifier) throw new Error(`invalid SPDX expression near: ${expression.slice(index)}`);
    tokens.push(identifier);
    index += identifier.length;
  }
  return tokens;
}

export function assertAllowedLicenseExpression(expression, policy) {
  const value = String(expression ?? '').trim();
  if (!value) throw new Error('invalid SPDX expression: empty license');
  const allowedLicenses = new Set(policy.allowedSpdxLicenses ?? []);
  const allowedExceptions = new Set(policy.allowedSpdxExceptions ?? []);
  const allowedRefs = new Set(policy.allowedLicenseRefs ?? []);
  const restrictedRefs = new Set(policy.restrictedLicenseRefs ?? []);
  const reviewedNonRestrictedRefs = new Set(policy.reviewedNonRestrictedLicenseRefs ?? []);
  for (const licenseRef of allowedRefs) {
    if (!restrictedRefs.has(licenseRef) && !reviewedNonRestrictedRefs.has(licenseRef)) {
      throw new Error(
        `${licenseRef} is neither restricted nor reviewed as non-restricted by license policy`,
      );
    }
  }
  for (const licenseRef of [...restrictedRefs, ...reviewedNonRestrictedRefs]) {
    if (!allowedRefs.has(licenseRef)) {
      throw new Error(`${licenseRef} is not present in allowedLicenseRefs`);
    }
  }
  const tokens = tokenizeSpdx(value);
  let cursor = 0;

  function peek() {
    return tokens[cursor];
  }

  function consume(expected) {
    const token = tokens[cursor];
    if (expected && token !== expected) {
      throw new Error(`invalid SPDX expression: expected ${expected}, received ${token ?? '<end>'}`);
    }
    cursor += 1;
    return token;
  }

  function parsePrimary() {
    if (peek() === '(') {
      consume('(');
      parseOr();
      consume(')');
      return { simpleLicense: false };
    }
    const license = consume();
    if (!license || ['AND', 'OR', 'WITH', ')'].includes(license)) {
      throw new Error(`invalid SPDX expression: expected license, received ${license ?? '<end>'}`);
    }
    if (license.startsWith('LicenseRef-')) {
      if (!allowedRefs.has(license)) throw new Error(`${license} is not allowed by license policy`);
    } else if (!allowedLicenses.has(license)) {
      throw new Error(`${license} is not allowed by license policy`);
    }
    return { simpleLicense: true };
  }

  function parseWith() {
    const primary = parsePrimary();
    if (peek() !== 'WITH') return primary;
    if (!primary.simpleLicense) {
      throw new Error('invalid SPDX expression: WITH must follow a single license');
    }
    consume('WITH');
    const exception = consume();
    if (!exception || ['AND', 'OR', 'WITH', '(', ')'].includes(exception)) {
      throw new Error('invalid SPDX expression: WITH requires an exception identifier');
    }
    if (!allowedExceptions.has(exception)) {
      throw new Error(`${exception} is not allowed by license policy`);
    }
    return { simpleLicense: false };
  }

  function parseAnd() {
    let result = parseWith();
    while (peek() === 'AND') {
      consume('AND');
      parseWith();
      result = { simpleLicense: false };
    }
    return result;
  }

  function parseOr() {
    let result = parseAnd();
    while (peek() === 'OR') {
      consume('OR');
      parseAnd();
      result = { simpleLicense: false };
    }
    return result;
  }

  parseOr();
  if (cursor !== tokens.length) {
    throw new Error(`invalid SPDX expression: unexpected token ${peek()}`);
  }
  return value;
}

function licenseRefsInExpression(expression) {
  return [...new Set(tokenizeSpdx(expression).filter((token) => token.startsWith('LicenseRef-')))];
}

async function scanNodeModules(nodeModulesRoot, relativeNodeModules = 'node_modules') {
  if (!(await pathExists(nodeModulesRoot))) return [];
  const packages = [];
  const entries = await fs.promises.readdir(nodeModulesRoot, { withFileTypes: true });
  entries.sort((left, right) => comparePortableUtf8(left.name, right.name));

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
      scopedEntries.sort((left, right) => comparePortableUtf8(left.name, right.name));
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

function npmPackageNameFromLockKey(lockKey) {
  const segments = lockKey.split('/');
  const nodeModulesIndex = segments.lastIndexOf('node_modules');
  const packageSegments = segments.slice(nodeModulesIndex + 1);
  const expectedLength = packageSegments[0]?.startsWith('@') ? 2 : 1;
  if (nodeModulesIndex < 0 || packageSegments.length !== expectedLength) {
    throw new Error(`invalid npm package-lock path: ${lockKey}`);
  }
  return packageSegments.join('/');
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
  entries.sort(comparePortableUtf8);
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

async function assertBundledRuntimeToolsPruned(runtimeRoot, platform) {
  const nodeRoot = path.join(runtimeRoot, 'node');
  const pythonRoot = path.join(runtimeRoot, 'python');
  const forbiddenNode = platform === 'windows-x64'
    ? ['node_modules/npm', 'node_modules/corepack', 'npm.cmd', 'npx.cmd', 'corepack.cmd']
    : ['lib/node_modules/npm', 'lib/node_modules/corepack', 'bin/npm', 'bin/npx', 'bin/corepack'];
  for (const relative of forbiddenNode) {
    if (await pathExists(path.join(nodeRoot, relative))) {
      throw new Error(`bundled npm/corepack payload must be pruned: node/${relative}`);
    }
  }
  const pythonLib = platform === 'windows-x64'
    ? path.join(pythonRoot, 'Lib')
    : path.join(pythonRoot, 'lib', 'python3.13');
  if (await pathExists(path.join(pythonLib, 'ensurepip'))) {
    throw new Error('bundled pip ensurepip payload must be pruned');
  }
  const sitePackages = await findSitePackages(runtimeRoot, platform);
  const entries = await fs.promises.readdir(sitePackages);
  if (entries.some((name) => name === 'pip' || /^pip-.*\.dist-info$/i.test(name))) {
    throw new Error('bundled pip payload must be pruned from site-packages');
  }
}

function validateApprovalDocument(document, label) {
  if (
    !document
    || typeof document !== 'object'
    || Array.isArray(document)
    || document.schemaVersion !== 1
    || !Array.isArray(document.approvals)
  ) {
    throw new Error(`${label} must use schemaVersion 1 and an approvals array`);
  }
  const required = ['package', 'version', 'sourceSha256', 'licenseRef', 'approvalId'];
  for (const approval of document.approvals) {
    if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
      throw new Error(`${label} approval must be an object`);
    }
    const keys = Object.keys(approval).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...required].sort())) {
      throw new Error(`${label} approval must contain exactly: ${required.join(', ')}`);
    }
    for (const field of required) {
      if (typeof approval[field] !== 'string' || approval[field].trim().length === 0) {
        throw new Error(`${label} approval ${field} must be a non-empty string`);
      }
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

function approvalKey(approval) {
  return JSON.stringify([
    approval.package,
    approval.version,
    approval.sourceSha256,
    approval.licenseRef,
    approval.approvalId,
  ]);
}

export async function loadApprovals(licenseApprovalPath, policy) {
  const trusted = validateApprovalDocument(
    { schemaVersion: 1, approvals: policy.trustedApprovals ?? [] },
    'repository trusted approval allowlist',
  );
  if (!licenseApprovalPath) return [];
  const document = await readJson(licenseApprovalPath);
  const approvals = validateApprovalDocument(document, 'external license approval document');
  const trustedKeys = new Set(trusted.map(approvalKey));
  for (const approval of approvals) {
    if (!trustedKeys.has(approvalKey(approval))) {
      throw new Error(
        `external approval ${approval.approvalId} for ${approval.package} is not trusted by repository allowlist`,
      );
    }
  }
  return approvals;
}

function requireRestrictedApproval({ component, packageName, policy, approvals, usedApprovals }) {
  const restricted = licenseRefsInExpression(component.license)
    .filter((licenseRef) => policy.restrictedLicenseRefs.includes(licenseRef));
  for (const licenseRef of restricted) {
    const candidates = approvals.filter((approval) => approval.package === packageName);
    const expected = {
      package: packageName,
      version: component.version,
      sourceSha256: component.sha256,
      licenseRef,
    };
    const exact = candidates.find((approval) => (
      approval.version === expected.version
      && approval.sourceSha256 === expected.sourceSha256
      && approval.licenseRef === expected.licenseRef
    ));
    if (!exact) {
      if (candidates.length === 0) {
        throw new Error(
          `redistribution approval required for ${licenseRef} on restricted package ${packageName}`,
        );
      }
      const candidate = candidates[0];
      const mismatches = ['version', 'sourceSha256', 'licenseRef']
        .filter((field) => candidate[field] !== expected[field]);
      throw new Error(
        `approval does not match restricted package ${packageName}: ${mismatches.join(', ')}`,
      );
    }
    usedApprovals.set(approvalKey(exact), exact);
  }
}

function componentLicense({ componentName, rawLicense, classifiers, policy }) {
  const classified = policy.classifications[componentName]
    ?? normalizeLicense(rawLicense, classifiers);
  if (!classified || policy.forbidden.includes(classified)) {
    throw new Error(`forbidden or UNKNOWN license for ${componentName}`);
  }
  return assertAllowedLicenseExpression(classified, policy);
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
      const lockedPackageName = npmPackageNameFromLockKey(item.lockKey);
      if (!locked) {
        throw new Error(`${lockedPackageName} is not present in ${relativeLock}`);
      }
      if (item.packageJson.name !== lockedPackageName) {
        throw new Error(
          `npm package identity ${item.packageJson.name ?? '<missing>'} does not match `
          + `${lockedPackageName} from ${relativeLock}`,
        );
      }
      if (item.packageJson.version !== locked.version) {
        throw new Error(
          `${lockedPackageName} version ${item.packageJson.version} does not match ${relativeLock}`,
        );
      }
      const name = `npm:${lockedPackageName}`;
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
      const licenseRefs = licenseRefsInExpression(component.license);
      if (licenseRefs.length > 0) {
        const declaredLicense = item.packageJson.license ?? locked.license;
        const licenseFile = typeof declaredLicense === 'string'
          ? declaredLicense.match(/^SEE LICENSE IN ([A-Za-z0-9._/-]+)$/i)?.[1]
          : undefined;
        if (!licenseFile || licenseFile.split('/').includes('..')) {
          throw new Error(`npm LicenseRef package has no safe reviewed license file: ${name}`);
        }
        const licensePath = path.resolve(item.packageDir, ...licenseFile.split('/'));
        const packageRelative = path.relative(item.packageDir, licensePath);
        if (packageRelative.startsWith('..') || path.isAbsolute(packageRelative)) {
          throw new Error(`npm license file escapes its package: ${name}`);
        }
        let current = item.packageDir;
        for (const segment of packageRelative.split(path.sep)) {
          current = path.join(current, segment);
          const stats = await fs.promises.lstat(current);
          if (stats.isSymbolicLink()) {
            throw new Error(`npm license file traverses a symbolic link: ${name}`);
          }
        }
        const licenseBytes = await readRegularFileSnapshot(licensePath, {
          maxBytes: 1024 * 1024,
        });
        const runtimeRelative = path.relative(runtimeRoot, licensePath);
        if (runtimeRelative.startsWith('..') || path.isAbsolute(runtimeRelative)) {
          throw new Error(`npm license file escapes runtime root: ${name}`);
        }
        component.licenseEvidence = [{
          kind: 'payload-file',
          path: runtimeRelative.split(path.sep).join('/'),
          sha256: createHash('sha256').update(licenseBytes).digest('hex'),
        }];
      }
      requireRestrictedApproval({
        component,
        packageName: lockedPackageName,
        policy,
        approvals,
        usedApprovals,
      });
      components.push(component);
    }
  }
  return components;
}

export async function pythonComponents({
  repoRoot,
  runtimeRoot,
  platform,
  policy,
  approvals,
  usedApprovals,
}) {
  const uvPackages = parseUvLock(await fs.promises.readFile(path.join(repoRoot, 'uv.lock'), 'utf8'));
  const sitePackages = await findSitePackages(runtimeRoot, platform);
  const components = [];
  const entries = await fs.promises.readdir(sitePackages, { withFileTypes: true });
  entries.sort((left, right) => comparePortableUtf8(left.name, right.name));
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
    const component = {
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
    };
    requireRestrictedApproval({
      component,
      packageName,
      policy,
      approvals,
      usedApprovals,
    });
    components.push(component);
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

export function parseNodeLicenseSections(licenseText) {
  const source = String(licenseText);
  const pattern = /^- ([^,\r\n]+), located at ([^,\r\n]+), is licensed as follows:\r?$/gm;
  const matches = [...source.matchAll(pattern)];
  const sections = matches.map((match, index) => ({
    heading: match[1],
    sourceSubpath: match[2],
    text: source.slice(match.index, matches[index + 1]?.index ?? source.length),
  }));
  const keys = sections.map(({ heading, sourceSubpath }) => `${heading}\0${sourceSubpath}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error('Node LICENSE contains duplicate third-party headings');
  }
  return sections;
}

export function parseNodeLicenseHeadings(licenseText) {
  return parseNodeLicenseSections(licenseText).map(({ heading, sourceSubpath }) => ({
    heading,
    sourceSubpath,
  }));
}

function nodeExecutable(runtimeRoot, platform) {
  return platform === 'windows-x64'
    ? path.join(runtimeRoot, 'node', 'node.exe')
    : path.join(runtimeRoot, 'node', 'bin', 'node');
}

async function readNodeProcessVersions(runtimeRoot, platform) {
  const executable = nodeExecutable(runtimeRoot, platform);
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      executable,
      ['-p', 'JSON.stringify(process.versions)'],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000 },
    ));
  } catch (error) {
    throw new Error(`cannot read Node process.versions from ${executable}: ${error.message}`, {
      cause: error,
    });
  }
  let versions;
  try {
    versions = JSON.parse(stdout.trim());
  } catch (error) {
    throw new Error(`Node process.versions output is not JSON: ${stdout.trim()}`, { cause: error });
  }
  if (
    !versions
    || typeof versions !== 'object'
    || Array.isArray(versions)
    || Object.values(versions).some((value) => typeof value !== 'string')
  ) {
    throw new Error('Node process.versions must be an object of strings');
  }
  return versions;
}

function nodeLicenseHeadingKey({ heading, sourceSubpath }) {
  return `${heading}\0${sourceSubpath}`;
}

function assertNodeSourceSubpath(value, label) {
  if (
    typeof value !== 'string'
    || !value
    || value.startsWith('/')
    || value.includes('\\')
    || value.split('/').includes('..')
    || (value !== '.' && !/^[A-Za-z0-9._@+/-]+$/.test(value))
  ) {
    throw new Error(`invalid Node source subpath for ${label}: ${value}`);
  }
}

export function assertNodeLicenseNoticeLock(notice) {
  const expectedFields = [
    'archivePath',
    'package',
    'payloadPath',
    'sha256',
    'sourcePath',
    'tarball',
    'version',
  ].sort();
  const tarballFields = ['bytes', 'integrity', 'sha256', 'url'].sort();
  if (
    !notice
    || typeof notice !== 'object'
    || Array.isArray(notice)
    || JSON.stringify(Object.keys(notice).sort()) !== JSON.stringify(expectedFields)
    || !/^[a-z0-9][a-z0-9._-]*$/.test(notice.package ?? '')
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(notice.version ?? '')
    || !notice.tarball
    || typeof notice.tarball !== 'object'
    || Array.isArray(notice.tarball)
    || JSON.stringify(Object.keys(notice.tarball).sort()) !== JSON.stringify(tarballFields)
    || notice.tarball.url
      !== `https://registry.npmjs.org/${notice.package}/-/${notice.package}-${notice.version}.tgz`
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(notice.tarball.integrity ?? '')
    || !/^[a-f0-9]{64}$/.test(notice.tarball.sha256 ?? '')
    || !Number.isSafeInteger(notice.tarball.bytes)
    || notice.tarball.bytes < 1
    || !['package/LICENSE', 'package/LICENSE.md'].includes(notice.archivePath)
    || notice.sourcePath
      !== `packaging/licenses/node-runtime/${notice.package}-${notice.version}-LICENSE.txt`
    || notice.payloadPath
      !== `licenses/node-runtime/${notice.package}-${notice.version}-LICENSE.txt`
    || !/^[a-f0-9]{64}$/.test(notice.sha256 ?? '')
  ) {
    throw new Error(`invalid Node license notice lock: ${notice?.package ?? '<unknown>'}`);
  }
}

async function nodeRuntimeComponents({
  repoRoot,
  runtimeRoot,
  platform,
  runtimeLock,
  policy,
  approvals,
  usedApprovals,
}) {
  const bom = await readJson(path.join(repoRoot, 'packaging/node-runtime-bom.json'));
  const platformBom = bom.platforms?.[platform];
  const lockedSource = runtimeLock.node.sourceAsset;
  if (
    bom.sourceAsset?.url !== lockedSource?.url
    || bom.sourceAsset?.sha256 !== lockedSource?.sha256
    || bom.sourceAsset?.license?.sha256 !== lockedSource?.licenseSha256
  ) {
    throw new Error('Node source BOM does not match runtime lock');
  }
  if (
    bom.schemaVersion !== 1
    || bom.nodeVersion !== runtimeLock.node.version
    || !/^https:\/\//.test(bom.sourceAsset?.url ?? '')
    || !/^[a-f0-9]{64}$/.test(bom.sourceAsset?.sha256 ?? '')
    || bom.sourceAsset?.license?.path !== 'LICENSE'
    || !/^[a-f0-9]{64}$/.test(bom.sourceAsset?.license?.sha256 ?? '')
    || !platformBom
    || platformBom.licenseFile?.path !== 'node/LICENSE'
    || !/^[a-f0-9]{64}$/.test(platformBom.licenseFile?.sha256 ?? '')
    || !['verified-native', 'pending-native'].includes(platformBom.verification)
    || !Array.isArray(bom.payloadComponents)
    || bom.payloadComponents.length === 0
    || !Array.isArray(bom.licenseNotices)
    || bom.licenseNotices.length === 0
    || !Array.isArray(bom.excludedLicenseSections)
  ) {
    throw new Error(`invalid Node runtime BOM for ${platform}`);
  }

  const licensePath = path.join(runtimeRoot, ...platformBom.licenseFile.path.split('/'));
  const licenseBytes = await readRegularFileSnapshot(licensePath, { maxBytes: 16 * 1024 * 1024 });
  const actualLicenseSha256 = createHash('sha256').update(licenseBytes).digest('hex');
  if (actualLicenseSha256 !== platformBom.licenseFile.sha256) {
    throw new Error(
      `Node LICENSE SHA-256 does not match BOM: expected ${platformBom.licenseFile.sha256}, `
      + `received ${actualLicenseSha256}`,
    );
  }
  const licenseText = new TextDecoder('utf-8', { fatal: true }).decode(licenseBytes);
  const actualSections = parseNodeLicenseSections(licenseText);
  const actualHeadings = actualSections.map(({ heading, sourceSubpath }) => ({
    heading,
    sourceSubpath,
  }));
  const sectionByKey = new Map(actualSections.map((section) => [
    nodeLicenseHeadingKey(section),
    section,
  ]));
  const actualHeadingKeys = new Set(actualHeadings.map(nodeLicenseHeadingKey));
  const classifiedHeadings = new Map();
  const noticeByPayloadPath = new Map();
  for (const notice of bom.licenseNotices) {
    assertNodeLicenseNoticeLock(notice);
    if (noticeByPayloadPath.has(notice.payloadPath)) {
      throw new Error(`duplicate Node license notice payload: ${notice.payloadPath}`);
    }
    const sourcePath = path.resolve(repoRoot, ...notice.sourcePath.split('/'));
    const sourceRelative = path.relative(repoRoot, sourcePath);
    if (sourceRelative.startsWith('..') || path.isAbsolute(sourceRelative)) {
      throw new Error(`Node license notice source escapes repository: ${notice.sourcePath}`);
    }
    let sourceStats;
    try {
      sourceStats = await fs.promises.lstat(sourcePath);
    } catch (error) {
      throw new Error(`Node license notice source is missing: ${notice.sourcePath}`, { cause: error });
    }
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new Error(`Node license notice source is not a regular file: ${notice.sourcePath}`);
    }
    if (await sha256File(sourcePath) !== notice.sha256) {
      throw new Error(`Node license notice source SHA-256 mismatch: ${notice.sourcePath}`);
    }
    noticeByPayloadPath.set(notice.payloadPath, notice);
  }

  function classifyHeading(record, disposition) {
    assertNodeSourceSubpath(record.sourceSubpath, record.heading);
    const key = nodeLicenseHeadingKey(record);
    if (classifiedHeadings.has(key)) {
      throw new Error(`Node LICENSE heading is classified more than once: ${record.heading}`);
    }
    classifiedHeadings.set(key, disposition);
  }

  for (const component of bom.payloadComponents) {
    const evidenceRecords = Array.isArray(component.licenseEvidence)
      ? component.licenseEvidence
      : [component.licenseEvidence];
    for (const evidence of evidenceRecords) {
      if (evidence?.kind === 'license-section') {
        if (evidence.sourceSubpath !== component.sourceSubpath) {
          throw new Error(`Node component source/evidence mismatch: ${component.name}`);
        }
        classifyHeading(evidence, 'payload');
      }
    }
  }
  for (const excluded of bom.excludedLicenseSections) {
    if (!['pruned', 'build-only', 'disabled'].includes(excluded.disposition) || !excluded.reason) {
      throw new Error(`invalid excluded Node LICENSE heading: ${excluded.heading}`);
    }
    classifyHeading(excluded, excluded.disposition);
  }
  const unclassified = actualHeadings.filter((heading) => (
    !classifiedHeadings.has(nodeLicenseHeadingKey(heading))
  ));
  const invented = [...classifiedHeadings.keys()].filter((key) => !actualHeadingKeys.has(key));
  if (unclassified.length > 0 || invented.length > 0) {
    throw new Error(
      `Node LICENSE heading partition is incomplete; unclassified=${unclassified
        .map(({ heading }) => heading).join(',') || '<none>'}; `
      + `missing=${invented.map((key) => key.split('\0')[0]).join(',') || '<none>'}`,
    );
  }

  const expectedVersions = platformBom.processVersions;
  if (
    !expectedVersions
    || typeof expectedVersions !== 'object'
    || Array.isArray(expectedVersions)
    || Object.values(expectedVersions).some((value) => typeof value !== 'string')
  ) {
    throw new Error(`invalid Node process.versions contract for ${platform}`);
  }
  const actualVersions = await readNodeProcessVersions(runtimeRoot, platform);
  const versionKeys = new Set([...Object.keys(expectedVersions), ...Object.keys(actualVersions)]);
  for (const key of [...versionKeys].sort()) {
    if (expectedVersions[key] !== actualVersions[key]) {
      throw new Error(
        `Node process.versions ${key} mismatch: expected ${expectedVersions[key] ?? '<missing>'}, `
        + `received ${actualVersions[key] ?? '<missing>'}`,
      );
    }
  }

  const seenNames = new Set();
  const usedNoticePaths = new Set();
  const components = [];
  const extractedLicenseFiles = new Map();
  for (const locked of bom.payloadComponents) {
    if (
      typeof locked.name !== 'string'
      || !locked.name
      || seenNames.has(locked.name.toLowerCase())
      || typeof locked.version !== 'string'
      || !locked.version
      || !['STATIC_LINK', 'CONTAINS'].includes(locked.relationship)
      || locked.disposition !== 'payload'
      || !locked.licenseEvidence
    ) {
      throw new Error(`invalid Node runtime component: ${locked.name ?? '<unnamed>'}`);
    }
    seenNames.add(locked.name.toLowerCase());
    assertNodeSourceSubpath(locked.sourceSubpath, locked.name);
    if (
      locked.processVersionKey
      && expectedVersions[locked.processVersionKey] !== locked.version
    ) {
      throw new Error(
        `Node component ${locked.name} version does not match process.versions.`
        + `${locked.processVersionKey}`,
      );
    }
    const evidenceRecords = Array.isArray(locked.licenseEvidence)
      ? locked.licenseEvidence
      : [locked.licenseEvidence];
    const evidence = await Promise.all(evidenceRecords.map(async (record) => {
      if (record.kind === 'license-preamble') {
        return {
          kind: 'source-file',
          path: 'LICENSE#Node.js',
          sha256: bom.sourceAsset.license.sha256,
        };
      }
      if (record.kind === 'license-section') {
        return {
          kind: 'source-file',
          path: `LICENSE#${record.heading}`,
          sha256: bom.sourceAsset.license.sha256,
        };
      }
      if (
        record.kind === 'source-file'
        && typeof record.path === 'string'
        && /^[a-f0-9]{64}$/.test(record.sha256)
      ) {
        return {
          kind: 'source-file',
          path: record.path,
          sha256: record.sha256,
        };
      }
      if (
        record.kind === 'payload-file'
        && typeof record.path === 'string'
        && record.path.startsWith('licenses/node-runtime/')
        && !record.path.split('/').includes('..')
        && /^[a-f0-9]{64}$/.test(record.sha256)
      ) {
        const notice = noticeByPayloadPath.get(record.path);
        if (
          !notice
          || notice.package.toLowerCase() !== locked.name.toLowerCase()
          || notice.version !== locked.version
          || notice.sha256 !== record.sha256
        ) {
          throw new Error(`Node license notice component binding mismatch: ${locked.name}`);
        }
        if (usedNoticePaths.has(record.path)) {
          throw new Error(`Node license notice payload is consumed more than once: ${record.path}`);
        }
        usedNoticePaths.add(record.path);
        const payloadPath = path.resolve(runtimeRoot, ...record.path.split('/'));
        const relative = path.relative(runtimeRoot, payloadPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`Node license notice payload escapes runtime root: ${record.path}`);
        }
        let stats;
        try {
          stats = await fs.promises.lstat(payloadPath);
        } catch (error) {
          throw new Error(`Node license notice payload is missing: ${record.path}`, { cause: error });
        }
        if (!stats.isFile() || stats.isSymbolicLink()) {
          throw new Error(`Node license notice payload is not a regular file: ${record.path}`);
        }
        const actualSha256 = await sha256File(payloadPath);
        if (actualSha256 !== record.sha256) {
          throw new Error(`Node license notice payload SHA-256 mismatch: ${record.path}`);
        }
        return {
          kind: 'payload-file',
          path: record.path,
          sha256: actualSha256,
        };
      }
      throw new Error(`invalid Node license evidence: ${locked.name}`);
    }));
    const license = assertAllowedLicenseExpression(locked.licenseDeclared, policy);
    const licenseRefs = licenseRefsInExpression(license);
    const licenseSections = evidenceRecords.filter((record) => record.kind === 'license-section');
    if (licenseRefs.length > 0 && licenseSections.length > 0) {
      if (licenseRefs.length !== 1 || licenseSections.length !== 1) {
        throw new Error(`Node LicenseRef component must bind one exact LICENSE section: ${locked.name}`);
      }
      const section = sectionByKey.get(nodeLicenseHeadingKey(licenseSections[0]));
      if (!section) throw new Error(`Node LicenseRef section is missing: ${locked.name}`);
      const bytes = Buffer.from(section.text, 'utf8');
      const payloadPath = `licenses/extracted/${licenseRefs[0]}.txt`;
      const item = {
        path: payloadPath,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
      const existing = extractedLicenseFiles.get(payloadPath);
      if (existing && (!existing.bytes.equals(bytes) || existing.sha256 !== item.sha256)) {
        throw new Error(`conflicting Node LicenseRef section bytes: ${licenseRefs[0]}`);
      }
      extractedLicenseFiles.set(payloadPath, item);
      evidence.push({
        kind: 'payload-file',
        path: payloadPath,
        sha256: item.sha256,
      });
    }
    const component = {
      name: `node-runtime:${locked.name}`,
      version: locked.version,
      license,
      source: `${bom.sourceAsset.url}#${locked.sourceSubpath}`,
      sha256: bom.sourceAsset.sha256,
      relationship: locked.relationship,
      disposition: locked.disposition,
      licenseEvidence: evidence,
    };
    requireRestrictedApproval({
      component,
      packageName: component.name,
      policy,
      approvals,
      usedApprovals,
    });
    components.push(component);
  }
  const unusedNotices = [...noticeByPayloadPath.keys()].filter((noticePath) => (
    !usedNoticePaths.has(noticePath)
  ));
  if (unusedNotices.length > 0) {
    throw new Error(`Node license notice has no component binding: ${unusedNotices.join(', ')}`);
  }
  return { components, extractedLicenseFiles: [...extractedLicenseFiles.values()] };
}

async function pythonStandaloneComponents({
  repoRoot,
  runtimeRoot,
  platform,
  runtimeLock,
  policy,
  approvals,
  usedApprovals,
  pythonEvidence,
}) {
  const bom = await readJson(path.join(repoRoot, 'packaging/python-standalone-bom.json'));
  const metadataAsset = runtimeLock.python.metadataAssets?.[platform];
  const platformBom = bom.platforms?.[platform];
  const expectedMetadata = platform === 'macos-arm64'
    ? { targetTriple: 'aarch64-apple-darwin', buildOptions: ['pgo', 'lto'] }
    : { targetTriple: 'x86_64-pc-windows-msvc', buildOptions: ['pgo'] };
  if (
    bom.schemaVersion !== 1
    || bom.pythonVersion !== runtimeLock.python.version
    || bom.distributionRelease !== runtimeLock.python.distributionRelease
    || bom.releaseCommit !== runtimeLock.python.releaseCommit
    || !metadataAsset
    || !platformBom
    || typeof platformBom.metadataSource !== 'object'
    || !Array.isArray(platformBom.externalSystemDependencies)
    || !Array.isArray(platformBom.components)
    || platformBom.components.length === 0
  ) {
    throw new Error(`CPython BOM metadata is invalid for ${platform}`);
  }
  if (
    platformBom.metadataSource.url !== metadataAsset.url
    || platformBom.metadataSource.sha256 !== metadataAsset.sha256
    || platformBom.metadataSource.size !== metadataAsset.size
    || platformBom.metadataSource.targetTriple !== expectedMetadata.targetTriple
    || JSON.stringify(platformBom.metadataSource.buildOptions) !== JSON.stringify(
      expectedMetadata.buildOptions,
    )
  ) {
    throw new Error('CPython BOM source archive SHA-256 does not match runtime lock');
  }
  if (
    platformBom.metadataSource.pythonJson?.path !== 'python/PYTHON.json'
    || platformBom.metadataSource.pythonJson?.sha256 !== metadataAsset.pythonJsonSha256
  ) {
    throw new Error('CPython BOM PYTHON.json SHA-256 does not match runtime lock');
  }

  const seen = new Set();
  const components = [];
  for (const locked of platformBom.components) {
    const keys = Object.keys(locked).sort();
    const expectedKeys = [
      'evidenceOrigins',
      'licenseDeclared',
      'licenseEvidence',
      'name',
      'disposition',
      ...(locked.payloadEvidence === undefined ? [] : ['payloadEvidence']),
      'relationship',
      'source',
      'version',
    ].sort();
    if (JSON.stringify(keys) !== JSON.stringify(
      expectedKeys,
    )) {
      throw new Error('invalid CPython BOM component fields');
    }
    const sourceKeys = Object.keys(locked.source ?? {}).sort();
    const validArchiveSource = (
      locked.source?.kind === 'archive'
      && JSON.stringify(sourceKeys) === JSON.stringify(['kind', 'sha256', 'url'])
      && /^https:\/\//.test(locked.source.url)
    );
    const validRuntimeSource = (
      locked.source?.kind === 'runtime-file'
      && JSON.stringify(sourceKeys) === JSON.stringify(['kind', 'path', 'sha256'])
      && /^python\/[A-Za-z0-9._/-]+$/.test(locked.source.path)
      && !locked.source.path.split('/').includes('..')
    );
    if (
      typeof locked.name !== 'string'
      || !locked.name
      || typeof locked.version !== 'string'
      || !locked.version
      || !['STATIC_LINK', 'DYNAMIC_LINK', 'CONTAINS'].includes(locked.relationship)
      || locked.disposition !== 'payload'
      || !Array.isArray(locked.evidenceOrigins)
      || (!validArchiveSource && !validRuntimeSource)
      || !/^[a-f0-9]{64}$/.test(locked.source?.sha256)
      || !Array.isArray(locked.licenseEvidence)
      || locked.licenseEvidence.length === 0
    ) {
      throw new Error(`invalid CPython BOM component record: ${locked.name ?? '<unnamed>'}`);
    }
    const manifestEvidence = [];
    for (const evidence of locked.licenseEvidence) {
      const commonPathIsValid = (
        typeof evidence?.path === 'string'
        && evidence.path
        && !evidence.path.startsWith('/')
        && !evidence.path.includes('\\')
        && !evidence.path.split('/').includes('..')
      );
      const regularEvidence = (
        JSON.stringify(Object.keys(evidence ?? {}).sort())
          === JSON.stringify(['kind', 'path', 'sha256'])
        && ['metadata-file', 'source-file', 'payload-file'].includes(evidence.kind)
        && /^[a-f0-9]{64}$/.test(evidence.sha256)
      );
      const archiveMemberEvidence = (
        JSON.stringify(Object.keys(evidence ?? {}).sort())
          === JSON.stringify(['archiveSha256', 'kind', 'memberSha256', 'path'])
        && evidence.kind === 'source-archive-member'
        && /^[a-f0-9]{64}$/.test(evidence.archiveSha256)
        && /^[a-f0-9]{64}$/.test(evidence.memberSha256)
      );
      if (!commonPathIsValid || (!regularEvidence && !archiveMemberEvidence)) {
        throw new Error(`invalid license evidence for CPython component ${locked.name}`);
      }
      if (evidence.kind === 'payload-file' && !validRuntimeSource) {
        throw new Error(`payload-file evidence requires a runtime-file source: ${locked.name}`);
      }
      if (evidence.kind !== 'payload-file') {
        manifestEvidence.push(pythonEvidence.payloadRecordForEvidence(platform, evidence));
      }
    }
    if (validRuntimeSource) {
      const payloadPath = path.resolve(
        runtimeRoot,
        locked.source.path.split('/').join(path.sep),
      );
      const relative = path.relative(runtimeRoot, payloadPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`CPython BOM runtime-file escapes runtime root: ${locked.source.path}`);
      }
      let stats;
      try {
        stats = await fs.promises.lstat(payloadPath);
      } catch (error) {
        throw new Error(`CPython BOM runtime-file is missing: ${locked.source.path}`, {
          cause: error,
        });
      }
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`CPython BOM runtime-file is not a regular file: ${locked.source.path}`);
      }
      const actualSha256 = await sha256File(payloadPath);
      if (actualSha256 !== locked.source.sha256) {
        throw new Error(
          `CPython BOM runtime-file SHA-256 does not match actual payload: ${locked.source.path}`,
        );
      }
      for (const evidence of locked.licenseEvidence.filter(({ kind }) => kind === 'payload-file')) {
        if (evidence.path !== locked.source.path || evidence.sha256 !== actualSha256) {
          throw new Error(
            `CPython BOM payload-file evidence does not match actual payload: ${evidence.path}`,
          );
        }
        manifestEvidence.push(evidence);
      }
    }
    const normalizedName = locked.name.toLowerCase();
    if (seen.has(normalizedName)) {
      throw new Error(`duplicate CPython BOM component: ${locked.name}`);
    }
    seen.add(normalizedName);
    const component = {
      name: `python-standalone:${locked.name}`,
      version: locked.version,
      license: assertAllowedLicenseExpression(locked.licenseDeclared, policy),
      source: validArchiveSource
        ? locked.source.url
        : `runtime-file:${locked.source.path}`,
      sha256: locked.source.sha256,
      relationship: locked.relationship,
      disposition: locked.disposition,
      licenseEvidence: manifestEvidence,
    };
    requireRestrictedApproval({
      component,
      packageName: component.name,
      policy,
      approvals,
      usedApprovals,
    });
    components.push(component);
  }
  return components;
}

function sortComponents(components) {
  return components.sort((left, right) => (
    comparePortableUtf8(
      `${left.name}\0${left.version}\0${left.source}`,
      `${right.name}\0${right.version}\0${right.source}`,
    )
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
    || !Array.isArray(policy.allowedSpdxLicenses)
    || !Array.isArray(policy.allowedSpdxExceptions)
    || !Array.isArray(policy.allowedLicenseRefs)
    || !Array.isArray(policy.restrictedLicenseRefs)
    || !Array.isArray(policy.reviewedNonRestrictedLicenseRefs)
    || !Array.isArray(policy.trustedApprovals)
    || typeof policy.classifications !== 'object'
  ) {
    throw new Error('invalid license policy');
  }
  const approvals = await loadApprovals(licenseApprovalPath, policy);
  const usedApprovals = new Map();
  const nodeAsset = runtimeLock.node.assets[platform];
  const pythonAsset = runtimeLock.python.assets[platform];
  if (!nodeAsset || !pythonAsset) throw new Error(`runtime lock does not contain ${platform}`);
  await assertBundledRuntimeToolsPruned(resolvedRuntimeRoot, platform);
  const pythonEvidence = loadPythonStandaloneEvidence({
    bundle: path.join(
      resolvedRepoRoot,
      'packaging/evidence/python-standalone/evidence-bundle.json',
    ),
    runtimeLock,
    bom: path.join(resolvedRepoRoot, 'packaging/python-standalone-bom.json'),
  });
  pythonEvidence.verifyStagedPythonStandaloneNotices({
    runtimeRoot: resolvedRuntimeRoot,
    platform,
  });
  verifyPythonStandalonePayloadEvidence({
    runtimeRoot: resolvedRuntimeRoot,
    platform,
    bom: path.join(resolvedRepoRoot, 'packaging/python-standalone-bom.json'),
  });
  const nodeRuntime = await nodeRuntimeComponents({
    repoRoot: resolvedRepoRoot,
    runtimeRoot: resolvedRuntimeRoot,
    platform,
    runtimeLock,
    policy,
    approvals,
    usedApprovals,
  });

  const components = [
    {
      name: 'runtime:node',
      version: runtimeLock.node.version,
      license: 'MIT',
      source: nodeAsset.url,
      sha256: nodeAsset.sha256,
    },
    ...nodeRuntime.components,
    {
      name: 'runtime:cpython',
      version: runtimeLock.python.version,
      license: 'Python-2.0',
      source: pythonAsset.url,
      sha256: pythonAsset.sha256,
    },
    ...await pythonStandaloneComponents({
      repoRoot: resolvedRepoRoot,
      runtimeRoot: resolvedRuntimeRoot,
      platform,
      runtimeLock,
      policy,
      approvals,
      usedApprovals,
      pythonEvidence,
    }),
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
      approvals,
      usedApprovals,
    }),
    ...await workspaceWheelComponents({ runtimeRoot: resolvedRuntimeRoot, policy }),
  ];

  const sortedComponents = sortComponents(components);
  const licenseApprovals = [...usedApprovals.values()].sort((left, right) => (
    comparePortableUtf8(
      `${left.package}\0${left.approvalId}`,
      `${right.package}\0${right.approvalId}`,
    )
  ));
  await writeRuntimeLicenseArtifacts({
    runtimeRoot: resolvedRuntimeRoot,
    platform,
    components: sortedComponents,
    licenseApprovals,
    virtualFiles: nodeRuntime.extractedLicenseFiles.map(({ path: itemPath, bytes }) => ({
      path: itemPath,
      bytes,
    })),
  });

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
    licenseApprovals,
    components: sortedComponents,
    files: await inventoryFiles(resolvedRuntimeRoot, {
      omitRelativePaths: ['runtime-manifest.json'],
    }),
  };
  validateRuntimeManifest(manifest, platform, { code: 'RUNTIME_MANIFEST_INVALID' });
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
