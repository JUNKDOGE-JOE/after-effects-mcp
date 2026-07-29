from __future__ import annotations

import asyncio
import hashlib
import json
from copy import deepcopy
from types import SimpleNamespace
from typing import Any

import pytest

from ae_mcp import schemas
from ae_mcp.backends import maintained_layer_source as S
from ae_mcp.handlers import native as native_handlers


HOST = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
PROJECT = "33333333-3333-4333-8333-333333333333"
LAYER_ID = "44444444-4444-4444-8444-444444444444"
COMP_ID = "55555555-5555-4555-8555-555555555555"
OLD_SOURCE_ID = "66666666-6666-4666-8666-666666666666"
NEW_SOURCE_ID = "77777777-7777-4777-8777-777777777777"
PROJECT_ROOT_ID = "88888888-8888-4888-8888-888888888888"
KEY = "layer-source-intent-0001"


def locator(kind: str, object_id: str, generation: int = 1) -> dict[str, Any]:
    return {
        "kind": kind,
        "hostInstanceId": HOST,
        "sessionId": SESSION,
        "projectId": PROJECT,
        "generation": generation,
        "objectId": object_id,
    }


LAYER = locator("layer", LAYER_ID)
COMPOSITION = locator("composition", COMP_ID)
OLD_SOURCE = locator("item", OLD_SOURCE_ID)
NEW_SOURCE = locator("composition", NEW_SOURCE_ID)
PROJECT_ROOT = locator("project", PROJECT_ROOT_ID)


def args(
    *,
    layer_locator: dict[str, Any] = LAYER,
    source_item_locator: dict[str, Any] = NEW_SOURCE,
    idempotency_key: str = KEY,
) -> schemas.AeSetLayerSourceArgs:
    return schemas.AeSetLayerSourceArgs(
        layer_locator=layer_locator,
        source_item_locator=source_item_locator,
        idempotency_key=idempotency_key,
    )


def resolved() -> S.ResolvedSourceReplacement:
    return S.ResolvedSourceReplacement(
        composition_project_item_index=2,
        expected_composition_name='Main "Comp" 😀\n',
        expected_composition_type="composition",
        layer_index=3,
        expected_layer_name='Relink "Target" 😀\n',
        expected_layer_type="av",
        current_source_project_item_index=4,
        expected_current_source_name="Old Source",
        expected_current_source_type="footage",
        new_source_project_item_index=5,
        expected_new_source_name='New "Source" 😀\n',
        expected_new_source_type="composition",
    )


def request_literal(rendered: str) -> dict[str, Any]:
    marker = "var request = "
    start = rendered.index(marker) + len(marker)
    end = rendered.index(";\n", start)
    return json.loads(rendered[start:end])


def invariant() -> dict[str, Any]:
    return {
        "name": 'Relink "Target" 😀\n',
        "inPoint": 0,
        "outPoint": 5,
        "startTime": 0,
        "stretch": 100,
        "parentIndex": None,
        "enabled": True,
        "audioEnabled": True,
        "solo": False,
        "shy": False,
        "locked": False,
        "guideLayer": False,
        "threeDLayer": False,
        "adjustmentLayer": False,
        "motionBlur": False,
        "collapseTransformation": False,
        "effectsActive": True,
        "frameBlending": False,
        "timeRemapEnabled": False,
        "preserveTransparency": False,
        "quality": 2,
        "blendingMode": 5220,
        "trackMatteType": 0,
        "trackMatteLayerIndex": None,
    }


def jsx_success() -> dict[str, Any]:
    address = resolved().model_dump(mode="json", by_alias=False)
    return {
        "ok": True,
        "value": {
            "_resolved": address,
            "beforeSource": {
                "projectItemIndex": 4,
                "name": "Old Source",
                "type": "footage",
            },
            "afterSource": {
                "projectItemIndex": 5,
                "name": 'New "Source" 😀\n',
                "type": "composition",
            },
            "beforeInvariant": invariant(),
            "afterInvariant": invariant(),
        },
    }


