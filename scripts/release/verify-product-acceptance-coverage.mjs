#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertPortableRelativePath,
  canonicalJson,
  readJsonFile,
  writeCanonicalJson,
} from '../package/lib/manifest.mjs';
import {
  readRegularFileSnapshot,
  sha256File,
} from '../package/lib/files.mjs';

const CANDIDATE_SHA = /^[a-f0-9]{40}$/;
const EVIDENCE_SHA256 = /^[a-f0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const SELECTOR_KEYS = ['evidence', 'requiredScenarios', 'schemaVersion', 'status'];
const ENTRY_KEYS = [
  'candidateSha',
  'evidencePath',
  'evidenceSha256',
  'id',
  'owner',
  'result',
  'reviewedBy',
];

export const PRODUCT_ACCEPTANCE_SCENARIOS = Object.freeze([
  'clean-install-and-upgrade-rollback',
  'permission-denial-and-recovery',
  'persistence',
  'provider-header-routing',
  'tool-library',
]);

function coverageError(message) {
  return new Error(message);
}

function hasExactKeys(value, expected) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sameOrderedValues(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function repositoryRootForCoveragePath(coveragePath) {
  const resolvedCoveragePath = path.resolve(coveragePath);
  const packagingDirectory = path.dirname(resolvedCoveragePath);
  if (path.basename(resolvedCoveragePath) !== 'product-acceptance-coverage.json'
      || path.basename(packagingDirectory) !== 'packaging') {
    throw coverageError('coverage selector must use the canonical packaging location');
  }
  return path.dirname(packagingDirectory);
}

async function assertSafeDirectoryChain(root, relative) {
  let current = root;
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.promises.lstat(current);
    } catch {
      throw coverageError(`evidence parent directory is missing: ${relative}`);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw coverageError(`evidence parent directory is unsafe: ${relative}`);
    }
  }
}

function validateSelector(selector, candidateSha) {
  if (!hasExactKeys(selector, SELECTOR_KEYS)
      || selector.schemaVersion !== 1
      || selector.status !== 'approved'
      || !sameOrderedValues(selector.requiredScenarios, PRODUCT_ACCEPTANCE_SCENARIOS)
      || !Array.isArray(selector.evidence)
      || selector.evidence.length !== PRODUCT_ACCEPTANCE_SCENARIOS.length) {
    throw coverageError('product acceptance selector is invalid');
  }

  return selector.evidence.map((entry, index) => {
    if (!hasExactKeys(entry, ENTRY_KEYS)
        || entry.id !== PRODUCT_ACCEPTANCE_SCENARIOS[index]
        || entry.candidateSha !== candidateSha
        || !CANDIDATE_SHA.test(entry.candidateSha)
        || entry.result !== 'PASS'
        || typeof entry.evidencePath !== 'string'
        || !EVIDENCE_SHA256.test(entry.evidenceSha256 ?? '')
        || typeof entry.owner !== 'string' || entry.owner.trim().length === 0
        || typeof entry.reviewedBy !== 'string' || entry.reviewedBy.trim().length === 0) {
      throw coverageError('product acceptance selector entry is invalid');
    }
    try {
      assertPortableRelativePath(entry.evidencePath, 'PRODUCT_ACCEPTANCE_EVIDENCE_PATH_INVALID');
    } catch {
      throw coverageError('product acceptance evidence path is invalid');
    }
    return entry;
  });
}

