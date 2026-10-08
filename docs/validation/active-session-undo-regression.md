# Active-session ownership and Undo regression

This record preserves the failed development diagnostic and repair scope.
Final implementation acceptance is recorded in [PR #398](https://github.com/JUNKDOGE-JOE/after-effects-mcp/pull/398).
The 2026-10-08 sweep of source `720a956` completed 35 cases: 26 PASS and 9 FAIL.
Base: main `8807aeb`; branch `codex/active-session-undo-regression`.

## Scope and contract

The owner requested automatic handoff after activity ends and a broad local AEP
regression investigating Undo-group mismatch. Panel turns retain ownership across
tool gaps; external MCP clients retain it only during AE calls. A write binding is
eligibility, not a permanent reservation. Explicit readonly, project generation,
queued/dispatched work, draining and uncertain-result protections remain enforced.
No new public tool, native primitive, provider, service, installer or dependency.
The internal conversation API starts/ends a turn with a matching conversation/turn ID.
Normal provider completion and confirmed termination carry that ID; UI stop is not proof.

Approved footprint: up to 29 repository files plus 3 local validation scripts;
approximately 1700–1850 handwritten additions. Generated bundles/media/evidence are separate.
The local hardware window is budgeted at 80–120 minutes; source/runner failures
remain visible and never turn an unexecuted or unreconciled case into a pass.

## Acceptance paths

Panel send → conversation start → workspace owner → provider events → confirmed end;
second panel/external context cannot write during that turn, then takes over without
user confirmation. External A/B calls serialize and release after completion.
Exercise normal completion, Stop, failed start, confirmed error/exit, old callbacks,
readonly, manual Tool Library controls, explicit rebind and unresolved/draining cases.

Public MCP → host handler → JSX bridge/native → real AE state → typed result and
audit → actual menu Undo/Redo → independent readback. Keep all public request/response
envelopes and a per-case PASS/FAIL/BLOCKED/INDETERMINATE ledger with side-effect and
reconciliation status. This is development evidence, not packaged T5/T6.

## Disposable full-project matrix

One `ephemeral-validation` fixture: 256×144, 24 fps, 2 seconds; Main/precomps,
2D/3D scenes, camera/light, text/shape/mask, keyframes/expressions, solid and generated
local PNG footage. Record actual font/renderer. No user project or external effect.
The recipe rebuilds it; no permanent retention or evidence snapshot is intended.
Count Save As, checkpoint and autosave files, then archive outside Adobe scan roots.

Cases 01–09: baseline; ordinary grouped edit; full-property batch; balanced nested
groups; script-managed groups; exceptions before/after mutation; nested finally;
syntax error. Use actual Undo/Redo/readback where applicable.
Cases 10–18: exact-ID continue recovery; evalFile with balanced groups; tool replay;
preview and expression validation; save outside/inside a group; copy; checkpoint/list.
Cases 19–23: ungrouped 2D/3D render and full Main sequence; direct/bracket/evalFile
grouped render rejection; rendering Tool Library replay rejection.
Cases 24–29: Save As, same-path reopen, new project, revert, restore recovery,
and a finite script deliberately longer than its request budget. Rebind changed
project generations; treat expected project/Undo-history replacement separately.
Cases 30–35, isolated last: unmatched end; unclosed script group; script-owned
group across render; computed render call under a host group; open/new project
inside a host group. Each requires a fresh owned AE process and the same rebuilt
fixture. Never continue ordinary acceptance in a process with a damaged Undo stack.

Stop writes for an unreconciled result, corrupted fixture, crash or incompatible
component. Continue only independent cases with restored/trustworthy state; batch
observed blockers before repair. A timeout does not terminate JSX. Record dialogs
and post-render 3D health; do not infer mismatch solely from a generic script error.

## Diagnostic disposition and replacement boundary

The run used Host 0.11.0, AE26.5x89 and the unchanged native 0.10.8 component.
Cases 4, 8 and 31–35 had Undo-stack warnings; 27/28 failed at the checkpoint project-transition guard.
Clean-process case 4 and script-only nested groups also reproduced; these do not enlarge the 35-case denominator.
Case 19 produced 48 Main frames plus two single frames: 50 verified 256×144 PSDs.
Case 29 recorded an actual 1000 ms JSX timeout, queued read, drain, reconciliation and real Undo/Redo.
The scoped 115 runner logs contain 705 public tool calls; mixed historical helper logs are excluded.
Case 12's marker-preparation failure and case 32's first health-runner failure remain preserved;
the later replay/health result does not erase either incident or case 32's actual mismatch.
All test AE processes exited and the 96-path prior runtime installation was restored; native was unchanged.
Twelve AEP files remain pending cleanup: one baseline, one Save As, one copy, four checkpoints and five autosaves.
They belong to one ephemeral fixture, retained for this package's repair replay; none is recorded as archived.
Private `evidence/summary.json`, `diagnostic-progress.md`, ledger and screenshots retain the original failed run.
Replacement evidence is separate and reuses this fixture. This diagnostic is neither development-verified nor release-accepted evidence.