def fresh_state(generation: int = 2) -> S.ReacquiredSourceState:
    return S.ReacquiredSourceState(
        project_locator=locator("project", PROJECT_ROOT_ID, generation),
        composition_locator=locator("composition", COMP_ID, generation),
        layer_locator=locator("layer", LAYER_ID, generation),
        before_source_item_locator=locator("item", OLD_SOURCE_ID, generation),
        after_source_item_locator=locator("composition", NEW_SOURCE_ID, generation),
        source_type="composition",
        source_name='New "Source" 😀\n',
    )


class ExecBackend:
    def __init__(self, result: Any):
        self.result = result
        self.calls: list[dict[str, Any]] = []

    async def exec(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result if isinstance(self.result, str) else json.dumps(self.result)


class NativeExecBackend(S.NativeInvokeBackend):
    def __init__(self, result: Any):
        self.result = result
        self.calls: list[dict[str, Any]] = []

    async def invoke(self, request, *, cancellation=None):
        raise AssertionError("native invoke is replaced by focused test seams")

    async def negotiate(self, *, deadline_unix_ms, cancellation=None):
        raise AssertionError("native negotiate is replaced by focused test seams")

    async def capabilities(
        self, *, ids, detail, limit, deadline_unix_ms, cancellation=None
    ):
        raise AssertionError("native capabilities are replaced by focused test seams")

    async def exec(self, **kwargs: Any) -> Any:
        self.calls.append(kwargs)
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result if isinstance(self.result, str) else json.dumps(self.result)


def template_rejection(
    *,
    code: str = "STALE_LOCATOR",
    side_effect: str = "not-started",
) -> dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": "A bounded template guard changed.",
            "retryable": False,
            "sideEffect": side_effect,
            "recovery": {
                "action": (
                    "reconcile-state"
                    if side_effect == "possible"
                    else "refresh-locators"
                ),
                "hint": "Refresh state using the fixed recovery path.",
            },
        },
    }


def test_fixed_template_is_closed_json_escaped_es3_and_digest_bound():
    rendered, metadata = S.render_layer_source_replace(
        args(), resolved_address=resolved(), undo_group="source-op-1"
    )
    literal = request_literal(rendered)

    assert metadata == {
        "templateId": "aemcp.layer.source.replace.v1",
        "templateDigest": (
            "2353317ea9e25d836dcc50284c9ab4aa534a2b84955e2fcb1ea78b9343af5fad"
        ),
    }
    raw_template = S.TEMPLATE_PATH.read_bytes()
    assert S.TEMPLATE_DIGEST == hashlib.sha256(raw_template).hexdigest()
    assert literal["_resolved"] == resolved().model_dump(
        mode="json", by_alias=False
    )
    assert literal["undo_group"] == "source-op-1"
    assert literal["idempotency_key"] == KEY
    assert "layer_locator" not in literal
    assert "source_item_locator" not in literal
    assert "\\ud83d\\ude00" in rendered
    assert "\\u2028" not in rendered
    assert "__AEMCP_LAYER_SOURCE_" not in rendered
    assert all(
        key not in literal
        for key in ("code", "jsx", "script", "expression", "path", "media")
    )
    template = raw_template.decode("utf-8")
    assert "let " not in template
    assert "const " not in template
    assert "=>" not in template
    assert template.count("replaceSource(newSource, false)") == 1
    assert template.count("app.beginUndoGroup") == 1
    assert "app.endUndoGroup" in template
    assert (
        template.index("app.beginUndoGroup")
        < template.index("replaceSource(newSource, false)")
        < template.index("app.endUndoGroup")
    )
    assert "try {" in template and "catch (" in template
    assert "throw " not in template
    assert "JSON.stringify" in template


