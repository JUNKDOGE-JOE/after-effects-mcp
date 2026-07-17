from __future__ import annotations

import contextlib
import hashlib
import json
import shutil
import stat
import struct
import zipfile
from pathlib import Path
from typing import Any

import pytest

import ae_mcp.tool_archive as archive_module
from ae_mcp.tool_archive import ToolPackageError, ToolPackageManager
from ae_mcp.tool_artifact import (
    ToolArtifact,
    ToolArtifactDraft,
    ToolSummary,
    canonical_json_bytes,
    compute_content_hash,
)
from ae_mcp.tool_secrets import RegexSecretScanner, SecretFinding
from ae_mcp.tool_store import ToolArtifactStore


USER_ID = "user:12345678-1234-5678-9234-567812345678"


def artifact_wire(**overrides: Any) -> dict[str, Any]:
    sensitive_source = bool(overrides.pop("_sensitive_source", False))
    content = overrides.pop("content", "return 1;")
    args_schema = overrides.pop("argsSchema", {})
    kind = overrides.pop("kind", "jsx")
    wire = {
        "schemaVersion": 1,
        "id": USER_ID,
        "name": "One",
        "description": "",
        "kind": kind,
        "category": "workflow",
        "tags": [],
        "compatibility": {},
        "declaredRisk": "write",
        "source": {
            "type": "user",
            "ref": (
                "/Users/person/private/provider-config.json"
                if sensitive_source
                else "manual"
            ),
            "client": "private-client" if sensitive_source else None,
            "productVersion": "0.9.2",
            "provenance": (
                {
                    "provider": "private-provider-shape",
                    "Authorization": "do-not-export",
                }
                if sensitive_source
                else {}
            ),
        },
        "status": "saved",
        "verified": False,
        "verification": None,
        "content": content,
        "argsSchema": args_schema,
        "contentHash": compute_content_hash(kind, content, args_schema),
        "revision": 1,
        "createdAt": 1,
        "updatedAt": 1,
        "lastUsedAt": None,
    }
    wire.update(overrides)
    return wire


def summary(artifact: ToolArtifact) -> ToolSummary:
    return ToolSummary(
        id=artifact.id,
        name=artifact.name,
        description=artifact.description,
        kind=artifact.kind,
        category=artifact.category,
        tags=artifact.tags,
        status=artifact.status,
        verified=artifact.verified,
        declared_risk=artifact.declared_risk,
        content_hash=artifact.content_hash,
        revision=artifact.revision,
        updated_at=artifact.updated_at,
        last_used_at=artifact.last_used_at,
        source_type=artifact.source.type,
    )


class FakeStore:
    def __init__(self) -> None:
        self.artifacts: dict[str, ToolArtifact] = {}
        self.revision = 0
        self.fail_batch = False
        self.next_id = 1

    def add(self, artifact: ToolArtifact) -> None:
        self.artifacts[artifact.id] = artifact
        self.revision += 1

    def list(self, **_filters: Any) -> list[ToolSummary]:
        return [summary(item) for item in self.artifacts.values()]

    def get(self, artifact_id: str, *, include_content: bool = True) -> ToolArtifact:
        del include_content
        if artifact_id not in self.artifacts:
            raise KeyError(artifact_id)
        return self.artifacts[artifact_id]

    def store_revision(self) -> int:
        return self.revision

    def create_many_atomic(
        self,
        drafts: list[ToolArtifactDraft],
        *,
        expected_store_revision: int,
    ) -> list[ToolArtifact]:
        if expected_store_revision != self.revision:
            raise RuntimeError("store revision conflict")
        if self.fail_batch:
            raise OSError("injected batch fault")
        created: list[ToolArtifact] = []
        for draft in drafts:
            artifact_id = f"user:00000000-0000-4000-8000-{self.next_id:012d}"
            self.next_id += 1
            wire = {
                "schemaVersion": 1,
                "id": artifact_id,
                "name": draft.name,
                "description": draft.description,
                "kind": draft.kind,
                "category": draft.category,
                "tags": list(draft.tags),
                "compatibility": dict(draft.compatibility),
                "declaredRisk": draft.declared_risk,
                "source": {
                    "type": draft.source.type,
                    "ref": draft.source.ref,
                    "client": draft.source.client,
                    "productVersion": draft.source.product_version,
                    "provenance": dict(draft.source.provenance),
                },
                "status": draft.status,
                "verified": False,
                "verification": None,
                "content": draft.content,
                "argsSchema": dict(draft.args_schema),
                "contentHash": compute_content_hash(
                    draft.kind, draft.content, draft.args_schema
                ),
                "revision": 1,
                "createdAt": 1,
                "updatedAt": 1,
                "lastUsedAt": None,
            }
            created.append(ToolArtifact.from_dict(wire))
        for artifact in created:
            self.artifacts[artifact.id] = artifact
        if created:
            self.revision += 1
        return created


