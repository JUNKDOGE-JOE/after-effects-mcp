import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SCRIPT = 'scripts/release/smoke-installed-runtime.mjs';
const VERSION = '0.9.2';
const PLATFORM = 'macos-arm64';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeLauncherSource() {
  return `#!${process.execPath}
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const base = process.env.AE_MCP_HOME;
const config = JSON.parse(fs.readFileSync(path.join(base, 'fake-config.json'), 'utf8'));
const relative = fs.readFileSync(path.join(base, 'runtime', 'current'), 'utf8').trim();
const manifestPath = path.join(base, 'runtime', relative, 'runtime-manifest.json');
const manifestDigest = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
if (config.mutateRuntimeFile) {
  fs.appendFileSync(path.join(base, 'runtime', relative, 'python', 'bin', 'python3'), 'tampered');
}
const dangerous = Object.keys(process.env).filter((key) =>
  key === 'PYTHONPATH' || key === 'PYTHONHOME' || key === 'VIRTUAL_ENV' || key.startsWith('UV_')
);
fs.writeFileSync(path.join(base, 'captured-env.json'), JSON.stringify({
  dangerous,
  cwd: process.cwd(),
  path: process.env.PATH || '',
  providerSecretPresent: Object.values(process.env).includes('provider-secret-sentinel'),
  authTokenPresent: Object.values(process.env).includes('local-auth-token-sentinel'),
}));
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
function payload(name) {
  if (name === 'ae_status') return {
    ok: true,
    version: config.version,
    aeMajor: config.aeMajor,
    runtimeManifestSha256: config.manifestDigest || manifestDigest,
  };
  if (name === 'ae_diagnose') return { ok: true, ae: { responsive: true } };
  if (name === 'ae_previewFrame') return { ok: true, frames: [{ path: '/tmp/frame.png' }] };
  if (name === 'ae_snapshot') return { ok: true, path: '/tmp/snapshot.png' };
  return { ok: false, error: 'unexpected tool' };
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    fs.appendFileSync(path.join(base, 'calls.ndjson'), line + '\\n');
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      reply(message.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-installed-runtime', version: config.version },
      });
    } else if (message.method === 'tools/list') {
      reply(message.id, { tools: [
        { name: 'ae_status' }, { name: 'ae_diagnose' },
        { name: 'ae_previewFrame' }, { name: 'ae_snapshot' },
      ] });
    } else if (message.method === 'tools/call') {
      const body = payload(message.params.name);
      const failed = config.failTool === message.params.name || body.ok !== true;
      if (config.failTool === message.params.name) body.ok = false;
      reply(message.id, {
        content: [{ type: 'text', text: JSON.stringify(body) }],
        isError: failed,
      });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ae-mcp-installed-smoke-'));
  const base = join(root, '.ae-mcp');
  const runtimeRoot = join(base, 'runtime', VERSION, PLATFORM);
  const pythonPath = join(runtimeRoot, 'python', 'bin', 'python3');
  const launcher = join(base, 'bin', 'ae-mcp');
  const manifestPath = join(runtimeRoot, 'runtime-manifest.json');
  const out = join(root, 'smoke.json');
  const pythonBytes = Buffer.from('fixture bundled python');
  await mkdir(dirname(pythonPath), { recursive: true });
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(pythonPath, pythonBytes, { mode: 0o755 });
  const manifest = {
    schemaVersion: 1,
    platform: PLATFORM,
    node: { version: '24.17.0', assetSha256: 'a'.repeat(64) },
    python: {
      version: '3.13.14',
      distributionRelease: '20260610',
      assetSha256: 'b'.repeat(64),
    },
    licenseApprovals: [],
    components: [{
      name: 'fixture',
      version: '1.0.0',
      license: 'MIT',
      source: 'fixture',
      sha256: 'c'.repeat(64),
    }],
    files: [{
      path: 'python/bin/python3',
      sha256: sha256(pythonBytes),
      size: pythonBytes.length,
      mode: '0755',
      type: 'file',
    }],
  };
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  await writeFile(manifestPath, manifestBytes);
  await writeFile(join(base, 'runtime', 'current'), `${VERSION}/${PLATFORM}\n`);
  await writeFile(join(base, 'fake-config.json'), JSON.stringify({ version: VERSION, aeMajor: 25 }));
  const launcherBytes = fakeLauncherSource();
  await writeFile(launcher, launcherBytes, { mode: 0o755 });
  await chmod(launcher, 0o755);
  return {
    root, base, runtimeRoot, pythonPath, launcher, manifestPath, out,
    manifestSha256: sha256(manifestBytes),
    launcherSha256: sha256(launcherBytes),
  };
}

function smokeArgs(fixture, overrides = {}) {
  return [
    SCRIPT,
    '--launcher', overrides.launcher || fixture.launcher,
    '--runtime-manifest', fixture.manifestPath,
    '--expected-platform', overrides.platform || PLATFORM,
    '--expected-version', overrides.version || VERSION,
    '--expected-runtime-manifest-sha256', overrides.runtimeManifestSha256
      || fixture.manifestSha256,
    '--expected-launcher-sha256', overrides.launcherSha256 || fixture.launcherSha256,
    '--expected-ae-major', String(overrides.aeMajor || 25),
    '--out', overrides.out || fixture.out,
  ];
}

function runSmoke(fixture, overrides = {}) {
  const repositorySentinel = resolve('packages/core');
  return spawnSync(process.execPath, smokeArgs(fixture, overrides), {
    cwd: resolve('.'),
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      PATH: `${repositorySentinel}:${process.env.PATH || ''}`,
      PYTHONPATH: repositorySentinel,
      VIRTUAL_ENV: resolve('.venv'),
      UV_CACHE_DIR: join(fixture.root, 'uv-cache'),
      PROVIDER_HEADER_VALUE: 'provider-secret-sentinel',
      AE_MCP_AUTH_TOKEN: 'local-auth-token-sentinel',
    },
  });
}

test('installed-runtime smoke uses the selected stable launcher and records only six PASS checks', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const run = runSmoke(fixture);
  assert.equal(run.status, 0, run.stderr);
  const outputText = await readFile(fixture.out, 'utf8');
  const output = JSON.parse(outputText);
  const manifestDigest = sha256(await readFile(fixture.manifestPath));
  assert.deepEqual(Object.keys(output).sort(), [
    'aeMajor', 'checks', 'launcher', 'launcherSha256', 'platform',
    'runtimeManifestSha256', 'schemaVersion', 'version',
  ]);
  assert.equal(output.launcher, fixture.launcher);
  assert.equal(output.launcherSha256, fixture.launcherSha256);
  assert.equal(output.runtimeManifestSha256, manifestDigest);
  assert.deepEqual(output.checks, [
    { name: 'initialize', result: 'PASS' },
    { name: 'tools/list', result: 'PASS' },
    { name: 'ae.status', result: 'PASS' },
    { name: 'ae.diagnose', result: 'PASS' },
    { name: 'ae.previewFrame', result: 'PASS' },
    { name: 'ae.snapshot', result: 'PASS' },
  ]);
  for (const forbidden of [
    'provider-secret-sentinel', 'local-auth-token-sentinel', 'PYTHONPATH',
    'VIRTUAL_ENV', 'UV_CACHE_DIR', resolve('packages/core'),
  ]) {
    assert.equal(outputText.includes(forbidden), false, `output leaked ${forbidden}`);
  }

  const captured = JSON.parse(await readFile(join(fixture.base, 'captured-env.json'), 'utf8'));
  assert.deepEqual(captured.dangerous, []);
  assert.equal(captured.providerSecretPresent, false);
  assert.equal(captured.authTokenPresent, false);
  assert.equal(captured.path.includes(resolve('packages/core')), false);
  assert.equal(captured.cwd, await realpath(fixture.runtimeRoot));

  const calls = (await readFile(join(fixture.base, 'calls.ndjson'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.filter((item) => item.id).map((item) => item.method), [
    'initialize', 'tools/list', 'tools/call', 'tools/call', 'tools/call', 'tools/call',
  ]);
  assert.deepEqual(
    calls.filter((item) => item.method === 'tools/call').map((item) => item.params.name),
    ['ae_status', 'ae_diagnose', 'ae_previewFrame', 'ae_snapshot'],
  );
});

test('installed-runtime smoke rejects an unselected launcher or changed runtime file', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const outsideLauncher = join(fixture.root, 'outside-launcher');
  await copyFile(fixture.launcher, outsideLauncher);
  await chmod(outsideLauncher, 0o755);
  const outside = runSmoke(fixture, { launcher: outsideLauncher });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /stable launcher.*runtime home/i);

  await writeFile(fixture.pythonPath, 'mutated bundled python');
  const mutated = runSmoke(fixture);
  assert.notEqual(mutated.status, 0);
  assert.match(mutated.stderr, /runtime file digest mismatch/i);
});

test('installed-runtime smoke rejects any unmanifested runtime leaf', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await writeFile(join(fixture.runtimeRoot, 'unmanifested-loader.js'), 'unexpected runtime code');
  const extra = runSmoke(fixture);
  assert.notEqual(extra.status, 0);
  assert.match(extra.stderr, /unmanifested runtime entry/i);
});

test('installed-runtime smoke re-verifies selected bytes after the MCP process exits', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await writeFile(join(fixture.base, 'fake-config.json'), JSON.stringify({
    version: VERSION,
    aeMajor: 25,
    mutateRuntimeFile: true,
  }));
  const mutated = runSmoke(fixture);
  assert.notEqual(mutated.status, 0);
  assert.match(mutated.stderr, /runtime file (?:metadata|digest) mismatch/i);
});

test('installed-runtime smoke never overwrites an existing evidence file', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await writeFile(fixture.out, 'existing-evidence');
  const run = runSmoke(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /EEXIST|already exists/i);
  assert.equal(await readFile(fixture.out, 'utf8'), 'existing-evidence');
});

test('installed-runtime smoke rejects platform, version, manifest digest, and AE-major mismatches', async (t) => {
  const fixture = await makeFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const platform = runSmoke(fixture, { platform: 'windows-x64' });
  assert.notEqual(platform.status, 0);
  assert.match(platform.stderr, /platform mismatch/i);

  const version = runSmoke(fixture, { version: '0.9.2' });
  assert.notEqual(version.status, 0);
  assert.match(version.stderr, /version mismatch/i);

  const installedManifest = runSmoke(fixture, { runtimeManifestSha256: 'e'.repeat(64) });
  assert.notEqual(installedManifest.status, 0);
  assert.match(installedManifest.stderr, /installed runtime manifest digest mismatch/i);

  const launcher = runSmoke(fixture, { launcherSha256: 'f'.repeat(64) });
  assert.notEqual(launcher.status, 0);
  assert.match(launcher.stderr, /installed stable launcher digest mismatch/i);

  await writeFile(join(fixture.base, 'fake-config.json'), JSON.stringify({
    version: VERSION,
    aeMajor: 25,
    manifestDigest: 'd'.repeat(64),
  }));
  const manifest = runSmoke(fixture);
  assert.notEqual(manifest.status, 0);
  assert.match(manifest.stderr, /runtime manifest digest mismatch/i);

  await writeFile(join(fixture.base, 'fake-config.json'), JSON.stringify({
    version: VERSION,
    aeMajor: 26,
  }));
  const aeMajor = runSmoke(fixture);
  assert.notEqual(aeMajor.status, 0);
  assert.match(aeMajor.stderr, /AE major mismatch/i);
});

test('platform RC wrappers enforce exact installed-runtime verification without rebuilding', async () => {
  const mac = await readFile('scripts/release/verify-rc-macos.sh', 'utf8');
  const windows = await readFile('scripts/release/verify-rc-windows.ps1', 'utf8');

  for (const required of [
    'set -euo pipefail', 'shasum -a 256', 'codesign --verify --deep --strict',
    'spctl --assess', 'xcrun stapler validate', 'ae-mcp-ae25-smoke.json',
    'ae-mcp-ae26-smoke.json', '--expected-runtime-manifest-sha256',
    '--expected-launcher-sha256',
    'uname -m', 'sw_vers -productVersion',
    'runtime/macos-arm64/runtime-manifest.json', 'write-attestation.mjs',
  ]) assert.match(mac, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const required of [
    "$ErrorActionPreference = 'Stop'", 'Get-FileHash', '-Algorithm SHA256',
    'Get-AuthenticodeSignature', 'ae-mcp-ae25-smoke.json',
    'ae-mcp-ae26-smoke.json', '--expected-runtime-manifest-sha256',
    '--expected-launcher-sha256',
    'PROCESSOR_ARCHITECTURE', 'Win32_OperatingSystem', '26100',
    'runtime/windows-x64/runtime-manifest.json', 'write-attestation.mjs',
  ]) assert.ok(windows.includes(required), `Windows wrapper is missing ${required}`);

  const forbidden = /(?:^|[\s"'&;])(?:uv|python(?:3)?|pip)(?:\s|$)|git\s+(?:add|commit)|build-portable-runtime|stage-platform-bundle|package-zxp/mi;
  assert.doesNotMatch(mac, forbidden);
  assert.doesNotMatch(windows, forbidden);
});

test('Windows Codex handoff fixes the verifier to exact artifact bytes and one PR comment', async () => {
  const prompt = await readFile('docs/WINDOWS_CODEX_RC_PROMPT.md', 'utf8');
  const exactBlock = `You are the Windows x64 release verifier for ae-mcp. Test and report only; do not modify files, commit, push, or rebuild artifacts.

1. Fetch the repository and checkout the exact candidate SHA supplied below.
2. Confirm \`git status --short\` is empty and \`git rev-parse HEAD\` equals the candidate SHA.
3. Download only the specified GitHub Actions run/artifact ID.
4. Run \`scripts/release/verify-rc-windows.ps1\` with the supplied artifact and manifest.
5. Exercise AE 25.x and AE 26.x using the script checklist; capture failure evidence without changing source.
6. Post the exact comment emitted by \`write-attestation.mjs\` to the supplied merged RC PR.
7. If any step fails, report FAIL. Never convert a partial run into PASS.

Required inputs: repository, merged RC PR number, candidate SHA, workflow run ID, artifact ID, artifact filename, manifest filename.`;
  assert.ok(prompt.includes(exactBlock));
  assert.match(prompt, /comment must be resolvable on the current PR/i);
});

