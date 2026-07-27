# Agile Real-AE Development Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS development profile that reuses installed dependencies, updates only explicitly selected components, and proves current checkout behavior with a bounded public-MCP real-AE HDEV smoke while reserving full T5/T6 for packaged release candidates.

**Architecture:** Keep the existing `AE_MCP_DEV_RUNTIME` panel boundary and bind its child process to the canonical checkout. Add a dependency-free Node CLI split into a pure command contract and a macOS executor; only the explicit `bootstrap` action may invoke dependency managers. Add a standalone seven-call Python HDEV driver whose evidence is permanently non-candidate, then update repository policy so ordinary capability PRs use HDEV and release candidates retain strict packaged T5/T6.

**Tech Stack:** Node.js 24 ESM and `node:test`; CEP React/Node runtime manager; Python 3.13, asyncio, MCP SDK and pytest; existing macOS CEP/native atomic installers; After Effects 2026 public MCP and AEGP.

## Global Constraints

- Work only in `/Users/junk_doge/Documents/ae-mcp/.worktrees/dev-runtime-path` on `codex/dev-runtime-path`; do not touch the root checkout's #67/#69 changes.
- `bootstrap` is the only command allowed to run `uv sync`, `npm ci`, or another dependency installer, and only after the user explicitly invokes it.
- `doctor`, `launch-ae`, `sync`, and `smoke` must never run dependency installation, portable-runtime packaging, ZXP packaging, signing, or a release installer.
- Core uses the canonical checkout's `.venv/bin/python3 -B -I -m ae_mcp`; it creates no RuntimeManager generation, pointer update, or RuntimeManager lock.
- CEP keeps off-scan staging, tree-shape validation, atomic replacement, rollback, and zero checkout symlinks under Adobe scan roots.
- Native reuses the installed Adobe SDK/Xcode toolchain but still requires a clean commit, AE stopped, the existing development installer, and a formal AE restart.
- Both profiles retain strict wire version, capability digest, RPC schema digest, `productVersion`, platform, architecture, entrypoint, load-result, scan-root, and uncertain-write gates.
- HDEV always emits `candidateRun=false`, `candidateEvidence=false`, and `validationProfile="development"`.
- HDEV uses one `ephemeral-validation` `.aep`, no Save As copies after its initial naming save, real Undo, independent readback, audit/provenance checks, and recovery/archive accounting.
- Full T5/T6 run only against a frozen packaged release candidate; this implementation does not run T5 or T6.
- Do not add Windows support, dirty-worktree native identity, native incremental object caching, ZXP changes, new MCP tools, new AEGP suites, or changed tool behavior.
- Any new invariant must be mutation-proved: break it, observe the intended test fail, restore it, and observe the test pass.

## File Map

### Product runtime

- Modify `plugin/panel/src/cep/runtimeManager.js` — include the canonical checkout working directory in the selected development runtime.
- Modify `plugin/panel/src/cep/mcpClient.js` — pass the selected development working directory to the child spawn without changing packaged runtime spawn behavior.
- Modify `plugin/panel/test/runtimeManager.test.js` — prove live checkout selection, zero RuntimeManager mutation, and release refusal.
- Modify `plugin/panel/test/mcpClient.test.js` — prove command, arguments, working directory, and source label reach the spawned process.
- Modify `plugin/client/dist/app.js` — generated panel bundle; rebuild once after source changes.

### Development orchestration

- Create `scripts/dev/profile-contract.mjs` — parse commands and produce immutable, typed process plans; own the no-implicit-bootstrap invariant.
- Create `scripts/dev/macos-development.mjs` — read-only doctor, exact formal-AE executable resolution, process checks, direct AE launch, and bounded process-step execution.
- Create `scripts/dev/ae-mcp-dev.mjs` — CLI entrypoint, option validation, component selection, native temporary output allocation, structured execution receipts.
- Create `scripts/dev/test/profile-contract.test.mjs` — pure parser/plan tests and forbidden-command mutation guard.
- Create `scripts/dev/test/macos-development.test.mjs` — filesystem/process-injected doctor, launcher, and executor tests.
- Create `scripts/dev/test/ae-mcp-dev.test.mjs` — CLI exit/output contract tests.

### HDEV

- Create `scripts/hardware/development_smoke_spec.py` — frozen seven-public-call scenario and closed assertions.
- Create `scripts/hardware/development_smoke.py` — direct live-checkout MCP session, checkpoint handling, state/audit/Undo validation, private evidence, and fixture archival.
- Create `packages/bridge/tests/test_development_smoke_driver.py` — fake-session, evidence, uncertain-write, call-budget, and mutation tests.
- Modify `scripts/hardware/README.md` — HDEV command and explicit non-candidate semantics.

### Policy and developer documentation

- Modify `AGENTS.md` — introduce HDEV for ordinary AE-changing PRs and move full T5/T6 to packaged release-candidate scope.
- Modify `docs/CAPABILITY_PACKAGE_WORKFLOW.md` — replace per-PR T5/T6 closure with T0-T3 + HDEV, and define release milestone aggregation.
- Modify `docs/INSTALL.md` — separate one-time explicit bootstrap from daily doctor/sync/smoke commands.
- Modify `docs/RUNTIME_MANAGER.md` — document exact development spawn/cwd behavior and packaged refusal.

---

### Task 1: Bind the panel's live Core process to the canonical checkout

**Files:**
- Modify: `plugin/panel/src/cep/runtimeManager.js:143-230`
- Modify: `plugin/panel/src/cep/mcpClient.js:42-74,296-318`
- Modify: `plugin/panel/test/runtimeManager.test.js:190-320`
- Modify: `plugin/panel/test/mcpClient.test.js:120-175`
- Modify: `docs/RUNTIME_MANAGER.md:43-66`
- Modify generated: `plugin/client/dist/app.js`

**Interfaces:**
- Consumes: existing `selectDevelopmentRuntime()` result with `launcher`, `args`, and `checkoutPath`.
- Produces: development selection `{launcher, args, cwd, checkoutPath, developmentRuntime:true}` and command spec `{command, args, cwd, source:"development-runtime"}`.

- [ ] **Step 0: Bootstrap this isolated worktree once, only if dependencies are absent**

