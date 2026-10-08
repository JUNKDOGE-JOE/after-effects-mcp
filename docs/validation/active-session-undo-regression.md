# Active-session ownership and Undo regression

Status: scope approved on 2026-10-08; implementation and hardware evidence pending.
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

Approved footprint: about 21 repository files (11 implementation, 6 tests,
3 documentation, 1 generated bundle), plus 3 local validation scripts; approximately
1100–1500 handwritten additions. Generated fixture media and evidence are separate.
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