def zip_info(
    name: str,
    *,
    mode: int = stat.S_IFREG | 0o600,
    extra: bytes = b"",
) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = mode << 16
    info.extra = extra
    return info


def build_zip(
    path: Path,
    entries: list[tuple[zipfile.ZipInfo | str, bytes]],
    *,
    compression: int = zipfile.ZIP_STORED,
) -> Path:
    with zipfile.ZipFile(path, "w", compression=compression) as package:
        for entry, data in entries:
            info = zip_info(entry) if isinstance(entry, str) else entry
            info.compress_type = compression
            package.writestr(info, data)
    requested_backslashes = [
        entry for entry, _ in entries if isinstance(entry, str) and "\\" in entry
    ]
    if requested_backslashes:
        archive = path.read_bytes()
        for requested in requested_backslashes:
            archive = archive.replace(
                requested.replace("\\", "/").encode("utf-8"),
                requested.encode("utf-8"),
            )
        path.write_bytes(archive)
    return path


def package_from_wires(
    path: Path,
    wires: list[dict[str, Any]],
    *,
    manifest_overrides: dict[str, Any] | None = None,
    extra_entries: list[tuple[zipfile.ZipInfo | str, bytes]] | None = None,
) -> Path:
    rows = []
    entries: list[tuple[zipfile.ZipInfo | str, bytes]] = []
    for wire in wires:
        artifact_path = (
            "artifacts/"
            + hashlib.sha256(wire["id"].encode("utf-8")).hexdigest()
            + ".json"
        )
        rows.append(
            {
                "id": wire["id"],
                "path": artifact_path,
                "contentHash": wire["contentHash"],
            }
        )
        entries.append((artifact_path, canonical_json_bytes(wire)))
    manifest: dict[str, Any] = {
        "format": "ae-mcp-tools",
        "schemaVersion": 1,
        "artifacts": rows,
    }
    if manifest_overrides:
        manifest.update(manifest_overrides)
    return build_zip(
        path,
        [("manifest.json", canonical_json_bytes(manifest)), *entries, *(extra_entries or [])],
    )


def quarantine_factory(parent: Path):
    counter = [0]

    @contextlib.contextmanager
    def factory(*, prefix: str):
        counter[0] += 1
        root = parent / f"{prefix}{counter[0]}"
        root.mkdir(mode=0o700)
        try:
            yield root
        finally:
            shutil.rmtree(root, ignore_errors=True)

    return factory


def make_manager(store: Any, scanner: Any, tmp_path: Path, **kwargs: Any):
    return ToolPackageManager(
        store,
        scanner,
        temp_dir_factory=quarantine_factory(tmp_path),
        **kwargs,
    )


@pytest.fixture
def package_manager(tmp_path: Path):
    manager = make_manager(FakeStore(), RegexSecretScanner(), tmp_path)
    yield manager
    for import_id in list(manager._pending):
        manager.discard_import(import_id)


@pytest.fixture
def saved_artifact() -> ToolArtifact:
    return ToolArtifact.from_dict(artifact_wire(_sensitive_source=True))


@pytest.mark.parametrize(
    ("suffix", "platforms"),
    [
        (".ps1", ["windows"]),
        (".psm1", ["windows"]),
        (".bat", ["windows"]),
        (".cmd", ["windows"]),
        (".sh", ["macos", "linux"]),
        (".command", ["macos", "linux"]),
    ],
)
def test_system_command_import_is_classified_external_and_quarantined(
    tmp_path: Path, suffix: str, platforms: list[str]
) -> None:
    store = FakeStore()
    manager = make_manager(store, RegexSecretScanner(), tmp_path)
    source = tmp_path / f"developer{suffix}"
    source.write_text("echo blocked\n", encoding="utf-8")

    preview = manager.preview_import(source)
    item = preview.artifacts[0]
    assert item.summary.kind == "system-command"
    assert item.summary.declared_risk == "external"
    assert item.calculated_risk == "external"
    created = manager.commit_import(preview.import_id, {})
    assert len(created) == 1
    assert created[0].kind == "system-command"
    assert created[0].status == "candidate"
    assert created[0].declared_risk == "external"
    assert created[0].compatibility == {
        "platforms": platforms,
        "runtime": "system-command",
    }
    assert created[0].source.ref == source.name
    assert str(tmp_path) not in created[0].source.ref


