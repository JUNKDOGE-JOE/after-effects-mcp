# Selected Runtime Sidecar Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS production Claude Agent sidecar come only from the RuntimeManager generation already selected and verified for the panel.

**Architecture:** Extend the existing pure `resolveSidecarPath()` boundary to consume RuntimeManager's existing `componentReceipt.canonicalPath`; do not add a second pointer reader or a general payload registry. Add a small pure selection-state adapter for `App.jsx` so startup remains non-throwing while macOS waits for runtime activation, and so incompatible selections disable the Claude channel before any sidecar spawn.

**Tech Stack:** CEP panel JavaScript (ES modules), React 18, Node `node:test`, existing platform path adapters, existing RuntimeManager receipts.

## Global Constraints

- macOS production must never fall back to `<extension>/runtime/macos-arm64/...` after RuntimeManager is enabled.
- `.debug` development continues to use `<extension>/sidecar/agent-sidecar.mjs`.
- Windows continues to use `<extension>/runtime/windows-x64/node/sidecar/agent-sidecar.mjs`.
- Consume the existing `componentReceipt`; do not parse `runtime/current` or install records outside RuntimeManager.
- Do not add PID, start-token, heartbeat, process census, lock, pruning, repair, generalized payload-registry, or runner infrastructure.
- Do not add full-tree hashing; RuntimeManager's existing manifest verification remains authoritative.
- Do not change Claude sidecar protocol, Provider behavior, helper registration, capture, signing, notarization, or installer behavior.
- Every production-code behavior change follows RED -> GREEN -> focused regression; do not write implementation before observing the specified test fail for the expected reason.
- Classify review findings under AGENTS.md section 5. Only reproduced current-path blockers may expand P0; all other hardening stays follow-up or out of scope.

---

### Task 1: Resolve the Sidecar from the verified runtime receipt

**Files:**
- Modify: `plugin/panel/src/cep/claudeAuth.js:7-22`
- Modify: `plugin/panel/test/claudeAuth.test.js:1-72`

**Interfaces:**
- Consumes: RuntimeManager success results shaped as `{ ok, action, componentReceipt }`, where `componentReceipt.component === "core-runtime"`, `componentReceipt.platform === platform.id`, and `componentReceipt.canonicalPath` is the verified runtime directory.
- Produces: `resolveSidecarPath({ extRoot, fsImpl?, platform?, runtimeSelection? }): string | null`.
- Error: incompatible provided selections throw an `Error` whose `code` is exactly `RUNTIME_SIDECAR_SELECTION_INCOMPATIBLE`.
- `null`: macOS production has not received a verified selection yet. It is a pending state, not a fallback path.

- [ ] **Step 1: Add complete platform and runtime-selection fixtures**

At the top of `plugin/panel/test/claudeAuth.test.js`, add:

```js
import path from 'node:path';
```

After `windowsPlatform()`, add fixtures that mirror the RuntimeManager result fields consumed at the boundary:

```js
function macPaths() {
  const runtimeRoot = '/Users/test/.ae-mcp/runtime';
  return {
    runtimeRoot,
    join: (parts) => path.posix.join(...parts),
    resolve: (parts) => path.posix.resolve(...parts),
    isAbsolute: (value) => path.posix.isAbsolute(value),
    contains: (root, candidate) => {
      const normalizedRoot = path.posix.resolve(root);
      const normalizedCandidate = path.posix.resolve(candidate);
      return normalizedCandidate === normalizedRoot
        || normalizedCandidate.startsWith(normalizedRoot + '/');
    },
  };
}

function macPlatform() {
  return { id: 'macos-arm64', paths: macPaths() };
}

function selectedRuntime(canonicalPath, action = 'ready') {
  return {
    ok: true,
    action,
    launcher: '/Users/test/.ae-mcp/bin/ae-mcp',
    relative: 'generations/g-0123456789abcdef',
    version: '0.9.3',
    sourceCommitSha: 'a'.repeat(40),
    componentReceipt: {
      schemaVersion: 1,
      component: 'core-runtime',
      platform: 'macos-arm64',
      version: '0.9.3',
      sourceRevision: 'a'.repeat(40),
      sourceRevisionRole: 'advisory',
      canonicalPath,
      installReceiptPath: '/Users/test/.ae-mcp/runtime/generations/g-0123456789abcdef/install-record.json',
      generation: 'generations/g-0123456789abcdef',
      layerId: 'b'.repeat(64),
      signals: {},
      stableLauncher: {
        canonicalPath: '/Users/test/.ae-mcp/bin/ae-mcp',
        installReceiptPath: '/Users/test/.ae-mcp/runtime/stable-launcher-record.json',
        signal: {},
      },
    },
  };
}
```

