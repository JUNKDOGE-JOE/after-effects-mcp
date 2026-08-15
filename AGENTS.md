# Repository Development and Delivery Rules

These rules apply to human developers and coding agents working in this repository. They exist to keep engineering effort aligned with observable After Effects functionality. When an issue plan, reviewer suggestion, or local preference conflicts with these rules, stop and resolve the conflict in favor of the user-visible acceptance outcome unless the user explicitly changes the priority.

## 0.0 Read the current architecture direction first

**Read [`docs/ARCHITECTURE_DIRECTION.md`](docs/ARCHITECTURE_DIRECTION.md) before planning any work.** It was approved 2026-08-15 and it changes what work is worth doing. The delivery discipline in the rest of this file — evidence, acceptance tiers, stop conditions, `.aep` lifecycle — remains fully in force. Only the *direction* moved.

Three standing decisions constrain new work until the direction document says otherwise:

- **The native AEGP plane is frozen.** Keep the `.aex` and its 23 primitives; add none. Do not open a new native capability package, do not extend `native-primitives.json`, and do not run the capability-package codegen pipeline. The two properties that justify the plane — exact rational time and generation-bound locators — are already built.
- **The Python server plane is being retired this quarter.** Do not add handlers, backends, schemas, or entry points under `packages/`. Fixes to keep it working are fine; new surface there is not. The MCP server is moving into the CEP Node context (`plugin/host/`).
- **The provider layer is collapsing to three channels** — claude CLI, codex CLI, opencode. Do not add a fourth backend adapter or extend `universalProviderRoute` / `providerCapabilityProbe` / `codexResponsesRoute`; those are scheduled for deletion.

Two things are known-broken and already assigned; do not re-diagnose them from scratch:

- `plugin/host/jsx-bridge.js` releases the serialization queue on timeout without cancelling the ExtendScript, opening the overlap window the queue exists to prevent. `plugin/host/jsx-bridge.test.js:59-83` currently enshrines that behavior as intended.
- The first-run wizard detects Node but never installs it, so the built-in Claude chat cannot start on a clean Windows machine. The Python server itself installs fine there via `uv`.

## 0. User authorization is the scope boundary

- The current user's explicit requested outcome and named deliverables are the authorization boundary. An Issue, Epic, milestone, checklist, review comment, repository rule, prior plan, branch, worktree, or sunk implementation is context or evidence only; none authorizes additional product work or delivery mechanisms.
- A release request authorizes only the named release assets and the smallest indispensable build, signing, verification, documentation, and publication steps. It does not implicitly authorize an installer, RuntimeManager, zero-environment onboarding, new CI or runner topology, private artifact service, distribution or update channel, repair/rollback/uninstall system, new trust or secret infrastructure, an additional OS, architecture, or After Effects version, or another user workflow.
- Before introducing any such item—or any other deliverable or workflow not named by the user—stop, describe its concrete user benefit, expected footprint and cost, and explicit non-goals, and obtain new explicit approval. Do not create an Issue, branch, worktree, scaffold, secret, workflow, or implementation for it while awaiting approval.
- Treat a prerequisite as indispensable only when the named outcome cannot be produced or truthfully verified without it. If an existing or bounded manual path can produce the approved assets, replacement infrastructure is follow-up work, not a prerequisite.
- Unless the user explicitly approved a package brief that anticipates the footprint, stop and reconfirm scope before touching more than 15 files or adding more than 500 non-generated, hand-written lines; stop sooner whenever the delivery model or user workflow changes. Report implementation, tests, workflow/infrastructure, configuration/schema/fixtures, documentation, generated files, and mechanical version changes separately, together with their committed, staged, tracked, or untracked state. Crossing a threshold is a scope alarm, not permission to continue.
- If the user narrows or changes direction, first bring any in-flight or possibly side-effecting operation to a safe, reconciled checkpoint, then immediately stop the superseded path, cancel further implementation, review, and CI for it, preserve unfinished work only as clearly labeled recoverable state, and provide a keep/drop inventory. Continue only the newly approved scope; sunk cost never justifies finishing the old path.
- Quality, security, testing, and acceptance rules constrain how approved work is delivered; they do not expand what is approved. Resolve any conflict by satisfying the approved outcome with the smallest compliant change or by asking the user.

