# Repository Development and Delivery Rules

These rules apply to human developers and coding agents working in this repository. They exist to keep engineering effort aligned with observable After Effects functionality. When an issue plan, reviewer suggestion, or local preference conflicts with these rules, stop and resolve the conflict in favor of the user-visible acceptance outcome unless the user explicitly changes the priority.

## 1. Measure outcomes, not activity

- The primary P0 measure is a working capability through the public MCP surface. Lines changed, tests added, commits, PRs, protocol completeness, and CI status are supporting evidence, not delivery.
- Prefer the smallest real vertical slice over a sequence of horizontal infrastructure layers.
- A build, mock, isolated RPC test, internal function call, or ping-only result does not prove an AE capability works.
- Do not describe a capability as complete until its observable AE result has been verified on the target machine.

## 2. Prioritize by dependency and user value

- Do not implement issues by issue number or creation order. Maintain P0/P1/P2/P3 priorities based on dependency and user value.
- Work on one dependent P0 issue at a time. Do not start or stack the next dependent issue before the current issue has completed its full closure loop.
- The closure loop is: implement -> automated tests -> independent diff review -> CI -> exact-build hardware validation -> merge -> rebuild/reinstall from `main` -> hardware revalidation -> close the issue and update its parent epic.
- Parallel work is allowed only when it is genuinely independent and cannot cause mixed builds, shared-fixture conflicts, or premature assumptions about an unmerged interface.

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

## 4. Hardware validation is a merge gate

- Any change whose acceptance depends on AE loading, lifecycle, GUI state, main-thread behavior, CEP/native communication, or project mutation requires real-machine validation before merge.
- Automated tests and CI never substitute for hardware validation.
- Build, install, and test the exact candidate commit. Core, CEP host, native plugin, protocol metadata, and test evidence must report the same full commit SHA. Abort validation on any mismatch.
- After merge, repeat the relevant public MCP smoke test from a clean `main` build. Do not rely on the pre-merge installation.
- Use a dedicated disposable AE project. Never use the user's production project for write testing.
- Prepare GUI access, permissions, pairing, no-sleep state, fixture path, canonical plugin path, and log locations in one preflight instead of discovering them through repeated user interruptions.

## 5. Keep review feedback from expanding P0

Classify every newly discovered risk or reviewer comment before implementing it:

1. **Current P0 blocker:** reproduced on the acceptance path, or demonstrably prevents correctness, recovery, auditability, or safe use of the current capability.
2. **Follow-up:** credible hardening or product work that does not block the current vertical slice. Record it as a separate P1/P2 issue and keep it out of the active PR.
3. **Not in scope:** hypothetical, unsupported, duplicated, or contrary to the current product decision. Document the disposition without implementing it.

- Do not silently promote concurrency hardening, power-loss behavior, installer edge cases, signing, notarization, cross-platform expansion, or generalized framework work into P0.
- Timebox investigations of non-reproduced edge cases. Once the current acceptance path is safe and reliable, defer the rest.
- A reviewer finding is evidence to evaluate, not an automatic change request or priority override.

## 6. Treat writes and uncertain failures explicitly

- A transport timeout or disconnect after dispatch does not prove that a write did not occur.
- Every native write should have a stable operation/request ID, bounded retry behavior, a queryable outcome when feasible, and a postcondition that can be checked independently.
- On an indeterminate result such as `POSSIBLY_SIDE_EFFECTING_FAILURE`, inspect AE state and the audit trail before retrying. Never blindly repeat a possibly completed write.
- Report Undo availability and Undo verification as separate facts. `available=true` must not imply that Undo has been executed and its postcondition verified.
- Success requires agreement between the typed response, AE state, provenance, audit record, and verification result.

## 7. Preserve build and workspace identity

- Use one worktree and one branch for each issue. Know which worktree owns every build, install, test artifact, and running process.
- Before building or deploying, record `git rev-parse HEAD`, dirty state, artifact hashes, installed paths, and runtime-reported source commit.
- Never mix Core, CEP, native plugin, or protocol files from different commits. A convenient partial redeploy is not valid evidence.
- Keep backup, staging, rollback, and evidence directories outside Adobe's plugin scan roots.
- Keep disposable projects, generated scripts, logs, and smoke outputs out of tracked source paths unless they are intentional fixtures.
- Do not use a stale or dirty root checkout as an implicit source for another issue's build.

## 8. Minimize human interruption during hardware work

- Consolidate all known permissions and GUI prerequisites into one preflight.
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

An issue completion report must include:

- issue and PR links, exact tested commit, and merge commit;
- the public MCP request and structured response;
- AE state evidence before and after the operation;
- native/AEGP provenance and matching source commit;
- audit evidence with sensitive values and private paths redacted;
- Undo and recovery evidence for writes;
- CI/review status and the clean-`main` hardware revalidation;
- remaining risks and their follow-up issue classification.

Do not claim completion using only "tests passed", "CI is green", "the plugin compiled", or "the PR merged".

## 10. Stop conditions before starting the next issue

Do not proceed to the next dependent issue when any of the following is true:

- the current public MCP acceptance test has not passed on real AE;
- the installed components do not share an exact source commit;
- a write produced an indeterminate result whose AE state and audit outcome are unreconciled;
- the PR is merged but clean `main` has not been rebuilt, reinstalled, and reverified;
- the test fixture, logs, or workspace state cannot distinguish the tested build from an older installation;
- a new task would hide or work around the current failure instead of resolving it.

These stop conditions are delivery controls, not reasons to add unrelated hardening. Fix the narrow blocking path, preserve the evidence, and resume the closure loop.
