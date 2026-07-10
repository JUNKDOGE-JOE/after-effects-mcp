# Windows Codex development handoff — 2026-07-11

Use this prompt in a Codex task running on the Windows x64 verifier. The PR comment
template at the end is the required return channel.

```text
You are taking over only the Windows lane of ae-mcp. Work from the exact candidate
SHA supplied in the PR handoff comment. Do not modify or reinterpret the macOS XPC,
Keychain, caller-identity, xattr, Developer ID, or notarization implementation.
Do not restore Tool Library WIP or include unrelated changes.

Repository: JUNKDOGE-JOE/after-effects-mcp
Integration branch: codex/macos-provider-integration
Base branch: main

Goals:
1. Reproduce and repair the Windows CI contract failures on a Windows-native branch.
2. Verify the Windows x64 N-API -> Named Pipe Helper path.
3. Verify helper/addon/launcher Authenticode evidence object-by-object.
4. Run non-destructive panel smoke in real AE 25 and AE 26 when both are available.
5. Report results as one comment on the integration PR; do not merge the PR.

Required environment:
- Windows 11 x64 and a clean NTFS checkout.
- PowerShell Core 7.6 or newer (`pwsh`), Git, GitHub CLI, and Visual Studio Build
  Tools with the Windows SDK.
- Node 20 and exact Node 24.17.0.
- uv 0.11.7 and a resolvable Python 3.13 patch. Record if the exact 3.13.14
  standalone distribution is unavailable on Windows; do not silently substitute
  it in release locks.
- Installed AE 25 and AE 26 for the final smoke. Never dismiss a save prompt and
  never discard an existing project.

Start:
1. Fetch the integration PR and detach at the exact supplied 40-character SHA.
2. Require `git status --porcelain=v1 --untracked-files=all` to be empty.
3. Record `git rev-parse HEAD`, `node --version`, both Node executable paths,
   `$PSVersionTable`, `uv --version`, Windows build, and AE executable versions.
4. Create a Windows-only branch named `codex/windows-verification-<short-sha>`.

First reproduce the known CI failures without broad skips:
- `.github/workflows/ci.yml` pins `uv python install 3.13.14`, which previously had
  no Windows x64 download in uv's catalog.
- macOS installer/signing tests previously ran on Windows and failed with `EFTYPE`
  or POSIX-mode assumptions.
- test fixtures previously hard-coded `node/bin/node` rather than `node.exe`.
- the platform-leak allowlist previously compared forward-slash paths against
  Windows backslash paths.

Repair rules:
- Keep the release runtime lock at its audited exact version. A CI interpreter
  selector may use the resolvable `3.13` series only if tests prove the release lock
  is unchanged.
- Put macOS execution tests in a macOS job. Keep portable and Windows contracts in
  the Windows job; do not blanket-skip failing suites.
- Make fixtures produce `node.exe` and portable path comparisons on Windows.
- Do not weaken manifest hashes, architecture checks, signer thumbprint checks,
  RFC3161 timestamp requirements, or source/final-byte evidence binding.

Run at minimum under both Node 20 and Node 24.17.0:
- `node --test` in `plugin/host`.
- `node --test` in `plugin/panel`.
- `node --test scripts/package/test/*.test.mjs` from the repository root after
  platform-specific routing is repaired.
- `node --test scripts/release/test/*.test.mjs` from the repository root.
- `npm run build` in `plugin/panel`, followed by a clean diff check for
  `plugin/client/dist`.

Windows-native Helper/signing acceptance:
- Build the x64 addon and Named Pipe Helper from the exact candidate.
- Prove unauthorized clients return `HELPER_UNAUTHORIZED` with zero protected
  backend access.
- Exercise capabilities and Keychain-equivalent secret get/set/delete CAS through
  the real N-API transport; do not add HTTP secret routes or stdio fallbacks.
- On disposable fixtures, run `scripts/package/sign-windows-nested.ps1` in pwsh.
- For helper, addon, and launcher separately require
  `Get-AuthenticodeSignature.Status -eq 'Valid'`, the protected signer thumbprint,
  and a non-null `TimeStamperCertificate`. Confirm aggregate evidence is written
  only after all three objects pass.
- Do not print certificate secrets, tokens, provider headers, absolute user paths,
  or raw signer-tool output in the PR comment.

AE smoke is non-destructive:
- Open the extension in AE 25, then AE 26, sequentially.
- Verify panel startup, Host bridge, Helper capabilities, a disposable secret CAS
  round trip, and a provider request whose expected headers reach only the intended
  origin. Include a redirect target and prove it receives zero requests.
- Do not create, edit, save, close, or discard an AE project as part of the smoke.

Commit only focused Windows/portable fixes. Push the Windows branch, then post one
comment on the integration PR using the exact template below. PASS requires every
required row; otherwise report FAIL or BLOCKED with the first reproducible reason.
```

## Required PR comment

```markdown
<!-- ae-mcp-windows-development-handoff-v1 -->
## Windows Codex handoff

- Candidate SHA: `<40 hex>`
- Windows branch/commit: `<branch>` / `<40 hex>`
- Result: `PASS | FAIL | BLOCKED`
- Windows / PowerShell: `<versions>`
- Node 20 / Node 24.17.0: `<paths and versions>`
- Python / uv: `<versions and exact 3.13.14 availability>`
- AE 25 / AE 26: `<exact versions or explicit missing blocker>`

| Check | Result | Evidence |
|---|---|---|
| Windows CI reproduction and focused repair |  |  |
| Panel tests Node 20 / 24 |  |  |
| Host tests Node 20 / 24 |  |  |
| Packaging and release contracts |  |  |
| x64 N-API -> Named Pipe Helper |  |  |
| Unauthorized caller / zero backend access |  |  |
| Helper/addon/launcher Authenticode + RFC3161 |  |  |
| AE 25 non-destructive smoke |  |  |
| AE 26 non-destructive smoke |  |  |
| Redirect target received zero requests |  |  |

Changed files: `<focused list or none>`

Residuals/blockers: `<explicit list; no secrets or private paths>`
```

The formal post-merge RC verifier remains
`docs/WINDOWS_CODEX_RC_PROMPT.md`; do not use that final-attestation flow for this
pre-merge development handoff.
