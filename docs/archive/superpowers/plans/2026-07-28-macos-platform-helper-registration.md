# macOS Platform Helper Registration Implementation Plan

> Archived 2026-08-28: platform-helper was removed and this registration plan is no longer actionable.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the verified bundled macOS Platform Helper and reach it from hardened Adobe CEP through a bounded same-binary stdio broker, so Provider credentials work in real After Effects without any plaintext fallback.

**Architecture:** The CommonJS registration module validates the fixed seven-file macOS payload, materializes a private per-user launchd plist, reuses only an already-loaded service whose program path matches the verified Helper, and bootstraps the service when absent. Real AE proved that Adobe's hardened CEP process cannot load a non-Adobe-Team N-API addon. The macOS host therefore spawns the exact verified Helper executable in a bounded `--client-stdio` mode; that child owns the existing XPC connection. Service authorization accepts the broker only with its fixed native identity, direct trusted CEP renderer parent followed by the signed CEP process, stable Adobe ancestry, current UID/audit session, and supported AE version. Windows keeps the addon path.

**Tech Stack:** Node.js CommonJS host modules, `node:test`, macOS `launchctl`, Swift stdio/XPC broker, Security.framework caller inspection, existing CEP development sync and non-candidate HDEV tooling.

## Global Constraints

- Do not change Provider routing, accepted credentials, plaintext fallback policy, Helper methods, protocol schemas, or release signing requirements.
- Caller authorization may add only the broker route described above; direct Adobe CEP authorization and every existing rejected-peer boundary remain covered.
- Do not read, print, log, or persist plaintext Provider credentials outside the existing Helper request boundary.
- Do not use a shell for registration; invoke only the fixed `/bin/launchctl` executable with an argv array.
- Do not boot out, kill, or restart an already-loaded matching Helper during routine panel startup.
- Windows keeps its existing verified-helper addon/spawn path.
- Reuse installed dependencies; do not run `npm ci`, `uv sync`, portable-runtime generation, ZXP packaging, T5, or T6.
- Real-machine verification is non-candidate HDEV and must run through the installed panel inside real After Effects.

## Real-host correction checkpoint

Tasks 1-3 below were completed and committed as `50378cb` and `c9614ad`.
Focused tests, mutation proof, host/panel/package/governance checks, CEP-only
sync, and an AE restart all passed their applicable boundaries. Real CEP then
reported:

```text
ERR_DLOPEN_FAILED: mapping process and mapped file have different Team IDs
```

The installed CEP executable is Adobe Team `JQ525L2MZD`, hardened, and has no
disable-library-validation entitlement. The development addon is ad-hoc signed;
a release addon would use the product Team ID, which is still not Adobe's.
Accordingly, the original “load addon inside CEP after registration” step is
not a viable macOS product path. The following tasks supersede only that
transport placement while retaining the completed registration work.

### Task 4: Specify the out-of-process macOS transport

- [ ] Add failing host tests proving macOS never loads the N-API addon, waits
  for registration, and spawns only the verified Helper path with the literal
  `--client-stdio` argument and private pipes.
- [ ] Add failing lifecycle tests for bounded stdout frames, EOF, spawn failure,
  unexpected exit, and concurrent requests.
- [ ] Add failing Swift tests for broker identity + direct CEP renderer +
  required CEP + AE ancestry,
  including independent mutations of every retained authorization boundary.

### Task 5: Implement the same-binary stdio broker

- [ ] Add Swift `--client-stdio` mode that reads one bounded JSON frame per line,
  forwards it through the existing XPC protocol, writes one bounded response per
  line, and exits on EOF.
- [ ] Add the broker authorization branch while preserving the direct CEP branch
  and rejection-only backend behavior.
- [ ] Change only macOS host transport to spawn the broker; retain the Windows
  N-API addon behavior unchanged.

Real CEP process inspection refined the broker branch: Node executes in
Adobe's signed `CEPHtmlEngine Helper (Renderer)`, so that renderer—not the
top-level `CEPHtmlEngine`—is the broker's direct parent. Authorization pins the
exact renderer identifier, then independently requires its signed
`CEPHtmlEngine` parent and the supported AE ancestor; it does not accept an
arbitrary Adobe-signed parent.

- [ ] Prove the new guards by mutation, then run focused Node, Swift, protocol,
  static-boundary, panel, package, and governance checks.

### Task 6: Real-AE development verification

- [ ] Rebuild only the changed Helper/CEP components and perform development
  sync without dependency bootstrap or release packaging.
- [ ] Restart formal AE, obtain Helper capabilities from the Adobe CEP process,
  and verify the service caller evidence is authorized.
- [ ] Run only the pending non-candidate Claude Provider multimodal HDEV; do not
  run packaged T5/T6.

---

## File Structure

