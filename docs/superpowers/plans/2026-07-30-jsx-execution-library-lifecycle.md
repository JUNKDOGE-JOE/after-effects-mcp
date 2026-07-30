# JSX Execution and Tool Library Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task by task.
> Use one implementer at a time in the shared worktree and one concentrated
> whole-branch reviewer. Do not add speculative safety or lifecycle
> infrastructure.

**Goal:** Close Issue #82 by making `ae_exec` non-persistent, allowing the model
or Tools panel to save reusable JSX deliberately, and allowing the model to
retain a durable non-executable candidate when it judges the script may be
useful again.

**Architecture:** Keep execution and persistence as separate calls. Remove the
`ae.exec` branch from automatic history capture. Extend the existing public
`ae_toolUse` tool with one strict `save` action for model-directed create or
promotion, while reusing the canonical Tool Library store. Restore the panel's
already-written mutation handlers through a separate capability-bound private
registry that is never advertised through `tools/list`.

**Tech Stack:** Python 3.11+, Pydantic v2, MCP low-level server, pytest,
JavaScript ES modules, Node.js `node:test`, React/CEP panel, generated bundled
skills.

## Frozen Acceptance Path

```text
one-time JSX:
public ae_exec
  -> Core handler/backend
  -> AE result
  -> no Tool Library service resolution or mutation

model save:
public ae_toolUse(action="save")
  -> strict save admission
  -> canonical ToolArtifactStore create/promote
  -> stable artifact response
  -> public ae_toolIndex/ae_toolInspect readback

panel save:
Tools panel
  -> capability-bound private mutation name
  -> existing Tool Library handler
  -> canonical ToolArtifactStore
  -> panel refresh/readback
```

## Global Constraints

- `ae_exec` never creates, updates, deduplicates, archives, or deletes a Tool
  Library artifact.
- A user-requested model save may create `saved` or `candidate` JSX.
- A model-curated save may create only a non-executable `candidate`.
- Candidate promotion requires user-requested intent and exact revision plus
  content-hash compare-and-swap fields.
- Candidates have no automatic expiration or cleanup.
- Existing candidates and all other user data remain untouched.
- The public MCP tool-name set remains unchanged.
- V1 model save accepts JSX only. Do not expand it to expressions, recipes,
  diagnostics, skills, or system commands.
- Panel mutation names remain absent from the public handler/schema/annotation
  registries and from `tools/list`.
- Reuse the existing panel capability. Do not add pairing, tokens, permissions,
  process identity, leases, or another service.
- Do not change JSX sent to AE, backend dispatch, checkpoint, Undo, timeout,
  uncertain-write, AEGP, or `ae_nativeExec` behavior.
- Do not add archive retention, cleanup concurrency, crash recovery, restart
  census, generic lifecycle infrastructure, or model-memory infrastructure.
- This package does not create an `.aep` and does not run HDEV/T4/T5/T6.
- Review findings are P0 only when reproduced on the frozen acceptance path.
  Use one concentrated review and at most one focused re-review for an actual
  blocker.

---

### Task 1: Define the strict public model-save contract

**Files:**

- Modify: `packages/core/ae_mcp/schemas.py`
- Modify: `packages/core/tests/test_schemas.py`

**Produces:**

- strict nested create and promote request models;
- `AeToolUseArgs.action = "save"`; and
- validation that rejects every mixed or unsupported save shape before handler
  execution.

- [ ] **Step 1: Write the failing schema tests**

Add table-driven tests for these valid requests:

```python
S.AeToolUseArgs(
    action="save",
    save={
        "mode": "create",
        "intent": "user-requested",
        "status": "saved",
        "artifact": {
            "name": "Reusable JSX",
            "description": "",
            "kind": "jsx",
            "category": "workflow",
            "tags": [],
            "compatibility": {},
            "declared_risk": "write",
            "content": "JSON.stringify({ok:true});",
            "args_schema": {},
        },
    },
)
```

