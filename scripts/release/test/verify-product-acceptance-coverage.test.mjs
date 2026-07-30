import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalJson,
  sha256Bytes,
} from '../../package/lib/manifest.mjs';
import {
  PRODUCT_ACCEPTANCE_SCENARIOS,
  parseProductAcceptanceArgs,
  verifyProductAcceptanceCoverage,
  writeProductAcceptanceCoverageEvidence,
} from '../verify-product-acceptance-coverage.mjs';

const CANDIDATE_SHA = 'a'.repeat(40);
const SCENARIO_IDS = [
  'clean-install-and-upgrade-rollback',
  'permission-denial-and-recovery',
  'persistence',
  'provider-header-routing',
  'tool-library',
];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function evidenceDocument(id, candidateSha = CANDIDATE_SHA, result = 'PASS') {
  return {
    candidateSha,
    result,
    scenario: id,
    schemaVersion: 1,
  };
}

async function makeFixture(t, options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ae-mcp-product-coverage-'));
  t.after(() => fs.promises.rm(root, { force: true, recursive: true }));

  const coveragePath = path.join(root, 'packaging', 'product-acceptance-coverage.json');
  const evidenceDigests = new Map();
  for (const id of SCENARIO_IDS) {
    const evidencePath = path.join(root, 'packaging', 'evidence', 'product-acceptance', `${id}.json`);
    const bytes = Buffer.from(canonicalJson(evidenceDocument(id)), 'utf8');
    await fs.promises.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.promises.writeFile(evidencePath, bytes);
    evidenceDigests.set(id, digest(bytes));
  }

  const selector = {
    evidence: SCENARIO_IDS.map((id) => ({
      id,
      candidateSha: CANDIDATE_SHA,
      result: 'PASS',
      evidencePath: `packaging/evidence/product-acceptance/${id}.json`,
      evidenceSha256: evidenceDigests.get(id),
      owner: 'JUNKDOGE-JOE',
      reviewedBy: 'subagent:issue68-product-coverage-review',
    })),
    requiredScenarios: SCENARIO_IDS,
    schemaVersion: 1,
    status: 'approved',
  };
  options.mutateSelector?.(selector, evidenceDigests);
  await fs.promises.mkdir(path.dirname(coveragePath), { recursive: true });
  await fs.promises.writeFile(coveragePath, canonicalJson(selector));

  return { coveragePath, evidenceDigests, root, selector };
}

async function rewriteSelector(fixture) {
  await fs.promises.writeFile(fixture.coveragePath, canonicalJson(fixture.selector));
}

async function writeEvidence(fixture, id, value) {
  const evidencePath = path.join(
    fixture.root,
    'packaging',
    'evidence',
    'product-acceptance',
    `${id}.json`,
  );
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  await fs.promises.writeFile(evidencePath, bytes);
  fixture.evidenceDigests.set(id, sha256Bytes(bytes));
  fixture.selector.evidence.find((entry) => entry.id === id).evidenceSha256 = sha256Bytes(bytes);
  await rewriteSelector(fixture);
  return evidencePath;
}

function expectRejected(action) {
  return assert.rejects(action, (error) => error instanceof Error);
}

test('approved selector returns the exact ordered product acceptance coverage', async (t) => {
  const fixture = await makeFixture(t);

  assert.deepEqual(PRODUCT_ACCEPTANCE_SCENARIOS, SCENARIO_IDS);
  const result = await verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: fixture.coveragePath,
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    candidateSha: CANDIDATE_SHA,
    result: 'PASS',
    coverage: SCENARIO_IDS.map((id) => ({
      id,
      result: 'PASS',
      evidenceSha256: fixture.evidenceDigests.get(id),
    })),
  });
});