## 1. Measure outcomes, not activity

- The primary P0 measure is a working capability through the public MCP surface. Lines changed, tests added, commits, PRs, protocol completeness, and CI status are supporting evidence, not delivery.
- Prefer the smallest real vertical slice to prove a new primitive over a sequence of horizontal infrastructure layers. Once the primitive is proven, batch related tools into the capability package in section 2 instead of creating one-tool delivery units.
- A build, mock, isolated RPC test, internal function call, or ping-only result does not prove an AE capability works.
- Do not describe a capability as complete until its observable AE result has been verified on the target machine.

## 2. Prioritize by dependency and user value

- Do not implement issues by issue number or creation order. Maintain P0/P1/P2/P3 priorities based on dependency and user value.
- Work on one dependent P0 capability package at a time. A capability package normally groups about 5-15 tightly related tools that share an AEGP SDK suite, dispatcher, fixture, Undo model, or user scenario. Small infrastructure changes and isolated fixes may remain single-Issue packages when they do not belong to a tool family.
- Prefer 6-10 tools for a normal capability package. Before implementation, freeze a short package brief containing any optional child Issues, public MCP schemas, capability/interaction matrix, native novelty, disposable fixture, Undo model, executable acceptance path, and explicit non-goals. Do not split the frozen package into one branch or PR per simple tool.
- A capability package may retain multiple child Issues and acceptance checklists, but it uses one branch/worktree, one PR, one concentrated review, and one bounded HDEV real-AE run. HDEV is development evidence only. Close each child Issue only when its own development acceptance result passed; the target release milestone separately aggregates changed capabilities for packaged acceptance.
- The ordinary package closure loop is: design the public MCP schemas and interaction matrix -> implement with incremental unit/contract/compile tests -> independent diff review -> T3/CI -> bounded HDEV real-AE validation -> merge -> publish `development-verified` evidence -> close accepted implementation Issues and update the target release milestone. At release freeze, build one packaged candidate, run the aggregate changed-capability T5 matrix, then run packaged clean-install/upgrade/rollback T6.
- Parallel work is allowed only when it is genuinely independent and cannot cause mixed builds, shared-fixture conflicts, or premature assumptions about an unmerged interface.
- The WIP limit is one dependent native capability package. That package may use at most three coordinated implementation tracks (native, Core/bridge/public MCP, and tests/fixture), but they share one schema freeze, one branch/worktree, and one acceptance matrix. Do not begin the next dependent package before the current package is merged with required HDEV evidence and reaches the product-direction checkpoint.
- Treat schedule targets as scope alarms, not permission to weaken evidence: package framing should normally take 2-4 hours, implementation 1-2.5 working days, concentrated review and CI 0.5-1 day, and the prepared hardware session 60-90 minutes excluding deterministic build time. When a target is exceeded, cut unrelated scope or repair the environment instead of accumulating more infrastructure inside the package.
- Workflow infrastructure must remove a measured repeated cost from the active acceptance path and is timeboxed to one working day unless the user explicitly promotes it. Otherwise record it as a follow-up and continue the capability package.

## 3. Define the public vertical-slice acceptance test first

> **Scope note (2026-08-15).** The AEGP chain below now describes acceptance for the **frozen** native plane only — use it when touching existing native primitives. New capability work runs on the ExtendScript plane, where the equivalent chain is: public MCP tool -> `plugin/host/mcp` handler -> `/exec` -> `jsx-bridge` -> ExtendScript -> After Effects state -> typed result -> audit evidence. The evidence requirements are identical; only the middle layers differ. See [`docs/ARCHITECTURE_DIRECTION.md`](docs/ARCHITECTURE_DIRECTION.md).

For AE-native work, write the executable acceptance path before expanding the implementation:

```text
public MCP tool
  -> Core handler/backend
  -> native RPC
  -> AEGP main-thread dispatcher
  -> After Effects state
  -> typed result
  -> audit evidence
```