Also cover:

- `model-curated` plus `candidate` create;
- `user-requested` plus `candidate` create; and
- user-requested candidate promotion with `artifact_id`,
  `expected_revision`, and `expected_content_hash`.

Add rejection cases for:

- model-curated `saved`;
- model-curated promotion;
- promotion to `candidate`;
- non-JSX kind;
- create mixed with existing-artifact identity;
- promote mixed with a draft;
- save payload supplied for another action; and
- save action without a save payload.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
uv run pytest packages/core/tests/test_schemas.py -q
```

Expected: FAIL because `save` is not a valid `AeToolUseArgs` action or field.

- [ ] **Step 3: Implement the smallest discriminated save models**

In `schemas.py`:

- define private nested Pydantic models for the artifact draft, create request,
  and promotion request;
- use a discriminated union on `mode`;
- add optional `save` to `AeToolUseArgs`;
- add `save` to the action literal; and
- extend the existing action-shape validator so save forbids all staged
  execution fields.

Do not add these nested models to public `SCHEMAS` as new tools. They are part
of the existing `ae.toolUse` schema only.

- [ ] **Step 4: Run the schema tests and commit**

Run:

```bash
uv run pytest packages/core/tests/test_schemas.py -q
git diff --check
git add packages/core/ae_mcp/schemas.py packages/core/tests/test_schemas.py
git commit -m "feat(tools): define explicit JSX save requests"
```

Expected: focused schema tests pass and the public tool-name registry remains
unchanged.

---

### Task 2: Implement model-directed create and promotion

**Files:**

- Modify: `packages/core/ae_mcp/handlers/tools.py`
- Modify: `packages/core/tests/test_handlers_tools.py`
- Modify: `packages/core/tests/test_tool_execution.py`

**Consumes:** Task 1 save request models and the existing
`ToolArtifactDraft`, `ToolSource`, `ToolArtifactStore.create()`,
`ToolArtifactStore.promote_candidate()`, `execution_capabilities()`, and public
index/inspect handlers.

**Produces:** `ae_toolUse(action="save")` create/promotion behavior without a
new public tool name.

- [ ] **Step 1: Write failing handler tests using a real temporary store**

Cover these vertical slices:

1. user-requested create returns a `saved` `user:` JSX artifact with revision 1
   and a 64-character content hash;
2. public index and inspect read back that exact artifact;
3. model-curated create returns a `candidate` with
   `source.type = "chat-tool-call"` and intent provenance;
4. default index/search excludes that candidate;
5. an explicit candidate query includes it;
6. execution preparation rejects the candidate through the existing blocked
   status rule;
7. user-requested promotion with exact revision/hash changes it to `saved`; and
8. stale revision/hash promotion returns the existing structured conflict.

The tests must not mock a second persistence service.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
uv run pytest packages/core/tests/test_handlers_tools.py \
  packages/core/tests/test_tool_execution.py -q
```

Expected: FAIL because `_run_tool_use` has no save branch.

- [ ] **Step 3: Add one save branch to the existing handler**

Implement one helper in `handlers/tools.py`:

- `mode = "create"` builds a `ToolArtifactDraft`;
- user-requested create uses `source.type = "user"`;
- model-curated create uses `source.type = "chat-tool-call"`;
- provenance records only bounded intent, request ID when available, and
  current client identity;
- the canonical store computes identity, revision, content hash, secret scan,
  and timestamps;
- `mode = "promote"` calls the canonical store's candidate promotion with the
  supplied compare-and-swap values; and
- the result returns the canonical serialized artifact plus execution
  capabilities.

Do not couple save to an `ae_exec` result, invent a history archive, deduplicate
explicit save calls, or add retry infrastructure.

- [ ] **Step 4: Run focused Tool Library tests and commit**

Run:

```bash
uv run pytest packages/core/tests/test_handlers_tools.py \
  packages/core/tests/test_tool_execution.py \
  packages/core/tests/test_tool_store.py -q
git diff --check
git add packages/core/ae_mcp/handlers/tools.py \
  packages/core/tests/test_handlers_tools.py \
  packages/core/tests/test_tool_execution.py
git commit -m "feat(tools): save model-directed JSX artifacts"
```

Expected: saved/candidate/promotion tests pass and candidate execution remains
blocked by existing behavior.

---

### Task 3: Stop automatic `ae_exec` history persistence

**Files:**

- Modify: `packages/core/ae_mcp/tool_history.py`
- Modify: `packages/core/tests/test_tool_history.py`

**Produces:** successful `ae_exec` calls no longer resolve or mutate the Tool
Library unless the model makes a separate save call.

- [ ] **Step 1: Replace the old success-capture tests with non-persistence tests**

Change the old `test_successful_exec_creates_non_executable_candidate` contract
to require:

```python
assert extract_history_draft(
    "ae.exec",
    exec_arguments(),
    {"ok": True},
    context(),
) is None
```

At the server boundary, patch `default_tool_service` to fail if resolved and
prove that a successful structured `ae_exec` response is still returned.

Keep one focused extraction test for any independently retained expression
history behavior. Do not redesign it.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
uv run pytest packages/core/tests/test_tool_history.py -q
```

Expected: FAIL because successful `ae.exec` still yields a candidate draft.

- [ ] **Step 3: Remove only the `ae.exec` extraction branch**

Delete the JSX draft creation branch from `extract_history_draft()`. Remove
imports or helpers only when they become unused. Leave the generic server
success path and unrelated expression behavior unchanged.

- [ ] **Step 4: Run focused server/history tests and commit**

Run:

```bash
uv run pytest packages/core/tests/test_tool_history.py \
  packages/core/tests/test_tool_names.py -q
git diff --check
git add packages/core/ae_mcp/tool_history.py \
  packages/core/tests/test_tool_history.py
git commit -m "fix(exec): stop automatic JSX candidate capture"
```

Expected: `ae_exec` result behavior is unchanged and Tool Library resolution is
absent without a separate save call.

---

### Task 4: Restore the capability-bound panel mutation channel

**Files:**

- Modify: `packages/core/ae_mcp/schemas.py`
- Modify: `packages/core/ae_mcp/handlers/__init__.py`
- Modify: `packages/core/ae_mcp/handlers/tools.py`
- Modify: `packages/core/ae_mcp/server.py`
- Modify: `packages/core/tests/test_handlers_tools.py`
- Modify: `packages/core/tests/test_tool_names.py`
- Modify: `plugin/panel/src/cep/toolsApi.js`
- Modify: `plugin/panel/test/toolsApi.test.js`

**Produces:** the existing Tools UI mutations work through private panel
handlers while public `tools/list` remains unchanged.

- [ ] **Step 1: Write failing Core private-dispatch tests**

Add exact tests proving:

- `PANEL_HANDLERS` contains only create, edit, delete, archive, duplicate,
  promote-from-history, import, and export;
- `HANDLERS`, public `SCHEMAS`, public annotations, and `FINAL_PUBLIC_TOOLS`
  remain exactly equal to the current public tool-name set;
- `tools/list` contains no panel mutation name;
- a panel mutation call without or with a wrong capability returns the ordinary
  unknown-tool error;
- a valid capability consumes the secret field, validates the private schema,
  and dispatches exactly once; and
- public developer index/search/inspect capability behavior remains unchanged.

- [ ] **Step 2: Write the failing panel transport test**

Update `toolsApi.test.js` to provide both `callTool` and `callPanelTool`.

Assert:

- index/search/inspect/use use `callTool`;
- create/edit/delete/archive/duplicate/promote/import/export use
  `callPanelTool`; and
- mutation arguments are unchanged apart from the capability added by the MCP
  client.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
uv run pytest packages/core/tests/test_handlers_tools.py \
  packages/core/tests/test_tool_names.py -q
node --test plugin/panel/test/toolsApi.test.js
```