def test_system_command_import_remains_readable_after_persisting(tmp_path: Path) -> None:
    root = tmp_path / "tools"
    manager = make_manager(ToolArtifactStore(root), RegexSecretScanner(), tmp_path)
    source = tmp_path / "developer.ps1"
    source.write_text("Write-Output blocked\n", encoding="utf-8")

    preview = manager.preview_import(source)
    [created] = manager.commit_import(preview.import_id, {})

    reopened = ToolArtifactStore(root)
    [summary] = reopened.list(statuses={"candidate"})
    persisted = reopened.get(created.id)
    assert summary.kind == "system-command"
    assert persisted.kind == "system-command"
    assert persisted.declared_risk == "external"
    assert persisted.content == "Write-Output blocked\n"


@pytest.mark.parametrize(
    "entry_name",
    [
        "../escape.json",
        "/absolute.json",
        "C:/escape.json",
        "\\\\server\\share\\escape.json",
        "artifacts\\backslash.json",
        "artifacts/./dot.json",
        "artifacts//empty.json",
    ],
)
def test_import_rejects_unsafe_cross_platform_paths(
    package_manager: ToolPackageManager, tmp_path: Path, entry_name: str
) -> None:
    package = build_zip(tmp_path / "bad.aemcptools", [(entry_name, b"{}")])
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(package)
    assert raised.value.code == "UNSAFE_ARCHIVE_PATH"
    assert package_manager.store.list() == []


def test_unicode_casefold_collision_is_rejected(
    package_manager: ToolPackageManager, tmp_path: Path
) -> None:
    package = build_zip(
        tmp_path / "collision.aemcptools",
        [
            ("artifacts/Caf\u00e9.json", b"{}"),
            ("artifacts/CAFE\u0301.json", b"{}"),
        ],
    )
    with pytest.raises(ToolPackageError, match="cross-platform collision"):
        package_manager.preview_import(package)


def test_duplicate_central_names_and_encryption_are_rejected(
    package_manager: ToolPackageManager, tmp_path: Path
) -> None:
    with pytest.warns(UserWarning, match="Duplicate name"):
        duplicate = build_zip(
            tmp_path / "duplicate.aemcptools",
            [("manifest.json", b"{}"), ("manifest.json", b"{}")],
        )
    with pytest.raises(ToolPackageError) as duplicate_error:
        package_manager.preview_import(duplicate)
    assert duplicate_error.value.code == "DUPLICATE_ARCHIVE_PATH"

    encrypted = build_zip(tmp_path / "encrypted.aemcptools", [("manifest.json", b"{}")])
    data = bytearray(encrypted.read_bytes())
    for signature, flag_offset in ((b"PK\x03\x04", 6), (b"PK\x01\x02", 8)):
        start = 0
        while (offset := data.find(signature, start)) >= 0:
            flags = struct.unpack_from("<H", data, offset + flag_offset)[0] | 1
            struct.pack_into("<H", data, offset + flag_offset, flags)
            start = offset + 4
    encrypted.write_bytes(data)
    with pytest.raises(ToolPackageError) as encrypted_error:
        package_manager.preview_import(encrypted)
    assert encrypted_error.value.code == "ENCRYPTED_ARCHIVE"


@pytest.mark.parametrize(
    "mode",
    [
        stat.S_IFLNK | 0o777,
        stat.S_IFCHR | 0o600,
        stat.S_IFBLK | 0o600,
        stat.S_IFIFO | 0o600,
        stat.S_IFSOCK | 0o600,
    ],
)
def test_import_rejects_non_regular_unix_members(
    package_manager: ToolPackageManager, tmp_path: Path, mode: int
) -> None:
    package = build_zip(
        tmp_path / f"special-{mode}.aemcptools",
        [(zip_info("manifest.json", mode=mode), b"{}")],
    )
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(package)
    assert raised.value.code == "UNSAFE_ARCHIVE_MEMBER"