- A read capability must return real AE state and include enough provenance and postcondition evidence to distinguish it from cached, replayed, mocked, or JSX-derived data.
- A write capability must use a disposable fixture, record before/after AE state, return structured provenance, produce an audit record, and demonstrate a real Undo followed by state verification.
- Use the public MCP tool name and request shape that a model will see. Internal calls may diagnose a failure but cannot replace end-to-end acceptance.
- AEGP expands the capability ceiling; it is not a mechanical routing rule. Do not design a complex AEGP/JSX resolver until the real AEGP execution plane and useful native capability set are working.

## 4. Layer hardware validation by native novelty and capability package

- **Local development trust model:** on the maintainer's single-user development Mac, files just built, copied, or atomically installed by the active agent-owned workflow are trusted by default. Routine development, AE restart, T4, and HDEV must not rehash the complete runtime tree or require Core, CEP, native, protocol, runner, and evidence to share one full repository SHA. Use the install receipt, canonical path, component version, file size, and modification time as inexpensive change signals; escalate to content hashing only after an observed inconsistency. Packaged release-candidate T5/T6 use the strict release-audit identity boundary, including exact source/artifact identity, complete payload verification, RuntimeManager manifest alignment, and the existing release gates. Hash verification for external downloads such as the Adobe SDK archive remains allowed.
- **Product trust boundary:** ae-mcp supports one trusted interactive OS user operating After Effects and selected MCP/model clients on the same host. The only runtime confidentiality commitment is preventing Provider/API secrets from leaking into source, configuration exports, logs, diagnostics, evidence, unrelated processes, or unselected routes. Do not create gates or hardening work for second-user isolation, hostile same-UID processes, endpoint attacks, remote/multi-user authentication, pairing, or power-loss/cross-restart continuation. Existing loopback, token, same-UID, endpoint, and AE-ancestry checks may remain as non-guaranteed implementation details until they measurably obstruct the product. Preserve correctness and data-integrity controls—typed validation, bounded paths, audit, Undo, uncertain-write reconciliation, atomic ordinary updates—and preserve release signing, notarization, artifact identity, and protocol compatibility. See `docs/THREAT_MODEL.md`.
- When a package introduces a new AEGP SDK suite, object-lifecycle rule, main-thread mechanism, or other unverified native primitive, run one narrow intermediate hardware smoke as soon as that primitive is testable. Once the mechanism is proven, do not redeploy for each simple tool built on it.
- Complete the package with one prepared HDEV run through the public MCP surface that exercises every new native primitive and one justified representative per shared adapter, locator, and Undo family in the same disposable AE fixture. Batch the structured response, AE state, native provenance, audit, recovery, and representative write-tool Undo evidence.
- Any package whose acceptance depends on AE loading, lifecycle, GUI state, main-thread behavior, CEP/native communication, or project mutation still requires this package-level real-machine validation before merge.
- Automated tests and CI never substitute for hardware validation.
- Record each development component's source revision and installed receipt for traceability, but do not make full-repository SHA equality an HDEV gate. Abort on an observed incompatible protocol/component version, wrong canonical path, failed load, or contradictory AE result. The later packaged release boundary retains exact identity checks.
- After merge, add the package's changed-capability matrix and HDEV disposition to the target release milestone. Do not relabel or reuse HDEV as packaged T5/T6 evidence.
- Use a dedicated disposable AE project. Never use the user's production project for write testing.
- Prepare GUI access, permissions, no-sleep state, fixture path, canonical plugin path, and log locations in one preflight instead of discovering them through repeated user interruptions.
- Before T4, HDEV, or packaged T5, complete a zero-evidence hardware preflight that proves the selected Core/CEP/native component set and protocol metadata can communicate; the formal AE absolute path, GUI, fixture runner, and log directories are usable; and the runner can create or reset, save, reopen from inside AE, and archive its single disposable fixture. Development preflight uses lightweight receipts/metadata and does not perform a full runtime hash walk or a pairing ceremony. It creates no candidate acceptance evidence.
- A failure before the first public MCP tool call is a T0-T2 environment or runner failure, not a failed HDEV or packaged candidate acceptance. Repair and falsify it at the lowest applicable tier before returning to hardware.
- After concentrated review has no unresolved blocker and all source, generated bundles, documentation, fixtures, and evidence schemas are committed, run T3 and required CI once before HDEV. A packaged candidate freeze is a later release-milestone boundary covering all changed capabilities since the previous release.
- After candidate freeze, create a replacement only for a reproduced acceptance blocker or a defect that demonstrably invalidates the package evidence. Batch all known blockers into one fix set, rerun only the affected lower test tiers, perform a focused re-review, and then create one replacement candidate. The replacement must pass required CI before any T5 acceptance evidence is collected.
- The ordinary PR target is one T3/CI run and one successful HDEV session. A packaged release normally uses one candidate T5 session and one T6 clean-install/upgrade/rollback session. Exceeding either budget must be explained in the applicable completion evidence; it is not a reason to weaken a gate.

