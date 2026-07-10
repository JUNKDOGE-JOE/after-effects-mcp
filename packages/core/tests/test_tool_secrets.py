from __future__ import annotations

import json

import pytest

from ae_mcp.tool_secrets import (
    RegexSecretScanner,
    SecretDetectedError,
    SecretScanError,
    require_secret_free,
)


@pytest.mark.parametrize(
    ("kind", "payload"),
    [
        ("authorization", b"Authorization: Bearer value-that-must-not-leak"),
        ("api-key-header", b"x-api-key: provider-key-that-must-not-leak"),
        ("cookie", b"Cookie: session=private-cookie-value"),
        (
            "jwt",
            b"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue123",
        ),
        (
            "private-key",
            b"-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----",
        ),
        ("sk-key", b"const key = 'sk-this-is-a-provider-secret';"),
    ],
)
def test_scanner_detects_secret_families_without_returning_matched_text(kind, payload):
    findings = RegexSecretScanner().scan_bytes("fixture.jsx", payload)
    assert findings
    assert any(finding.kind == kind for finding in findings)
    rendered = repr(findings)
    assert payload.decode("utf-8") not in rendered
    assert all(
        set(finding.__dict__) == {"kind", "file", "line", "column"}
        for finding in findings
    )


def test_scanner_reports_position_but_never_secret_value():
    findings = RegexSecretScanner().scan_bytes(
        "two-lines.txt", b"clean\nAuthorization: Bearer do-not-return-this\n"
    )
    assert findings[0].file == "two-lines.txt"
    assert findings[0].line == 2
    assert findings[0].column == 1
    assert "do-not-return-this" not in repr(findings[0])


def test_scan_json_uses_canonical_text_and_detects_nested_values():
    findings = RegexSecretScanner().scan_json(
        "fixture.json", {"nested": {"token": "sk-nested-secret-value"}}
    )
    assert findings
    assert "sk-nested-secret-value" not in repr(findings)


@pytest.mark.parametrize(
    "value",
    [
        {"Authorization": "Bearer opaque-provider-value"},
        {"x-api-key": "opaque-provider-value"},
        {"Cookie": "session=opaque-provider-value"},
    ],
)
def test_scan_json_detects_sensitive_header_keys_even_without_key_prefix(value):
    findings = RegexSecretScanner().scan_json("headers.json", value)
    assert findings
    assert "opaque-provider-value" not in repr(findings)


def test_clean_extendscript_has_no_findings():
    clean = b"var comp = app.project.activeItem; JSON.stringify({name: comp.name});"
    assert RegexSecretScanner().scan_bytes("clean.jsx", clean) == ()


def test_scanner_fails_closed_on_invalid_utf8_and_oversize_input():
    scanner = RegexSecretScanner()
    with pytest.raises(SecretScanError, match="UTF-8"):
        scanner.scan_bytes("bad.bin", b"\xff")
    with pytest.raises(SecretScanError, match="5 MiB"):
        scanner.scan_bytes("large.txt", b"a" * (5 * 1024 * 1024 + 1))


def test_require_secret_free_fails_closed_on_finding_or_scanner_exception():
    with pytest.raises(SecretDetectedError) as caught:
        require_secret_free(
            RegexSecretScanner(),
            name="secret.txt",
            data=b"x-api-key: do-not-put-this-in-the-error",
        )
    assert "do-not-put-this-in-the-error" not in str(caught.value)

    class BrokenScanner:
        def scan_bytes(self, name, data):
            raise RuntimeError("scanner backend unavailable: sk-do-not-chain-this")

    with pytest.raises(SecretScanError, match="scanner failed") as scan_error:
        require_secret_free(BrokenScanner(), name="clean.txt", data=b"clean")
    assert scan_error.value.__cause__ is None
    assert scan_error.value.__suppress_context__ is False


def test_scan_json_rejects_non_json_and_non_finite_values():
    scanner = RegexSecretScanner()
    with pytest.raises(SecretScanError, match="JSON"):
        scanner.scan_json("bad.json", {"bad": object()})
    with pytest.raises(SecretScanError, match="JSON"):
        scanner.scan_json("nan.json", {"bad": float("nan")})


def test_findings_are_json_serializable_without_secret_material():
    secret = "sk-never-serialize-this-secret"
    findings = RegexSecretScanner().scan_bytes("one.txt", secret.encode())
    payload = json.dumps([finding.__dict__ for finding in findings])
    assert secret not in payload
