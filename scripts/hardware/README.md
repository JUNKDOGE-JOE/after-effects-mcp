# Real-AE hardware drivers

These scripts call the same public MCP tools that a model sees. They do not
call Core handlers, the CEP HTTP bridge, or the native socket directly.

## Capability package #155

`issue155_layer_timeline_acceptance.py` is the frozen driver for the Layer
Timeline Editing package. T5/T6 exercise all eight public tools in one formal
AE session, verify all seven writes with real Undo/readback, save the single
active fixture in place, restart formal AE, reacquire fresh locators, and prove
the post-restart state still matches the stable post-Undo baseline. T4 is the
narrow duplication primitive smoke.

The fixture lifecycle is always `ephemeral-validation`. The exact fixture path
must be an absent absolute `.aep` path before preflight. The runner permits one
first save and no Save As copies; after successful acceptance it moves the
closed fixture into a unique run directory under the explicit recovery archive
root. That root must be outside every Adobe CEP and plug-in scan root.

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --frozen python \
  scripts/hardware/issue155_layer_timeline_acceptance.py \
  --mode t5 \
  --expected-sha 0123456789abcdef0123456789abcdef01234567 \
  --fixture-path '/absolute/local/active/issue155-layer-timeline.aep' \
  --recovery-archive-root '/absolute/local/recovery/ae-mcp-fixtures' \
  --stretch-percent 125.5 \
  --native-receipt /absolute/candidate/native/build-receipt.json \
  --native-manifest /absolute/candidate/native-plugin-manifest.json \
  --evidence-dir '/absolute/private/evidence/issue155-t5'
```

At `restart-ae`, save the current exact fixture in place before quitting. Start
only the explicit formal AE application path and reopen the fixture through AE,
never Finder/LaunchServices. The driver binds every response to the latest
formal native load record, requires both host instance and session to change,
and rejects any fixture-state drift before archival.

## Capability package #150

`issue150_project_composition_acceptance.py` is the frozen hardware driver for
the Project / Composition Context & Mutation package.

- `t4`: one narrow native-novelty smoke for composition duplication and real
  After Effects Undo.
- `t5`: one exact-candidate run covering all eight package tools, all five
  writes and their real Undo/readback checkpoints, then AE restart/reconnect
  and stale-locator rejection.
- `t6`: the same package matrix rebuilt and reinstalled from the clean merge
  commit.

Example (use only a disposable fixture project):

```sh
PYTHONDONTWRITEBYTECODE=1 uv run --frozen python \
  scripts/hardware/issue150_project_composition_acceptance.py \
  --mode t5 \
  --expected-sha 0123456789abcdef0123456789abcdef01234567 \
  --fixture-composition-name 'Issue150 Fixture' \
  --renamed-name 'Issue150 Renamed' \
  --duplicate-name 'Issue150 Duplicate' \
  --comment-value 'Issue #150 acceptance' \
  --label-id 6 \
  --work-area-start 24/24 \
  --work-area-duration 48/24 \
  --native-receipt /absolute/candidate/native/build-receipt.json \
  --native-manifest /absolute/candidate/native-plugin-manifest.json \
  --evidence-dir "$HOME/Library/Application Support/AfterEffectsMCP/issue150/evidence"
```

T4, T5 and T6 all fail closed unless the canonical CEP
`bundle-manifest.json`, RuntimeManager `current` pointer and selected
`install-record.json`, supplied native receipt/manifest, and every public
response report the same full candidate SHA. Component and artifact hashes
are recorded in the private evidence log.

The frozen package matrix has eight public acceptance rows: three reads and
five writes. `ae_listProjectItems` is an existing support read used only for
independent project-count and duplicate readback; its descriptor is pinned by
the driver, but it is not a ninth package acceptance row.

The orchestrator reads each `CHECKPOINT_REQUIRED` line, performs the authorized
GUI action, and writes exactly one acknowledgement line:

```json
{"checkpointId":"the-emitted-id","status":"completed"}
```

Pairing, Undo and restart are deliberately explicit checkpoints. Pairing
fingerprints and private paths are available only in the live checkpoint and
are redacted before evidence is persisted. Evidence files use mode `0600` in a
`0700` directory.

Before completing the emitted `preflight-ae` checkpoint, open only the
disposable #150 project in the formal After Effects app, make the named source
composition active, and select it in the Project panel. The driver resolves the
fixture only through public project-context results. Keep the disposable
project at 49 items or fewer so the duplicate and independent count readback
remain in the bounded first page. After restart, restore the same
active/selected state if After Effects did not preserve it.

If any write returns `POSSIBLY_SIDE_EFFECTING_FAILURE`, the driver exits with
status 3 without retrying. Inspect AE state and the native audit trail before
deciding how to recover.

Every write is surrounded by a normalized complete semantic snapshot. The
driver rejects collateral changes, then requires a real GUI Undo and proves
the complete snapshot returned to its baseline. It also recomputes each typed
postcondition digest using the RFC 8785/JCS-compatible package value shape.
