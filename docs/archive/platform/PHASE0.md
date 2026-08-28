# Frozen native plane

> Archived 2026-08-28: this phase note is consolidated into `docs/ARCHITECTURE_DIRECTION.md` and `docs/WORKFLOW.md`.

The native AEGP plane is complete and frozen. Its checked-in `.aex` artifact
and generated protocol catalog remain part of the product; no new native
capability package or code-generation entry point is introduced here.

Before a native build, validate the developer-supplied Adobe SDK and protocol
inputs. The packaged ZXP does not embed native binaries. The `.aex` is a
separate artifact with its own build receipt and signature evidence.

Acceptance uses a public MCP call, real After Effects state, typed native
provenance, audit evidence, and independent Undo verification for writes.
