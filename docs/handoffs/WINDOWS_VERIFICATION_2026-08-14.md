# Windows verification handoff — 2026-08-14

Everything in the #242 / #243 batch was written and verified on macOS. Five of
the six items were **reported from Windows**, and three of them can only be
proved there. This is the list of what a Windows machine can settle that a Mac
cannot, ordered by how much is still unknown.

Branch: `handoff/windows-verification` — `main` plus the two PRs still awaiting
merge, so one checkout exercises all of it.

## What is on this branch

| commit | what | merged? |
|---|---|---|
| `f126b23` | macOS added to the merge gate; bridge test stopped mutating shared stdlib modules | yes |
| `858ff50` `abefd16` | AE 2023/2024 Windows compatibility (`/MT`, CEP 11 shims) | yes |
| `3803219` | composer no longer latches shut at 8px; panel `MinSize` → 300×280 | yes |
| `0c554ff` | previewFrame reports real PNG size, waits for a complete file, per-frame budget | yes |
| `381c777` | `ae.snapshot` default path no longer resolves against the working directory | **PR #249** |
| `3f97c50` | approval model documented; no behaviour change | **PR #250** |

## 1. `ae.snapshot` default path — nothing about this has ever run

**Highest value: the backend is `mss`, which is Windows-only. On macOS the fix
is covered only by unit tests. The capture path has never executed.**

The defect: the default destination was `Path(f"ae_viewer_{ts}.png")` — a bare
filename, resolved against the MCP server process's working directory. That is
`[Errno 13] Permission denied: 'ae_viewer_....png'`, with no directory in the
message because there was never a directory in the path.

The test that matters is not "does snapshot work". It is **does it still work
when the process cannot write to its own working directory** — the condition
that produced the report.

```powershell
# Reproduce the original failure first, on main, so the fix means something.
cd C:\Windows\System32          # or any directory your user cannot write to
ae-mcp                          # start the server from here
# then, from your client: ae_snapshot with no out_path
```

On `main` that should fail with the Errno 13 above. On this branch it should
write into `%TEMP%\ae_mcp_snapshots\ae_viewer_<uuid>.png` and succeed.

Also worth one pass: two snapshots issued in the same millisecond used to be
able to collide on the timestamp. They are UUIDs now, but concurrency on
Windows file handles is its own thing.

## 2. previewFrame under Windows file semantics

