"""Crash-safe, cross-process recovery records for Tool Library executions."""

from __future__ import annotations

import json
import os
import re
import secrets
import socket
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from ae_mcp.tool_artifact import JsonValue
from ae_mcp.tool_audit import redact_audit_value
from ae_mcp.tool_store import StoreLock, ToolStoreError, atomic_write_json


EXECUTION_HISTORY_SCHEMA_VERSION = 2
EXECUTION_HISTORY_MAX_RECORDS = 500
EXECUTION_RESERVATION_LEASE_MS = 30_000

_LEGACY_SCHEMA_VERSION = 1
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_TERMINAL_STATUSES = frozenset(
    {"succeeded", "failed", "cancelled", "outcome-unknown"}
)
_RESERVATION_STATUSES = frozenset({"queued", "running"})
_OPERATIONS = frozenset({"render", "execute", "apply"})


class ExecutionJobStoreError(RuntimeError):
    code = "tool_execution_history_failed"


class ExecutionOperationConflict(ExecutionJobStoreError):
    code = "tool_operation_conflict"


@dataclass(frozen=True)
class ExecutionClaim:
    owned: bool
    record: Mapping[str, JsonValue]
    owner_token: str | None


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


def _identity(record: Mapping[str, Any]) -> dict[str, JsonValue]:
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
    initiator = _bounded_string(record.get("initiator"), maximum=120)
    return {
        "executionId": execution_id,
        "operationId": operation_id,
        "artifactId": artifact_id,
        "contentHash": content_hash,
        "artifactRevision": revision,
        "planHash": plan_hash,
        "operation": operation,
        "initiator": initiator,
        "createdAt": cast(int, _timestamp(record.get("createdAt"))),
    }


def _normalize(record: Mapping[str, Any]) -> dict[str, JsonValue]:
    normalized = _identity(record)
    status = _bounded_string(record.get("status"), maximum=32)
    if status not in _TERMINAL_STATUSES:
        raise ExecutionJobStoreError("Execution history status is invalid.")
    cancel_requested = record.get("cancelRequested", False)
    if not isinstance(cancel_requested, bool):
        raise ExecutionJobStoreError("Execution history cancellation state is invalid.")
    result = _optional_mapping(record.get("result"))
    error = _optional_mapping(record.get("error"))
    if status == "succeeded" and (result is None or error is not None):
        raise ExecutionJobStoreError("Execution history success payload is invalid.")
    if status in {"failed", "outcome-unknown"} and error is None:
        raise ExecutionJobStoreError("Execution history error payload is invalid.")
    if status == "cancelled" and result is not None:
        raise ExecutionJobStoreError("Execution history cancellation payload is invalid.")
    normalized.update(
        {
            "status": status,
            "startedAt": _timestamp(record.get("startedAt"), optional=True),
            "finishedAt": cast(int, _timestamp(record.get("finishedAt"))),
            "cancelRequested": cancel_requested,
            "result": cast(JsonValue, result),
            "error": cast(JsonValue, error),
            "audit": cast(JsonValue, _optional_mapping(record.get("audit"))),
        }
    )
    return normalized


def _normalize_reservation(record: Mapping[str, Any]) -> dict[str, JsonValue]:
    normalized = _identity(record)
    status = _bounded_string(record.get("status"), maximum=32)
    if status not in _RESERVATION_STATUSES:
        raise ExecutionJobStoreError("Execution reservation status is invalid.")
    started_at = _timestamp(record.get("startedAt"), optional=True)
    if status == "queued" and started_at is not None:
        raise ExecutionJobStoreError("Queued execution reservation has a start time.")
    if status == "running" and started_at is None:
        raise ExecutionJobStoreError("Running execution reservation lacks a start time.")
    owner = record.get("owner")
    if not isinstance(owner, Mapping):
        raise ExecutionJobStoreError("Execution reservation owner is invalid.")
    token = _bounded_string(owner.get("token"), minimum=16, maximum=128)
    host = _bounded_string(owner.get("host"), maximum=255)
    pid = owner.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        raise ExecutionJobStoreError("Execution reservation owner pid is invalid.")
    normalized.update(
        {
            "status": status,
            "startedAt": started_at,
            "owner": {
                "token": token,
                "host": host,
                "pid": pid,
                "leaseExpiresAt": cast(
                    int, _timestamp(owner.get("leaseExpiresAt"))
                ),
            },
        }
    )
    return normalized