- Create `plugin/host/platform-helper-registration.js`: macOS manifest verification, private plist materialization, launchd inspection, and bootstrap.
- Create `plugin/host/platform-helper-registration.test.js`: direct property tests for payload, state-directory, argv, reuse, and failure classification.
- Modify `plugin/host/platform-helper-transport.js`: call the registrar before opening macOS native XPC and preserve its bounded lifecycle errors.
- Modify `plugin/host/platform-helper-transport.test.js`: integration ordering, single-flight registration, mutation guard, Windows non-regression, and process-boundary allowlist.
- Modify `plugin/client/dist/app.js`: generated panel bundle produced by the existing build.

### Task 1: Verified macOS registration boundary

**Files:**
- Create: `plugin/host/platform-helper-registration.js`
- Create: `plugin/host/platform-helper-registration.test.js`

**Interfaces:**
- Consumes: an absolute addon path ending in `lib/ae-mcp-platform-helper-transport.node`; injected `fsImpl`, `createHash`, `execFile`, `homedir`, `getuid`, and `processId` for deterministic tests.
- Produces:

```js
prepareMacosHelperRegistration(options) -> Object.freeze({
    helperPath: string,
    ensureRegistered: async function () -> undefined,
})
```

- Throws only bounded errors with `{code, retryable}`:
  - malformed/tampered payload or mismatched loaded program:
    `PLATFORM_HELPER_REPAIR_REQUIRED`, `retryable:false`;
  - launchctl execution/bootstrap failure:
    `HELPER_START_FAILED`, `retryable:true`.

- [ ] **Step 1: Write fixture helpers and the failing happy-path test**

Create a seven-file fixture whose manifest matches:

```js
const MACOS_FILES = [
    ['bin/ae-mcp-platform-helper', 'macho-arm64'],
    ['bin/ae-mcp', 'script'],
    ['lib/ae-mcp-platform-helper-transport.node', 'macho-arm64'],
    ['xpc/com.junkdoge.ae-mcp.platform-helper.xpc/Contents/MacOS/ae-mcp-platform-helper', 'macho-arm64'],
    ['xpc/com.junkdoge.ae-mcp.platform-helper.xpc/Contents/Info.plist', 'data'],
    ['metadata/PlatformHelper.entitlements', 'data'],
    ['launchd/com.junkdoge.ae-mcp.platform-helper.plist', 'data'],
];
```

The launchd mock must observe exactly:

```js
[
    ['/bin/launchctl', ['print', 'gui/501/com.junkdoge.ae-mcp.platform-helper']],
    ['/bin/launchctl', ['bootstrap', 'gui/501', generatedPlist]],
    ['/bin/launchctl', ['print', 'gui/501/com.junkdoge.ae-mcp.platform-helper']],
]
```

The first `print` rejects as absent; the second returns the literal
`program = ` prefix followed by the fixture's verified absolute Helper path.

```text
program = /fixture/platform/macos-arm64/bin/ae-mcp-platform-helper
```

Assert that the generated plist:

```js
assert.equal(plist.includes('__AE_MCP_HELPER_EXECUTABLE__'), false);
assert.equal(plist.includes(verifiedHelperPath), true);
assert.equal((fs.statSync(stateRoot).mode & 0o077), 0);
assert.equal((fs.statSync(generatedPlist).mode & 0o177), 0);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test plugin/host/platform-helper-registration.test.js
```

Expected: FAIL because `./platform-helper-registration` does not exist.

- [ ] **Step 3: Implement strict payload verification**

In `platform-helper-registration.js`, define the exact file/architecture records,
resolve every manifest path beneath the helper root, reject symlinks and
non-regular files, and compare every file to its manifest SHA-256. Validate:

```js
manifest.schemaVersion === 1
manifest.platform === 'macos-arm64'
manifest.helperId === 'com.junkdoge.ae-mcp.platform-helper'
manifest.entrypoints.helper === 'bin/ae-mcp-platform-helper'
manifest.entrypoints.launcher === 'bin/ae-mcp'
```

Reject missing, extra, duplicate, reordered, or architecture-mismatched file
records before any launchctl invocation.

- [ ] **Step 4: Implement private plist materialization**

Use:

```js
const stateRoot = path.join(
    homedir(),
    'Library',
    'Application Support',
    'AfterEffectsMCP',
    'platform-helper-v1',
);
```

Create/chmod the directory to `0700`, reject a symbolic/non-directory state
root, XML-escape the verified helper path, replace exactly one template token,
write a unique `0600` temporary file with `flag:'wx'`, and atomically rename it
to `com.junkdoge.ae-mcp.platform-helper.plist`.

- [ ] **Step 5: Implement registration and exact service reuse**

Wrap callback-style `execFile` in a Promise with:

```js
execFile('/bin/launchctl', args, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    maxBuffer: 65536,
}, callback);
```

Algorithm:

```js
const domain = 'gui/' + getuid();
const service = domain + '/com.junkdoge.ae-mcp.platform-helper';
const current = await launchctl(['print', service], { allowMissing: true });
if (current.found) {
    requireExactProgram(current.stdout, helperPath);
    return;
}
const plistPath = materializePrivatePlist();
await launchctl(['bootstrap', domain, plistPath]);
const registered = await launchctl(['print', service]);
requireExactProgram(registered.stdout, helperPath);
```

`requireExactProgram` accepts only a trimmed launchctl line equal to
`program = ${helperPath}`. It must not use substring matching.

- [ ] **Step 6: Add failing security and lifecycle tests**

Add independent tests that assert:

1. changing one payload byte prevents all launchctl calls;
2. an extra manifest file prevents all launchctl calls;
3. a symbolic state root prevents all launchctl calls;
4. an already-loaded exact program performs one `print`, no `bootstrap`, no
   `bootout`;
5. an already-loaded different program fails
   `PLATFORM_HELPER_REPAIR_REQUIRED`;
6. failed `bootstrap` returns `HELPER_START_FAILED` without leaking stderr or
   local paths in the public message;
7. concurrent `ensureRegistered()` calls share one registration Promise.

- [ ] **Step 7: Run the tests and verify GREEN**

Run:

```bash
node --test plugin/host/platform-helper-registration.test.js
```

Expected: all registration tests pass with no warnings.

- [ ] **Step 8: Commit the registration unit**

```bash
git add plugin/host/platform-helper-registration.js plugin/host/platform-helper-registration.test.js
git commit -m "fix(panel): register verified macOS platform helper"
```

### Task 2: Bind registration to the macOS transport

**Files:**
- Modify: `plugin/host/platform-helper-transport.js`
- Modify: `plugin/host/platform-helper-transport.test.js`

**Interfaces:**
- Consumes:

```js
prepareMacosHelperRegistration({ addonPath, ...injectedDependencies })
```

- Adds one test injection point:

```js
options.prepareMacosHelperRegistration
```

- The injected function returns the exact `{helperPath, ensureRegistered}`
  object defined in Task 1.

- [ ] **Step 1: Write the failing registration-before-XPC test**

Add a macOS test that records:

```js
events.push('register:start');
events.push('register:done');
events.push('addon:createTransport');
events.push('native:request');
```

Resolve registration asynchronously and assert the native addon is not opened
until it resolves. After `transport.request('xpc')`, assert:

```js
assert.deepEqual(events, [
    'register:start',
    'register:done',
    'addon:createTransport',
    'native:request',
]);
```

- [ ] **Step 2: Run the transport test and verify RED**

Run:

```bash
node --test plugin/host/platform-helper-transport.test.js
```

Expected: FAIL because macOS currently opens the addon transport without
registration.

- [ ] **Step 3: Implement the minimal transport integration**

Load `prepareMacosHelperRegistration` from the new module. Construct it before
loading the addon so a malformed payload blocks native code. Add:

```js
async function connectMacos() {
    await macosRegistration.ensureRegistered();
    return openNativeTransport();
}
```

Use `connectMacos()` only for `macos-arm64`; keep `connectWindows()` byte-for-byte
equivalent in behavior. Preserve registrar error codes through the transport
and existing sanitized client boundary.

- [ ] **Step 4: Update the host process-boundary invariant**

The current static test permits process launch only in
`platform-helper-transport.js`. Change it to permit process APIs only in:

```js
new Set([
    'platform-helper-transport.js',
    'platform-helper-registration.js',
])
```

Add source assertions that the registration module contains `/bin/launchctl`,
uses `execFile`, and contains none of:

```text
shell:true
exec(
spawn(
bootout
kill
stdio:'inherit'
```

- [ ] **Step 5: Add failure and single-flight integration tests**

Assert:

- concurrent macOS requests invoke `ensureRegistered()` once;
- registrar `HELPER_START_FAILED` remains retryable and does not open native
  transport;
- registrar `PLATFORM_HELPER_REPAIR_REQUIRED` remains non-retryable and does
  not open native transport;
- Windows does not construct or invoke the macOS registrar.

- [ ] **Step 6: Run focused host tests and verify GREEN**

Run:

```bash
node --test \
  plugin/host/platform-helper-registration.test.js \
  plugin/host/platform-helper-transport.test.js \
  plugin/host/platform-helper-client.test.js
```

Expected: all tests pass.

- [ ] **Step 7: Prove the ordering guard by mutation**

Temporarily remove only:

```js
await macosRegistration.ensureRegistered();
```

Run:

```bash
node --test plugin/host/platform-helper-transport.test.js
```

