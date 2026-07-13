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

_CREDENTIAL_FIELDS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "credential-header",
        re.compile(
            r"^[ \t]*(?P<name>[!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*:[ \t]*(?P<value>[^\s\r\n][^\r\n]*)$",
            re.MULTILINE,
        ),
    ),
    (
        "credential-assignment",
        re.compile(
            r"(?<![A-Za-z0-9_.-])['\"]?(?P<name>[A-Za-z][A-Za-z0-9_.-]*)['\"]?[ \t]*[:=][ \t]*(?P<value>['\"][^'\"\r\n]+['\"]|[^'\"\s,;&{}\[\]]+)",
            re.MULTILINE,
        ),
    ),
)

_SENSITIVE_KEY_SEGMENTS = frozenset(
    {
        "apikey",
        "auth",
        "authentication",
        "authorization",
        "cookie",
        "credential",
        "credentials",
        "key",
        "oauth",
        "passwd",
        "password",
        "secret",
        "session",
        "signature",
        "token",
    }
)

_STRONG_SENSITIVE_FRAGMENTS = (
    "apikey",
    "auth",
    "cookie",
    "credential",
    "oauth",
    "passwd",
    "password",
    "secret",
    "session",
    "signature",
    "token",
)

_KEY_SUFFIX_PREFIXES = frozenset(
    {
        "api",
        "access",
        "client",
        "credential",
        "private",
        "provider",
        "public",
        "secret",
        "x",
    }
)

_SCHEMA_ONLY_KEYS = frozenset(
    {
        "$comment",
        "$ref",
        "deprecated",
        "description",
        "format",
        "readOnly",
        "title",
        "type",
        "writeOnly",
    }
)

_JSON_SCHEMA_TYPES = frozenset(
    {"array", "boolean", "integer", "null", "number", "object", "string"}
)


def _sensitive_name(value: str) -> bool:
    raw = value.strip()
    if not raw:
        return False
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", raw)
    separated = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", separated)
    segments = tuple(
        segment
        for segment in re.split(r"[^a-z0-9]+", separated.lower())
        if segment
    )
    if any(segment in _SENSITIVE_KEY_SEGMENTS for segment in segments):
        return True
    compact = re.sub(r"[^a-z0-9]+", "", raw.lower())
    if any(fragment in compact for fragment in _STRONG_SENSITIVE_FRAGMENTS):
        return True
    if not compact.endswith("key"):
        return False
    prefix = compact[:-3]
    return prefix in _KEY_SUFFIX_PREFIXES or any(
        prefix.endswith(candidate) for candidate in _KEY_SUFFIX_PREFIXES
    )


def _schema_only_object(value: dict[str, JsonValue]) -> bool:
    keys = set(value)
    return (
        bool(keys)
        and keys <= _SCHEMA_ONLY_KEYS
        and value.get("type") in _JSON_SCHEMA_TYPES
    )


def _contains_credential_payload(value: JsonValue) -> bool:
    if isinstance(value, str):
        return bool(value)
    if isinstance(value, list):
        return any(_contains_credential_payload(item) for item in value)
    if isinstance(value, dict):
        if _schema_only_object(value):
            return False
        return any(_contains_credential_payload(item) for item in value.values())
    return value is not None


def _json_key_findings(name: str, value: JsonValue) -> tuple[SecretFinding, ...]:
    findings: list[SecretFinding] = []

    def visit(current: JsonValue) -> None:
        if isinstance(current, dict):
            for key, item in current.items():
                if (
                    isinstance(key, str)
                    and _sensitive_name(key)
                    and _contains_credential_payload(item)
                ):
                    findings.append(
                        SecretFinding(
                            kind="credential-key",
                            file=name,
                            line=1,
                            column=1,
                        )
                    )
                visit(item)
        elif isinstance(current, list):
            for item in current:
                visit(item)

    visit(value)
    return tuple(findings)


def _json_string_values(value: JsonValue) -> tuple[str, ...]:
    strings: list[str] = []

    def visit(current: JsonValue) -> None:
        if isinstance(current, str):
            if current:
                strings.append(current)
        elif isinstance(current, dict):
            for item in current.values():
                visit(item)
        elif isinstance(current, list):
            for item in current:
                visit(item)

    visit(value)
    return tuple(strings)


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
        for kind, pattern in _CREDENTIAL_FIELDS:
            for match in pattern.finditer(text):
                if not _sensitive_name(match.group("name")):
                    continue
                offset = match.start("name")
                key = (kind, offset)
                if key in seen:
                    continue
                seen.add(key)
                line, column = _position(text, offset)
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
        findings = list(self.scan_bytes(name, data))
        for string_value in _json_string_values(value):
            findings.extend(self.scan_bytes(name, string_value.encode("utf-8")))
        findings.extend(_json_key_findings(name, value))
        unique = {
            (finding.kind, finding.file, finding.line, finding.column): finding
            for finding in findings
        }
        return tuple(
            sorted(
                unique.values(),
                key=lambda item: (item.line, item.column, item.kind),
            )
        )


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


def require_secret_free_json(
    scanner: SecretScanner, *, name: str, value: JsonValue
) -> None:
    scan_failed = False
    try:
        findings = scanner.scan_json(name, value)
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
    "require_secret_free_json",
]