@pytest.mark.asyncio
async def test_resolver_requires_exact_locator_matches_and_bounded_addresses(
    monkeypatch,
):
    project_locator = S._native_locator(PROJECT_ROOT)
    composition_locator = S._native_locator(COMPOSITION)
    old_source_locator = S._native_locator(OLD_SOURCE)
    new_source_locator = S._native_locator(NEW_SOURCE)
    layer_locator = S._native_locator(LAYER)
    rows = [
        (2, SimpleNamespace(
            locator=composition_locator, name='Main "Comp" 😀\n',
            type="composition",
        )),
        (4, SimpleNamespace(
            locator=old_source_locator, name="Old Source", type="footage",
        )),
        (5, SimpleNamespace(
            locator=new_source_locator, name='New "Source" 😀\n',
            type="composition",
        )),
    ]
    layer = SimpleNamespace(
        locator=layer_locator, stack_index=3, name='Relink "Target" 😀\n',
        type="av", source_item_locator=old_source_locator,
    )

    async def project_rows(*_args, **_kwargs):
        return project_locator, rows

    async def layer_rows(*_args, **_kwargs):
        return [layer] if _args[1] == composition_locator else []

    async def source_read(*_args, **_kwargs):
        return SimpleNamespace(
            value=SimpleNamespace(
                layer_locator=layer_locator,
                source_item_locator=old_source_locator,
                source_type="footage",
                source_name="Old Source",
            )
        )

    monkeypatch.setattr(S, "_project_item_rows", project_rows)
    monkeypatch.setattr(S, "_composition_layer_rows", layer_rows)
    monkeypatch.setattr(S, "invoke_layer_source_read", source_read)
    address = await S.resolve_source_replacement(
        object(), LAYER, NEW_SOURCE,
        deadline_unix_ms=123, cancellation=S.NativeCancellationToken(),
    )
    assert address == resolved()

    duplicate_rows = [*rows, rows[-1]]

    async def duplicated(*_args, **_kwargs):
        return project_locator, duplicate_rows

    monkeypatch.setattr(S, "_project_item_rows", duplicated)
    with pytest.raises(ValueError, match="STALE_LOCATOR"):
        await S.resolve_source_replacement(
            object(), LAYER, NEW_SOURCE,
            deadline_unix_ms=123, cancellation=S.NativeCancellationToken(),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("layer_type", "source_type", "has_source", "same_source", "code"),
    [
        ("text", "composition", True, False, "LAYER_SOURCE_NOT_REPLACEABLE"),
        ("shape", "composition", True, False, "LAYER_SOURCE_NOT_REPLACEABLE"),
        ("null", "composition", True, False, "LAYER_SOURCE_NOT_REPLACEABLE"),
        ("camera", "composition", False, False, "LAYER_SOURCE_NOT_REPLACEABLE"),
        ("light", "composition", False, False, "LAYER_SOURCE_NOT_REPLACEABLE"),
        ("adjustment", "composition", True, False, "LAYER_SOURCE_NOT_REPLACEABLE"),
        ("av", "composition", False, False, "LAYER_SOURCE_NOT_REPLACEABLE"),
        ("av", "folder", True, False, "SOURCE_ITEM_NOT_AV"),
        ("unknown", "composition", True, False, "LAYER_SOURCE_NOT_REPLACEABLE"),
        ("av", "composition", True, True, "VALUE_UNCHANGED"),
    ],
)
async def test_resolver_rejects_non_replaceable_boundaries_before_dispatch(
    monkeypatch, layer_type, source_type, has_source, same_source, code,
):
    layer_locator = S._native_locator(LAYER)
    composition_locator = S._native_locator(COMPOSITION)
    old_locator = S._native_locator(OLD_SOURCE)
    selected_locator = old_locator if same_source else S._native_locator(NEW_SOURCE)
    project_locator = S._native_locator(PROJECT_ROOT)
    rows = [
        (2, SimpleNamespace(
            locator=composition_locator, name="Main", type="composition",
        )),
        (4, SimpleNamespace(
            locator=old_locator, name="Old", type="footage",
        )),
        (5, SimpleNamespace(
            locator=selected_locator, name="New", type=source_type,
        )),
    ]
    if same_source:
        rows = rows[:2]

    async def project_rows(*_args, **_kwargs):
        return project_locator, rows

    async def layer_rows(*_args, **_kwargs):
        if _args[1] != composition_locator:
            return []
        return [
            SimpleNamespace(
                locator=layer_locator, stack_index=3, name="Target",
                type=layer_type,
                source_item_locator=old_locator if has_source else None,
            )
        ]

    monkeypatch.setattr(S, "_project_item_rows", project_rows)
    monkeypatch.setattr(S, "_composition_layer_rows", layer_rows)
    with pytest.raises(ValueError, match=code):
        await S.resolve_source_replacement(
            object(), LAYER,
            OLD_SOURCE if same_source else NEW_SOURCE,
            deadline_unix_ms=123, cancellation=S.NativeCancellationToken(),
        )