Check:

```bash
test -x .venv/bin/python3
test -d plugin/host/node_modules
test -d plugin/sidecar/node_modules
test -d plugin/panel/node_modules
```

Run only the missing setup commands:

```bash
uv sync --all-packages --group dev
(cd plugin/host && npm ci)
(cd plugin/sidecar && npm ci)
(cd plugin/panel && npm ci)
```

Record which commands ran. Do not repeat them in Tasks 2-7 unless a lockfile or toolchain requirement changes.

- [ ] **Step 1: Write the failing runtime-selection assertion**

Add to the existing development checkout test:

```js
assert.equal(selected.cwd, canonicalCheckout);
assert.equal(selected.checkoutPath, canonicalCheckout);
```

Run:

```bash
node --test plugin/panel/test/runtimeManager.test.js \
  --test-name-pattern='development checkout bypasses'
```

Expected: FAIL because `selected.cwd` is currently `undefined`.

- [ ] **Step 2: Return the canonical checkout as the child working directory**

In `selectDevelopmentRuntime()` return:

```js
return {
  ok: true,
  action: 'development-runtime',
  developmentRuntime: true,
  checkoutPath: checkout,
  launcher: interpreter,
  args: ['-B', '-I', '-m', 'ae_mcp'],
  cwd: checkout,
  interpreter: {
    path: interpreter,
    resolvedPath: resolvedInterpreter,
  },
  diagnostics: [{
    code: 'RUNTIME_DEVELOPMENT_RUNTIME_SELECTED',
    message: `Development runtime selected from ${checkout}; no packaged runtime was verified or installed.`,
  }],
};
```

Run the same focused test. Expected: PASS.

- [ ] **Step 3: Write the failing spawn propagation test**

Extend `plugin/panel/test/mcpClient.test.js` so the injected `resolveCommand` returns:

```js
{
  command: '/checkout/.venv/bin/python3',
  args: ['-B', '-I', '-m', 'ae_mcp'],
  cwd: '/checkout',
  source: 'development-runtime',
}
```

Capture the spawn options and assert:

```js
assert.equal(spawned.command, '/checkout/.venv/bin/python3');
assert.deepEqual(spawned.args, ['-B', '-I', '-m', 'ae_mcp']);
assert.equal(spawned.options.cwd, '/checkout');
assert.equal(spawned.options.shell, false);
```

Run:

```bash
node --test plugin/panel/test/mcpClient.test.js \
  --test-name-pattern='development checkout'
```

Expected: FAIL because `createMcpClient.start()` does not pass `cwd`.

- [ ] **Step 4: Propagate `cwd` only for the selected development runtime**

Return `cwd` from `resolveMcpCommand()`:

```js
return {
  command: selected.launcher,
  args: selected.args || [],
  cwd: selected.cwd,
  source: selected.developmentRuntime
    ? 'development-runtime'
    : (selected.action === 'fallback' ? 'runtime-fallback' : 'runtime-manager'),
  runtime: selected,
};
```

Add it conditionally to spawn options:

```js
const options = {
  stdio: 'pipe',
  windowsHide: true,
  env: spawnEnv,
  ...(commandSpec.cwd ? { cwd: commandSpec.cwd } : {}),
};
```

Add a packaged-runtime assertion that `cwd` remains absent. Run the focused `mcpClient` and `runtimeManager` tests. Expected: PASS.

- [ ] **Step 5: Rebuild the panel bundle once**

Run:

```bash
(cd plugin/panel && npm run build)
```

Expected: `plugin/client/dist/app.js` changes and no other generated file changes.

- [ ] **Step 6: Mutation-prove packaged release refusal**

Using `apply_patch`, temporarily replace:

```js
if (!developmentBuild()) {
```

with:

```js
if (false) {
```

Run:

```bash
node --test plugin/panel/test/runtimeManager.test.js \
  --test-name-pattern='packaged release build refuses'
```

Expected: FAIL because a packaged extension accepts the override. Restore the original condition with `apply_patch`, rerun, and expect PASS.

- [ ] **Step 7: Document and commit**

Update `docs/RUNTIME_MANAGER.md` to state that the development child uses the canonical checkout as `cwd`, while packaged launch behavior is unchanged.

Run:

```bash
git diff --check
node --test plugin/panel/test/runtimeManager.test.js \
  plugin/panel/test/mcpClient.test.js \
  plugin/panel/test/diagnostics.test.js
```

Expected: all tests PASS.

Commit:

```bash
git add plugin/panel/src/cep/runtimeManager.js \
  plugin/panel/src/cep/mcpClient.js \
  plugin/panel/test/runtimeManager.test.js \
  plugin/panel/test/mcpClient.test.js \
  plugin/client/dist/app.js \
  docs/RUNTIME_MANAGER.md
git commit -m "fix(panel): bind development core to checkout"
```

---

### Task 2: Define the pure development command contract

**Files:**
- Create: `scripts/dev/profile-contract.mjs`
- Create: `scripts/dev/test/profile-contract.test.mjs`

**Interfaces:**
- Produces `parseDevelopmentCommand(argv, defaults) -> DevelopmentCommand`.
- Produces `buildDevelopmentPlan(command, paths) -> DevelopmentPlan`.
- Produces `assertDailyPlanSafe(plan) -> plan` or throws code `DEV_IMPLICIT_BOOTSTRAP_FORBIDDEN`.
- Later tasks consume plan steps shaped as `{id, component, kind, executable, args, cwd}`.

- [ ] **Step 1: Write parser and plan-shape tests**

Create tests for the five actions:

```js
const defaults = {
  repoRoot: '/repo',
  home: '/Users/developer',
  formalAeApp: '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
};
const parsed = parseDevelopmentCommand(['sync', '--component', 'cep'], defaults);
assert.equal(parsed.action, 'sync');
assert.deepEqual(parsed.components, ['cep']);
assert.equal(parsed.repoRoot, '/repo');
assert.equal(parsed.home, '/Users/developer');
assert.equal(
  parsed.formalAeApp,
  '/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app',
);
assert.deepEqual(
  parseDevelopmentCommand(['bootstrap', '--component', 'all'], defaults).components,
  ['core', 'cep', 'native'],
);
assert.deepEqual(
  parseDevelopmentCommand([
    'smoke',
    '--component', 'core',
    '--component', 'cep',
    '--scenario', 'core-native-write-undo@1',
  ], defaults).components,
  ['core', 'cep'],
);
assert.throws(
  () => parseDevelopmentCommand(['sync', '--component', 'unknown'], defaults),
  (error) => error.code === 'DEV_ARGUMENT_INVALID',
);
```