test('Windows Codex handoff is exact-identity and fails closed without a tested comment file', async () => {
  const prompt = await readFile('docs/WINDOWS_CODEX_RC_PROMPT.md', 'utf8');

  for (const required of [
    '<OWNER/REPOSITORY>', '<MERGED_RC_PR_NUMBER>', '<CANDIDATE_SHA>', '<BUILD_RUN_ID>',
    '<WINDOWS_ARTIFACT_ID>', '<MANIFEST_ARTIFACT_ID>', '<AE25_AFTERFX_EXE>',
    '<AE26_AFTERFX_EXE>', '<ZXP_INSTALLER>', '<CODEX_VERSION>',
    'ae-mcp-panel-v0.9.2-windows-x64.zxp', 'artifact-manifest-v0.9.2.json',
    'run_attempt', 'workflow_dispatch', '.github/workflows/build-rc.yml',
    'expired', 'gh api', 'gh run download', 'git status --porcelain',
    '--comment-out', '--input', 'UTF8Encoding',
    '$PSNativeCommandUseErrorActionPreference = $true',
    'validate-attestation-comment.mjs', '--paginate', '--slurp',
  ]) assert.ok(prompt.includes(required), `Windows handoff is missing ${required}`);

  assert.match(prompt, /run_attempt[^\n]*(?:-ne|must equal|equals?)\s*1/i);
  assert.match(prompt, /merged[^\n]*merge_commit_sha[^\n]*candidate/i);
  assert.match(prompt, /artifact ID[^\n]*exact name[^\n]*not expired/i);
  assert.match(prompt, /AE 25[\s\S]{0,240}AfterFX\.exe[\s\S]{0,400}AE 26[\s\S]{0,240}AfterFX\.exe/i);
  assert.match(prompt, /GUI[\s\S]{0,240}ae-mcp panel/i);
  assert.match(prompt, /no unsaved AE work|no unsaved After Effects work/i);
  assert.match(prompt, /same comment ID[\s\S]{0,400}artifact SHA-256/i);
  assert.match(prompt, /valid canonical FAIL[\s\S]{0,240}blocker/i);
  assert.match(prompt, /Never reconstruct[\s\S]{0,160}PASS/i);
  assert.match(prompt, /PowerShell success stream[\s\S]{0,240}not (?:the )?raw (?:Node writer )?stdout bytes/i);
  assert.match(prompt, /UTF-8 round trip[\s\S]{0,240}(?:does not|cannot) prove/i);
  assert.match(prompt, /tested[\s\S]{0,160}--comment-out/i);
  assert.match(prompt, /(?:interface is absent|contract tests have not passed)[\s\S]{0,180}post nothing[\s\S]{0,80}blocker/i);
  assert.match(prompt, /post nothing[\s\S]{0,160}blocker/i);
  assert.match(prompt, /all PR comments[\s\S]{0,320}(?:malformed|invalid)[\s\S]{0,160}block/i);
  assert.match(prompt, /platform[\s\S]{0,240}candidate[\s\S]{0,240}run[\s\S]{0,240}artifact[\s\S]{0,320}(?:exactly|strictly) zero/i);
  assert.match(prompt, /POST[\s\S]{0,240}(?:uncertain|unknown outcome)[\s\S]{0,160}(?:never|do not) retry/i);
  assert.match(prompt, /one Windows verifier session[\s\S]{0,240}(?:coordination ownership|协调权)/i);
  assert.match(prompt, /zero-match[\s\S]{0,200}POST[\s\S]{0,200}not atomic/i);
  assert.match(prompt, /(?:forbid|do not allow|禁止)[\s\S]{0,120}concurrent/i);
  assert.doesNotMatch(prompt, /\$StdoutCopy|RedirectStandardOutput\s*=\s*\$true|--raw-field[\s\S]{0,80}body=/,
    'the prompt must not present PowerShell stream capture or a multiline CLI field as lossless');
  assert.doesNotMatch(prompt, /if \(Test-Path[^\n]+-or Test-Path/,
    'each Test-Path command in a boolean expression must be parenthesized');
  assert.equal((prompt.match(/--method POST/g) || []).length, 1,
    'the gated future flow must contain exactly one comment creation call');
});
