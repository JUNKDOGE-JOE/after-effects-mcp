import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  comparePortableUtf8,
  readRegularFileSnapshot,
  writeBytesAtomically,
} from './files.mjs';
import {
  buildLicenseInventory,
  buildRuntimeSpdx,
  canonicalRuntimeEvidenceJson,
  verifyExtractedLicenseEvidence,
} from './runtime-evidence.mjs';

const MAX_LICENSE_BYTES = 16 * 1024 * 1024;
const LICENSE_REF_PATTERN = /^LicenseRef-[A-Za-z0-9.-]+$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VIRTUAL_LICENSE_PREFIX = 'licenses/extracted/';
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function artifactError(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'RUNTIME_LICENSE_EVIDENCE_INVALID';
  return error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertPortablePath(relative, label = 'license evidence') {
  if (typeof relative !== 'string'
      || relative.length === 0
      || relative.length > 1024
      || relative.includes('\\')
      || relative.includes('\0')
      || path.posix.isAbsolute(relative)
      || path.win32.isAbsolute(relative)) {
    throw artifactError(`${label} path is not portable: ${String(relative)}`);
  }
  const reservedWindowsName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
  if (relative.split('/').some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || /[<>:"|?*\u0000-\u001f]/.test(segment)
    || /[ .]$/.test(segment)
    || reservedWindowsName.test(segment)
  ))) {
    throw artifactError(`${label} path is not portable: ${relative}`);
  }
  return relative;
}

function resolveInside(runtimeRoot, relative) {
  const absolute = path.resolve(runtimeRoot, ...relative.split('/'));
  if (!isInside(runtimeRoot, absolute) || absolute === runtimeRoot) {
    throw artifactError(`license evidence escapes runtime root: ${relative}`);
  }
  return absolute;
}

async function assertRuntimeRoot(runtimeRoot) {
  if (typeof runtimeRoot !== 'string' || !runtimeRoot) {
    throw artifactError('runtime root is required');
  }
  const resolved = path.resolve(runtimeRoot);
  let stats;
  try {
    stats = await fs.promises.lstat(resolved);
  } catch (error) {
    throw artifactError(`runtime root cannot be inspected safely: ${resolved}`, error);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw artifactError(`runtime root is not a real directory: ${resolved}`);
  }
  return { resolved, real: await fs.promises.realpath(resolved) };
}

async function inspectAncestorDirectories({ resolved, real }, relative, { create = false } = {}) {
  const segments = relative.split('/').slice(0, -1);
  let current = resolved;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (create) {
      try {
        await fs.promises.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw artifactError(`cannot create license evidence directory safely: ${relative}`, error);
        }
      }
    }
    let stats;
    try {
      stats = await fs.promises.lstat(current);
    } catch (error) {
      throw artifactError(`license evidence ancestor cannot be inspected: ${relative}`, error);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw artifactError(`license evidence has a symbolic-link or non-directory ancestor: ${relative}`);
    }
    const realCurrent = await fs.promises.realpath(current);
    if (!isInside(real, realCurrent) || realCurrent === real) {
      throw artifactError(`license evidence ancestor escapes runtime root: ${relative}`);
    }
  }
}

async function pathKind(filePath) {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readEvidenceBytes(root, relative) {
  await inspectAncestorDirectories(root, relative);
  const absolute = resolveInside(root.resolved, relative);
  try {
    return await readRegularFileSnapshot(absolute, { maxBytes: MAX_LICENSE_BYTES });
  } catch (error) {
    throw artifactError(`license evidence cannot be read safely: ${relative}`, error);
  }
}

function decodeText(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_LICENSE_BYTES) return null;
  let text;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)
      || !text.trim()
      || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) {
    return null;
  }
  return text;
}

function licenseRefs(expression) {
  if (typeof expression !== 'string') {
    throw artifactError('runtime component license expression is invalid');
  }
  const refs = new Set();
  const pattern = /(?:^|[^A-Za-z0-9.-])(LicenseRef-[A-Za-z0-9.-]+)(?=$|[^A-Za-z0-9.-])/g;
  for (const match of expression.matchAll(pattern)) refs.add(match[1]);
  return [...refs].sort(comparePortableUtf8);
}

function licenseName(licenseId) {
  return licenseId.slice('LicenseRef-'.length).replace(/[-.]+/g, ' ');
}

