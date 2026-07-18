---
name: Native capability package
about: Plan related native public MCP tools with one review and real-AE closure loop
title: "[Native Capability Package] "
labels: ""
assignees: ""
---

Follow `docs/CAPABILITY_PACKAGE_WORKFLOW.md`. This Issue is the single source of truth for package scope and the acceptance matrix.

## Package identity

- Parent Epic:
- Priority: P0 / P1 / P2 / P3
- Owner worktree/branch:
- User-visible outcome:
- Normal target: 6-10 tools (allowed range 5-15)

## Child Issues (optional)

- [ ] #

## Scope freeze

### Shared implementation

- AEGP suites / native primitive:
- Locator / lifecycle:
- Dispatcher path:
- Disposable fixture:
- Undo / recovery model:
- User scenario:

### Explicit exclusions

-

### Native novelty

- [ ] No new real-AE primitive; T4 is not required.
- [ ] New suite/lifecycle/main-thread mechanism; one narrow T4 smoke is required.
- T4 hypothesis and observable result:

## Public capability and acceptance matrix

| Optional child Issue | Public MCP tool and schema | Capability ID / shared primitive | R/W | Postcondition | Undo | Important interaction | Status |
|---|---|---|---|---|---|---|---|
| # |  |  |  |  |  |  | planned |

## Executable acceptance path

```text
public MCP tool
  -> Core handler/backend
  -> native RPC
  -> AEGP main-thread dispatcher
  -> After Effects state
  -> typed result
  -> audit evidence
```

- Public request(s):
- Read-state evidence:
- Write before/after evidence:
- Undo execution and verification:
- Recovery / uncertain-failure check:
- Restart/reconnect check:

## Test plan

- T0 commands:
- T1 commands:
- T2 commands:
- T3 full regression / required CI for each frozen candidate SHA:
- T4 narrow hardware smoke, if required:
- T5 candidate harness:
- T6 clean-main harness (every included public tool; accepted optional child Issues; every write Undo):

## Hardware preflight

- [ ] Formal AE path/version/build selected; Beta excluded.
- [ ] Target machine unlocked/awake; OS permissions and GUI control prepared.
- [ ] Canonical CEP/native paths and scan roots checked.
- [ ] Disposable fixture and evidence root prepared.
- [ ] Pairing and known modal-dialog recovery prepared.
- [ ] Exact SHA, clean state, artifact hashes, and installed receipts will be captured.

## Exit conditions

- [ ] All included tools pass the public-MCP candidate session.
- [ ] Typed result, AE state, provenance, audit, and postcondition agree.
- [ ] Every write has executed and verified Undo.
- [ ] Review/CI pass and candidate identity is exact.
- [ ] Clean-main rebuild/reinstall and package smoke pass.
- [ ] Per-tool acceptance, optional per-Issue disposition, and remaining risks are recorded.
