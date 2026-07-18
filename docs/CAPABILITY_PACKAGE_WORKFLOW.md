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

The package owns one branch/worktree, one PR, one acceptance matrix, one concentrated review, one frozen candidate, one candidate hardware session, and one clean-`main` revalidation. T4-T6 apply to AE-dependent packages; a non-AE isolated fix uses the applicable lower tiers and records its observable acceptance check instead of manufacturing hardware evidence.

## 2. Scope freeze before implementation

Use `.github/ISSUE_TEMPLATE/capability-package.md` to freeze:

- parent Epic, child Issues, priority, and user-visible outcome;
- public MCP names and schemas;
- shared native primitives and which ones are new on real AE;
- read/write, side-effect, idempotency, postcondition, and Undo contracts;
- disposable fixture and important inter-tool interactions;
- executable public-MCP acceptance path;
- explicit exclusions and follow-up boundaries;
- relevant T0-T3 commands and the hardware preflight.

Implementation may refine an ambiguous field, but a material scope expansion requires an explicit package decision. Reviewer suggestions do not silently change the freeze.

## 3. Package lifecycle

| Phase | Normal target | Work | Exit condition |
|---|---:|---|---|
| Frame | 2-4 hours | Freeze schemas, matrix, fixture, native novelty, acceptance harness skeleton, exclusions | Matrix is reviewable and every child Issue has an observable result |
| Native novelty smoke | 0-1 focused run | Only for an unverified suite, lifecycle, or main-thread mechanism | Primitive works in real AE or the package is redesigned |
| Implement | 1-2.5 working days | Up to three coordinated tracks: native; Core/bridge/public MCP; tests/fixture | All matrix rows pass T0-T2 and generated artifacts are current |
| Review, freeze, and CI | 0.5-1 day | Concentrated review and blocker fixes, freeze the exact SHA, then run T3 and required CI | No unresolved in-scope blocker; the frozen SHA passes T3 and CI |
| Candidate hardware | 60-90 minutes plus deterministic build time | One continuous exact-SHA package session on real AE | Every included child Issue has evidence; writes have verified Undo |
| Merge and main | 0.5-1.5 hours plus build time | Merge, rebuild/reinstall from clean `main`, rerun package smoke | Merge SHA passes and accepted child Issues can close |

These are scope alarms, not promises and not permission to drop evidence. When a phase exceeds its target, first remove unrelated work, repair the environment, or split a genuinely oversized package.

Keep edit-level work local to the package worktree and run T0-T2 there. Publish the package branch for concentrated review/CI after the integration checkpoint instead of pushing every small edit and triggering a full remote matrix repeatedly.

## 4. Test escalation

Use the lowest tier that can disprove the current edit. Escalate only at the listed milestone.

| Tier | When | Typical coverage | Expected frequency |
|---|---|---|---|
| T0 | Every edit | syntax, formatting, lint, one focused unit | Many times |
| T1 | Each tool/adapter | schema, codec, suite adapter, error and postcondition contract | Per matrix row |
| T2 | Package integration | affected native compile, Core/CEP bridge, fixture and interaction corpus, generated-file checks | At integration checkpoints |
| T3 | Frozen candidate | relevant full repository regression and required CI | Once after review |
| T4 | New primitive only | narrow real-AE smoke for the unverified mechanism | Zero or one per package |
| T5 | Candidate | full exact-SHA public-MCP package acceptance | Once normally |
| T6 | Clean main | rebuild/reinstall plus package smoke from merge SHA | Once |

After a T3-T6 failure, first add or run the smallest reproducing T0-T2 test. Batch the complete fix set before returning to the expensive tier.

## 5. Review disposition and timebox

Every finding receives one of three dispositions:

| Class | Required evidence | Action in active package |
|---|---|---|
| Current blocker | Reproduced on the package acceptance path, or demonstrably breaks correctness, recovery, audit, Undo, or safe use | Fix before candidate freeze |
| Follow-up | Credible improvement that does not block the frozen outcome | Record a P1/P2 Issue and keep it out of the PR |
| Out of scope | Hypothetical, duplicated, unsupported, or contrary to the product decision | Document why; do not implement |

Use no more than two concentrated review rounds by default. Investigation of a non-reproduced edge case is limited to 60-90 minutes. Additional review is warranted only when a blocker fix changes the public acceptance boundary.

