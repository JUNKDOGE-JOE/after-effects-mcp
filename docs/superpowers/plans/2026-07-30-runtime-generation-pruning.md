# Runtime Generation Pruning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Issue #179 by bounding RuntimeManager-owned disk state to the active `current` generation and the verified `previous` rollback generation, including legacy schema-v1 state and pre-activation rejection cleanup.

**Architecture:** Extend the existing ownership-aware garbage collector rather than adding a new cleanup service. A single `reclaimOwnedState()` path will retain the exact `current`, `previous`, and operation-local in-progress references, remove only directories whose install records prove RuntimeManager ownership, and preserve unknown or malformed directories. Selection failures that occur before pointer activation will invoke the same collector with freshly known retained references.

**Tech Stack:** JavaScript ES modules, Node.js `node:test`, CEP RuntimeManager filesystem adapter.

## Global Constraints

- Retain the active `current` generation and at most one verified `previous` rollback generation.
- Reclaim only RuntimeManager-owned state proven by a valid schema-v1 install record or the existing valid schema-v2 generation/layer records.
- Preserve unknown, malformed, non-owned, staging, evidence, fixture, and unrelated directories.
- A launcher-incompatible selection rejected before activation must not leave a complete generation or runtime layer.
- Keep the existing lifecycle counters for reclaimed generations, layers, logical bytes, and physical bytes.
- No PID/start-token expansion, heartbeat, lease, stale-process forensics, power-loss continuation, cross-restart recovery, hostile-process hardening, generalized cleanup framework, or Windows RuntimeManager change.
- This is a non-AE isolated RuntimeManager fix. Focused Node tests are the acceptance path; do not manufacture T4/T5/T6 or real-AE evidence.

---

### Task 1: Reclaim unreferenced legacy generations and document the policy

**Files:**
- Modify: `plugin/panel/test/runtimeManager.test.js`
- Modify: `plugin/panel/src/cep/runtimeManager.js`
- Modify: `docs/RUNTIME_MANAGER.md`

**Interfaces:**
- Consumes: existing `validateLegacyInstallRecord()`, `validateGenerationRecord()`, `treeUsage()`, `emptyLifecycle()`, and pointer-relative values.
- Produces: `reclaimOwnedState({ currentRelative, previousRelative, inProgressRelative })`, replacing the narrower `reclaimOwnedV2()` call sites without changing their result shape.

- [ ] **Step 1: Write the failing legacy-retention regression test**

Extend the existing schema-v1 migration test into a two-transition scenario:

```js
const migrated = await managerFor(h, v1.extensionRoot).ensureReady();
assert.equal(
  (await fs.promises.readFile(h.platform.paths.previousPointer, 'utf8')).trim(),
  legacy.relative,
);

const upgraded = await managerFor(h, v2.extensionRoot).ensureReady();
assert.equal(upgraded.action, 'upgrade');
assert.equal(upgraded.lifecycle.generations.reclaimed, 1);
await assert.rejects(
  fs.promises.lstat(legacy.generationRoot),
  { code: 'ENOENT' },
);
```

