# 0.11.1 release preparation

Status: preparation only; **not release-accepted or published**.
The owner authorized publication on 2026-10-22, including reuse of unchanged
Windows and macOS native assets from v0.11.0. Publication remains conditional
on completing the packaged validation below.

## Merged scope

| Issue | PR | Merge commit | Changed behavior |
| --- | --- | --- | --- |
| #408 | #409 | 87193733a9a74b920eaf0b086ca3daa970cd218a | Valid primary AE PID, bounded discovery retry and in-panel retry |
| #406 (performance only) | #410 | 2c3b04e50a03ca8947c992ef75db718c719ecc92 | One index read per listing/collection, with artifact validation |
| #404 | #412 | 6f5c5de7f492878400ac41f9dd56f8bf9c24ca90 | Shared direct-MCP guidance for stdio and HTTP |
| #402 | #411 | 822b0e2fe3114805665022cbe61da9dc2542c0a2 | Native Codex image preview, zoom and history |

No new native primitive, provider, installer, update service, CI topology or
dependency upgrade is included. #406 remains open for retention controls and
recipe execution; those features are not part of this release preparation.

## Development evidence and packaged matrix

Integrated source: 63cf31b1babdacd0e5f45636f8843eda635e8187.
Merged main: 822b0e2fe3114805665022cbe61da9dc2542c0a2.
Both Git trees are b4a1fd7a159c82c95ef8059c84962e5cefd1d58e.
Independent review and all three PR CI checks passed before merge.
Full integrated local regression: 1,271 passed, 100 skipped, zero failed.

The Windows AE 26.5x89 / CEP 12.0.1 development session passed 13 cases with
73 public MCP calls and one real native Codex image generation. The native
component was unchanged 0.11.0. This is development evidence only:
validationProfile=development, candidateRun=false, candidateEvidence=false.

| Changed capability | Development result | Packaged T5 requirement |
| --- | --- | --- |
| PID discovery | Automatic recovery after two failures; retry in the same panel after three failures passed | Replay both paths |
| Project ownership | Panel close retains live ownership; reopen rejects old context; confirmed AE exit releases ownership | Replay close/reopen/exit with final payload |
| Tool Library | 200-candidate management listing and public candidate guidance passed | Verify listing, inspection and guidance |
| External MCP | Fresh-client edit/readback/preview/Undo, separate bindings and read-only rejection passed | Replay direct workflow and error boundaries |
| Images | Real Codex generation, inline display, zoom, history reopen and existing frame preview passed | Verify both image paths in final panel |
| Instance coexistence | Independent endpoints remained usable | Verify routing and fallback |

Native AE startup prompts may require user or Computer Use interaction.
Unattended startup is not a release promise. The earlier unattended registration
timeout remains an unpassed observation, not a retroactively passed test.

## Version preparation

Product host, panel, CEP manifest, native-client fallback and package default
advance to 0.11.1; the panel bundle is rebuilt. The native source tree is unchanged since v0.11.0. Per owner direction, reuse
the published Windows AEX and macOS arm64 plugin ZIP byte-for-byte, keeping
their 0.11.0 filenames, component versions and original signing properties.

The unchanged npm connector and MCP Registry remain 0.11.0. The documented
compatibility contract pairs product and connector by major.minor; no connector
publication is needed for these installed-extension fixes. Download links target the 0.11.1 release; unchanged native assets retain their
0.11.0 filenames.

## Preparation checks

- Rebuilt panel bundle matches source; all six version-consistency checks pass.
- Package/release/development contracts: 115 passed, 80 platform-gated skips,
  zero failures. The unsigned Windows payload passes the existing verifier
  with 718 files and pinned OpenCode 1.18.23. This is a staging directory,
  not a signed ZXP or an installed release candidate.
- Independent read-only diff review found no blocker in version preparation.
- Production npm audit reports four dependency entries: three moderate
  (qs and its body-parser/Express ancestors) and one critical (proxy-addr).
  Dependencies are unchanged by this PR. The critical
  [upstream advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h)
  requires a vulnerable trusted-proxy subnet configuration. The host creates
  Express without trust-proxy configuration, listens on 127.0.0.1 and does not
  use req.ip/req.ips for authorization; the reported exploit prerequisite is
  absent from the reviewed path. This is an applicability assessment, not a
  clean audit. The existing qs findings remain recorded in the 0.11.0
  preparation document. Reassess dependency disposition before publication;
  no dependency update or new security work is included here.

## Remaining release gates

- Review and commit version preparation; required CI must pass for the final source.
- Freeze the final clean source and build the named release artifacts using the
  existing release process and locked inputs. An unsigned stage is not a ZXP.
- Verify signatures, artifact identities and complete packaged payloads.
- Run aggregate packaged T5 for the matrix above, then T6 clean install,
  upgrade and rollback. Development evidence must not be relabeled as T5/T6.
- Publish the verified bytes without rebuilding or re-signing. Owner approval
  for tag, GitHub Release and asset upload was received on 2026-10-22.

Updates remain manual: replacing the AEX requires AE to restart, and the
plug-in process cannot guarantee continuation after its parent AE process exits.
No automatic updater is introduced.