Concurrency hardening, power-loss behavior, extreme installer recovery, signing/notarization, Windows expansion, generalized frameworks, Provider routing, Tool Library work, and AEGP/JSX resolution do not become P0 without acceptance-path evidence or an explicit user priority change.

## 6. Candidate freeze

Freeze the exact candidate SHA after:

- all product source and generated bundles are committed;
- schemas, fixtures, docs, license/policy metadata, and evidence format are final;
- T0-T2 pass for the exact source and generated files under review;
- concentrated review has no unresolved blocker;
- the worktree is clean and all components can report the same full SHA.

Run the relevant T3 full regression and required CI on that frozen SHA. T5 hardware starts only after they pass. If T3 or CI finds a blocker, unfreeze the candidate, collect and batch the complete fix set, run focused lower-tier tests and review, then freeze one replacement candidate. After freeze, a new SHA is otherwise allowed only for a reproduced acceptance blocker or an evidence-invalidating defect. Do not deploy once per small fix.

Normal budget: at most two candidate builds, one frozen-candidate full CI run, one candidate hardware session, and one clean-main hardware session. Record the reason for any excess.

## 7. Continuous hardware session

Prepare before launching AE:

- formal AE absolute path, version, and build;
- target machine unlocked/awake, required OS permissions, and normal GUI control;
- Beta and unrelated AE processes closed;
- canonical CEP/native paths and scan-root audit;
- exact source SHA, clean state, artifact hashes, and installed receipts;
- disposable project/fixture, evidence root, logs, pairing flow, and known optional dialogs.

Run the package in one continuous window:

1. Launch formal AE and verify host identity and canonical plug-in mapping.
2. Pair immediately without conversational round trips.
3. Create the disposable fixture once.
4. Run every read tool and record the real AE state.
5. For every write: record before state, invoke once, record response/audit/after state, execute Undo, and verify the Undo state.
6. Exercise the important inter-tool combinations from the matrix.
7. Quit and relaunch AE once; verify a new host/session and repeat the package smoke.
8. Emit one machine-readable evidence bundle and a redacted completion summary.

If a write returns `POSSIBLY_SIDE_EFFECTING_FAILURE`, stop retries and reconcile AE state plus audit first.

Commit the package acceptance driver with the package and use the same driver for candidate and clean-`main` runs. The driver must call the public MCP surface, support the package's real dynamic locators and generation changes, create a fresh intent key for each new write while reusing that key for reconciliation, and bind its evidence to separately verified Core/CEP/native/protocol identities. A hashed test plan is explicit authorization for the disposable fixture only; it does not prove the production approval/elicitation path unless the package explicitly exercises that path. Temporary `/private/tmp` clients are not acceptance assets.

Do not introduce a generalized plan language speculatively. Promote repeated driver code into a shared runner only after at least two capability packages demonstrate the same stable need; a shared runner must not infer exact component identity from native self-report or model an invented response/Undo contract.

## 8. Merge and completion

After candidate acceptance:

1. Merge the single package PR.
2. Build and install every relevant component from a clean merge commit.
3. Run T6 with the same harness; the reduced smoke still touches every child Issue, and every write still verifies Undo.
4. Fill `docs/templates/capability-package-completion.md`.
5. Close only the child Issues that passed, then update the parent Epic.

## 9. Efficiency counters

Record these counters in the completion report:

- included tools and accepted child Issues;
- elapsed time from scope freeze to clean-main acceptance;
- review rounds and finding dispositions;
- candidate builds and candidate SHA changes;
- full CI runs;
- T4, T5, and T6 hardware runs;
- first candidate hardware pass/fail;
- environment, pairing, and permission interruptions;
- follow-up work created outside the active package.

Useful targets are 6-10 tools per package, no more than two review rounds, no more than two candidate builds, and exactly one T5 plus one T6 run under normal conditions. These counters diagnose process waste; they are not substitutes for functional evidence.

## 10. WIP and exceptions

- Keep one dependent native capability package in flight.
- The package may have up to three coordinated implementation tracks, but only one schema freeze and acceptance matrix.
- One truly independent auxiliary package may proceed only if it cannot mix builds, fixtures, interfaces, or hardware state.
- Do not start the next dependent package until clean-main acceptance finishes.
- A one-day workflow improvement is allowed only when it removes a measured repeated cost on the active path. Larger infrastructure work needs explicit user promotion.
