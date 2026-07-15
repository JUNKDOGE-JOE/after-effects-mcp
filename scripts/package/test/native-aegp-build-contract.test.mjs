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
const INFO_PLIST = await fs.promises.readFile(
  'native/ae-plugin/resources/Info.plist',
  'utf8',
);
const VERIFIER = await fs.promises.readFile(
  'native/ae-plugin/verify-macos.mjs',
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

test('native product version is derived from the exact commit and bound across the artifact', () => {
  assert.match(BUILD_SCRIPT, /PRODUCT_MANIFEST_PATH = 'plugin\/host\/package\.json'/u);
  assert.match(
    BUILD_SCRIPT,
    /gitFileBytes\(sourceCommit, PRODUCT_MANIFEST_PATH\)/u,
  );
  assert.match(BUILD_SCRIPT, /PRODUCT_VERSION_TOKEN/u);
  assert.match(BUILD_SCRIPT, /replaceExactlyOnce\(/u);
  assert.match(BUILD_SCRIPT, /-DAE_MCP_PRODUCT_VERSION=/u);
  assert.match(BUILD_SCRIPT, /expectedProductVersion: productVersion/u);
  assert.doesNotMatch(BUILD_SCRIPT, /AE_MCP_PRODUCT_VERSION[^\n]*(?:process\.env|environment)/u);
  assert.doesNotMatch(BUILD_SCRIPT, /--product-version/u);

  assert.equal(
    INFO_PLIST.match(/__AE_MCP_PRODUCT_VERSION__/gu)?.length,
    1,
    'Info.plist must contain exactly one deterministic product version token',
  );
  assert.match(PLUGIN_ENTRY, /#ifndef AE_MCP_PRODUCT_VERSION/u);
  assert.match(PLUGIN_ENTRY, /kPluginVersion = AE_MCP_PRODUCT_VERSION/u);
  assert.match(VERIFIER, /CFBundleShortVersionString/u);
  assert.match(VERIFIER, /PIPL_COMPATIBILITY_VERSION = 0x00010000/u);
  assert.match(VERIFIER, /JSON\.stringify\(exported\).*\['_AeMcpNativeMain'\]/u);
  assert.match(VERIFIER, /data 'PiPL' \(16000\)/u);
  assert.match(
    VERIFIER,
    /assertPiplProperty\(resourceBytes, 'vers', piplCompatibilityVersion\)/u,
  );

  for (const source of [BUILD_SCRIPT, INFO_PLIST, PLUGIN_ENTRY, VERIFIER]) {
    assert.doesNotMatch(source, /0\.1\.0(?:-dev)?/u);
  }
});

test('native mac build emits the AE-recognized AEGP package metadata', async () => {
  assert.match(INFO_PLIST, /<key>CFBundleSignature<\/key>\s*<string>FXTC<\/string>/u);
  assert.match(BUILD_SCRIPT, /Buffer\.from\('AEgxFXTC', 'ascii'\)/u);
  assert.match(VERIFIER, /'Contents\/PkgInfo'/u);
  assert.match(VERIFIER, /Buffer\.from\('AEgxFXTC', 'ascii'\)/u);
});

test('native idle hook drains only real authenticated requests', () => {
  const idleStart = PLUGIN_ENTRY.indexOf('A_Err idle_hook(');
  const namespaceEnd = PLUGIN_ENTRY.indexOf('}  // namespace', idleStart);
  const entryStart = PLUGIN_ENTRY.indexOf('extern "C"', namespaceEnd);
  assert.notEqual(idleStart, -1);
  assert.notEqual(namespaceEnd, -1);
  assert.notEqual(entryStart, -1);

  const idleHook = PLUGIN_ENTRY.slice(idleStart, namespaceEnd);
  const pluginEntry = PLUGIN_ENTRY.slice(entryStart);
  assert.match(idleHook, /state->dispatcher\.drain\(host\)/u);
  assert.doesNotMatch(PLUGIN_ENTRY, /submit_boot_probe_once|boot_probe_submitted/u);
  assert.doesNotMatch(idleHook, /dispatcher\.enqueue/u);
  assert.doesNotMatch(pluginEntry, /"boot-project-summary"/u);
});

test('native pairing command is enabled by the AE update-menu hook', () => {
  assert.match(PLUGIN_ENTRY, /A_Err update_menu_hook\(/u);
  assert.match(
    PLUGIN_ENTRY,
    /AEGP_EnableCommand\(\s*state->pairing_command\s*\)/u,
  );
  assert.match(
    PLUGIN_ENTRY,
    /AEGP_RegisterUpdateMenuHook\(\s*plugin_id, update_menu_hook, 0\s*\)/u,
  );
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