Assert daily CEP sync contains panel build plus the existing dev installer, but no dependency step:

```js
const paths = {
  repoRoot: '/repo',
  uv: '/usr/local/bin/uv',
  npm: '/usr/local/bin/npm',
  node: '/usr/local/bin/node',
  python: '/repo/.venv/bin/python3',
  hostRoot: '/repo/plugin/host',
  sidecarRoot: '/repo/plugin/sidecar',
  panelRoot: '/repo/plugin/panel',
  cepInstaller: '/repo/scripts/install-plugin-dev-macos.sh',
  nativeBuilder: '/repo/native/ae-plugin/build-macos.mjs',
  nativeInstaller: '/repo/native/ae-plugin/install-dev-macos.mjs',
  sdkArchive: '/inputs/AfterEffectsSDK.zip',
  sdkRoot: '/inputs/AfterEffectsSDK',
  nativeOutput: '/private/tmp/ae-mcp-native-dev-test/artifact',
  developmentSmoke: '/repo/scripts/hardware/development_smoke.py',
};
const syncCep = parseDevelopmentCommand(['sync', '--component', 'cep'], defaults);
const plan = buildDevelopmentPlan(syncCep, paths);
assert.deepEqual(plan.steps.map((step) => step.id), [
  'cep-panel-build',
  'cep-development-install',
]);
assert.equal(plan.dependencyBootstrapInvocations, 0);
assert.equal(plan.releasePackagingInvocations, 0);
```

Run:

```bash
node --test scripts/dev/test/profile-contract.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement closed command and step types**

In `profile-contract.mjs`, define:

```js
export const COMPONENTS = Object.freeze(['core', 'cep', 'native']);
export const DAILY_ACTIONS = Object.freeze(['doctor', 'launch-ae', 'sync', 'smoke']);

export function developmentError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function processStep(id, component, kind, executable, args, cwd) {
  return Object.freeze({
    id, component, kind, executable,
    args: Object.freeze([...args]),
    cwd,
  });
}
```

Use exact step kinds:

```js
const DEPENDENCY_KIND = 'dependency-install';
const RELEASE_KIND = 'release-package';
const DAILY_ALLOWED_KINDS = new Set([
  'build', 'development-install', 'public-smoke', 'read-only-check',
]);
```

`parseDevelopmentCommand()` must reject duplicates, missing option values, relative paths, unknown actions, and unknown components with `DEV_ARGUMENT_INVALID`.
For `smoke`, accept repeated unique `--component` options and compute `reused` as the
ordered complement of `['core', 'cep', 'native']`.

- [ ] **Step 3: Implement exact component plans**

Use these exact process steps:

```js
// bootstrap core
processStep(
  'core-uv-sync', 'core', 'dependency-install',
  paths.uv, ['sync', '--all-packages', '--group', 'dev'], paths.repoRoot,
);

// bootstrap CEP
processStep('host-npm-ci', 'cep', 'dependency-install', paths.npm, ['ci'], paths.hostRoot);
processStep('sidecar-npm-ci', 'cep', 'dependency-install', paths.npm, ['ci'], paths.sidecarRoot);
processStep('panel-npm-ci', 'cep', 'dependency-install', paths.npm, ['ci'], paths.panelRoot);

// daily CEP sync
processStep('cep-panel-build', 'cep', 'build', paths.node, ['build.mjs'], paths.panelRoot);
processStep(
  'cep-development-install', 'cep', 'development-install',
  '/bin/bash', [paths.cepInstaller], paths.repoRoot,
);

// daily native sync
processStep(
  'native-build', 'native', 'build', paths.node,
  [
    paths.nativeBuilder,
    '--sdk-archive', paths.sdkArchive,
    '--sdk-root', paths.sdkRoot,
    '--output', paths.nativeOutput,
  ],
  paths.repoRoot,
);
processStep(
  'native-development-install', 'native', 'development-install', paths.node,
  [
    paths.nativeInstaller,
    'install', '--artifact-dir', paths.nativeOutput,
    '--profile', 'development',
  ],
  paths.repoRoot,
);
```

Core daily sync produces zero process steps and a structured action:

```js
{
  component: 'core',
  action: 'restart-mcp-session',
  reason: 'live checkout requires no copy or RuntimeManager generation',
}
```

- [ ] **Step 4: Enforce no implicit bootstrap**

Implement:

```js
export function assertDailyPlanSafe(plan) {
  if (!DAILY_ACTIONS.includes(plan.action)) return plan;
  const forbidden = plan.steps.find(
    (step) => step.kind === DEPENDENCY_KIND || step.kind === RELEASE_KIND,
  );
  if (forbidden) {
    throw developmentError(
      'DEV_IMPLICIT_BOOTSTRAP_FORBIDDEN',
      `${plan.action} may not execute ${forbidden.id}`,
    );
  }
  return plan;
}
```

Every non-bootstrap plan constructor must call it before returning.

Run the full contract test. Expected: PASS.

- [ ] **Step 5: Mutation-prove the daily safety guard**

Temporarily add this step to CEP sync using `apply_patch`:

```js
processStep('forbidden-npm-ci', 'cep', 'dependency-install', paths.npm, ['ci'], paths.panelRoot),
```

Run:

```bash
node --test scripts/dev/test/profile-contract.test.mjs \
  --test-name-pattern='daily plans reject dependency installation'
```

Expected: FAIL by throwing `DEV_IMPLICIT_BOOTSTRAP_FORBIDDEN`. Restore, rerun, expect PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/dev/profile-contract.mjs \
  scripts/dev/test/profile-contract.test.mjs
git commit -m "feat(dev): define component-selective command plans"
```

---

### Task 3: Implement the read-only doctor and exact formal-AE launcher

**Files:**
- Create: `scripts/dev/macos-development.mjs`
- Create: `scripts/dev/test/macos-development.test.mjs`

