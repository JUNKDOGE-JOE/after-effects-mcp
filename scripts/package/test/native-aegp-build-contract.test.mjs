import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const BUILD_SCRIPT = await fs.promises.readFile(
  'native/ae-plugin/build-macos.mjs',
  'utf8',
);
const PLUGIN_ENTRY = await fs.promises.readFile(
  'native/ae-plugin/src/aegp/plugin_entry.cpp',
  'utf8',
);

test('native mac build consumes both locked SDK inputs and records combined evidence', () => {
  assert.match(BUILD_SCRIPT, /verifyAeSdkInput\(\{/u);
  assert.match(BUILD_SCRIPT, /archivePath: sdkArchiveInput/u);
  assert.match(BUILD_SCRIPT, /if \(!verification\.sdkRootReady\)/u);
  assert.match(BUILD_SCRIPT, /archiveVerification: sdkVerification\.archiveVerification/u);
  assert.match(BUILD_SCRIPT, /rootVerification: sdkVerification\.rootVerification/u);
  assert.match(BUILD_SCRIPT, /inputProvenance: sdkVerification\.provenance/u);
});

test('native mac build rejects every Git boundary and cannot build into an AE scan root', () => {
  assert.match(BUILD_SCRIPT, /'worktree', 'list', '--porcelain'/u);
  assert.match(BUILD_SCRIPT, /'rev-parse', '--git-common-dir'/u);
  assert.match(BUILD_SCRIPT, /assertOutsideBoundaries\(sdkRoot/u);
  assert.match(BUILD_SCRIPT, /assertOutsideBoundaries\(sdkArchive/u);
  assert.match(BUILD_SCRIPT, /realpath\('\/private\/tmp'\)/u);
  assert.doesNotMatch(BUILD_SCRIPT, /os\.tmpdir/u);
  assert.match(
    BUILD_SCRIPT,
    /native development builds are restricted to canonical \/private\/tmp/u,
  );
});

test('native mac build compiles product Git blobs from a private minimal SDK snapshot', () => {
  assert.match(BUILD_SCRIPT, /gitFileBytes\(sourceCommit/u);
  assert.match(BUILD_SCRIPT, /\.restricted-sdk-snapshot/u);
  assert.match(BUILD_SCRIPT, /path\.join\(sdkRoot, 'Examples', 'Headers'\)/u);
  assert.match(BUILD_SCRIPT, /'Resources', 'AE_General\.r'/u);
  assert.doesNotMatch(
    BUILD_SCRIPT,
    /fs\.promises\.cp\(\s*path\.join\(sdkRoot, 'Examples', 'Resources'\)/u,
  );
  assert.match(BUILD_SCRIPT, /fs\.promises\.rm\(sdkSnapshot, \{ recursive: true \}\)/u);
  assert.match(BUILD_SCRIPT, /AE_MCP_SOURCE_COMMIT/u);
  assert.match(BUILD_SCRIPT, /AE_PLUGIN_BUILD_IO_FAILED/u);
  assert.match(BUILD_SCRIPT, /AE_PLUGIN_BUILD_CLEANUP_REQUIRED/u);
  assert.doesNotMatch(BUILD_SCRIPT, /cleanup did not complete.*stage/u);
});

test('native mac build emits the AE-recognized AEGP package metadata', async () => {
  const [verifier, plist] = await Promise.all([
    fs.promises.readFile('native/ae-plugin/verify-macos.mjs', 'utf8'),
    fs.promises.readFile('native/ae-plugin/resources/Info.plist', 'utf8'),
  ]);
  assert.match(plist, /<key>CFBundleSignature<\/key>\s*<string>FXTC<\/string>/u);
  assert.match(BUILD_SCRIPT, /Buffer\.from\('AEgxFXTC', 'ascii'\)/u);
  assert.match(verifier, /'Contents\/PkgInfo'/u);
  assert.match(verifier, /Buffer\.from\('AEgxFXTC', 'ascii'\)/u);
});

test('native boot probe starts its deadline at the first AE idle callback', () => {
  const submitStart = PLUGIN_ENTRY.indexOf('void submit_boot_probe_once(');
  const idleStart = PLUGIN_ENTRY.indexOf('A_Err idle_hook(');
  const namespaceEnd = PLUGIN_ENTRY.indexOf('}  // namespace', idleStart);
  const entryStart = PLUGIN_ENTRY.indexOf('extern "C"', namespaceEnd);
  assert.notEqual(submitStart, -1);
  assert.notEqual(idleStart, -1);
  assert.notEqual(namespaceEnd, -1);
  assert.notEqual(entryStart, -1);

  const submitBootProbe = PLUGIN_ENTRY.slice(submitStart, idleStart);
  const idleHook = PLUGIN_ENTRY.slice(idleStart, namespaceEnd);
  const pluginEntry = PLUGIN_ENTRY.slice(entryStart);
  assert.match(submitBootProbe, /PluginState& state\) noexcept/u);
  assert.match(submitBootProbe, /if \(state\.boot_probe_submitted\) return;/u);
  assert.match(submitBootProbe, /state\.boot_probe_submitted = true;\s*try \{/u);
  assert.match(submitBootProbe, /"boot-project-summary"/u);
  assert.match(submitBootProbe, /state\.clock\.now\(\) \+ 60s/u);
  assert.match(submitBootProbe, /catch \(\.\.\.\)/u);
  assert.match(idleHook, /submit_boot_probe_once\(\*state\)[\s\S]*dispatcher\.drain/u);
  assert.doesNotMatch(pluginEntry, /"boot-project-summary"/u);
});

test('native README examples use safe shell variables and the complete build inputs', async () => {
  for (const readmePath of ['README.md', 'README.zh-CN.md']) {
    const readme = await fs.promises.readFile(readmePath, 'utf8');
    const start = readme.indexOf('native/ae-plugin/build-macos.mjs');
    const end = readme.indexOf('CEP', start);
    assert.notEqual(start, -1, `${readmePath} has no native build example`);
    const section = readme.slice(start, end === -1 ? undefined : end);
    assert.match(section, /--sdk-archive "\$AE_SDK_ARCHIVE"/u);
    assert.match(section, /--sdk-root "\$AE_SDK_ROOT"/u);
    assert.match(section, /--output "\$BUILD_DIR"/u);
    assert.match(section, /--transaction "\$TRANSACTION_ID"/u);
    assert.match(section, /native-plugin-dev-v1/u);
    assert.doesNotMatch(section, /<(?:commit|transactionId)>/u);
  }
});