def test_template_rechecks_every_bounded_guard_before_the_single_mutation():
    template = S.TEMPLATE_PATH.read_text(encoding="utf-8")
    mutation = template.index("replaceSource(newSource, false)")
    required_guards = [
        "composition_project_item_index",
        "expected_composition_name",
        "expected_composition_type",
        "layer_index",
        "expected_layer_name",
        "expected_layer_type",
        "current_source_project_item_index",
        "expected_current_source_name",
        "expected_current_source_type",
        "new_source_project_item_index",
        "expected_new_source_name",
        "expected_new_source_type",
        "instanceof AVLayer",
        "instanceof TextLayer",
        "instanceof ShapeLayer",
        "nullLayer",
        "adjustmentLayer",
        "layer.source",
        "layer.source === newSource",
    ]
    for guard in required_guards:
        assert guard in template
        assert template.index(guard) < mutation


@pytest.mark.asyncio
async def test_reacquisition_uses_only_post_exec_locators_and_native_source_read(
    monkeypatch,
):
    fresh = fresh_state()
    project_locator = S._native_locator(
        fresh.project_locator.model_dump(mode="json", by_alias=True)
    )
    comp_locator = S._native_locator(
        fresh.composition_locator.model_dump(mode="json", by_alias=True)
    )
    old_locator = S._native_locator(
        fresh.before_source_item_locator.model_dump(mode="json", by_alias=True)
    )
    new_locator = S._native_locator(
        fresh.after_source_item_locator.model_dump(mode="json", by_alias=True)
    )
    layer_locator = S._native_locator(
        fresh.layer_locator.model_dump(mode="json", by_alias=True)
    )
    calls: list[dict[str, Any]] = []

    async def project_rows(*_args, **_kwargs):
        return project_locator, [
            (2, SimpleNamespace(locator=comp_locator, name='Main "Comp" 😀\n', type="composition")),
            (4, SimpleNamespace(locator=old_locator, name="Old Source", type="footage")),
            (5, SimpleNamespace(locator=new_locator, name='New "Source" 😀\n', type="composition")),
        ]

    async def layer_rows(*_args, **_kwargs):
        assert _args[1] == comp_locator
        return [SimpleNamespace(
            locator=layer_locator, stack_index=3,
            name='Relink "Target" 😀\n', type="av",
            source_item_locator=new_locator,
        )]

    async def source_read(*_args, **kwargs):
        calls.append(kwargs)
        assert kwargs["layer_locator"] == layer_locator
        return SimpleNamespace(value=SimpleNamespace(
            layer_locator=layer_locator,
            source_item_locator=new_locator,
            source_type="composition",
            source_name='New "Source" 😀\n',
        ))

    monkeypatch.setattr(S, "_project_item_rows", project_rows)
    monkeypatch.setattr(S, "_composition_layer_rows", layer_rows)
    monkeypatch.setattr(S, "invoke_layer_source_read", source_read)
    state = await S.reacquire_source_state(
        object(), resolved(),
        deadline_unix_ms=123, cancellation=S.NativeCancellationToken(),
    )
    assert state == fresh
    assert state.layer_locator.generation == 2
    assert calls and calls[0]["request_id"].startswith("layer-source-post-read-")


@pytest.mark.asyncio
async def test_execution_invalidates_graph_verifies_projection_audits_and_replays(
    monkeypatch, tmp_path,
):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_LAYER_SOURCE_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "a" * 40)

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    async def reacquire(*_args, **_kwargs):
        return fresh_state()

    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    monkeypatch.setattr(S, "reacquire_source_state", reacquire)
    backend = ExecBackend(jsx_success())
    response = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert response["ok"] is True
    assert response["implementation"]["engine"] == "maintained-jsx"
    assert response["implementation"]["callerCodeAccepted"] is False
    assert response["provenance"]["sourceCommit"] == "a" * 40
    assert response["provenance"]["hostInstanceId"] == HOST
    assert response["provenance"]["sessionId"] == SESSION
    assert response["provenance"]["projectId"] == PROJECT
    assert response["provenance"]["projectGenerationBefore"] == 1
    assert response["provenance"]["projectGenerationAfter"] == 2
    assert response["value"]["beforeInvariant"] == response["value"]["afterInvariant"]
    assert response["value"]["beforeSourceItemLocator"]["generation"] == 2
    assert response["value"]["afterSourceItemLocator"]["generation"] == 2
    assert response["value"]["layerLocator"]["generation"] == 2
    assert response["evidence"]["postcondition"]["verified"] is True
    assert response["evidence"]["undo"]["available"] is True
    assert response["evidence"]["undo"]["verified"] is False
    assert len(backend.calls) == 1
    assert backend.calls[0]["native_project_graph_effect"] == "invalidate"

    replay = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert replay["replayed"] is True
    assert len(backend.calls) == 1
    records = [
        json.loads(line)
        for line in (tmp_path / "audit.jsonl").read_text().splitlines()
    ]
    assert [record["outcome"] for record in records] == [
        "dispatch-intent", "completed",
    ]
    assert all("arguments" not in record for record in records)
    assert all("path" not in json.dumps(record).lower() for record in records)
    assert all("media" not in json.dumps(record).lower() for record in records)


