"""Conservative Tool Library candidates from successful MCP tool calls."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import re
from typing import Any

from ae_mcp.tool_artifact import (
    JsonValue,
    ToolArtifact,
    ToolArtifactDraft,
    ToolSource,
    canonical_json_bytes,
    compute_content_hash,
)
from ae_mcp.tool_secrets import (
    SecretDetectedError,
    SecretScanner,
    require_secret_free,
)
from ae_mcp.tool_store import ToolArtifactStore


_STRING_LITERAL = re.compile(r"(?P<quote>['\"])(?P<body>(?:\\.|(?!\1).)*)\1", re.DOTALL)


@dataclass(frozen=True)
class HistoryContext:
    client: str
    request_id: str | None
    created_at: int

    def __post_init__(self) -> None:
        if not isinstance(self.client, str) or not self.client.strip():
            raise ValueError("history client must be a non-empty string")
        if len(self.client) > 256:
            raise ValueError("history client exceeds 256 characters")
        if self.request_id is not None and (
            not isinstance(self.request_id, str)
            or not self.request_id
            or len(self.request_id) > 512
        ):
            raise ValueError("history request id is invalid")
        if (
            isinstance(self.created_at, bool)
            or not isinstance(self.created_at, int)
            or self.created_at < 0
        ):
            raise ValueError("history created_at must be a non-negative integer")


def _source(verb_name: str, context: HistoryContext) -> ToolSource:
    return ToolSource(
        type="chat-tool-call",
        ref=context.request_id or f"{verb_name}:{context.created_at}",
        client=context.client,
        product_version=None,
        provenance={
            "verbName": verb_name,
            "requestId": context.request_id,
            "capturedAt": context.created_at,
        },
    )


def _bounded_name(value: object, fallback: str) -> str:
    if isinstance(value, str) and value.strip():
        return value.strip()[:128]
    return fallback[:128]


def extract_history_draft(
    verb_name: str,
    arguments: Mapping[str, JsonValue],
    result: Any,
    context: HistoryContext,
) -> ToolArtifactDraft | None:
    if not isinstance(verb_name, str) or not isinstance(arguments, Mapping):
        return None
    if not isinstance(context, HistoryContext):
        return None
    if not isinstance(result, Mapping) or result.get("ok") is not True:
        return None
    if verb_name in {"ae.skillCreate", "ae.skillEdit"} or verb_name.startswith("ae.tool"):
        return None
    if verb_name == "ae.exec":
        content = arguments.get("code")
        if not isinstance(content, str) or not content.strip():
            return None
        return ToolArtifactDraft(
            name=_bounded_name(arguments.get("undo_group_name"), "Captured AE execution"),
            description="Captured from a successful MCP tool call.",
            kind="jsx",
            category="workflow",
            tags=(),
            compatibility={},
            declared_risk="write",
            source=_source(verb_name, context),
            status="candidate",
            content=content,
            args_schema={},
        )
    for field in ("expression", "expression_text"):
        content = arguments.get(field)
        if not isinstance(content, str) or not content.strip():
            continue
        return ToolArtifactDraft(
            name=_bounded_name(
                arguments.get("name"),
                f"Expression from {verb_name}",
            ),
            description="Captured from a successful MCP tool call.",
            kind="expression",
            category="workflow",
            tags=(),
            compatibility={},
            declared_risk="write",
            source=_source(verb_name, context),
            status="candidate",
            content=content,
            args_schema={},
        )
    return None


def _scan_draft(scanner: SecretScanner, draft: ToolArtifactDraft) -> None:
    source = draft.source
    value: dict[str, JsonValue] = {
        "name": draft.name,
        "description": draft.description,
        "kind": draft.kind,
        "category": draft.category,
        "tags": list(draft.tags),
        "compatibility": dict(draft.compatibility),
        "declaredRisk": draft.declared_risk,
        "source": {
            "type": source.type,
            "ref": source.ref,
            "client": source.client,
            "productVersion": source.product_version,
            "provenance": dict(source.provenance),
        },
        "status": draft.status,
        "content": draft.content,
        "argsSchema": dict(draft.args_schema),
    }
    require_secret_free(
        scanner,
        name="history-candidate.json",
        data=canonical_json_bytes(value),
    )
    if isinstance(draft.content, str):
        for match in _STRING_LITERAL.finditer(draft.content):
            require_secret_free(
                scanner,
                name="history-candidate-literal.txt",
                data=match.group("body").encode("utf-8"),
            )


def _matching_history_candidate(
    store: ToolArtifactStore,
    draft: ToolArtifactDraft,
) -> ToolArtifact | None:
    content_hash = compute_content_hash(draft.kind, draft.content, draft.args_schema)
    matches = store.find_by_content_hash(
        draft.kind,
        content_hash,
        statuses={"candidate"},
    )
    for summary in sorted(matches, key=lambda item: item.id):
        artifact = store.get(summary.id)
        if artifact.source.type == "chat-tool-call":
            return artifact
    return None


def capture_history_candidate(
    *,
    store: ToolArtifactStore,
    scanner: SecretScanner,
    verb_name: str,
    arguments: Mapping[str, JsonValue],
    result: Any,
    context: HistoryContext,
) -> ToolArtifact | None:
    draft = extract_history_draft(verb_name, arguments, result, context)
    if draft is None:
        return None
    try:
        _scan_draft(scanner, draft)
    except SecretDetectedError:
        return None
    existing = _matching_history_candidate(store, draft)
    if existing is None:
        return store.create(draft)
    provenance = dict(existing.source.provenance)
    provenance.update(
        {
            "lastRequestId": context.request_id,
            "lastClient": context.client,
            "capturedAt": context.created_at,
        }
    )
    return store.edit(
        existing.id,
        {
            "lastUsedAt": context.created_at,
            "sourceProvenance": provenance,
        },
        expected_revision=existing.revision,
        expected_content_hash=existing.content_hash,
    )


__all__ = [
    "HistoryContext",
    "capture_history_candidate",
    "extract_history_draft",
]
