# Snapshot Truthfulness and macOS Helper Repair Implementation Plan

> Archived 2026-08-28: `ae_snapshot`, snapshot-mss, and platform-helper were removed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one PR that makes `snapshot-mss` truthfully Windows-only and
adds an explicit panel action that repairs a stale macOS platform-helper
registration.

**Architecture:** The PR has two independent tracks. The Python snapshot track
changes only platform eligibility and the promises around it. The macOS helper
track adds `repairRegistered()` to the existing launchd registrar, selects that
operation through a one-shot transport construction option, and lets the
HostController replace its helper client/transport when the user invokes
Repair Helper.

**Tech Stack:** Python 3.10+, pytest, Node.js CommonJS host modules,
`node:test`, React 18 CEP panel, esbuild, macOS per-user launchd.

## Global Constraints

- Work only in
  `/Users/junk_doge/Documents/ae-mcp/.worktrees/issues-178-66-snapshot-helper-repair`
  on branch `codex/issues-178-66-snapshot-helper-repair`; the root checkout has
  unrelated user changes and must remain untouched.
- Keep #178 and #66 in one PR but in separate logical commits, test groups, and
  issue dispositions.
- Follow strict red-green-refactor: no production behavior change before its
  focused test has failed for the expected missing behavior.
- `MssSnapshotter.supports_platform()` returns `True` only for
  `sys.platform == "win32"`.
- Do not change the Windows screenshot implementation or the native
  `ae.previewFrame` path.
- Routine macOS startup continues to perform only absent-service bootstrap or
  exact-path reuse. It never executes `bootout`.
- Only the explicit user repair path may replace the fixed per-user service
  `gui/<uid>/com.junkdoge.ae-mcp.platform-helper`.
- Repair must reverify the current payload before launchd mutation, use only
  `/bin/launchctl`, verify the loaded Program equals the current helper path,
  then create a fresh transport/client and complete `capabilities()`.
- A missing service during explicit repair is recoverable. Other launchctl
  failures remain structured failures and are not blindly retried.
- Helper failures exposed to React preserve sanitized codes and never expose
  payload paths, command output, secret values, or native error messages.
- Do not add PID tracking, start-token comparison, process census, generalized
  runner infrastructure, routine full-tree hash walks, automatic
  multi-instance coordination, or unrelated security hardening.
- Do not change Swift/XPC protocol code, RuntimeManager, Keychain policy,
  ScreenCaptureKit, installer/uninstaller, signing, notarization, or AEGP.
- Keep ScreenCaptureKit work in #67, installer lifecycle in #69, and signed
  clean-machine release attestation in #70.
- Generate `plugin/client/dist/app.js` with
  `npm --prefix plugin/panel run build`; never edit the bundle by hand.
- Per-task reviewers classify findings under AGENTS.md section 5. A
  non-reproduced edge case is follow-up or out of scope, not an automatic
  implementation request.

## File Responsibility Map

- `packages/snapshot-mss/ae_mcp_snapshot_mss/__init__.py`: implements the
  snapshotter predicate and Windows capture behavior.
- `packages/snapshot-mss/tests/test_mss_snapshot.py`: proves platform
  eligibility, discovery consequence, and existing capture behavior.
- `packages/snapshot-mss/pyproject.toml`,
  `packages/snapshot-mss/README.md`, `README.md`, and `README.zh-CN.md`: state
  the public Windows-only `snapshot-mss` support contract.
- `plugin/host/platform-helper-registration.js`: owns verified launchd
  inspection, bootstrap, explicit replacement, and exact Program verification.
- `plugin/host/platform-helper-registration.test.js`: executes the registrar
  against controlled payloads and injected `/bin/launchctl` behavior.
- `plugin/host/platform-helper-transport.js`: chooses normal registration or
  explicit repair before opening the macOS stdio broker.
- `plugin/host/platform-helper-transport.test.js`: proves ordering and Windows
  non-regression at the transport boundary.
- `plugin/panel/src/cep/hostBridge.js`: owns the live CEP helper
  client/transport lifecycle and exposes `repairPlatformHelper()`.
- `plugin/panel/test/hostBridge.test.js`: proves repair replaces the failed
  helper binding and completes a sanitized capability handshake.
- `plugin/panel/src/app/providerInitState.js`: classifies helper failures and
  computes the Repair Helper view model.
