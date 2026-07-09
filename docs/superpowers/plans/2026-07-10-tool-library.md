# Tool Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete local Tool Library: versioned ToolArtifact storage, legacy skill compatibility, progressive MCP handlers, safe history candidates, hostile-safe .aemcptools import/export, hash-bound execution grants, and the Panel Tools UI with Claude/Codex/ZCode approval adapters.

**Architecture:** Python core owns canonical artifact validation, persistence, risk calculation, immutable execution plans, grants, archive isolation, and audit records. Legacy skills remain in their original SkillStore and appear through a virtual adapter, while the Panel uses only MCP handlers and relays core elicitation rather than making trust decisions from imported metadata. All execution follows prepare, grant, execute; core re-reads content and verifies every hash before touching After Effects.

**Tech Stack:** Python 3.10+, Pydantic 2, pytest/pytest-asyncio, stdlib pathlib/json/hashlib/zipfile/tempfile; React 18, CEP Node, Node test runner, Claude Agent SDK 0.3.174.

## Global Constraints

- Authoritative requirements are docs/superpowers/specs/2026-07-10-macos-header-tool-library-dual-release-design.md sections 7, 8.2, and 12.3.
- Product scope originates in https://github.com/JUNKDOGE-JOE/after-effects-mcp/issues/50; where the issue and design differ, the design's security, migration, import/export, and approval constraints govern.
- User artifacts live under ~/.ae-mcp/tools with schemaVersion 1, revision/CAS writes, same-directory atomic replacement, cross-process locking, and recoverable backups.
- Existing ~/.ae-mcp/skills and AE_MCP_SKILL_DIR remain canonical; first upgrade must not copy them into the native tools store.
- Native IDs use user:<uuid4>; user legacy IDs use legacy:<first-24-hex-of-canonical-path-sha256>; bundled IDs use builtin:skill:<skill-name>.
- Supported kinds are exactly jsx, expression, prompt-skill, recipe, and diagnostic.
- Supported statuses are exactly candidate, saved, pinned, archived, and deprecated; verified remains a separate property.
- Every integer timestamp and wire expiresAt value is Unix epoch milliseconds in UTC.
- candidate, archived, and deprecated artifacts cannot render, prepare, receive grants, or execute.
- ae.skillUse execute=false retains its existing response keys and rendering behavior.
- ae.skillUse execute=true must call the same prepare/risk/hash/grant engine as ae.toolUse and must never call Backend.exec directly.
- Risk is recalculated by core from kind, rendered content, arguments, target, recipe dependencies, and capability annotations. Imported or user-declared risk may raise but never lower calculated risk.
- The one-time grant binds the complete planHash. A session allowance binds artifactId, contentHash, operation, and normalizedTarget, then issues a fresh one-time plan-bound grant for each execution.
- readonly blocks every write/high-risk plan; manual asks for write/high risk; auto and none automatically grant local reversible writes; destructive/external always require explicit approval in manual, auto, and none.
- Clients without MCP elicitation may inspect and prepare, but cannot execute destructive/external artifacts.
- .aemcptools input is hostile: 10 MiB archive, 50 MiB expanded, 5 MiB per file, 512 entries, depth 8, compression ratio 100:1.
- Archive paths reject absolute paths, parent traversal, backslashes, drive/UNC paths, Unicode NFC + casefold collisions, links, devices, special files, encrypted entries, nested archives, duplicate entries, and undeclared files.
- Secret scanning runs before import persistence, diff display, logging, and export output. Scanner failure fails closed.
- Imported artifacts always become candidate with verified=false and no pinned state. Whole-package import cannot replace existing artifacts.
- Bundled trust comes from the signed manifest; content hashes prove identity only.
- Panel renders artifact content as React text nodes and never uses dangerouslySetInnerHTML.
- Tool Library feature commits immediately run Claude/Codex/ZCode approval adapter regressions.
- The implementation must preserve unrelated working-tree changes, especially the existing modification in packages/core/ae_mcp/schemas.py.

---
## Locked File Structure

### Python core files to create

- packages/core/ae_mcp/tool_artifact.py — artifact types, canonical JSON, IDs, schema validation, hashes.
- packages/core/ae_mcp/tool_secrets.py — scanner protocol, regex scanner, fail-closed errors.
- packages/core/ae_mcp/tool_store.py — native persistence, CAS, atomic writes, lock, backups.
- packages/core/ae_mcp/tool_legacy.py — legacy/bundled virtual artifacts and legacy-metadata.json.
- packages/core/ae_mcp/tool_migrations.py — v0.9 backup, schema marker, crash-safe resume/rollback.
- packages/core/ae_mcp/tool_audit.py — bounded redacted execution audit.
- packages/core/ae_mcp/tool_execution.py — rendering, risk, plans, session allowances, one-time grants, execution.
- packages/core/ae_mcp/tool_history.py — successful tool-call extraction into candidates.
- packages/core/ae_mcp/tool_archive.py — deterministic export and isolated hostile import.
- packages/core/ae_mcp/tool_service.py — shared composition root for stores, execution, packages, and handlers.
- packages/core/ae_mcp/handlers/tools.py — twelve Tool Library MCP handlers.
- packages/core/ae_mcp/jsx_templates/apply_expression.jsx — explicit expression target application.
- packages/core/ae_mcp/skills_bundled/manifest.json — signed-source manifest for the seven shipped skills.

### Python core files to modify

- packages/core/ae_mcp/skill_store.py
- packages/core/ae_mcp/handlers/skills.py
- packages/core/ae_mcp/handlers/__init__.py
- packages/core/ae_mcp/schemas.py
- packages/core/ae_mcp/annotations.py
- packages/core/ae_mcp/approval_gate.py
- packages/core/ae_mcp/server.py
- packages/core/ae_mcp/backends/base.py
- packages/core/ae_mcp/instructions.py

### Panel and sidecar files to create

- plugin/shared/tool-approval.mjs
- plugin/panel/src/cep/approvalTierFile.js
- plugin/panel/src/cep/toolsApi.js
- plugin/panel/src/cep/toolFileDialogs.js
- plugin/panel/src/lib/toolsState.js
- plugin/panel/src/lib/elicitationCoordinator.js
- plugin/panel/src/screens/ToolsScreen.jsx
- plugin/panel/src/components/tools/ToolArtifactRow.jsx
- plugin/panel/src/components/tools/ToolArtifactEditor.jsx
- plugin/panel/src/components/tools/ToolApprovalDialog.jsx
- plugin/panel/src/components/forms/Textarea.jsx

### Panel and sidecar files to modify

- plugin/panel/src/app/App.jsx
- plugin/panel/src/cep/mcpClient.js
- plugin/panel/src/lib/agentLoop.js
- plugin/panel/src/screens/ChatScreen.jsx
- plugin/panel/src/cep/codexBackend.js
- plugin/panel/src/cep/zcodeBackend.js
- plugin/panel/src/styles/index.css
- plugin/sidecar/lib.mjs
- plugin/sidecar/package.json
- plugin/sidecar/package-lock.json
- plugin/client/dist/app.js

---
## Locked Cross-Task Interfaces

These signatures are the handoff contract between tasks. A task may add private helpers, but it must not rename fields, change wire values, or broaden a dependency without updating every producing and consuming task in this plan.

- Type aliases are `ArtifactKind = Literal["jsx", "expression", "prompt-skill", "recipe", "diagnostic"]`, `ArtifactStatus = Literal["candidate", "saved", "pinned", "archived", "deprecated"]`, `ArtifactRisk = Literal["read", "write", "destructive", "external"]`, and `ArtifactOperation = Literal["render", "execute", "apply"]`.
- `jsx`, `expression`, and `prompt-skill` content is a UTF-8 string. `RecipeContent` is `{"steps": Sequence[RecipeStep]}` where each step is exactly `{"refType": "artifact" | "tool", "ref": str, "operation": "render" | "execute" | "apply" | "call", "args": Mapping[str, JsonValue], "target": Mapping[str, JsonValue]}`. `DiagnosticContent` is exactly `{"capability": str, "args": Mapping[str, JsonValue]}`. Therefore `ArtifactContent = str | RecipeContent | DiagnosticContent`; unknown content keys are rejected.
- `ToolSource` is a frozen dataclass with fields, in order: `type: Literal["user", "legacy", "bundled", "chat-tool-call", "imported"]`, `ref: str`, `client: str | None`, `product_version: str | None`, and `provenance: Mapping[str, JsonValue]`.
- `ToolVerification` is a frozen dataclass with `method: Literal["signed-manifest", "content-hash", "user-reviewed"]`, `verified_at: int`, and `evidence_hash: str | None`.
- `ToolArtifact` is a frozen dataclass with fields, in order: `id`, `name`, `description`, `kind`, `category`, `tags`, `compatibility`, `declared_risk`, `source`, `status`, `verified`, `verification`, `content`, `args_schema`, `content_hash`, `schema_version`, `revision`, `created_at`, `updated_at`, and `last_used_at`. Their types are respectively `str`, `str`, `str`, `ArtifactKind`, `str`, `tuple[str, ...]`, `Mapping[str, JsonValue]`, `ArtifactRisk`, `ToolSource`, `ArtifactStatus`, `bool`, `ToolVerification | None`, `ArtifactContent`, `Mapping[str, JsonValue]`, `str`, `int`, `int`, `int`, `int`, and `int | None`.
- `ToolArtifact.from_dict(data: Mapping[str, JsonValue], *, imported: bool = False) -> ToolArtifact` validates wire input, and `ToolArtifact.to_dict(*, include_content: bool = True, export_safe: bool = False) -> dict[str, JsonValue]` emits camelCase wire keys.
- `ToolArtifactDraft` is a frozen dataclass with fields, in order: `name: str`, `description: str`, `kind: ArtifactKind`, `category: str`, `tags: tuple[str, ...]`, `compatibility: Mapping[str, JsonValue]`, `declared_risk: ArtifactRisk`, `source: ToolSource`, `status: Literal["candidate", "saved"]`, `content: ArtifactContent`, and `args_schema: Mapping[str, JsonValue]`.
- `ToolSummary` is a frozen dataclass with fields, in order: `id: str`, `name: str`, `description: str`, `kind: ArtifactKind`, `category: str`, `tags: tuple[str, ...]`, `status: ArtifactStatus`, `verified: bool`, `declared_risk: ArtifactRisk`, `content_hash: str`, `revision: int`, `updated_at: int`, `last_used_at: int | None`, and `source_type: str`. It has no `content` field.
- `ToolArtifactStore` exposes exactly `list(*, kinds: AbstractSet[ArtifactKind] | None = None, statuses: AbstractSet[ArtifactStatus] | None = None, source_types: AbstractSet[str] | None = None, limit: int = 100) -> list[ToolSummary]`, `search(query: str, *, kinds: AbstractSet[ArtifactKind] | None = None, categories: AbstractSet[str] | None = None, tags: AbstractSet[str] | None = None, risks: AbstractSet[ArtifactRisk] | None = None, statuses: AbstractSet[ArtifactStatus] | None = None, source_types: AbstractSet[str] | None = None, offset: int = 0, limit: int = 50) -> tuple[list[ToolSummary], int]`, `find_by_content_hash(kind: ArtifactKind, content_hash: str, *, statuses: AbstractSet[ArtifactStatus] | None = None) -> list[ToolSummary]`, `get(artifact_id: str, *, include_content: bool = True) -> ToolArtifact`, `create(draft: ToolArtifactDraft, *, expected_store_revision: int | None = None) -> ToolArtifact`, `edit(artifact_id: str, patch: Mapping[str, JsonValue], *, expected_revision: int, expected_content_hash: str, replace_artifact_id: str | None = None) -> ToolArtifact`, `delete(artifact_id: str, *, expected_revision: int, expected_content_hash: str) -> None`, `archive(artifact_id: str, *, expected_revision: int, expected_content_hash: str) -> ToolArtifact`, `duplicate(artifact_id: str, *, name: str, expected_content_hash: str) -> ToolArtifact`, `promote_candidate(artifact_id: str, *, expected_revision: int, expected_content_hash: str) -> ToolArtifact`, `create_many_atomic(drafts: Sequence[ToolArtifactDraft], *, expected_store_revision: int) -> list[ToolArtifact]`, `store_revision() -> int`, and `subscribe(callback: Callable[[StoreMutation], None]) -> Callable[[], None]`.
- `ExecutionPlan` is a frozen dataclass with fields, in order: `artifact_id: str`, `content_hash: str`, `operation: ArtifactOperation`, `normalized_args: Mapping[str, JsonValue]`, `target: Mapping[str, JsonValue]`, `dependency_hashes: tuple[tuple[str, str], ...]`, `plan_hash: str`, `risk: ArtifactRisk`, and `expires_at: int`.
- `ExecutionGrant` is a frozen dataclass with `grant_id: str`, `plan_hash: str`, `scope: Literal["once", "session"]`, and `expires_at: int`. A session decision is stored separately as the SHA-256 key of canonical `{artifactId, contentHash, operation, normalizedTarget}` and always mints a fresh one-time `ExecutionGrant` for the concrete `plan_hash`.
- `ToolExecutionEngine` exposes exactly `render(artifact_id: str, args: Mapping[str, JsonValue]) -> Mapping[str, JsonValue]`, `prepare(artifact_id: str, *, operation: ArtifactOperation, args: Mapping[str, JsonValue], target: Mapping[str, JsonValue]) -> ExecutionPlan`, `request_grant(plan_hash: str, *, requested_scope: Literal["once", "session"], ctx: Any) -> Awaitable[ExecutionGrant]`, `execute(plan_hash: str, grant_id: str, *, ctx: Any) -> Awaitable[Mapping[str, JsonValue]]`, and `execute_legacy_skill(record: SkillRecord, *, args: Mapping[str, JsonValue], ctx: Any) -> Awaitable[Mapping[str, JsonValue]]`.
- The platform isolation contract is `private_temp_dir(*, prefix: str) -> ContextManager[Path]`; yielded directories are mode 0700 on macOS and protected by a current-user-only ACL on Windows.
- `ConflictResolution = Literal["keep", "duplicate"]`. `ImportConflict` is a frozen dataclass with `conflict_id: str`, `incoming_id: str`, `incoming_name: str`, `existing_id: str`, `incoming_content_hash: str`, and `existing_content_hash: str`. `ImportItemPreview` is a frozen dataclass with `summary: ToolSummary`, `existing_id: str | None`, `metadata_changes: Mapping[str, Mapping[str, JsonValue]]`, `content_changed: bool`, and `calculated_risk: ArtifactRisk`; each metadata change contains only `from` and `to`. `ImportPreview` is a frozen dataclass with `import_id: str`, `package_sha256: str`, `artifacts: tuple[ImportItemPreview]`, `conflicts: tuple[ImportConflict]`, `highest_risk: ArtifactRisk`, and `expires_at: int`. `PackageExport` is a frozen dataclass with `path: Path` and `package_sha256: str`.
- `ToolPackageManager` exposes exactly `preview_import(archive_path: Path) -> ImportPreview`, `commit_import(import_id: str, resolutions: Mapping[str, ConflictResolution]) -> list[ToolArtifact]`, `discard_import(import_id: str) -> None`, `export(artifact_ids: Sequence[str], destination: Path) -> PackageExport`, and `cleanup_expired() -> int`.
- `ToolLibraryService` is a frozen dataclass with `store: ToolArtifactStore`, `execution: ToolExecutionEngine`, and `packages: ToolPackageManager`. `default_tool_service() -> ToolLibraryService` returns the process singleton, and `reset_default_tool_service_for_tests() -> None` closes subscriptions and clears it.