**Interfaces:**
- Consumes `DevelopmentPlan` from Task 2.
- Produces `inspectDevelopmentEnvironment(options) -> DoctorReport`.
- Produces `launchDevelopmentAe(report, dependencies) -> LaunchReceipt`.
- Produces `executeDevelopmentPlan(plan, dependencies) -> ExecutionReceipt`.
- Produces `createDefaultMacosDependencies() -> MacosDevelopmentDependencies`.
- Imports `developmentError` from `profile-contract.mjs`.

- [ ] **Step 1: Write the doctor fail/pass tests**

Build a temporary fixture with:

```text
repo/pyproject.toml
repo/packages/core/ae_mcp/__main__.py
repo/.venv/bin/python3
cep/com.aemcp.panel/.debug
formal.app/Contents/Info.plist
formal.app/Contents/MacOS/After Effects
```

Inject `fs`, `execFile`, and `processInspector`. Assert the success report has exactly:

```js
{
  schemaVersion: 1,
  profile: 'development',
  ok: true,
  checkoutPath: canonicalRepo,
  interpreterPath: canonicalPython,
  formalAeApp: canonicalApp,
  formalAeExecutable: canonicalExecutable,
  checks: checks,
  blockers: [],
}
```

Then assert:

```js
assert.deepEqual(report.checks.map((check) => check.id), [
  'checkout',
  'core-entrypoint',
  'core-interpreter',
  'core-import',
  'cep-development-marker',
  'cep-release-manifest-absent',
  'formal-ae-app',
  'formal-ae-executable',
]);
assert.equal(report.checks.every((check) => check.ok), true);
```

Remove `.venv/bin/python3` and assert:

```js
assert.equal(report.ok, false);
assert.deepEqual(report.blockers.map((item) => item.code), [
  'DEV_CORE_INTERPRETER_MISSING',
]);
assert.equal(writes.length, 0);
```

Run:

```bash
node --test scripts/dev/test/macos-development.test.mjs \
  --test-name-pattern='doctor'
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement bounded read-only inspection**

Export:

```js
export async function inspectDevelopmentEnvironment({
  repoRoot,
  home,
  formalAeApp,
  components = ['core'],
  environment = process.env,
  dependencies = createDefaultMacosDependencies(),
}) {
  const checkoutPath = await dependencies.realpath(repoRoot);
  const checks = await inspectRequiredPaths({
    checkoutPath, home, formalAeApp, components, environment, dependencies,
  });
  const blockers = checks.filter((check) => check.ok === false);
  return Object.freeze({
    schemaVersion: 1,
    profile: 'development',
    ok: blockers.length === 0,
    checkoutPath,
    interpreterPath: checks.find((check) => check.id === 'core-interpreter').path,
    formalAeApp: checks.find((check) => check.id === 'formal-ae-app').path,
    formalAeExecutable: checks.find((check) => check.id === 'formal-ae-executable').path,
    checks: Object.freeze(checks),
    blockers: Object.freeze(blockers),
  });
}
```

Rules:

- implement private
  `inspectRequiredPaths({checkoutPath, home, formalAeApp, components, environment, dependencies})`
  in the same file; it returns the closed `checks` array described below and performs no write;
- implement exported `createDefaultMacosDependencies()` in the same file with only Node `fs`,
  `path`, `child_process.execFile`, `child_process.spawn`, and the bounded AE process inspector;
- canonicalize `repoRoot`, `.venv/bin/python3`, CEP root, formal app, and formal executable;
- reject symlinked `pyproject.toml`, Core entrypoint, formal app, and formal executable;
- verify executable mode;
- parse `CFBundleExecutable`, `CFBundleShortVersionString`, and `CFBundleVersion` using
  `/usr/bin/plutil` with `shell:false`;
- verify CEP `.debug` is present and `bundle-manifest.json` absent;
- check, but do not create, `plugin/{host,sidecar,panel}/node_modules` only when
  `components` includes `cep`; a Core-only sync must not be blocked by missing CEP source dependencies;
- call the interpreter with `-B -I -c` and assert `ae_mcp.__file__` resolves beneath the canonical checkout;
- report missing SDK inputs only when native was selected;
- never call `mkdir`, `writeFile`, `rename`, `unlink`, or a package manager.

- [ ] **Step 3: Write the launch tests**

Assert a running AE returns `DEV_AE_ALREADY_RUNNING` and does not spawn. For a stopped AE, assert:

```js
assert.equal(spawned.file, report.formalAeExecutable);
assert.deepEqual(spawned.args, []);
assert.equal(spawned.options.cwd, path.dirname(report.formalAeExecutable));
assert.equal(spawned.options.detached, true);
assert.equal(spawned.options.stdio, 'ignore');
assert.equal(spawned.options.env.AE_MCP_DEV_RUNTIME, report.checkoutPath);
assert.equal(spawned.options.shell, false);
assert.equal(calls.some((call) => call.file === '/bin/launchctl'), false);
```

Run the launch-focused test. Expected: FAIL.

- [ ] **Step 4: Implement direct formal-AE launch**

Export:

```js
export async function launchDevelopmentAe(report, {
  processInspector,
  spawn,
  environment = process.env,
  now = () => new Date(),
}) {
  if (await processInspector.afterEffectsRunning()) {
    throw developmentError(
      'DEV_AE_ALREADY_RUNNING',
      'formal After Effects is already running',
    );
  }
  const child = spawn(report.formalAeExecutable, [], {
    cwd: path.dirname(report.formalAeExecutable),
    detached: true,
    stdio: 'ignore',
    shell: false,
    env: {...environment, AE_MCP_DEV_RUNTIME: report.checkoutPath},
  });
  child.unref();
  return Object.freeze({
    schemaVersion: 1,
    profile: 'development',
    pid: child.pid,
    formalAeExecutable: report.formalAeExecutable,
    checkoutPath: report.checkoutPath,
    launchedAt: now().toISOString(),
  });
}
```

Require `report.ok === true`, no running `Adobe After Effects|AfterFX`, then spawn the exact executable with only the child environment extended:

```js
const child = spawn(report.formalAeExecutable, [], {
  cwd: path.dirname(report.formalAeExecutable),
  detached: true,
  stdio: 'ignore',
  shell: false,
  env: {
    ...environment,
    AE_MCP_DEV_RUNTIME: report.checkoutPath,
  },
});
child.unref();
```

Return `{schemaVersion:1, profile:"development", pid, formalAeExecutable, checkoutPath, launchedAt}`.

- [ ] **Step 5: Implement step execution and structured receipts**

`executeDevelopmentPlan()` must use `execFile`, never a shell string, and record:

```js
{
  schemaVersion: 1,
  profile: 'development',
  action: plan.action,
  components: plan.components,
  steps: [{id, component, kind, exitCode: 0}],
  dependencyBootstrapInvocations,
  releasePackagingInvocations: 0,
}
```

For every daily action, assert `dependencyBootstrapInvocations === 0`. Redact home/repo paths from public error messages while retaining absolute paths in the local private receipt object.

- [ ] **Step 6: Run and commit**

```bash
node --test scripts/dev/test/macos-development.test.mjs
git diff --check
git add scripts/dev/macos-development.mjs \
  scripts/dev/test/macos-development.test.mjs