## 5. Keep review feedback from expanding P0

Classify every newly discovered risk or reviewer comment before implementing it:

1. **Current P0 blocker:** reproduced on the acceptance path, or demonstrably prevents correctness, recovery, auditability, or safe use of the current capability.
2. **Follow-up:** credible hardening or product work that does not block the current vertical slice. Record it as a separate P1/P2 issue and keep it out of the active PR.
3. **Not in scope:** hypothetical, unsupported, duplicated, or contrary to the current product decision. Document the disposition without implementing it.

- Do not silently promote concurrency hardening, power-loss behavior, installer edge cases, signing, notarization, cross-platform expansion, or generalized framework work into P0.
- Timebox investigations of non-reproduced edge cases. Once the current acceptance path is safe and reliable, defer the rest.
- A reviewer finding is evidence to evaluate, not an automatic change request or priority override.
- Use no more than two concentrated review rounds by default. A further round is justified only when the previous round found a reproduced blocker or the fix changed the public acceptance boundary. Limit investigation of a non-reproduced edge case to 60-90 minutes before classifying it as follow-up or out of scope.

### 5.1 Escalate tests by risk and lifecycle

Use the lowest test tier that can falsify the current change, then escalate at package milestones:

- **T0, every edit:** formatting, syntax, lint, or a single focused unit test; target seconds.
- **T1, each tool or adapter:** schema, codec, suite adapter, structured-error, and postcondition contract tests; target 1-5 minutes.
- **T2, package integration:** affected native compile tests, Core/CEP integration, shared fixture, interaction corpus, and generated-file checks; target 10-30 minutes.
- **T3, reviewed source or release freeze:** the relevant full repository regression plus required CI; run once for the ordinary reviewed source and once for each packaged release candidate or approved replacement.
- **T4, optional native-novelty smoke:** one narrow real-AE check only when the package introduces an unverified suite, object lifecycle, or main-thread mechanism.
- **HDEV, ordinary development real-AE smoke:** reuse the current compatible development installation, exercise every new native primitive and one justified representative per shared adapter/locator/Undo family, and always emit `validationProfile=development`, `candidateRun=false`, and `candidateEvidence=false`.
- **T5, packaged release-candidate acceptance:** run the complete changed-capability matrix accumulated since the previous release against the frozen release-audit artifact.
- **T6, packaged release revalidation:** prove clean install, upgrade, rollback, and the release artifact boundary. It is not a per-PR clean-`main` replay.

Do not rerun T3, HDEV, T5, or T6 after every small fix. A failed higher tier should drive the smallest reproducing lower-tier test first; return to the higher tier only after the fix set is complete.

For an agent-owned development installation on the single-user machine, reuse is the default. Check only the canonical path, install receipt, component version, size, and modification time on routine starts. Do not perform a full payload hash walk at T4, HDEV, or AE restart. Escalate to selective/content verification when those inexpensive signals change, AE reports an incompatible component/protocol, or an actual result is contradictory. Packaged T5/T6 deliberately cross the strict release-audit boundary.

### 5.2 Batch independent acceptance defects before repair