Expected: Core cannot resolve the private names and panel mutations still use
the public call path.

- [ ] **Step 4: Implement one separate private registry**

Add:

- strict private request schemas matching the existing handler/UI request
  shapes;
- `PANEL_HANDLERS` and `register_panel()` separate from `HANDLERS`;
- registration of the eight already-written mutation handlers;
- a private reverse map in `build_server()`;
- capability consumption before private schema disclosure or dispatch; and
- unknown-tool behavior for invalid private calls.

The public list loop must continue iterating `HANDLERS` only. Do not add private
names to backend supported verbs, annotations, generated public schemas, or
instructions.

Change the panel API's mutation functions to use `panelCall`.

- [ ] **Step 5: Run Core/panel tests and commit**

Run:

```bash
uv run pytest packages/core/tests/test_handlers_tools.py \
  packages/core/tests/test_tool_names.py -q
node --test plugin/panel/test/toolsApi.test.js \
  plugin/panel/test/mcpClient.test.js \
  plugin/panel/test/toolsState.test.js
git diff --check
git add packages/core/ae_mcp/schemas.py \
  packages/core/ae_mcp/handlers/__init__.py \
  packages/core/ae_mcp/handlers/tools.py \
  packages/core/ae_mcp/server.py \
  packages/core/tests/test_handlers_tools.py \
  packages/core/tests/test_tool_names.py \
  plugin/panel/src/cep/toolsApi.js \
  plugin/panel/test/toolsApi.test.js
git commit -m "fix(panel): restore private Tool Library mutations"
```

Expected: panel mutations dispatch, public tool names remain unchanged, and no
new permission system exists.

---

### Task 5: Teach model routing and rebuild generated artifacts

**Files:**

- Modify: `plugin/shared/tool-approval.mjs`
- Modify: `plugin/panel/test/toolApproval.test.js`
- Modify: `scripts/generate_native_exec.py`
- Modify: `packages/core/tests/test_skill_store.py`
- Generate: `packages/core/ae_mcp/skills_bundled/ae-execution-guide.json`
- Generate: `packages/core/ae_mcp/skills_bundled/manifest.json`
- Modify: `docs/REFERENCE.md`
- Modify: `docs/WORKFLOW.md`
- Generate: `plugin/client/dist/app.js`

**Produces:** models can route the new save action to Core and receive the
approved lifecycle rule from the default execution skill.

- [ ] **Step 1: Write failing delegation and bundled-skill tests**

Add tests proving:

- `isCoreAuthorizedDynamicCall("ae_toolUse", {action: "save", ...})` delegates
  to Core;
- unsupported actions such as `delete` remain denied;
- the generated execution guide says ordinary `ae_exec` is ephemeral;
- user-requested persistence uses `saved`;
- model-judged possible reuse uses `candidate`;
- candidate creation is a separate call and candidates are non-executable; and
- no automatic expiration or cleanup rule is introduced.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test plugin/panel/test/toolApproval.test.js
uv run pytest packages/core/tests/test_skill_store.py -q
```

Expected: save is not delegated and the generated guide lacks lifecycle
instructions.

- [ ] **Step 3: Update the authoritative generator and shared delegation set**

Add `save` to the existing `TOOL_USE_ACTIONS` set. Core remains the authority
for the strict payload.

Update the stable text inside `scripts/generate_native_exec.py`; do not hand-edit
the generated bundled JSON. Add a concise `JSX persistence` section with the
approved three-way rule.

Run:

```bash
uv run python scripts/generate_native_exec.py
uv run python scripts/generate_native_exec.py --check
```

Expected: only the execution guide, its manifest hash, and any deterministic
projection already owned by the generator change.

- [ ] **Step 4: Update user documentation**

In both English and Chinese sections of `docs/REFERENCE.md` and
`docs/WORKFLOW.md`, document:

- `ae_exec` is non-persistent;
- `ae_toolUse action=save` create and promote shapes;
- saved versus candidate intent rules;
- candidates are excluded from default discovery and cannot execute; and
- candidates remain until explicit panel deletion or user-requested promotion.

Do not restore the old archive/retention plan.

- [ ] **Step 5: Build the panel and run focused tests**

Run:

```bash
node --test plugin/panel/test/toolApproval.test.js \
  plugin/panel/test/toolsApi.test.js