def test_import_rejects_hardlink_like_unix_extra_field(
    package_manager: ToolPackageManager, tmp_path: Path
) -> None:
    unix_extra = struct.pack("<HH", 0x000D, 0)
    package = build_zip(
        tmp_path / "hardlink.aemcptools",
        [(zip_info("manifest.json", extra=unix_extra), b"{}")],
    )
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(package)
    assert raised.value.code == "UNSAFE_ARCHIVE_MEMBER"


@pytest.mark.parametrize("name", ["artifacts/nested.zip", "artifacts/NESTED.AEMCPTOOLS"])
def test_nested_archive_extensions_are_rejected(
    package_manager: ToolPackageManager, tmp_path: Path, name: str
) -> None:
    package = build_zip(tmp_path / "nested.aemcptools", [(name, b"not-an-archive")])
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(package)
    assert raised.value.code == "NESTED_ARCHIVE"


def test_nested_archive_magic_is_rejected(
    package_manager: ToolPackageManager, tmp_path: Path
) -> None:
    package = build_zip(
        tmp_path / "nested-magic.aemcptools",
        [("manifest.json", b"PK\x03\x04{}")],
    )
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(package)
    assert raised.value.code == "NESTED_ARCHIVE"


def test_manifest_references_are_closed_world(
    package_manager: ToolPackageManager, tmp_path: Path
) -> None:
    wire = artifact_wire()
    undeclared = package_from_wires(
        tmp_path / "undeclared.aemcptools",
        [wire],
        extra_entries=[("notes.json", b"{}")],
    )
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(undeclared)
    assert raised.value.code == "UNDECLARED_ARCHIVE_MEMBER"

    missing = package_from_wires(tmp_path / "missing.aemcptools", [wire])
    with zipfile.ZipFile(missing, "r") as source:
        manifest = source.read("manifest.json")
    build_zip(missing, [("manifest.json", manifest)])
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(missing)
    assert raised.value.code == "MISSING_ARCHIVE_MEMBER"

    artifact_path = (
        "artifacts/"
        + hashlib.sha256(wire["id"].encode()).hexdigest()
        + ".json"
    )
    unreferenced_manifest = canonical_json_bytes(
        {"format": "ae-mcp-tools", "schemaVersion": 1, "artifacts": []}
    )
    unreferenced = build_zip(
        tmp_path / "unreferenced.aemcptools",
        [
            ("manifest.json", unreferenced_manifest),
            (artifact_path, canonical_json_bytes(wire)),
        ],
    )
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(unreferenced)
    assert raised.value.code == "UNDECLARED_ARCHIVE_MEMBER"