test('argument parser requires exactly one absolute candidate selector and output', () => {
  const coveragePath = path.join(os.tmpdir(), 'coverage.json');
  const outPath = path.join(os.tmpdir(), 'out.json');
  const argv = ['--candidate-sha', CANDIDATE_SHA, '--coverage', coveragePath, '--out', outPath];
  assert.deepEqual(parseProductAcceptanceArgs(argv), {
    candidateSha: CANDIDATE_SHA,
    coveragePath,
    outPath,
  });

  for (const invalid of [
    [],
    ['--candidate-sha', CANDIDATE_SHA, '--candidate-sha', CANDIDATE_SHA, '--coverage', coveragePath, '--out', outPath],
    ['--candidate-sha', CANDIDATE_SHA, '--coverage', coveragePath, '--out', outPath, '--unknown', 'x'],
    ['--candidate-sha', CANDIDATE_SHA, '--coverage', 'coverage.json', '--out', outPath],
    ['--candidate-sha', CANDIDATE_SHA, '--coverage', coveragePath, '--out', 'out.json'],
    ['--candidate-sha', 'not-a-sha', '--coverage', coveragePath, '--out', outPath],
  ]) {
    assert.throws(() => parseProductAcceptanceArgs(invalid));
  }
});

test('blocked selector cannot produce product acceptance coverage', async (t) => {
  const fixture = await makeFixture(t, {
    mutateSelector: (selector) => { selector.status = 'blocked'; },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: fixture.coveragePath,
  }));
});

test('empty evidence array cannot produce product acceptance coverage', async (t) => {
  const fixture = await makeFixture(t, {
    mutateSelector: (selector) => { selector.evidence = []; },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: fixture.coveragePath,
  }));
});

for (const [name, mutate] of [
  ['missing', (selector) => { selector.evidence.pop(); }],
  ['extra', (selector) => { selector.evidence.push({ ...selector.evidence[0], id: 'extra' }); }],
  ['duplicate', (selector) => { selector.evidence[4] = { ...selector.evidence[4], id: selector.evidence[0].id }; }],
  ['unsorted', (selector) => { [selector.evidence[0], selector.evidence[1]] = [selector.evidence[1], selector.evidence[0]]; }],
]) {
  test(`${name} scenario coverage is rejected`, async (t) => {
    const fixture = await makeFixture(t, { mutateSelector: mutate });
    await expectRejected(() => verifyProductAcceptanceCoverage({
      candidateSha: CANDIDATE_SHA,
      coveragePath: fixture.coveragePath,
    }));
  });
}

test('selector and entries must retain their exact schema keys', async (t) => {
  const selectorFixture = await makeFixture(t, {
    mutateSelector: (selector) => { selector.unexpected = true; },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: selectorFixture.coveragePath,
  }));

  const entryFixture = await makeFixture(t, {
    mutateSelector: (selector) => { selector.evidence[0].unexpected = true; },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: entryFixture.coveragePath,
  }));
});

test('selector entry candidate SHA and result must match the requested PASS candidate', async (t) => {
  const wrongSha = await makeFixture(t, {
    mutateSelector: (selector) => { selector.evidence[0].candidateSha = 'b'.repeat(40); },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: wrongSha.coveragePath,
  }));

  const nonPass = await makeFixture(t, {
    mutateSelector: (selector) => { selector.evidence[0].result = 'FAIL'; },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: nonPass.coveragePath,
  }));
});

test('selector entries require non-empty owner and reviewer identities', async (t) => {
  const owner = await makeFixture(t, {
    mutateSelector: (selector) => { selector.evidence[0].owner = ''; },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: owner.coveragePath,
  }));

  const reviewer = await makeFixture(t, {
    mutateSelector: (selector) => { selector.evidence[0].reviewedBy = ''; },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: reviewer.coveragePath,
  }));
});

test('absolute and escaping evidence paths are rejected', async (t) => {
  const absolute = await makeFixture(t, {
    mutateSelector: (selector) => { selector.evidence[0].evidencePath = '/tmp/evidence.json'; },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: absolute.coveragePath,
  }));

  const escaping = await makeFixture(t, {
    mutateSelector: (selector) => { selector.evidence[0].evidencePath = '../evidence.json'; },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: escaping.coveragePath,
  }));
});

