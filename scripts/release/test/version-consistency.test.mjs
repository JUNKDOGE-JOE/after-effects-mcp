import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const VERSION = '0.10.3';

async function text(relative) {
  return fs.readFile(relative, 'utf8');
}

async function json(relative) {
  return JSON.parse(await text(relative));
}

test('active Node package versions agree with the release version', async () => {
  const [host, hostLock, panel] = await Promise.all([
    json('plugin/host/package.json'),
    json('plugin/host/package-lock.json'),
    json('plugin/panel/package.json'),
  ]);
  assert.equal(host.version, VERSION);
  assert.equal(hostLock.version, VERSION);
  assert.equal(hostLock.packages[''].version, VERSION);
  assert.equal(panel.version, VERSION);
  assert.equal(host.dependencies.express, '4.22.2');
});

test('native build scripts keep the release version placeholder contract', async () => {
  const [build, entry, info] = await Promise.all([
    text('native/ae-plugin/build-macos.mjs'),
    text('native/ae-plugin/src/aegp/plugin_entry.cpp'),
    text('native/ae-plugin/resources/Info.plist'),
  ]);
  assert.match(build, /-DAE_MCP_PRODUCT_VERSION=/u);
  assert.match(entry, /kPluginVersion = AE_MCP_PRODUCT_VERSION/u);
  assert.equal(info.match(/__AE_MCP_PRODUCT_VERSION__/gu)?.length, 1);
});

test('the public setup text names the two supported connection forms', async () => {
  const [readme, readmeZh, install] = await Promise.all([
    text('README.md'),
    text('README.zh-CN.md'),
    text('docs/INSTALL.md'),
  ]);
  for (const body of [readme, readmeZh, install]) {
    assert.match(body, /127\.0\.0\.1:11488\/mcp/u);
    assert.match(body, /host\/stdio-shim\.js/u);
    assert.doesNotMatch(body, /uv|Python|sidecar|ae-mcp\.exe/iu);
  }
  assert.match(readme, /claude mcp add --transport http ae http:\/\/127\.0\.0\.1:11488\/mcp/u);
  assert.match(readmeZh, /claude mcp add --transport http ae http:\/\/127\.0\.0\.1:11488\/mcp/u);
});

test('the direct ZXP package script stages only the bundled runtime, no retired payloads', async () => {
  const source = await text('scripts/package-zxp.ps1');
  assert.match(source, /\$payloadRoots = @\('client', 'CSXS', 'host', 'icons', 'jsx', 'shared'\)/u);
  assert.match(source, /npm ci --omit=dev/u);
  assert.match(source, /Signing ZXP once/u);
  // The bundled OpenCode runtime is a supported payload since 0.10.3; the
  // retired sidecar/helper executables must never return to this script.
  assert.match(source, /runtime-staging\\opencode\\opencode\.exe/u);
  assert.doesNotMatch(source, /sidecar|helper|ae-mcp\.exe/iu);
});

test('CI has no package-server workflow', async () => {
  const names = await fs.readdir('.github/workflows');
  for (const name of names) {
    if (!name.endsWith('.yml') && !name.endsWith('.yaml')) continue;
    assert.doesNotMatch(await text(`.github/workflows/${name}`), /python/iu, name);
  }
});

test('retired package roots and lockfiles are absent', async () => {
  for (const relative of ['packages', 'plugin/sidecar', 'pyproject.toml', 'uv.lock']) {
    await assert.rejects(fs.access(relative), undefined, relative);
  }
});