@pytest.mark.asyncio
async def test_same_key_conflict_is_not_dispatched(monkeypatch, tmp_path):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_LAYER_SOURCE_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "b" * 40)
    monkeypatch.setattr(S, "resolve_source_replacement", lambda *_args, **_kwargs: None)

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    async def reacquire(*_args, **_kwargs):
        return fresh_state()

    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    monkeypatch.setattr(S, "reacquire_source_state", reacquire)
    backend = ExecBackend(jsx_success())
    assert (await S.execute_layer_source_replace(
        backend, object(), args=args(),
    ))["ok"]
    other = locator("item", "99999999-9999-4999-8999-999999999999")
    rejected = await S.execute_layer_source_replace(
        backend, object(), args=args(source_item_locator=other),
    )
    assert rejected["error"]["code"] == "DUPLICATE_REQUEST"
    assert rejected["error"]["sideEffect"] == "not-started"
    assert len(backend.calls) == 1


@pytest.mark.asyncio
async def test_predispatch_rejection_is_bounded_and_same_key_never_resolves_again(
    monkeypatch,
):
    S.clear_replay_cache_for_tests()
    resolve_calls = 0

    async def reject(*_args, **_kwargs):
        nonlocal resolve_calls
        resolve_calls += 1
        raise ValueError("STALE_LOCATOR:target moved")

    monkeypatch.setattr(S, "resolve_source_replacement", reject)
    backend = ExecBackend(jsx_success())
    first = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    second = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert first["error"]["code"] == "STALE_LOCATOR"
    assert first["error"]["sideEffect"] == "not-started"
    assert second == {**deepcopy(first), "replayed": True}
    assert resolve_calls == 1
    assert backend.calls == []


@pytest.mark.asyncio
async def test_idempotency_outcomes_remain_bounded(monkeypatch):
    S.clear_replay_cache_for_tests()

    async def reject(*_args, **_kwargs):
        raise ValueError("STALE_LOCATOR:target moved")

    monkeypatch.setattr(S, "resolve_source_replacement", reject)
    backend = ExecBackend(jsx_success())
    for index in range(260):
        response = await S.execute_layer_source_replace(
            backend,
            object(),
            args=args(idempotency_key=f"source-bounded-{index:04d}"),
        )
        assert response["error"]["code"] == "STALE_LOCATOR"
    assert len(S._REPLAY) == 256


