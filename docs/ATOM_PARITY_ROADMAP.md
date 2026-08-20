# Current parity roadmap

The panel-host migration is complete for the public MCP surface. New work is
planned on the CEP Node host and the frozen native AEGP plane.

## Current boundaries

- `plugin/host/mcp` owns public MCP handlers and generated native contracts.
- `plugin/host` owns `/mcp`, `/exec`, the stdio bridge, audit, and host logs.
- `plugin/panel` owns UI, approvals, client orchestration, and diagnostics.
- `plugin/shared` contains the two panel-shared attachment and approval modules.
- `native/ae-plugin` remains frozen and supplies exact time and generation
  locator primitives.

## Acceptance

Every new capability is tested through a public MCP call, real After Effects
state, typed provenance, audit evidence, postcondition verification, and Undo
verification for writes. Disposable fixtures are archived outside Adobe scan
roots after evidence extraction.