- `plugin/panel/test/providerInitState.test.js`: proves Repair Helper visibility
  and disabled state from observable provider initialization facts.
- `plugin/panel/src/app/App.jsx`: invokes HostController repair, records
  progress, and reruns provider initialization.
- `plugin/panel/src/screens/SettingsScreen.jsx`: renders the explicit Repair
  Helper action.
- `plugin/client/dist/app.js`: generated panel bundle.

---

### Task 1: Make `snapshot-mss` Truthfully Windows-Only

**Files:**

- Modify: `packages/snapshot-mss/ae_mcp_snapshot_mss/__init__.py`
- Modify: `packages/snapshot-mss/tests/test_mss_snapshot.py`
- Modify: `packages/snapshot-mss/pyproject.toml`
- Modify: `packages/snapshot-mss/README.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

**Interfaces:**

- Consumes: Python's exact `sys.platform` values.
- Produces:
  `MssSnapshotter.supports_platform() -> bool`, true only on `win32`.
- Preserves: `MssSnapshotter.capture(...)` and the existing Windows
  HWND-to-rectangle behavior.

- [ ] **Step 1: Replace the incorrect predicate test with platform cases**

In `packages/snapshot-mss/tests/test_mss_snapshot.py`, use the already imported
`sys` and add the discovery import:

```python
from ae_mcp.snapshot.discovery import select_snapshotter
```

Replace `test_supports_platform_always_true` with:

```python
@pytest.mark.parametrize(
    ("platform", "expected"),
    [("win32", True), ("darwin", False), ("linux", False)],
)
def test_supports_platform_only_when_window_capture_is_implemented(platform, expected):
    with patch.object(sys, "platform", platform):
        assert MssSnapshotter().supports_platform() is expected


def test_darwin_discovery_does_not_select_mss():
    with patch.object(sys, "platform", "darwin"), patch(
        "ae_mcp.snapshot.discovery._scan_entry_points",
        return_value={"mss": MssSnapshotter},
    ):
        assert select_snapshotter() is None
```

The predicate test catches an unconditional return. The discovery test catches
a later regression that makes the concrete backend eligible on Darwin.

- [ ] **Step 2: Run the new tests and verify the intended red result**

Run:

```bash
uv run pytest \
  packages/snapshot-mss/tests/test_mss_snapshot.py::test_supports_platform_only_when_window_capture_is_implemented \
  packages/snapshot-mss/tests/test_mss_snapshot.py::test_darwin_discovery_does_not_select_mss \
  -q
```

Expected: Darwin and Linux predicate cases fail because the current method
returns `True`; Darwin discovery selects `mss`.

- [ ] **Step 3: Implement the minimal predicate**

In `packages/snapshot-mss/ae_mcp_snapshot_mss/__init__.py`:

```python
"""Windows AE-window ae.snapshot implementation backed by mss."""
from __future__ import annotations

import sys
import time
```

Change the method to:

```python
def supports_platform(self) -> bool:
    return sys.platform == "win32"
```

Do not change `capture()`.

- [ ] **Step 4: Run the focused tests and verify green**

Run the command from Step 2.

Expected: all parameter cases and Darwin discovery pass.

- [ ] **Step 5: Correct user-facing package promises**

Use these meanings consistently:

- Python module docstring: Windows AE-window implementation backed by `mss`.
- `pyproject.toml` description:
  `Windows mss-based After Effects window capture for ae-mcp`.
- Package README, Chinese:
  `ae-mcp-snapshot-mss` 是 ae-mcp 的 Windows 截图 backend。
- Package README, English:
  `ae-mcp-snapshot-mss` is the Windows screenshot backend for ae-mcp.
- Root README and Chinese README: `snapshot-mss` provides Windows
  `ae_snapshot` screen capture; `ae_previewFrame` remains the AE-internal
  `CompItem.saveFrameToPng` path.

Do not claim that the underlying `mss` library is Windows-only; the limitation
belongs to this backend's AE-window targeting implementation.

- [ ] **Step 6: Run the snapshot and public filtering regressions**

Run:

```bash
uv run pytest \
  packages/snapshot-mss/tests/test_mss_snapshot.py \
  packages/core/tests/test_snapshot_discovery.py \
  packages/core/tests/test_status_tool.py \
  packages/core/tests/test_server_native_tools.py \
  -q