git commit -m "feat(dev): add read-only doctor and scoped AE launch"
```

Expected: all tests PASS.

---

### Task 4: Add explicit bootstrap, component sync, and the CLI

**Files:**
- Create: `scripts/dev/ae-mcp-dev.mjs`
- Create: `scripts/dev/test/ae-mcp-dev.test.mjs`
- Modify: `docs/INSTALL.md:171-190`

**Interfaces:**
- Consumes Task 2 parser/plans and Task 3 doctor/launcher/executor.
- Produces CLI JSON `{ok, result}` on stdout or `{ok:false,error:{code,message,recovery}}` on stderr.
- Produces no side effects before argument validation and doctor success.

- [ ] **Step 1: Write CLI contract tests**

Invoke an exported `main(argv, dependencies)` rather than spawning Node in unit tests:

```js
const result = await main([
  'doctor',
  '--repo-root', repoRoot,
  '--formal-ae-app', formalAeApp,
], harness.dependencies);
assert.equal(result.exitCode, 0);
assert.equal(result.output.result.profile, 'development');
```

Test these failures:

```js
['DEV_ARGUMENT_INVALID', 'DEV_DOCTOR_BLOCKED', 'DEV_AE_ALREADY_RUNNING']
```

Test `sync --component core` executes zero process steps and returns:

```js
{
  selected: ['core'],
  reused: ['cep', 'native'],
  restart: ['mcp-session'],
  dependencyBootstrapInvocations: 0,
  releasePackagingInvocations: 0,
}
```

Remove all three CEP `node_modules` directories from the test fixture and require the same
Core-only result. Add a separate `sync --component cep` test that fails doctor with
`DEV_CEP_DEPENDENCIES_MISSING`.

Run:

```bash
node --test scripts/dev/test/ae-mcp-dev.test.mjs
```

Expected: FAIL because the CLI does not exist.

- [ ] **Step 2: Implement CLI parsing and dependency injection**

Use:

```js
export async function main(
  argv = process.argv.slice(2),
  dependencies = createDefaultMacosDependencies(),
) {
  const command = parseDevelopmentCommand(argv, dependencies.defaults);
  const report = await inspectDevelopmentEnvironment({
    repoRoot: command.repoRoot,
    home: command.home,
    formalAeApp: command.formalAeApp,
    components: command.components,
    dependencies,
  });
  if (!report.ok && command.action !== 'bootstrap') {
    throw developmentError(
      'DEV_DOCTOR_BLOCKED',
      'development doctor reported blockers',
      {recovery: report.blockers},
    );
  }
  // dispatch exact action
}
```

The file-level CLI block must catch errors, print one JSON line, and set `process.exitCode`; it must not expose credentials or private paths in error text.

- [ ] **Step 3: Allocate native output safely**

For native bootstrap/sync:

```js
const buildRoot = await fs.promises.mkdtemp('/private/tmp/ae-mcp-native-dev-');
const nativeOutput = path.join(buildRoot, 'artifact');
```

Pass the absent `nativeOutput` to the existing builder. Keep the directory after successful install so the returned receipt can name `build-receipt.json`; on pre-build failure remove only the exact owned temporary directory. Never place output inside a worktree, Git common directory, Adobe scan root, or installer state root.

- [ ] **Step 4: Enforce explicit bootstrap**

`bootstrap` may execute dependency-install steps only after the literal action is present in `argv`. `doctor`, `launch-ae`, `sync`, and `smoke` must call `assertDailyPlanSafe()` before any process execution.

Add the test:

```js
for (const action of ['doctor', 'launch-ae', 'sync', 'smoke']) {
  const receipt = await harness.run(action);
  assert.equal(receipt.dependencyBootstrapInvocations, 0);
  assert.equal(receipt.releasePackagingInvocations, 0);
}
```

- [ ] **Step 5: Wire existing CEP/native installers without weakening them**

CEP sync must run exactly:

```text
node plugin/panel/build.mjs
/bin/bash scripts/install-plugin-dev-macos.sh
```

Native sync must run exactly:

```text
node native/ae-plugin/build-macos.mjs --sdk-archive "$AE_SDK_ARCHIVE" --sdk-root "$AE_SDK_ROOT" --output "$native_output"
node native/ae-plugin/install-dev-macos.mjs install --artifact-dir "$native_output" --profile development
```

Do not add a force flag, skip-AE-process flag, scan-root exception, or release-audit downgrade.

- [ ] **Step 6: Document one-time versus daily commands**

In `docs/INSTALL.md`, show:

```bash
node scripts/dev/ae-mcp-dev.mjs bootstrap --component all \
  --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

and daily examples:

```bash
node scripts/dev/ae-mcp-dev.mjs doctor --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
node scripts/dev/ae-mcp-dev.mjs sync --component core --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

State explicitly that daily commands fail with a bootstrap instruction rather than installing dependencies.

- [ ] **Step 7: Run and commit**

```bash
node --test scripts/dev/test/profile-contract.test.mjs \
  scripts/dev/test/macos-development.test.mjs \
  scripts/dev/test/ae-mcp-dev.test.mjs