function normalizeVirtualFiles(virtualFiles) {
  if (!Array.isArray(virtualFiles)) {
    throw artifactError('virtual reviewed license files must be an array');
  }
  const byPath = new Map();
  const portableKeys = new Set();
  for (const record of virtualFiles) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(['bytes', 'path'])
        || !(Buffer.isBuffer(record.bytes) || record.bytes instanceof Uint8Array)) {
      throw artifactError('virtual reviewed license file record is invalid');
    }
    const relative = assertPortablePath(record.path, 'virtual reviewed license');
    if (!relative.startsWith(VIRTUAL_LICENSE_PREFIX)
        || relative.length === VIRTUAL_LICENSE_PREFIX.length) {
      throw artifactError(
        `virtual reviewed license files are restricted to ${VIRTUAL_LICENSE_PREFIX}`,
      );
    }
    const portableKey = relative.normalize('NFC').toLowerCase();
    if (portableKeys.has(portableKey)) {
      throw artifactError(`duplicate virtual reviewed license path: ${relative}`);
    }
    const bytes = Buffer.from(record.bytes);
    if (bytes.length === 0 || bytes.length > MAX_LICENSE_BYTES) {
      throw artifactError(`virtual reviewed license file is empty or too large: ${relative}`);
    }
    portableKeys.add(portableKey);
    byPath.set(relative, bytes);
  }
  return byPath;
}

function collectPayloadCandidates(components) {
  if (!Array.isArray(components) || components.length === 0) {
    throw artifactError('runtime components are required');
  }
  const candidates = new Map();
  const referencedPayloads = new Map();
  for (const component of components) {
    if (!component || typeof component !== 'object' || Array.isArray(component)) {
      throw artifactError('runtime component is invalid');
    }
    const refs = licenseRefs(component.license);
    if (refs.length === 0) continue;
    if (!Array.isArray(component.licenseEvidence)) {
      throw artifactError(`runtime component has no license evidence: ${component.name ?? '<unknown>'}`);
    }
    const payloadEvidence = component.licenseEvidence.filter((record) => record?.kind === 'payload-file');
    for (const evidence of payloadEvidence) {
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
          || typeof evidence.path !== 'string'
          || !SHA256_PATTERN.test(evidence.sha256 ?? '')) {
        throw artifactError(`runtime component payload license evidence is invalid: ${component.name}`);
      }
      assertPortablePath(evidence.path);
      const identity = `${evidence.path}\0${evidence.sha256}`;
      referencedPayloads.set(identity, evidence);
      for (const licenseId of refs) {
        if (!LICENSE_REF_PATTERN.test(licenseId)) {
          throw artifactError(`invalid SPDX LicenseRef: ${licenseId}`);
        }
        if (!candidates.has(licenseId)) candidates.set(licenseId, new Map());
        candidates.get(licenseId).set(identity, evidence);
      }
    }
    for (const licenseId of refs) {
      if (!candidates.has(licenseId)) candidates.set(licenseId, new Map());
    }
  }
  return { candidates, referencedPayloads };
}

async function preflightVirtualDestinations(root, virtualFiles) {
  for (const [relative, bytes] of virtualFiles) {
    const absolute = resolveInside(root.resolved, relative);
    const stats = await pathKind(absolute);
    if (!stats) {
      const parentRelative = relative.split('/').slice(0, -1).join('/');
      if (parentRelative) {
        const firstMissing = parentRelative.split('/');
        let current = root.resolved;
        for (const segment of firstMissing) {
          current = path.join(current, segment);
          const ancestor = await pathKind(current);
          if (!ancestor) break;
          if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) {
            throw artifactError(`virtual reviewed license has an unsafe ancestor: ${relative}`);
          }
        }
      }
      continue;
    }
    const existing = await readEvidenceBytes(root, relative);
    if (!existing.equals(bytes)) {
      throw artifactError(`virtual reviewed license destination has different content: ${relative}`);
    }
  }
}

async function stageVirtualFiles(root, virtualFiles) {
  for (const relative of [...virtualFiles.keys()].sort(comparePortableUtf8)) {
    const bytes = virtualFiles.get(relative);
    await inspectAncestorDirectories(root, relative, { create: true });
    const absolute = resolveInside(root.resolved, relative);
    try {
      await writeBytesAtomically(absolute, bytes, { mode: 0o600 });
    } catch (error) {
      throw artifactError(`virtual reviewed license cannot be staged atomically: ${relative}`, error);
    }
    await inspectAncestorDirectories(root, relative);
    const staged = await readEvidenceBytes(root, relative);
    if (!staged.equals(bytes)) {
      throw artifactError(`virtual reviewed license changed while staging: ${relative}`);
    }
  }
}