The JavaScript handoffs are exact as well: plugin/shared/tool-approval.mjs exports `PLAN_SCHEMA_KEY`, `normalizeMcpToolName`, `isCoreAuthorizedDynamicCall`, `extractToolPlan`, `planSessionKey`, `decideToolPlan`, and `approvalResult`; `createElicitationCoordinator({ resolveApproval, presentGenericForm })` returns `handle(request, context)`, `snapshot()`, `subscribe(listener)`, `resolveVisible(result)`, and `dispose()`; and toolsState.js exports `INITIAL_TOOLS_STATE`, `reduceToolsState`, `searchArgsFromState`, `canEditArtifact`, `canExecuteArtifact`, `canPromoteArtifact`, and `displayArtifactContent`.

---
### Task 1: ToolArtifact schema, deterministic identity, and secret scanning

**Files:**

- Create: packages/core/ae_mcp/tool_artifact.py
- Create: packages/core/ae_mcp/tool_secrets.py
- Test: packages/core/tests/test_tool_artifact.py
- Test: packages/core/tests/test_tool_secrets.py

**Interfaces:**

- Produces ArtifactKind = Literal["jsx", "expression", "prompt-skill", "recipe", "diagnostic"].
- Produces ArtifactStatus = Literal["candidate", "saved", "pinned", "archived", "deprecated"].
- Produces ArtifactRisk = Literal["read", "write", "destructive", "external"].
- Produces ArtifactOperation = Literal["render", "execute", "apply"].
- Produces ToolSource, ToolVerification, ToolArtifact, ToolArtifactDraft, and ToolSummary frozen dataclasses.
- Produces canonical_json_bytes(value: JsonValue) -> bytes.
- Produces compute_content_hash(kind: ArtifactKind, content: ArtifactContent, args_schema: Mapping[str, JsonValue]) -> str.
- Produces new_user_artifact_id(uuid_value: UUID) -> str.
- Produces legacy_artifact_id(source_path: Path) -> str.
- Produces builtin_artifact_id(skill_name: str) -> str.
- Produces max_risk(*risks: ArtifactRisk) -> ArtifactRisk.
- Produces SecretScanner.scan_bytes(name: str, data: bytes) -> Sequence[SecretFinding].
- Produces SecretScanner.scan_json(name: str, value: JsonValue) -> Sequence[SecretFinding].
- Produces require_secret_free(scanner: SecretScanner, *, name: str, data: bytes) -> None.

- [ ] **Step 1: Write failing artifact model and scanner tests**

Create test_tool_artifact.py with these assertions:

```python
from pathlib import Path
from uuid import UUID

import pytest

from ae_mcp.tool_artifact import (
    ToolArtifact,
    builtin_artifact_id,
    canonical_json_bytes,
    compute_content_hash,
    legacy_artifact_id,
    max_risk,
    new_user_artifact_id,
)


def test_canonical_json_is_order_independent_and_rejects_nan():
    assert canonical_json_bytes({"b": 2, "a": 1}) == b'{"a":1,"b":2}'
    with pytest.raises(ValueError, match="finite"):
        canonical_json_bytes({"bad": float("nan")})


def test_content_hash_binds_kind_content_and_args_schema():
    base = compute_content_hash("jsx", "return 1;", {"x": {"type": "number"}})
    assert base == compute_content_hash(
        "jsx", "return 1;", {"x": {"type": "number"}}
    )
    assert base != compute_content_hash(
        "jsx", "return 2;", {"x": {"type": "number"}}
    )
    assert base != compute_content_hash(
        "jsx", "return 1;", {"x": {"type": "string"}}
    )


def test_namespaced_ids_are_stable_and_non_overlapping(tmp_path):
    source = tmp_path / "skills" / "same.json"
    assert new_user_artifact_id(
        UUID("12345678-1234-5678-1234-567812345678")
    ) == "user:12345678-1234-5678-1234-567812345678"
    assert legacy_artifact_id(source).startswith("legacy:")
    assert legacy_artifact_id(source) == legacy_artifact_id(source)
    assert builtin_artifact_id("same") == "builtin:skill:same"


def test_imported_trust_fields_are_reset():
    raw = {
        "schemaVersion": 1,
        "id": "user:12345678-1234-5678-1234-567812345678",
        "name": "Imported",
        "description": "",
        "kind": "jsx",
        "category": "workflow",
        "tags": [],
        "compatibility": {},
        "declaredRisk": "read",
        "source": {
            "type": "imported",
            "ref": "package:fixture",
            "client": None,
            "productVersion": None,
            "provenance": {},
        },
        "status": "pinned",
        "verified": True,
        "verification": {
            "method": "user-reviewed",
            "verifiedAt": 1,
            "evidenceHash": None,
        },
        "content": "return 1;",
        "argsSchema": {},
        "contentHash": compute_content_hash("jsx", "return 1;", {}),
        "revision": 1,
        "createdAt": 1,
        "updatedAt": 1,
        "lastUsedAt": None,
    }
    artifact = ToolArtifact.from_dict(raw, imported=True)
    assert artifact.status == "candidate"
    assert artifact.verified is False
    assert artifact.verification is None


def test_risk_order_can_only_raise():
    assert max_risk("read", "write") == "write"
    assert max_risk("write", "destructive") == "destructive"
    assert max_risk("external", "read") == "external"
```

Create test_tool_secrets.py with direct coverage for Authorization, x-api-key, Cookie, JWT, PEM private key, sk-prefixed keys, scanner exceptions, and clean ExtendScript.

- [ ] **Step 2: Run the focused tests and verify the red state**

Run:

```bash
uv run pytest packages/core/tests/test_tool_artifact.py packages/core/tests/test_tool_secrets.py -q
```

Expected: test collection exits non-zero with ModuleNotFoundError for ae_mcp.tool_artifact or ae_mcp.tool_secrets.

- [ ] **Step 3: Add the artifact dataclasses, canonical serialization, and scanner**

Implement ToolArtifact.from_dict so it:

1. rejects unknown schemaVersion;
2. validates the five kind-specific content shapes;
3. recomputes contentHash and rejects a mismatch;
4. resets imported status to candidate and clears verification;
5. requires verified artifacts to carry a verification record;
6. rejects unsupported status/risk/source values;
7. caps name at 128 characters, description at 4096, tags at 32 entries, and each tag at 64 characters.

Kind validation requires string content for jsx/expression/prompt-skill, the locked RecipeContent shape with 1-64 steps for recipe, and the locked DiagnosticContent shape for diagnostic. Recipe `call` is legal only with refType tool; the other operations are legal only with refType artifact. Creation rejects recursive ae.tool verbs, ae.exec, and ae.skillUse as recipe tool refs, rejects unknown handler names, and validates every tool-step args object against that handler's Pydantic schema.

Use this canonical hash body:

```python
def compute_content_hash(kind, content, args_schema):
    body = {
        "kind": kind,
        "content": content,
        "argsSchema": args_schema,
    }
    return hashlib.sha256(canonical_json_bytes(body)).hexdigest()
```

RegexSecretScanner must decode UTF-8 strictly, cap a single scan at 5 MiB, and return only finding type/file/line/column. It must never return matched secret text.

- [ ] **Step 4: Run focused tests and verify green**

Run:

```bash
uv run pytest packages/core/tests/test_tool_artifact.py packages/core/tests/test_tool_secrets.py -q
```

Expected: exit 0; every selected test passes with no warning containing a matched secret value.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/core/ae_mcp/tool_artifact.py packages/core/ae_mcp/tool_secrets.py packages/core/tests/test_tool_artifact.py packages/core/tests/test_tool_secrets.py
git commit -m "feat(core): define tool artifact schema and secret scanner"
```

---

### Task 2: CAS-safe native store, lock, backup, and migration marker

**Files:**

- Create: packages/core/ae_mcp/tool_store.py
- Create: packages/core/ae_mcp/tool_migrations.py
- Test: packages/core/tests/test_tool_store.py
- Test: packages/core/tests/test_tool_migrations.py

**Interfaces:**

- Consumes ToolArtifact, ToolArtifactDraft, ToolSummary, SecretScanner.
- Produces StoreLock(root: Path, *, timeout_sec: float = 5.0, stale_after_sec: float = 30.0).
- Produces ToolArtifactStore.list/search/find_by_content_hash/get/create/edit/delete/archive/duplicate/promote_candidate/create_many_atomic/subscribe.
- Produces ToolDataMigrator.migrate_from_v0_9() -> MigrationResult.
- Produces ToolDataMigrator.rollback(backup_id: str) -> None.
- Produces ToolDataMigrator.prune_backups(*, retain_count: int = 3, retain_days: int = 30) -> None.

- [ ] **Step 1: Write failing persistence and migration tests**

Create test_tool_store.py with:

```python
import json