async function verifyEvidence({ entry, root, realRoot, candidateSha }) {
  const evidencePath = path.resolve(root, ...entry.evidencePath.split('/'));
  if (!isInside(root, evidencePath)) {
    throw coverageError(`product acceptance evidence path escapes repository: ${entry.evidencePath}`);
  }
  await assertSafeDirectoryChain(root, entry.evidencePath);

  let stats;
  try {
    stats = await fs.promises.lstat(evidencePath);
  } catch {
    throw coverageError(`product acceptance evidence is missing: ${entry.evidencePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
      || stats.size <= 0 || stats.size > MAX_EVIDENCE_BYTES) {
    throw coverageError(`product acceptance evidence is not one bounded regular file: ${entry.evidencePath}`);
  }

  let realEvidencePath;
  try {
    realEvidencePath = await fs.promises.realpath(evidencePath);
  } catch {
    throw coverageError(`product acceptance evidence cannot be resolved: ${entry.evidencePath}`);
  }
  if (!isInside(realRoot, realEvidencePath)) {
    throw coverageError(`product acceptance evidence escapes repository: ${entry.evidencePath}`);
  }

  let bytes;
  let evidenceSha256;
  try {
    bytes = await readRegularFileSnapshot(evidencePath, {
      expectedStats: stats,
      maxBytes: MAX_EVIDENCE_BYTES,
    });
    evidenceSha256 = await sha256File(evidencePath, { expectedStats: stats });
  } catch {
    throw coverageError(`product acceptance evidence cannot be read safely: ${entry.evidencePath}`);
  }
  if (evidenceSha256 !== entry.evidenceSha256) {
    throw coverageError(`product acceptance evidence digest mismatch: ${entry.evidencePath}`);
  }

  let evidence;
  try {
    evidence = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw coverageError(`product acceptance evidence is not JSON: ${entry.evidencePath}`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(evidence), 'utf8'))
      || !evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || evidence.schemaVersion !== 1
      || evidence.candidateSha !== candidateSha
      || evidence.result !== 'PASS'
      || evidence.scenario !== entry.id) {
    throw coverageError(`product acceptance evidence contract is invalid: ${entry.evidencePath}`);
  }

  return {
    id: entry.id,
    result: 'PASS',
    evidenceSha256,
  };
}

export function parseProductAcceptanceArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 6) {
    throw coverageError('expected --candidate-sha, --coverage, and --out exactly once');
  }
  const values = new Map();
  const allowed = new Set(['--candidate-sha', '--coverage', '--out']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || values.has(key) || typeof value !== 'string' || value.length === 0) {
      throw coverageError('expected --candidate-sha, --coverage, and --out exactly once');
    }
    values.set(key, value);
  }
  const candidateSha = values.get('--candidate-sha');
  const coveragePath = values.get('--coverage');
  const outPath = values.get('--out');
  if (!CANDIDATE_SHA.test(candidateSha)
      || !path.isAbsolute(coveragePath)
      || !path.isAbsolute(outPath)) {
    throw coverageError('candidate SHA and coverage/output paths are invalid');
  }
  return { candidateSha, coveragePath, outPath };
}

export async function verifyProductAcceptanceCoverage({ candidateSha, coveragePath } = {}) {
  if (!CANDIDATE_SHA.test(candidateSha ?? '') || typeof coveragePath !== 'string'
      || !path.isAbsolute(coveragePath)) {
    throw coverageError('candidate SHA and coverage path are invalid');
  }
  const root = repositoryRootForCoveragePath(coveragePath);
  let realRoot;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    throw coverageError('repository root cannot be resolved');
  }

  let selector;
  try {
    selector = await readJsonFile(coveragePath, 'PRODUCT_ACCEPTANCE_COVERAGE_INVALID');
  } catch {
    throw coverageError('product acceptance selector cannot be read safely');
  }
  const entries = validateSelector(selector, candidateSha);
  const coverage = [];
  for (const entry of entries) {
    coverage.push(await verifyEvidence({ entry, root, realRoot, candidateSha }));
  }
  return {
    schemaVersion: 1,
    candidateSha,
    result: 'PASS',
    coverage,
  };
}

export async function writeProductAcceptanceCoverageEvidence({ candidateSha, coveragePath, outPath } = {}) {
  if (!CANDIDATE_SHA.test(candidateSha ?? '') || typeof coveragePath !== 'string'
      || !path.isAbsolute(coveragePath) || typeof outPath !== 'string' || !path.isAbsolute(outPath)) {
    throw coverageError('candidate SHA and coverage/output paths are invalid');
  }
  try {
    await fs.promises.lstat(outPath);
    throw coverageError(`output path already exists: ${outPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const result = await verifyProductAcceptanceCoverage({ candidateSha, coveragePath });
  await writeCanonicalJson(outPath, result);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeProductAcceptanceCoverageEvidence(parseProductAcceptanceArgs(process.argv.slice(2)))
    .catch((error) => {
      process.stderr.write(
        `PRODUCT_ACCEPTANCE_COVERAGE_FAILED: ${error.message}\n`,
      );
      process.exitCode = 1;
    });
}