def test_limits_accept_boundary_and_reject_one_over(
    package_manager: ToolPackageManager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    base = build_zip(tmp_path / "base.aemcptools", [("manifest.json", b"{}")])
    monkeypatch.setattr(archive_module, "MAX_ARCHIVE_BYTES", base.stat().st_size)
    with pytest.raises(ToolPackageError) as at_boundary:
        package_manager.preview_import(base)
    assert at_boundary.value.code != "ARCHIVE_LIMIT_EXCEEDED"
    monkeypatch.setattr(archive_module, "MAX_ARCHIVE_BYTES", base.stat().st_size - 1)
    with pytest.raises(ToolPackageError) as over_archive:
        package_manager.preview_import(base)
    assert over_archive.value.code == "ARCHIVE_LIMIT_EXCEEDED"

    monkeypatch.setattr(archive_module, "MAX_ARCHIVE_BYTES", 10_000)
    monkeypatch.setattr(archive_module, "MAX_FILE_BYTES", 3)
    file_boundary = build_zip(
        tmp_path / "file-boundary.aemcptools", [("manifest.json", b"123")]
    )
    with pytest.raises(ToolPackageError) as file_at_boundary:
        package_manager.preview_import(file_boundary)
    assert file_at_boundary.value.code != "ARCHIVE_LIMIT_EXCEEDED"
    file_over = build_zip(
        tmp_path / "file-over.aemcptools", [("manifest.json", b"1234")]
    )
    with pytest.raises(ToolPackageError) as over_file:
        package_manager.preview_import(file_over)
    assert over_file.value.code == "ARCHIVE_LIMIT_EXCEEDED"

    monkeypatch.setattr(archive_module, "MAX_FILE_BYTES", 10)
    monkeypatch.setattr(archive_module, "MAX_EXPANDED_BYTES", 6)
    expanded_boundary = build_zip(
        tmp_path / "expanded-boundary.aemcptools",
        [("manifest.json", b"123"), ("artifacts/x.json", b"456")],
    )
    with pytest.raises(ToolPackageError) as expanded_at_boundary:
        package_manager.preview_import(expanded_boundary)
    assert expanded_at_boundary.value.code != "ARCHIVE_LIMIT_EXCEEDED"
    monkeypatch.setattr(archive_module, "MAX_EXPANDED_BYTES", 5)
    with pytest.raises(ToolPackageError) as over_expanded:
        package_manager.preview_import(expanded_boundary)
    assert over_expanded.value.code == "ARCHIVE_LIMIT_EXCEEDED"

    monkeypatch.setattr(archive_module, "MAX_EXPANDED_BYTES", 100)
    monkeypatch.setattr(archive_module, "MAX_ENTRIES", 2)
    with pytest.raises(ToolPackageError) as entries_at_boundary:
        package_manager.preview_import(expanded_boundary)
    assert entries_at_boundary.value.code != "ARCHIVE_LIMIT_EXCEEDED"
    monkeypatch.setattr(archive_module, "MAX_ENTRIES", 1)
    with pytest.raises(ToolPackageError) as over_entries:
        package_manager.preview_import(expanded_boundary)
    assert over_entries.value.code == "ARCHIVE_LIMIT_EXCEEDED"

    monkeypatch.setattr(archive_module, "MAX_ENTRIES", 10)
    monkeypatch.setattr(archive_module, "MAX_DEPTH", 2)
    depth_boundary = build_zip(
        tmp_path / "depth-boundary.aemcptools", [("a/b", b"{}")]
    )
    with pytest.raises(ToolPackageError) as depth_at_boundary:
        package_manager.preview_import(depth_boundary)
    assert depth_at_boundary.value.code != "ARCHIVE_LIMIT_EXCEEDED"
    depth_over = build_zip(
        tmp_path / "depth-over.aemcptools", [("a/b/c", b"{}")]
    )
    with pytest.raises(ToolPackageError) as over_depth:
        package_manager.preview_import(depth_over)
    assert over_depth.value.code == "ARCHIVE_LIMIT_EXCEEDED"


def test_compression_ratio_accepts_boundary_and_rejects_over(
    package_manager: ToolPackageManager, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(archive_module, "MAX_COMPRESSION_RATIO", 1)
    stored = build_zip(tmp_path / "stored.aemcptools", [("manifest.json", b"x" * 200)])
    with pytest.raises(ToolPackageError) as at_boundary:
        package_manager.preview_import(stored)
    assert at_boundary.value.code != "ARCHIVE_LIMIT_EXCEEDED"
    compressed = build_zip(
        tmp_path / "compressed.aemcptools",
        [("manifest.json", b"x" * 200)],
        compression=zipfile.ZIP_DEFLATED,
    )
    with pytest.raises(ToolPackageError) as over:
        package_manager.preview_import(compressed)
    assert over.value.code == "ARCHIVE_LIMIT_EXCEEDED"


def test_package_constants_match_locked_limits() -> None:
    assert archive_module.MAX_ARCHIVE_BYTES == 10 * 1024 * 1024
    assert archive_module.MAX_EXPANDED_BYTES == 50 * 1024 * 1024
    assert archive_module.MAX_FILE_BYTES == 5 * 1024 * 1024
    assert archive_module.MAX_ENTRIES == 512
    assert archive_module.MAX_DEPTH == 8
    assert archive_module.MAX_COMPRESSION_RATIO == 100
    assert archive_module.PACKAGE_SCHEMA_VERSION == 1


def test_unknown_schema_unknown_keys_and_content_hash_tampering_are_rejected(
    package_manager: ToolPackageManager, tmp_path: Path
) -> None:
    wire = artifact_wire()
    unknown_schema = package_from_wires(
        tmp_path / "schema.aemcptools", [wire], manifest_overrides={"schemaVersion": 2}
    )
    with pytest.raises(ToolPackageError) as schema_error:
        package_manager.preview_import(unknown_schema)
    assert schema_error.value.code == "UNSUPPORTED_PACKAGE_SCHEMA"

    unknown_key = package_from_wires(
        tmp_path / "key.aemcptools", [wire], manifest_overrides={"extra": True}
    )
    with pytest.raises(ToolPackageError) as key_error:
        package_manager.preview_import(unknown_key)
    assert key_error.value.code == "INVALID_MANIFEST"

    unknown_artifact_key = artifact_wire(extra=True)
    package = package_from_wires(
        tmp_path / "artifact-key.aemcptools", [unknown_artifact_key]
    )
    with pytest.raises(ToolPackageError) as artifact_key_error:
        package_manager.preview_import(package)
    assert artifact_key_error.value.code == "INVALID_ARTIFACT"

    tampered = artifact_wire(contentHash="0" * 64)
    package = package_from_wires(tmp_path / "tampered.aemcptools", [tampered])
    with pytest.raises(ToolPackageError) as hash_error:
        package_manager.preview_import(package)
    assert hash_error.value.code == "CONTENT_HASH_MISMATCH"


class FindingScanner:
    def scan_bytes(self, name: str, data: bytes):
        del data
        if name.startswith("artifacts/"):
            return (SecretFinding("api-key-header", name, 7, 11),)
        return ()


class FailingScanner:
    def scan_bytes(self, name: str, data: bytes):
        del name, data
        raise RuntimeError("scanner leaked-secret-value")


def test_scanner_findings_are_redacted_and_scanner_exceptions_fail_closed(
    tmp_path: Path,
) -> None:
    package = package_from_wires(tmp_path / "secret.aemcptools", [artifact_wire()])
    finding_manager = make_manager(FakeStore(), FindingScanner(), tmp_path)
    with pytest.raises(ToolPackageError) as finding_error:
        finding_manager.preview_import(package)
    assert finding_error.value.code == "SECRET_DETECTED"
    assert finding_error.value.details == (
        {
            "kind": "api-key-header",
            "file": finding_error.value.details[0]["file"],
            "line": 7,
            "column": 11,
        },
    )
    rendered = str(finding_error.value) + repr(finding_error.value.details)
    assert "private-client" not in rendered
    assert "do-not-export" not in rendered

    failing_manager = make_manager(FakeStore(), FailingScanner(), tmp_path)
    with pytest.raises(ToolPackageError) as scanner_error:
        failing_manager.preview_import(package)
    assert scanner_error.value.code == "SECRET_SCANNER_UNAVAILABLE"
    assert "leaked-secret-value" not in str(scanner_error.value)


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("X-Custom-Token", "opaque-custom-token"),
        ("client_secret", "opaque-client-secret"),
        ("password", "opaque-password"),
    ],
)
def test_import_rejects_credential_named_values_without_known_prefixes(
    package_manager: ToolPackageManager,
    tmp_path: Path,
    name: str,
    value: str,
) -> None:
    wire = artifact_wire()
    wire["source"]["provenance"] = {name: value}
    package = package_from_wires(tmp_path / f"{name}.aemcptools", [wire])
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(package)
    assert raised.value.code == "SECRET_DETECTED"
    assert value not in str(raised.value) + repr(raised.value.details)