node scripts/check-repository-governance.mjs
git diff --check
git add scripts/dev/ae-mcp-dev.mjs \
  scripts/dev/test/ae-mcp-dev.test.mjs \
  docs/INSTALL.md
git commit -m "feat(dev): orchestrate explicit bootstrap and component sync"
```

Expected: all tests and governance PASS.

---

### Task 5: Add the seven-call non-candidate HDEV driver

**Files:**
- Create: `scripts/hardware/development_smoke_spec.py`
- Create: `scripts/hardware/development_smoke.py`
- Create: `packages/bridge/tests/test_development_smoke_driver.py`
- Modify: `scripts/dev/profile-contract.mjs`
- Modify: `scripts/dev/test/profile-contract.test.mjs`

**Interfaces:**
- Produces scenario `core-native-write-undo@1`.
- Produces CLI mode `hdev` with call hard limit 7.
- Produces evidence summary schema:

```python
{
    "schemaVersion": 1,
    "validationProfile": "development",
    "candidateRun": False,
    "candidateEvidence": False,
    "passed": bool,
    "publicCalls": {
        "target": 7,
        "hardLimit": 7,
        "total": int,
        "byTool": dict[str, int],
        "byPhase": dict[str, int],
    },
    "componentDisposition": {
        "selected": list[str],
        "reused": list[str],
    },
    "aepLifecycle": {
        "created": int,
        "canonicalRetained": int,
        "evidenceSnapshotsRetained": int,
        "archived": int,
        "unclassified": int,
        "saveAsCopies": int,
    },
}
```

- [ ] **Step 1: Freeze the executable scenario**

In `development_smoke_spec.py`, define:

```python
SCENARIO_ID = "core-native-write-undo@1"
CALL_HARD_LIMIT = 7
CALLS = (
    ("readiness", "ae_projectSummary"),
    ("composition-create", "ae_createComposition"),
    ("baseline-settings", "ae_getCompositionSettings"),
    ("background-set", "ae_setCompositionBackgroundColor"),
    ("changed-settings", "ae_getCompositionSettings"),
    ("undo-reacquire", "ae_listProjectItems"),
    ("undo-settings", "ae_getCompositionSettings"),
)
BASELINE_COLOR = {"red": 16, "green": 32, "blue": 48, "alpha": 255}
CHANGED_COLOR = {"red": 64, "green": 96, "blue": 128, "alpha": 255}
```

Add an import-time invariant:

```python
assert len(CALLS) == CALL_HARD_LIMIT
assert len({key for key, _ in CALLS}) == CALL_HARD_LIMIT
```

- [ ] **Step 2: Write fake-session tests first**

Create tests that provide ordered fake responses and assert the exact request sequence:

```python
assert calls[1] == ("ae_createComposition", {
    "name": "HDEV Core Native Fixture",
    "width": 640,
    "height": 360,
    "duration": {"value": 5, "scale": 1},
    "frame_rate": {"numerator": 24, "denominator": 1},
    "pixel_aspect_ratio": {"numerator": 1, "denominator": 1},
    "idempotency_key": "hdev-core-native-composition-0001",
})
assert calls[3][0] == "ae_setCompositionBackgroundColor"
assert calls[3][1]["background_color"] == CHANGED_COLOR
```

Assert the driver:

- saves the empty project once before the first public write;
- validates baseline, changed, and restored complete settings snapshots;
- performs one explicit real Undo checkpoint;
- reacquires the composition locator after Undo;
- archives exactly one fixture;
- stops with exit 3 on `POSSIBLY_SIDE_EFFECTING_FAILURE`;
- stops before call 8;
- never retries a write.

Run:

```bash
PYTHONDONTWRITEBYTECODE=1 uv run --frozen pytest \
  packages/bridge/tests/test_development_smoke_driver.py -q
```

Expected: FAIL because the driver does not exist.

- [ ] **Step 3: Implement the live-checkout MCP session**

Launch Core with:

```python
StdioServerParameters(
    command=str(checkout / ".venv/bin/python3"),
    args=["-B", "-I", "-m", "ae_mcp"],
    cwd=str(checkout),
    env={
        "AE_MCP_BACKEND": "ae-mcp",
        "AE_MCP_PLUGIN_URL": plugin_url,
        "HOME": str(identity_home),
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "TMPDIR": os.environ.get("TMPDIR", "/private/tmp"),
    },
)
```

Before session creation, verify the interpreter and `ae_mcp.__file__` resolve beneath `checkout`; do not use the stable RuntimeManager launcher.

- [ ] **Step 4: Implement closed state and write evidence assertions**

For every native response require:

- one JSON text payload;
- `engine == "native-aegp"` in provenance;
- current formal host/session identifiers;
- capability/contract digest;
- audit ID and postcondition digest;
- write `changed is True`;
- `undo` object is present, with `available` and `verified` read separately.

For the background setter require:

```python
require(before["backgroundColor"] == BASELINE_COLOR, "write before colour drifted")
require(after["backgroundColor"] == CHANGED_COLOR, "write after colour drifted")
```

After the GUI Undo checkpoint, use `ae_listProjectItems(offset=0, limit=50)` to reacquire the named composition, then require restored background equals `BASELINE_COLOR`.

- [ ] **Step 5: Implement private evidence and fixture lifecycle**

Create evidence files with directory mode `0700` and file mode `0600`. Every event and summary must contain:

```python
"validationProfile": "development",
"candidateRun": False,
"candidateEvidence": False,
```

Parse `--selected-components` and `--reused-components` as closed, disjoint subsets of
`core`, `cep`, and `native`. Require their union to contain all three components and persist
them under `componentDisposition`.

The successful lifecycle must be:

```python
{
    "created": 1,
    "canonicalRetained": 0,
    "evidenceSnapshotsRetained": 0,
    "archived": 1,
    "unclassified": 0,
    "saveAsCopies": 0,
}
```

The initial checkpoint instructs AE to save the empty project at `fixturePath`. The final checkpoint instructs closing formal AE; only after process count is zero may the runner move the exact fixture to the recovery archive.

- [ ] **Step 6: Wire the `smoke` command**

Make the pure plan use:

```js
processStep(
  'hdev-core-native-write-undo',
  'core',
  'public-smoke',
  paths.python,
  [
    '-B', '-I',
    paths.developmentSmoke,
    '--scenario', 'core-native-write-undo@1',
    '--selected-components', command.components.join(','),
    '--reused-components',
      COMPONENTS.filter((component) => !command.components.includes(component)).join(','),
    '--checkout', paths.repoRoot,
    '--fixture-path', command.fixturePath,
    '--recovery-archive-root', command.recoveryRoot,
    '--evidence-dir', command.evidenceDir,
    '--formal-ae-app', command.formalAeApp,
  ],
  paths.repoRoot,
);
```

Do not run `uv run` in daily smoke; use the already-verified checkout interpreter directly.

- [ ] **Step 7: Mutation-prove evidence cannot become candidate evidence**

Temporarily change the summary construction to:

```python
"candidateEvidence": True,
```

Run:

```bash
PYTHONDONTWRITEBYTECODE=1 uv run --frozen pytest \
  packages/bridge/tests/test_development_smoke_driver.py \
  -q -k candidate_evidence
