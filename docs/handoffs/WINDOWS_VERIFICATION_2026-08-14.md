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

# Verification archive — 2026-08-15

The document above is preserved verbatim as **Part 1: the historical preflight**. It was written on 2026-08-14 against `main @ 0c554ff` plus the then-unmerged #249/#250 (handoff branch `0b98320`) and reflects what was believed *before* the machine run. Everything below records what actually happened, what the preflight got wrong, and where the public evidence lives.

## Part 2 — Windows real-machine results (2026-08-15, owner's machine)

| # | Item | Result |
|---|---|---|
| 1 | `ae.snapshot` default path | **Verified and merged (#249).** Errno 13 reproduced byte-for-byte on `main` with the server started from `C:\Windows\System32`; the fix landed captures in `%TEMP%\ae_mcp_snapshots\` with UUID names; concurrent ×2 clean. New finding: first-capture DPI/stale-frame behaviour, now tracked as #255. |
| 2 | previewFrame under Windows file semantics | **Pass under live antivirus** (Defender real-time on). Full HD ×5 consecutive clean; `times [0,7,14]` completed in 1.3 s under the per-frame budget; Half-resolution metadata exact (`960×540`, `compWidth/Height 1920×1080`, `resolutionFactor [2,2]`, `downsampled: true`, note present). Active handle contention was not injected. |
| 3 | Live suite | **16/16 green on the first run ever** (8.28 s), including the documented `uv run --frozen --python 3.13.13` invocation exactly as written. |
| 4 | Composer floor & panel MinSize | **Pass.** CDP measurement against the live panel: 96 px floor, range 96–447 px, non-ASCII input and backspace survive without collapse. Owner approved the new MinSize in his real workspace. Manifest value: **Width 280 × Height 300** (see correction 6). |
| 5 | AE 2023/2024 | **Not runtime-verifiable on this machine.** AE 2023's GUI dies during `drawbotagm` initialization — environmental, ae-mcp exonerated by elimination (safe mode with third-party effects disabled, panel isolation, full user-font deregistration, hidden CUDA devices: all still die); `aerender 23.5x52` works. AE 2024 is uninstalled and Adobe distributes only current+previous major. Separately, the merged `/MT` + original `AEGP_DeathHook` + original synchronous logger combination ran end-to-end on real AE **2026** (Windows): `load` event with `sourceCommit 0b98320` → native list/read with live locators → undoable write (`composition.duration.set` under `operationKey` + `undoGroup`) → `ipc.listener stopped` → `death` event written by the synchronous logger inside the death hook → endpoint self-cleaned, **zero new minidumps**. Bonus contract observations: idempotency (`DUPLICATE_REQUEST` on same key with different args) and frame-alignment validation, live. |
| 6 | ZXP sidecar payload | **Confirmed missing** by three-file interlock (production resolver path / packager that never stages it / verifier that never checks it). Fix is **PR #251 (open)** — see Part 4 for what "fixed" will require. |

## Part 3 — cross-review corrections

Errors in the first write-up of these results, corrected here so the archive does not propagate them:

1. **"Fixed for real in PR #251" was premature.** At the time of writing, #251 was open and covered only the Windows half. The complete fix (both platforms, shared closure, unified dev-vs-packaged rule, hermetic self-check) is the current #251; even after it merges, #239 stays open and no "v0.9.6 fixes it" claim is made until the immutable v0.9.6 release passes a logged-in `--probe` on real Windows and macOS installs.
2. **"The wizard neither detects nor installs Node" was half wrong.** The diagnostics page DOES detect Node — with the wrong threshold (24.17.0 vs the sidecar's actual 18.0.0 floor) and, on Windows, a fixHint pointing at a repair flow that only exists on macOS (documented in #239). The accurate statement: the first-run wizard has no Node install step; detection exists but its threshold and guidance are wrong.
3. **"New finding filed separately" overstated the DPI discovery.** It existed only as a session chip at the time. It is now genuinely filed: #255.
4. **"Three-frame batch in 1.3 s (old flat 60 s budget would have died)" does not follow.** 1.3 s is far under 60 s; this machine renders fast and cannot reproduce the original failure mode (slow renders × multiple frames exhausting a flat budget). The 1.3 s run proves the per-frame-budget code path works, not that the old budget must fail here. The old failure stands on the original reports (#242/#243), not on this measurement.
5. **AE 2026 does not substitute for AE 2023/2024.** Teardown behaviour is host-version-specific — the entire reason #236 exists. The 2026 run proves the merged combination is clean **on 2026**; 2023/2024 remain statically compatible, runtime-unverified, pending community testing.
6. **"MinSize 300×280" had the axes backwards.** The CSXS manifest writes `<MinSize><Height>300</Height><Width>280</Width></MinSize>`: the panel minimum is **280 wide × 300 tall**. Earlier notes quoted it height-first as if it were width-first.

## Part 4 — open items

- **PR #251** (dual-platform #239 fix): awaiting CI on both platforms and owner merge.
- **v0.9.6**: not released. Required before #239 can close: immutable v0.9.6 artifacts under new names (Windows ZXP, macOS bundle/native artifact, checksums, release notes — v0.9.5 assets are never overwritten), and a logged-in sidecar `--probe` on real Windows and macOS installs of the RC. The networked `--probe` stays out of normal CI by design.
- **macOS**: zero real-host acceptance to date, for anything. The v0.9.5 macOS assets are unsigned and post-hoc; the support matrix and READMEs now say so explicitly.
- **AE 2023/2024 community testing**: #236 tracks real-host acceptance; a call-for-testing draft (with an endpoint-file load-proof procedure and a report template) is prepared and pending owner review.
- **Timeout / uncertain-execution contract (JSX plane)**: #253 (P0; a community patch is reported at 11/11 — coordinate, do not parallelize).
- **Non-string `ae_exec` results destroyed by `String(v)`**: #254.
- **Snapshot first-capture DPI/stale frame**: #255.
- **Clean-machine Node gap**: the Claude sidecar needs a system Node ≥ 18 that nothing installs or correctly guides toward on Windows (documented inside #239; wizard/diagnostics follow-up work).

## Part 5 — public evidence index

**Source SHAs**
- Preflight baseline: `main @ 0c554ff`; handoff branch `0b98320` (= 0c554ff + #249 + #250 cherry-picks + this document's first version).
- Post-merge main at archive time: `254a24f` (#249 = `dc764d2`, #250 = `254a24f`).
- #251: first pass `3ebe268` (Windows-only), dual-platform completion `8d31500`.

**Artifacts and hashes**
- Acceptance AEX (merged combination, #236 run): sha256 `57c6ef9b59e074fb…` — build receipt records `sourceCommit 0b98320`, MSVC `14.44.35207`, Windows SDK `10.0.26100.0`, AE SDK `25.6.61`.
- v0.9.5 release asset digests (GitHub release, for cross-reference): Windows ZXP `2bdac694…`, Windows AEX `479c8808…`, macOS bundle (unsigned) `13ae5692…`, macOS native plugin `41c4587c…`.

**Machine and run context (redacted receipts)**
- Windows 11 build 26200 (kernel 26100.9168), NVIDIA RTX 5080 + AMD integrated, 125 % display scale, Node v24.14.0, Defender real-time ON throughout.
- AE 2026 v26.3 (`26.3x87`), zh-CN UI. AEX install receipt at `%LOCALAPPDATA%\Temp\aemcp-aex\install-receipt-ae2026.json` on the owner's machine (records the pre-swap backup `AeMcpNative.aex.pre-0b98320.bak`).
- Native plugin log evidence (`%LOCALAPPDATA%\AfterEffectsMCP\Logs\native-plugin-v1.jsonl`): `load` (instanceId `c00785b1…`, `sourceCommit 0b98320…`) → `ipc.listener started` → `ipc.listener stopped` → `death`, with the endpoint file `aemcp-n1\d-<uuid>.endpoint` present during the session and removed at teardown.
- Minidump check: `%LOCALAPPDATA%\CrashDumps` + `%LOCALAPPDATA%\Temp` inventories identical before/after (10 pre-existing dumps, 0 new).

**Trackers**: #239 (dual-platform P0, open until v0.9.6 evidence completes), #236 (AE 2023/2024 real-host), #253 (timeout contract), #254 (non-string results), #255 (snapshot DPI), PR #249/#250 (merged), PR #251 (fix), PR #252 (this archive).

