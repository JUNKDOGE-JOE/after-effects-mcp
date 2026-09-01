Read `docs/ARCHITECTURE_DIRECTION.md` and `docs/WORKFLOW.md` first. The native AEGP plane is frozen; new capability work runs on the ExtendScript plane (public MCP tool → host handler → `/exec` → `jsx-bridge` → After Effects → typed result → audit evidence). The linked Issue is the source of truth for scope and acceptance; do not copy it here.

Complete **Common** for every PR. Complete **Real-AE evidence** for any change that alters AE-facing behavior; for any other PR write one `N/A` line with the reason and the observable check you ran instead.

## Common

- Change type: ExtendScript capability / isolated fix / docs / infrastructure
- Issue:
- User-visible outcome:
- Scope and explicit non-goals:

Commands and results:

```text

```

Review findings and disposition (blocker / follow-up / out of scope):

## Real-AE evidence (conditional)

- Public MCP request(s) exercised, exactly as a client sends them:
- Read-state evidence, or before/after state for writes:
- Undo executed and verified (writes):
- Recovery / uncertain-failure check:
- After Effects version and platform:

The historical native capability-package process is archived at `docs/archive/CAPABILITY_PACKAGE_WORKFLOW.md`; do not open new native packages.