import pytest

from ae_mcp.tool_artifact import ToolArtifactDraft, ToolSource
from ae_mcp.tool_store import ToolArtifactStore, ToolRevisionConflict


def draft(name="One", content="return 1;"):
    return ToolArtifactDraft(
        name=name,
        description="",
        kind="jsx",
        category="workflow",
        tags=(),
        compatibility={},
        declared_risk="write",
        source=ToolSource(
            type="user",
            ref="manual",
            client=None,
            product_version=None,
            provenance={},
        ),
        status="saved",
        content=content,
        args_schema={},
    )


def test_stale_revision_cannot_overwrite_newer_artifact(tmp_path):
    store = ToolArtifactStore(root=tmp_path / "tools")
    first = store.create(draft())
    second = store.edit(
        first.id,
        {"description": "new"},
        expected_revision=first.revision,
        expected_content_hash=first.content_hash,
    )
    with pytest.raises(ToolRevisionConflict):
        store.edit(
            first.id,
            {"description": "stale"},
            expected_revision=first.revision,
            expected_content_hash=first.content_hash,
        )
    assert store.get(first.id).description == second.description


def test_atomic_batch_failure_leaves_no_partial_artifacts(tmp_path, monkeypatch):
    store = ToolArtifactStore(root=tmp_path / "tools")
    before = store.store_revision()
    monkeypatch.setattr(store, "_replace_index", lambda path: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(OSError, match="boom"):
        store.create_many_atomic(
            [draft("One"), draft("Two")],
            expected_store_revision=before,
        )
    assert store.store_revision() == before
    assert store.list() == []


def test_index_and_search_never_return_content(tmp_path):
    store = ToolArtifactStore(root=tmp_path / "tools")
    store.create(draft(content="TOP SECRET BODY"))
    summary = store.search("One", limit=50)[0][0]
    assert not hasattr(summary, "content")
```

Create migration tests for empty v0.9 roots, existing skills without native duplication, after-backup/after-index/before-marker injected crashes, idempotent restart, rollback, and three-copy/30-day pruning.

- [ ] **Step 2: Run focused tests and verify the red state**

```bash
uv run pytest packages/core/tests/test_tool_store.py packages/core/tests/test_tool_migrations.py -q
```

Expected: collection exits non-zero because ToolArtifactStore and ToolDataMigrator do not exist.

- [ ] **Step 3: Implement the lock and disk layout**

Use exactly this layout:

```text
~/.ae-mcp/tools/
  index.json
  artifacts/
    <uuid>.json
  legacy-metadata.json
  audit.jsonl
  backups/
    <backup-id>/
      manifest.json
      index.json
      artifacts/
  migration-v1.json
  .store-lock/
    owner.json
```

StoreLock uses atomic mkdir for .store-lock. owner.json contains pid, hostname, createdAt, and a random nonce. Stale recovery may remove a lock only when age exceeds 30 seconds and either the owner host differs or the owner PID is not alive; it must re-read and compare the nonce immediately before removal.

Every mutation:

1. acquires StoreLock;
2. re-reads index.json;
3. checks store revision plus artifact revision/content hash;
4. scans new persisted content;
5. writes artifact and index temp files in the same directories;
6. fsyncs file contents;
7. atomically replaces artifact files and index;
8. fsyncs containing directories where the platform supports directory fsync;
9. publishes StoreMutation after commit.

- [ ] **Step 4: Implement first-upgrade backup and rollback**

ToolDataMigrator must scan existing skill/tool bytes before backup, write checksums into the backup manifest, create index.json and legacy-metadata.json without copying legacy skills into artifacts/, then atomically write migration-v1.json. A scanner failure or finding aborts before any new primary file is committed.

- [ ] **Step 5: Run focused tests and verify green**

```bash
uv run pytest packages/core/tests/test_tool_store.py packages/core/tests/test_tool_migrations.py -q
```

Expected: exit 0; CAS, lock recovery, fault injection, backup retention, restart, and rollback tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/core/ae_mcp/tool_store.py packages/core/ae_mcp/tool_migrations.py packages/core/tests/test_tool_store.py packages/core/tests/test_tool_migrations.py
git commit -m "feat(core): add CAS-safe tool storage and migration backups"
```

---
### Task 3: Legacy and bundled skills as virtual ToolArtifacts

**Files:**

- Modify: packages/core/ae_mcp/skill_store.py
- Create: packages/core/ae_mcp/tool_legacy.py
- Create: packages/core/ae_mcp/skills_bundled/manifest.json
- Modify: packages/core/tests/test_skill_store.py
- Test: packages/core/tests/test_tool_legacy.py

**Interfaces:**

- Consumes ToolArtifactStore and artifact hash helpers.
- Produces SkillRecord(skill: Skill, source: Literal["user", "bundled"], path: Path).
- Produces SkillStore.list_records(*, include_shadowed: bool = False) -> list[SkillRecord].
- Produces SkillStore.resolve(name: str) -> SkillRecord.
- Produces SkillStore.write_record(record: SkillRecord, skill: Skill, *, expected_content_hash: str) -> SkillRecord.
- Produces LegacyMetadataStore.get/compare_and_set with source path + content hash keys.
- Produces LegacySkillAdapter.list/get/edit/delete/duplicate.

- [ ] **Step 1: Write failing compatibility and namespace tests**

Add to test_skill_store.py:

```python
def test_list_records_preserves_old_resolution_and_can_show_shadowed(tmp_path):
    bundled = _bundled(tmp_path)
    user = tmp_path / "user"
    store = SkillStore(root=user, bundled_root=bundled)
    store.create(
        Skill(
            name="extendscript-cookbook",
            description="user",
            template_type="prompt",
            template="USER",
            args_schema={},
        )
    )
    assert store.load("extendscript-cookbook").template == "USER"
    visible = store.list_records()
    all_records = store.list_records(include_shadowed=True)
    assert len([r for r in visible if r.skill.name == "extendscript-cookbook"]) == 1
    assert {r.source for r in all_records if r.skill.name == "extendscript-cookbook"} == {
        "user",
        "bundled",
    }
```

Create test_tool_legacy.py with these cases:

- same-name user and bundled records produce different exact IDs;
- AE_MCP_SKILL_DIR is honored;
- legacy edit writes the original user JSON and does not create artifacts/ content;
- bundled edit/delete raises ToolReadOnly;
- bundled duplicate returns a native user draft;
- external file edit changes content hash, drops verified metadata, and invalidates old expected_content_hash;
- legacy-metadata.json CAS rejects stale revision;
- the old SkillStore list/load resolution order remains unchanged.

- [ ] **Step 2: Run focused tests and verify the red state**

```bash
uv run pytest packages/core/tests/test_skill_store.py packages/core/tests/test_tool_legacy.py -q
```

Expected: new tests fail because SkillRecord, list_records, and LegacySkillAdapter are absent.

- [ ] **Step 3: Extend SkillStore without changing old public behavior**

Implement list_records so include_shadowed=False returns the same merged set and order as list(). Implement include_shadowed=True as sorted bundled records followed by sorted user records without name-based collapse. resolve(name) must keep user-before-bundled lookup.

write_record must:

1. reject bundled records;
2. re-read the exact record path;
3. compare compute_content_hash against expected_content_hash;
4. write JSON through the same atomic writer used by ToolArtifactStore;
5. return a record pointing to the same canonical source path.

- [ ] **Step 4: Add the legacy adapter and signed bundled manifest**

Map template_type jsx to kind jsx and template_type prompt to kind prompt-skill. Default legacy metadata is category workflow, status saved, verified false.

Use this manifest shape and the fixed hashes from the approved baseline:

```json
{
  "schemaVersion": 1,
  "productVersion": "0.9.0",
  "artifacts": [
    {"path":"ease-and-timing.json","sha256":"2fad50c0f4692086dac92d9aae2503e64f25f54abe68f63ba752fe305e38868b"},
    {"path":"extendscript-cookbook.json","sha256":"097db4672538a38b6714256af1fd2af7a26cc378a081cb4c75dd8e111109295d"},
    {"path":"glow-recipes.json","sha256":"54b9632d802167a5ab53132122c8030ae037dac418abc97faa23a4cb7376c213"},
    {"path":"grade-stack.json","sha256":"846d728e9265d68a9449055bd866ec0c6baa74195ba55f59ed0f86e17b5f5056"},
    {"path":"kinetic-typography.json","sha256":"a910e02852952552bd003a4c8569cbe2f9210e6d12c56a144d77f1700559cdd5"},
    {"path":"project-organization.json","sha256":"c6c3dc680b16d77a4571a71a94cb55de4a8adf290f03596ee2215afef2c8fcd2"},
    {"path":"render-order.json","sha256":"4961a82cc6de3b3646394a41507258de02f7a352cf62f2a9fae289be1f7e82b3"}
  ]
}
```

The build/release task must regenerate and review these values when bundled content changes.

- [ ] **Step 5: Run focused tests and verify green**

```bash
uv run pytest packages/core/tests/test_skill_store.py packages/core/tests/test_tool_legacy.py -q
```

Expected: exit 0; old SkillStore tests and all namespace/sidecar/read-only tests pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add packages/core/ae_mcp/skill_store.py packages/core/ae_mcp/tool_legacy.py packages/core/ae_mcp/skills_bundled/manifest.json packages/core/tests/test_skill_store.py packages/core/tests/test_tool_legacy.py
git commit -m "feat(core): index legacy and bundled skills without copying"
```

---

### Task 4: Risk analysis, immutable plans, grants, expression application, and audit

**Files:**

- Create: packages/core/ae_mcp/tool_execution.py
- Create: packages/core/ae_mcp/tool_audit.py
- Create: packages/core/ae_mcp/jsx_templates/apply_expression.jsx
- Modify: packages/core/ae_mcp/approval_gate.py
- Test: packages/core/tests/test_tool_execution.py
- Test: packages/core/tests/test_tool_audit.py
- Modify: packages/core/tests/test_approval_gate.py

**Interfaces:**

- Consumes ToolArtifactStore, Backend, SecretScanner, handler registry, VERB_ANNOTATIONS.
- Produces ExecutionPlan with artifact_id, content_hash, operation, normalized_args, target, dependency_hashes, plan_hash, risk, expires_at.
- Produces ExecutionGrant with grant_id, plan_hash, scope, expires_at.
- Produces PreparedPlanStore.put/get/revoke_artifact.
- Produces GrantStore.issue_once/issue_from_session/allow_session/consume/revoke_artifact.
- Produces AuditRecord and ToolAuditLog.append/list. audit.jsonl rotates at 5 MiB, retains three 0600 generations, and never stores rendered content or matched secret values.
- Produces normalize_args, normalize_target, analyze_jsx, analyze_artifact_risk, and compute_plan_hash.
- Produces ToolExecutionEngine.render/prepare/request_grant/execute/execute_legacy_skill.
- Produces approval_gate.current_tool_tier/plan_decision/build_plan_elicitation_schema/authorize_plan.

- [ ] **Step 1: Write failing risk, grant, TOCTOU, and audit tests**

Create test_tool_execution.py with the complete matrix:

```python
import pytest

from ae_mcp.approval_gate import plan_decision


@pytest.mark.parametrize(
    ("tier", "risk", "expected"),
    [
        ("readonly", "read", "allow"),
        ("readonly", "write", "deny"),
        ("readonly", "destructive", "deny"),
        ("readonly", "external", "deny"),
        ("manual", "read", "allow"),
        ("manual", "write", "elicit"),
        ("manual", "destructive", "elicit"),
        ("manual", "external", "elicit"),
        ("auto", "read", "allow"),
        ("auto", "write", "allow"),
        ("auto", "destructive", "elicit"),
        ("auto", "external", "elicit"),
        ("none", "read", "allow"),
        ("none", "write", "allow"),
        ("none", "destructive", "elicit"),
        ("none", "external", "elicit"),
    ],
)
def test_tool_plan_matrix(tier, risk, expected):
    assert plan_decision(tier, risk) == expected
```

Add tests proving:

- all three blocked statuses fail before backend selection;
- arbitrary JSX defaults to write;
- File, Folder, Socket, system.callSystem, app.open, and importFile classify external;
- remove, purge, project close, eval, and Function classify destructive;
- expression render is read and expression apply is write;
- prompt-skill render returns an untrustedContext object and never calls a backend;
- diagnostic accepts only the explicit read-capability allowlist;
- recipe depth is at most 8, steps at most 64, cycles are rejected, and every child content hash enters planHash;
- recipe tool steps revalidate arguments against the current handler schema, take risk from current annotations, and bind a canonical hash of handler name/schema/annotations into dependency_hashes;
- declared risk raises but never lowers calculated risk;
- changing args, target, content, parameter schema, or recipe dependency changes planHash;
- one-time grant can be consumed once only;
- session allowance matches content hash, operation, and normalized target but not merely tool name;
- destructive/external never create a session allowance;
- editing an artifact revokes prepared plans, grants, allowances, and verified;
- execute re-reads and recomputes immediately before Backend.exec;
- a client without elicitation receives a structured denial for destructive/external;
- audit records contain IDs/hashes/backend/result but no secret values.
- audit records contain artifact/content/plan hashes, args/target hashes, redacted normalized args/target, grant ID/scope, backend, outcome, and timestamps; rotation retains at most three 5 MiB generations.

- [ ] **Step 2: Run focused tests and verify the red state**

```bash
uv run pytest packages/core/tests/test_tool_execution.py packages/core/tests/test_tool_audit.py packages/core/tests/test_approval_gate.py -q
```

Expected: new tests fail because execution plan and plan_decision symbols are absent.

- [ ] **Step 3: Implement normalization and risk analysis**

normalize_args supports object properties, required, additionalProperties=false, type, enum, default, minimum, maximum, minLength, and maxLength. Artifact creation rejects other schema keywords so execution never silently ignores validation rules.

normalize_target rules:

- jsx execute accepts an object and canonicalizes keys/finite numbers;
- expression apply requires compId as string or null, layerId as positive integer, and a non-empty path;
- prompt-skill render requires an empty target;
- diagnostic target is empty;
- recipe target is the canonical map supplied to child target substitutions.

Use these risk floors:

```python
_EXTERNAL_JSX = re.compile(
    r"\b(File|Folder|Socket|system\.callSystem|app\.open|importFile)\b"
)
_DESTRUCTIVE_JSX = re.compile(
    r"(\.remove\s*\(|\bpurge\s*\(|app\.project\.close\s*\(|"
    r"\beval\s*\(|\bFunction\s*\()"
)


def analyze_jsx(rendered: str) -> ArtifactRisk:
    if _EXTERNAL_JSX.search(rendered):
        return "external"
    if _DESTRUCTIVE_JSX.search(rendered):
        return "destructive"
    return "write"
```

Diagnostic allowlist is exactly:

```python
DIAGNOSTIC_CAPABILITIES = {
    "ae.overview",
    "ae.layers",
    "ae.ping",
    "ae.getTime",
    "ae.getProperties",
    "ae.scanPropertyTree",
    "ae.inspectPropertyCapabilities",
    "ae.getExpressions",
    "ae.validateExpressions",
    "ae.getKeyframes",
    "ae.searchProject",
}
```

- [ ] **Step 4: Implement prepared plans and grants**

Plan TTL is 300 seconds (300,000 milliseconds). One-time grant TTL is 60 seconds (60,000 milliseconds). Grant IDs are 32 random bytes encoded base64url without padding.

Session key is SHA-256 of canonical JSON containing only artifactId, contentHash, operation, and normalizedTarget. When a session allowance matches a new plan, issue a new one-time grant bound to that planHash.

build_plan_elicitation_schema returns:

```python
def build_plan_elicitation_schema(plan: ExecutionPlan) -> dict[str, object]:
    decisions = ["once", "deny"]
    if plan.risk == "write":
        decisions.insert(1, "session")
    return {
        "type": "object",
        "properties": {
            "decision": {
                "type": "string",
                "enum": decisions,
                "title": "Approval",
            }
        },
        "required": ["decision"],
        "additionalProperties": False,
        "x-ae-mcp-plan": plan.public_dict(),
    }
```

Use AE_MCP_TOOL_APPROVAL_TIER_FILE only for dynamic artifact plans. If it is absent or invalid, current_tool_tier returns manual.

- [ ] **Step 5: Implement kind execution and expression target template**

apply_expression.jsx must resolve comp, layer, and property through AEMCP helpers, set the expression text, and return JSON with ok, compId, layerId, and path. It must not accept arbitrary JSX.

Prompt render result:

```python
{
    "ok": True,
    "artifactId": artifact.id,
    "contentHash": artifact.content_hash,
    "trust": "user-untrusted",
    "untrustedContext": {
        "kind": artifact.kind,
        "content": rendered_text,
    },
}
```

Before executing, scan rendered content and normalized args; any finding denies execution. Append an audit record after success, denial, timeout, or backend failure.

- [ ] **Step 6: Run focused tests and verify green**

```bash
uv run pytest packages/core/tests/test_tool_execution.py packages/core/tests/test_tool_audit.py packages/core/tests/test_approval_gate.py -q
```

Expected: exit 0; all matrix, kind, hash-binding, session-scope, mutation invalidation, TOCTOU, and audit tests pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add packages/core/ae_mcp/tool_execution.py packages/core/ae_mcp/tool_audit.py packages/core/ae_mcp/jsx_templates/apply_expression.jsx packages/core/ae_mcp/approval_gate.py packages/core/tests/test_tool_execution.py packages/core/tests/test_tool_audit.py packages/core/tests/test_approval_gate.py
git commit -m "feat(core): enforce hash-bound tool execution grants"
```

---

### Task 5: Deterministic and hostile-safe .aemcptools import/export

**Files:**

- Create: packages/core/ae_mcp/tool_archive.py
- Test: packages/core/tests/test_tool_archive.py

**Interfaces:**

- Consumes ToolArtifactStore, ToolArtifact.from_dict(imported=True), SecretScanner.
- Consumes the platform contract private_temp_dir(*, prefix: str) -> ContextManager[Path], which creates 0700 directories on macOS and current-user-only ACL directories on Windows.
- Produces ImportConflict, ImportItemPreview, ImportPreview, ToolPackageManager.preview_import/commit_import/discard_import/export/cleanup_expired.
- ConflictResolution is exactly Literal["keep", "duplicate"].
- Import preview TTL is 15 minutes.

- [ ] **Step 1: Write failing round-trip and hostile ZIP tests**

Create test_tool_archive.py with a helper that writes arbitrary ZipInfo entries. Cover:

```python
@pytest.mark.parametrize(
    "entry_name",
    [
        "../escape.json",
        "/absolute.json",
        "C:/escape.json",
        "\\\\server\\share\\escape.json",
        "artifacts\\backslash.json",
    ],
)
def test_import_rejects_unsafe_cross_platform_paths(
    package_manager, tmp_path, entry_name
):
    package = build_zip(tmp_path / "bad.aemcptools", {entry_name: b"{}"})
    with pytest.raises(ToolPackageError):
        package_manager.preview_import(package)
    assert package_manager.store.list() == []


def test_unicode_casefold_collision_is_rejected(package_manager, tmp_path):
    package = build_zip(
        tmp_path / "collision.aemcptools",
        {
            "artifacts/Caf\u00e9.json": b"{}",
            "artifacts/CAFE\u0301.json": b"{}",
        },
    )
    with pytest.raises(ToolPackageError, match="cross-platform collision"):
        package_manager.preview_import(package)


def test_round_trip_is_byte_deterministic(package_manager, tmp_path, saved_artifact):
    first = tmp_path / "first.aemcptools"
    second = tmp_path / "second.aemcptools"
    package_manager.export([saved_artifact.id], first)
    package_manager.export([saved_artifact.id], second)
    assert first.read_bytes() == second.read_bytes()
```

Add cases for:

- encrypted flag;
- duplicate central-directory names;
- Unix symlink, hardlink-like Unix extra fields, character device, block device, FIFO, and socket modes;
- nested ZIP magic and archive extensions;
- undeclared root file;
- manifest referencing a missing file;
- unreferenced artifact file;
- 10 MiB archive, 50 MiB expanded, 5 MiB file, 512 entries, depth 8, and ratio 100 boundaries plus one-over-limit cases;
- unknown package schema;
- content hash tampering;
- secret scanner finding and scanner exception;
- export-safe serialization omitting absolute legacy paths, client identity, provider-shaped keys, and unapproved provenance;
- preview displaying only redacted finding type/location;
- imported pinned/verified reset to candidate/unverified;
- imported legacy:/builtin: namespace spoofing remapped to a fresh user ID while preserving originalArtifactId only as export-safe provenance;
- atomic commit fault leaving no candidates;
- conflict keep and duplicate;
- explicit rejection of replace during import;
- discard/expiry removing quarantine state.

- [ ] **Step 2: Run focused tests and verify the red state**

```bash
uv run pytest packages/core/tests/test_tool_archive.py -q
```

Expected: collection exits non-zero because ToolPackageManager is absent.

- [ ] **Step 3: Implement central-directory preflight before extraction**

Constants:

```python
MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
MAX_EXPANDED_BYTES = 50 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ENTRIES = 512
MAX_DEPTH = 8
MAX_COMPRESSION_RATIO = 100
PACKAGE_SCHEMA_VERSION = 1
```

For every ZipInfo:

1. reject flag_bits encryption;
2. reject every original backslash without rewriting it as a separator;
3. normalize with unicodedata.normalize("NFC", name).casefold();
4. reject empty/dot/dot-dot segments, absolute path, drive prefix, and UNC prefix;
5. reject depth greater than 8;
6. reject duplicate normalized path;
7. inspect Unix file type bits and link-bearing extra fields, permit only regular files/directories, and create each output with exclusive regular-file semantics so no member can materialize a hardlink;
8. reject file/aggregate/ratio limits from central-directory sizes;
9. require root manifest.json plus only manifest-referenced artifacts/ regular files.

Do not call ZipFile.extract. Open each member and stream it into a newly created regular file under the quarantine root after rechecking resolved containment.

- [ ] **Step 4: Scan before parse, diff, log, or persistence**

After central preflight, read each bounded member into bytes and call scanner.scan_bytes. If any finding exists, return a structured error containing only kind, archive-relative file, line, and column, then discard quarantine. Scanner exceptions are ToolPackageError with code SECRET_SCANNER_UNAVAILABLE.

Only after a clean scan may the code parse manifest/artifacts, compare content hashes, compute risk, or expose preview details.

- [ ] **Step 5: Implement deterministic export and atomic candidate commit**

manifest.json uses exactly `format`, `schemaVersion`, and `artifacts`. format is `ae-mcp-tools`; schemaVersion is 1; artifacts is sorted by `(id, contentHash)` and each entry uses exactly `id`, `path`, and `contentHash`. The path is `artifacts/<sha256-of-artifact-id>.json`, so no artifact ID is interpreted as a path. Each referenced artifact file is canonical JSON from export-safe serialization, and manifest/artifact objects reject unknown keys on import.

Use ToolArtifact.to_dict(export_safe=True), ZIP_STORED, sorted member names, UTF-8, DOS timestamp 1980-01-01 00:00:00, create_system=3, and external_attr for regular 0600 files. Export-safe source metadata contains source type, product version, original artifact ID, and content hash only; it omits client identity, absolute source refs, provider-shaped keys, and arbitrary provenance.

Export creates its same-directory temporary path with current-user-only permissions, scans every JSON byte sequence, writes and fsyncs the deterministic ZIP, then os.replace to out_path. A finding or exception removes the temporary path and leaves any prior out_path bytes unchanged; when no prior destination existed, out_path remains absent.

commit_import requires one resolution for every conflict. keep retains the existing artifact and skips that incoming artifact; duplicate assigns a fresh user ID to the incoming artifact. A non-conflicting incoming user UUID may be preserved, but every legacy:/builtin: ID is remapped to a fresh user ID so imported bytes cannot enter a trusted namespace. Both paths rebuild every accepted draft with source imported, status candidate, verified false, then call store.create_many_atomic. The package path never mutates an existing artifact, and any replace value is rejected before mutation.

- [ ] **Step 6: Run focused tests and verify green**

```bash
uv run pytest packages/core/tests/test_tool_archive.py -q
```

Expected: exit 0; deterministic round-trip and every malicious archive/scanner/conflict/atomicity case passes.

- [ ] **Step 7: Commit Task 5**

```bash
git add packages/core/ae_mcp/tool_archive.py packages/core/tests/test_tool_archive.py
git commit -m "feat(core): add hostile-safe aemcptools import and export"
```

---
### Task 6: Twelve MCP verbs and ae.skillUse compatibility

**Files:**

- Create: packages/core/ae_mcp/handlers/tools.py
- Create: packages/core/ae_mcp/tool_service.py
- Modify: packages/core/ae_mcp/handlers/skills.py
- Modify: packages/core/ae_mcp/handlers/__init__.py
- Modify: packages/core/ae_mcp/schemas.py
- Modify: packages/core/ae_mcp/annotations.py
- Modify: packages/core/ae_mcp/backends/base.py
- Modify: packages/core/ae_mcp/server.py
- Modify: packages/core/ae_mcp/instructions.py
- Test: packages/core/tests/test_handlers_tools.py
- Test: packages/core/tests/test_skill_tool_compat.py
- Modify: packages/core/tests/test_schemas.py
- Modify: packages/core/tests/test_annotations.py
- Modify: packages/core/tests/test_backend_base.py
- Modify: packages/core/tests/test_tool_names.py
- Modify: packages/core/tests/test_server_instructions.py

**Interfaces:**

- Consumes ToolArtifactStore, ToolExecutionEngine, and ToolPackageManager.
- Produces ToolLibraryService, default_tool_service, and reset_default_tool_service_for_tests using the locked cross-task signatures.
- Produces schemas AeToolIndexArgs, AeToolSearchArgs, AeToolInspectArgs, AeToolUseArgs, AeToolCreateArgs, AeToolEditArgs, AeToolDeleteArgs, AeToolArchiveArgs, AeToolDuplicateArgs, AeToolPromoteFromHistoryArgs, AeToolImportArgs, AeToolExportArgs.
- Registers ae.toolIndex, ae.toolSearch, ae.toolInspect, ae.toolUse, ae.toolCreate, ae.toolEdit, ae.toolDelete, ae.toolArchive, ae.toolDuplicate, ae.toolPromoteFromHistory, ae.toolImport, and ae.toolExport.
- Preserves the existing AeSkillUseArgs signature.

- [ ] **Step 1: Write failing schema, registration, progressive-output, and legacy tests**

Update the registry assertion from 32 to 44 and require exactly the twelve verbs above.

Create test_skill_tool_compat.py:

```python
import json
from types import SimpleNamespace

import pytest

from ae_mcp import schemas as S
from ae_mcp.handlers.skills import _run_skill_use
from ae_mcp.skill_store import Skill, SkillStore


@pytest.mark.asyncio
async def test_skill_use_execute_false_keeps_legacy_payload(monkeypatch, tmp_path):
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path / "skills"))
    SkillStore().create(
        Skill(
            name="render-only",
            description="",
            template_type="jsx",
            template="return 1;",
            args_schema={},
        )
    )
    assert await _run_skill_use(
        S.AeSkillUseArgs(name="render-only", execute=False),
        None,
    ) == {
        "ok": True,
        "name": "render-only",
        "template_type": "jsx",
        "rendered": "return 1;",
    }


@pytest.mark.asyncio
async def test_skill_use_execute_true_none_still_elicits_destructive_jsx(
    monkeypatch, tmp_path, mock_backend
):
    monkeypatch.setenv("AE_MCP_SKILL_DIR", str(tmp_path / "skills"))
    tier = tmp_path / "tier"
    tier.write_text("none\n", encoding="utf-8")
    monkeypatch.setenv("AE_MCP_TOOL_APPROVAL_TIER_FILE", str(tier))
    SkillStore().create(
        Skill(
            name="remove-layer",
            description="",
            template_type="jsx",
            template="app.project.activeItem.layer(1).remove();",
            args_schema={},
        )
    )
    session = FakeSession(action="decline")
    result = await _run_skill_use(
        S.AeSkillUseArgs(name="remove-layer", execute=True),
        SimpleNamespace(session=session, request_id="req-1"),
    )
    assert result["ok"] is False
    assert len(session.calls) == 1
    assert mock_backend.calls == []
    plan = session.calls[0]["requestedSchema"]["x-ae-mcp-plan"]
    assert plan["artifactId"].startswith("legacy:")
    assert plan["risk"] == "destructive"
```

FakeSession returns an object with action/content and records exact elicitation kwargs.

- [ ] **Step 2: Run focused tests and verify the red state**

```bash
uv run pytest packages/core/tests/test_handlers_tools.py packages/core/tests/test_skill_tool_compat.py packages/core/tests/test_schemas.py packages/core/tests/test_annotations.py packages/core/tests/test_backend_base.py packages/core/tests/test_tool_names.py -q
```

Expected: registry count/assertions fail, Tool schemas are missing, and execute=true still reaches Backend.exec without a plan.

- [ ] **Step 3: Compose the service, then add strict schemas and handler registration**

tool_service.py constructs the default ToolArtifactStore, scanner, ToolExecutionEngine, and ToolPackageManager from the same configured root and backend factory. Handlers obtain that singleton through default_tool_service; tests call reset_default_tool_service_for_tests so subscriptions, prepared plans, grants, quarantines, and cached roots cannot leak between cases.

AeToolUseArgs fields are optional artifact_id, action, operation, args, target, plan_hash, grant_id, and grant_scope. Add a model validator enforcing:

- render requires artifact_id, forbids plan_hash/grant_id, and defaults operation to render;
- prepare requires artifact_id plus operation and forbids plan_hash/grant_id;
- grant requires plan_hash plus grant_scope and forbids artifact_id/grant_id;
- execute requires plan_hash plus grant_id and forbids artifact_id/grant_scope.

Every schema uses `extra="forbid"`. Mutation schemas require expected_revision and expected_content_hash. AeToolEditArgs contains `artifact_id`, `changes`, `expected_revision`, `expected_content_hash`, and optional `replace_artifact_id`; changes may set editable metadata/content/args_schema/status plus `verification_action: Literal["mark-reviewed", "clear"]`. mark-reviewed writes method user-reviewed, current epoch milliseconds, and the current content hash as evidence; any content/args schema/recipe dependency edit clears it. A status change accepts only candidate to saved, saved to pinned, or pinned to saved; archive uses ae.toolArchive. replace_artifact_id is accepted only with candidate to saved after explicit confirmation and is forwarded to the store's atomic edit path. Import action preview requires path; commit/discard require import_id; export requires one to 512 artifact IDs and out_path.

Tool Index/Search return ToolSummary data only. Inspect returns `{"ok": true, "artifact": artifact.to_dict(), "trust": "signed-bundled" | "user-untrusted"}`; only a manifest-verified bundled artifact receives signed-bundled, and the response never promotes content into server instructions. Use dispatches exactly:

```python
if args.action == "render":
    return service.execution.render(args.artifact_id, args.args)
if args.action == "prepare":
    return service.execution.prepare(
        args.artifact_id,
        operation=args.operation,
        args=args.args,
        target=args.target,
    ).public_dict()
if args.action == "grant":
    grant = await service.execution.request_grant(
        args.plan_hash,
        requested_scope=args.grant_scope,
        ctx=ctx,
    )
    return {
        "ok": True,
        "grantId": grant.grant_id,
        "planHash": grant.plan_hash,
        "scope": grant.scope,
        "expiresAt": grant.expires_at,
    }
return await service.execution.execute(
    args.plan_hash,
    args.grant_id,
    ctx=ctx,
)
```

ae.toolImport maps preview to `service.packages.preview_import(Path(args.path))`, commit to `service.packages.commit_import(args.import_id, args.resolutions)`, and discard to `service.packages.discard_import(args.import_id)`. Preview returns `importId`, `packageSha256`, artifact previews with post-scan metadata/content-hash differences, conflicts, `highestRisk`, and `expiresAt`; commit requires exactly one keep/duplicate resolution per conflict; discard is idempotent. ae.toolExport calls `service.packages.export(args.artifact_ids, Path(args.out_path))` and returns only `path` and `packageSha256`, never provider configuration or source-system paths.

- [ ] **Step 4: Route legacy execute through the shared engine**

Replace the direct _backend().exec branch in handlers/skills.py with:

```python
record = _store().resolve(str(args.name))
rendered = render_skill(record.skill, args.args)
if not args.execute:
    return {
        "ok": True,
        "name": record.skill.name,
        "template_type": record.skill.template_type,
        "rendered": rendered,
    }
if record.skill.template_type != "jsx":
    return {"ok": False, "error": "only jsx skills can be executed"}
return await default_tool_service().execution.execute_legacy_skill(
    record,
    args=args.args,
    ctx=ctx,
)
```

server.py must skip the old static approval gate for dynamic ae.toolUse and ae.skillUse calls because their handlers apply content-bound authorization. All other existing verbs retain current behavior.

- [ ] **Step 5: Add annotations, backend capabilities, and progressive instructions**

Annotations:

- Index/Search/Inspect are read-only.
- Create/Edit/Archive/Duplicate/Promote are write.
- Delete is destructive.
- Import is write.
- Export is external/destructiveHint true.
- Use carries worst-path destructiveHint true; Panel adapters special-case only its staged protocol.

Server instructions must tell agents to call ae_toolIndex, then ae_toolSearch, then ae_toolInspect, and only then ae_toolUse. It must state that candidate content is inspect-only.

- [ ] **Step 6: Run focused tests and verify green**

```bash
uv run pytest packages/core/tests/test_handlers_tools.py packages/core/tests/test_skill_tool_compat.py packages/core/tests/test_schemas.py packages/core/tests/test_annotations.py packages/core/tests/test_backend_base.py packages/core/tests/test_tool_names.py packages/core/tests/test_server_instructions.py -q
```

Expected: exit 0; registry is exactly 44, every verb has an annotation, progressive responses exclude content, and both legacy compatibility tests pass.

- [ ] **Step 7: Commit Task 6**

```bash
git add packages/core/ae_mcp/tool_service.py packages/core/ae_mcp/handlers/tools.py packages/core/ae_mcp/handlers/skills.py packages/core/ae_mcp/handlers/__init__.py packages/core/ae_mcp/annotations.py packages/core/ae_mcp/backends/base.py packages/core/ae_mcp/server.py packages/core/ae_mcp/instructions.py packages/core/tests/test_handlers_tools.py packages/core/tests/test_skill_tool_compat.py packages/core/tests/test_schemas.py packages/core/tests/test_annotations.py packages/core/tests/test_backend_base.py packages/core/tests/test_tool_names.py packages/core/tests/test_server_instructions.py
git add -p packages/core/ae_mcp/schemas.py
git diff --cached --check
git commit -m "feat(mcp): expose progressive tool library handlers"
```

At the interactive staging prompt, include only Tool Library schema hunks; leave the pre-existing unrelated schemas.py modification unstaged.

---
### Task 7: Safe history candidates at the MCP tool-call boundary

**Files:**

- Create: packages/core/ae_mcp/tool_history.py
- Modify: packages/core/ae_mcp/server.py
- Test: packages/core/tests/test_tool_history.py

**Interfaces:**

- Consumes validated MCP arguments, final handler result, client_identity, ToolArtifactStore, and SecretScanner.
- Produces HistoryContext(client: str, request_id: str | None, created_at: int).
- Produces extract_history_draft(verb_name: str, arguments: Mapping[str, JsonValue], result: Any, context: HistoryContext) -> ToolArtifactDraft | None.
- Produces capture_history_candidate(*, store: ToolArtifactStore, scanner: SecretScanner, verb_name: str, arguments: Mapping[str, JsonValue], result: Any, context: HistoryContext) -> ToolArtifact | None.

- [ ] **Step 1: Write failing history candidate tests**

Create test_tool_history.py:

```python
from ae_mcp.tool_history import HistoryContext, capture_history_candidate


def test_successful_exec_creates_non_executable_candidate(store, scanner):
    artifact = capture_history_candidate(
        store=store,
        scanner=scanner,
        verb_name="ae.exec",
        arguments={
            "code": "app.project.activeItem.layers.addNull();",
            "undo_group_name": "Create control",
            "checkpoint_label": None,
            "timeout_sec": 30,
        },
        result={"ok": True},
        context=HistoryContext(
            client="panel-chat/0.9.0",
            request_id="req-1",
            created_at=1000,
        ),
    )
    assert artifact is not None
    assert artifact.status == "candidate"
    assert artifact.kind == "jsx"
    assert artifact.source.type == "chat-tool-call"
    assert artifact.source.client == "panel-chat/0.9.0"


def test_failed_exec_does_not_create_candidate(store, scanner):
    result = capture_history_candidate(
        store=store,
        scanner=scanner,
        verb_name="ae.exec",
        arguments={"code": "return 1;"},
        result={"ok": False, "error": "AE failed"},
        context=HistoryContext("client", "req-2", 1000),
    )
    assert result is None
    assert store.list(statuses={"candidate"}) == []


def test_secret_hit_does_not_persist_candidate(store, scanner):
    result = capture_history_candidate(
        store=store,
        scanner=scanner,
        verb_name="ae.exec",
        arguments={"code": 'var token = "Authorization: Bearer secret";'},
        result={"ok": True},
        context=HistoryContext("client", "req-3", 1000),
    )
    assert result is None
    assert store.list(statuses={"candidate"}) == []
```

Add server dispatch coverage proving capture runs only after successful handler output and capture exceptions do not alter the original CallToolResult.

- [ ] **Step 2: Run focused tests and verify the red state**

```bash
uv run pytest packages/core/tests/test_tool_history.py -q
```

Expected: collection exits non-zero because ae_mcp.tool_history does not exist.

- [ ] **Step 3: Implement conservative extraction**

Current extractors are:

- ae.exec: code becomes jsx candidate; undo_group_name becomes the candidate name when non-empty.
- any future validated argument containing a top-level expression or expression_text string becomes an expression candidate.
- ae.skillCreate and ae.skillEdit return None because their canonical copy already lives in SkillStore.
- all Tool Library verbs return None to prevent recursive candidate generation.
- failed, denied, timed-out, or protocol-error calls return None.

Deduplicate with store.find_by_content_hash(kind, contentHash, statuses={"candidate"}), not a bounded list page. A repeated match updates lastUsedAt and source provenance under CAS rather than adding an unbounded duplicate.

- [ ] **Step 4: Wire capture after handler success**

In server._call_tool, call capture_history_candidate after append_hint processing and before building CallToolResult. Use validated.model_dump(mode="json"), client_identity.get_client(), and str(ctx.request_id) when present.

Catch ToolStoreError and SecretScanError, log only exception class plus request ID, and return the original tool result unchanged.

- [ ] **Step 5: Run focused tests and verify green**

```bash
uv run pytest packages/core/tests/test_tool_history.py packages/core/tests/test_tool_names.py -q
```

Expected: exit 0; safe success capture, failure/secret suppression, deduplication, and dispatch isolation pass.

- [ ] **Step 6: Commit Task 7**

```bash
git add packages/core/ae_mcp/tool_history.py packages/core/ae_mcp/server.py packages/core/tests/test_tool_history.py
git commit -m "feat(core): capture safe tool-call history candidates"
```

---

### Task 8: Shared plan policy, approval tier file, and direct MCP elicitation

**Files:**

- Create: plugin/shared/tool-approval.mjs
- Create: plugin/panel/src/cep/approvalTierFile.js
- Create: plugin/panel/src/lib/elicitationCoordinator.js
- Modify: plugin/panel/src/cep/mcpClient.js
- Modify: plugin/panel/src/lib/agentLoop.js
- Test: plugin/panel/test/toolApproval.test.js
- Test: plugin/panel/test/approvalTierFile.test.js
- Test: plugin/panel/test/elicitationCoordinator.test.js
- Test: plugin/panel/test/mcpElicitation.test.js
- Modify: plugin/panel/test/mcpClient.test.js
- Modify: plugin/panel/test/agentLoop.test.js

**Interfaces:**

- Produces PLAN_SCHEMA_KEY = "x-ae-mcp-plan".
- Produces normalizeMcpToolName, isCoreAuthorizedDynamicCall, extractToolPlan, planSessionKey, decideToolPlan, approvalResult.
- Produces createApprovalTierFile and withToolApprovalTier. The returned tier service exposes path(), env(), write(tier), and dispose().
- Produces createElicitationCoordinator. The returned coordinator exposes handle(request, context), snapshot(), subscribe(listener), resolveVisible(result), and dispose().
- Extends _createRpc(stdinWrite, onLine, {timeoutMs, onRequest}) to answer server-initiated requests.
- Extends createMcpClient with onElicitation(request, {signal}) -> Promise<ElicitationResult>.

- [ ] **Step 1: Write failing shared-policy and direct elicitation tests**

Create toolApproval.test.js:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideToolPlan,
  extractToolPlan,
  isCoreAuthorizedDynamicCall,
  planSessionKey,
} from '../../shared/tool-approval.mjs';

