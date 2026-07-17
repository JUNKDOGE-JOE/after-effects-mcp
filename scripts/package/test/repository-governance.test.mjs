import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import {
  GOVERNANCE_PATH,
  FINAL_WORKTREES,
  INVENTORY_PATH,
  REQUIRED_ARCHIVE_REFS,
  extractFinalRetainedWorktrees,
  normalizeWorktreePath,
  missingFinalWorktrees,
  parseWorktreePorcelain,
  validateArchiveRefs,
  validateGovernance,
} from '../../check-repository-governance.mjs';

test('tracked repository rules and worktree baseline pass the governance contract', () => {
  const agentsText = fs.readFileSync(GOVERNANCE_PATH, 'utf8');
  const inventoryText = fs.readFileSync(INVENTORY_PATH, 'utf8');
  const errors = validateGovernance({
    agentsText,
    inventoryText,
    trackedPaths: new Set([GOVERNANCE_PATH, INVENTORY_PATH]),
  });
  assert.deepEqual(errors, []);
});

test('missing delivery rules and untracked governance files fail closed', () => {
  const errors = validateGovernance({ agentsText: '', inventoryText: '', trackedPaths: new Set() });
  assert.ok(errors.some((error) => error.includes('public MCP surface')));
  assert.ok(errors.some((error) => error.includes('must be tracked by git')));
  assert.ok(errors.some((error) => error.includes('26-worktree baseline')));
});

test('semantic rule reversal and final retained-set removal fail closed', () => {
  const agentsText = fs.readFileSync(GOVERNANCE_PATH, 'utf8');
  const inventoryText = fs.readFileSync(INVENTORY_PATH, 'utf8');
  const trackedPaths = new Set([GOVERNANCE_PATH, INVENTORY_PATH]);
  const weakened = agentsText.replace(
    'Automated tests and CI never substitute for hardware validation.',
    'Automated tests and CI fully substitute for hardware validation.',
  );
  assert.ok(validateGovernance({ agentsText: weakened, inventoryText, trackedPaths })
    .some((error) => error.includes('locked SHA-256')));
  const otherWeakening = agentsText.replace(
    'Use one worktree and one branch for each capability package.',
    'Do not use one worktree and one branch for each capability package.',
  );
  assert.ok(validateGovernance({ agentsText: otherWeakening, inventoryText, trackedPaths })
    .some((error) => error.includes('locked SHA-256')));
  const withoutFinalSet = inventoryText.replace(/## Final retained registry[\s\S]*?(?=\n## Cleanup execution record)/, '');
  assert.ok(validateGovernance({ agentsText, inventoryText: withoutFinalSet, trackedPaths })
    .some((error) => error.includes('final retained worktree set')));
  assert.equal(extractFinalRetainedWorktrees(withoutFinalSet).size, 0);
});

test('live registry validation rejects a missing required retained worktree', () => {
  assert.deepEqual(missingFinalWorktrees(new Set(FINAL_WORKTREES)), []);
  assert.deepEqual(
    missingFinalWorktrees(new Set(FINAL_WORKTREES.slice(1))),
    [FINAL_WORKTREES[0]],
  );
});

test('post-#126 retained set keeps only root and the dirty platform WIP', () => {
  assert.deepEqual(FINAL_WORKTREES, [
    '<repo-root>',
    '<repo-root>/.worktrees/platform-contracts',
  ]);
});

test('rollback archive ref must exist and peel to the audited commit', () => {
  const [[ref, sha]] = REQUIRED_ARCHIVE_REFS;
  assert.deepEqual(validateArchiveRefs((candidate) => {
    assert.equal(candidate, ref);
    return sha;
  }), []);
  assert.match(validateArchiveRefs(() => '0'.repeat(40))[0], /expected/u);
  assert.match(validateArchiveRefs(() => { throw new Error('missing'); })[0], /missing/u);
});

test('worktree porcelain parsing and path normalization are deterministic', () => {
  const parsed = parseWorktreePorcelain([
    'worktree /repo',
    `HEAD ${'a'.repeat(40)}`,
    'branch refs/heads/main',
    '',
    'worktree /private/tmp/verify',
    `HEAD ${'b'.repeat(40)}`,
    'detached',
    '',
  ].join('\n'));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].detached, true);
  assert.equal(normalizeWorktreePath('/repo/.worktrees/issue-1', '/repo'), '<repo-root>/.worktrees/issue-1');
  assert.equal(normalizeWorktreePath('/private/tmp/verify', '/repo'), '<tmp>/verify');
});
