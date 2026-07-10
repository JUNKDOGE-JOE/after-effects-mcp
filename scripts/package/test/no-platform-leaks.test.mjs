import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PANEL_SRC_ROOT = path.join(REPO_ROOT, 'plugin', 'panel', 'src');
const CEP_ROOT = path.join(PANEL_SRC_ROOT, 'cep');
const PLATFORM_ROOT = path.join(CEP_ROOT, 'platform') + path.sep;

// These are intentionally temporary and exact-counted: the helper approval
// gate has not opened, so provider plaintext persistence cannot yet migrate to
// protected secret references. Do not add a whole-file exemption here.
const GATED_PLATFORM_ALLOWLIST = new Map([
  ['plugin/panel/src/cep/apiKey.js::native-path-home-module', 2],
  ['plugin/panel/src/cep/providerStore.js::native-path-home-module', 2],
  // Provider env shaping is part of the same gated provider-facade migration.
  ['plugin/panel/src/lib/providerProfile.js::windows-user-root-env', 4],
]);

const FORBIDDEN_PLATFORM_PATTERNS = [
  { id: 'runtime-platform-branch', pattern: /\b(?:process|os)\s*(?:\.\s*(?:platform|arch)\b|\[\s*['"](?:platform|arch)['"]\s*\])/ },
  { id: 'child-process-module', pattern: /(?:(?:\b[A-Za-z_$][\w$]*\s*\(|\)\s*\()\s*['"](?:node:)?child_process['"]|\bfrom\s*['"](?:node:)?child_process['"])/ },
  { id: 'native-path-home-module', pattern: /(?:(?:\b[A-Za-z_$][\w$]*\s*\(|\)\s*\()\s*['"](?:node:)?(?:os|path)['"]|\bfrom\s*['"](?:node:)?(?:os|path)['"])/ },
  { id: 'direct-exec-api', pattern: /(?<![.\w])(?:exec|execFile|execFileSync|execSync)\s*\(/ },
  { id: 'system-discovery-command', pattern: /['"](?:explorer(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|where(?:\.exe)?|which)['"]/i },
  { id: 'windows-user-root-env', pattern: /\b(?:LOCALAPPDATA|USERPROFILE)\b/ },
  { id: 'hard-coded-windows-path', pattern: /['"`](?:[A-Za-z]:\\\\|\\\\\\\\[^\\])/ },
  { id: 'hard-coded-macos-path', pattern: /['"`]\/(?:Applications|Users|opt\/homebrew|usr\/(?:bin|local\/bin))\// },
  { id: 'general-shell', pattern: /\bshell\s*:\s*true\b/ },
];

function countRule(text, rule) {
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : rule.pattern.flags + 'g');
  return Array.from(text.matchAll(pattern)).length;
}

test('platform leak rules catch aliased CEP module loaders', () => {
  const source = `const load = getCepRequire(); load('child_process'); load('node:path');`;
  assert.equal(countRule(source, FORBIDDEN_PLATFORM_PATTERNS.find((rule) => rule.id === 'child-process-module')), 1);
  assert.equal(countRule(source, FORBIDDEN_PLATFORM_PATTERNS.find((rule) => rule.id === 'native-path-home-module')), 1);
});

function panelBusinessFiles() {
  const pending = [PANEL_SRC_ROOT];
  const files = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (target !== PLATFORM_ROOT.slice(0, -1)) pending.push(target);
      } else if (/\.(?:cjs|js|jsx|mjs|ts|tsx)$/.test(entry.name)) {
        files.push(target);
      }
    }
  }
  return files.sort();
}

test('business modules do not branch on platform or invoke system discovery commands', () => {
  const leaks = [];
  const usedAllowances = new Set();
  const files = panelBusinessFiles();
  assert.equal(files.some((file) => file.endsWith(path.join('app', 'App.jsx'))), true, 'scanner must include JSX outside cep');
  assert.equal(files.some((file) => file.startsWith(PLATFORM_ROOT)), false, 'platform boundary itself must stay excluded');
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const rule of FORBIDDEN_PLATFORM_PATTERNS) {
      const count = countRule(text, rule);
      if (!count) continue;
      const relative = path.relative(REPO_ROOT, file);
      const allowanceKey = relative + '::' + rule.id;
      const allowedCount = GATED_PLATFORM_ALLOWLIST.get(allowanceKey);
      if (allowedCount === count) usedAllowances.add(allowanceKey);
      else leaks.push(relative + ' matches ' + rule.id + ' ' + count + ' time(s); allowed ' + (allowedCount || 0));
    }
  }
  for (const key of GATED_PLATFORM_ALLOWLIST.keys()) {
    if (!usedAllowances.has(key)) leaks.push('stale or count-mismatched gated allowlist: ' + key);
  }
  assert.deepEqual(leaks, []);

  const zcode = fs.readFileSync(path.join(CEP_ROOT, 'zcodeBackend.js'), 'utf8');
  for (const pattern of [/credentials\.json/, /decryptZcodeCredentialValue/, /readZcodeOAuthAccessToken/, /resolveZcodeCodingPlanApiKey/]) {
    assert.doesNotMatch(zcode, pattern, 'ZCode must not scrape or exchange desktop credentials');
  }
});