@pytest.mark.parametrize(
    "content",
    [
        "X-Custom-Token: opaque-custom-token",
        "client_secret=opaque-client-secret",
        "password='opaque-password'",
    ],
)
def test_import_recursively_scans_artifact_content_strings(
    package_manager: ToolPackageManager,
    tmp_path: Path,
    content: str,
) -> None:
    package = package_from_wires(
        tmp_path / "content-secret.aemcptools",
        [artifact_wire(content=content)],
    )
    with pytest.raises(ToolPackageError) as raised:
        package_manager.preview_import(package)
    assert raised.value.code == "SECRET_DETECTED"
    assert content not in str(raised.value) + repr(raised.value.details)


def test_round_trip_export_is_byte_deterministic_and_export_safe(
    package_manager: ToolPackageManager,
    tmp_path: Path,
    saved_artifact: ToolArtifact,
) -> None:
    package_manager.store.add(saved_artifact)
    first = tmp_path / "first.aemcptools"
    second = tmp_path / "second.aemcptools"
    first_result = package_manager.export([saved_artifact.id], first)
    second_result = package_manager.export([saved_artifact.id], second)
    assert first.read_bytes() == second.read_bytes()
    assert first_result.package_sha256 == second_result.package_sha256
    assert first_result.path == first

    with zipfile.ZipFile(first) as package:
        names = package.namelist()
        assert names == sorted(names)
        for info in package.infolist():
            assert info.compress_type == zipfile.ZIP_STORED
            assert info.date_time == (1980, 1, 1, 0, 0, 0)
            assert info.create_system == 3
            assert stat.S_IFMT(info.external_attr >> 16) == stat.S_IFREG
            assert stat.S_IMODE(info.external_attr >> 16) == 0o600
        artifact_name = next(name for name in names if name.startswith("artifacts/"))
        exported = json.loads(package.read(artifact_name))
    rendered = canonical_json_bytes(exported).decode("utf-8")
    for forbidden in (
        "/Users/person/private/provider-config.json",
        "private-client",
        "private-provider-shape",
        "do-not-export",
        "Authorization",
    ):
        assert forbidden not in rendered
    assert exported["source"]["provenance"] == {
        "contentHash": saved_artifact.content_hash,
        "originalArtifactId": saved_artifact.id,
    }


