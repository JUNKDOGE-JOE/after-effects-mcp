import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import {
  GOVERNANCE_PATH,
  INVENTORY_PATH,
  normalizeWorktreePath,
  parseWorktreePorcelain,
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
