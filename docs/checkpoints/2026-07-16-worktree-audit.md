# Worktree and root-workspace audit — 2026-07-16

Issue: [#109](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/109)

Parent: [#61](https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/61)

Initial registered worktrees: **26**

This inventory was captured after #103 closed at `2532da2763d01a3e17c31c0db85f6e047bb77105`. Paths are normalized so the audit does not publish a developer account name. Removal means `git worktree remove` only after checking tracked dirt, unpushed commits, merged ancestry, associated Issue/PR, ignored build material, and rollback purpose. Branch refs are not deleted by this cleanup.

## Initial inventory and disposition

| Path | State at audit | Issue / purpose | Disposition |
| --- | --- | --- | --- |
| `<repo-root>` | dirty; branch `codex/macos-header-tools-release-design`; 4 unique commits | historical release-design work plus local user artifacts | retain, archive local artifacts losslessly, preserve branch ref, then return root to clean `main` |
| `<tmp>/ae-mcp-issue99-main-verify-1e6668a` | clean; detached; ancestor of `main` | #99 clean-main verification | remove-completed |
| `<tmp>/ae-mcp-main-101-final-e075a70` | clean; detached; ancestor of `main` | #101 clean-main verification | remove-completed |
| `<tmp>/ae-mcp-main-93-deploy` | clean; detached; ancestor of `main` | #93 deployment verification | remove-completed |
| `<tmp>/ae-mcp-main-94-final-6c890776` | clean; detached; ancestor of `main` | #94 clean-main verification | remove-completed |
| `<tmp>/ae-mcp-main-96-deploy` | clean; detached; ancestor of `main` | #96 deployment verification | remove-completed |
| `<tmp>/ae-mcp-main-p0-verify` | clean; detached; duplicate ancestor | historical P0 verification | remove-completed |
| `<tmp>/ae-mcp-rollback-29e7931` | clean; detached; one commit not in `main` | #73 rollback snapshot | retain and move to `<repo-root>/.worktrees/issue-73-rollback-29e7931` |
| `<repo-root>/.worktrees/issue-101-native-layer-properties` | clean; PR #102 merged | #101 implementation | remove-completed |
| `<repo-root>/.worktrees/issue-104-clean-main-2a166552` | clean; detached; ancestor | #104 clean-main verification | remove-completed |
| `<repo-root>/.worktrees/issue-104-native-composition-time` | clean; PR #105 merged | #104 implementation | remove-completed |
| `<repo-root>/.worktrees/issue-106-native-selected-layers` | clean; PR #107 merged | #106 implementation | remove-completed |
| `<repo-root>/.worktrees/issue-109-repo-governance` | active; branch `codex/issue-109-repo-governance` | #109 implementation | retain-active |
| `<repo-root>/.worktrees/issue-71-sdk-intake` | clean; PR #84 merged | #71 SDK intake | remove-completed |
| `<repo-root>/.worktrees/issue-72-native-rpc` | clean; PR #85 merged | #72 protocol | remove-completed |
| `<repo-root>/.worktrees/issue-73-native-plugin` | clean; PR #87 merged | #73 native plugin | remove-completed |
| `<repo-root>/.worktrees/issue-74-authenticated-ipc` | clean; PR #91 merged | #74 authenticated IPC | remove-completed |
| `<repo-root>/.worktrees/issue-75-native-core-backend` | clean; PR #92 merged | #75 Core backend | remove-completed |
| `<repo-root>/.worktrees/issue-76-public-native-read` | clean; PR #93 merged | #76 public read | remove-completed |
| `<repo-root>/.worktrees/issue-78-native-undoable-write` | clean; PR #94 squash-merged; six branch commits remain patch-distinct from `origin/main` | #78 public write history | retain branch worktree; deletion requires a separate explicit risk decision |
| `<repo-root>/.worktrees/issue-95-cep-scan-root` | clean; PR #96 merged | #95 CEP scan-root fix | remove-completed |
| `<repo-root>/.worktrees/issue-97-native-artifact-stage` | clean; PR #98 squash-merged; two branch commits remain patch-distinct from `origin/main` | #97 artifact staging history | retain branch worktree; deletion requires a separate explicit risk decision |
| `<repo-root>/.worktrees/issue-99-native-project-graph` | clean; PR #100 merged | #99 project graph | remove-completed |
| `<repo-root>/.worktrees/macos-provider-integration` | clean; PR #53 merged | macOS provider integration | remove-completed |
| `<repo-root>/.worktrees/platform-contracts` | retain-dirty; 2 unique commits; PR #52 closed unmerged | superseded platform contract history, four untracked alternates, SDD and build evidence | retain-dirty |
| `<repo-root>/.worktrees/post107-main-5261cea9d735` | clean; detached; ancestor | post-#107 clean-main verification | remove-completed |

## Preserved unique content

- Root branch `codex/macos-header-tools-release-design` remains as a branch ref. Its unique commits are not rewritten or deleted.
- The #73 rollback snapshot at `29e7931fc9b1243896c1ff473b7c7ceb61b68825` remains a registered worktree under the repository's ignored `.worktrees` directory.
- `<repo-root>/.worktrees/platform-contracts` remains untouched. It has two commits absent from `main`, four untracked `* 2` alternates, ignored `.superpowers/sdd` material, and ignored macOS helper build evidence.
- The clean #78 and #97 worktrees remain registered because squash merging preserved their product result but not their individual branch commits as `origin/main` ancestors. Their branch refs and working trees are retained instead of treating PR state alone as proof that no unique history exists.
- Root tracked dirt is archived as a patch before restoration. Disposable AEPs, autosaves, temporary JSX/Python helpers, and the obsolete smoke shell script are moved—not deleted—to `.local-workspace-archive/2026-07-16/root-pre-main/` with SHA-256 metadata.

## Versioned HEAD, upstream, and patch inventory

`main-only/branch-only` is `git rev-list --left-right --count origin/main...HEAD` at the `2532da2763d01a3e17c31c0db85f6e047bb77105` baseline. `patch + / -` is the count from `git cherry origin/main HEAD`; a plus is patch-distinct, while a minus has a patch-equivalent change on `origin/main`.

| Path | Exact HEAD at audit | Branch / upstream at audit | main-only / branch-only | patch + / - | Dirty state |
| --- | --- | --- | ---: | ---: | --- |
| `<repo-root>` | `036d45ff6bb63294696fbab227bcb7ddb7721cb1` | `codex/macos-header-tools-release-design`; no upstream | 14 / 5 | 4 / 0 | 1 tracked + 7 untracked |
| `<tmp>/ae-mcp-issue99-main-verify-1e6668a` | `1e6668a683eb08f4f6326b9ed76c5b704a7b7413` | detached | 4 / 0 | 0 / 0 | clean |
| `<tmp>/ae-mcp-main-101-final-e075a70` | `e075a70a5797aaee93d6f9a6b818144dba548484` | detached | 3 / 0 | 0 / 0 | clean |
| `<tmp>/ae-mcp-main-93-deploy` | `a7f7b2453fb62325d9a40ac22edbc05377882222` | detached | 8 / 0 | 0 / 0 | clean |
| `<tmp>/ae-mcp-main-94-final-6c890776` | `6c890776a24b901559e57de3b7b8822ba4fea3fe` | detached | 6 / 0 | 0 / 0 | clean |
| `<tmp>/ae-mcp-main-96-deploy` | `3c8204827fe546b4cc1a778934ac5ceea183c896` | detached | 7 / 0 | 0 / 0 | clean |
| `<tmp>/ae-mcp-main-p0-verify` | `a7f7b2453fb62325d9a40ac22edbc05377882222` | detached | 8 / 0 | 0 / 0 | clean |
| `<tmp>/ae-mcp-rollback-29e7931` | `29e7931fc9b1243896c1ff473b7c7ceb61b68825` | detached | 14 / 3 | 1 / 2 | clean |
| `<repo-root>/.worktrees/issue-101-native-layer-properties` | `e600e371033f026b0f538934a66ef147c7d188b1` | `origin/codex/issue-101-native-layer-properties`; 0 / 0 | 4 / 4 | 4 / 0 | clean |
| `<repo-root>/.worktrees/issue-104-clean-main-2a166552` | `2a166552c15f51b57e7ab662f61ae6cd7cfe4997` | detached | 2 / 0 | 0 / 0 | clean |
| `<repo-root>/.worktrees/issue-104-native-composition-time` | `88916f8b3186b354c8e7aa3f3bbef5d1b48f6fe7` | `origin/codex/issue-104-native-composition-time`; 0 / 0 | 3 / 1 | 0 / 1 | clean |
| `<repo-root>/.worktrees/issue-106-native-selected-layers` | `56e2ec348b1fa25d66739d790b6c3bf2886ca5bb` | `origin/codex/issue-106-native-selected-layers`; 0 / 0 | 2 / 4 | 4 / 0 | clean |
| `<repo-root>/.worktrees/issue-109-repo-governance` | `2532da2763d01a3e17c31c0db85f6e047bb77105` | new branch; no upstream | 0 / 0 | 0 / 0 | clean |
| `<repo-root>/.worktrees/issue-71-sdk-intake` | `8d0ce5865ce1509dfb0d372238be8dbae262e7a3` | `origin/codex/issue-71-sdk-intake`; 0 / 0 | 14 / 1 | 0 / 1 | clean |
| `<repo-root>/.worktrees/issue-72-native-rpc` | `f7f97218a3349e72c3305e33eba3bbcc48c730f6` | `origin/codex/issue-72-native-rpc-contract`; 0 / 0 | 13 / 1 | 0 / 1 | clean |
| `<repo-root>/.worktrees/issue-73-native-plugin` | `d31e3acb3038577dd2cf5d9ef5fb7cc9405bd7d4` | `origin/codex/issue-73-native-plugin-host`; 0 / 0 | 12 / 4 | 4 / 0 | clean |
| `<repo-root>/.worktrees/issue-74-authenticated-ipc` | `fb1ea7f476ab9f80fc76247406da58db90e0075f` | `origin/codex/issue-74-authenticated-ipc`; 0 / 0 | 11 / 2 | 2 / 0 | clean |
| `<repo-root>/.worktrees/issue-75-native-core-backend` | `a7e24f8bcf25c1e449493a3c0c4115c01b8a047f` | `origin/codex/issue-75-native-core-backend`; 0 / 0 | 10 / 1 | 0 / 1 | clean |
| `<repo-root>/.worktrees/issue-76-public-native-read` | `e49503ad2eecad2c996074c43e4422b93eb9b648` | `origin/codex/issue-76-public-native-read`; 0 / 0 | 9 / 1 | 0 / 1 | clean |
| `<repo-root>/.worktrees/issue-78-native-undoable-write` | `70c9cd9192cde1ae891e29cdb26fdfdb23d14374` | `origin/codex/issue-78-native-undoable-write`; 0 / 0 | 7 / 6 | 6 / 0 | clean |
| `<repo-root>/.worktrees/issue-95-cep-scan-root` | `b7d71b2d48012647ba72d4dec114849ab733a011` | `origin/codex/issue-95-cep-scan-root`; 0 / 0 | 8 / 1 | 0 / 1 | clean |
| `<repo-root>/.worktrees/issue-97-native-artifact-stage` | `7f52a841313b5c794efb92f7dfcf41e57451b0db` | `origin/codex/issue-97-native-artifact-stage`; 0 / 0 | 6 / 2 | 2 / 0 | clean |
| `<repo-root>/.worktrees/issue-99-native-project-graph` | `533eae65a24ecc235cee37994779edf5acfb54d3` | `origin/codex/issue-99-native-project-graph`; 0 / 0 | 5 / 1 | 0 / 1 | clean |
| `<repo-root>/.worktrees/macos-provider-integration` | `7afc85342ed9ddc95251b3df8c4205e82e0ae4fa` | upstream gone | 42 / 0 | 0 / 0 | clean |
| `<repo-root>/.worktrees/platform-contracts` | `c8393232d4c372a18c10f3afddc7c882f8d0a9c1` | upstream gone | 69 / 18 | 2 / 16 | 4 untracked |
| `<repo-root>/.worktrees/post107-main-5261cea9d735` | `5261cea9d735e2b043a4d331a9e80445663a0e26` | detached | 1 / 0 | 0 / 0 | clean |

### Retained dirty-file identity

The retained `platform-contracts` worktree was not modified. Its four untracked files at audit are:

| Relative path | SHA-256 |
| --- | --- |
| `docs/superpowers/plans/2026-07-10-tool-library 2.md` | `b83a0c40bd36a08f3740753fc1abff6f3064827dbf93d9fcb1e547b1268c4745` |
| `packages/core/ae_mcp/skill_store 2.py` | `14a7b3242150e1e20e2fdaaf97f0c77cf673d04cf8460c4df90a556a7fff278e` |
| `packages/core/tests/test_skill_store 2.py` | `85e17af64c71f6188153dbd5affa67d8ef829f8b27ce2a7eeb49514d9a36edfb` |
| `plugin/client/dist/app 2.js` | `74b8959381e575653363a0e6f301df708ded6e2a8cb429b72c8a5c9a1a7f1b7f` |

## Root artifact manifest before archival

| Source | Bytes | SHA-256 | Classification |
| --- | ---: | --- | --- |
| `AEMCP_P0_78_DISPOSABLE.aep` | 9427 | `5fe1aad13146ba540ae0d468bc8445d81ac476ad773aecc571f7bc7235589c55` | disposable AE fixture; archive |
| `Adobe After Effects 自动保存/AEMCP_P0_78_DISPOSABLE自动保存 1.aep` | 10533 | `b21651687ad3db670fe24ef61f6821839db2637cc58d266d30fab63cba886a83` | autosave; archive |
| `Adobe After Effects 自动保存/AEMCP_P0_78_DISPOSABLE自动保存 2.aep` | 10723 | `48b0971ea8c6c28d4202681aba2dbccf57b0d689a1b64e6ca3d2caf897c0923c` | autosave; archive |
| `scripts/create_timer_display.jsx` | 2604 | `3a85a7b6ad42d78e18ace0b3e50ab052c0713bc719cfef7d7fa2a2cd80f4c95b` | one-off JSX helper; archive |
| `scripts/run_timer_display.py` | 1749 | `c640607d871d6f0bafdf1b6e2f85aed6d10a855adfb6746b858709611b3d1663` | one-off direct `/exec` helper; archive |
| `scripts/smoke-test-macos.sh` | 5634 | `446d13fc1c9a45256f934b0d877abf9a67866aaacbf13dbd36a370d71999e2f7` | obsolete/manual smoke script; archive |
| `packages/core/ae_mcp/schemas.py` tracked diff | one-line change | recorded as patch | preserve local edit, then restore worktree file |

## Final retained registry

| Path | Required final state | Purpose |
| --- | --- | --- |
| `<repo-root>` | clean `main`, synchronized with `origin/main` | canonical integration checkout |
| `<repo-root>/.worktrees/platform-contracts` | retain-dirty | unmerged/superseded platform history and evidence |

While a branch is under review, the worktree invoking the check is the sole allowed addition to this final set. Candidate validation therefore accepts the active Issue worktree, while the post-merge check invoked from root `main` rejects it until it is removed. The local `--worktrees` governance check rejects all other live worktree drift and rejects dirty worktrees unless the final table explicitly gives their state as `retain-dirty`. CI runs the deterministic tracked-file contract; live worktree state remains a local closure gate because CI cannot see a developer machine's worktree registry.

## Cleanup execution record

- 20 completed or historical verification worktrees were removed from the Git registry after the pre-removal checks above. Branch refs were deliberately left intact.
- Two removals (#99 and macOS provider integration) unregistered correctly but could not remove directories containing ignored dependencies. The now-unregistered orphan directories were deleted only after confirming their `.git` pointers targeted absent registry entries and their branch refs remained preserved.
- Six worktrees remain registered during #109: root, active #109, #73 rollback, clean patch-distinct #78 history, clean patch-distinct #97 history, and dirty/unmerged `platform-contracts` history.
- Root artifacts were archived with matching post-move SHA-256 values. Root tracked dirt was restored only after its patch was written to the ignored archive.

## Post-#126 reconciliation — Issue #130

The #109 table above remains the immutable 26-worktree audit record. Issue #130 rechecked the live registry after the #124/#126 native capability closures and reconciled the machine gate with subsequent, separately authorized cleanup.

| Path before #130 cleanup | Exact HEAD | State and upstream | Issue / PR mapping | Disposition |
| --- | --- | --- | --- | --- |
| `<repo-root>` | `5ebb77b09f4990339852fcf17698184018c5d32f` | clean `main`; synchronized with `origin/main` | #126 / PR #129 clean-main acceptance source | retain |
| `<repo-root>/.worktrees/issue-124-native-apply-effect` | `4375ac0d966f48d04141e15b4e9829ce5402b541` | clean; upstream synchronized; branch tree is the current main feature minus the later #126 fix | #124 / PR #125 merged | remove completed worktree; retain branch ref |
| `<repo-root>/.worktrees/issue-126-effect-undo-identity` | `c9dcf064b6b0389296c3db640918029d3e159ce7` | clean; upstream synchronized; fully merged into `main` | #126 / PR #129 merged | remove completed worktree; retain branch ref |
| `<repo-root>/.worktrees/platform-contracts` | `c8393232d4c372a18c10f3afddc7c882f8d0a9c1` | retain-dirty; upstream gone; 18 branch-only commits and four untracked files | PR #52 closed unmerged and superseded by merged PR #53; Tool Library WIP excluded from #53 | retain unchanged |

The three historical worktrees that #109 initially retained (#73 rollback, #78 squash history, and #97 squash history) were later unregistered. Review of #130 found that the exact #73 rollback commit was still present only through reflog/object retention and was not reachable from the issue-73 branch. Before accepting the cleanup, #130 created the durable annotated tag `archive/rollback/issue-73-29e7931-20260716` at exact commit `29e7931fc9b1243896c1ff473b7c7ceb61b68825`; the local `--worktrees` gate now fails if that tag is absent or peels to another commit. The #78 and #97 commits remain reachable through their remote-tracking branches. Issue #130 does not delete or rewrite any of those refs.

The four `platform-contracts` untracked-file hashes still match the **Retained dirty-file identity** table exactly. Their corresponding tracked filenames are content-distinct: the Tool Library plan differs by 3 insertions/3 deletions, `skill_store 2.py` by 411 insertions/39 deletions, `test_skill_store 2.py` by 75 insertions/1 deletion, and `app 2.js` has a distinct binary hash. This WIP is not disposable.

The ignored root archive remains at `.local-workspace-archive/2026-07-16/root-pre-main/` with the fixture, two autosaves, three one-off scripts, the governance-source copy, the tracked `schemas.py` patch, and its manifest. No archived user content was deleted. After removing the two completed worktrees, the persistent live registry is exactly the clean root plus retained-dirty `platform-contracts`; the active #130 worktree is permitted only while this Issue is under review.
