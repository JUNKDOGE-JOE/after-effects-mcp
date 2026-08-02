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
  const entryStart = PLUGIN_ENTRY.indexOf('extern "C"', idleStart);
  assert.notEqual(idleStart, -1);
  assert.notEqual(entryStart, -1);

  const idleHook = PLUGIN_ENTRY.slice(idleStart, entryStart);
  const pluginEntry = PLUGIN_ENTRY.slice(entryStart);
  assert.match(idleHook, /state->dispatcher\.drain\(host\)/u);
  assert.doesNotMatch(PLUGIN_ENTRY, /submit_boot_probe_once|boot_probe_submitted/u);
  assert.doesNotMatch(idleHook, /dispatcher\.enqueue/u);
  assert.doesNotMatch(pluginEntry, /"boot-project-summary"/u);
});

test('native local transport admits a stable current-AE peer before immediate authorization', () => {
  const source = fs.readFileSync(
    'native/ae-plugin/src/platform/macos/mac_ipc_server.cpp',
    'utf8',
  );
  const admit = source.indexOf('admit_local_ae_peer(');
  const preface = source.indexOf('parse_auth_preface(', admit);
  const firstPeerCheck = source.indexOf('same_peer(peer_backend_', preface);
  const firstEndpointCheck = source.indexOf('endpoint_.verify().ok()', firstPeerCheck);
  const challenge = source.indexOf('serialize_auth_challenge(', firstEndpointCheck);
  const secondPeerCheck = source.indexOf('same_peer(peer_backend_', challenge);
  const secondEndpointCheck = source.indexOf('endpoint_.verify().ok()', secondPeerCheck);
  const decision = source.indexOf('serialize_auth_decision({', secondEndpointCheck);
  const serve = source.indexOf('handler_.serve(authenticated)');
  assert.ok(
    admit >= 0
      && preface > admit
      && firstPeerCheck > preface
      && firstEndpointCheck > firstPeerCheck
      && challenge > firstEndpointCheck
      && secondPeerCheck > challenge
      && secondEndpointCheck > secondPeerCheck
      && decision > secondEndpointCheck
      && serve > decision,
    'peer, endpoint, challenge, decision, and handler ordering changed',
  );
});

test('native build has one local admission path and no manual confirmation surface', () => {
  assert.doesNotMatch(BUILD_SCRIPT, /DEVELOPMENT_TRUST_LOCAL_PEER|developmentTrustLocalPeer/u);
  assert.doesNotMatch(BUILD_SCRIPT, /pairing_gate|pairing_ui/u);
  assert.match(BUILD_SCRIPT, /transport_auth\.cpp/u);
  assert.doesNotMatch(PLUGIN_ENTRY, /pairing|Pairing|AEGP_RegisterUpdateMenuHook/u);
  assert.match(PLUGIN_ENTRY, /AEGP_RegisterCommandHook/u);
});

test('native terminal diagnostics expose aggregate native-program evidence', () => {
  const completionStart = PLUGIN_ENTRY.indexOf('void log_completion(');
  const completionEnd = PLUGIN_ENTRY.indexOf('bool PluginState::start_ipc', completionStart);
  assert.notEqual(completionStart, -1);
  assert.notEqual(completionEnd, -1);

  const completionLogger = PLUGIN_ENTRY.slice(completionStart, completionEnd);
  assert.match(completionLogger, /completion\.capability_id == kNativeProgramCapability/u);
  for (const evidenceField of [
    'requestDigest',
    'postconditionDigest',
    'startedAtUnixMs',
    'completedAtUnixMs',
    'completedOperationCount',
    'outputCount',
    'writeStarted',
    'undoAvailable',
    'replayed',
    'disposition',
    'failedOperationIndex',
  ]) {
    assert.match(
      completionLogger,
      new RegExp(String.raw`\\"${evidenceField}\\"`, 'u'),
    );
  }
  assert.doesNotMatch(completionLogger, /composition_create_result/u);
  assert.doesNotMatch(completionLogger, /composition_settings_change_result/u);
});