During a diagnostic T4, or after an HDEV/T5/T6 run has already failed, do not stop and modify source after the first ordinary assertion failure. Continue every independent case whose evidence remains trustworthy and whose fixture state is either unchanged or restored, then repair the collected blockers as one fix set.

- The runner must record each case as `PASS`, `FAIL`, `BLOCKED`, or `INDETERMINATE`, together with the failing layer, side-effect status, state-reconciliation result, dependency impact, and evidence identifiers.
- Continue after a failure only when it is read-only or definitively `not-started`, or when any completed write has been reconciled against AE state and audit evidence and the fixture baseline has been verified as restored.
- Stop the sweep immediately when a possible write remains unreconciled, the fixture baseline cannot be restored, AE crashes or corrupts the project, an incompatible component/protocol is observed, or subsequent evidence would otherwise be untrustworthy.
- Mark dependent cases `BLOCKED` and continue unrelated cases; continuing diagnostic collection never converts the failed candidate into accepted evidence.
- Do not edit source between individual diagnostic cases. After the bounded sweep, group all reproduced current blockers by layer, fix them together, rerun only the affected lower tiers, perform one focused review, and replay the hardware gate once on the permitted replacement candidate.
- Generate a machine-readable defect ledger from the sweep so the repair batch, replacement review, and completion report consume the same observed failures instead of manually reconstructing them.

## 6. Treat writes and uncertain failures explicitly

- A transport timeout or disconnect after dispatch does not prove that a write did not occur.
- Every native write should have a stable operation/request ID, bounded retry behavior, a queryable outcome when feasible, and a postcondition that can be checked independently.
- On an indeterminate result such as `POSSIBLY_SIDE_EFFECTING_FAILURE`, inspect AE state and the audit trail before retrying. Never blindly repeat a possibly completed write.
- Report Undo availability and Undo verification as separate facts. `available=true` must not imply that Undo has been executed and its postcondition verified.
- Success requires agreement between the typed response, AE state, provenance, audit record, and verification result.

## 7. Preserve build and workspace identity

- Use one worktree and one branch for each capability package. Record any optional child Issues and the acceptance matrix owned by that worktree, and know which package owns every build, install, test artifact, and running process.
- Before starting an expensive build, fail fast on every locked external input and prerequisite, including the Adobe SDK archive/root, Node headers, license approvals, output ownership, and local non-evictable input state. Do not discover a missing build prerequisite after a long runtime or native build has started.
- Before building or deploying, record the source revision, dirty state, installed paths, component versions, sizes, and modification times. Content hashes are optional diagnostics, not routine acceptance gates.
- Do not intentionally deploy incompatible Core, CEP, native plug-in, or protocol versions. A source-revision mismatch by itself is not proof of incompatibility and must not block development.
- Keep backup, staging, rollback, and evidence directories outside Adobe's plugin scan roots.
- Keep disposable projects, generated scripts, logs, and smoke outputs out of tracked source paths unless they are intentional fixtures.
- Do not use a stale or dirty root checkout as an implicit source for another issue's build.
- Keep the active build and evidence worktree on fully local, non-evictable storage. Cloud/on-demand placeholders, including macOS `dataless` files, are not valid candidate inputs; hydrate the complete scoped inputs or create a local checkout before freezing the candidate.

### 7.1 Classify `.aep` lifecycle by purpose

Classify every agent-created After Effects project before creating it. Lifecycle follows the project's purpose, not its Issue, PR, branch, candidate SHA, or evidence directory. The default is `ephemeral-validation`.

- **`ephemeral-validation`:** single candidate, read/write, Undo, recovery, or acceptance work. After structured evidence is extracted, move it to a short-lived recoverable archive outside Adobe scan roots.
- **`reusable-fixture`:** deterministic input shared by multiple capability packages. Keep exactly one canonical copy plus its rebuild recipe; do not duplicate it per Issue or candidate.
- **`persistent-workspace`:** a project the user explicitly chose for continued editing, or a project in a user-selected workspace. Never move, archive, overwrite, or delete it automatically.
- **`evidence-snapshot`:** allowed only when an unresolved defect cannot be reproduced from structured logs and a deterministic recipe. Keep one minimal, redacted snapshot with its source revision/build receipt.