const BASE = {
  artifactId: 'user:123',
  contentHash: 'a'.repeat(64),
  operation: 'execute',
  normalizedArgs: {},
  target: { compId: '7' },
  planHash: 'b'.repeat(64),
  risk: 'write',
  expiresAt: 9999999999999,
};

test('four tiers enforce the server minimum', () => {
  assert.equal(decideToolPlan({ tier: 'readonly', plan: BASE }).decision, 'deny');
  assert.equal(decideToolPlan({ tier: 'manual', plan: BASE }).decision, 'ask');
  assert.equal(decideToolPlan({ tier: 'auto', plan: BASE }).decision, 'allow');
  assert.equal(decideToolPlan({ tier: 'none', plan: BASE }).decision, 'allow');

  for (const tier of ['manual', 'auto', 'none']) {
    const high = decideToolPlan({
      tier,
      plan: Object.assign({}, BASE, { risk: 'external' }),
    });
    assert.equal(high.decision, 'ask');
    assert.equal(high.allowSession, false);
  }
});

test('session key binds hash operation and target rather than tool name', () => {
  assert.notEqual(
    planSessionKey(BASE),
    planSessionKey(Object.assign({}, BASE, {
      contentHash: 'c'.repeat(64),
    })),
  );
  assert.notEqual(
    planSessionKey(BASE),
    planSessionKey(Object.assign({}, BASE, {
      target: { compId: '8' },
    })),
  );
});

