"""Bounded maintained-JSX replacement for one ordinary AV layer source."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Any, Literal, Mapping

from pydantic import StrictStr, model_validator

from ae_mcp.backends.maintained_text import (
    _core_version,
    _source_commit,
    canonical_bytes,
    digest,
)
from ae_mcp.backends.native import (
    NativeCancellationToken,
    NativeInvokeBackend,
    NativeLocator,
    PositiveInt,
    _NativeModel,
    invoke_composition_layers_list,
    invoke_project_items_list,
)
from ae_mcp.backends.native_layer_source_matte_av import (
    invoke_layer_source_read,
)
from ae_mcp.jsx_prelude import with_prelude
from ae_mcp.jsx_result import parse_jsx_result


TEMPLATE_ID = "aemcp.layer.source.replace.v1"
TEMPLATE_PATH = (
    Path(__file__).resolve().parent.parent
    / "jsx_templates"
    / "layer_source_replace.jsx"
)
TEMPLATE_DIGEST = "2353317ea9e25d836dcc50284c9ab4aa534a2b84955e2fcb1ea78b9343af5fad"
AUDIT_ENV = "AE_MCP_LAYER_SOURCE_AUDIT_PATH"
CONTRACT_ID = "ae.layer.source.set"
CONTRACT_VERSION = 1
MAX_REPLAY_ENTRIES = 256
INVARIANT_FIELDS = frozenset(
    {
        "name",
        "inPoint",
        "outPoint",
        "startTime",
        "stretch",
        "parentIndex",
        "enabled",
        "audioEnabled",
        "solo",
        "shy",
        "locked",
        "guideLayer",
        "threeDLayer",
        "adjustmentLayer",
        "motionBlur",
        "collapseTransformation",
        "effectsActive",
        "frameBlending",
        "timeRemapEnabled",
        "preserveTransparency",
        "quality",
        "blendingMode",
        "trackMatteType",
        "trackMatteLayerIndex",
    }
)


class ResolvedSourceReplacement(_NativeModel):
    composition_project_item_index: PositiveInt
    expected_composition_name: StrictStr
    expected_composition_type: Literal["composition"]
    layer_index: PositiveInt
    expected_layer_name: StrictStr
    expected_layer_type: Literal["av"]
    current_source_project_item_index: PositiveInt
    expected_current_source_name: StrictStr
    expected_current_source_type: Literal["footage", "composition"]
    new_source_project_item_index: PositiveInt
    expected_new_source_name: StrictStr
    expected_new_source_type: Literal["footage", "composition"]


class ReacquiredSourceState(_NativeModel):
    project_locator: NativeLocator
    composition_locator: NativeLocator
    layer_locator: NativeLocator
    before_source_item_locator: NativeLocator
    after_source_item_locator: NativeLocator
    source_type: Literal["footage", "composition"]
    source_name: StrictStr

    @model_validator(mode="after")
    def _fresh_context(self) -> "ReacquiredSourceState":
        context = self.project_locator.context()
        locators = (
            self.composition_locator,
            self.layer_locator,
            self.before_source_item_locator,
            self.after_source_item_locator,
        )
        if self.project_locator.kind != "project" or any(
            locator.context() != context for locator in locators
        ):
            raise ValueError("reacquired source state escaped one native graph")
        if (
            self.composition_locator.kind != "composition"
            or self.layer_locator.kind != "layer"
            or self.before_source_item_locator.kind not in {"item", "composition"}
            or self.after_source_item_locator.kind not in {"item", "composition"}
        ):
            raise ValueError("reacquired source state contains wrong locator kinds")
        expected_kind = (
            "composition" if self.source_type == "composition" else "item"
        )
        if self.after_source_item_locator.kind != expected_kind:
            raise ValueError("reacquired source type and locator kind disagree")
        return self


def _native_locator(value: Any) -> NativeLocator:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json", by_alias=True)
    return NativeLocator.model_validate(value)


async def _project_item_rows(
    backend: NativeInvokeBackend,
    *,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken,
) -> tuple[NativeLocator, list[tuple[int, Any]]]:
    offset = 0
    project_locator: NativeLocator | None = None
    rows: list[tuple[int, Any]] = []
    while True:
        execution = await invoke_project_items_list(
            backend,
            request_id=f"layer-source-items-{uuid.uuid4().hex}",
            project_locator=project_locator,
            offset=offset,
            limit=50,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        page = execution.value
        if project_locator is None:
            project_locator = page.project_locator
        elif page.project_locator != project_locator:
            raise RuntimeError("native project-item pages changed graph context")
        rows.extend(
            (page.offset + row_index + 1, item)
            for row_index, item in enumerate(page.items)
        )
        if not page.has_more:
            if project_locator is None:
                raise RuntimeError("native project-item read omitted project locator")
            return project_locator, rows
        if page.next_offset is None:
            raise RuntimeError("native project-item resolver omitted nextOffset")
        offset = page.next_offset


async def _composition_layer_rows(
    backend: NativeInvokeBackend,
    composition_locator: NativeLocator,
    *,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken,
) -> list[Any]:
    offset = 0
    rows: list[Any] = []
    while True:
        execution = await invoke_composition_layers_list(
            backend,
            request_id=f"layer-source-layers-{uuid.uuid4().hex}",
            composition_locator=composition_locator,
            offset=offset,
            limit=50,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        page = execution.value
        if page.composition_locator != composition_locator:
            raise RuntimeError("native layer page changed composition locator")
        rows.extend(page.layers)
        if not page.has_more:
            return rows
        if page.next_offset is None:
            raise RuntimeError("native composition-layer resolver omitted nextOffset")
        offset = page.next_offset


def _exact_locator_match(
    rows: list[tuple[int, Any]],
    locator: NativeLocator,
    *,
    label: str,
) -> tuple[int, Any]:
    matches = [(position, row) for position, row in rows if row.locator == locator]
    if len(matches) != 1:
        raise ValueError(
            f"STALE_LOCATOR:{label} locator did not resolve exactly once"
        )
    return matches[0]


async def resolve_source_replacement(
    backend: NativeInvokeBackend,
    layer_locator: Any,
    source_item_locator: Any,
    *,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken,
) -> ResolvedSourceReplacement:
    """Resolve exactly two project items, one composition, and one layer."""

    target = _native_locator(layer_locator)
    requested_source = _native_locator(source_item_locator)
    if target.kind != "layer":
        raise ValueError("STALE_LOCATOR:target locator is not a layer")
    if requested_source.kind not in {"item", "composition"}:
        raise ValueError("SOURCE_ITEM_NOT_AV:source locator is not a project item")
    if target.context() != requested_source.context():
        raise ValueError("STALE_LOCATOR:source and layer locator contexts differ")

    _project_locator, project_rows = await _project_item_rows(
        backend,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    new_source_position, new_source = _exact_locator_match(
        project_rows, requested_source, label="new source"
    )
    if new_source.type not in {"footage", "composition"}:
        raise ValueError("SOURCE_ITEM_NOT_AV:new source is not footage or composition")

    layer_matches: list[tuple[int, Any, Any]] = []
    for composition_position, composition in project_rows:
        if composition.type != "composition":
            continue
        if composition.locator.context() != target.context():
            continue
        layers = await _composition_layer_rows(
            backend,
            composition.locator,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        for layer in layers:
            if layer.locator == target:
                layer_matches.append((composition_position, composition, layer))
    if len(layer_matches) != 1:
        raise ValueError(
            "STALE_LOCATOR:target layer locator did not resolve exactly once"
        )
    composition_position, composition, layer = layer_matches[0]
    if layer.type != "av":
        raise ValueError(
            "LAYER_SOURCE_NOT_REPLACEABLE:target is not an ordinary AV layer"
        )
    if layer.source_item_locator is None:
        raise ValueError(
            "LAYER_SOURCE_NOT_REPLACEABLE:target layer has no current source"
        )
    if layer.source_item_locator == requested_source:
        raise ValueError("VALUE_UNCHANGED:requested source is already active")
    old_source_position, old_source = _exact_locator_match(
        project_rows, layer.source_item_locator, label="current source"
    )
    if old_source.type not in {"footage", "composition"}:
        raise ValueError(
            "LAYER_SOURCE_NOT_REPLACEABLE:current source is not replaceable"
        )

    source_execution = await invoke_layer_source_read(
        backend,
        request_id=f"layer-source-pre-read-{uuid.uuid4().hex}",
        layer_locator=target,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    source = source_execution.value
    if (
        source.layer_locator != target
        or source.source_item_locator != old_source.locator
        or source.source_type != old_source.type
        or source.source_name != old_source.name
    ):
        raise ValueError(
            "STALE_LOCATOR:native current source did not match the bounded layer row"
        )
    return ResolvedSourceReplacement(
        composition_project_item_index=composition_position,
        expected_composition_name=composition.name,
        expected_composition_type="composition",
        layer_index=layer.stack_index,
        expected_layer_name=layer.name,
        expected_layer_type="av",
        current_source_project_item_index=old_source_position,
        expected_current_source_name=old_source.name,
        expected_current_source_type=old_source.type,
        new_source_project_item_index=new_source_position,
        expected_new_source_name=new_source.name,
        expected_new_source_type=new_source.type,
    )


def _bounded_position_match(
    rows: list[tuple[int, Any]],
    position: int,
    name: str,
    item_type: str,
    *,
    label: str,
) -> Any:
    matches = [
        item
        for row_position, item in rows
        if row_position == position and item.name == name and item.type == item_type
    ]
    if len(matches) != 1:
        raise RuntimeError(f"{label} could not be reacquired exactly once")
    return matches[0]


async def reacquire_source_state(
    backend: NativeInvokeBackend,
    address: ResolvedSourceReplacement,
    *,
    deadline_unix_ms: int,
    cancellation: NativeCancellationToken,
) -> ReacquiredSourceState:
    """Reacquire every native locator after CEP invalidated the graph."""

    project_locator, project_rows = await _project_item_rows(
        backend,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    composition = _bounded_position_match(
        project_rows,
        address.composition_project_item_index,
        address.expected_composition_name,
        address.expected_composition_type,
        label="composition",
    )
    before_source = _bounded_position_match(
        project_rows,
        address.current_source_project_item_index,
        address.expected_current_source_name,
        address.expected_current_source_type,
        label="before source",
    )
    after_source = _bounded_position_match(
        project_rows,
        address.new_source_project_item_index,
        address.expected_new_source_name,
        address.expected_new_source_type,
        label="after source",
    )
    layer_matches = [
        layer
        for layer in await _composition_layer_rows(
            backend,
            composition.locator,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
        if (
            layer.stack_index == address.layer_index
            and layer.name == address.expected_layer_name
            and layer.type == address.expected_layer_type
        )
    ]
    if len(layer_matches) != 1:
        raise RuntimeError("target layer could not be reacquired exactly once")
    layer = layer_matches[0]
    if layer.source_item_locator != after_source.locator:
        raise RuntimeError("reacquired layer row does not show the requested source")
    source_execution = await invoke_layer_source_read(
        backend,
        request_id=f"layer-source-post-read-{uuid.uuid4().hex}",
        layer_locator=layer.locator,
        deadline_unix_ms=deadline_unix_ms,
        cancellation=cancellation,
    )
    source = source_execution.value
    if (
        source.layer_locator != layer.locator
        or source.source_item_locator != after_source.locator
        or source.source_type != address.expected_new_source_type
        or source.source_name != address.expected_new_source_name
    ):
        raise RuntimeError(
            "independent native source read did not verify the requested transition"
        )
    return ReacquiredSourceState(
        project_locator=project_locator,
        composition_locator=composition.locator,
        layer_locator=layer.locator,
        before_source_item_locator=before_source.locator,
        after_source_item_locator=after_source.locator,
        source_type=source.source_type,
        source_name=source.source_name,
    )


def render_layer_source_replace(
    args: Any,
    *,
    resolved_address: ResolvedSourceReplacement,
    undo_group: str,
) -> tuple[str, dict[str, str]]:
    raw_template = TEMPLATE_PATH.read_bytes()
    actual_digest = hashlib.sha256(raw_template).hexdigest()
    if actual_digest != TEMPLATE_DIGEST:
        raise RuntimeError("maintained layer source template digest changed")
    request = args.model_dump(mode="json", by_alias=False)
    request.pop("layer_locator")
    request.pop("source_item_locator")
    request["_resolved"] = resolved_address.model_dump(
        mode="json", by_alias=False
    )
    request["undo_group"] = undo_group
    request_literal = json.dumps(
        request,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )
    template = raw_template.decode("utf-8")
    body = template.replace("__AEMCP_LAYER_SOURCE_REQUEST__", request_literal)
    if "__AEMCP_LAYER_SOURCE_" in body:
        raise RuntimeError(
            "maintained layer source template contains an unresolved placeholder"
        )
    return with_prelude(body), {
        "templateId": TEMPLATE_ID,
        "templateDigest": TEMPLATE_DIGEST,
    }


def _audit_path() -> Path:
    configured = os.environ.get(AUDIT_ENV)
    if configured:
        return Path(configured)
    return (
        Path.home()
        / "Library"
        / "Application Support"
        / "AfterEffectsMCP"
        / "layer-source-replacement-v1"
        / "audit.jsonl"
    )


def _append_audit(record: Mapping[str, Any]) -> None:
    path = _audit_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
    try:
        os.write(descriptor, canonical_bytes(record) + b"\n")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


_REPLAY_LOCK = asyncio.Lock()
_REPLAY: OrderedDict[
    str,
    tuple[
        str,
        Literal["not-dispatched", "rejected", "completed", "indeterminate"],
        dict[str, Any],
    ],
] = OrderedDict()
_KEY_LOCKS: dict[str, asyncio.Lock] = {}


def _record_replay(
    idempotency_key: str,
    request_digest: str,
    status: Literal[
        "not-dispatched", "rejected", "completed", "indeterminate"
    ],
    response: dict[str, Any],
) -> None:
    _REPLAY[idempotency_key] = (request_digest, status, response)
    _REPLAY.move_to_end(idempotency_key)
    while len(_REPLAY) > MAX_REPLAY_ENTRIES:
        evicted_key, _outcome = _REPLAY.popitem(last=False)
        evicted_lock = _KEY_LOCKS.get(evicted_key)
        if evicted_lock is not None and not evicted_lock.locked():
            _KEY_LOCKS.pop(evicted_key, None)


def _duplicate_request(idempotency_key: str) -> dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "code": "DUPLICATE_REQUEST",
            "message": "idempotency key is already bound to different arguments",
            "retryable": False,
            "sideEffect": "not-started",
            "recovery": {
                "action": "use-original-request",
                "hint": "Reuse this key only for the original business intent.",
            },
            "details": {"idempotencyKey": idempotency_key},
        },
    }


def _pre_dispatch_error(exc: ValueError) -> dict[str, Any]:
    message = str(exc)
    code, separator, detail = message.partition(":")
    if not separator or code not in {
        "STALE_LOCATOR",
        "LAYER_SOURCE_NOT_REPLACEABLE",
        "SOURCE_ITEM_NOT_AV",
        "VALUE_UNCHANGED",
    }:
        code = "LAYER_SOURCE_NOT_REPLACEABLE"
        detail = "Source replacement preconditions were not satisfied."
    return {
        "ok": False,
        "error": {
            "code": code,
            "message": detail,
            "retryable": False,
            "sideEffect": "not-started",
            "recovery": {
                "action": "refresh-locators",
                "hint": (
                    "Refresh project and layer locators or change the requested "
                    "source before submitting a new intent."
                ),
            },
        },
    }


def _indeterminate(
    *,
    operation_id: str,
    idempotency_key: str,
) -> dict[str, Any]:
    return {
        "ok": False,
        "error": {
            "code": "POSSIBLY_SIDE_EFFECTING_FAILURE",
            "message": (
                "Source replacement may have reached After Effects, but its "
                "terminal state could not be verified."
            ),
            "retryable": False,
            "sideEffect": "possible",
            "recovery": {
                "action": "reconcile-state",
                "hint": (
                    "Rediscover all project and layer locators, read the layer "
                    "source, and inspect the audit outcome before any retry."
                ),
            },
            "details": {
                "operationId": operation_id,
                "idempotencyKey": idempotency_key,
            },
        },
    }


def _validate_jsx_value(
    raw_value: Any,
    address: ResolvedSourceReplacement,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    if not isinstance(raw_value, Mapping):
        raise ValueError("source template omitted its value")
    observed = ResolvedSourceReplacement.model_validate(raw_value.get("_resolved"))
    if observed != address:
        raise ValueError("source template changed its bounded target")
    before_source = raw_value.get("beforeSource")
    after_source = raw_value.get("afterSource")
    before_invariant = raw_value.get("beforeInvariant")
    after_invariant = raw_value.get("afterInvariant")
    expected_before = {
        "projectItemIndex": address.current_source_project_item_index,
        "name": address.expected_current_source_name,
        "type": address.expected_current_source_type,
    }
    expected_after = {
        "projectItemIndex": address.new_source_project_item_index,
        "name": address.expected_new_source_name,
        "type": address.expected_new_source_type,
    }
    if before_source != expected_before or after_source != expected_after:
        raise ValueError("source template transition did not match the request")
    if (
        not isinstance(before_invariant, Mapping)
        or not isinstance(after_invariant, Mapping)
        or frozenset(before_invariant) != INVARIANT_FIELDS
        or frozenset(after_invariant) != INVARIANT_FIELDS
        or dict(before_invariant) != dict(after_invariant)
    ):
        raise ValueError("source replacement changed a preserved layer invariant")
    return dict(before_source), dict(before_invariant), dict(after_invariant)


async def _execute_serialized(
    exec_backend: Any,
    native_backend: NativeInvokeBackend,
    *,
    args: Any,
) -> dict[str, Any]:
    request_payload = args.model_dump(mode="json", by_alias=False)
    request_digest = digest(
        {"tool": "ae.setLayerSource", "arguments": request_payload}
    )
    idempotency_key = args.idempotency_key
    async with _REPLAY_LOCK:
        replay = _REPLAY.get(idempotency_key)
        if replay is not None:
            prior_digest, _status, prior_response = replay
            if prior_digest != request_digest:
                return _duplicate_request(idempotency_key)
            response = json.loads(json.dumps(prior_response))
            response["replayed"] = True
            return response

    cancellation = NativeCancellationToken()
    deadline_unix_ms = int(time.time() * 1000) + 30_000
    try:
        address = await resolve_source_replacement(
            native_backend,
            args.layer_locator,
            args.source_item_locator,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
    except ValueError as exc:
        response = _pre_dispatch_error(exc)
        async with _REPLAY_LOCK:
            _record_replay(
                idempotency_key,
                request_digest,
                "not-dispatched",
                response,
            )
        return response

    operation_id = f"layer-source-{uuid.uuid4().hex}"
    undo_group = operation_id
    jsx, template = render_layer_source_replace(
        args,
        resolved_address=address,
        undo_group=undo_group,
    )
    source_commit = _source_commit()
    contract_digest = digest(
        {
            "contractId": CONTRACT_ID,
            "contractVersion": CONTRACT_VERSION,
            "inputSchema": type(args).model_json_schema(),
            "templateDigest": TEMPLATE_DIGEST,
        }
    )
    started = int(time.time() * 1000)
    audit_base = {
        "operationId": operation_id,
        "idempotencyKey": idempotency_key,
        "tool": "ae.setLayerSource",
        "requestDigest": request_digest,
        "contractDigest": contract_digest,
        "templateDigest": template["templateDigest"],
        "startedAtUnixMs": started,
    }
    _append_audit({**audit_base, "outcome": "dispatch-intent"})

    try:
        raw = await exec_backend.exec(
            code=jsx,
            timeout_sec=30.0,
            native_project_graph_effect="invalidate",
        )
        parsed = parse_jsx_result(raw)
        if not isinstance(parsed, Mapping) or parsed.get("ok") is not True:
            if (
                isinstance(parsed, Mapping)
                and parsed.get("ok") is False
                and isinstance(parsed.get("error"), Mapping)
                and parsed["error"].get("sideEffect") == "not-started"
            ):
                response = dict(parsed)
                response["replayed"] = False
                completed = int(time.time() * 1000)
                _append_audit(
                    {
                        **audit_base,
                        "outcome": "rejected",
                        "completedAtUnixMs": completed,
                    }
                )
                async with _REPLAY_LOCK:
                    _record_replay(
                        idempotency_key,
                        request_digest,
                        "rejected",
                        response,
                    )
                return response
            raise ValueError("maintained template returned an untrusted result")
        _before_source, before_invariant, after_invariant = _validate_jsx_value(
            parsed.get("value"), address
        )
        fresh = await reacquire_source_state(
            native_backend,
            address,
            deadline_unix_ms=deadline_unix_ms,
            cancellation=cancellation,
        )
    except Exception:
        response = _indeterminate(
            operation_id=operation_id,
            idempotency_key=idempotency_key,
        )
        completed = int(time.time() * 1000)
        _append_audit(
            {
                **audit_base,
                "outcome": "indeterminate",
                "completedAtUnixMs": completed,
            }
        )
        async with _REPLAY_LOCK:
            _record_replay(
                idempotency_key,
                request_digest,
                "indeterminate",
                response,
            )
        return response

    wire_value = {
        "changed": True,
        "compositionLocator": fresh.composition_locator.model_dump(
            mode="json", by_alias=True
        ),
        "layerLocator": fresh.layer_locator.model_dump(
            mode="json", by_alias=True
        ),
        "beforeSourceItemLocator": fresh.before_source_item_locator.model_dump(
            mode="json", by_alias=True
        ),
        "afterSourceItemLocator": fresh.after_source_item_locator.model_dump(
            mode="json", by_alias=True
        ),
        "beforeSource": {
            "sourceItemLocator": fresh.before_source_item_locator.model_dump(
                mode="json", by_alias=True
            ),
            "sourceType": address.expected_current_source_type,
            "sourceName": address.expected_current_source_name,
        },
        "afterSource": {
            "sourceItemLocator": fresh.after_source_item_locator.model_dump(
                mode="json", by_alias=True
            ),
            "sourceType": fresh.source_type,
            "sourceName": fresh.source_name,
        },
        "beforeInvariant": before_invariant,
        "afterInvariant": after_invariant,
    }
    postcondition_digest = digest(
        {
            "tool": "ae.setLayerSource",
            "contractVersion": CONTRACT_VERSION,
            "value": wire_value,
        }
    )
    completed = int(time.time() * 1000)
    response = {
        "ok": True,
        "replayed": False,
        "value": wire_value,
        "implementation": {
            "engine": "maintained-jsx",
            "contractId": CONTRACT_ID,
            "contractVersion": CONTRACT_VERSION,
            "contractDigest": contract_digest,
            "templateId": template["templateId"],
            "templateDigest": template["templateDigest"],
            "mutability": "mutating",
            "idempotency": "idempotency-key",
            "undo": "ae-undo-group",
            "callerCodeAccepted": False,
        },
        "provenance": {
            "engine": "maintained-jsx",
            "sourceCommit": source_commit,
            "coreVersion": _core_version(),
            "templateId": template["templateId"],
            "templateDigest": template["templateDigest"],
            "callerCodeAccepted": False,
            "hostInstanceId": args.layer_locator.host_instance_id,
            "sessionId": args.layer_locator.session_id,
            "projectId": args.layer_locator.project_id,
            "projectGenerationBefore": args.layer_locator.generation,
            "projectGenerationAfter": fresh.project_locator.generation,
        },
        "audit": {
            "operationId": operation_id,
            "idempotencyKey": idempotency_key,
            "replayed": False,
            "contractId": CONTRACT_ID,
            "contractDigest": contract_digest,
            "effect": "committed",
            "requestDigest": request_digest,
            "postconditionAlgorithm": "sha256-rfc8785-jcs-v1",
            "postconditionDigest": postcondition_digest,
            "undoAvailable": True,
            "undoVerified": False,
            "startedAtUnixMs": started,
            "completedAtUnixMs": completed,
        },
        "evidence": {
            "postcondition": {
                "verified": True,
                "kind": "layer-source-replace",
                "algorithm": "sha256-rfc8785-jcs-v1",
                "digest": postcondition_digest,
            },
            "undo": {
                "available": True,
                "verified": False,
                "groupId": undo_group,
            },
        },
    }
    _append_audit(
        {
            **audit_base,
            "outcome": "completed",
            "postconditionDigest": postcondition_digest,
            "completedAtUnixMs": completed,
        }
    )
    async with _REPLAY_LOCK:
        _record_replay(
            idempotency_key,
            request_digest,
            "completed",
            response,
        )
    return response


async def execute_layer_source_replace(
    exec_backend: Any,
    native_backend: NativeInvokeBackend,
    *,
    args: Any,
) -> dict[str, Any]:
    key = args.idempotency_key
    async with _REPLAY_LOCK:
        key_lock = _KEY_LOCKS.setdefault(key, asyncio.Lock())
    async with key_lock:
        return await _execute_serialized(
            exec_backend,
            native_backend,
            args=args,
        )


def clear_replay_cache_for_tests() -> None:
    _REPLAY.clear()
    _KEY_LOCKS.clear()


__all__ = [
    "ReacquiredSourceState",
    "ResolvedSourceReplacement",
    "TEMPLATE_DIGEST",
    "TEMPLATE_ID",
    "TEMPLATE_PATH",
    "clear_replay_cache_for_tests",
    "execute_layer_source_replace",
    "reacquire_source_state",
    "render_layer_source_replace",
    "resolve_source_replacement",
]