Before creating, retaining, moving, or archiving an `.aep`, determine and record:

1. whether the user created it or selected its directory;
2. whether public MCP or a checked-in recipe can rebuild it deterministically;
3. whether an unresolved defect genuinely requires the complete project;
4. whether an open acceptance checklist explicitly references it; and
5. whether the user explicitly requested persistent retention.

- If long-term value cannot be demonstrated, do not retain the project permanently under an Issue or candidate directory; use a dated recovery archive with a cleanup condition.
- One HDEV/T5/T6 hardware session may have only one active fixture. Retry by resetting or deterministically rebuilding that fixture; do not accumulate projects through repeated Save As operations.
- If an agent-created `ephemeral-validation` fixture fails before the first public tool call, has no AE mutation, and has no unresolved diagnostic value, the runner must move it to recovery and clear the active slot before exit. Once any public call or possible write dispatch occurred, reconcile AE state and audit evidence before resetting, archiving, or retrying.
- Issue and evidence directories should normally store the fixture ID, lifecycle, owner, rebuild recipe, source revision/build receipt, public MCP request/response, before/after state, audit, Undo, and result—not a complete `.aep`.
- When a candidate is superseded, archive its ephemeral project by default. An old build identifier is traceability metadata, not a reason for permanent retention.
- Permanent retention requires a recorded reason, owner, references, source revision/build receipt, and cleanup condition. A canonical reusable fixture also requires a uniqueness check before another copy is created.
- Use centralized `canonical`, `active`, `recovery`, and `evidence` roots outside Adobe scan directories. Do not create a new file-management framework merely to enforce this lifecycle.
- Completion evidence must report `.aep` counts: created, canonical retained, evidence snapshots retained, archived, unclassified, and logical/physical space moved or released.

## 8. Minimize human interruption during hardware work

- Consolidate all known permissions and GUI prerequisites into one preflight.
- Run package hardware acceptance as one continuous prepared session. Keep fixture creation, all tool calls, write verification, Undo/Redo, restart/reconnect, and evidence collection in the same orchestrated window.
- Do not require or perform a connection-code/fingerprint pairing ceremony on the supported local single-user path, and do not create follow-up work to add one.
- Open or reopen acceptance fixtures from the formal AE process using AE's own File/Open or Open Recent flow. Do not use Finder, file double-click, or LaunchServices because they may route the project to Beta or another host.
- Once the user has authorized routine AE/macOS GUI control, perform normal focus, open/save/close, restart, disposable-project, and test Undo/Redo operations without repeatedly asking them to click.
- Pause only for a genuinely required system confirmation, credential/license decision, destructive action outside the disposable fixture, or a product choice that changes the result.
- When blocked, report the single concrete blocker and the evidence already gathered; do not offload ordinary debugging steps to the user.

### 8.1 Reuse the proven Skip -> Continue recovery

When macOS, the GUI-control layer, or an unrelated application interrupts an already authorized hardware-validation step, reuse the following recovery before starting a new investigation:

1. Read the prompt and identify which application and permission it belongs to. Do not confuse an unrelated prompt with an AE, CEP, native-plugin, or MCP failure.
2. If the permission is optional for the current acceptance path, click **Skip**. A known example is an unexpected Shadowrocket proxy/network permission prompt during local AE work; local AE validation must not be blocked on granting that unrelated permission.
3. Click **Continue** in the controlling workflow to dismiss the interruption and return control to the active task.
4. Read the screen again, restore focus to the exact target application, and resume from the last verified checkpoint. Do not restart the entire install, pairing, fixture, or acceptance sequence merely because the UI was interrupted.
5. Retry the originally intended, idempotent click at most once after confirming the expected screen is visible. For a write or an operation with uncertain side effects, inspect AE state and audit evidence before any retry.

Treat this Skip -> Continue sequence as established project knowledge. Do not repeatedly ask the user how to handle the same optional prompt, and do not turn it into a new P0 investigation.

### 8.2 Recover from a genuine system-level block

