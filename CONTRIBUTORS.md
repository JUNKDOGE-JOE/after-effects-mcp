# Contributors

Git records who wrote a line of code. It has no way to record who spent an
evening with a debugger and came back with the reason a bug happens, or who
ran a build on real hardware nobody else has. Both have moved this project
more than most patches. This file exists for the part git cannot hold.

The [GitHub contributor list][gh] is generated from commits on `main` and stays
the authoritative record for code. Where a fix originated in someone else's
analysis, the commit that lands it carries a `Co-authored-by:` trailer, so that
credit reaches the same place.

[gh]: https://github.com/JUNKDOGE-JOE/after-effects-mcp/graphs/contributors

## Code

**[@Kokoro12345](https://github.com/Kokoro12345)** — After Effects 2024 on
Windows ([#235](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/235)).
Traced a load failure from a minidump through `std::_Mutex_base::lock` to the
host's older `MSVCP140`, identified the static CRT (`/MT`) as the correct fix
rather than shipping a redistributable, and renamed the five bare `require`
calls that CEP 11 rejects. The diagnosis was the hard part and it was right;
the merged change extends it rather than replacing it.

**[@Ghz114514](https://github.com/Ghz114514)** — MCP-compliant tool names
(`fe1a705`). Dotted verb names like `ae.ping` violate the MCP name pattern, so
strict clients rejected the whole tool list at handshake. Fixed without
breaking existing callers.

## Analysis and root cause

**[@msaworks](https://github.com/msaworks)** —
[#242](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/242),
`ae.previewFrame`. Separated two failures that shared one symptom: the handler
reported the composition's nominal size while `saveFrameToPng` honours the
viewer's resolution, and it accepted a PNG as complete on an 8-byte signature
while After Effects was still writing the file. Verified the first by decoding
the IHDR chunk directly, and demonstrated the second by showing `outFile.exists`
false immediately after the call. Wrote the reproduction as a stubbed backend
that fails against the old code and passes against the new — including the
negative assertion, so the test cannot pass vacuously.

**[@tomaszteee](https://github.com/tomaszteee)** —
[#243](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/243), Windows
v0.9.5 reliability. Five independent issues in one report, each separated into
confirmed runtime fact and hypothesis. Measured the collapsed composer through
live CEP DevTools rather than describing it (`582×8px`, with the row-by-row
arithmetic that explains it). Recognised that a timed-out ExtendScript call is
not a cancelled one, which is a correctness problem rather than the timeout
tuning issue it first resembles.

## Hardware validation

**[@tomaszteee](https://github.com/tomaszteee)** — carried the
[#239](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/239) workaround
through a real Windows install of After Effects 2026 and built a six-layer
composition end to end, which is what established that the main execution path
works and that everything else in that report was a separate problem.

## Adding to this file

Open a pull request, or say so on the issue and it will be added when the
related change lands. Analysis and hardware validation belong here as much as
code does — that is the point of the file.
