# Capability Package Delivery Workflow

This playbook turns the repository rules in `AGENTS.md` into a low-overhead delivery loop for After Effects native capabilities. It optimizes repeated work without weakening real-AE acceptance.

## 1. Delivery unit

The default delivery unit is one capability package containing 6-10 related public MCP tools (5-15 is the allowed range). Tools belong in the same package when they share at least two of these:

- AEGP SDK suite or native object lifecycle;
- locator and stale-object behavior;
- main-thread dispatcher path;
- disposable AE fixture;
- Undo or recovery model;
- user scenario and tool interactions.

An isolated bug or infrastructure fix may remain a single-Issue package. Do not create one PR per simple tool merely because each tool has a child Issue.

The package owns one branch/worktree, one PR, one acceptance matrix, one concentrated review, and one bounded HDEV real-AE session. HDEV is permanently non-candidate development evidence. The target release milestone aggregates every changed-capability matrix since the previous release and later owns the strict packaged T5/T6 boundary. A non-AE isolated fix uses the applicable lower tiers and records its observable acceptance check instead of manufacturing hardware evidence.

## 2. Scope freeze before implementation

Use `.github/ISSUE_TEMPLATE/capability-package.md` to freeze:

- parent Epic, optional child Issues, priority, and user-visible outcome;
- public MCP names and schemas;
- shared native primitives and which ones are new on real AE;
- read/write, side-effect, idempotency, postcondition, and Undo contracts;
- disposable fixture and important inter-tool interactions;
- executable public-MCP acceptance path;
- explicit exclusions and follow-up boundaries;
- relevant T0-T3 commands and the hardware preflight.

Implementation may refine an ambiguous field, but a material scope expansion requires an explicit package decision. Reviewer suggestions do not silently change the freeze.

### Non-Undoable native writes

The executable definition is `native/ae-plugin/protocol/aegp-rpc.schema.json`:
every successful mutation response must contain an `evidence.undo` object, while
read-only responses must omit it. For a native write whose pinned SDK
documentation explicitly says non-Undoable, that object is exactly
`{"available":false,"verified":false}`. Absence is invalid. The capability must
not open an AE Undo group for that operation, and must not claim an Undo entry,
Undo availability, Undo execution, or Undo restoration. Acceptance must record
the SDK citation, the public request and response, before/after readback at both
the native and public layers, audit and postcondition evidence, and a distinct
idempotent compensating public write that restores the exact prior state with
an independently verified full postcondition. A real AE Undo may be reported
only if a hardware run proves that this exact operation restores the prior
state; until then it must never be claimed, and never inferred from
AEGP_StartUndoGroup/AEGP_EndUndoGroup returning success or from an Edit-menu
label.

Do not open the group merely to test this: source evidence cannot distinguish no entry from a phantom entry that appears in Edit but does not restore the value. A phantom entry is worse because a user can see the menu respond and reasonably believe the write was reverted.

## 3. Package lifecycle

| Phase | Normal target | Work | Exit condition |
|---|---:|---|---|
| Frame | 2-4 hours | Freeze schemas, matrix, fixture, native novelty, acceptance harness skeleton, exclusions | Matrix is reviewable and every included public tool has an observable result |
| Native novelty smoke | 0-1 focused run | Only for an unverified suite, lifecycle, or main-thread mechanism | Primitive works in real AE or the package is redesigned |
| Implement | 1-2.5 working days | Up to three coordinated tracks: native; Core/bridge/public MCP; tests/fixture | All matrix rows pass T0-T2 and generated artifacts are current |
| Review and CI | 0.5-1 day | Concentrated review and blocker fixes, commit the development source and component receipts, then run T3 and required CI | No unresolved in-scope blocker; the reviewed source passes T3 and CI |
| HDEV hardware | Bounded scenario, normally under 30 public calls | Reuse the compatible development installation; exercise every new native primitive and one representative per shared adapter/locator/Undo family | Public MCP, AE state, provenance, audit, postcondition, and representative real Undo agree; evidence says `candidateEvidence=false` |
| Merge and milestone | 0.5-1 hour | Merge, close development-verified implementation Issues, add the changed-capability matrix to the target release milestone | PR is `development-verified`; it is not called `release-accepted` |

These are scope alarms, not promises and not permission to drop evidence. When a phase exceeds its target, first remove unrelated work, repair the environment, or split a genuinely oversized package.

Keep edit-level work local to the package worktree and run T0-T2 there. Complete the concentrated review and resolve blockers before the required T3/CI run and HDEV. Do not push every small edit and trigger a full remote matrix repeatedly. If a genuinely required human review can only occur on GitHub, publish a Draft explicitly as review input.

## 4. Test escalation

Use the lowest tier that can disprove the current edit. Escalate only at the listed milestone.

