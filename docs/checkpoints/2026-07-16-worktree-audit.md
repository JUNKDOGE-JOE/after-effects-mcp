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

## Final retained registry target

| Path | Required final state | Purpose |
| --- | --- | --- |
| `<repo-root>` | clean `main`, synchronized with `origin/main` | canonical integration checkout |
| `<repo-root>/.worktrees/issue-109-repo-governance` | clean while PR is active; remove after closure | #109 isolated delivery worktree |
| `<repo-root>/.worktrees/issue-73-rollback-29e7931` | clean detached snapshot | explicit #73 rollback evidence |
| `<repo-root>/.worktrees/issue-78-native-undoable-write` | clean | retained patch-distinct #78 squash-merge history |
| `<repo-root>/.worktrees/issue-97-native-artifact-stage` | clean | retained patch-distinct #97 squash-merge history |
| `<repo-root>/.worktrees/platform-contracts` | retain-dirty | unmerged/superseded platform history and evidence |

The local `--worktrees` governance check rejects undocumented live worktrees and rejects dirty worktrees unless this document explicitly marks their normalized path `retain-dirty`. CI runs the deterministic tracked-file contract; live worktree state remains a local closure gate because CI cannot see a developer machine's worktree registry.

## Cleanup execution record

- 20 completed or historical verification worktrees were removed from the Git registry after the pre-removal checks above. Branch refs were deliberately left intact.
- Two removals (#99 and macOS provider integration) unregistered correctly but could not remove directories containing ignored dependencies. The now-unregistered orphan directories were deleted only after confirming their `.git` pointers targeted absent registry entries and their branch refs remained preserved.
- Six worktrees remain registered during #109: root, active #109, #73 rollback, clean patch-distinct #78 history, clean patch-distinct #97 history, and dirty/unmerged `platform-contracts` history.
- Root artifacts were archived with matching post-move SHA-256 values. Root tracked dirt was restored only after its patch was written to the ignored archive.