```

Expected: FAIL. Restore `False`, rerun, expect PASS.

- [ ] **Step 8: Run and commit**

```bash
PYTHONDONTWRITEBYTECODE=1 uv run --frozen pytest \
  packages/bridge/tests/test_development_smoke_driver.py -q
node --test scripts/dev/test/profile-contract.test.mjs
git diff --check
git add scripts/hardware/development_smoke_spec.py \
  scripts/hardware/development_smoke.py \
  packages/bridge/tests/test_development_smoke_driver.py \
  scripts/dev/profile-contract.mjs \
  scripts/dev/test/profile-contract.test.mjs
git commit -m "test(hardware): add non-candidate HDEV smoke"
```

Expected: all tests PASS.

---

### Task 6: Move ordinary PR hardware proof to HDEV and reserve T5/T6 for release

**Files:**
- Modify: `AGENTS.md:12-22,43-59,74-99,161-223`
- Modify: `docs/CAPABILITY_PACKAGE_WORKFLOW.md:1-224`
- Modify: `scripts/hardware/README.md:1-24`
- Modify: `docs/INSTALL.md:171-205`
- Modify: `docs/RUNTIME_MANAGER.md:43-70`

**Interfaces:**
- Consumes the exact `bootstrap`, `doctor`, `launch-ae`, `sync`, `smoke`, and HDEV evidence semantics implemented in Tasks 1-5.
- Produces one canonical lifecycle policy; capability briefs reference it rather than redefining T5/T6 timing.

- [ ] **Step 1: Rewrite the tier table without weakening real-AE proof**

In `AGENTS.md`, retain T0-T3 and define:

```text
HDEV — ordinary development real-AE smoke. Reuse the current compatible
development installation, exercise every new native primitive and one justified
representative per shared adapter/locator/Undo family, and emit
candidateEvidence=false.

T5 — packaged release-candidate acceptance. Run the complete changed-capability
matrix against the frozen artifact.

T6 — packaged release clean-install/upgrade/rollback revalidation. Prove the
release artifact and install boundary, not each ordinary PR.
```

Delete or rewrite every statement that still requires one T5 plus one clean-main T6 for each capability PR. Keep the rule that automated tests never substitute for real AE when product behavior changed.

- [ ] **Step 2: Define merge and Issue disposition**

State:

- ordinary capability PR may merge after T0-T3, review, and its required HDEV;
- its completion language is `development-verified`, never `release-accepted`;
- implementation Issues may close at merge;
- the target release milestone tracks all changed capabilities since the previous release;
- only packaged T5/T6 can mark that milestone `release-accepted`.

Keep the next-PR product-direction checkpoint after each merged standalone/capability PR.

- [ ] **Step 3: Document commands and stop conditions**

In `scripts/hardware/README.md`, add the exact HDEV command:

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python3 -B -I \
  scripts/hardware/development_smoke.py \
  --scenario core-native-write-undo@1 \
  --checkout "$PWD" \
  --fixture-path "$HOME/Library/Application Support/AfterEffectsMCP/fixtures/active/hdev-core-native.aep" \
  --recovery-archive-root "$HOME/Library/Application Support/AfterEffectsMCP/fixtures/recovery" \
  --evidence-dir "$HOME/Library/Application Support/AfterEffectsMCP/evidence/hdev-core-native" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

Retain stop conditions for protocol incompatibility, uncertain writes, corrupted fixture baseline, AE crash, and failed load.

- [ ] **Step 4: Run documentation and governance checks**

```bash
rg -n "one T5|one clean-main T6|exactly one T5|per capability PR" \
  AGENTS.md docs/CAPABILITY_PACKAGE_WORKFLOW.md
node scripts/check-repository-governance.mjs
git diff --check
```

Expected: `rg` returns no stale per-PR requirement; governance and diff checks PASS.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md \
  docs/CAPABILITY_PACKAGE_WORKFLOW.md \
  docs/INSTALL.md \
  docs/RUNTIME_MANAGER.md \
  scripts/hardware/README.md
git commit -m "docs: separate HDEV from packaged release acceptance"
```

---

### Task 7: Run the complete lower tiers, mutation proofs, and one real AE HDEV

**Files:**
- Verify all files from Tasks 1-6.
- Do not commit private HDEV evidence, absolute private paths, `.aep` files, native build outputs, or dependency directories.

**Interfaces:**
- Consumes the complete development profile.
- Produces a review-ready branch and one machine-readable HDEV evidence bundle with `candidateEvidence=false`.

- [ ] **Step 1: Run formatting, syntax, and focused tests**

```bash
git diff --check
node --check scripts/dev/profile-contract.mjs
node --check scripts/dev/macos-development.mjs
node --check scripts/dev/ae-mcp-dev.mjs
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python3 -m py_compile \
  scripts/hardware/development_smoke.py \
  scripts/hardware/development_smoke_spec.py
node --test scripts/dev/test/profile-contract.test.mjs \
  scripts/dev/test/macos-development.test.mjs \
  scripts/dev/test/ae-mcp-dev.test.mjs
PYTHONDONTWRITEBYTECODE=1 uv run --frozen pytest \
  packages/bridge/tests/test_development_smoke_driver.py -q
```

