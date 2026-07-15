#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GOVERNANCE_PATH = 'AGENTS.md';
export const INVENTORY_PATH = 'docs/checkpoints/2026-07-16-worktree-audit.md';

const REQUIRED_RULES = [
  '# Repository Development and Delivery Rules',
  '## 1. Measure outcomes, not activity',
  'public MCP surface',
  '## 4. Hardware validation is a merge gate',
  'Core, CEP host, native plugin',
  'POSSIBLY_SIDE_EFFECTING_FAILURE',
  'one worktree and one branch for each issue',
  '## 9. Completion evidence',
  '## 10. Stop conditions before starting the next issue',
];

const INITIAL_WORKTREES = [
  '<repo-root>',
  '<tmp>/ae-mcp-issue99-main-verify-1e6668a',
  '<tmp>/ae-mcp-main-101-final-e075a70',
  '<tmp>/ae-mcp-main-93-deploy',
  '<tmp>/ae-mcp-main-94-final-6c890776',
  '<tmp>/ae-mcp-main-96-deploy',
  '<tmp>/ae-mcp-main-p0-verify',
  '<tmp>/ae-mcp-rollback-29e7931',
  '<repo-root>/.worktrees/issue-101-native-layer-properties',
  '<repo-root>/.worktrees/issue-104-clean-main-2a166552',
  '<repo-root>/.worktrees/issue-104-native-composition-time',
  '<repo-root>/.worktrees/issue-106-native-selected-layers',
  '<repo-root>/.worktrees/issue-109-repo-governance',
  '<repo-root>/.worktrees/issue-71-sdk-intake',
  '<repo-root>/.worktrees/issue-72-native-rpc',
  '<repo-root>/.worktrees/issue-73-native-plugin',
  '<repo-root>/.worktrees/issue-74-authenticated-ipc',
  '<repo-root>/.worktrees/issue-75-native-core-backend',
  '<repo-root>/.worktrees/issue-76-public-native-read',
  '<repo-root>/.worktrees/issue-78-native-undoable-write',
  '<repo-root>/.worktrees/issue-95-cep-scan-root',
  '<repo-root>/.worktrees/issue-97-native-artifact-stage',
  '<repo-root>/.worktrees/issue-99-native-project-graph',
  '<repo-root>/.worktrees/macos-provider-integration',
  '<repo-root>/.worktrees/platform-contracts',
  '<repo-root>/.worktrees/post107-main-5261cea9d735',
];

export function validateGovernance({ agentsText, inventoryText, trackedPaths }) {
  const errors = [];
  for (const required of REQUIRED_RULES) {
    if (!agentsText.includes(required)) errors.push(`${GOVERNANCE_PATH} is missing required rule: ${required}`);
  }
  if (!trackedPaths.has(GOVERNANCE_PATH)) errors.push(`${GOVERNANCE_PATH} must be tracked by git`);
  if (!trackedPaths.has(INVENTORY_PATH)) errors.push(`${INVENTORY_PATH} must be tracked by git`);
  if (!inventoryText.includes('Initial registered worktrees: **26**')) {
    errors.push(`${INVENTORY_PATH} must record the 26-worktree baseline`);
  }
  for (const worktree of INITIAL_WORKTREES) {
    if (!inventoryText.includes(`\`${worktree}\``)) errors.push(`${INVENTORY_PATH} is missing ${worktree}`);
  }
  return errors;
}

export function parseWorktreePorcelain(text) {
  return text.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const fields = Object.fromEntries(block.split('\n').map((line) => {
      const separator = line.indexOf(' ');
      return separator === -1 ? [line, true] : [line.slice(0, separator), line.slice(separator + 1)];
    }));
    return fields;
  });
}

export function normalizeWorktreePath(worktreePath, repoRoot) {
  if (worktreePath === repoRoot) return '<repo-root>';
  if (worktreePath.startsWith(`${repoRoot}${path.sep}`)) {
    return `<repo-root>/${path.relative(repoRoot, worktreePath).split(path.sep).join('/')}`;
  }
  if (worktreePath.startsWith(`/private/tmp${path.sep}`)) return `<tmp>/${path.basename(worktreePath)}`;
  return `<external>/${path.basename(worktreePath)}`;
}

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
}

export function inspectLiveWorktrees(repoRoot, inventoryText, canonicalRoot = repoRoot) {
  const errors = [];
  const rows = parseWorktreePorcelain(git(repoRoot, ['worktree', 'list', '--porcelain'])).map((entry) => {
    const normalized = normalizeWorktreePath(entry.worktree, canonicalRoot);
    const status = git(entry.worktree, ['status', '--porcelain', '--untracked-files=normal']).trim();
    const dirty = status.length > 0;
    if (!inventoryText.includes(`\`${normalized}\``)) errors.push(`live worktree is undocumented: ${normalized}`);
    if (dirty && !inventoryText.includes(`\`${normalized}\` | retain-dirty`)) {
      errors.push(`dirty worktree lacks an explicit retain-dirty disposition: ${normalized}`);
    }
    return { path: normalized, head: entry.HEAD, branch: entry.branch ?? 'detached', dirty };
  });
  return { errors, rows };
}

function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(scriptPath), '..');
  const agentsText = fs.readFileSync(path.join(repoRoot, GOVERNANCE_PATH), 'utf8');
  const inventoryText = fs.readFileSync(path.join(repoRoot, INVENTORY_PATH), 'utf8');
  const trackedPaths = new Set(git(repoRoot, ['ls-files']).trim().split('\n'));
  const errors = validateGovernance({ agentsText, inventoryText, trackedPaths });
  let rows = [];
  if (process.argv.includes('--worktrees')) {
    const commonDir = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    const canonicalRoot = path.dirname(commonDir);
    const live = inspectLiveWorktrees(repoRoot, inventoryText, canonicalRoot);
    errors.push(...live.errors);
    rows = live.rows;
  }
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`ERROR: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Repository governance check passed (${INITIAL_WORKTREES.length} audited baseline worktrees).\n`);
  for (const row of rows) {
    process.stdout.write(`${row.dirty ? 'DIRTY' : 'clean'} ${row.path} ${row.head.slice(0, 12)} ${row.branch}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