The first transition must still retain the schema-v1 rollback target. The second transition must remove it only after both pointers reference schema-v2 generations.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern="schema-v1 generation" plugin/panel/test/runtimeManager.test.js
```

Expected: FAIL because the legacy generation directory still exists after it loses both pointer references.

- [ ] **Step 3: Implement ownership-aware legacy pruning**

Rename `reclaimOwnedV2()` to `reclaimOwnedState()` and retain every non-empty exact relative passed as `currentRelative`, `previousRelative`, or `inProgressRelative`.

After the existing schema-v2 generation pass, inspect only direct child directories of `runtimeRoot`. Skip hidden names and the managed `generations` and `layers` roots. For each remaining directory:

```js
const relative = `${entry.name}/${platform.id}`;
if (retained.has(relative)) continue;
const record = validateLegacyInstallRecord(
  await readJson(
    paths.join([root, entry.name, INSTALL_RECORD]),
    'RUNTIME_INSTALL_RECORD_INVALID',
  ),
  relative,
);
```

Only after that validation succeeds, measure the directory with `treeUsage()`, remove it, and increment `generations.reclaimed`, `logicalBytes.reclaimed`, and `physicalBytes.reclaimed`. Invalid, missing, malformed, or non-owned records remain untouched.

Replace all existing `reclaimOwnedV2()` calls with `reclaimOwnedState()`. Remove the now-duplicated schema-v1 deletion loop from `uninstall()`, because `reclaimOwnedState()` with no retained pointers owns that behavior.

- [ ] **Step 4: Run the focused test and full RuntimeManager suite**

Run:

```bash
node --test --test-name-pattern="schema-v1 generation" plugin/panel/test/runtimeManager.test.js
node --test plugin/panel/test/runtimeManager.test.js
```

Expected: the focused test passes and all RuntimeManager tests pass.

- [ ] **Step 5: Document the exact retention and ownership boundary**

Update `docs/RUNTIME_MANAGER.md` in English and Chinese:

- show the current schema-v2 `generations/` and shared `layers/` layout while noting readable schema-v1 migration;
- state that `current` and `previous` are the only retained generation references;
- state that successful transitions prune other valid RuntimeManager-owned generations and their unreferenced layers;
- state that unknown/malformed/unowned directories are preserved;
- retain the existing explicit non-goals.

- [ ] **Step 6: Verify formatting and commit**

Run:

```bash
git diff --check
node --test plugin/panel/test/runtimeManager.test.js
git add plugin/panel/src/cep/runtimeManager.js plugin/panel/test/runtimeManager.test.js docs/RUNTIME_MANAGER.md
git commit -m "fix(runtime): prune unreferenced legacy generations"
```

Expected: `git diff --check` exits 0, the RuntimeManager suite passes, and one focused commit is created.

---

### Task 2: Remove completed state after pre-activation rejection

**Files:**
- Modify: `plugin/panel/test/runtimeManager.test.js`
- Modify: `plugin/panel/src/cep/runtimeManager.js`

**Interfaces:**
- Consumes: Task 1 `reclaimOwnedState()` and the existing `assertLauncherTransitionCompatible()`, `installLauncher()`, `activate()`, `installPackaged()`, and pointer-state objects.
- Produces: `prepareSelectedForActivation(selected, current, previous)`, which either completes compatibility/launcher preparation or reclaims the unreferenced selection before rethrowing the original error.

- [ ] **Step 1: Write failing upgrade and repair rejection tests**

Add a test-only helper that counts valid managed directories:

```js
async function managedDirectoryCounts(runtimeRoot) {
  const generations = await fs.promises.readdir(path.join(runtimeRoot, 'generations'));
  const layersRoot = path.join(runtimeRoot, 'layers');
  const layerDigests = await fs.promises.readdir(layersRoot);
  let layers = 0;
  for (const digest of layerDigests) {
    layers += (await fs.promises.readdir(path.join(layersRoot, digest))).length;
  }
  return { generations: generations.length, layers };
}
```

For an installed v1 payload and a v2 payload with a different fixture launcher contract:

```js
const before = await managedDirectoryCounts(h.platform.paths.runtimeRoot);
await assert.rejects(
  incompatible.ensureReady(),
  { code: 'RUNTIME_LAUNCHER_MIGRATION_REQUIRED' },
);
assert.deepEqual(
  await managedDirectoryCounts(h.platform.paths.runtimeRoot),
  before,
);
```

Add the same observable assertion for `incompatible.repair()`. Keep the existing pointer and launcher byte-for-byte assertions.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern="launcher contract" plugin/panel/test/runtimeManager.test.js
```

Expected: FAIL because the rejected selection leaves at least one additional completed managed generation, and `repair()` also leaves a new runtime layer.

- [ ] **Step 3: Implement the narrow pre-activation cleanup boundary**

Add:

```js
async function prepareSelectedForActivation(selected, current, previous) {
  try {
    assertLauncherTransitionCompatible(selected, current);
    await installLauncher(selected);
  } catch (error) {
    await reclaimOwnedState({
      currentRelative: current?.relative || null,
      previousRelative: previous?.relative || null,
      inProgressRelative: null,
    });
    throw error;
  }
}
```

Use it only where a newly completed selection has been created but `activate()` has not started:

- the new-selection branch of `ensureReady()`;
- `repair()`, after reading both `current` and `previous`.

Do not wrap `activate()` itself. Pointer-write uncertainty is outside this reproduced pre-activation defect and must not be expanded here.

- [ ] **Step 4: Run the focused tests and full RuntimeManager suite**

Run:

```bash
node --test --test-name-pattern="launcher contract" plugin/panel/test/runtimeManager.test.js
node --test plugin/panel/test/runtimeManager.test.js
```

Expected: both rejection paths restore the managed generation/layer counts, pointer and launcher assertions remain unchanged, and the full RuntimeManager suite passes.

- [ ] **Step 5: Verify formatting and commit**

Run:

```bash
git diff --check
node --test plugin/panel/test/runtimeManager.test.js
git add plugin/panel/src/cep/runtimeManager.js plugin/panel/test/runtimeManager.test.js
git commit -m "fix(runtime): reclaim rejected selections"
```

Expected: `git diff --check` exits 0, the RuntimeManager suite passes, and one focused commit is created.

---

## Final Verification

Run:

```bash
node --test plugin/panel/test/runtimeManager.test.js
node --test plugin/panel/test/runtimeActivationWiring.test.js
node --test scripts/package/test/runtime-manager-stage.test.mjs
git diff --check origin/main...HEAD
```

Expected: all focused RuntimeManager/activation/staging tests pass with no formatting errors. Real AE, packaged candidate generation, T5, and T6 are explicitly not required because the public AE execution path and installed-runtime behavior are not changed.