@pytest.mark.asyncio
async def test_template_guard_rejection_is_audited_and_never_redispatched(
    monkeypatch, tmp_path,
):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_LAYER_SOURCE_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "d" * 40)

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    backend = ExecBackend(template_rejection())
    first = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    second = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert first["error"]["code"] == "STALE_LOCATOR"
    assert second["replayed"] is True
    assert len(backend.calls) == 1
    records = [
        json.loads(line)
        for line in (tmp_path / "audit.jsonl").read_text().splitlines()
    ]
    assert [record["outcome"] for record in records] == [
        "dispatch-intent", "rejected",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value["error"].pop("recovery"),
        lambda value: value["error"].update({"unexpected": True}),
        lambda value: value["error"].update({"retryable": "false"}),
        lambda value: value["error"].update({"retryable": 0}),
        lambda value: value.update({"ok": 0}),
        lambda value: value["error"].update({"message": ""}),
        lambda value: value["error"]["recovery"].update({"hint": "x" * 1025}),
        lambda value: value["error"].update({
            "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "sideEffect": "not-started",
        }),
        lambda value: value["error"]["recovery"].update({
            "action": "reconcile-state",
        }),
    ],
    ids=[
        "missing-field",
        "extra-field",
        "wrong-string-type",
        "wrong-bool-integer-type",
        "wrong-ok-integer-type",
        "empty-string",
        "overlong-string",
        "invalid-code-side-effect-pairing",
        "invalid-recovery-pairing",
    ],
)
async def test_malformed_template_rejection_is_indeterminate_and_never_redispatched(
    monkeypatch, tmp_path, mutate,
):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_LAYER_SOURCE_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "f" * 40)

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    malformed = template_rejection()
    mutate(malformed)
    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    backend = ExecBackend(malformed)
    first = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert first["error"]["code"] == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert first["error"]["sideEffect"] == "possible"
    replay = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert replay == {**deepcopy(first), "replayed": True}
    assert len(backend.calls) == 1


@pytest.mark.asyncio
async def test_public_timeout_after_exec_returns_cached_indeterminate_without_redispatch(
    monkeypatch, tmp_path,
):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_LAYER_SOURCE_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "1" * 40)
    backend = NativeExecBackend(jsx_success())
    reacquire_started = asyncio.Event()

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    async def block_after_dispatch(*_args, **_kwargs):
        reacquire_started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    async def quick_timeout(ctx, coro, **_kwargs):
        try:
            return await asyncio.wait_for(coro, timeout=0.01)
        except asyncio.TimeoutError:
            return {"ok": False, "error": "generic outer timeout"}

    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    monkeypatch.setattr(S, "reacquire_source_state", block_after_dispatch)
    monkeypatch.setattr(native_handlers._discovery, "select_backend", lambda: backend)
    monkeypatch.setattr(native_handlers.progress, "run_with_timeout", quick_timeout)
    public_args = args()
    first = await native_handlers._run_set_layer_source(public_args, None)
    assert reacquire_started.is_set()
    assert first["error"]["code"] == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert first["error"]["details"]["idempotencyKey"] == KEY
    assert "audit" not in first
    operation_id = first["error"]["details"]["operationId"]
    assert operation_id.startswith("layer-source-")
    assert KEY in S._REPLAY
    replay = await native_handlers._run_set_layer_source(public_args, None)
    assert replay["replayed"] is True
    assert replay["error"]["details"]["operationId"] == operation_id
    assert len(backend.calls) == 1


@pytest.mark.asyncio
async def test_public_timeout_before_dispatch_remains_safe_and_uncached(
    monkeypatch,
):
    S.clear_replay_cache_for_tests()
    backend = NativeExecBackend(jsx_success())
    resolve_started = asyncio.Event()

    async def block_before_dispatch(*_args, **_kwargs):
        resolve_started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    async def quick_timeout(ctx, coro, **_kwargs):
        try:
            return await asyncio.wait_for(coro, timeout=0.01)
        except asyncio.TimeoutError:
            return {"ok": False, "error": "generic outer timeout"}

    monkeypatch.setattr(S, "resolve_source_replacement", block_before_dispatch)
    monkeypatch.setattr(native_handlers._discovery, "select_backend", lambda: backend)
    monkeypatch.setattr(native_handlers.progress, "run_with_timeout", quick_timeout)
    response = await native_handlers._run_set_layer_source(args(), None)
    assert resolve_started.is_set()
    assert response == {"ok": False, "error": "generic outer timeout"}
    assert backend.calls == []
    assert KEY not in S._REPLAY


@pytest.mark.asyncio
async def test_terminal_audit_failure_after_verified_success_is_cached_indeterminate(
    monkeypatch,
):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "2" * 40)
    backend = ExecBackend(jsx_success())
    audit_calls = 0

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    async def reacquire(*_args, **_kwargs):
        return fresh_state()

    def fail_terminal_audit(_record):
        nonlocal audit_calls
        audit_calls += 1
        if audit_calls > 1:
            raise OSError("terminal audit unavailable")

    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    monkeypatch.setattr(S, "reacquire_source_state", reacquire)
    monkeypatch.setattr(S, "_append_audit", fail_terminal_audit)
    first = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert first["error"]["code"] == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert "audit" not in first
    assert first["error"]["details"]["idempotencyKey"] == KEY
    replay = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert replay == {**deepcopy(first), "replayed": True}
    assert len(backend.calls) == 1
    assert KEY in S._REPLAY


