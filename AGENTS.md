# Repository Development and Delivery Rules

These rules apply to human developers and coding agents working in this repository. They exist to keep engineering effort aligned with observable After Effects functionality. When an issue plan, reviewer suggestion, or local preference conflicts with these rules, stop and resolve the conflict in favor of the user-visible acceptance outcome unless the user explicitly changes the priority.

## 1. Measure outcomes, not activity

- The primary P0 measure is a working capability through the public MCP surface. Lines changed, tests added, commits, PRs, protocol completeness, and CI status are supporting evidence, not delivery.
- Prefer the smallest real vertical slice to prove a new primitive over a sequence of horizontal infrastructure layers. Once the primitive is proven, batch related tools into the capability package in section 2 instead of creating one-tool delivery units.
- A build, mock, isolated RPC test, internal function call, or ping-only result does not prove an AE capability works.
- Do not describe a capability as complete until its observable AE result has been verified on the target machine.

## 2. Prioritize by dependency and user value

- Do not implement issues by issue number or creation order. Maintain P0/P1/P2/P3 priorities based on dependency and user value.
- Work on one dependent P0 capability package at a time. A capability package normally groups about 5-15 tightly related tools that share an AEGP SDK suite, dispatcher, fixture, Undo model, or user scenario. Small infrastructure changes and isolated fixes may remain single-Issue packages when they do not belong to a tool family.
- Prefer 6-10 tools for a normal capability package. Before implementation, freeze a short package brief containing any optional child Issues, public MCP schemas, capability/interaction matrix, native novelty, disposable fixture, Undo model, executable acceptance path, and explicit non-goals. Do not split the frozen package into one branch or PR per simple tool.
- A capability package may retain multiple child Issues and acceptance checklists, but it uses one branch/worktree, one PR, one concentrated review, one exact-candidate hardware acceptance run, and one clean-`main` hardware revalidation. Close each child Issue only when its own acceptance result passed in the package evidence.
- The package closure loop is: design the public MCP schemas and interaction matrix -> implement with incremental unit/contract/compile tests -> independent diff review -> CI -> exact-build package hardware validation -> merge -> rebuild/reinstall from `main` -> package hardware revalidation -> close accepted child Issues and update their parent epic.
- Parallel work is allowed only when it is genuinely independent and cannot cause mixed builds, shared-fixture conflicts, or premature assumptions about an unmerged interface.
- The WIP limit is one dependent native capability package. That package may use at most three coordinated implementation tracks (native, Core/bridge/public MCP, and tests/fixture), but they share one schema freeze, one branch/worktree, and one acceptance matrix. Do not begin the next dependent package before the current package passes clean-`main` revalidation.
- Treat schedule targets as scope alarms, not permission to weaken evidence: package framing should normally take 2-4 hours, implementation 1-2.5 working days, concentrated review and CI 0.5-1 day, and the prepared hardware session 60-90 minutes excluding deterministic build time. When a target is exceeded, cut unrelated scope or repair the environment instead of accumulating more infrastructure inside the package.
- Workflow infrastructure must remove a measured repeated cost from the active acceptance path and is timeboxed to one working day unless the user explicitly promotes it. Otherwise record it as a follow-up and continue the capability package.

## 3. Define the public vertical-slice acceptance test first

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

- When a package introduces a new AEGP SDK suite, object-lifecycle rule, main-thread mechanism, or other unverified native primitive, run one narrow intermediate hardware smoke as soon as that primitive is testable. Once the mechanism is proven, do not redeploy for each simple tool built on it.
- Complete the package with one exact-SHA real-machine run through the public MCP surface that exercises every included tool and their important interactions in the same disposable AE fixture. Batch the structured response, AE state, native provenance, audit, recovery, and write-tool Undo evidence.
- Any package whose acceptance depends on AE loading, lifecycle, GUI state, main-thread behavior, CEP/native communication, or project mutation still requires this package-level real-machine validation before merge.
- Automated tests and CI never substitute for hardware validation.
- Build, install, and test the exact candidate commit. Core, CEP host, native plugin, protocol metadata, and test evidence must report the same full commit SHA. Abort validation on any mismatch.
- After merge, repeat the public MCP package smoke from a clean `main` build. It must touch every included public tool, cover each accepted optional child Issue, and verify real Undo for every included write. Do not rely on the pre-merge installation.
- Use a dedicated disposable AE project. Never use the user's production project for write testing.
- Prepare GUI access, permissions, pairing, no-sleep state, fixture path, canonical plugin path, and log locations in one preflight instead of discovering them through repeated user interruptions.
- After concentrated review has no unresolved blocker and all source, generated bundles, documentation, license metadata, fixtures, and evidence schemas are committed, designate that exact SHA as the candidate freeze. Run T3 and required CI on the frozen SHA; except for the single narrow smoke allowed for a genuinely new native primitive, do not begin exact-candidate hardware acceptance until they pass. This is the candidate freeze.
- After candidate freeze, change the SHA only for a reproduced acceptance blocker or a defect that demonstrably invalidates the package evidence. Batch all known blockers into one fix set, rerun only the affected lower test tiers, perform a focused re-review, and then create one replacement candidate. The replacement is a new frozen candidate and must pass required CI before any T5 acceptance evidence is collected.
- The normal target is one candidate and one full CI run. At most one replacement candidate is allowed for a reproduced blocker; that replacement gets its own required CI run, while already-passing unaffected local tiers need not be repeated. The normal hardware target remains one successful candidate session and one clean-`main` session. Exceeding these targets must be explained in the completion evidence; it is not a reason to weaken a gate.

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
- **T3, frozen candidate:** the relevant full repository regression plus required CI; run once for each exact candidate SHA after concentrated or focused replacement review.
- **T4, optional native-novelty smoke:** one narrow real-AE check only when the package introduces an unverified suite, object lifecycle, or main-thread mechanism.
- **T5, candidate acceptance:** one exact-SHA public-MCP package run on real AE.
- **T6, clean-main acceptance:** one rebuild/reinstall and package smoke from the merge commit that touches every included public tool, covers each accepted optional child Issue, and verifies real Undo for every included write.