test('dynamic staged calls are delegated to core authorization', () => {
  assert.equal(isCoreAuthorizedDynamicCall(
    'mcp__ae__ae_toolUse',
    { action: 'grant', plan_hash: 'b'.repeat(64) },
  ), true);
  assert.equal(isCoreAuthorizedDynamicCall(
    'mcp__ae__ae_skillUse',
    { execute: true, name: 'legacy' },
  ), true);
  assert.equal(isCoreAuthorizedDynamicCall(
    'mcp__ae__ae_exec',
    { code: 'return 1;' },
  ), false);
});
```

Create mcpElicitation.test.js that sends a JSON-RPC elicitation/create request into _createRpc and verifies the exact JSON-RPC response. Add agentLoop coverage proving staged ae_toolUse and ae_skillUse reach core without adapter-level tool-name session caching.

- [ ] **Step 2: Run focused tests and verify the red state**

```bash
node --test plugin/panel/test/toolApproval.test.js plugin/panel/test/approvalTierFile.test.js plugin/panel/test/elicitationCoordinator.test.js plugin/panel/test/mcpElicitation.test.js plugin/panel/test/agentLoop.test.js
```

Expected: module-not-found failures for the new shared/panel modules and failing inbound-request assertions in mcpClient.

- [ ] **Step 3: Implement the shared policy**

Use exact return shape:

```javascript
export function decideToolPlan({ tier, plan, sessionAllowed = false }) {
  const risk = plan && plan.risk;
  if (!['read', 'write', 'destructive', 'external'].includes(risk)) {
    return { decision: 'deny', risk: 'unknown', allowSession: false, sessionKey: null };
  }
  const high = risk === 'destructive' || risk === 'external';
  if (risk === 'read') {
    return { decision: 'allow', risk, allowSession: false, sessionKey: null };
  }
  if (tier === 'readonly') {
    return { decision: 'deny', risk, allowSession: false, sessionKey: null };
  }
  if (sessionAllowed && risk === 'write') {
    return {
      decision: 'allow',
      risk,
      allowSession: true,
      sessionKey: planSessionKey(plan),
    };
  }
  if (high) {
    return { decision: 'ask', risk, allowSession: false, sessionKey: null };
  }
  if (tier === 'manual') {
    return {
      decision: 'ask',
      risk,
      allowSession: true,
      sessionKey: planSessionKey(plan),
    };
  }
  return { decision: 'allow', risk, allowSession: false, sessionKey: null };
}
```

extractToolPlan reads requestedSchema[PLAN_SCHEMA_KEY], requires a non-empty artifactId, lowercase 64-hex contentHash/planHash, a supported operation/risk, plain-object normalizedArgs/target, and expiresAt later than the current clock; it returns null on malformed or expired input. Malformed and expired plan elicitation is always declined. approvalResult maps deny to `{action:"decline", content:{}}`, once to `{action:"accept", content:{decision:"once"}}`, and session to `{action:"accept", content:{decision:"session"}}`; session input is rejected unless the policy marked allowSession true.

isCoreAuthorizedDynamicCall returns true only for:

- ae_toolUse actions render, prepare, grant, execute;
- ae_skillUse with execute boolean;
- dotted, underscore, and mcp__ae__ prefixed forms of those names.

- [ ] **Step 4: Implement the tier file**

TOOL_TIER_ENV is AE_MCP_TOOL_APPROVAL_TIER_FILE. createApprovalTierFile writes under ~/.ae-mcp/runtime/approval/panel-<pid>.tier with parent mode 0700 and file mode 0600. write validates one of readonly/manual/auto/none, writes a same-directory temporary file, fsyncs, and renames. dispose removes only its own file.

withToolApprovalTier returns a new command spec and merges:

```javascript
Object.assign({}, commandSpec, {
  env: Object.assign({}, commandSpec.env || {}, {
    AE_MCP_TOOL_APPROVAL_TIER_FILE: tierFile.path(),
  }),
})
```

- [ ] **Step 5: Handle inbound MCP elicitation**

_createRpc must distinguish:

- response: has id and no method;
- server request: has id and method;
- notification: has method and no id.

For elicitation/create, createMcpClient calls onElicitation with message, requestedSchema, mode, and server metadata, then responds with the callback result. Missing callback returns action decline. Unknown request responds JSON-RPC -32601. Abort/close resolves pending elicitation as cancel.

elicitationCoordinator allows exactly one visible pending request at a time, queues subsequent requests FIFO, and removes aborted entries without displaying them. snapshot returns the visible immutable record or null; subscribe returns an unsubscribe function; resolveVisible settles only the matching visible request and advances the queue; dispose cancels every pending request and clears listeners.

- [ ] **Step 6: Delegate dynamic calls from the BYOK agent loop**

In handleToolUse, call isCoreAuthorizedDynamicCall before checking static annotations or sessionAllowedTools. These calls go directly to executeTool because core performs the content-bound plan decision. Ordinary verbs retain existing behavior.

- [ ] **Step 7: Run focused tests and verify green**

```bash
node --test plugin/panel/test/toolApproval.test.js plugin/panel/test/approvalTierFile.test.js plugin/panel/test/elicitationCoordinator.test.js plugin/panel/test/mcpElicitation.test.js plugin/panel/test/mcpClient.test.js plugin/panel/test/agentLoop.test.js
```

Expected: exit 0; policy matrix, session keys, atomic tier writes, FIFO coordination, inbound JSON-RPC, and BYOK dynamic delegation pass.

- [ ] **Step 8: Commit Task 8**

```bash
git add plugin/shared/tool-approval.mjs plugin/panel/src/cep/approvalTierFile.js plugin/panel/src/lib/elicitationCoordinator.js plugin/panel/src/cep/mcpClient.js plugin/panel/src/lib/agentLoop.js plugin/panel/test/toolApproval.test.js plugin/panel/test/approvalTierFile.test.js plugin/panel/test/elicitationCoordinator.test.js plugin/panel/test/mcpElicitation.test.js plugin/panel/test/mcpClient.test.js plugin/panel/test/agentLoop.test.js
git commit -m "feat(panel): relay content-bound tool plan approvals"
```

---

### Task 9: Claude, Codex, and ZCode plan elicitation adapters

**Files:**

- Modify: plugin/sidecar/lib.mjs
- Modify: plugin/sidecar/test/sidecar.test.js
- Modify: plugin/sidecar/package.json
- Modify: plugin/sidecar/package-lock.json
- Modify: plugin/panel/src/cep/codexBackend.js
- Modify: plugin/panel/test/codexBackend.test.js
- Modify: plugin/panel/src/cep/zcodeBackend.js
- Modify: plugin/panel/test/zcodeBackend.test.js
- Modify: plugin/panel/src/screens/ChatScreen.jsx
- Modify: plugin/panel/test/chatEntries.test.js

**Interfaces:**

- Consumes extractToolPlan, decideToolPlan, planSessionKey, approvalResult, and isCoreAuthorizedDynamicCall from plugin/shared/tool-approval.mjs.
- Claude consumes Agent SDK onElicitation(request, {signal}) and returns {action, content}.
- Codex consumes mcpServer/elicitation/request and responds {action, content}.
- ZCode consumes elicitation/create and responds {action, content}.
- Approval events retain type, toolUseId, name, input, and risk; risk now permits external.

- [ ] **Step 1: Add failing high-risk-none and session-binding tests to all three adapters**

Claude sidecar test:

```javascript
test('Claude none tier still asks for an external artifact plan', async () => {
  const writes = [];
  let pendingElicitation;
  const sidecar = createSidecar({
    queryFn: async function * ({ options }) {
      pendingElicitation = options.onElicitation({
        serverName: 'ae',
        message: 'Approve external artifact?',
        requestedSchema: {
          type: 'object',
          'x-ae-mcp-plan': EXTERNAL_PLAN,
        },
      }, { signal: new AbortController().signal });
      await pendingElicitation;
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'sess-1',
      };
    },
    writeLine: (obj) => writes.push(obj),
    argvOptions: defaultOptions,
    env: {},
  });
  sidecar.handleLine(JSON.stringify({
    t: 'user',
    text: 'run it',
    permissionMode: 'none',
  }));
  await waitFor(() => eventCount(writes, 'approval-required') === 1);
  const approval = lastEvent(writes);
  assert.equal(approval.risk, 'external');
  sidecar.handleLine(JSON.stringify({
    t: 'approve',
    id: approval.toolUseId,
    decision: 'allow',
  }));
  assert.deepEqual(await pendingElicitation, {
    action: 'accept',
    content: { decision: 'once' },
  });
});
```

Codex test sends mcpServer/elicitation/request with requestedSchema containing x-ae-mcp-plan and asserts no automatic accept in none.

ZCode test sends elicitation/create with the same schema and asserts no automatic accept in none.

For each backend add:

- auto write returns accept + decision once without a card;
- manual write card allows allow-session and returns decision session;
- destructive/external card does not expose allow-session;
- changing contentHash or target prevents prior session allowance;
- initial ae_toolUse staged call is allowed to reach core and is not cached by tool name;
- malformed plan schema is declined.

- [ ] **Step 2: Run the three backend tests and verify the red state**

```bash
node --test plugin/sidecar/test/sidecar.test.js plugin/panel/test/codexBackend.test.js plugin/panel/test/zcodeBackend.test.js
```

Expected: Claude lacks options.onElicitation, while Codex and ZCode incorrectly auto-accept high-risk elicitation in none mode.

- [ ] **Step 3: Implement Claude Agent SDK onElicitation**

Pin @anthropic-ai/claude-agent-sdk to exact version 0.3.174 in package.json and the root lockfile dependency entry; the resolved package and platform packages are already 0.3.174. Add pendingElicitations and sessionAllowedPlans maps alongside existing tool approvals. buildTurnOptions adds:

```javascript
onElicitation: async (request, { signal }) => {
  const plan = extractToolPlan(request.requestedSchema);
  if (!plan) return { action: 'decline' };
  const key = planSessionKey(plan);
  const policy = decideToolPlan({
    tier: turn.permissionMode,
    plan,
    sessionAllowed: sessionAllowedPlans.has(key),
  });
  if (policy.decision === 'allow') {
    return { action: 'accept', content: { decision: 'once' } };
  }
  if (policy.decision === 'deny') return { action: 'decline' };
  return await waitForElicitationApproval(request, plan, policy, signal);
},
```

waitForElicitationApproval emits name mcp__ae__ae_toolUse, input equal to the public plan, and risk equal to the plan risk. allow-session stores planSessionKey only when policy.allowSession is true. stop/error drains both tool approvals and elicitation approvals.

canUseTool delegates staged dynamic calls directly to core before name-level sessionAllowedTools.

- [ ] **Step 4: Implement Codex plan-first request handling**

In handleRequest, inspect requestedSchema before parsing a normal static tool request. When a valid plan exists, use decideToolPlan and a separate pending approval record with kind tool-plan, plan, and allowSession.

approve responds:

- deny: {action:"decline", content:{}}
- allow: {action:"accept", content:{decision:"once"}}
- allow-session for write: {action:"accept", content:{decision:"session"}}

Normal Codex tool approvals retain their current response and tool-name session behavior; plan approvals never enter sessionAllowedTools.

- [ ] **Step 5: Implement ZCode plan-first elicitation handling**

At the start of handleElicitation, extract a plan. If present, do not run AskUserQuestion enum/default logic. Apply the same decisions and store plan-specific pending data. approve returns the same decision content as Claude/Codex.

In handlePermissionRequest, isCoreAuthorizedDynamicCall causes only the initial staged MCP call to be allowed; the core plan elicitation remains authoritative.

- [ ] **Step 6: Render external as high risk**

In ChatScreen:

```javascript
const highRisk = entry.risk === 'destructive' || entry.risk === 'external';
```

ApprovalCard receives no onAllowSession for either high-risk value.

- [ ] **Step 7: Run all three backend approval regressions**

```bash
node --test plugin/sidecar/test/sidecar.test.js plugin/panel/test/codexBackend.test.js plugin/panel/test/zcodeBackend.test.js plugin/panel/test/chatEntries.test.js
```

Expected: exit 0; Claude/Codex/ZCode all enforce the same four-tier matrix and hash/operation/target session scope.

- [ ] **Step 8: Commit Task 9**

```bash
git add plugin/sidecar/lib.mjs plugin/sidecar/test/sidecar.test.js plugin/sidecar/package.json plugin/sidecar/package-lock.json plugin/panel/src/cep/codexBackend.js plugin/panel/test/codexBackend.test.js plugin/panel/src/cep/zcodeBackend.js plugin/panel/test/zcodeBackend.test.js plugin/panel/src/screens/ChatScreen.jsx plugin/panel/test/chatEntries.test.js
git commit -m "fix(panel): enforce tool plan approvals across three backends"
```

---
### Task 10: Panel Tools API, state model, file dialogs, and Tools screen

**Files:**

- Create: plugin/panel/src/cep/toolsApi.js
- Create: plugin/panel/src/cep/toolFileDialogs.js
- Create: plugin/panel/src/lib/toolsState.js
- Create: plugin/panel/src/screens/ToolsScreen.jsx
- Create: plugin/panel/src/components/tools/ToolArtifactRow.jsx
- Create: plugin/panel/src/components/tools/ToolArtifactEditor.jsx
- Create: plugin/panel/src/components/tools/ToolApprovalDialog.jsx
- Create: plugin/panel/src/components/forms/Textarea.jsx
- Modify: plugin/panel/src/app/App.jsx
- Modify: plugin/panel/src/styles/index.css
- Test: plugin/panel/test/toolsApi.test.js
- Test: plugin/panel/test/toolFileDialogs.test.js
- Test: plugin/panel/test/toolsState.test.js
- Modify: plugin/panel/test/mcpClient.test.js

**Interfaces:**

- Produces parseMcpPayload(result) -> object.
- Produces createToolsApi(mcp) with index/search/inspect/create/edit/delete/archive/duplicate/promoteFromHistory/use/previewImport/commitImport/discardImport/exportPackage.
- Produces chooseToolPackage and chooseToolExportPath.
- Produces INITIAL_TOOLS_STATE, reduceToolsState, searchArgsFromState, canEditArtifact, canExecuteArtifact, canPromoteArtifact, displayArtifactContent.
- Produces ToolsScreen, ToolArtifactRow, ToolArtifactEditor, ToolApprovalDialog, and Textarea components.
- Consumes createApprovalTierFile, withToolApprovalTier, createElicitationCoordinator, createMcpClient, and copyText.

- [ ] **Step 1: Write failing API, state, and dialog tests**

Create toolsApi.test.js with an MCP fake that records exact exposed underscore names:

```javascript
test('Tools API uses progressive calls and preserves MCP errors', async () => {
  const calls = [];
  const mcp = {
    async callTool(name, args) {
      calls.push({ name, args });
      return {
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      };
    },
  };
  const api = createToolsApi(mcp);
  await api.index({ include_candidates: true });
  await api.search({ query: 'wiggle' });
  await api.inspect('user:1');
  assert.deepEqual(calls.map((call) => call.name), [
    'ae_toolIndex',
    'ae_toolSearch',
    'ae_toolInspect',
  ]);
});
```

Create toolsState.test.js covering:

- initial filters exclude candidate/archived/deprecated;
- selecting a summary does not invent content;
- inspect success installs payload.artifact as full content and retains payload.trust;
- pinned/verified/status/source/risk sort/filter behavior;
- bundled cannot edit/delete but can duplicate;
- legacy user can edit/delete;
- candidate cannot execute and can promote;
- archived/deprecated cannot execute;
- stale revision errors preserve the editor draft and request refresh;
- displayArtifactContent returns plain text for strings and formatted JSON for recipe/diagnostic.

Create toolFileDialogs.test.js with injected CEP fs fakes for cancel, one selected .aemcptools file, rejected extension, and export path extension normalization.

- [ ] **Step 2: Run focused tests and verify the red state**

```bash
node --test plugin/panel/test/toolsApi.test.js plugin/panel/test/toolFileDialogs.test.js plugin/panel/test/toolsState.test.js
```

Expected: module-not-found failures for toolsApi, toolFileDialogs, and toolsState.

- [ ] **Step 3: Implement the MCP API wrapper**

parseMcpPayload joins text content, parses JSON, and throws an Error with payload.error when result.isError or payload.ok is false.

createToolsApi maps:

```javascript
export function createToolsApi(mcp) {
  const call = async (name, args) => parseMcpPayload(
    await mcp.callTool(name, args),
  );
  return {
    index: (args = {}) => call('ae_toolIndex', args),
    search: (args = {}) => call('ae_toolSearch', args),
    inspect: (artifactId) => call(
      'ae_toolInspect',
      { artifact_id: artifactId },
    ),
    create: (input) => call('ae_toolCreate', input),
    edit: (input) => call('ae_toolEdit', input),
    delete: (input) => call('ae_toolDelete', input),
    archive: (input) => call('ae_toolArchive', input),
    duplicate: (input) => call('ae_toolDuplicate', input),
    promoteFromHistory: (input) => call(
      'ae_toolPromoteFromHistory',
      input,
    ),
    use: (input) => call('ae_toolUse', input),
    previewImport: (path) => call(
      'ae_toolImport',
      { action: 'preview', path },
    ),
    commitImport: (importId, resolutions) => call(
      'ae_toolImport',
      { action: 'commit', import_id: importId, resolutions },
    ),
    discardImport: (importId) => call(
      'ae_toolImport',
      { action: 'discard', import_id: importId },
    ),
    exportPackage: (artifactIds, outPath) => call(
      'ae_toolExport',
      { artifact_ids: artifactIds, out_path: outPath },
    ),
  };
}
```

- [ ] **Step 4: Implement the pure state reducer**

INITIAL_TOOLS_STATE contains:

```javascript
{
  phase: 'idle',
  summaries: [],
  total: 0,
  selectedId: null,
  inspected: null,
  query: '',
  kinds: [],
  category: '',
  risk: '',
  statuses: ['saved', 'pinned'],
  sourceType: '',
  editor: null,
  importPreview: null,
  conflictResolutions: {},
  error: '',
}
```

Reducer events are load-start/load-success/load-error/select/inspect-success/set-query/set-filter/edit-start/edit-change/edit-cancel/save-success/delete-success/import-preview/import-resolution/import-finished/clear-error. Every mutation returns a new object and retains the draft after a revision conflict.

- [ ] **Step 5: Implement CEP file dialogs**

chooseToolPackage calls cepFs.showOpenDialog(false, false, title, initialPath, ["aemcptools"]). It returns null on cancel and the single normalized path on success.

chooseToolExportPath calls cepFs.showSaveDialog(title, initialPath, ["aemcptools"], "tools.aemcptools"). Append .aemcptools when the returned path lacks that case-insensitive suffix.

- [ ] **Step 6: Implement Tools screen behavior**

The screen layout is:

1. header with New, Import, Export;
2. search and filters for kind/category/risk/status/source;
3. list showing name, kind, category, risk, status, verified, source, last used;
4. detail pane showing metadata and escaped content;
5. actions Edit, Duplicate, Archive, Delete, Pin/Unpin, Verify, Promote, Copy, Prepare/Run according to capabilities.

Add responsive split-pane/list/editor styles to plugin/panel/src/styles/index.css using the existing spacing, color, typography, focus-ring, and reduced-motion tokens; at narrow Panel widths the detail pane stacks below the list without horizontal page scrolling.

ToolArtifactEditor edits name, description, kind, category, comma-separated tags, declared risk, content, and JSON args schema. Save parses args schema before calling api and includes expected_revision and expected_content_hash for edits.

Candidate Promote calls ae_toolPromoteFromHistory only for chat-tool-call sources; imported candidate promotion uses ae_toolEdit with changes.status set to saved. Pin/Unpin also uses ae_toolEdit status transitions, and Verify uses verification_action mark-reviewed. replace_artifact_id is sent only while promoting a candidate after a separate conflict confirmation.

Import first opens preview, then renders each post-scan metadata change, content-hash change, calculated risk, and conflict as text. Commit stays disabled until every conflict has an explicit keep/duplicate resolution; cancel calls discardImport. A successful commit refreshes candidates and never auto-promotes them.

Execution performs:

```javascript
const plan = await api.use({
  artifact_id: artifact.id,
  action: 'prepare',
  operation,
  args,
  target,
});
const grant = await api.use({
  action: 'grant',
  plan_hash: plan.planHash,
  grant_scope: 'once',
});
return await api.use({
  action: 'execute',
  plan_hash: plan.planHash,
  grant_id: grant.grantId,
});
```

Candidate/archived/deprecated never show Prepare/Run. expression render offers Copy; expression apply requires explicit compId/layerId/path fields.

- [ ] **Step 7: Wire tier state, elicitation, Tools tab, and backend MCP specs in App**

Create one approval tier file service per Panel lifetime. Write the initial permissionMode and update it in a React effect whenever the chip changes. Dispose it on unmount.

Build one function:

```javascript
const getMcpSpec = React.useCallback(async () => (
  withToolApprovalTier(
    await resolveMcpCommand({ extRoot }),
    approvalTierFile,
  )
), [extRoot, approvalTierFile]);
```

Use getMcpSpec for Claude, Codex, OpenCode, and ZCode. Pass approvalTierFile.env() into the direct createMcpClient.

Create elicitationCoordinator before createMcpClient and pass coordinator.handle as onElicitation. Render ToolApprovalDialog at the app root; allow-session is present only when decideToolPlan says allowSession.

Add the tab between Activity and Settings:

```javascript
{ id: 'tools', icon: 'wrench', label: t.tools }
```

Render ToolsScreen with createToolsApi(mcp). Add Chinese and English labels for the tab and approval dialog.

- [ ] **Step 8: Run focused Panel tests and build**

```bash
node --test plugin/panel/test/toolsApi.test.js plugin/panel/test/toolFileDialogs.test.js plugin/panel/test/toolsState.test.js plugin/panel/test/elicitationCoordinator.test.js plugin/panel/test/mcpClient.test.js
npm --prefix plugin/panel run build
```

Expected: tests exit 0; esbuild exits 0 and regenerates plugin/client/dist/app.js.

- [ ] **Step 9: Commit Task 10**

```bash
git add plugin/panel/src/cep/toolsApi.js plugin/panel/src/cep/toolFileDialogs.js plugin/panel/src/lib/toolsState.js plugin/panel/src/screens/ToolsScreen.jsx plugin/panel/src/components/tools/ToolArtifactRow.jsx plugin/panel/src/components/tools/ToolArtifactEditor.jsx plugin/panel/src/components/tools/ToolApprovalDialog.jsx plugin/panel/src/components/forms/Textarea.jsx plugin/panel/src/app/App.jsx plugin/panel/src/styles/index.css plugin/panel/test/toolsApi.test.js plugin/panel/test/toolFileDialogs.test.js plugin/panel/test/toolsState.test.js plugin/panel/test/mcpClient.test.js plugin/client/dist/app.js
git commit -m "feat(panel): add Tool Library management UI"
```

---

### Task 11: Documentation, complete regressions, and build verification

**Files:**

- Modify: README.md
- Modify: README.zh-CN.md
- Modify: docs/REFERENCE.md
- Modify: docs/WORKFLOW.md
- Modify: docs/INSTALL.md
- Verify: plugin/client/dist/app.js

**Interfaces:**

- Documents the twelve canonical dotted verbs and their exposed underscore names.
- Documents ~/.ae-mcp/tools, legacy canonical behavior, backup/rollback, .aemcptools limits, and approval matrix.
- Documents prepare/grant/execute request and response shapes.

- [ ] **Step 1: Update user and operator documentation**

README files must introduce the Tools tab and progressive discovery without claiming cloud sync.

REFERENCE must list all twelve verbs with:

- required/optional arguments;
- summary versus full-content responses;
- candidate restrictions;
- prepare response fields;
- grant and execute sequence;
- import preview/commit/discard;
- exposed underscore tool name.

WORKFLOW must show:

```text
ae_toolIndex
  -> ae_toolSearch
  -> ae_toolInspect
  -> ae_toolUse(action="prepare")
  -> ae_toolUse(action="grant")
  -> ae_toolUse(action="execute")