```

Expected: all pass. Existing core tests prove that `select_snapshotter() is
None` removes `ae.snapshot` from the public tool set.

- [ ] **Step 7: Commit the independent #178 track**

```bash
git add \
  packages/snapshot-mss/ae_mcp_snapshot_mss/__init__.py \
  packages/snapshot-mss/tests/test_mss_snapshot.py \
  packages/snapshot-mss/pyproject.toml \
  packages/snapshot-mss/README.md \
  README.md \
  README.zh-CN.md
git commit -m "fix(snapshot): advertise only implemented platform support"
```

---

### Task 2: Add the Explicit launchd Repair Primitive

**Files:**

- Modify: `plugin/host/platform-helper-registration.js`
- Modify: `plugin/host/platform-helper-registration.test.js`

**Interfaces:**

- Consumes:
  `prepareMacosHelperRegistration({ addonPath, fsImpl, createHash, execFile,
  homedir, getuid, processId })`.
- Produces:
  `repairRegistered() -> Promise<{action: "already-current" | "repaired",
  helperPath: string}>` alongside the existing `helperPath` and
  `ensureRegistered()`.
- Preserves: normal `ensureRegistered()` never calls `bootout`.

- [ ] **Step 1: Add a red test for stale-path explicit replacement**

Add a test named
`macOS explicit repair replaces a stale registration and verifies the current helper`
to `plugin/host/platform-helper-registration.test.js`.

Use `writeMacosFixture(t)`, `registrationFor(...)`, the literal service
`gui/501/com.junkdoge.ae-mcp.platform-helper`, and an injected `execFile` that
records calls. It must return a stale Program for the first `print`, accept
`bootout` and `bootstrap`, and return `fixture.helperPath` for the final
`print`.

Assert:

```javascript
assert.deepEqual(await registration.repairRegistered(), {
    action: 'repaired',
    helperPath: fixture.helperPath,
});
assert.deepEqual(calls.map(([, args]) => args[0]), [
    'print',
    'bootout',
    'bootstrap',
    'print',
]);
assert.deepEqual(calls[1][1], ['bootout', service]);
```

- [ ] **Step 2: Verify the replacement test is red**

Run:

```bash
node --test \
  --test-name-pattern="explicit repair replaces" \
  plugin/host/platform-helper-registration.test.js
```

Expected: fail because `registration.repairRegistered` is not defined.

- [ ] **Step 3: Add the minimal repair API**

In `prepareMacosHelperRegistration`, retain the absolute addon path and add:

```javascript
async function repairRegistered() {
    const currentPayload = verifyMacosPayload(
        path.resolve(input.addonPath),
        dependencies,
    );
    const current = await launchctl(['print', service], { allowMissing: true });
    if (current.found) {
        try {
            requireExactProgram(current.stdout, currentPayload.helperPath);
            return Object.freeze({
                action: 'already-current',
                helperPath: currentPayload.helperPath,
            });
        } catch (error) {
            if (!error || error.code !== 'PLATFORM_HELPER_REPAIR_REQUIRED') {
                throw error;
            }
        }
        await launchctl(['bootout', service], { allowMissing: true });
    }
    const plistPath = materializePrivatePlist(currentPayload, dependencies);
    await launchctl(['bootstrap', domain, plistPath]);
    const registered = await launchctl(['print', service]);
    requireExactProgram(registered.stdout, currentPayload.helperPath);
    return Object.freeze({
        action: 'repaired',
        helperPath: currentPayload.helperPath,
    });
}
```

Return it from the frozen registration object:

```javascript
return Object.freeze({
    helperPath: payload.helperPath,
    ensureRegistered,
    repairRegistered,
});
```

Keep `register()` and `ensureRegistered()` unchanged.

- [ ] **Step 4: Run the replacement test and verify green**

Run the Step 2 command.

Expected: pass with the exact `print → bootout → bootstrap → print` sequence.

- [ ] **Step 5: Add red tests for the repair boundaries**

Add these separate tests with literal expected calls:

1. `macOS explicit repair reuses an already-current registration`
   - first `print` contains `fixture.helperPath`;
   - result is `{ action: "already-current", helperPath }`;
   - calls are exactly `["print"]`.
2. `macOS explicit repair bootstraps when the service is already absent`
   - first `print` fails with `{ code: 113 }`;
   - calls are `["print", "bootstrap", "print"]`;
   - no `bootout` call occurs.
3. `macOS explicit repair reverifies the payload before launchd mutation`
   - construct the registration, then append `tampered` to
     `fixture.helperPath`;
   - `repairRegistered()` rejects with
     `PLATFORM_HELPER_REPAIR_REQUIRED`;
   - `launchctlCalls === 0`.
4. `macOS explicit repair stops on a non-missing bootout failure`
   - stale `print`, then `bootout` fails with `{ code: 5 }`;
   - reject with `HELPER_START_FAILED`;
   - no `bootstrap` occurs.
5. `macOS explicit repair continues when bootout observes a missing service`
   - stale `print`, then `bootout` fails with `{ code: 113 }`;
   - continue through `bootstrap` and exact final `print`.
6. `macOS normal registration never boots out a stale service`
   - call `ensureRegistered()` against a stale Program;
   - reject with `PLATFORM_HELPER_REPAIR_REQUIRED`;
   - calls are exactly `["print"]`.

- [ ] **Step 6: Verify the new boundary tests expose the missing distinction**

Run:

```bash
node --test \
  --test-name-pattern="explicit repair|normal registration never" \
  plugin/host/platform-helper-registration.test.js