def test_export_failure_preserves_destination(tmp_path: Path, saved_artifact: ToolArtifact) -> None:
    store = FakeStore()
    store.add(saved_artifact)
    destination = tmp_path / "existing.aemcptools"
    destination.write_bytes(b"previous")
    manager = make_manager(store, FindingScanner(), tmp_path)
    with pytest.raises(ToolPackageError) as raised:
        manager.export([saved_artifact.id], destination)
    assert raised.value.code == "SECRET_DETECTED"
    assert destination.read_bytes() == b"previous"

    absent = tmp_path / "absent.aemcptools"
    with pytest.raises(ToolPackageError):
        manager.export([saved_artifact.id], absent)
    assert not absent.exists()

    unavailable = make_manager(store, FailingScanner(), tmp_path)
    with pytest.raises(ToolPackageError) as scanner_error:
        unavailable.export([saved_artifact.id], destination)
    assert scanner_error.value.code == "SECRET_SCANNER_UNAVAILABLE"
    assert "leaked-secret-value" not in str(scanner_error.value)
    assert destination.read_bytes() == b"previous"


def test_quarantine_creation_failure_is_fail_closed(tmp_path: Path) -> None:
    class BrokenContext:
        def __enter__(self):
            raise RuntimeError("private-path-and-secret")

        def __exit__(self, *_args: Any) -> None:
            return None

    manager = ToolPackageManager(
        FakeStore(),
        RegexSecretScanner(),
        temp_dir_factory=lambda **_kwargs: BrokenContext(),
    )
    package = package_from_wires(tmp_path / "quarantine.aemcptools", [artifact_wire()])
    with pytest.raises(ToolPackageError) as raised:
        manager.preview_import(package)
    assert raised.value.code == "QUARANTINE_UNAVAILABLE"
    assert "private-path-and-secret" not in str(raised.value)


def test_default_private_quarantine_can_preview_and_discard(tmp_path: Path) -> None:
    manager = ToolPackageManager(FakeStore(), RegexSecretScanner())
    package = package_from_wires(
        tmp_path / "default-quarantine.aemcptools", [artifact_wire()]
    )

    preview = manager.preview_import(package)

    assert preview.artifacts
    manager.discard_import(preview.import_id)


def test_import_resets_trust_and_remaps_trusted_namespace(
    package_manager: ToolPackageManager, tmp_path: Path
) -> None:
    wire = artifact_wire(
        id="builtin:skill:spoofed",
        status="pinned",
        verified=True,
        verification={
            "method": "user-reviewed",
            "verifiedAt": 1,
            "evidenceHash": None,
        },
    )
    package = package_from_wires(tmp_path / "spoof.aemcptools", [wire])
    preview = package_manager.preview_import(package)
    assert preview.artifacts[0].summary.status == "candidate"
    assert preview.artifacts[0].summary.verified is False
    created = package_manager.commit_import(preview.import_id, {})
    assert len(created) == 1
    assert created[0].id.startswith("user:")
    assert created[0].status == "candidate"
    assert created[0].verified is False
    assert created[0].source.type == "imported"
    assert created[0].source.client is None
    assert created[0].source.provenance == {
        "originalArtifactId": "builtin:skill:spoofed",
        "contentHash": created[0].content_hash,
    }


