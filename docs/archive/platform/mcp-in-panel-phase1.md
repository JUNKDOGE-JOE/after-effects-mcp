# CEP host MCP surface

> Archived 2026-08-28: the migration phase is complete; current endpoint and client behavior lives in `docs/REFERENCE.md` and `docs/WORKFLOW.md`.

The public MCP surface now runs in `plugin/host/mcp`. The host provides
`/mcp` for Streamable HTTP clients and `/exec` for the existing authenticated
CEP bridge. Both routes return structured errors and bounded audit data.

The panel uses the host for tools, skills, approvals, and diagnostics. The two
modules under `plugin/shared` remain the only shared panel modules. Claude
Code uses the URL transport; Claude Desktop uses the installed stdio shim
with system Node.

Native operations use the generated checked-in protocol catalog. A write must
include its operation key and Undo group, then perform an independent
readback. Potentially side-effecting failures are reconciled before retry.