- First try the already authorized normal GUI path. If automation can click the required control safely, click it and continue without asking the user.
- If macOS presents a protected confirmation that automation genuinely cannot operate, stop repeated or blind clicking. Record the exact prompt text, owning application, required button, and last verified checkpoint.
- Ask the user for only the one unavoidable confirmation. Do not ask them to repeat ordinary focus, navigation, pairing, save, close, restart, or test-fixture steps.
- After the user confirms completion, take a fresh UI observation, verify that the prompt is gone or the permission changed, restore the exact target application and fixture, and continue from the saved checkpoint immediately.
- If the system block disappears without the requested permission being necessary, use **Skip** and **Continue** and resume. Do not broaden permissions merely to make the warning disappear.
- A recovered GUI interruption is not evidence that the product operation succeeded. Continue the original public-MCP acceptance path and collect the same AE state, provenance, audit, and postcondition evidence required before the interruption.

## 9. Completion evidence

A capability-package development completion report must include:

- package PR, parent Epic, any optional child Issue links and dispositions, per-tool acceptance disposition, tested source revision/build receipt, and merge commit;
- the public MCP request and structured response;
- AE state evidence before and after the operation;
- native/AEGP provenance and observed component/protocol versions;
- audit evidence with sensitive values and private paths redacted;
- Undo and recovery evidence for writes;
- CI/review status, the required HDEV disposition, and the explicit status `development-verified` rather than `release-accepted`;
- remaining risks and their follow-up issue classification.
- package-efficiency counters: included tools, review rounds, T3/CI runs, HDEV runs, first-hardware-pass result, environment/pairing interruptions, and elapsed time from scope freeze to merged development verification.
- a machine-generated per-tool summary containing public-call counts, request/result disposition, before/after state, Undo result, component build receipts/versions, host instances, audit/postcondition IDs, and fixture lifecycle. PR and Issue updates should consume this generated summary instead of manually transcribing repeated evidence.

Do not claim completion using only "tests passed", "CI is green", "the plugin compiled", or "the PR merged".

The target release milestone retains the complete changed-capability matrix since the previous release. Its separate release completion report adds the frozen packaged source/artifact identity, strict release-audit results, aggregate T5, clean-install/upgrade/rollback T6, and the status `release-accepted`. Only packaged T5/T6 may use that status.

## 10. Stop conditions before starting the next dependent capability package

Do not proceed to the next dependent capability package when any of the following is true:

- the current required HDEV public MCP smoke has not passed on real AE;
- an installed component or protocol is observed to be incompatible with the active public-MCP path;
- a write produced an indeterminate result whose AE state and audit outcome are unreconciled;
- the PR is merged but its development evidence, Issue disposition, or fixture disposition is incomplete;
- the test fixture, logs, or workspace state cannot distinguish the tested build from an older installation;
- a new task would hide or work around the current failure instead of resolving it.

These stop conditions are delivery controls, not reasons to add unrelated hardening. Fix the narrow blocking path, preserve the evidence, and resume the closure loop.

## 11. Require user approval before the next PR package

After every capability-package or standalone product PR completes its ordinary closure loop—including merge, required HDEV, Issue/release-milestone updates, evidence publication, and fixture disposition—stop work before beginning another PR package.

- Perform only the bounded read-only inventory needed to prepare the decision. Do not create the next Issue, branch, worktree, schema, fixture, candidate, or implementation, and do not mutate backlog priorities before approval.
- Present the user with the just-completed package status and any remaining risks, followed by two to four next-package candidates ordered by dependency and user value.
- For each candidate, state the target user workflow, proposed 6-10 public tools or bounded standalone outcome, shared SDK suite/primitive, native novelty, dependencies, expected HDEV budget and contribution to the later packaged release matrix, principal risks, and explicit non-goals.
- Recommend one direction with concrete reasoning, but treat it as a proposal rather than authorization.
- Wait for the user's explicit selection or approval before creating or implementing the next PR package. Silence, an earlier backlog order, an existing open Issue, or a previous instruction to continue sequentially does not satisfy this approval gate.

This is a mandatory product-direction checkpoint, not a request to pause an unfinished package. Finish the active package safely, then stop at the approval packet.