async function buildExtractedLicenses({ root, components, virtualFiles }) {
  const { candidates, referencedPayloads } = collectPayloadCandidates(components);
  for (const [relative, bytes] of virtualFiles) {
    const digest = sha256(bytes);
    if (!referencedPayloads.has(`${relative}\0${digest}`)) {
      throw artifactError(`virtual reviewed license is not bound to payload evidence: ${relative}`);
    }
  }

  const extractedLicenses = [];
  for (const licenseId of [...candidates.keys()].sort(comparePortableUtf8)) {
    const textual = [];
    const evidenceRecords = [...candidates.get(licenseId).values()]
      .sort((left, right) => comparePortableUtf8(left.path, right.path));
    for (const evidence of evidenceRecords) {
      const bytes = virtualFiles.has(evidence.path)
        ? virtualFiles.get(evidence.path)
        : await readEvidenceBytes(root, evidence.path);
      if (sha256(bytes) !== evidence.sha256) {
        throw artifactError(`license evidence digest does not match: ${evidence.path}`);
      }
      const text = decodeText(bytes);
      if (text !== null) textual.push({ bytes, evidence, text });
    }
    if (textual.length === 0) {
      throw artifactError(`no reviewed UTF-8 textual evidence for ${licenseId}`);
    }
    const selected = textual[0];
    if (textual.some(({ bytes }) => !bytes.equals(selected.bytes))) {
      throw artifactError(`divergent textual evidence for ${licenseId}`);
    }
    extractedLicenses.push({
      licenseId,
      name: licenseName(licenseId),
      extractedText: selected.text,
      evidence: {
        path: selected.evidence.path,
        sha256: selected.evidence.sha256,
      },
    });
  }
  return extractedLicenses;
}

async function preflightCanonicalOutput(root, relative, bytes) {
  const absolute = resolveInside(root.resolved, relative);
  const stats = await pathKind(absolute);
  if (!stats) return;
  let existing;
  try {
    existing = await readRegularFileSnapshot(absolute, { maxBytes: Math.max(1, bytes.length) });
  } catch (error) {
    throw artifactError(`runtime license artifact cannot be read safely: ${relative}`, error);
  }
  if (!existing.equals(bytes)) {
    throw artifactError(`runtime license artifact already exists with different content: ${relative}`);
  }
}

export async function writeRuntimeLicenseArtifacts({
  runtimeRoot,
  platform,
  components,
  licenseApprovals = [],
  virtualFiles = [],
}) {
  const root = await assertRuntimeRoot(runtimeRoot);
  const normalizedVirtualFiles = normalizeVirtualFiles(virtualFiles);
  await preflightVirtualDestinations(root, normalizedVirtualFiles);

  const extractedLicenses = await buildExtractedLicenses({
    root,
    components,
    virtualFiles: normalizedVirtualFiles,
  });
  const licenseInventory = buildLicenseInventory({
    platform,
    components,
    licenseApprovals,
    extractedLicenses,
  });
  const sbom = buildRuntimeSpdx({ platform, components, extractedLicenses });
  const licenseInventoryBytes = Buffer.from(
    canonicalRuntimeEvidenceJson(licenseInventory),
    'utf8',
  );
  const sbomBytes = Buffer.from(canonicalRuntimeEvidenceJson(sbom), 'utf8');

  await preflightCanonicalOutput(root, 'license-inventory.json', licenseInventoryBytes);
  await preflightCanonicalOutput(root, 'sbom.spdx.json', sbomBytes);
  await stageVirtualFiles(root, normalizedVirtualFiles);
  await verifyExtractedLicenseEvidence({ runtimeRoot: root.resolved, components, extractedLicenses });
  await writeBytesAtomically(
    path.join(root.resolved, 'license-inventory.json'),
    licenseInventoryBytes,
    { mode: 0o600 },
  );
  await writeBytesAtomically(
    path.join(root.resolved, 'sbom.spdx.json'),
    sbomBytes,
    { mode: 0o600 },
  );

  return { extractedLicenses, licenseInventory, sbom };
}