uv run pytest packages/core/tests/test_skill_store.py \
  packages/core/tests/test_native_exec_generation.py -q
npm run build --prefix plugin/panel
uv run python scripts/generate_native_exec.py --check
git diff --check
```

Expected: generated artifacts are current and the panel bundle reflects source
changes.

- [ ] **Step 6: Commit**

Run:

```bash
git add plugin/shared/tool-approval.mjs \
  plugin/panel/test/toolApproval.test.js \
  scripts/generate_native_exec.py \
  packages/core/tests/test_skill_store.py \
  packages/core/ae_mcp/skills_bundled/ae-execution-guide.json \
  packages/core/ae_mcp/skills_bundled/manifest.json \
  docs/REFERENCE.md docs/WORKFLOW.md plugin/client/dist/app.js
git commit -m "docs(tools): teach explicit JSX persistence"
```

---

### Task 6: Concentrated review, focused CI, and delivery

**Files:** Review the complete branch diff against the frozen design and this
plan.

- [ ] **Step 1: Run the complete affected local test set**

Run:

```bash
uv run pytest \
  packages/core/tests/test_schemas.py \
  packages/core/tests/test_tool_history.py \
  packages/core/tests/test_handlers_tools.py \
  packages/core/tests/test_tool_execution.py \
  packages/core/tests/test_tool_store.py \
  packages/core/tests/test_tool_names.py \
  packages/core/tests/test_skill_store.py \
  packages/core/tests/test_native_exec_generation.py -q
node --test \
  plugin/panel/test/toolsApi.test.js \
  plugin/panel/test/mcpClient.test.js \
  plugin/panel/test/toolsState.test.js \
  plugin/panel/test/toolApproval.test.js
uv run python scripts/generate_native_exec.py --check
npm run build --prefix plugin/panel
git diff --check
git status --short
```

Expected: all focused tests pass, generators are clean, the build creates no
uncommitted drift, and only intended #82 files changed.

- [ ] **Step 2: Run one concentrated independent review**

Give the reviewer:

- the frozen design;
- this implementation plan;
- the complete branch diff;
- the focused test receipt; and
- the explicit instruction that speculative retention, cleanup, process,
  permission, and generic framework hardening are follow-up or out of scope.

Classify findings:

- P0 only if reproduced on the frozen acceptance path;
- follow-up for credible but non-blocking work; and
- out of scope for unsupported or contrary suggestions.

If a real blocker is found, fix it as one bounded set, rerun only affected
lower-tier tests, and perform one focused re-review. Do not start a third
general review round.

- [ ] **Step 3: Run the frozen-branch regression and CI once**

After review has no unresolved blocker:

```bash
uv run pytest -q
npm test --prefix plugin/panel
uv run python scripts/generate_native_exec.py --check
```

Push the branch, open one PR for #82, and wait for required GitHub checks. This
is the package's one full local regression/CI candidate.

- [ ] **Step 4: Merge and close the package**

After CI is green and review is clear:

- merge the PR;
- verify the clean `main` source revision and rerun the focused non-AE package
  smoke;
- rewrite/close Issue #82 with the superseded archive scope recorded;
- report zero `.aep` files created, retained, archived, or deleted; and
- stop for the mandatory next-package approval checkpoint.

No real-AE acceptance run is required because the implementation does not
change the AE execution path.
