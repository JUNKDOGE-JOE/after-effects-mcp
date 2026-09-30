# Native discovery and timeout recovery: issue 392

This is development evidence, not packaged release acceptance. Issue 392
remains open pending the original reporter's verification.

## Implementation provenance

The shared implementation starts from main
`959f9dbf7b63b9362c86016b268f4b0412f9d5e9` and the independently implemented
Windows fix `49c4504cd4a68862e6afbaf74474f9a30eb6d681` (five files,
147 additions and 15 deletions). It forwards native dependencies through
`mountMcp`, makes diagnose perform a bounded read-only negotiation, and clears
a pending connection when its deadline expires. Stale handshake callbacks are
bound to their original socket. Passive status and ping remain passive.

The separate Mac fix `bf20064` was reported as eight files, 165 additions and
three deletions: 65 implementation, 74 test, and 26 documentation lines.
Its exact patch was not supplied or fetched from another machine. This PR
independently covers the reported behavior and adds connection-state reporting
and Unix-socket timeout/retry coverage; it does not claim byte equality with
that patch or Mac hardware validation of this PR's final SHA.

## Windows real-AE observations

AE 26.5x89, CEP 12.0.1, host/native 0.10.8, native wire 1, SDK 25.6.61.
Native source: `bcab87a0ec96b4409636ba6dd3ae5fb3f25d17c7`.

- Baseline AE/CEP host PIDs: 19224/46460. Loaded native module, descriptor PID,
  process start time and live named pipe matched. Cold diagnose returned false.
- Public `ae_nativeExec` with one `project.items.list` operation, offset 0,
  limit 1 and `returnAs="items"` succeeded; total was zero. Native evidence
  reported `effect="none"`, a verified postcondition and no Undo availability.
  Diagnose then returned true. Project was empty and `dirty=false`.
- Windows fix `49c4504` was installed as three backed-up host files. Native
  binary was unchanged. New AE/CEP host PIDs: 12668/66156. Cold passive status
  remained false; first diagnose and the native read both succeeded. Project
  remained empty and clean. The task AE and its native pipe were then closed.
- Its host suite: 424 tests, 406 passed, 18 Unix socket tests skipped, zero
  failures. The same real Windows pipe timeout regression fails on old source
  with `challenge-pending`, and passes after the fix.
- Two descriptors for dead PIDs were present. Verified-owner PID selection
  chose the live host. No actual pipe, PID, session or permission mismatch was
  observed. No genuine AE authorization timeout was induced; timeout recovery
  uses isolated socket/pipe fixtures.

The installed server already had two unrelated differences from main; those
were preserved. No production project was reopened, saved or changed, and no
`.aep` files were created. Raw public MCP and installation receipts are retained
in the Windows task evidence directory; private project paths are excluded here.

## Separately reported Mac observations

AE 26.3x87/native 0.10.8: baseline diagnose=false while public native read
succeeded; first diagnose became true with Mac fix `bf20064`. The reported
counts are 71 focused and 425 full host tests passing. Four host JS files were
backed up for that Mac installation. These are delegated prior-run observations,
not a new Mac run and not evidence for this PR's final SHA.

Before merge or release, validate the final shared revision on macOS through
first diagnose and public native read. Packaged identity, signatures, T5/T6,
the original reporter's result and broader release limitations remain separate
gates. Do not interpret this local repair as release acceptance.