- [ ] **Step 2: Write failing macOS selection tests**

Add these tests before the existing Windows production tests:

```js
test('resolveSidecarPath waits for a verified macOS production runtime selection', () => {
  const result = resolveSidecarPath({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    fsImpl: { existsSync: () => false },
  });

  assert.equal(result, null);
});

test('resolveSidecarPath uses the selected macOS generation for ready retained and fallback results', () => {
  const cases = [
    ['ready', '/Users/test/.ae-mcp/runtime/layers/a/i-ready/macos-arm64',
      '/Users/test/.ae-mcp/runtime/layers/a/i-ready/macos-arm64/node/sidecar/agent-sidecar.mjs'],
    ['retained', '/Users/test/.ae-mcp/runtime/layers/b/i-retained/macos-arm64',
      '/Users/test/.ae-mcp/runtime/layers/b/i-retained/macos-arm64/node/sidecar/agent-sidecar.mjs'],
    ['fallback', '/Users/test/.ae-mcp/runtime/layers/c/i-fallback/macos-arm64',
      '/Users/test/.ae-mcp/runtime/layers/c/i-fallback/macos-arm64/node/sidecar/agent-sidecar.mjs'],
  ];

  for (const [action, canonicalPath, expected] of cases) {
    const result = resolveSidecarPath({
      extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
      platform: macPlatform(),
      runtimeSelection: selectedRuntime(canonicalPath, action),
      fsImpl: { existsSync: () => false },
    });
    assert.equal(result, expected);
  }
});

test('resolveSidecarPath rejects incompatible macOS runtime receipts without an extension fallback', () => {
  const base = selectedRuntime('/Users/test/.ae-mcp/runtime/layers/a/i-valid/macos-arm64');
  const cases = [
    { ...base, componentReceipt: { ...base.componentReceipt, component: 'platform-helper' } },
    { ...base, componentReceipt: { ...base.componentReceipt, platform: 'windows-x64' } },
    { ...base, componentReceipt: { ...base.componentReceipt, canonicalPath: 'relative/runtime' } },
    { ...base, componentReceipt: { ...base.componentReceipt, canonicalPath: '/Applications/Adobe/CEP/extensions/ae-mcp/runtime/macos-arm64' } },
  ];

  for (const runtimeSelection of cases) {
    assert.throws(
      () => resolveSidecarPath({
        extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
        platform: macPlatform(),
        runtimeSelection,
        fsImpl: { existsSync: () => false },
      }),
      (error) => error?.code === 'RUNTIME_SIDECAR_SELECTION_INCOMPATIBLE',
    );
  }
});
```

Name the break these tests catch: restoring the extension-owned macOS runtime candidate, ignoring retained/fallback selection, or accepting an unrelated/out-of-root receipt.

- [ ] **Step 3: Run the new tests and verify RED**

Run:

```bash
node --test plugin/panel/test/claudeAuth.test.js
```

Expected: the macOS pending test fails because current code returns
`/Applications/Adobe/CEP/extensions/ae-mcp/runtime/macos-arm64/node/sidecar/agent-sidecar.mjs`;
the selected-generation test fails for the same reason; and incompatible receipts do not throw.

- [ ] **Step 4: Implement the minimal receipt-based resolver**

In `plugin/panel/src/cep/claudeAuth.js`, add:

```js
function incompatibleSidecarSelection(message) {
  const error = new Error(message);
  error.code = 'RUNTIME_SIDECAR_SELECTION_INCOMPATIBLE';
  return error;
}
```

Change the resolver signature and production branch to:

```js
export function resolveSidecarPath({
  extRoot,
  fsImpl,
  platform,
  runtimeSelection,
} = {}) {
  const adapter = platform || createPlatformAdapter();
  const root = normalizeCepSystemPath(extRoot || adapter.paths.configRoot, adapter);
  const developmentMarker = adapter.paths.join([root, '.debug']);
  const developmentSidecar = adapter.paths.join([root, 'sidecar', 'agent-sidecar.mjs']);
  const extensionRuntimeSidecar = adapter.paths.join([
    root, 'runtime', adapter.id, 'node', 'sidecar', 'agent-sidecar.mjs',
  ]);
  const fs = fsImpl || adapter.fs;
  if (!fs || typeof fs.existsSync !== 'function') {
    throw new Error('platform filesystem is unavailable');
  }
  if (fs.existsSync(developmentMarker) && fs.existsSync(developmentSidecar)) {
    return developmentSidecar;
  }
  if (adapter.id !== 'macos-arm64') return extensionRuntimeSidecar;
  if (!runtimeSelection) return null;

  const receipt = runtimeSelection.componentReceipt;
  const canonicalPath = receipt?.canonicalPath;
  if (receipt?.component !== 'core-runtime'
      || receipt?.platform !== adapter.id
      || typeof canonicalPath !== 'string'
      || !adapter.paths.isAbsolute(canonicalPath)
      || !adapter.paths.contains(adapter.paths.runtimeRoot, canonicalPath)) {
    throw incompatibleSidecarSelection(
      'The selected runtime does not own a compatible Claude sidecar payload',
    );
  }
  return adapter.paths.join([
    canonicalPath, 'node', 'sidecar', 'agent-sidecar.mjs',
  ]);
}
```

Do not inspect the sidecar file independently here: the selected runtime
manifest has already been verified by RuntimeManager.

- [ ] **Step 5: Verify GREEN and existing Windows/development behavior**

Run:

```bash
node --test plugin/panel/test/claudeAuth.test.js
```

Expected: all tests pass, including the pre-existing `.debug`, Windows, probe,
timeout, and stderr tests.

- [ ] **Step 6: Commit Task 1**

```bash
git add plugin/panel/src/cep/claudeAuth.js plugin/panel/test/claudeAuth.test.js
git commit -m "fix(panel): resolve sidecar from selected runtime"
```

---

### Task 2: Gate App probing on the selected Sidecar state

**Files:**
- Modify: `plugin/panel/src/cep/claudeAuth.js`
- Modify: `plugin/panel/test/claudeAuth.test.js`
- Modify: `plugin/panel/src/app/App.jsx:24,609-653,831-856,1122-1140`
- Modify: `docs/RUNTIME_MANAGER.md:32-38`

**Interfaces:**
- Consumes: `runtimeActivation` shaped as `{ state: "starting"|"ready"|"error", result, error }`.
- Produces: `resolveSidecarSelection({ runtimeActivation, extRoot, fsImpl?, platform? })` returning exactly one of:
  - `{ state: "ready", path: string, error: null }`
  - `{ state: "pending", path: null, error: null }`
  - `{ state: "error", path: null, error: Error }`
- App passes `runtimeActivation.result` only through this adapter; it does not read runtime pointers.

- [ ] **Step 1: Write failing selection-state tests**

Extend the import in `plugin/panel/test/claudeAuth.test.js`:

```js
import {
  probeClaudeLogin,
  resolveSidecarPath,
  resolveSidecarSelection,
} from '../src/cep/claudeAuth.js';
```

Add:

```js
test('resolveSidecarSelection keeps macOS pending until runtime activation is ready', () => {
  const selection = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'starting', result: null, error: null },
    fsImpl: { existsSync: () => false },
  });

  assert.deepEqual(selection, { state: 'pending', path: null, error: null });
});

test('resolveSidecarSelection exposes the verified path only after macOS activation', () => {
  const runtime = selectedRuntime('/Users/test/.ae-mcp/runtime/layers/a/i-active/macos-arm64');
  const selection = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'ready', result: runtime, error: null },
    fsImpl: { existsSync: () => false },
  });

  assert.deepEqual(selection, {
    state: 'ready',
    path: '/Users/test/.ae-mcp/runtime/layers/a/i-active/macos-arm64/node/sidecar/agent-sidecar.mjs',
    error: null,
  });
});

test('resolveSidecarSelection preserves RuntimeManager and receipt errors before dispatch', () => {
  const runtimeError = Object.assign(new Error('runtime failed'), {
    code: 'RUNTIME_MANIFEST_INVALID',
  });
  const activationFailure = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'error', result: null, error: runtimeError },
    fsImpl: { existsSync: () => false },
  });
  assert.equal(activationFailure.state, 'error');
  assert.equal(activationFailure.path, null);
  assert.equal(activationFailure.error, runtimeError);

  const runtime = selectedRuntime('/Applications/Adobe/CEP/extensions/ae-mcp/runtime/macos-arm64');
  const receiptFailure = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'ready', result: runtime, error: null },
    fsImpl: { existsSync: () => false },
  });
  assert.equal(receiptFailure.state, 'error');
  assert.equal(receiptFailure.path, null);
  assert.equal(receiptFailure.error.code, 'RUNTIME_SIDECAR_SELECTION_INCOMPATIBLE');
});

test('resolveSidecarSelection keeps Windows and debug paths independent of RuntimeManager', () => {
  const windows = resolveSidecarSelection({
    extRoot: 'C:\\ext',
    platform: windowsPlatform(),
    runtimeActivation: { state: 'ready', result: null, error: null },
    fsImpl: { existsSync: () => false },
  });
  assert.deepEqual(windows, {
    state: 'ready',
    path: 'C:\\ext\\runtime\\windows-x64\\node\\sidecar\\agent-sidecar.mjs',
    error: null,
  });

  const debug = resolveSidecarSelection({
    extRoot: '/Applications/Adobe/CEP/extensions/ae-mcp',
    platform: macPlatform(),
    runtimeActivation: { state: 'ready', result: null, error: null },
    fsImpl: {
      existsSync: (value) => value === '/Applications/Adobe/CEP/extensions/ae-mcp/.debug'
        || value === '/Applications/Adobe/CEP/extensions/ae-mcp/sidecar/agent-sidecar.mjs',
    },
  });
  assert.deepEqual(debug, {
    state: 'ready',
    path: '/Applications/Adobe/CEP/extensions/ae-mcp/sidecar/agent-sidecar.mjs',
    error: null,
  });
});

test('probeClaudeLogin does not resolve Node or spawn while Sidecar selection is pending', async () => {
  let nodeResolutions = 0;
  let spawns = 0;
  const result = await probeClaudeLogin({
    sidecarPath: null,
    resolveNode: async () => {
      nodeResolutions += 1;
      return { ok: true, nodePath: 'node', version: '20.0.0' };
    },
    spawnImpl: () => {
      spawns += 1;
      return makeProc();
    },
  });

  assert.deepEqual(result, {
    loggedIn: false,
    nodeOk: false,
    detail: 'verified runtime sidecar is not ready',
  });
  assert.equal(nodeResolutions, 0);
  assert.equal(spawns, 0);
});
```