def _public(record: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
    status = cast(str, record["status"])
    terminal = status in _TERMINAL_STATUSES
    return {
        "ok": True,
        **{
            key: record[key]
            for key in (
                "executionId",
                "operationId",
                "artifactId",
                "contentHash",
                "artifactRevision",
                "planHash",
                "operation",
                "initiator",
                "status",
                "createdAt",
                "startedAt",
            )
        },
        "progress": 100 if terminal else 25 if status == "running" else 0,
        "terminal": terminal,
        "cancelRequested": cast(bool, record.get("cancelRequested", False)),
        "outcomeUnknown": status == "outcome-unknown",
        "finishedAt": record.get("finishedAt"),
        "result": record.get("result"),
        "error": record.get("error"),
        "audit": record.get("audit"),
    }


class ExecutionJobStore:
    """Persist terminal jobs and atomically reserve operation IDs before dispatch."""

    def __init__(
        self,
        root: Path,
        *,
        max_records: int = EXECUTION_HISTORY_MAX_RECORDS,
        reservation_lease_ms: int = EXECUTION_RESERVATION_LEASE_MS,
        now: Callable[[], int] | None = None,
    ) -> None:
        if (
            isinstance(max_records, bool)
            or not isinstance(max_records, int)
            or max_records < 1
        ):
            raise ValueError("execution history max_records must be positive")
        if (
            isinstance(reservation_lease_ms, bool)
            or not isinstance(reservation_lease_ms, int)
            or reservation_lease_ms < 1
        ):
            raise ValueError("execution reservation lease must be positive")
        self.root = Path(root).expanduser().absolute()
        self.path = self.root / "execution-history.json"
        self.max_records = max_records
        self.reservation_lease_ms = reservation_lease_ms
        self._now = now or (lambda: int(time.time() * 1000))
        self._host = socket.gethostname()
        self._pid = os.getpid()

    def _read_state_unlocked(
        self,
    ) -> tuple[list[dict[str, JsonValue]], list[dict[str, JsonValue]], int]:
        if not self.path.exists():
            return [], [], EXECUTION_HISTORY_SCHEMA_VERSION
        if self.path.is_symlink() or not self.path.is_file():
            raise ExecutionJobStoreError("Execution history path is invalid.")
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise ExecutionJobStoreError("Execution history cannot be read.") from exc
        if not isinstance(raw, Mapping):
            raise ExecutionJobStoreError("Execution history schema is invalid.")
        schema = raw.get("schemaVersion")
        if schema not in {_LEGACY_SCHEMA_VERSION, EXECUTION_HISTORY_SCHEMA_VERSION}:
            raise ExecutionJobStoreError("Execution history schema is invalid.")
        raw_executions = raw.get("executions")
        raw_reservations = [] if schema == _LEGACY_SCHEMA_VERSION else raw.get("reservations")
        if not isinstance(raw_executions, list) or not isinstance(raw_reservations, list):
            raise ExecutionJobStoreError("Execution history schema is invalid.")
        executions = [
            _normalize(cast(Mapping[str, Any], item))
            for item in raw_executions
            if isinstance(item, Mapping)
        ]
        reservations = [
            _normalize_reservation(cast(Mapping[str, Any], item))
            for item in raw_reservations
            if isinstance(item, Mapping)
        ]
        if len(executions) != len(raw_executions) or len(reservations) != len(raw_reservations):
            raise ExecutionJobStoreError("Execution history record is invalid.")
        combined = [*executions, *reservations]
        execution_ids = [cast(str, row["executionId"]) for row in combined]
        operation_ids = [cast(str, row["operationId"]) for row in combined]
        if len(set(execution_ids)) != len(combined) or len(set(operation_ids)) != len(combined):
            raise ExecutionJobStoreError("Execution history identities are duplicated.")
        return executions, reservations, cast(int, schema)

    def _prune(
        self, records: list[dict[str, JsonValue]]
    ) -> list[dict[str, JsonValue]]:
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

    def _write_state_unlocked(
        self,
        executions: list[dict[str, JsonValue]],
        reservations: list[dict[str, JsonValue]],
    ) -> None:
        atomic_write_json(
            self.path,
            {
                "schemaVersion": EXECUTION_HISTORY_SCHEMA_VERSION,
                "executions": cast(JsonValue, executions),
                "reservations": cast(JsonValue, reservations),
            },
        )

    def _recover_orphans(
        self,
        executions: list[dict[str, JsonValue]],
        reservations: list[dict[str, JsonValue]],
    ) -> tuple[list[dict[str, JsonValue]], list[dict[str, JsonValue]], bool]:
        now = self._now()
        retained: list[dict[str, JsonValue]] = []
        changed = False
        for reservation in reservations:
            owner = cast(Mapping[str, JsonValue], reservation["owner"])
            if now < cast(int, owner["leaseExpiresAt"]):
                retained.append(reservation)
                continue
            running = reservation["status"] == "running"
            error: dict[str, JsonValue] = {
                "code": "tool_execution_owner_exited",
                "message": (
                    "Execution owner exited after dispatch; inspect AE state before retrying."
                    if running
                    else "Execution owner exited before dispatch."
                ),
                "sideEffect": "may-have-occurred" if running else "not-started",
                "recovery": {
                    "action": "inspect-state" if running else "retry-with-new-operation-id",
                    "hint": (
                        "Inspect AE state and audit evidence before any retry."
                        if running
                        else "Use a new operation id only after confirming the prior owner never dispatched."
                    ),
                },
            }
            terminal = {
                key: reservation[key]
                for key in (
                    "executionId",
                    "operationId",
                    "artifactId",
                    "contentHash",
                    "artifactRevision",
                    "planHash",
                    "operation",
                    "initiator",
                    "createdAt",
                    "startedAt",
                )
            }
            terminal.update(
                {
                    "status": "outcome-unknown" if running else "failed",
                    "finishedAt": now,
                    "cancelRequested": False,
                    "result": None,
                    "error": error,
                    "audit": None,
                }
            )
            executions.append(_normalize(terminal))
            changed = True
        return self._prune(executions), retained, changed

    @staticmethod
    def _same_identity(
        current: Mapping[str, JsonValue], incoming: Mapping[str, JsonValue]
    ) -> bool:
        return all(
            current[key] == incoming[key]
            for key in (
                "executionId",
                "operationId",
                "artifactId",
                "contentHash",
                "artifactRevision",
                "planHash",
                "operation",
                "createdAt",
            )
        )

    def claim(self, record: Mapping[str, Any]) -> ExecutionClaim:
        identity = _identity(record)
        queued = {
            **identity,
            "status": "queued",
            "startedAt": None,
            "owner": {
                "token": secrets.token_urlsafe(24),
                "host": self._host,
                "pid": self._pid,
                "leaseExpiresAt": self._now() + self.reservation_lease_ms,
            },
        }
        normalized = _normalize_reservation(queued)
        try:
            with StoreLock(self.root):
                executions, reservations, schema = self._read_state_unlocked()
                executions, reservations, recovered = self._recover_orphans(
                    executions, reservations
                )
                for current in [*executions, *reservations]:
                    if current["operationId"] != normalized["operationId"]:
                        continue
                    if current["planHash"] != normalized["planHash"]:
                        raise ExecutionOperationConflict(
                            "Operation id is already bound to a different execution plan."
                        )
                    if recovered or schema != EXECUTION_HISTORY_SCHEMA_VERSION:
                        self._write_state_unlocked(executions, reservations)
                    return ExecutionClaim(False, _public(current), None)
                if len(reservations) >= self.max_records:
                    raise ExecutionJobStoreError(
                        "Execution reservation capacity is exhausted."
                    )
                reservations.append(normalized)
                self._write_state_unlocked(executions, reservations)
                owner = cast(Mapping[str, JsonValue], normalized["owner"])
                return ExecutionClaim(
                    True, _public(normalized), cast(str, owner["token"])
                )
        except (OSError, ToolStoreError) as exc:
            raise ExecutionJobStoreError(
                "Execution operation could not be reserved."
            ) from exc

    def mark_running(
        self, execution_id: str, *, owner_token: str, started_at: int
    ) -> Mapping[str, JsonValue]:
        _bounded_string(execution_id, maximum=128)
        _bounded_string(owner_token, minimum=16, maximum=128)
        started = cast(int, _timestamp(started_at))
        try:
            with StoreLock(self.root):
                executions, reservations, _schema = self._read_state_unlocked()
                executions, reservations, recovered = self._recover_orphans(
                    executions, reservations
                )
                for reservation in reservations:
                    if reservation["executionId"] != execution_id:
                        continue
                    owner = cast(dict[str, JsonValue], reservation["owner"])
                    if owner["token"] != owner_token:
                        raise ExecutionJobStoreError(
                            "Execution reservation is owned by another Core process."
                        )
                    reservation["status"] = "running"
                    reservation["startedAt"] = started
                    owner["leaseExpiresAt"] = self._now() + self.reservation_lease_ms
                    self._write_state_unlocked(executions, reservations)
                    return _public(reservation)
                if recovered:
                    self._write_state_unlocked(executions, reservations)
                raise ExecutionJobStoreError("Execution reservation was not found.")
        except (OSError, ToolStoreError) as exc:
            raise ExecutionJobStoreError(
                "Execution reservation could not enter running state."
            ) from exc

    def renew(self, execution_id: str, *, owner_token: str) -> None:
        _bounded_string(execution_id, maximum=128)
        _bounded_string(owner_token, minimum=16, maximum=128)
        try:
            with StoreLock(self.root):
                executions, reservations, _schema = self._read_state_unlocked()
                executions, reservations, recovered = self._recover_orphans(
                    executions, reservations
                )
                for reservation in reservations:
                    if reservation["executionId"] != execution_id:
                        continue
                    owner = cast(dict[str, JsonValue], reservation["owner"])
                    if owner["token"] != owner_token:
                        raise ExecutionJobStoreError(
                            "Execution reservation is owned by another Core process."
                        )
                    owner["leaseExpiresAt"] = (
                        self._now() + self.reservation_lease_ms
                    )
                    self._write_state_unlocked(executions, reservations)
                    return
                if recovered:
                    self._write_state_unlocked(executions, reservations)
                raise ExecutionJobStoreError("Execution reservation was not found.")
        except (OSError, ToolStoreError) as exc:
            raise ExecutionJobStoreError(
                "Execution reservation lease could not be renewed."
            ) from exc

    def complete(
        self, record: Mapping[str, Any], *, owner_token: str
    ) -> Mapping[str, JsonValue]:
        normalized = _normalize(record)
        _bounded_string(owner_token, minimum=16, maximum=128)
        try:
            with StoreLock(self.root):
                executions, reservations, _schema = self._read_state_unlocked()
                executions, reservations, recovered = self._recover_orphans(
                    executions, reservations
                )
                for current in executions:
                    if current["operationId"] != normalized["operationId"]:
                        continue
                    if not self._same_identity(current, normalized):
                        raise ExecutionOperationConflict(
                            "Execution completion conflicts with durable history."
                        )
                    if current != normalized:
                        raise ExecutionJobStoreError(
                            "Execution outcome was already recovered and cannot be overwritten."
                        )
                    if recovered:
                        self._write_state_unlocked(executions, reservations)
                    return _public(current)
                owned = None
                for reservation in reservations:
                    if reservation["operationId"] != normalized["operationId"]:
                        continue
                    owner = cast(Mapping[str, JsonValue], reservation["owner"])
                    if owner["token"] != owner_token or not self._same_identity(
                        reservation, normalized
                    ):
                        raise ExecutionOperationConflict(
                            "Execution completion conflicts with its reservation."
                        )
                    owned = reservation
                    break
                if owned is None:
                    raise ExecutionJobStoreError("Execution reservation was not found.")
                reservations.remove(owned)
                executions.append(normalized)
                executions = self._prune(executions)
                self._write_state_unlocked(executions, reservations)
                return _public(normalized)
        except (OSError, ToolStoreError) as exc:
            raise ExecutionJobStoreError(
                "Execution completion could not be persisted."
            ) from exc

    def upsert(self, record: Mapping[str, Any]) -> None:
        normalized = _normalize(record)
        try:
            with StoreLock(self.root):
                executions, reservations, _schema = self._read_state_unlocked()
                executions, reservations, _recovered = self._recover_orphans(
                    executions, reservations
                )
                for current in [*executions, *reservations]:
                    same_execution = current["executionId"] == normalized["executionId"]
                    same_operation = current["operationId"] == normalized["operationId"]
                    if not same_execution and not same_operation:
                        continue
                    if not same_execution or not same_operation or not self._same_identity(
                        current, normalized
                    ):
                        raise ExecutionJobStoreError(
                            "Execution history identity conflicts with an existing record."
                        )
                    if current in reservations:
                        raise ExecutionJobStoreError(
                            "Execution reservation requires its owner to complete it."
                        )
                executions = [
                    row
                    for row in executions
                    if row["executionId"] != normalized["executionId"]
                    and row["operationId"] != normalized["operationId"]
                ]
                executions.append(normalized)
                self._write_state_unlocked(self._prune(executions), reservations)
        except (OSError, ToolStoreError) as exc:
            raise ExecutionJobStoreError(
                "Execution history cannot be persisted."
            ) from exc

    def _snapshot(self) -> list[dict[str, JsonValue]]:
        try:
            with StoreLock(self.root):
                executions, reservations, schema = self._read_state_unlocked()
                original_count = len(executions)
                executions, reservations, recovered = self._recover_orphans(
                    executions, reservations
                )
                if (
                    recovered
                    or len(executions) != original_count
                    or schema != EXECUTION_HISTORY_SCHEMA_VERSION
                ):
                    self._write_state_unlocked(executions, reservations)
                rows = [_public(row) for row in [*executions, *reservations]]
                rows.sort(
                    key=lambda row: (
                        cast(int, row["createdAt"]),
                        cast(str, row["executionId"]),
                    )
                )
                return rows
        except (OSError, ToolStoreError) as exc:
            raise ExecutionJobStoreError("Execution history cannot be loaded.") from exc

    def load(self) -> list[dict[str, JsonValue]]:
        return [row for row in self._snapshot() if cast(bool, row["terminal"])]

    def snapshot(self) -> list[dict[str, JsonValue]]:
        return self._snapshot()

    def lookup_operation(self, operation_id: str) -> Mapping[str, JsonValue] | None:
        _bounded_string(operation_id, minimum=16, maximum=128)
        for record in self._snapshot():
            if record["operationId"] == operation_id:
                return record
        return None

    def lookup_execution(self, execution_id: str) -> Mapping[str, JsonValue] | None:
        _bounded_string(execution_id, maximum=128)
        for record in self._snapshot():
            if record["executionId"] == execution_id:
                return record
        return None


__all__ = [
    "EXECUTION_HISTORY_MAX_RECORDS",
    "EXECUTION_HISTORY_SCHEMA_VERSION",
    "EXECUTION_RESERVATION_LEASE_MS",
    "ExecutionClaim",
    "ExecutionJobStore",
    "ExecutionJobStoreError",
    "ExecutionOperationConflict",
]