def test_atomic_commit_fault_leaves_no_candidates(tmp_path: Path) -> None:
    store = FakeStore()
    manager = make_manager(store, RegexSecretScanner(), tmp_path)
    package = package_from_wires(tmp_path / "atomic.aemcptools", [artifact_wire()])
    preview = manager.preview_import(package)
    store.fail_batch = True
    with pytest.raises(OSError, match="injected"):
        manager.commit_import(preview.import_id, {})
    assert store.list() == []
    manager.discard_import(preview.import_id)


def test_real_store_commit_creates_only_candidate_artifacts(tmp_path: Path) -> None:
    store = ToolArtifactStore(root=tmp_path / "tools")
    manager = make_manager(store, RegexSecretScanner(), tmp_path)
    package = package_from_wires(tmp_path / "real-store.aemcptools", [artifact_wire()])
    preview = manager.preview_import(package)
    created = manager.commit_import(preview.import_id, {})
    assert len(created) == 1
    assert created[0].status == "candidate"
    assert created[0].source.type == "imported"
    assert store.get(created[0].id).content == "return 1;"


def test_conflict_requires_explicit_keep_or_duplicate(tmp_path: Path) -> None:
    existing = ToolArtifact.from_dict(artifact_wire(content="return 1;"))
    incoming = artifact_wire(content="return 2;")

    keep_store = FakeStore()
    keep_store.add(existing)
    keep_manager = make_manager(keep_store, RegexSecretScanner(), tmp_path)
    keep_package = package_from_wires(tmp_path / "keep.aemcptools", [incoming])
    keep_preview = keep_manager.preview_import(keep_package)
    conflict = keep_preview.conflicts[0]
    assert conflict.existing_id == existing.id
    assert keep_preview.artifacts[0].content_changed is True
    with pytest.raises(ToolPackageError) as missing:
        keep_manager.commit_import(keep_preview.import_id, {})
    assert missing.value.code == "MISSING_CONFLICT_RESOLUTION"
    assert keep_manager.commit_import(
        keep_preview.import_id, {conflict.conflict_id: "keep"}
    ) == []
    assert keep_store.get(existing.id).content == "return 1;"

    duplicate_store = FakeStore()
    duplicate_store.add(existing)
    duplicate_manager = make_manager(duplicate_store, RegexSecretScanner(), tmp_path)
    duplicate_package = package_from_wires(
        tmp_path / "duplicate-conflict.aemcptools", [incoming]
    )
    duplicate_preview = duplicate_manager.preview_import(duplicate_package)
    duplicate_conflict = duplicate_preview.conflicts[0]
    with pytest.raises(ToolPackageError) as replace:
        duplicate_manager.commit_import(
            duplicate_preview.import_id,
            {duplicate_conflict.conflict_id: "replace"},  # type: ignore[dict-item]
        )
    assert replace.value.code == "INVALID_CONFLICT_RESOLUTION"
    created = duplicate_manager.commit_import(
        duplicate_preview.import_id,
        {duplicate_conflict.conflict_id: "duplicate"},
    )
    assert len(created) == 1
    assert created[0].id != existing.id
    assert duplicate_store.get(existing.id).content == "return 1;"


def test_discard_and_expiry_remove_quarantine(tmp_path: Path) -> None:
    now = [100]
    manager = make_manager(
        FakeStore(), RegexSecretScanner(), tmp_path, clock=lambda: now[0]
    )
    package = package_from_wires(tmp_path / "pending.aemcptools", [artifact_wire()])
    discarded = manager.preview_import(package)
    discarded_root = manager._pending[discarded.import_id].root
    assert discarded_root.exists()
    manager.discard_import(discarded.import_id)
    assert not discarded_root.exists()

    expired = manager.preview_import(package)
    expired_root = manager._pending[expired.import_id].root
    now[0] = expired.expires_at
    assert manager.cleanup_expired() == 1
    assert not expired_root.exists()
    with pytest.raises(ToolPackageError) as missing:
        manager.commit_import(expired.import_id, {})
    assert missing.value.code == "IMPORT_NOT_FOUND"