@pytest.mark.asyncio
async def test_terminal_audit_failure_on_indeterminate_is_still_cached(
    monkeypatch,
):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "3" * 40)
    backend = ExecBackend(TimeoutError("transport timed out"))
    audit_calls = 0

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    def fail_terminal_audit(_record):
        nonlocal audit_calls
        audit_calls += 1
        if audit_calls > 1:
            raise OSError("terminal audit unavailable")

    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    monkeypatch.setattr(S, "_append_audit", fail_terminal_audit)
    first = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert first["error"]["code"] == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    replay = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert replay == {**deepcopy(first), "replayed": True}
    assert len(backend.calls) == 1
    assert KEY in S._REPLAY


@pytest.mark.asyncio
async def test_dispatch_intent_audit_failure_stays_predispatch(
    monkeypatch,
):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "4" * 40)
    backend = ExecBackend(jsx_success())

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    def fail_audit(_record):
        raise OSError("dispatch intent audit unavailable")

    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    monkeypatch.setattr(S, "_append_audit", fail_audit)
    with pytest.raises(OSError, match="dispatch intent audit unavailable"):
        await S.execute_layer_source_replace(
            backend, object(), args=args(),
        )
    assert backend.calls == []
    assert KEY not in S._REPLAY


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure",
    [
        TimeoutError("timeout"),
        ConnectionError("disconnect"),
        "{malformed",
        {"ok": True, "value": {"unexpected": True}},
        RuntimeError("postcondition unavailable"),
    ],
)
async def test_possible_dispatch_failures_become_bounded_indeterminate_without_retry(
    monkeypatch, tmp_path, failure,
):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_LAYER_SOURCE_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "c" * 40)

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    async def reacquire(*_args, **_kwargs):
        if isinstance(failure, RuntimeError):
            raise failure
        return fresh_state()

    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    monkeypatch.setattr(S, "reacquire_source_state", reacquire)
    backend_result = (
        jsx_success()
        if isinstance(failure, RuntimeError)
        else failure
    )
    backend = ExecBackend(backend_result)
    first = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert first["error"]["code"] == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert first["error"]["retryable"] is False
    assert first["error"]["sideEffect"] == "possible"
    assert first["error"]["details"]["idempotencyKey"] == KEY
    assert first["error"]["details"]["operationId"].startswith("layer-source-")
    replay = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert replay == {**deepcopy(first), "replayed": True}
    assert len(backend.calls) == 1
    records = [
        json.loads(line)
        for line in (tmp_path / "audit.jsonl").read_text().splitlines()
    ]
    assert [record["outcome"] for record in records] == [
        "dispatch-intent", "indeterminate",
    ]


@pytest.mark.asyncio
async def test_incomplete_but_equal_invariant_snapshots_are_indeterminate(
    monkeypatch, tmp_path,
):
    S.clear_replay_cache_for_tests()
    monkeypatch.setenv("AE_MCP_LAYER_SOURCE_AUDIT_PATH", str(tmp_path / "audit.jsonl"))
    monkeypatch.setenv("AE_MCP_SOURCE_COMMIT_SHA", "e" * 40)

    async def resolve_address(*_args, **_kwargs):
        return resolved()

    reacquire_calls = 0

    async def unexpected_reacquire(*_args, **_kwargs):
        nonlocal reacquire_calls
        reacquire_calls += 1
        return fresh_state()

    malformed = jsx_success()
    del malformed["value"]["beforeInvariant"]["audioEnabled"]
    del malformed["value"]["afterInvariant"]["audioEnabled"]
    monkeypatch.setattr(S, "resolve_source_replacement", resolve_address)
    monkeypatch.setattr(S, "reacquire_source_state", unexpected_reacquire)
    backend = ExecBackend(malformed)
    response = await S.execute_layer_source_replace(
        backend, object(), args=args(),
    )
    assert response["error"]["code"] == "POSSIBLY_SIDE_EFFECTING_FAILURE"
    assert reacquire_calls == 0