Expected: the registration-before-XPC test fails because
`addon:createTransport` appears before registration. Restore the line and rerun
the same command; expected PASS. Record both outcomes in the completion
evidence.

- [ ] **Step 8: Commit the transport integration**

```bash
git add plugin/host/platform-helper-transport.js plugin/host/platform-helper-transport.test.js
git commit -m "fix(panel): start macOS helper before XPC"
```

### Task 3: Rebuild and run affected automated tiers

**Files:**
- Modify generated file: `plugin/client/dist/app.js`

**Interfaces:**
- Consumes the host registration and transport behavior from Tasks 1-2.
- Produces an installed CEP candidate containing the updated host files and
  rebuilt panel bundle; no Core/native/runtime artifact changes.

- [ ] **Step 1: Run all host and panel tests**

Run:

```bash
npm --prefix plugin/host test
npm --prefix plugin/panel test
```

Expected: all tests pass. The known unrelated receipt-reuse flake may be
reported once but must not hide a deterministic failure in the changed tests.

- [ ] **Step 2: Rebuild the panel bundle**

Run:

```bash
npm --prefix plugin/panel run build
```

Expected: exit 0 and only the generated `plugin/client/dist/app.js` changes in
addition to intended source/tests/docs.

- [ ] **Step 3: Run package and governance checks affected by host/process rules**

Run these affected package, platform, and governance checks without dependency
installation:

```bash
node --test \
  scripts/package/test/dev-install-contract.test.mjs \
  scripts/package/test/no-platform-leaks.test.mjs \
  scripts/package/test/repository-governance.test.mjs \
  native/platform-helper/macos/Tests/platform-helper-static.test.mjs
node scripts/check-repository-governance.mjs
```

Expected: all selected checks pass.

- [ ] **Step 4: Audit the diff and commit generated output**

Confirm:

```bash
git diff --check
git status --short
git diff --stat
```

No Core, native Helper, protocol schema, Provider routing, or dependency lock
file may change.

Commit:

```bash
git add plugin/client/dist/app.js
git commit -m "chore(panel): rebuild helper registration bundle"
```

### Task 4: Component-selective real-AE verification

**Files:**
- No tracked source edits expected.
- Evidence remains in the existing ignored HDEV evidence root and is
  permanently non-candidate.

**Interfaces:**
- Consumes the existing `scripts/dev/ae-mcp-dev.mjs` component-selective
  workflow and installed Helper payload.
- Produces read-only Helper capability evidence and the pending Claude Provider
  multimodal HDEV result.

- [ ] **Step 1: Record the pre-sync development state**

Record branch/HEAD, clean status, current CEP install receipt/path, current
Helper manifest metadata, and active AE PID. Do not hash the Core/native runtime
tree and do not inspect Provider secret values.

- [ ] **Step 2: Close the formal After Effects process and sync only CEP**

Use the already-authorized normal GUI quit path, verify all After Effects and
AfterFX processes exited, then run:

```bash
node scripts/dev/ae-mcp-dev.mjs sync \
  --component cep \
  --repo-root "$(pwd -P)" \
  --home "$HOME" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

Expected receipt:

```text
selected=["cep"]
dependencyBootstrapInvocations=0
releasePackagingInvocations=0
```

- [ ] **Step 3: Launch formal AE and verify Helper registration**

Launch through the existing development command, open the panel, and verify:

```bash
launchctl print gui/$(id -u)/com.junkdoge.ae-mcp.platform-helper
```

The service program must equal the verified installed Helper path. From the
CEP-in-process host, call only `capabilities()` and verify protocol version 1,
platform `macos-arm64`, Helper version `0.9.2`, `authenticatedCaller:true`, and
the exact method set. Do not use an external Node process as authorization
evidence because it is intentionally not an Adobe CEP caller.

- [ ] **Step 4: Run the pending Claude Provider HDEV**

Use the existing panel acceptance bridge and five-file multimodal fixture from
the current branch. Verify the Claude custom Provider route reaches Claude Code
through the loopback Provider facade, attachments are exposed as scoped file
paths, public AE MCP calls remain observable, and no plaintext credential is
written to panel storage or evidence.

This run is explicitly:

```text
profile=development
candidateEvidence=false
T5=false
T6=false
```

- [ ] **Step 5: Verify recovery and final state**

Close the acceptance route cleanly, confirm no unreconciled write or secret
migration remains, preserve only redacted non-candidate evidence, and report:

- original native error and confirmed root cause;
- source commits;
- focused/full automated test counts;
- mutation RED and restored GREEN;
- CEP-only sync with zero dependency/bootstrap/release-package invocations;
- launchd service identity and CEP-authenticated capabilities;
- Claude Provider HDEV disposition;
- remaining release/Windows risks without claiming packaged acceptance.