Do not rerun T3, T5, or T6 after every small fix. A failed higher tier should drive the smallest reproducing lower-tier test first; return to the higher tier only after the fix set is complete.

## 6. Treat writes and uncertain failures explicitly

- A transport timeout or disconnect after dispatch does not prove that a write did not occur.
- Every native write should have a stable operation/request ID, bounded retry behavior, a queryable outcome when feasible, and a postcondition that can be checked independently.
- On an indeterminate result such as `POSSIBLY_SIDE_EFFECTING_FAILURE`, inspect AE state and the audit trail before retrying. Never blindly repeat a possibly completed write.
- Report Undo availability and Undo verification as separate facts. `available=true` must not imply that Undo has been executed and its postcondition verified.
- Success requires agreement between the typed response, AE state, provenance, audit record, and verification result.

## 7. Preserve build and workspace identity

- Use one worktree and one branch for each capability package. Record any optional child Issues and the acceptance matrix owned by that worktree, and know which package owns every build, install, test artifact, and running process.
- Before building or deploying, record `git rev-parse HEAD`, dirty state, artifact hashes, installed paths, and runtime-reported source commit.
- Never mix Core, CEP, native plugin, or protocol files from different commits. A convenient partial redeploy is not valid evidence.
- Keep backup, staging, rollback, and evidence directories outside Adobe's plugin scan roots.
- Keep disposable projects, generated scripts, logs, and smoke outputs out of tracked source paths unless they are intentional fixtures.
- Do not use a stale or dirty root checkout as an implicit source for another issue's build.
- Keep the active build and evidence worktree on fully local, non-evictable storage. Cloud/on-demand placeholders, including macOS `dataless` files, are not valid candidate inputs; hydrate the complete scoped inputs or create a local checkout before freezing the candidate.

## 8. Minimize human interruption during hardware work

- Consolidate all known permissions and GUI prerequisites into one preflight.
- Run package hardware acceptance as one continuous prepared session. Keep pairing, fixture creation, all tool calls, write verification, Undo/Redo, restart/reconnect, and evidence collection in the same orchestrated window; do not spread a short-lived pairing flow across conversational round trips.
- Once the user has authorized routine AE/macOS GUI control, perform normal focus, open/save/close, pairing, restart, disposable-project, and test Undo/Redo operations without repeatedly asking them to click.
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

A capability-package completion report must include:

- package PR, parent Epic, any optional child Issue links and dispositions, per-tool acceptance disposition, exact tested commit, and merge commit;
- the public MCP request and structured response;
- AE state evidence before and after the operation;
- native/AEGP provenance and matching source commit;
- audit evidence with sensitive values and private paths redacted;
- Undo and recovery evidence for writes;
- CI/review status and the clean-`main` hardware revalidation;
- remaining risks and their follow-up issue classification.
- package-efficiency counters: included tools, review rounds, candidate builds, full CI runs, candidate/main hardware runs, first-hardware-pass result, environment/pairing interruptions, and elapsed time from scope freeze to clean-`main` acceptance.

Do not claim completion using only "tests passed", "CI is green", "the plugin compiled", or "the PR merged".

## 10. Stop conditions before starting the next dependent capability package

Do not proceed to the next dependent capability package when any of the following is true:

- the current public MCP acceptance test has not passed on real AE;
- the installed components do not share an exact source commit;
- a write produced an indeterminate result whose AE state and audit outcome are unreconciled;
- the PR is merged but clean `main` has not been rebuilt, reinstalled, and reverified;
- the test fixture, logs, or workspace state cannot distinguish the tested build from an older installation;
- a new task would hide or work around the current failure instead of resolving it.

These stop conditions are delivery controls, not reasons to add unrelated hardening. Fix the narrow blocking path, preserve the evidence, and resume the closure loop.