```

Expected before the next implementation step: the non-missing `bootout`
failure case shows that the existing `allowMissing` behavior incorrectly
swallows every command failure.

- [ ] **Step 7: Restrict missing-service recovery to launchctl code 113**

Add:

```javascript
function launchctlServiceMissing(error) {
    return Boolean(error) && Number(error.code) === 113;
}
```

In `launchctlRunner`, replace the unconditional `if (allowMissing)` branch
with:

```javascript
if (allowMissing && launchctlServiceMissing(error)) {
    resolve(Object.freeze({ found: false, stdout: '' }));
    return;
}
```

All other failures continue through the existing sanitized
`HELPER_START_FAILED` path.

- [ ] **Step 8: Run the complete registrar suite**

Run:

```bash
node --test plugin/host/platform-helper-registration.test.js
```

Expected: all existing registration tests and all explicit repair tests pass.

- [ ] **Step 9: Commit the registrar primitive**

```bash
git add \
  plugin/host/platform-helper-registration.js \
  plugin/host/platform-helper-registration.test.js
git commit -m "feat(macos): repair stale helper registration explicitly"
```

---

### Task 3: Rebuild the CEP Helper Binding Through Repair Mode

**Files:**

- Modify: `plugin/host/platform-helper-transport.js`
- Modify: `plugin/host/platform-helper-transport.test.js`
- Modify: `plugin/panel/src/cep/hostBridge.js`
- Modify: `plugin/panel/test/hostBridge.test.js`

**Interfaces:**

- Consumes from Task 2:
  `{ helperPath, ensureRegistered, repairRegistered }`.
- Produces:
  `createPlatformHelperTransport({ ..., repairRegistration?: boolean })`.
- Produces:
  `createHostController(...).repairPlatformHelper() -> Promise<Capabilities>`.
- Preserves: the host facade methods `capabilities`, `secretGet`, `secretSet`,
  and `secretDelete`; Windows transport behavior is unchanged.

- [ ] **Step 1: Add a red transport ordering test**

Update the default macOS registrar fixture in
`plugin/host/platform-helper-transport.test.js` so it defines both methods:

```javascript
return {
    helperPath: '/verified/platform/helper',
    ensureRegistered: async function () {},
    repairRegistered: async function () {},
};
```

Add:

```javascript
test('macOS repair transport replaces registration before opening the broker', async () => {
    const events = [];
    const transport = createPlatformHelperTransport(macOptions({
        repairRegistration: true,
        prepareMacosHelperRegistration: function () {
            return {
                helperPath: '/verified/platform/helper',
                ensureRegistered: async function () {
                    events.push('ensure');
                },
                repairRegistered: async function () {
                    events.push('repair');
                },
            };
        },
        createMacosBrokerTransport: function () {
            events.push('broker');
            return {
                request: async function () { return 'ready'; },
                close: async function () {},
            };
        },
    }));

    assert.equal(await transport.request('request'), 'ready');
    assert.deepEqual(events, ['repair', 'broker']);
    await transport.close();
});
```

- [ ] **Step 2: Verify the transport test is red**

Run:

```bash
node --test \
  --test-name-pattern="repair transport replaces" \
  plugin/host/platform-helper-transport.test.js