| Tier | When | Typical coverage | Expected frequency |
|---|---|---|---|
| T0 | Every edit | syntax, formatting, lint, one focused unit | Many times |
| T1 | Each tool/adapter | schema, codec, suite adapter, error and postcondition contract | Per matrix row |
| T2 | Package integration | affected native compile, Core/CEP bridge, fixture and interaction corpus, generated-file checks | At integration checkpoints |
| T3 | Reviewed development source | relevant full repository regression and required CI | Once after review |
| T4 | New primitive only | narrow real-AE smoke for the unverified mechanism | Zero or one per package |
| HDEV | Ordinary AE-changing PR | current compatible development install, every new native primitive plus justified representatives, always non-candidate | Once normally |
| T5 | Packaged release candidate | full aggregate changed-capability matrix since the prior release under strict release-audit identity | Once normally per release candidate |
| T6 | Packaged release artifact | clean install, upgrade, rollback, and release-boundary replay | Once normally per release |

After a T3/HDEV/T5/T6 failure, first add or run the smallest reproducing T0-T2 test. Batch the complete fix set before returning to the expensive tier.

## 5. Review disposition and timebox

Every finding receives one of three dispositions:

| Class | Required evidence | Action in active package |
|---|---|---|
| Current blocker | Reproduced on the package acceptance path, or demonstrably breaks correctness, recovery, audit, Undo, or safe use | Fix before HDEV or packaged release freeze, whichever boundary it affects |
| Follow-up | Credible improvement that does not block the frozen outcome | Record a P1/P2 Issue and keep it out of the PR |
| Out of scope | Hypothetical, duplicated, unsupported, or contrary to the product decision | Document why; do not implement |

Use no more than two concentrated review rounds by default. Investigation of a non-reproduced edge case is limited to 60-90 minutes. Additional review is warranted only when a blocker fix changes the public acceptance boundary.

Power-loss/cross-restart continuation and hostile-local-process hardening are rejected by the
product trust policy and must not become capability-package work. Concurrency correctness, extreme
installer recovery, signing/notarization, Windows expansion, generalized frameworks, Provider
routing, Tool Library work, and AEGP/JSX resolution do not become P0 without acceptance-path
evidence or an explicit user priority change.

## 6. Development review and release-candidate freeze

Before ordinary HDEV:

- all product source and generated bundles are committed;
- schemas, fixtures, docs, license/policy metadata, and evidence format are final;
- T0-T2 pass for the source and generated files under review;
- concentrated review has no unresolved blocker; and
- every selected or reused component has a compatible protocol/version plus
  its own source revision and development install receipt.

Run the relevant T3 regression and required CI, then HDEV. HDEV records the
component revisions but remains `validationProfile=development`,
`candidateRun=false`, and `candidateEvidence=false`. If it finds a blocker,
collect the bounded trustworthy sweep, repair one batch, rerun affected lower
tiers, and replay HDEV. It never becomes release evidence.

At target-release freeze, aggregate all changed-capability matrices since the
previous release and build one packaged candidate. This boundary retains exact
source/artifact identity, full payload hashes, and the signed bundle manifest
alignment, complete cross-component SHA checks, and all existing strict
protocol/product/platform/architecture/entrypoint/load, signing, and scan-root
gates. T5 starts only after the frozen artifact passes its required regression
and CI. A reproduced release blocker may justify one replacement candidate.

## 7. Continuous hardware session

Prepare before launching AE for HDEV:

- formal AE absolute path, version, and build;
- target machine unlocked/awake, required OS permissions, and normal GUI control;
- Beta and unrelated AE processes closed;
- canonical CEP/native paths and scan-root audit;
- selected/reused component revisions, compatibility versions, and development
  install receipts;
- bounded canonical-path, size, mode, and modification-time signals for the
  selected Core checkout, CEP extension, and native plug-in;
- disposable project/fixture, evidence root, logs, and known optional dialogs.

Run HDEV in one continuous window:

1. Run read-only doctor, then launch the exact formal AE executable with the
   child-only checkout override.
2. Verify host identity, canonical plug-in mapping, compatible
   protocol/product versions, and automatic same-user/current-AE admission.
3. Save one empty `ephemeral-validation` project once.
4. Exercise every new native primitive and one justified representative per
   shared adapter, locator, and Undo family through public MCP.
5. For each representative write, record before state, invoke once, record
   response/audit/after state, execute real Undo when guaranteed, reacquire
   locators, and independently verify restoration.
6. Emit one machine-readable bundle with `candidateEvidence=false`, close AE,
   and archive exactly one fixture with no Save As copies.

Before HDEV, run the read-only doctor for the selected components. It must
prove that checkout Core, CEP/native development installation, formal AE path,
and protocol metadata are compatible and usable without installing
dependencies. Repair failures at T0-T2; they are not hardware attempts.

One ledger must count every public MCP dispatch. Put stress, repeated calls,
parameter combinations, and the broad error matrix in T2. HDEV uses a frozen
bounded plan; `native-exec-ir@1` has exactly nine public calls and
aborts before call ten. Release T5/T6 own separate frozen aggregate budgets.

If a write returns `POSSIBLY_SIDE_EFFECTING_FAILURE`, stop retries and reconcile AE state plus audit first.