Name the break these tests catch: spawning before activation, hiding the
authoritative RuntimeManager error, or accidentally imposing macOS
RuntimeManager behavior on Windows/development.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test plugin/panel/test/claudeAuth.test.js
```

Expected: module import fails because `resolveSidecarSelection` is not exported.

- [ ] **Step 3: Implement the pure selection-state adapter**

In `plugin/panel/src/cep/claudeAuth.js`, after `resolveSidecarPath()`, add:

```js
export function resolveSidecarSelection({
  runtimeActivation,
  extRoot,
  fsImpl,
  platform,
} = {}) {
  const adapter = platform || createPlatformAdapter();
  if (adapter.id === 'macos-arm64'
      && runtimeActivation?.state === 'error'
      && runtimeActivation.error) {
    return { state: 'error', path: null, error: runtimeActivation.error };
  }
  try {
    const path = resolveSidecarPath({
      extRoot,
      fsImpl,
      platform: adapter,
      runtimeSelection: runtimeActivation?.state === 'ready'
        ? runtimeActivation.result
        : null,
    });
    return path
      ? { state: 'ready', path, error: null }
      : { state: 'pending', path: null, error: null };
  } catch (error) {
    return { state: 'error', path: null, error };
  }
}
```

At the start of `probeClaudeLogin()`, before selecting the platform adapter or
resolving Node, add:

```js
if (!sidecarPath) {
  return {
    loggedIn: false,
    nodeOk: false,
    detail: 'verified runtime sidecar is not ready',
  };
}
```

- [ ] **Step 4: Verify the state adapter and no-spawn guard are GREEN**

Run:

```bash
node --test plugin/panel/test/claudeAuth.test.js
```

Expected: all Claude-auth tests pass.

- [ ] **Step 5: Wire App to the selection state without an interim probe**

In `plugin/panel/src/app/App.jsx`, import `resolveSidecarSelection` instead of
`resolveSidecarPath`:

```js
import { probeClaudeLogin, resolveSidecarSelection } from '../cep/claudeAuth';
```

Replace the existing `sidecarPath` memo with:

```js
const sidecarSelection = React.useMemo(() => resolveSidecarSelection({
  extRoot,
  platform,
  runtimeActivation,
}), [extRoot, platform, runtimeActivation]);
const sidecarPath = sidecarSelection.path;
```

At the start of `runClaudeProbe`, after `setProbe(null)`, add the gate:

```js
if (sidecarSelection.state !== 'ready') {
  if (sidecarSelection.state === 'error') {
    const error = sidecarSelection.error;
    setProbe({
      loggedIn: false,
      nodeOk: false,
      detail: error?.message || String(error),
    });
  }
  return () => { alive = false; };
}
```

Add `sidecarSelection` to the callback dependencies:

```js
}, [platform, resolvePanelNode, sidecarPath, sidecarSelection]);
```

The existing `probe === null` channel state keeps the composer/backend disabled
while selection is pending. An error sets `nodeOk:false`, which disables both
Claude subscription and Provider sidecar channels before `sendUser`.

- [ ] **Step 6: Document the selected Sidecar ownership**

After the schema-v2/current/previous paragraph in `docs/RUNTIME_MANAGER.md`,
add one English and one Chinese paragraph:

```md
On macOS production paths, the panel also resolves the Claude Agent sidecar
from the selected generation's verified `componentReceipt.canonicalPath`.
It does not pair the selected Node executable with an extension-owned sidecar
or fall back to another payload copy.

在 macOS 正式路径中，面板也会从已选 generation 的已验证
`componentReceipt.canonicalPath` 解析 Claude Agent Sidecar。它不会把已选
Node 可执行文件与扩展目录中的另一份 Sidecar 混用，也不会回退到其他
payload 副本。
```

- [ ] **Step 7: Run focused tests and the production panel build**

Run:

```bash
node --test \
  plugin/panel/test/claudeAuth.test.js \
  plugin/panel/test/runtimeManager.test.js \
  plugin/panel/test/runtimeActivationWiring.test.js
(cd plugin/panel && npm run build)
```

Expected: focused tests pass and the React production bundle builds without an
import, hook-dependency, or syntax error.

- [ ] **Step 8: Run the complete panel suite**

Run:

```bash
(cd plugin/panel && npm test)
```

Expected: all panel tests pass with zero failures.

- [ ] **Step 9: Commit Task 2**

```bash
git add \
  plugin/panel/src/cep/claudeAuth.js \
  plugin/panel/test/claudeAuth.test.js \
  plugin/panel/src/app/App.jsx \
  docs/RUNTIME_MANAGER.md
git commit -m "fix(panel): bind Claude sidecar to runtime activation"
```

---

## Completion Gate

After both tasks pass their task-scoped reviews:

1. Run one concentrated whole-branch review.
2. Run `git diff --check`.
3. Re-run the focused tests, panel production build, and complete panel suite
   from the reviewed HEAD.
4. Do not start AE unless the implementation changed installed-runtime
   behavior beyond the selected-path wiring described above.
5. Open one PR for #148, wait for required CI, merge only if review and CI have
   no current-path blocker, then close #148 with its focused verification
   evidence.
6. Stop at the repository's next-package approval gate before starting #66.