```

INSTALL must document:

- first-upgrade backup location;
- no legacy duplication;
- three backups/30 days retention;
- rollback through the current migrator;
- imported packages enter candidate;
- Tool Library data is not removed by ordinary runtime rollback.

- [ ] **Step 2: Run the complete non-live Python regression**

```bash
uv run pytest packages/core/tests/test_tool_artifact.py packages/core/tests/test_tool_secrets.py packages/core/tests/test_tool_store.py packages/core/tests/test_tool_legacy.py packages/core/tests/test_tool_migrations.py packages/core/tests/test_tool_audit.py packages/core/tests/test_tool_execution.py packages/core/tests/test_tool_history.py packages/core/tests/test_tool_archive.py packages/core/tests/test_handlers_tools.py packages/core/tests/test_skill_tool_compat.py packages/core/tests/test_skill_store.py packages/core/tests/test_approval_gate.py packages/core/tests/test_schemas.py packages/core/tests/test_annotations.py packages/core/tests/test_backend_base.py packages/core/tests/test_tool_names.py packages/core/tests/test_server_instructions.py -q
```

Expected: exit 0; no FAIL or ERROR entries.

- [ ] **Step 3: Run immediate three-backend approval regressions**

```bash
npm --prefix plugin/sidecar test
node --test plugin/panel/test/codexBackend.test.js plugin/panel/test/zcodeBackend.test.js plugin/panel/test/toolApproval.test.js plugin/panel/test/chatEntries.test.js
```

Expected: both commands exit 0; Claude, Codex, and ZCode destructive/external none-mode tests each pass.

- [ ] **Step 4: Run the complete Panel suite and production build**

```bash
npm --prefix plugin/panel test
npm --prefix plugin/panel run build
```

Expected: both commands exit 0; plugin/client/dist/app.js is regenerated and contains the Tools tab bundle.

- [ ] **Step 5: Run static safety checks**

```bash
rg -n "dangerouslySetInnerHTML|Authorization: Bearer|x-api-key|Set-Cookie" plugin/panel/src packages/core/ae_mcp/tool_*.py packages/core/ae_mcp/handlers/tools.py
rg -n "sessionAllowedTools.*ae_toolUse|sessionAllowedTools.*ae_skillUse" plugin/panel/src plugin/sidecar
```

Expected: first command has no dangerouslySetInnerHTML in Tool Library code and no embedded credential values; policy pattern names may appear only in scanner definitions/tests. Second command has no match showing dynamic Tool/Skill authorization cached by tool name.

- [ ] **Step 6: Inspect the final diff for scope and generated output**

```bash
git status --short
git diff --check
git diff --stat
```

Expected: git diff --check exits 0; only files listed in this plan plus the generated Panel bundle are changed by this work.

- [ ] **Step 7: Commit Task 11**

```bash
git add README.md README.zh-CN.md docs/REFERENCE.md docs/WORKFLOW.md docs/INSTALL.md plugin/client/dist/app.js
git commit -m "docs: document Tool Library migration and package safety"
```

---

## Required Acceptance Evidence

- Python schema registry contains exactly 44 verbs and the new set equals the twelve Tool Library names.
- Tool Index/Search responses contain no artifact content; Inspect is the first content-bearing call.
- User and bundled same-name legacy skills both appear in Tool UI with different IDs, while ae.skillUse preserves its old resolution order.
- ae.skillUse execute=false matches the old response exactly.
- ae.skillUse execute=true destructive content under none emits a plan-bound elicitation and does not touch Backend.exec before approval.
- Editing content or args schema revokes verified, prepared plans, one-time grants, and session allowances.
- Recipe dependency changes alter final planHash.
- candidate, archived, and deprecated fail in all four tiers.
- .aemcptools malicious path/link/bomb/hash/schema/secret/scanner/conflict cases leave no partial state.
- Claude onElicitation, Codex mcpServer/elicitation/request, and ZCode elicitation/create enforce the same matrix.
- destructive/external approval cards never offer allow-session.
- Panel content rendering contains no HTML execution path.
- Complete Python, Panel, sidecar, and production build commands exit 0.

## Self-Review Checklist

- [ ] Re-read specification section 7.1 and confirm model, storage, legacy sidecar, namespaces, and no-copy upgrade each map to Tasks 1-3.
- [ ] Re-read sections 7.2-7.3 and confirm twelve handlers, progressive disclosure, and five kind boundaries map to Tasks 4 and 6.
- [ ] Re-read section 7.4 and confirm status blocking, risk recalculation, plan fields, one-time grants, session scope, TOCTOU, and four-tier matrix map to Tasks 4, 6, 8, and 9.
- [ ] Re-read section 7.5 and confirm every archive bound and negative input maps to Task 5.
- [ ] Re-read section 8.2 and confirm first-upgrade backup, monotonic schema, idempotent restart, retention, rollback, and no legacy fork map to Tasks 2-3.
- [ ] Re-read section 12.3 and confirm every listed test category has an exact test file and command.
- [ ] Search this plan for banned incomplete-work markers and remove every occurrence before execution handoff.
- [ ] Compare every Python and JavaScript interface name across tasks and correct any mismatch.
- [ ] Confirm every task ends with a focused green command and an independent commit.

## Execution Handoff

Plan execution requires superpowers:subagent-driven-development for task-by-task implementation with review between commits, or superpowers:executing-plans for checkpointed inline execution. Do not execute multiple tasks in one commit.