test('missing, symbolic, hard-linked, and oversized evidence files are rejected', async (t) => {
  const missing = await makeFixture(t);
  const missingPath = path.join(missing.root, 'packaging', 'evidence', 'product-acceptance', `${SCENARIO_IDS[0]}.json`);
  await fs.promises.rm(missingPath);
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: missing.coveragePath,
  }));

  const symbolic = await makeFixture(t);
  const symbolicPath = path.join(symbolic.root, 'packaging', 'evidence', 'product-acceptance', `${SCENARIO_IDS[0]}.json`);
  const symbolicTarget = path.join(symbolic.root, 'symbolic-target.json');
  await fs.promises.rename(symbolicPath, symbolicTarget);
  await fs.promises.symlink(symbolicTarget, symbolicPath);
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: symbolic.coveragePath,
  }));

  const linked = await makeFixture(t);
  const linkedPath = path.join(linked.root, 'packaging', 'evidence', 'product-acceptance', `${SCENARIO_IDS[0]}.json`);
  const linkedTarget = path.join(linked.root, 'hardlink-target.json');
  await fs.promises.rename(linkedPath, linkedTarget);
  await fs.promises.link(linkedTarget, linkedPath);
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: linked.coveragePath,
  }));

  const oversized = await makeFixture(t);
  const oversizedPath = path.join(oversized.root, 'packaging', 'evidence', 'product-acceptance', `${SCENARIO_IDS[0]}.json`);
  await fs.promises.writeFile(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1));
  oversized.selector.evidence[0].evidenceSha256 = await digest(await fs.promises.readFile(oversizedPath));
  await rewriteSelector(oversized);
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: oversized.coveragePath,
  }));
});

test('selector evidence digest must match the bounded evidence bytes', async (t) => {
  const fixture = await makeFixture(t, {
    mutateSelector: (selector) => { selector.evidence[0].evidenceSha256 = 'b'.repeat(64); },
  });
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: fixture.coveragePath,
  }));
});

test('evidence JSON must be canonical and match its candidate and PASS result', async (t) => {
  const candidate = await makeFixture(t);
  await writeEvidence(candidate, SCENARIO_IDS[0], evidenceDocument(SCENARIO_IDS[0], 'b'.repeat(40)));
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: candidate.coveragePath,
  }));

  const result = await makeFixture(t);
  await writeEvidence(result, SCENARIO_IDS[0], evidenceDocument(SCENARIO_IDS[0], CANDIDATE_SHA, 'FAIL'));
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: result.coveragePath,
  }));

  const noncanonical = await makeFixture(t);
  const noncanonicalPath = path.join(
    noncanonical.root,
    'packaging',
    'evidence',
    'product-acceptance',
    `${SCENARIO_IDS[0]}.json`,
  );
  const bytes = Buffer.from('{"schemaVersion":1,"scenario":"clean-install-and-upgrade-rollback","candidateSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","result":"PASS"}\n', 'utf8');
  await fs.promises.writeFile(noncanonicalPath, bytes);
  noncanonical.selector.evidence[0].evidenceSha256 = digest(bytes);
  await rewriteSelector(noncanonical);
  await expectRejected(() => verifyProductAcceptanceCoverage({
    candidateSha: CANDIDATE_SHA,
    coveragePath: noncanonical.coveragePath,
  }));
});

test('writer refuses a pre-existing output path', async (t) => {
  const fixture = await makeFixture(t);
  const outPath = path.join(fixture.root, 'product-acceptance-evidence.json');
  await fs.promises.writeFile(outPath, 'already present\n');
  await expectRejected(() => writeProductAcceptanceCoverageEvidence({
    candidateSha: CANDIDATE_SHA,
    coveragePath: fixture.coveragePath,
    outPath,
  }));
});

test('writer produces canonical product acceptance evidence only after verification', async (t) => {
  const fixture = await makeFixture(t);
  const outPath = path.join(fixture.root, 'product-acceptance-evidence.json');
  const result = await writeProductAcceptanceCoverageEvidence({
    candidateSha: CANDIDATE_SHA,
    coveragePath: fixture.coveragePath,
    outPath,
  });
  assert.equal(await fs.promises.readFile(outPath, 'utf8'), canonicalJson(result));
});
