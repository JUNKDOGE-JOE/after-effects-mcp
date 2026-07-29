# Task 5 report

Status: DONE

## Source

- Start SHA: `5b08fe480ce9309e540c803eb168e07677f1f795`
- Implementation commit: the commit containing this report
- Tested worktree: `codex/native-exec-ir`

## RED / GREEN

- RED: the portable codec and connection tests did not compile because the
  common native-program success/failure types and encoders did not exist.
- RED: the protocol corpus rejected native-program terminal envelopes because
  the schema had no common success or failure definitions.
- RED: the CEP program cases reached the prior operation-specific client and
  could not send or validate one `ae.native.exec@1` program.
- GREEN: one connection request now dispatches one admitted native program and
  emits one program-level progress event followed by one common terminal.
- GREEN: common success contains named public outputs, ordered operation
  summaries, native evidence, a digest over public outputs plus completed
  operations, and the real program-level Undo availability/label facts.
- GREEN: common failures preserve `not-started`, `completed`, or
  `possibly-side-effecting`, partial outputs and completed operations, failed
  operation identity, `operationKey`, native evidence, and `verified:false`
  postconditions.
- GREEN: every recorded write-program terminal, including safe failures and
  ambiguous failures, is replayed for the same `operationKey + programDigest`
  without redispatch; a different digest conflicts.
- GREEN: disconnect after write dispatch remains
  `POSSIBLY_SIDE_EFFECTING_FAILURE`; no retry is synthesized.
- GREEN: a safe pre-mutation write failure retains `writeStarted:false`,
  `postcondition.verified:false`, its real operation key, and
  `undo.available:true` only when the outer Undo begin/end pair succeeded.

## Change

- Added the common `NativeProgramSuccess` and `NativeProgramFailure` codec
  models and the protocol definitions `nativeProgramInvokeResult` and
  `nativeProgramFailureDetails`.
- Canonicalized public native JSON and completed operation summaries before
  computing the native-program postcondition digest.
- Preserved accumulated operation outcomes and named outputs on executor
  failure instead of reducing a failed program to an operation index alone.
- Recorded balanced outer Undo availability in the dispatcher and retained
  safe/ambiguous terminals in its program replay ledger.
- Routed native-program requests through the existing connection dispatcher,
  validated the returned operation order against the admitted program, and
  encoded a common success or failure terminal.
- Updated persistent native diagnostics with bounded program disposition,
  operation counts, failed index, write-started, Undo-available, and replay
  facts; no output values or synthetic evidence IDs are persisted.
- Exposed only the one-program CEP invoke path. The previous
  operation-specific invoke implementation remains inert and unexported for
  the Task 9 deletion boundary.
- Synchronized the tracked Task 5 plan with the previously approved protocol,
  dispatcher, executor, and diagnostic file boundary.

## Verification

- Strict portable `host_dispatcher_test` compile with
  `-std=c++20 -Wall -Wextra -Wpedantic -Werror -pthread`: PASS.
- `host_dispatcher_test`: PASS.
- Strict portable `rpc_codec_test` compile with the same flags: PASS.
- `rpc_codec_test`: PASS.
- Strict portable `native_rpc_connection_test` compile with the same flags:
  PASS.
- `native_rpc_connection_test`: PASS.
- `node --check plugin/host/native-aegp-client.js`: PASS.
- `node --test native/ae-plugin/protocol/protocol.test.mjs`: 8/8 PASS.
- `node --test plugin/host/native-aegp-client.test.js`: 16 active PASS,
  0 FAIL, 36 legacy operation-specific cases explicitly SKIP.
- Schema inspection: both common native-program definitions exist; native
  program Undo exposes `available`, `verified`, and optional `groupLabel`,
  never `groupId`.
- Pre-report `git diff --check`: PASS.

## Scope and remaining risk

- The 36 skipped CEP cases exercise the intentionally unreachable
  operation-specific invoke carrier. Deleting that carrier and its obsolete
  tests is Task 9, not Task 5; active program, transport, discovery, control,
  deadline, and connection-recovery cases all ran.
- No Task 6 Core public tool schema, Task 7 skill, public tool deletion,
  Task 9 carrier cleanup, install, HDEV, AE launch, fixture mutation, or
  hardware acceptance was performed.
- Task 5 provides portable wire/replay/evidence proof only. Observable AE
  acceptance remains owned by the later frozen package closure tasks.
