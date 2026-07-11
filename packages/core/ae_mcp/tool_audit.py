"""Bounded, redacted audit records for Tool Library execution."""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, cast

from ae_mcp.tool_artifact import JsonValue, canonical_json_bytes


AUDIT_MAX_BYTES = 5 * 1024 * 1024
AUDIT_GENERATIONS = 3

_SENSITIVE_KEY = re.compile(
    r"(?:authorization|cookie|password|passwd|secret|token|api[-_]?key)",
    re.IGNORECASE,
)
_SENSITIVE_TEXT = re.compile(
    r"(?:\b(?:bearer|basic)\s+\S+|"
    r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|"
    r"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])|"
    r"[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,})",
    re.IGNORECASE,
)


def redact_audit_value(
    value: JsonValue, *, all_strings: bool = False, _depth: int = 0
) -> JsonValue:
    """Return bounded JSON with secret-shaped values removed."""

    if _depth >= 8:
        return "[TRUNCATED]"
    if isinstance(value, dict):
        redacted: dict[str, JsonValue] = {}
        items = list(value.items())
        for index, (key, item) in enumerate(items[:64]):
            secret_key = bool(_SENSITIVE_TEXT.search(key))
            output_key = f"[key-{index}]" if all_strings or secret_key else key
            if _SENSITIVE_KEY.search(key) or secret_key:
                redacted[output_key] = "[REDACTED]"
            else:
                redacted[output_key] = redact_audit_value(
                    item, all_strings=all_strings, _depth=_depth + 1
                )
        if len(items) > 64:
            redacted["[truncated]"] = len(items) - 64
        return redacted
    if isinstance(value, list):
        result = [
            redact_audit_value(
                item, all_strings=all_strings, _depth=_depth + 1
            )
            for item in value[:64]
        ]
        if len(value) > 64:
            result.append(f"[TRUNCATED {len(value) - 64}]")
        return result
    if isinstance(value, str):
        if all_strings or _SENSITIVE_TEXT.search(value):
            return "[REDACTED]"
        if len(value) > 512:
            return value[:512] + "…"
    return value


@dataclass(frozen=True)
class AuditRecord:
    artifact_id: str
    content_hash: str
    plan_hash: str
    args_hash: str
    target_hash: str
    redacted_args: Mapping[str, JsonValue]
    redacted_target: Mapping[str, JsonValue]
    grant_id: str | None
    grant_scope: str | None
    backend: str | None
    outcome: str
    started_at: int
    finished_at: int
    error_code: str | None = None

    def public_dict(self) -> dict[str, JsonValue]:
        return {
            "artifactId": self.artifact_id,
            "contentHash": self.content_hash,
            "planHash": self.plan_hash,
            "argsHash": self.args_hash,
            "targetHash": self.target_hash,
            "args": cast(JsonValue, redact_audit_value(dict(self.redacted_args))),
            "target": cast(JsonValue, redact_audit_value(dict(self.redacted_target))),
            "grantId": self.grant_id,
            "grantScope": self.grant_scope,
            "backend": self.backend,
            "outcome": self.outcome,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "errorCode": self.error_code,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> "AuditRecord":
        args = value.get("args", {})
        target = value.get("target", {})
        if not isinstance(args, Mapping) or not isinstance(target, Mapping):
            raise ValueError("audit args and target must be objects")
        return cls(
            artifact_id=str(value["artifactId"]),
            content_hash=str(value["contentHash"]),
            plan_hash=str(value["planHash"]),
            args_hash=str(value["argsHash"]),
            target_hash=str(value["targetHash"]),
            redacted_args=cast(Mapping[str, JsonValue], dict(args)),
            redacted_target=cast(Mapping[str, JsonValue], dict(target)),
            grant_id=cast(str | None, value.get("grantId")),
            grant_scope=cast(str | None, value.get("grantScope")),
            backend=cast(str | None, value.get("backend")),
            outcome=str(value["outcome"]),
            started_at=int(value["startedAt"]),
            finished_at=int(value["finishedAt"]),
            error_code=cast(str | None, value.get("errorCode")),
        )


class ToolAuditLog:
    def __init__(
        self,
        root_or_path: Path,
        *,
        max_bytes: int = AUDIT_MAX_BYTES,
        generations: int = AUDIT_GENERATIONS,
    ) -> None:
        supplied = Path(root_or_path)
        self.path = supplied if supplied.suffix == ".jsonl" else supplied / "audit.jsonl"
        if max_bytes < 1:
            raise ValueError("audit max_bytes must be positive")
        if generations < 1:
            raise ValueError("audit generations must be positive")
        self.max_bytes = max_bytes
        self.generations = generations
        self._lock = threading.RLock()

    def _generation(self, index: int) -> Path:
        return self.path if index == 0 else self.path.with_name(f"{self.path.name}.{index}")

    @staticmethod
    def _protect(path: Path) -> None:
        try:
            path.chmod(0o600)
        except OSError:
            pass

    def _rotate(self) -> None:
        oldest = self._generation(self.generations - 1)
        if oldest.exists():
            oldest.unlink()
        for index in range(self.generations - 2, -1, -1):
            source = self._generation(index)
            if source.exists():
                destination = self._generation(index + 1)
                os.replace(source, destination)
                self._protect(destination)

    def append(self, record: AuditRecord) -> None:
        if not isinstance(record, AuditRecord):
            raise TypeError("record must be an AuditRecord")
        line = canonical_json_bytes(cast(JsonValue, record.public_dict())) + b"\n"
        if len(line) > self.max_bytes:
            raise ValueError("audit record exceeds generation size")
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            size = self.path.stat().st_size if self.path.exists() else 0
            if size and size + len(line) > self.max_bytes:
                self._rotate()
            fd = os.open(self.path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
            try:
                os.write(fd, line)
                os.fsync(fd)
            finally:
                os.close(fd)
            self._protect(self.path)

    def list(self, *, limit: int = 100, artifact_id: str | None = None) -> list[AuditRecord]:
        if not 1 <= limit <= 10_000:
            raise ValueError("audit limit must be between 1 and 10000")
        records: list[AuditRecord] = []
        with self._lock:
            paths = [
                self._generation(index)
                for index in range(self.generations - 1, -1, -1)
            ]
            for path in paths:
                if not path.exists():
                    continue
                for line in path.read_text(encoding="utf-8").splitlines():
                    if not line:
                        continue
                    try:
                        raw = json.loads(line)
                        if not isinstance(raw, Mapping):
                            continue
                        record = AuditRecord.from_dict(raw)
                    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                        continue
                    if artifact_id is None or record.artifact_id == artifact_id:
                        records.append(record)
        return records[-limit:]


__all__ = [
    "AUDIT_GENERATIONS",
    "AUDIT_MAX_BYTES",
    "AuditRecord",
    "ToolAuditLog",
    "redact_audit_value",
]