```

Expected: fail because the current transport always calls
`ensureRegistered()`.

- [ ] **Step 3: Select the approved registration operation**

Require `repairRegistered` in `validMacosRegistration`:

```javascript
&& typeof value.ensureRegistered === 'function'
&& typeof value.repairRegistered === 'function';
```

Before opening the broker in `connect()`:

```javascript
if (input.repairRegistration === true) {
    await macosRegistration.repairRegistered();
} else {
    await macosRegistration.ensureRegistered();
}
```

Do not add `bootout` or launchd knowledge to the transport.

- [ ] **Step 4: Run the complete transport suite**

Run:

```bash
node --test plugin/host/platform-helper-transport.test.js
```

Expected: the repair ordering test and all Windows/macOS existing tests pass.
In the existing process-boundary source test, remove only `\bbootout\b` from
the registration-source forbidden regex so it becomes:

```javascript
/shell:\s*true|\bexec\s*\(|\bspawn\s*\(|\bkill\b|stdio:\s*'inherit'/i
```

The test must continue to reject shell execution, inherited stdio, kill
behavior, and process APIs in other host files. Behavioral registrar tests,
not a source-text assertion, prove the exact `bootout` operation.

- [ ] **Step 5: Add a red HostController replacement test**

In `plugin/panel/test/hostBridge.test.js`, add
`host controller repair replaces the stale helper binding and handshakes the replacement`.

Use the existing `fakeHostDependencyRuntime`, `macHostAdapter`, and fake host
shape. Have `createPlatformHelperTransportImpl(options)` record
`options.repairRegistration` and return transport 1 for the normal bind and
transport 2 for the repair bind. Client 1's `capabilities()` rejects with code
`PLATFORM_HELPER_REPAIR_REQUIRED`; client 2 returns:

```javascript
{
  protocolVersion: 1,
  helperVersion: 'test-helper',
  authenticatedCaller: true,
  secretBackend: 'keychain',
  methods: ['secret.get', 'secret.set', 'secret.delete'],
}
```

Assert:

```javascript
await assert.rejects(
  controller.getHost().capabilities(),
  { code: 'PLATFORM_HELPER_REPAIR_REQUIRED' },
);
assert.equal(typeof controller.repairPlatformHelper, 'function');
assert.equal(
  (await controller.repairPlatformHelper()).authenticatedCaller,
  true,
);
assert.deepEqual(repairModes, [false, true]);
assert.equal((await controller.getHost().capabilities()).helperVersion, 'test-helper');
assert.equal(firstClientCloses, 1);
```

- [ ] **Step 6: Verify the HostController test is red**

Run:

```bash
node --test \
  --test-name-pattern="repair replaces the stale helper binding" \
  plugin/panel/test/hostBridge.test.js
```

Expected: fail because `repairPlatformHelper` is not exported by the
controller and the transport factory is never called with repair mode.

- [ ] **Step 7: Refactor the helper bind around one reusable context**

In `createHostController`, add:

```javascript
let helperBindingContext = null;
```

Extend `bindPlatformHelperFacade` to accept
`repairRegistration = false`, pass the boolean to the transport factory, and
store the binding context for the current host:

```javascript
transport = transportFactory({
  platformId: adapter.id,
  runtime: helperRuntime(adapter.id),
  repairRegistration,
});
```

After the current host is established in `start`, retain only:

```javascript
helperBindingContext = { cepRequire, extRoot, hostInstance: nextHost };
```

Clear `helperBindingContext` wherever the current lifecycle clears `host`,
including start replacement, startup failure, and `beforeunload`.

- [ ] **Step 8: Implement `repairPlatformHelper()` with a fresh binding**

Add an async controller method with this behavior:

```javascript
async function repairPlatformHelper() {
  const context = helperBindingContext;
  const currentHost = host;
  if (adapter.id !== 'macos-arm64'
      || !context
      || !currentHost
      || context.hostInstance !== currentHost) {
    throw helperUnavailableError();
  }

  const priorClient = helperClient;
  helperClient = null;
  closeHelperClient(priorClient);
  bindPlatformHelperFacade({
    ...context,
    repairRegistration: true,
  });

  if (host !== currentHost) {
    throw helperUnavailableError();
  }
  try {
    return await currentHost.capabilities();
  } catch (error) {
    throw sanitizeHelperError(error);
  }
}
```

Return it from the controller:

```javascript
return { start, restart, repairPlatformHelper, getHost: () => host };
```

The new binding replaces all helper facade methods on `currentHost`. Calling
`currentHost.capabilities()` even when construction produced no client
preserves the sanitized binding error installed by
`bindPlatformHelperFacade`. A failed replacement remains a repairable state;
another explicit invocation constructs another fresh binding.

- [ ] **Step 9: Add and pass failure-boundary tests**

Add:

1. `host controller repair preserves a sanitized replacement failure`
   - replacement client rejects with a message containing a private path and
     code `HELPER_START_FAILED`;
   - controller rejection has code `HELPER_START_FAILED`;
   - returned message contains neither the path nor the native message.
2. `Windows host controller does not offer macOS helper replacement`
   - use the Windows adapter;
   - `repairPlatformHelper()` rejects with `HELPER_UNAVAILABLE`;
   - no repair-mode transport is constructed.

Run:

```bash
node --test \
  plugin/host/platform-helper-transport.test.js \
  plugin/panel/test/hostBridge.test.js
```

Expected: all pass.

- [ ] **Step 10: Commit transport and CEP lifecycle integration**

```bash
git add \
  plugin/host/platform-helper-transport.js \
  plugin/host/platform-helper-transport.test.js \
  plugin/panel/src/cep/hostBridge.js \
  plugin/panel/test/hostBridge.test.js
git commit -m "feat(panel): rebuild helper binding after explicit repair"
```

---

### Task 4: Wire the Repair Helper Action Into Settings

**Files:**

- Modify: `plugin/panel/src/app/providerInitState.js`
- Modify: `plugin/panel/test/providerInitState.test.js`
- Modify: `plugin/panel/src/app/App.jsx`
- Modify: `plugin/panel/src/screens/SettingsScreen.jsx`
- Modify: `plugin/client/dist/app.js`

**Interfaces:**

- Consumes from Task 3:
  `ctrl.current.repairPlatformHelper() -> Promise<Capabilities>`.
- Produces:
  `platformHelperRepairView(providerInit, repairing, hasAction) ->
  null | { disabled: boolean, label: "repair" | "repairing" }`.
- Produces:
  `providerRepairFailure(error) -> { state: "unavailable",
  error: "PLATFORM_HELPER_REPAIR_REQUIRED", detail: string }`.
- Adds `SettingsScreen` props:
  `onRepairPlatformHelper?: () => Promise<void>` and
  `providerRepairing?: boolean`.
- Preserves: provider lists and provider secrets remain unchanged while helper
  repair is unavailable or fails.

- [ ] **Step 1: Add red view-model tests**

In `plugin/panel/test/providerInitState.test.js`, import
`platformHelperRepairView` and add:

```javascript
test('Repair Helper is available only for the explicit repair-required state', async () => {
  const {
    platformHelperRepairView,
    providerRepairFailure,
  } = await import('../src/app/providerInitState.js');
  assert.deepEqual(
    platformHelperRepairView(
      { state: 'unavailable', error: 'PLATFORM_HELPER_REPAIR_REQUIRED' },
      false,
      true,
    ),
    { disabled: false, label: 'repair' },
  );
  assert.deepEqual(
    platformHelperRepairView(
      { state: 'unavailable', error: 'PLATFORM_HELPER_REPAIR_REQUIRED' },
      true,
      true,
    ),
    { disabled: true, label: 'repairing' },
  );
  for (const providerInit of [
    { state: 'checking', error: '' },
    { state: 'ready', error: '' },
    { state: 'unavailable', error: 'PLATFORM_HELPER_START_FAILED' },
  ]) {
    assert.equal(platformHelperRepairView(providerInit, false, true), null);
  }
  assert.equal(
    platformHelperRepairView(
      { state: 'unavailable', error: 'PLATFORM_HELPER_REPAIR_REQUIRED' },
      false,
      false,
    ),
    null,
  );

  const failure = new Error('private helper path');
  failure.code = 'HELPER_START_FAILED';
  assert.deepEqual(providerRepairFailure(failure), {
    state: 'unavailable',
    error: 'PLATFORM_HELPER_REPAIR_REQUIRED',
    detail: 'PLATFORM_HELPER_START_FAILED',
  });
  assert.equal(JSON.stringify(providerRepairFailure(failure)).includes('private helper path'), false);
});
```

- [ ] **Step 2: Verify the view-model test is red**

Run:

```bash
node --test \
  --test-name-pattern="Repair Helper is available" \
  plugin/panel/test/providerInitState.test.js
```

Expected: fail because `platformHelperRepairView` is not exported.

- [ ] **Step 3: Implement the pure view model**

In `plugin/panel/src/app/providerInitState.js`:

```javascript
export function platformHelperRepairView(providerInit, repairing, hasAction) {
  if (!hasAction
      || providerInit?.state !== 'unavailable'
      || providerInit?.error !== 'PLATFORM_HELPER_REPAIR_REQUIRED') {
    return null;
  }
  return {
    disabled: repairing === true,
    label: repairing === true ? 'repairing' : 'repair',
  };
}

export function providerRepairFailure(error) {
  const classified = providerInitFailure(error);
  return {
    state: 'unavailable',
    error: 'PLATFORM_HELPER_REPAIR_REQUIRED',
    detail: classified.error,
  };
}
```

Run the Step 2 command and expect pass.

- [ ] **Step 4: Render the explicit action from the approved state**

In `SettingsScreen.jsx`:

- import `platformHelperRepairView`;
- add Chinese strings `repairHelper: "修复 Helper"` and
  `repairingHelper: "正在修复 Helper…"`; add English strings
  `repairHelper: "Repair Helper"` and
  `repairingHelper: "Repairing Helper…"`;
- add props `onRepairPlatformHelper` and `providerRepairing = false`;
- compute:

```javascript
const helperRepair = platformHelperRepairView(
  providerInit,
  providerRepairing,
  typeof onRepairPlatformHelper === 'function',
);
```

Inside the existing provider alert, after the diagnostic text, render:

```jsx
{helperRepair ? (
  <div style={{ marginTop: 6 }}>
    <Button
      variant="secondary"
      size="sm"
      disabled={helperRepair.disabled}
      onClick={onRepairPlatformHelper}
    >
      {helperRepair.label === 'repairing' ? t.repairingHelper : t.repairHelper}
    </Button>
  </div>
) : null}
```

Do not render the action for generic helper startup failures or provider-store
failures.

Change the displayed diagnostic suffix from `providerInit.error` to
`providerInit.detail || providerInit.error`. This keeps the action keyed to the
repair-required state while showing only an existing sanitized classification
such as `PLATFORM_HELPER_START_FAILED`.

- [ ] **Step 5: Wire one repair attempt and provider reinitialization**

In `App.jsx`, add `providerRepairFailure` to the existing import from
`./providerInitState`, then add:

```javascript
const [providerRepairing, setProviderRepairing] = React.useState(false);
const [providerInitEpoch, setProviderInitEpoch] = React.useState(0);
```

Add an async callback:

```javascript
const repairPlatformHelper = React.useCallback(async () => {
  if (providerRepairing) return;
  setProviderRepairing(true);
  try {
    const controller = ctrl.current;
    if (!controller || typeof controller.repairPlatformHelper !== 'function') {
      throw providerRuntimeUnavailableError();
    }
    await controller.repairPlatformHelper();
    pushLog('Platform Helper repaired; rechecking protected provider state');
    setProviderInitEpoch((current) => current + 1);
  } catch (error) {
    setProviderInit(providerRepairFailure(error));
    pushLog('Platform Helper repair failed: ' + (
      typeof error?.code === 'string' ? error.code : 'HELPER_UNAVAILABLE'
    ));
  } finally {
    setProviderRepairing(false);
  }
}, [providerRepairing, pushLog]);
```

Add `providerInitEpoch` to the existing provider initialization effect's
dependency array. The effect remains the single place that performs the full
`capabilities()` check, migration ordering, protected-secret readback, and
ready-state transition.

Pass to `SettingsScreen`:

```jsx
providerInit={providerInit}
providerRepairing={providerRepairing}
onRepairPlatformHelper={repairPlatformHelper}
```

The alert remains visible and the button remains disabled during the repair
promise. Success triggers one provider initialization rerun; failure keeps the
sanitized repair-required state.

- [ ] **Step 6: Run panel state and helper lifecycle tests**

Run:

```bash
node --test \
  plugin/panel/test/providerInitState.test.js \
  plugin/panel/test/providerUiClosure.test.js \
  plugin/panel/test/hostBridge.test.js
```

Expected: all pass. Existing provider closure tests continue to prove that
provider data is not replaced on repairable initialization failure.

- [ ] **Step 7: Build the panel and verify the generated bundle**

Run:

```bash
npm --prefix plugin/panel run build
```

Expected: build exits 0 and updates `plugin/client/dist/app.js`.

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 8: Commit the user-visible Repair Helper action**

```bash
git add \
  plugin/panel/src/app/providerInitState.js \
  plugin/panel/test/providerInitState.test.js \
  plugin/panel/src/app/App.jsx \
  plugin/panel/src/screens/SettingsScreen.jsx \
  plugin/client/dist/app.js
git commit -m "feat(panel): expose explicit platform helper repair"
```

---

## Integrated Verification Gate

After all four task reviews are clean, run the following without editing
production source between commands.

### Focused Python

```bash
uv run pytest \
  packages/snapshot-mss/tests/test_mss_snapshot.py \
  packages/core/tests/test_snapshot_discovery.py \
  packages/core/tests/test_status_tool.py \
  packages/core/tests/test_server_native_tools.py \
  -q
```

### Focused Helper and Panel

```bash
node --test \
  plugin/host/platform-helper-registration.test.js \
  plugin/host/platform-helper-transport.test.js \
  plugin/panel/test/hostBridge.test.js \
  plugin/panel/test/providerInitState.test.js \
  plugin/panel/test/providerUiClosure.test.js
```

### Affected Package Regressions

```bash
npm --prefix plugin/host test
npm --prefix plugin/panel test
npm --prefix plugin/panel run build
node --test scripts/package/test/*.test.mjs
git diff --exit-code -- plugin/client/dist/app.js
git diff --check
git status --short
```

Expected:

- every test/build command exits 0;
- rebuilding the panel leaves the committed bundle unchanged;
- status contains no generated or test residue;
- the only branch changes are the approved design, plan, #178 track, registrar
  primitive, transport/HostController integration, Settings action, tests,
  documentation, and generated bundle.

## Review Gate

- Generate a whole-branch review package from merge base `357b20c` through the
  final implementation head.
- Dispatch one most-capable final reviewer for spec compliance and code
  quality.
- Classify each finding as current blocker, follow-up, or out of scope.
- If the review finds current blockers, dispatch one combined fix wave and one
  scoped re-review. Do not add a second broad implementation wave.

## Real macOS/AE HDEV Gate

Use the built development panel/helper from this worktree. Do not create an
`.aep` fixture and do not mutate an AE project.

1. Record branch head, helper manifest path, helper executable path, component
   versions, sizes, and mtimes.
2. Register the fixed product label once with a controlled stale Program path.
3. Launch the normal AE build and open the actual panel.
4. Confirm provider initialization reports
   `PLATFORM_HELPER_REPAIR_REQUIRED` and shows Repair Helper.
5. Trigger Repair Helper through the panel without asking the user to perform
   routine GUI steps.
6. Verify `/bin/launchctl print
   gui/<uid>/com.junkdoge.ae-mcp.platform-helper` reports the current verified
   helper Program.
7. From real CEP, verify `capabilities()` reports protocol version 1, the
   expected method set, and `authenticatedCaller: true`.
8. Use one non-sensitive temporary reference to perform
   `secretSet → secretGet → secretDelete`; verify the final read reports absent.
9. Make one representative public MCP read and record its structured result.
10. Restore the development machine to the current verified registration and
    record that no temporary secret remains.

This is a narrow development HDEV, not a signed release test and not an AEGP
T5/T6 run.

## PR, Merge, and Clean-Main Closure

1. Push the branch and open one PR linking #178 and #66.
2. Include separate per-issue acceptance summaries in the PR body.
3. Run required CI once after the final concentrated review is clean.
4. Merge only when focused tests, required CI, final review, and pre-merge HDEV
   are green.
5. Build from clean `main` at the merge commit and repeat only the minimal
   stale-registration Repair Helper plus `capabilities()` smoke.
6. Close #178 with the predicate, discovery/filtering, docs, and CI evidence.
7. Close #66 with explicit repair, real AE HDEV, merge, and clean-main smoke
   evidence.
8. Leave #67, #69, and #70 open with their existing product boundaries.