Commit the HDEV plan and driver with the workflow. It must call public MCP,
support real dynamic locators and generation changes, use a fresh intent key
for each new write while reusing that key for reconciliation, and bind evidence
to separately recorded selected/reused component identities and protocol
compatibility. HDEV evidence cannot be copied into or promoted as packaged
candidate evidence. Release T5/T6 use the aggregate release harness and strict
artifact identity boundary.

Do not introduce a generalized plan language speculatively. Promote repeated driver code into a shared runner only after at least two capability packages demonstrate the same stable need; a shared runner must not infer exact component identity from native self-report or model an invented response/Undo contract.

### 7.1 Known traps that cost whole retry cycles

A retry of the seven-call sequence is not cheap: it costs a full AE quit,
relaunch, and fixture reopen. One package needed five attempts before the
passing run, and the product code was correct in every one of them — three
failures were the harness, one was the environment. Check these before the
session rather than discovering them mid-run.

**Reopen the fixture through AE's own Open Recent.** The macOS file-open
dialog exposes its file rows to the accessibility tree as editable text, so
clicking a row does not select it and Open stays disabled. One session spent
roughly forty accessibility operations — path entry, search, filter, row
containers, identifier refreshes — before falling back to File > Open Recent,
which worked immediately. Do not reach for Finder or LaunchServices instead;
they may route the project to Beta or another host.

**Validate the driver's expectations against the published contract at T1 or
T2.** A driver asserted `replayed=true` for a repeated write key where the
public schema, the Core tests and the native dispatcher all specify
`DUPLICATE_REQUEST`. The tool behavior was correct; the assertion was wrong;
it surfaced on real hardware at call four. A driver expectation that contradicts
the contract is a lower-tier defect and must never reach HDEV or packaged T5.

**The native replay fence lives as long as the host process, and Undo does not
clear it.** A rerun that reuses an operation key from an earlier run in the same
host will be refused, even after the earlier write was undone and the fixture
restored. Either mint a fresh key per evidence session or restart the host
before rerunning. Reconciliation still requires reusing the original key — the
two rules do not conflict, but the driver has to distinguish them.

## 8. Merge and completion

After HDEV:

1. Publish the machine-generated summary and mark the PR
   `development-verified`, never `release-accepted`.
2. Merge the single package PR.
3. Close only implementation Issues whose development matrix passed.
4. Add the complete changed-capability matrix and HDEV disposition to the
   target release milestone.
5. Finish fixture disposition and stop at the next-package direction checkpoint.

At release freeze, T5 runs the aggregate matrix against the packaged
release-audit artifact. T6 then uses a distinct plan to prove clean install,
upgrade, rollback, and the packaged boundary rather than replaying every thin
wrapper.

### What T6 must replay

T5 proves the aggregate changed-capability release candidate. T6 proves that
the packaged artifact installs, upgrades, rolls back, and still exposes its
critical paths. Those are different questions, so the plans differ.

T6 must replay:

- every native primitive introduced since the previous release, on its first
  packaged clean install;
- one representative tool per family that shares an already-proven primitive —
  if one sibling works from a clean install, the others exercise the same path;
- every tool whose implementation changed after packaged T5,
  including anything touched by a replacement candidate;
- anything that touches install, staging, generated bundles or component
  identity, because those are precisely what packaging and installation change;
- at least one real Undo per distinct Undo model in the release matrix, not per tool.

T6 may skip a thin setter that shares its primitive, Undo model, and locator
scheme with a tool already replayed, and whose packaged implementation is
byte-identical to T5. Record what was skipped and on which ground;
an unexplained omission is not a reduction, it is a gap.

This is a deliberate trade. A selective replay can miss an integration defect
that only shows up on a clean install, which is why the qualifying list above is
specific rather than left to judgement. If a package cannot say plainly which of
its tools are thin wrappers over an already-replayed path, it does not yet
understand its own shape and should replay everything.

Packaged component identity is recorded **once per session**, with per-tool records
carrying only deltas. Repeating an invariant component set in every per-tool
record inflates the evidence bundle without adding traceability.

## 9. Efficiency counters

Record these counters in the completion report:

- included tools and accepted optional child Issues;
- elapsed time from scope freeze to merged development verification;
- review rounds and finding dispositions;
- development component syncs and source revisions;
- T3/CI runs;
- T4 and HDEV hardware runs;
- first HDEV pass/fail;
- environment, GUI, and permission interruptions;
- follow-up work created outside the active package.

Useful ordinary-PR targets are 6-10 tools per package, no more than two review
rounds, one T3/CI run, and one successful HDEV. Release-level counters
separately record candidate builds, aggregate T5, and packaged T6. These
counters diagnose process waste; they are not substitutes for functional evidence.

## 10. WIP and exceptions

- Keep one dependent native capability package in flight.
- The package may have up to three coordinated implementation tracks, but only one schema freeze and acceptance matrix.
- One truly independent auxiliary package may proceed only if it cannot mix builds, fixtures, interfaces, or hardware state.
- Do not start the next dependent package until the current PR is merged,
  development evidence and Issue/release-milestone dispositions are published,
  the fixture is archived, and the user selects the next direction.
- A one-day workflow improvement is allowed only when it removes a measured repeated cost on the active path. Larger infrastructure work needs explicit user promotion.
