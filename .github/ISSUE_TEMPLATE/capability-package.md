---
name: Capability or fix
about: Plan an ExtendScript-plane capability or a fix with a real-AE acceptance path
title: ""
labels: ""
assignees: ""
---

Read `docs/ARCHITECTURE_DIRECTION.md` first. The native AEGP plane is frozen (23 primitives, no new ones); the provider layer is the claude, codex, and opencode channels. New capability work runs on the ExtendScript plane and must prove a user-visible After Effects outcome through the public MCP surface. This Issue is the source of truth for scope and acceptance.

## Identity

- Priority: P0 (blocks use or masks failures) / P1 (data safety or security) / P2 (robustness, i18n, docs)
- User-visible outcome:
- Explicit non-goals:

## Public surface

- Public MCP tool(s) and request shape, exactly as a client sends them:
- Read or write:
- Postcondition a client can verify by reading AE state back:
- Undo model (writes):

## Executable acceptance path

```text
public MCP tool
  -> plugin/host/mcp handler
  -> /exec -> jsx-bridge -> ExtendScript
  -> After Effects state
  -> typed result
  -> audit evidence
```

- Public request(s):
- Read-state evidence:
- Write before/after evidence:
- Undo execution and verification:
- Recovery / uncertain-failure check:

## Test plan

- Unit and contract tests (`npm test` in `plugin/host` and `plugin/panel`, `node --test` for scripts):
- CI status on the candidate SHA:
- Real-AE check (After Effects version, platform, project bit depth):

## Exit conditions

- [ ] The public MCP call returns the typed result and the AE state agrees with it.
- [ ] Every write has executed and verified Undo.
- [ ] Review and CI pass on the exact candidate SHA.
- [ ] Docs (`docs/REFERENCE.md`, `docs/TOOL_LIBRARY.md`) and the `### Unreleased` changelog section are updated.

The historical native capability-package template is archived at `docs/archive/templates/capability-package-completion.md`.
