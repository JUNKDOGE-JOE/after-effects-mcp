# Worktree registry — 2026-08-20

> Archived 2026-08-28: this point-in-time worktree inventory is retained only as historical governance evidence.

This is the current sanitized registry used by the deterministic governance check. It records
path identity only; live worktree inspection remains a local closure gate.

Initial registered worktrees: **26**

## Initial inventory

| Path | Disposition |
| --- | --- |
| `<repo-root>` | retain |
| `<tmp>/ae-mcp-issue99-main-verify-1e6668a` | remove-completed |
| `<tmp>/ae-mcp-main-101-final-e075a70` | remove-completed |
| `<tmp>/ae-mcp-main-93-deploy` | remove-completed |
| `<tmp>/ae-mcp-main-94-final-6c890776` | remove-completed |
| `<tmp>/ae-mcp-main-96-deploy` | remove-completed |
| `<tmp>/ae-mcp-main-p0-verify` | remove-completed |
| `<tmp>/ae-mcp-rollback-29e7931` | archive-ref-preserved |
| `<repo-root>/.worktrees/issue-101-native-layer-properties` | remove-completed |
| `<repo-root>/.worktrees/issue-104-clean-main-2a166552` | remove-completed |
| `<repo-root>/.worktrees/issue-104-native-composition-time` | remove-completed |
| `<repo-root>/.worktrees/issue-106-native-selected-layers` | remove-completed |
| `<repo-root>/.worktrees/issue-109-repo-governance` | remove-completed |
| `<repo-root>/.worktrees/issue-71-sdk-intake` | remove-completed |
| `<repo-root>/.worktrees/issue-72-native-rpc` | remove-completed |
| `<repo-root>/.worktrees/issue-73-native-plugin` | remove-completed |
| `<repo-root>/.worktrees/issue-74-authenticated-ipc` | remove-completed |
| `<repo-root>/.worktrees/issue-75-native-core-backend` | remove-completed |
| `<repo-root>/.worktrees/issue-76-public-native-read` | remove-completed |
| `<repo-root>/.worktrees/issue-78-native-undoable-write` | retain-history |
| `<repo-root>/.worktrees/issue-95-cep-scan-root` | remove-completed |
| `<repo-root>/.worktrees/issue-97-native-artifact-stage` | retain-history |
| `<repo-root>/.worktrees/issue-99-native-project-graph` | remove-completed |
| `<repo-root>/.worktrees/macos-provider-integration` | remove-completed |
| `<repo-root>/.worktrees/platform-contracts` | retain-dirty |
| `<repo-root>/.worktrees/post107-main-5261cea9d735` | remove-completed |

## Final retained registry

| Path | Required final state | Purpose |
| --- | --- | --- |
| `<repo-root>` | clean integration checkout | canonical integration source |
| `<repo-root>/.worktrees/platform-contracts` | retain-dirty | unmerged platform history |

## Cleanup execution record

- Historical worktrees were removed only after their branch and archive identities were recorded.
- The active integration worktree is the only permitted temporary addition while its change is under review.
- The rollback archive ref remains checked by the governance script.
