import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VERSION = '0.9.2';
const PLATFORM_ASSETS = [
  'ae-mcp-panel-v0.9.2-windows-x64.zxp',
];

const PYTHON_PROJECTS = [
  'packages/core/pyproject.toml',
  'packages/bridge/pyproject.toml',
  'packages/snapshot-mss/pyproject.toml',
];

const NODE_PROJECTS = [
  ['plugin/host/package.json', 'plugin/host/package-lock.json'],
  ['plugin/panel/package.json', 'plugin/panel/package-lock.json'],
  ['plugin/sidecar/package.json', 'plugin/sidecar/package-lock.json'],
];

const USER_DOCS = [
  'README.md',
  'README.zh-CN.md',
  'docs/INSTALL.md',
  'docs/REFERENCE.md',
  'docs/WORKFLOW.md',
];

const INSTALL_PATH_DOCS = [
  'README.md',
  'README.zh-CN.md',
  'docs/INSTALL.md',
  'docs/RELEASE.md',
];

async function text(relativePath) {
  return readFile(join(ROOT, relativePath), 'utf8');
}

async function json(relativePath) {
  return JSON.parse(await text(relativePath));
}

function projectVersion(toml, relativePath) {
  const project = toml.match(/(?:^|\n)\[project\]\n([\s\S]*?)(?=\n\[|$)/)?.[1] || '';
  const version = project.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  assert.ok(version, `${relativePath} must declare [project].version`);
  return version;
}

function uvWorkspaceVersions(lock) {
  const entries = new Map();
  for (const block of lock.split(/(?=^\[\[package\]\]$)/m)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
    const source = block.match(/^source\s*=\s*\{\s*editable\s*=\s*"([^"]+)"\s*\}\s*$/m)?.[1];
    if (name && version && source) entries.set(name, { version, source });
  }
  return entries;
}

function panelVersion(source) {
  return source.match(/PANEL_VERSION\s*=\s*['"]([^'"]+)['"];/)?.[1];
}

test('all active package and lockfile versions are v0.9.2', async () => {
  for (const relativePath of PYTHON_PROJECTS) {
    assert.equal(projectVersion(await text(relativePath), relativePath), VERSION, relativePath);
  }

  for (const [manifestPath, lockPath] of NODE_PROJECTS) {
    const manifest = await json(manifestPath);
    const lock = await json(lockPath);
    assert.equal(manifest.version, VERSION, manifestPath);
    assert.equal(lock.version, VERSION, lockPath);
    assert.equal(lock.packages?.['']?.version, VERSION, `${lockPath} packages[""]`);
  }

  const workspace = uvWorkspaceVersions(await text('uv.lock'));
  assert.deepEqual([...workspace.keys()].sort(), [
    'ae-mcp',
    'ae-mcp-bridge',
    'ae-mcp-snapshot-mss',
  ]);
  for (const [name, entry] of workspace) {
    assert.equal(entry.version, VERSION, `uv.lock ${name} (${entry.source})`);
  }
});

test('Panel source, generated bundle, and CEP manifest use the release version', async () => {
  const client = await text('plugin/panel/src/cep/mcpClient.js');
  assert.equal(panelVersion(client), VERSION, 'plugin/panel/src/cep/mcpClient.js');

  const bundle = await text('plugin/client/dist/app.js');
  assert.equal(panelVersion(bundle), VERSION, 'plugin/client/dist/app.js');

  const manifest = await text('plugin/CSXS/manifest.xml');
  assert.equal(manifest.match(/ExtensionBundleVersion="([^"]+)"/)?.[1], VERSION);
  assert.equal(manifest.match(/<Extension Id="com\.aemcp\.panel" Version="([^"]+)"/)?.[1], VERSION);
  assert.equal(manifest.match(/<Host Name="AEFT" Version="([^"]+)"/)?.[1], '[25.0,26.9]');
});

test('user docs describe the v0.9.2 platform assets and optional AI channel CLIs', async () => {
  for (const relativePath of USER_DOCS) {
    const body = await text(relativePath);
    assert.match(body, /v?0\.9\.2/, `${relativePath} release version`);
    for (const asset of PLATFORM_ASSETS) {
      assert.ok(body.includes(asset), `${relativePath} must name ${asset}`);
    }
    assert.match(body, /Claude Code/i, `${relativePath} Claude Code CLI`);
    assert.match(body, /Codex(?: CLI)?/i, `${relativePath} Codex CLI`);
    assert.match(body, /ZCode(?: CLI)?/i, `${relativePath} ZCode CLI`);
    assert.match(body, /optional|可选/i, `${relativePath} must mark channel CLIs optional`);
  }
});

test('normal install docs do not make an online uv tool install the user path', async () => {
  for (const relativePath of INSTALL_PATH_DOCS) {
    const body = await text(relativePath);
    assert.doesNotMatch(
      body,
      /^.*uv tool install.*(?:git\+https|github\.com).*$/mi,
      `${relativePath} contains a tag/network uv tool install example`,
    );
  }
});

test('release docs retain the hardened dual-platform design for v0.9.3 work', async () => {
  const release = await text('docs/RELEASE.md');
  for (const marker of [
    'build-rc.yml',
    'artifact-manifest-v0.9.2.json',
    'macos-rc-attestation',
    'windows-rc-attestation',
    'release.yml',
  ]) {
    assert.ok(release.includes(marker), `docs/RELEASE.md must name ${marker}`);
  }
  assert.match(release, /no[- ]rebuild|不重新构建|禁止重建/i);
  assert.match(release, /prerequisite|前置条件/i);
  assert.doesNotMatch(release, /one-day signer-preflight|保留 1 天/);
  assert.match(release,
    /保留 30 天[^\n]*Environment[^\n]*(?:缺失|不影响)[^\n]*四个晋级资产/);
  assert.match(release,
    /30-day[^\n]*Environment[^\n]*(?:missing|absence)[^\n]*four promotion assets/i);

  const changelog = await text('CHANGELOG.md');
  const firstRelease = changelog.match(/^### \[([^\]]+)\].*$/m)?.[1];
  assert.equal(firstRelease, VERSION);
  assert.match(changelog, /^### \[0\.9\.2\].*2026-07-13/mi);
});

test('user docs distinguish the Windows v0.9.2 release from deferred v0.9.3 work', async () => {
  const [readme, readmeZh, install, reference, release, workflow] = await Promise.all([
    readFile('README.md', 'utf8'),
    readFile('README.zh-CN.md', 'utf8'),
    readFile('docs/INSTALL.md', 'utf8'),
    readFile('docs/REFERENCE.md', 'utf8'),
    readFile('docs/RELEASE.md', 'utf8'),
    readFile('docs/WORKFLOW.md', 'utf8'),
  ]);

  assert.match(readme, /v0\.9\.2 Target Support Matrix/);
  assert.match(readmeZh, /v0\.9\.2 目标支持矩阵/);
  assert.match(readme, /historical v0\.9\.0 development wizard[\s\S]*online `uv`/i);
  assert.match(readmeZh, /历史 v0\.9\.0 开发向导[\s\S]*在线 `uv`/);
  assert.match(readme, /install-plugin-dev-macos\.sh/);
  assert.match(readmeZh, /install-plugin-dev-macos\.sh/);

  for (const value of [install, readme, readmeZh]) {
    assert.match(value, /Windows[\s\S]{0,400}v0\.9\.3/i);
    assert.match(value, /macOS[\s\S]{0,400}v0\.9\.3/i);
  }
  assert.doesNotMatch(workflow, /Mac 安装 DMG|install the DMG/i);
  assert.match(workflow, /受支持的 ZXP installer/);
  assert.match(workflow, /supported ZXP installer/i);
  assert.match(release, /six installed-runtime checks/i);
  assert.match(release, /六项 installed-runtime/);
  assert.match(release, /product-acceptance[\s\S]{0,300}blocked/i);

  assert.doesNotMatch(reference, /203 passed/);
  assert.doesNotMatch(reference, /24 passed/);
  assert.doesNotMatch(reference, /\| Handler count \| 30 verbs/);
  assert.match(reference, /\| Handler count \| 44 verbs/);
  assert.equal((reference.match(/\| `ae\.status` \|/g) || []).length, 2);
  assert.equal((reference.match(/\| `ae\.diagnose` \|/g) || []).length, 2);
  assert.match(reference, /operating-system temporary directory/i);
  assert.match(reference, /操作系统临时目录/);

  for (const value of [readme, readmeZh, workflow]) {
    assert.match(value, /\/Users\/<USER>\/\.ae-mcp\/bin\/ae-mcp/);
    assert.match(value, /RuntimeManager[\s\S]{0,400}(?:bare PATH|裸 PATH)/i);
  }
  assert.match(install, /\/Users\/<USER>\/\.ae-mcp\/bin\/ae-mcp/);
});

test('Windows handoff gates the outer shell to PowerShell Core 7.3 or newer', async () => {
  const prompt = await readFile('docs/WINDOWS_CODEX_RC_PROMPT.md', 'utf8');
  assert.match(prompt, /\$PSVersionTable\.PSEdition\s+-cne\s+'Core'/);
  assert.match(prompt, /\$PSVersionTable\.PSVersion\s+-lt\s+\[version\]'7\.3'/);
  const gateIndex = prompt.indexOf('if ($PSVersionTable.PSEdition');
  const inputIndex = prompt.indexOf("$Repository = '<OWNER/REPOSITORY>'");
  assert.ok(gateIndex >= 0 && gateIndex < inputIndex,
    'the shell gate must run before any handoff input is consumed');
  assert.match(prompt, /two artifact IDs|两个 artifact ID/i);
  assert.match(prompt, /AE 25[\s\S]{0,180}AE 26[\s\S]{0,180}ZXP installer[\s\S]{0,180}Codex version/i);
});