test('native composition settings use the pinned SDK ratio and frame-rate ABI', () => {
  const start = PLUGIN_ENTRY.indexOf(
    'HostCompositionSettingsWriteResult set_composition_setting(',
  );
  const end = PLUGIN_ENTRY.indexOf(
    'list_composition_layers(',
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const adapter = PLUGIN_ENTRY.slice(start, end);

  assert.match(
    adapter,
    /const A_Ratio ratio\{\s*static_cast<A_long>\(command\.ratio\.numerator\),\s*static_cast<A_u_long>\(command\.ratio\.denominator\)\};/u,
  );
  assert.match(
    adapter,
    /const A_FpLong frame_rate[\s\S]*AEGP_SetCompFrameRate\(\s*comp,\s*&frame_rate\)/u,
  );
  assert.doesNotMatch(
    adapter,
    /AEGP_SetCompFrameRate\(\s*comp,\s*static_cast<A_FpLong>/u,
  );
});

test('native standard transform writes reacquire canonical layer streams before mutation', () => {
  const helperStart = PLUGIN_ENTRY.indexOf(
    'standard_layer_stream_for_match_name(',
  );
  const setterStart = PLUGIN_ENTRY.indexOf(
    'set_layer_property(',
  );
  const setterEnd = PLUGIN_ENTRY.indexOf(
    'resolve_program_layer_handle(',
    setterStart,
  );
  assert.notEqual(helperStart, -1);
  assert.notEqual(setterStart, -1);
  assert.notEqual(setterEnd, -1);

  const helper = PLUGIN_ENTRY.slice(helperStart, setterStart);
  for (const [matchName, sdkStream] of [
    ['ADBE Anchor Point', 'AEGP_LayerStream_ANCHORPOINT'],
    ['ADBE Position', 'AEGP_LayerStream_POSITION'],
    ['ADBE Scale', 'AEGP_LayerStream_SCALE'],
    ['ADBE Rotate Z', 'AEGP_LayerStream_ROTATE_Z'],
    ['ADBE Opacity', 'AEGP_LayerStream_OPACITY'],
    ['ADBE Orientation', 'AEGP_LayerStream_ORIENTATION'],
  ]) {
    assert.match(helper, new RegExp(`${matchName.replaceAll(' ', '\\s+')}`));
    assert.match(helper, new RegExp(sdkStream));
  }

  const setter = PLUGIN_ENTRY.slice(setterStart, setterEnd);
  const undoGroup = setter.indexOf('AEGP_StartUndoGroup(');
  const directStream = setter.indexOf('AEGP_GetNewLayerStream(', undoGroup);
  const identityCheck = setter.indexOf('direct_unique_id', directStream);
  const startAdd = setter.indexOf('AEGP_StartAddKeyframes(', undoGroup);
  const add = setter.indexOf('AEGP_AddKeyframes(', startAdd);
  const mutation = setter.indexOf('AEGP_SetAddKeyframe(', add);
  const commit = setter.indexOf('AEGP_EndAddKeyframes(', mutation);
  const remove = setter.indexOf('AEGP_DeleteKeyframe(', commit);
  const countAfter = setter.indexOf('keyframe_count_after', remove);
  const timeVaryingAfter = setter.indexOf('time_varying_after', countAfter);
  const readback = setter.indexOf('AEGP_GetNewStreamValue(', timeVaryingAfter);
  const finish = setter.indexOf('undo_group.finish()', readback);
  assert.ok(
    undoGroup !== -1
      && directStream > undoGroup
      && identityCheck > directStream
      && startAdd > identityCheck
      && add > startAdd
      && mutation > add
      && commit > mutation
      && remove > commit
      && countAfter > remove
      && timeVaryingAfter > countAfter
      && readback > timeVaryingAfter
      && finish > readback,
    'standard transform mutation must leave a verified static value inside one Undo group',
  );
  assert.doesNotMatch(setter, /AEGP_SetStreamValue\(/u);
  assert.doesNotMatch(setter, /AEGP_InsertKeyframe\(/u);
  assert.doesNotMatch(setter, /AEGP_SetKeyframeValue\(/u);
  assert.match(setter, /keyframe_count_after != 0/u);
  assert.match(setter, /time_varying_after != FALSE/u);
});

test('native keyframe add inserts before setting the typed value', () => {
  const mutationStart = PLUGIN_ENTRY.indexOf(
    'mutate_layer_property_keyframe(',
  );
  const mutationEnd = PLUGIN_ENTRY.indexOf(
    'HostLayerPropertyWriteResult',
    mutationStart,
  );
  assert.notEqual(mutationStart, -1);
  assert.notEqual(mutationEnd, -1);

  const mutation = PLUGIN_ENTRY.slice(mutationStart, mutationEnd);
  const addStart = mutation.indexOf('if (adding) {');
  const addEnd = mutation.indexOf('} else if (command.kind ==', addStart);
  assert.notEqual(addStart, -1);
  assert.notEqual(addEnd, -1);

  const add = mutation.slice(addStart, addEnd);
  const insert = add.indexOf('AEGP_InsertKeyframe(');
  const set = add.indexOf('AEGP_SetKeyframeValue(', insert);
  assert.ok(
    insert !== -1 && set > insert,
    'keyframe add must insert first and then set the typed value',
  );
  assert.doesNotMatch(add, /AEGP_StartAddKeyframes\(/u);
  assert.doesNotMatch(add, /AEGP_AddKeyframes\(/u);
  assert.doesNotMatch(add, /AEGP_SetAddKeyframe\(/u);
  assert.doesNotMatch(add, /AEGP_EndAddKeyframes\(/u);
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

async function readWindowsBuildScript() {
  return fs.promises.readFile('native/ae-plugin/build-windows.mjs', 'utf8');
}

test('native windows build fails fast on every locked external input before compiling', async () => {
  const script = await readWindowsBuildScript();
  // Same pinned SDK policy as macOS, bound to the windows-x64 platform record.
  assert.match(script, /verifyAeSdkInput\(\{/u);
  assert.match(script, /platform: 'windows-x64'/u);
  assert.match(script, /if \(!verification\.sdkRootReady\)/u);
  assert.match(script, /archiveVerification: sdkVerification\.archiveVerification/u);
  assert.match(script, /rootVerification: sdkVerification\.rootVerification/u);
  assert.match(script, /inputProvenance: sdkVerification\.provenance/u);
  // Toolchain prerequisites are their own structured AE_* failures.
  assert.match(script, /AE_PLUGIN_MSVC_UNAVAILABLE/u);
  assert.match(script, /AE_PLUGIN_WINDOWS_SDK_UNAVAILABLE/u);
  // Output ownership mirrors the macOS boundary rules.
  assert.match(script, /AE_PLUGIN_OUTPUT_INVALID/u);
  assert.match(script, /AE_PLUGIN_OUTPUT_EXISTS/u);
  assert.match(script, /assertOutsideBoundaries\(sdkRoot/u);
  assert.match(script, /assertOutsideBoundaries\(sdkArchive/u);
  // Build staging must never land in an Adobe plug-in scan root.
  assert.match(script, /Adobe plug-in scan roots/u);
  // Routine builds record dirty worktrees; evidence mode restores the clean
  // source and repeated locked-input gates.
  assert.match(script, /--evidence/u);
  assert.match(script, /repositoryClean: sourceState\.clean/u);
  assert.match(script, /readSourceCommit\(\{ requireClean/u);
  assert.doesNotMatch(script, /development builds are restricted to the current-user/u);
  // The repeated locked-input re-verification is gated behind evidence mode.
  const reverify = script.indexOf('AE_SDK_INPUT_CHANGED');
  const evidenceGate = script.lastIndexOf('if (evidence)', reverify);
  assert.notEqual(reverify, -1);
  assert.ok(evidenceGate !== -1 && evidenceGate < reverify);
  // Public interface promised by the implementation plan.
  assert.match(script, /export async function checkWindowsBuildPrerequisites/u);
  assert.match(script, /export async function buildWindowsAex/u);
  // Prerequisites resolve before any compiler invocation can run.
  const prerequisite = script.indexOf('checkWindowsBuildPrerequisites(');
  const compile = script.indexOf('compileWindowsObjects(');
  assert.notEqual(prerequisite, -1, 'prerequisite check is wired into the build');
  assert.notEqual(compile, -1, 'compile step exists');
  assert.ok(
    script.indexOf('await checkWindowsBuildPrerequisites(', prerequisite + 1) !== -1
      || script.indexOf('await checkWindowsBuildPrerequisites(', 0) < compile,
    'prerequisite check must run before the compile step',
  );
  // Scope guards: no signing, no pairing, no installer work in this package.
  assert.doesNotMatch(script, /signtool|Authenticode|makecert|msiexec/u);
  assert.doesNotMatch(script, /DEVELOPMENT_TRUST_LOCAL_PEER|pairing_gate|pairing_ui/u);
});

test('native windows build derives the product version from the exact commit like the mac build', async () => {
  const script = await readWindowsBuildScript();
  assert.match(script, /PRODUCT_MANIFEST_PATH = 'plugin\/host\/package\.json'/u);
  assert.match(script, /gitFileBytes\(sourceCommit, PRODUCT_MANIFEST_PATH\)/u);
  assert.match(script, /PRODUCT_VERSION_TOKEN/u);
  assert.match(script, /replaceExactlyOnce\(/u);
  assert.match(script, /AE_MCP_PRODUCT_VERSION/u);
  assert.match(script, /AE_PLUGIN_PRODUCT_VERSION_INVALID/u);
  assert.doesNotMatch(script, /AE_MCP_PRODUCT_VERSION[^\n]*(?:process\.env|environment)/u);
  assert.doesNotMatch(script, /--product-version/u);
  assert.match(script, /AE_PLUGIN_SOURCE_DIRTY/u);
  assert.match(script, /AE_PLUGIN_SOURCE_CHANGED/u);
});

test('native windows build compiles one x64 aex with msvc and records the toolchain receipt', async () => {
  const script = await readWindowsBuildScript();
  // MSVC toolchain discovery and the compile/link/resource pipeline.
  assert.match(script, /vswhere\.exe/u);
  assert.match(script, /vcvars64\.bat/u);
  assert.match(script, /cl\.exe/u);
  assert.match(script, /link\.exe/u);
  assert.match(script, /rc\.exe/u);
  assert.match(script, /\/std:c\+\+20/u);
  assert.match(script, /\/DMSWindows/u);
  assert.match(script, /\/DAE_MCP_SOURCE_COMMIT=/u);
  assert.match(script, /AeMcpNative\.aex/u);
  // The receipt binds the artifact hash to the pinned toolchain identity.
  assert.match(script, /msvcVersion/u);
  assert.match(script, /windowsSdkVersion/u);
  assert.match(script, /build-receipt\.json/u);
  assert.match(script, /sourceCommit/u);
  // Windows resource compilation replaces the macOS Rez step.
  assert.match(script, /AeMcpNative_PiPL\.win\.rc/u);
  assert.doesNotMatch(script, /\/usr\/bin\/xcrun/u);
  assert.doesNotMatch(script, /codesign/u);
});

test('native windows build verifies the staged PE and publishes an exact canonical output set', async () => {
  const script = await readWindowsBuildScript();
  assert.match(script, /import \{ verifyWindowsAex \} from '.\/verify-windows\.mjs'/u);
  assert.match(script, /verifyWindowsAex\(\{/u);
  assert.match(script, /expectedCommit: sourceCommit/u);
  assert.match(script, /expectedProductVersion: productVersion/u);
  assert.match(script, /assertWindowsVerification\(/u);
  assert.match(script, /verification\.sourceCommit !== sourceCommit/u);
  assert.match(script, /verification\.productVersion !== productVersion/u);
  assert.match(script, /receipt\.sourceCommit !== verification\.sourceCommit/u);
  assert.match(script, /receipt\.productVersion !== verification\.productVersion/u);
  assert.match(script, /verification: \{/u);
  assert.match(script, /receipt: verification\.receipt/u);
  assert.match(script, /path\.join\(canonicalOutput, ARTIFACT_NAME\)/u);
  assert.match(script, /sha256: verification\.artifactSha256/u);
  assert.match(script, /architecture: verification\.architecture/u);
  assert.match(script, /entryExport: verification\.entryExport/u);
  assert.match(script, /resources: verification\.receipt\.resources/u);
  assert.match(script, /assertExactOutputSet\(stage\)/u);
  assert.match(script, /objects = path\.join\(privateBuild/u);
  assert.match(script, /sourceSnapshot = path\.join\(privateBuild/u);
  assert.match(script, /sdkSnapshot = path\.join\(privateBuild/u);
  assert.match(script, /resourceSource = path\.join\(privateBuild/u);
  assert.match(script, /resourceObject = path\.join\(privateBuild/u);
  assert.match(script, /\/IMPLIB:/u);
  assert.match(script, /rm\(privateBuild, \{ recursive: true \}\)/u);
  assert.doesNotMatch(script, /path: executable/u);
});

test('native windows PiPL resource carries the same identity as the mac PiPL', async () => {
  const winRc = await fs.promises.readFile(
    'native/ae-plugin/resources/AeMcpNative_PiPL.win.rc', 'utf8',
  );
  const macPipl = await fs.promises.readFile(
    'native/ae-plugin/resources/AeMcpNative_PiPL.r', 'utf8',
  );
  // Same resource id, kind, name, category, version, and entry point values.
  assert.match(winRc, /^16000\s+PiPL\s+DISCARDABLE/mu);
  assert.match(winRc, /"MIB8",\s*\r?\n\s*"dnik"/u);
  assert.match(winRc, /"xgEA"/u);
  assert.match(winRc, /"MIB8",\s*\r?\n\s*"eman"/u);
  assert.match(winRc, /"\\x18After Effects MCP Native/u);
  assert.match(winRc, /"MIB8",\s*\r?\n\s*"gtac"/u);
  assert.match(winRc, /General Plugin/u);
  assert.match(winRc, /"MIB8",\s*\r?\n\s*"srev"/u);
  assert.match(winRc, /"MIB8",\s*\r?\n\s*"4668"/u);
  assert.match(winRc, /AeMcpNativeMain/u);
  // The macOS PiPL declares the same user-visible identity strings.
  for (const identity of [
    'After Effects MCP Native',
    'General Plugin',
    'AeMcpNativeMain',
  ]) {
    assert.ok(
      macPipl.includes(identity) && winRc.includes(identity),
      `PiPL identity drifted between platforms: ${identity}`,
    );
  }
  // Build identity tokens are each substituted exactly once before rc.exe.
  assert.equal(
    winRc.match(/__AE_MCP_PRODUCT_VERSION__/gu)?.length,
    1,
    'Windows resource must contain exactly one deterministic product version token',
  );
  assert.equal(
    winRc.match(/__AE_MCP_SOURCE_COMMIT__/gu)?.length,
    1,
    'Windows resource must contain exactly one deterministic source commit token',
  );
  // No second identity may appear: match name stays the shared one.
  assert.doesNotMatch(winRc, /AeMcpNativeWindows|AeMcpWin/u);
});

test('native windows entry point owns DllMain while the export stays the shared dispatch', async () => {
  const entry = await fs.promises.readFile(
    'native/ae-plugin/src/platform/windows/plugin_entry_windows.cpp', 'utf8',
  );
  assert.match(entry, /DllMain/u);
  assert.match(entry, /DLL_PROCESS_ATTACH/u);
  assert.match(entry, /DLL_PROCESS_DETACH/u);
  // The Windows adapter must not grow a parallel entry implementation.
  assert.doesNotMatch(entry, /A_Err AeMcpNativeMain\(/u);
  assert.doesNotMatch(entry, /AEGP_RegisterCommandHook/u);

  const dispatch = await fs.promises.readFile(
    'native/ae-plugin/src/aegp/plugin_entry.cpp', 'utf8',
  );
  const seam = await fs.promises.readFile(
    'native/ae-plugin/include/aemcp_native/host_platform.hpp', 'utf8',
  );
  // One export macro seam; no macOS-only attribute syntax left in the shared
  // dispatch, and no scattered platform #ifdef blocks inside it.
  assert.match(dispatch, /AE_MCP_PLUGIN_EXPORT A_Err AeMcpNativeMain\(/u);
  assert.doesNotMatch(dispatch, /__attribute__\(\(visibility\("default"\)\)\)/u);
  assert.doesNotMatch(dispatch, /__declspec\(dllexport\)/u);
  assert.doesNotMatch(dispatch, /#if defined\(_WIN32\)/u);
  assert.doesNotMatch(dispatch, /#ifdef _WIN32/u);
  // The shared dispatch consumes exactly one platform seam header instead of
  // macOS adapter headers directly.
  assert.match(dispatch, /#include "aemcp_native\/host_platform\.hpp"/u);
  assert.doesNotMatch(dispatch, /#include "aemcp_native\/endpoint_registry_macos\.hpp"/u);
  assert.doesNotMatch(dispatch, /#include "aemcp_native\/mac_ipc_server\.hpp"/u);
  assert.doesNotMatch(dispatch, /#include "aemcp_native\/peer_identity_macos\.hpp"/u);
  assert.doesNotMatch(dispatch, /#include "aemcp_native\/secure_random_macos\.hpp"/u);
  assert.doesNotMatch(dispatch, /#include <CoreFoundation\/CoreFoundation\.h>/u);
  assert.doesNotMatch(dispatch, /#include <fcntl\.h>/u);
  assert.doesNotMatch(dispatch, /#include <unistd\.h>/u);
  // The selector chooses the platform adapter in exactly one place.
  assert.match(seam, /#if defined\(_WIN32\)/u);
  assert.match(seam, /#elif defined\(__APPLE__\)/u);
  assert.match(seam, /#else/u);
  assert.match(seam, /#error/u);
  assert.match(seam, /__declspec\(dllexport\)/u);
  assert.match(seam, /__attribute__\(\(visibility\("default"\)\)\)/u);
});

test('native windows endpoint registry interface mirrors the mac semantics on named pipes', async () => {
  const header = await fs.promises.readFile(
    'native/ae-plugin/src/platform/windows/endpoint_registry_windows.hpp', 'utf8',
  );
  // One pipe per host instance under the shared aemcp-n1 naming scheme.
  assert.match(header, /aemcp-n1-/u);
  assert.match(header, /\\\\\.\\pipe\\/u);
  assert.match(header, /NativeEndpointDescriptor/u);
  // The same-user ACL is the local transport boundary; no manual pairing
  // state participates in endpoint discovery.
  assert.match(header, /same-user ACL/u);
  assert.doesNotMatch(header, /pairing|fingerprint|connection-code/u);
});