Expected: all commands PASS.

- [ ] **Step 2: Run affected panel, package, protocol, and governance suites**

```bash
node --test plugin/panel/test/runtimeManager.test.js \
  plugin/panel/test/mcpClient.test.js \
  plugin/panel/test/diagnostics.test.js
node --test scripts/package/test/dev-install-contract.test.mjs \
  scripts/package/test/native-aegp-dev-install.test.mjs
node native/ae-plugin/protocol/protocol.test.mjs
node scripts/check-repository-governance.mjs
```

Expected: all commands PASS. If the known #193 receipt-reuse panel test flakes once, record it and rerun only that exact test once; do not broaden scope or call it a product blocker unless it reproduces deterministically.

- [ ] **Step 3: Repeat all three mutation proofs as one review bundle**

Perform and restore these exact mutations one at a time:

1. packaged release accepts `AE_MCP_DEV_RUNTIME` → release-refusal test FAILS;
2. daily CEP sync contains `npm ci` → daily safety test FAILS;
3. HDEV summary sets `candidateEvidence=true` → evidence test FAILS.

After restoring all three, rerun their focused tests and require PASS. Finish with:

```bash
git diff --check
git status --short
```

Expected: no mutation residue.

- [ ] **Step 4: Verify doctor and changed-CEP sync without installing dependencies**

Run:

```bash
node scripts/dev/ae-mcp-dev.mjs doctor \
  --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"

node scripts/dev/ae-mcp-dev.mjs sync --component cep \
  --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

Require receipts with:

```json
{
  "profile": "development",
  "dependencyBootstrapInvocations": 0,
  "releasePackagingInvocations": 0
}
```

Also require no new RuntimeManager generation, `current`/`previous` pointer mutation, portable runtime, ZXP, or native install transaction.

The sync receipt must report CEP as selected, native as reused, and Core as a live checkout
rather than an installed/copied component. It must report `dependencyBootstrapInvocations=0`.

- [ ] **Step 5: Launch formal AE with the scoped checkout environment**

Ensure AE is closed, then run:

```bash
node scripts/dev/ae-mcp-dev.mjs launch-ae \
  --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"
```

Open the development CEP panel and verify Connection diagnostics visibly contains:

```text
DEVELOPMENT CHECKOUT
$PWD
$PWD/.venv/bin/python3
RUNTIME_DEVELOPMENT_RUNTIME_SELECTED
```

Do not use `launchctl setenv`, Finder, a file double-click, or an alternate AE application.

- [ ] **Step 6: Run the real seven-call HDEV**

Run `dev smoke` with one absent fixture path and private evidence directory:

```bash
node scripts/dev/ae-mcp-dev.mjs smoke \
  --scenario core-native-write-undo@1 \
  --component core \
  --component cep \
  --repo-root "$PWD" \
  --formal-ae-app "/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app" \
  --fixture-path "$HOME/Library/Application Support/AfterEffectsMCP/fixtures/active/hdev-core-native.aep" \
  --recovery-archive-root "$HOME/Library/Application Support/AfterEffectsMCP/fixtures/recovery" \
  --evidence-dir "$HOME/Library/Application Support/AfterEffectsMCP/evidence/hdev-core-native"
```

At checkpoints:

1. use formal AE to save the empty project once at the exact fixture path;
2. execute exactly one real AE Undo when requested;
3. after final readback, save in place, close the fixture, and quit formal AE;
4. acknowledge each checkpoint by copying its emitted ID exactly:

   ```python
   checkpoint_id = checkpoint_event["checkpointId"]
   acknowledgement = {
       "checkpointId": checkpoint_id,
       "status": "completed",
   }
   ```

Require:

- 7/7 public calls;
- readiness, composition creation, baseline read, background write, changed read,
  post-Undo reacquire, restored read all PASS;
- one real Undo executed and verified;
- current native provenance, audit, and postcondition agree;
- `candidateRun=false`;
- `candidateEvidence=false`;
- `validationProfile=development`;
- component disposition selected `["core", "cep"]` and reused `["native"]`;
- fixture lifecycle created 1, archived 1, active 0, unclassified 0;
- dependency bootstrap invocations 0;
- release packaging invocations 0.

- [ ] **Step 7: Review, commit any evidence-format-only correction, and push**

If HDEV exposed a qualifying cross-layer contract or driver defect with unchanged product behavior, batch it, add a lower-tier regression, rerun only affected lower tiers, and replay HDEV once. Stop for any tool behavior change, widened package, new AEGP mechanism, relaxed gate, or unreconciled write.

Then run:

```bash
git status --short
git log --oneline origin/codex/dev-runtime-path..HEAD
```

Commit only tracked source/test/doc corrections:

```bash
git add plugin/panel/src/cep/runtimeManager.js \
  plugin/panel/src/cep/mcpClient.js \
  plugin/panel/test/runtimeManager.test.js \
  plugin/panel/test/mcpClient.test.js \
  plugin/client/dist/app.js \
  scripts/dev/profile-contract.mjs \
  scripts/dev/macos-development.mjs \
  scripts/dev/ae-mcp-dev.mjs \
  scripts/dev/test/profile-contract.test.mjs \
  scripts/dev/test/macos-development.test.mjs \
  scripts/dev/test/ae-mcp-dev.test.mjs \
  scripts/hardware/development_smoke.py \
  scripts/hardware/development_smoke_spec.py \
  packages/bridge/tests/test_development_smoke_driver.py \
  AGENTS.md \
  docs/CAPABILITY_PACKAGE_WORKFLOW.md \
  docs/INSTALL.md \
  docs/RUNTIME_MANAGER.md \
  scripts/hardware/README.md
git commit -m "fix(dev): close HDEV integration gaps"
```

Skip that commit when there are no corrections. Never stage private evidence or `.aep` files.

Push:

```bash
git push origin codex/dev-runtime-path
```

Update #194 with:

- implementation commits;
- selected/reused component list;
- lower-tier totals;
- all mutation fail/pass evidence;
- HDEV seven-call summary and Undo result;
- proof that no dependency bootstrap, runtime generation, ZXP, or release packaging ran;
- explicit statement that T5/T6 were not run because this is development profile evidence.

Do not merge until concentrated review and required CI are green.
