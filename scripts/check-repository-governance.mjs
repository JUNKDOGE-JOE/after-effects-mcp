#!/usr/bin/env node

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const GOVERNANCE_PATH = 'AGENTS.md';
export const INVENTORY_PATH = 'docs/checkpoints/2026-07-16-worktree-audit.md';
export const GOVERNANCE_SHA256 = '0c82c647c42903154074c920a30298ebfae9238443a56b0b2541303f9c333d8e';
export const SUPPORTING_WORKFLOW_PATHS = [
  '.github/ISSUE_TEMPLATE/capability-package.md',
  '.github/pull_request_template.md',
  'docs/CAPABILITY_PACKAGE_WORKFLOW.md',
  'docs/templates/capability-package-completion.md',
];

const REQUIRED_RULES = [
  '# Repository Development and Delivery Rules',
  '## 1. Measure outcomes, not activity',
  'public MCP surface',
  '## 4. Layer hardware validation by native novelty and capability package',
  'Core, CEP host, native plugin',
  'POSSIBLY_SIDE_EFFECTING_FAILURE',
  'one worktree and one branch for each capability package',
  'one branch/worktree, one PR, one concentrated review',
  '## 9. Completion evidence',
  '## 10. Stop conditions before starting the next dependent capability package',
  'Do not implement issues by issue number or creation order.',
  'Automated tests and CI never substitute for hardware validation.',
  'After merge, repeat the public MCP package smoke from a clean `main` build.',
  'Never blindly repeat a possibly completed write.',
  'This is the candidate freeze.',
  '**T0, every edit:**',
  '**T6, clean-main acceptance:**',
  'no more than two concentrated review rounds by default',
  'fully local, non-evictable storage',
  'The WIP limit is one dependent native capability package.',
];

export const FINAL_WORKTREES = [
  '<repo-root>',
  '<repo-root>/.worktrees/platform-contracts',
];

export const REQUIRED_ARCHIVE_REFS = new Map([
  ['archive/rollback/issue-73-29e7931-20260716', '29e7931fc9b1243896c1ff473b7c7ceb61b68825'],
]);

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
  const agentsSha256 = createHash('sha256').update(agentsText).digest('hex');
  if (agentsSha256 !== GOVERNANCE_SHA256) {
    errors.push(`${GOVERNANCE_PATH} content changed; review and update the locked SHA-256 deliberately`);
  }
  for (const required of REQUIRED_RULES) {
    if (!agentsText.includes(required)) errors.push(`${GOVERNANCE_PATH} is missing required rule: ${required}`);
  }
  if (!trackedPaths.has(GOVERNANCE_PATH)) errors.push(`${GOVERNANCE_PATH} must be tracked by git`);
  if (!trackedPaths.has(INVENTORY_PATH)) errors.push(`${INVENTORY_PATH} must be tracked by git`);
  for (const workflowPath of SUPPORTING_WORKFLOW_PATHS) {
    if (!trackedPaths.has(workflowPath)) errors.push(`${workflowPath} must be tracked by git`);
  }
  if (!inventoryText.includes('Initial registered worktrees: **26**')) {
    errors.push(`${INVENTORY_PATH} must record the 26-worktree baseline`);
  }
  for (const worktree of INITIAL_WORKTREES) {
    if (!inventoryText.includes(`\`${worktree}\``)) errors.push(`${INVENTORY_PATH} is missing ${worktree}`);
  }
  const finalRows = extractFinalRetainedWorktrees(inventoryText);
  const actualFinal = [...finalRows.keys()].sort();
  const expectedFinal = [...FINAL_WORKTREES].sort();
  if (JSON.stringify(actualFinal) !== JSON.stringify(expectedFinal)) {
    errors.push(`${INVENTORY_PATH} final retained worktree set does not match the reviewed contract`);
  }
  return errors;
}

export function extractFinalRetainedWorktrees(inventoryText) {
  const section = inventoryText.match(/## Final retained registry\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? '';
  const rows = new Map();
  for (const match of section.matchAll(/^\| `([^`]+)` \| ([^|]+) \|/gm)) {
    rows.set(match[1], match[2].trim());
  }
  return rows;
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
  const finalRows = extractFinalRetainedWorktrees(inventoryText);
  const rows = parseWorktreePorcelain(git(repoRoot, ['worktree', 'list', '--porcelain'])).map((entry) => {
    const normalized = normalizeWorktreePath(entry.worktree, canonicalRoot);
    const status = git(entry.worktree, ['status', '--porcelain', '--untracked-files=normal']).trim();
    const dirty = status.length > 0;
    const isInvokingWorktree = path.resolve(entry.worktree) === path.resolve(repoRoot);
    if (!finalRows.has(normalized) && !isInvokingWorktree) {
      errors.push(`live worktree is outside the final retained set: ${normalized}`);
    }
    if (dirty && finalRows.get(normalized) !== 'retain-dirty') {
      errors.push(`dirty worktree lacks an explicit retain-dirty disposition: ${normalized}`);
    }
    return { path: normalized, head: entry.HEAD, branch: entry.branch ?? 'detached', dirty };
  });
  const livePaths = new Set(rows.map((row) => row.path));
  for (const missing of missingFinalWorktrees(livePaths)) {
    errors.push(`required retained worktree is missing: ${missing}`);
  }
  errors.push(...validateArchiveRefs((ref) => git(repoRoot, ['rev-parse', `${ref}^{commit}`]).trim()));
  return { errors, rows };
}

export function validateArchiveRefs(resolveRef) {
  const errors = [];
  for (const [ref, expected] of REQUIRED_ARCHIVE_REFS) {
    let actual;
    try {
      actual = resolveRef(ref);
    } catch {
      errors.push(`required archive ref is missing: ${ref}`);
      continue;
    }
    if (actual !== expected) {
      errors.push(`required archive ref points to ${actual}, expected ${expected}: ${ref}`);
    }
  }
  return errors;
}

export function missingFinalWorktrees(livePaths) {
  return FINAL_WORKTREES.filter((worktree) => !livePaths.has(worktree));
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
