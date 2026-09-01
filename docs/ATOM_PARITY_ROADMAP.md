# Product differentiation roadmap

The CEP-host migration is complete. The current public surface has 13 tools,
the Python bridge is retired, and the native AEGP plane is frozen at 23
primitives. New work is evaluated against observable After Effects outcomes,
not parity by tool count.

## Differentiators already delivered

- External MCP clients connect directly to `http://127.0.0.1:11488/mcp` or
  through the `ae-mcp-jkdg` stdio connector.
- Exact rational time and generation-bound locators remain available through
  the frozen `ae_nativeExec` plane.
- `ae_read` supplies structured project, comp, layer, property, keyframe, and
  comp-settings views; `ae_previewFrame` supplies range grids and A/B diffs.
- Tool Library now covers capture → replay → promote/save → export/import or
  bundled generation → `useCount`/`lastUsedAt` and funnel telemetry.
- History-redaction placeholders are rejected before dispatch, pointed to
  captured candidates, and stopped by a per-session circuit breaker.
- The Tools page is the single Tool Library management surface (#350,
  v0.10.5).
- `jsx-bridge` keeps its serialization lock across a timeout and drains the
  engine with a sentinel before releasing it (#260).

## Current focus

- Admit new ExtendScript capabilities only when a public MCP call can prove a
  user-visible AE outcome through typed response, state readback, audit, and
  Undo verification for writes.

No parity item may add a native primitive, revive the Python/package-server
plane, add a fourth provider adapter, or create a separate target-identity
stamp without a reproduced acceptance failure and an explicit scope decision.