Fixed and verified on macOS, but the failure was reported from Windows twice
(#242, #243 item 4) and the mechanism is a **write race** — exactly the thing
antivirus scanning, file locking, and indexing change the timing of.

`saveFrameToPng` does not block. The old code accepted the file as soon as its
first 8 bytes matched the PNG signature; it now requires the `IEND` trailer, a
size unchanged across two polls, and a successful decode.

What to check:

- a 1920×1080 comp at **Full** resolution, repeatedly — the case that produced
  `frame 0 is not a decodable image`;
- the same comp at **Half** — should now succeed and come back with
  `width/height` 960×540, `compWidth/compHeight` 1920×1080,
  `resolutionFactor [2,2]`, `downsampled: true`, and a `note` in the result;
- `times: [0, 7, 14]` — three frames used to exhaust one flat 60s budget while
  each capture was succeeding;
- **with real-time antivirus on.** If a scanner holds the handle open after the
  last write, the size-stable check could pass while the file is still locked.
  This is the specific unknown Windows introduces, and no Mac can answer it.

## 3. The live test suite — never run, on any platform

`packages/core/tests/live/` has thirteen tests behind `AE_MCP_LIVE_TESTS=1` and
a reachable backend. They have never executed. This branch adds three that need
full HD, which is where the write race actually lives.

```powershell
$env:AE_MCP_LIVE_TESTS = "1"
uv run --frozen --python 3.13.13 pytest packages/core/tests/live -v -m live
```

Expect breakage that is the tests' fault rather than the product's — they were
written against a backend that could not be exercised. That is still worth
finding out, and fixing them is worth its own PR.

## 4. Composer floor and the new panel minimum

The 8px collapse was measured on Windows through CEP DevTools, and the fix is
verified on macOS only as unit tests plus a visual check.

Two things to confirm, one of which is a **risk this change introduced**:

- the composer opens at 96px with a usable textarea, survives typing, non-ASCII
  input, backspace and clipboard paste, and does not collapse after interaction;
- **`MinSize` moved from 120×240 to 300×280.** That was deliberate — at the old
  minimum the panel could be dragged smaller than its own contents, which is
  what made the collapse reachable. But if you dock ae-mcp into a narrow column
  or a short strip in your normal workspace, this is the change that will bite,
  and only your actual layout can tell us. If it is wrong, say so; the number is
  not sacred.

## 5. AE 2024 and 2023 on Windows — the merged combination has never run

From `AE_2024_WINDOWS_COMPATIBILITY_2026-08.md`: the shutdown and logging
observations were made on a **mixed local build** that also carried an
uncommitted death-hook removal and disabled logging. The combination that
actually merged — `/MT` **plus** the original `AEGP_DeathHook` **plus** the
original synchronous logger — has never run on real AE 2024, and AE 2023 has
not been tested at all.

Tracked in #236. Wanted: AEX loads, one read, one undoable write, a clean exit,
and no new minidump. If it still crashes on teardown, the fallback is to gate
the death hook by host version rather than to catch harder — a C++ `try/catch`
does not reliably contain an access violation during host teardown.

Note for the same trip: on macOS the helper hard-rejects AE 24
(`MacCallerPolicy.supportedAfterEffectsMajors = [25, 26]`, `Authorization.swift`),
which contradicts the CEP manifest's `[23.0,26.9]`. That is #240 and it is a
macOS problem, not yours — but it means AE 2024 acceptance can only come from
Windows right now.

## 6. Packaging — is the sidecar payload still missing?

#239 was worked around, not fixed. A fresh ZXP build from this branch should be
checked for `runtime/windows-x64/node/sidecar`. Note that
`verify-platform-bundle.mjs` validates the bundle against **its own generated
manifest**, so a file that was never staged is absent from both and the check
passes — do not take a green verify as evidence the payload is there. Look in
the archive.

Related: `.debug` is a **required** input to the staged bundle
(`stage-platform-bundle.mjs`), and `resolveSidecarPath` takes the development
branch when it is present. A debug marker doubling as a behaviour switch is the
root of the macOS half of #239.

## Findings from the macOS side you would otherwise not know

**#247 is closed, and the answer is "not our bug".** The report that
`saveFrameToPng` ignores effect-property changes does not hold. Sweeping
Minimax's Operation × Channel while making the same Radius change moves the
picture in four of six combinations and not in two — and a stale capture cannot
be selective by parameter value. `app.purge(ALL_CACHES)` before each capture
changed nothing, and a transform change on the same layer in the same session
was reflected immediately. The AE defaults for a freshly added Minimax happen to
be one of the two no-op combinations. If you ever see identical frames across an
effect change, move a transform first before suspecting the capture.

**CI now runs the full Python and JS suites on macOS as well as Windows**, in
`platform-foundation-ci.yml` rather than `ci.yml` — `ci.yml` is Windows-only by
contract, asserted in `scripts/release/test/signing-plan.test.mjs`. If you add a
job, that test is what will tell you where it belongs.

**`ae_exec` returning a non-string is deterministic, not intermittent.** The
transport does `String(v)`, so an object becomes `"[object Object]"`, and the
leading bracket makes the Python parser treat it as malformed JSON. The script
ran to completion and the write succeeded — only the return value was lost. Do
not retry on it. Fix is pending, bundled with the timeout work.

## Not on this branch, and why

The **timeout / uncertain-execution contract** (#243 item 2, the P0) is not
here. @tomaszteee has a patch with 11/11 passing and has been invited to open
the PR. If you start it in parallel you will collide with them.

The shape it needs, when it lands: the native plane already models this —
`_possibly_side_effecting_error` in `packages/bridge/ae_mcp_bridge/__init__.py`,
`disposition: possibly-side-effecting` / `evidence.effect: may-have-occurred` in
`backends/native.py`, and the "Uncertain native write" recovery in the
`ae-execution-guide` skill. The JSX plane has none of it. The work is porting an
existing contract, not designing one.

## Evidence worth bringing back

For anything that fails, the useful artifact is the pair, not the failure: the
capture or log from `main` and the same from this branch. For #1 that means the
Errno 13 and the successful temp-directory write. For #2, the failing frame and
its size on disk at the moment of failure.

For anything that passes, a one-line note per item is enough — but say which AE
version and whether antivirus was live, because those are the variables that
make Windows different.

---

## Results — verified 2026-08-15 on the owner's Windows machine

| # | Item | Verdict |
|---|---|---|
| 1 | `ae.snapshot` default path | **Fixed, verified, merged (#249).** Errno 13 reproduced byte-for-byte on `main` with the server started from `C:\Windows\System32`; the branch build landed in `%TEMP%\ae_mcp_snapshots\` with UUID names, concurrent ×2 clean. New finding filed separately: the first capture in a process returns pre-DPI-aware coordinates and a possibly stale DWM frame (`mss` flips process DPI awareness on first instantiation). |
| 2 | previewFrame under Windows file semantics | **Pass.** Full HD ×5 consecutive, three-frame batch in 1.3 s (old flat 60 s budget would have died), Half-resolution metadata exact (`960×540`, `resolutionFactor [2,2]`, `downsampled: true`, note present). Defender real-time protection on throughout. Active handle contention was not injected — that specific race remains unexercised. |
| 3 | Live suite | **16/16 green on the first run ever** (8.28 s). The documented command worked exactly as written, including the `--python 3.13.13` venv rebuild. Expected test-fault breakage: none. |
| 4 | Composer floor & panel MinSize | **Pass.** CDP measurement against the live panel: 96 px floor, range 96–447 px, non-ASCII input + backspace survive without collapse. Owner approved the 300×280 MinSize in his real workspace layout. |
| 5 | AE 2023/2024 real hosts | **Blocked by vendor distribution; merged combination verified on AE 2026 instead.** AE 2023 GUI dies on this machine inside `drawbotagm` initialization — environmental, ae-mcp exonerated by elimination (safe mode with third-party effects disabled, panel isolation, full user-font deregistration, hidden CUDA devices: all still die); `aerender 23.5x52` works. AE 2024 is uninstalled and Adobe ships only current+previous major, so no channel exists. The merged `/MT` + original `AEGP_DeathHook` + original synchronous logger combination was instead verified end-to-end on real AE 2026: load event with `sourceCommit 0b98320` → native list/read with live locators → undoable write via `composition.duration.set` under `operationKey` + `undoGroup` → `ipc.listener stopped` → `death` event written by the synchronous logger inside the death hook → endpoint file self-cleaned, **zero new minidumps** (#236). Idempotency (`DUPLICATE_REQUEST` on same key, different args) and frame-alignment validation observed live as a bonus. Community call-for-testing drafted for 2023/2024. |
| 6 | ZXP sidecar payload | **Confirmed missing, then actually fixed.** The three-file interlock (production resolver path / packager that never stages it / verifier that never checks it) is documented above; the real fix ships in PR #251 — payload staged to `runtime/windows-x64/node/sidecar`, stage verification fails closed, stray stage-root copy rejected. |

Merged from this batch: #249, #250. Open follow-ups: PR #251 (the #239 fix), the AE 2023/2024 call-for-testing issue, and the clean-machine bootstrap gap — the Claude channel's sidecar requires a system Node ≥ 18 that the first-run wizard neither detects nor installs, while the failure copy points at an "offline runtime" that does not exist on Windows.
