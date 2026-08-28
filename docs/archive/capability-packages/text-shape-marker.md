# Text and shape marker capability

> Archived 2026-08-28: this capability-package note is superseded by the ExtendScript-first public CEP host workflow.

Text and shape marker operations use the public CEP host MCP surface. Use
`ae_exec` for maintained scripting operations and `ae_nativeExec` only for a
primitive already present in the frozen native catalog.

The acceptance fixture must be disposable. Record the public request and
typed response, real After Effects state before and after, audit identifiers,
and independent Undo verification for writes. Do not add a new native surface
or a second packaging path for this capability.
