"""Crash-safe, redacted recovery records for Tool Library executions."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

from ae_mcp.tool_artifact import JsonValue
from ae_mcp.tool_audit import redact_audit_value
from ae_mcp.tool_store import StoreLock, ToolStoreError, atomic_write_json


EXECUTION_HISTORY_SCHEMA_VERSION = 1
EXECUTION_HISTORY_MAX_RECORDS = 500

_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_TERMINAL_STATUSES = frozenset(
    {"succeeded", "failed", "cancelled", "outcome-unknown"}
)
_OPERATIONS = frozenset({"render", "execute", "apply"})


class ExecutionJobStoreError(RuntimeError):
    code = "tool_execution_history_failed"


def _bounded_string(value: Any, *, minimum: int = 1, maximum: int = 256) -> str:
    if not isinstance(value, str) or not minimum <= len(value) <= maximum:
        raise ExecutionJobStoreError("Execution history contains an invalid string.")
    return value


def _timestamp(value: Any, *, optional: bool = False) -> int | None:
    if value is None and optional:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ExecutionJobStoreError("Execution history contains an invalid timestamp.")
    return value


def _optional_mapping(value: Any) -> Mapping[str, JsonValue] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ExecutionJobStoreError("Execution history payload must be an object.")

    def strip_ephemeral(item: JsonValue) -> JsonValue:
        if isinstance(item, dict):
            return {
                key: strip_ephemeral(child)
                for key, child in item.items()
                if re.sub(r"[^a-z0-9]", "", key.casefold())
                not in {"grant", "grantid", "grantscope"}
            }
        if isinstance(item, list):
            return [strip_ephemeral(child) for child in item]
        return item

    redacted = redact_audit_value(strip_ephemeral(cast(JsonValue, dict(value))))
    if not isinstance(redacted, dict):
        raise ExecutionJobStoreError("Execution history payload is invalid.")
    return cast(Mapping[str, JsonValue], redacted)


def _normalize(record: Mapping[str, Any]) -> dict[str, JsonValue]:
    execution_id = _bounded_string(record.get("executionId"), maximum=128)
    operation_id = _bounded_string(
        record.get("operationId"), minimum=16, maximum=128
    )
    artifact_id = _bounded_string(record.get("artifactId"), maximum=256)
    content_hash = _bounded_string(record.get("contentHash"), minimum=64, maximum=64)
    plan_hash = _bounded_string(record.get("planHash"), minimum=64, maximum=64)
    if not _HEX_64.fullmatch(content_hash) or not _HEX_64.fullmatch(plan_hash):
        raise ExecutionJobStoreError("Execution history hashes are invalid.")
    revision = record.get("artifactRevision")
    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
        raise ExecutionJobStoreError("Execution history revision is invalid.")
    operation = _bounded_string(record.get("operation"), maximum=16)
    if operation not in _OPERATIONS:
        raise ExecutionJobStoreError("Execution history operation is invalid.")
    # client_identity.set_client() exposes labels up to 120 characters. Keep
    # the durable envelope aligned so a valid public client cannot execute a
    # write and only then fail recovery persistence.
    initiator = _bounded_string(record.get("initiator"), maximum=120)
    status = _bounded_string(record.get("status"), maximum=32)
    if status not in _TERMINAL_STATUSES:
        raise ExecutionJobStoreError("Execution history status is invalid.")
    cancel_requested = record.get("cancelRequested", False)
    if not isinstance(cancel_requested, bool):
        raise ExecutionJobStoreError("Execution history cancellation state is invalid.")
    finished_at = _timestamp(record.get("finishedAt"))

    result = _optional_mapping(record.get("result"))
    error = _optional_mapping(record.get("error"))
    if status == "succeeded" and (result is None or error is not None):
        raise ExecutionJobStoreError("Execution history success payload is invalid.")
    if status in {"failed", "outcome-unknown"} and error is None:
        raise ExecutionJobStoreError("Execution history error payload is invalid.")
    if status == "cancelled" and result is not None:
        raise ExecutionJobStoreError("Execution history cancellation payload is invalid.")

    normalized: dict[str, JsonValue] = {
        "executionId": execution_id,
        "operationId": operation_id,
        "artifactId": artifact_id,
        "contentHash": content_hash,
        "artifactRevision": revision,
        "planHash": plan_hash,
        "operation": operation,
        "initiator": initiator,
        "status": status,
        "createdAt": cast(int, _timestamp(record.get("createdAt"))),
        "startedAt": _timestamp(record.get("startedAt"), optional=True),
        "finishedAt": cast(int, finished_at),
        "cancelRequested": cancel_requested,
        "result": cast(JsonValue, result),
        "error": cast(JsonValue, error),
        "audit": cast(JsonValue, _optional_mapping(record.get("audit"))),
    }
    return normalized


class ExecutionJobStore:
    """Persist bounded execution recovery without persisting grants or arguments."""

    def __init__(
        self,
        root: Path,
        *,
        max_records: int = EXECUTION_HISTORY_MAX_RECORDS,
    ) -> None:
        if (
            isinstance(max_records, bool)
            or not isinstance(max_records, int)
            or max_records < 1
        ):
            raise ValueError("execution history max_records must be positive")
        self.root = Path(root).expanduser().absolute()
        self.path = self.root / "execution-history.json"
        self.max_records = max_records

    def _read_unlocked(self) -> list[dict[str, JsonValue]]:
        if not self.path.exists():
            return []
        if self.path.is_symlink() or not self.path.is_file():
            raise ExecutionJobStoreError("Execution history path is invalid.")
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ExecutionJobStoreError("Execution history cannot be read.") from exc
        if (
            not isinstance(raw, Mapping)
            or raw.get("schemaVersion") != EXECUTION_HISTORY_SCHEMA_VERSION
            or not isinstance(raw.get("executions"), list)
        ):
            raise ExecutionJobStoreError("Execution history schema is invalid.")
        records = [
            _normalize(cast(Mapping[str, Any], item))
            for item in cast(list[Any], raw["executions"])
            if isinstance(item, Mapping)
        ]
        if len(records) != len(raw["executions"]):
            raise ExecutionJobStoreError("Execution history record is invalid.")
        execution_ids = [cast(str, row["executionId"]) for row in records]
        operation_ids = [cast(str, row["operationId"]) for row in records]
        if (
            len(set(execution_ids)) != len(records)
            or len(set(operation_ids)) != len(records)
        ):
            raise ExecutionJobStoreError("Execution history identities are duplicated.")
        return records

    def _prune(self, records: list[dict[str, JsonValue]]) -> list[dict[str, JsonValue]]:
        records.sort(
            key=lambda row: (
                cast(int, row["createdAt"]),
                cast(str, row["executionId"]),
            ),
            reverse=True,
        )
        kept = records[: self.max_records]
        kept.sort(
            key=lambda row: (
                cast(int, row["createdAt"]),
                cast(str, row["executionId"]),
            )
        )
        return kept

    def _write_unlocked(self, records: list[dict[str, JsonValue]]) -> None:
        atomic_write_json(
            self.path,
            {
                "schemaVersion": EXECUTION_HISTORY_SCHEMA_VERSION,
                "executions": cast(JsonValue, records),
            },
        )

    def upsert(self, record: Mapping[str, Any]) -> None:
        normalized = _normalize(record)
        try:
            with StoreLock(self.root):
                records = self._read_unlocked()
                immutable = (
                    "executionId",
                    "operationId",
                    "artifactId",
                    "contentHash",
                    "artifactRevision",
                    "planHash",
                    "operation",
                    "createdAt",
                )
                for current in records:
                    same_execution = (
                        current["executionId"] == normalized["executionId"]
                    )
                    same_operation = (
                        current["operationId"] == normalized["operationId"]
                    )
                    if not same_execution and not same_operation:
                        continue
                    if not same_execution or not same_operation or any(
                        current[key] != normalized[key] for key in immutable
                    ):
                        raise ExecutionJobStoreError(
                            "Execution history identity conflicts with an existing "
                            "record."
                        )
                records = [
                    row
                    for row in records
                    if row["executionId"] != normalized["executionId"]
                    and row["operationId"] != normalized["operationId"]
                ]
                records.append(normalized)
                self._write_unlocked(self._prune(records))
        except (OSError, ToolStoreError) as exc:
            raise ExecutionJobStoreError(
                "Execution history cannot be persisted."
            ) from exc

    def load(self) -> list[dict[str, JsonValue]]:
        try:
            with StoreLock(self.root):
                records = self._read_unlocked()
                pruned = self._prune(records)
                if len(pruned) != len(records):
                    self._write_unlocked(pruned)
                return [dict(row) for row in pruned]
        except (OSError, ToolStoreError) as exc:
            raise ExecutionJobStoreError("Execution history cannot be loaded.") from exc


__all__ = [
    "EXECUTION_HISTORY_MAX_RECORDS",
    "EXECUTION_HISTORY_SCHEMA_VERSION",
    "ExecutionJobStore",
    "ExecutionJobStoreError",
]
