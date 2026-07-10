"""Fail-closed secret scanning for Tool Library persistence and archives."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Protocol, Sequence

from ae_mcp.tool_artifact import JsonValue


MAX_SCAN_BYTES = 5 * 1024 * 1024


class SecretScanError(ValueError):
    """Scanning could not produce a trustworthy clean result."""


class SecretDetectedError(SecretScanError):
    """One or more secret-shaped values were detected."""


@dataclass(frozen=True)
class SecretFinding:
    kind: str
    file: str
    line: int
    column: int


class SecretScanner(Protocol):
    def scan_bytes(self, name: str, data: bytes) -> Sequence[SecretFinding]: ...

    def scan_json(self, name: str, value: JsonValue) -> Sequence[SecretFinding]: ...


_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "authorization",
        re.compile(
            r"^[ \t]*authorization[ \t]*:[ \t]*(?:bearer|basic)[ \t]+[^\s]+",
            re.IGNORECASE | re.MULTILINE,
        ),
    ),
    (
        "authorization",
        re.compile(
            r'"authorization"[ \t]*:[ \t]*"(?:bearer|basic)[ \t]+[^"\r\n]+"',
            re.IGNORECASE,
        ),
    ),
    (
        "api-key-header",
        re.compile(
            r"^[ \t]*(?:x[-_]api[-_]key|api[-_]key)[ \t]*:[ \t]*[^\s]+",
            re.IGNORECASE | re.MULTILINE,
        ),
    ),
    (
        "api-key-header",
        re.compile(
            r'"(?:x[-_]api[-_]key|api[-_]key)"[ \t]*:[ \t]*"[^"\r\n]+"',
            re.IGNORECASE,
        ),
    ),
    (
        "cookie",
        re.compile(
            r"^[ \t]*(?:cookie|set-cookie)[ \t]*:[ \t]*[^\r\n]+",
            re.IGNORECASE | re.MULTILINE,
        ),
    ),
    (
        "cookie",
        re.compile(
            r'"(?:cookie|set-cookie)"[ \t]*:[ \t]*"[^"\r\n]+"',
            re.IGNORECASE,
        ),
    ),
    (
        "jwt",
        re.compile(
            r"(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])"
        ),
    ),
    (
        "private-key",
        re.compile(r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"),
    ),
    (
        "sk-key",
        re.compile(r"(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])"),
    ),
)


def _position(text: str, offset: int) -> tuple[int, int]:
    line = text.count("\n", 0, offset) + 1
    previous_newline = text.rfind("\n", 0, offset)
    column = offset + 1 if previous_newline < 0 else offset - previous_newline
    return line, column


class RegexSecretScanner:
    """Bounded scanner whose findings contain location metadata, never values."""

    def scan_bytes(self, name: str, data: bytes) -> tuple[SecretFinding, ...]:
        if not isinstance(name, str) or not name:
            raise SecretScanError("scan file name must be a non-empty string")
        if not isinstance(data, bytes):
            raise SecretScanError("scan input must be bytes")
        if len(data) > MAX_SCAN_BYTES:
            raise SecretScanError("scan input exceeds the 5 MiB limit")
        decode_failed = False
        try:
            text = data.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            decode_failed = True
            text = ""
        if decode_failed:
            raise SecretScanError("scan input must be valid UTF-8")
        findings: list[SecretFinding] = []
        seen: set[tuple[str, int]] = set()
        for kind, pattern in _PATTERNS:
            for match in pattern.finditer(text):
                key = (kind, match.start())
                if key in seen:
                    continue
                seen.add(key)
                line, column = _position(text, match.start())
                findings.append(
                    SecretFinding(kind=kind, file=name, line=line, column=column)
                )
        findings.sort(key=lambda item: (item.line, item.column, item.kind))
        return tuple(findings)

    def scan_json(self, name: str, value: JsonValue) -> tuple[SecretFinding, ...]:
        serialization_failed = False
        try:
            data = json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError, UnicodeError):
            serialization_failed = True
            data = b""
        if serialization_failed:
            raise SecretScanError("scan value must be finite JSON")
        return self.scan_bytes(name, data)


def require_secret_free(
    scanner: SecretScanner, *, name: str, data: bytes
) -> None:
    scan_failed = False
    try:
        findings = scanner.scan_bytes(name, data)
    except Exception:
        scan_failed = True
        findings = ()
    if scan_failed:
        raise SecretScanError("secret scanner failed closed")
    if findings:
        kinds = ",".join(sorted({finding.kind for finding in findings}))
        raise SecretDetectedError(
            f"secret-shaped content detected ({len(findings)} finding(s); types={kinds})"
        )


__all__ = [
    "MAX_SCAN_BYTES",
    "RegexSecretScanner",
    "SecretDetectedError",
    "SecretFinding",
    "SecretScanError",
    "SecretScanner",
    "require_secret_free",
]
