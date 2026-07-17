"""Deterministic, fail-closed import and export for Tool Library packages."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import stat
import struct
import time
import unicodedata
import zipfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, ContextManager, Literal, TypeAlias, cast
from uuid import uuid4

from ae_mcp.platform_files import atomic_replace_bytes, private_temp_dir
from ae_mcp.tool_artifact import (
    ArtifactRisk,
    JsonValue,
    ToolArtifact,
    ToolArtifactDraft,
    ToolSource,
    ToolSummary,
    canonical_json_bytes,
    compute_content_hash,
    max_risk,
    new_user_artifact_id,
)
from ae_mcp.tool_secrets import SecretFinding, SecretScanner
from ae_mcp.tool_store import ToolArtifactStore, ToolNotFound


MAX_ARCHIVE_BYTES = 10 * 1024 * 1024
MAX_EXPANDED_BYTES = 50 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024
MAX_ENTRIES = 512
MAX_DEPTH = 8
MAX_COMPRESSION_RATIO = 100
PACKAGE_SCHEMA_VERSION = 1
IMPORT_TTL_SECONDS = 15 * 60

ConflictResolution: TypeAlias = Literal["keep", "duplicate"]

_PACKAGE_FORMAT = "ae-mcp-tools"
_MANIFEST_KEYS = frozenset({"format", "schemaVersion", "artifacts"})
_MANIFEST_ARTIFACT_KEYS = frozenset({"id", "path", "contentHash"})
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
_SAFE_ORIGINAL_ID = re.compile(
    r"^(?:user:[0-9a-fA-F-]{36}|legacy:[0-9a-f]{24}|builtin:skill:[a-z0-9][a-z0-9_-]{0,127})$"
)
_WINDOWS_RESERVED = frozenset(
    {
        "con",
        "prn",
        "aux",
        "nul",
        "com1",
        "com2",
        "com3",
        "com4",
        "com5",
        "com6",
        "com7",
        "com8",
        "com9",
        "lpt1",
        "lpt2",
        "lpt3",
        "lpt4",
        "lpt5",
        "lpt6",
        "lpt7",
        "lpt8",
        "lpt9",
    }
)
_LINK_BEARING_UNIX_EXTRAS = frozenset({0x000D, 0x5855, 0x756E, 0x7855, 0x7875})
_NESTED_ARCHIVE_SUFFIXES = (".zip", ".aemcptools")
_NESTED_ARCHIVE_MAGIC = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
_SYSTEM_COMMAND_SUFFIXES = frozenset(
    {".ps1", ".psm1", ".bat", ".cmd", ".sh", ".command"}
)


@dataclass(frozen=True)
class ImportConflict:
    conflict_id: str
    incoming_id: str
    incoming_name: str
    existing_id: str
    incoming_content_hash: str
    existing_content_hash: str


@dataclass(frozen=True)
class ImportItemPreview:
    summary: ToolSummary
    existing_id: str | None
    metadata_changes: Mapping[str, Mapping[str, JsonValue]]
    content_changed: bool
    calculated_risk: ArtifactRisk


@dataclass(frozen=True)
class ImportPreview:
    import_id: str
    package_sha256: str
    artifacts: tuple[ImportItemPreview, ...]
    conflicts: tuple[ImportConflict, ...]
    highest_risk: ArtifactRisk
    expires_at: int


@dataclass(frozen=True)
class PackageExport:
    path: Path
    package_sha256: str


class ToolPackageError(ValueError):
    """A package failed validation without exposing package or scanner bytes."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: Sequence[Mapping[str, JsonValue]] = (),
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = tuple(dict(item) for item in details)


@dataclass(frozen=True)
class _ArchiveMember:
    info: zipfile.ZipInfo
    name: str
    normalized_name: str
    is_directory: bool


@dataclass
class _PendingImport:
    preview: ImportPreview
    artifacts: tuple[ToolArtifact, ...]
    conflict_by_artifact_id: Mapping[str, ImportConflict]
    store_revision: int
    root: Path
    cleanup: contextlib.ExitStack


def _error(code: str, message: str) -> ToolPackageError:
    return ToolPackageError(code, message)


def _exact_keys(value: Mapping[str, Any], expected: frozenset[str]) -> bool:
    return set(value) == expected


def _summary(artifact: ToolArtifact) -> ToolSummary:
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


def _artifact_path(artifact_id: str) -> str:
    digest = hashlib.sha256(artifact_id.encode("utf-8")).hexdigest()
    return f"artifacts/{digest}.json"


def _json_loads(data: bytes, *, code: str, message: str) -> JsonValue:
    def object_pairs(pairs: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
        result: dict[str, JsonValue] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON object key")
            result[key] = value
        return result

    def reject_constant(_value: str) -> None:
        raise ValueError("non-finite JSON number")

    try:
        value = json.loads(
            data.decode("utf-8", errors="strict"),
            object_pairs_hook=object_pairs,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
        raise _error(code, message) from None
    return cast(JsonValue, value)


def _iter_extra_fields(extra: bytes) -> Sequence[tuple[int, bytes]]:
    fields: list[tuple[int, bytes]] = []
    offset = 0
    while offset < len(extra):
        if len(extra) - offset < 4:
            raise _error("UNSAFE_ARCHIVE_MEMBER", "archive member has malformed metadata")
        field_id = int.from_bytes(extra[offset : offset + 2], "little")
        size = int.from_bytes(extra[offset + 2 : offset + 4], "little")
        offset += 4
        end = offset + size
        if end > len(extra):
            raise _error("UNSAFE_ARCHIVE_MEMBER", "archive member has malformed metadata")
        fields.append((field_id, extra[offset:end]))
        offset = end
    return fields


def _safe_archive_name(info: zipfile.ZipInfo) -> tuple[str, str, bool]:
    original = info.filename
    if not original or "\\" in original or "\x00" in original:
        raise _error("UNSAFE_ARCHIVE_PATH", "archive contains an unsafe cross-platform path")
    if original.startswith(("/", "//")) or _DRIVE_PREFIX.match(original):
        raise _error("UNSAFE_ARCHIVE_PATH", "archive contains an unsafe cross-platform path")
    is_directory = info.is_dir()
    without_trailing = original[:-1] if is_directory and original.endswith("/") else original
    if not without_trailing:
        raise _error("UNSAFE_ARCHIVE_PATH", "archive contains an unsafe cross-platform path")
    segments = without_trailing.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise _error("UNSAFE_ARCHIVE_PATH", "archive contains an unsafe cross-platform path")
    if len(segments) > MAX_DEPTH:
        raise _error("ARCHIVE_LIMIT_EXCEEDED", "archive path depth exceeds the package limit")
    for segment in segments:
        if (
            len(segment) > 255
            or segment.endswith((" ", "."))
            or ":" in segment
            or any(ord(character) < 32 for character in segment)
            or segment.casefold().split(".", 1)[0] in _WINDOWS_RESERVED
        ):
            raise _error("UNSAFE_ARCHIVE_PATH", "archive contains an unsafe cross-platform path")
    name = unicodedata.normalize("NFC", without_trailing)
    normalized = name.casefold()
    return name, normalized, is_directory


def _validate_raw_zip_names(archive: bytes) -> None:
    eocd_offset = archive.rfind(b"PK\x05\x06", max(0, len(archive) - 65_557))
    if eocd_offset < 0 or eocd_offset + 22 > len(archive):
        return
    try:
        (
            _signature,
            disk_number,
            directory_disk,
            disk_entries,
            total_entries,
            directory_size,
            directory_offset,
            comment_size,
        ) = struct.unpack_from("<4s4H2LH", archive, eocd_offset)
    except struct.error:
        raise _error("INVALID_ARCHIVE", "package central directory is invalid") from None
    if (
        disk_number != 0
        or directory_disk != 0
        or disk_entries != total_entries
        or total_entries == 0xFFFF
        or directory_size == 0xFFFFFFFF
        or directory_offset == 0xFFFFFFFF
        or eocd_offset + 22 + comment_size != len(archive)
        or directory_offset + directory_size != eocd_offset
    ):
        raise _error("INVALID_ARCHIVE", "package central directory is invalid")

    position = directory_offset
    for _ in range(total_entries):
        if position + 46 > eocd_offset or archive[position : position + 4] != b"PK\x01\x02":
            raise _error("INVALID_ARCHIVE", "package central directory is invalid")
        name_size, extra_size, entry_comment_size = struct.unpack_from(
            "<3H", archive, position + 28
        )
        local_offset = struct.unpack_from("<L", archive, position + 42)[0]
        name_start = position + 46
        name_end = name_start + name_size
        entry_end = name_end + extra_size + entry_comment_size
        if entry_end > eocd_offset or local_offset + 30 > directory_offset:
            raise _error("INVALID_ARCHIVE", "package central directory is invalid")
        central_name = archive[name_start:name_end]
        if b"\\" in central_name:
            raise _error(
                "UNSAFE_ARCHIVE_PATH",
                "archive contains an unsafe cross-platform path",
            )
        if archive[local_offset : local_offset + 4] != b"PK\x03\x04":
            raise _error("INVALID_ARCHIVE", "package local header is invalid")
        local_name_size, local_extra_size = struct.unpack_from(
            "<2H", archive, local_offset + 26
        )
        local_name_start = local_offset + 30
        local_name_end = local_name_start + local_name_size
        if local_name_end + local_extra_size > directory_offset:
            raise _error("INVALID_ARCHIVE", "package local header is invalid")
        local_name = archive[local_name_start:local_name_end]
        if b"\\" in local_name:
            raise _error(
                "UNSAFE_ARCHIVE_PATH",
                "archive contains an unsafe cross-platform path",
            )
        if local_name != central_name:
            raise _error("INVALID_ARCHIVE", "package member names do not match")
        position = entry_end
    if position != eocd_offset:
        raise _error("INVALID_ARCHIVE", "package central directory is invalid")


def _preflight(infos: Sequence[zipfile.ZipInfo]) -> tuple[_ArchiveMember, ...]:
    if not infos:
        raise _error("INVALID_ARCHIVE", "package archive is empty")
    if len(infos) > MAX_ENTRIES:
        raise _error("ARCHIVE_LIMIT_EXCEEDED", "archive entry count exceeds the package limit")
    seen: set[str] = set()
    expanded = 0
    members: list[_ArchiveMember] = []
    manifest_found = False
    for info in infos:
        if info.flag_bits & 1:
            raise _error("ENCRYPTED_ARCHIVE", "encrypted package members are not supported")
        name, normalized, is_directory = _safe_archive_name(info)
        if normalized in seen:
            raise _error(
                "DUPLICATE_ARCHIVE_PATH",
                "archive contains a duplicate or cross-platform collision",
            )
        seen.add(normalized)
        if normalized == "manifest.json":
            if name != "manifest.json" or is_directory:
                raise _error("INVALID_MANIFEST", "package manifest path is invalid")
            manifest_found = True
        if not is_directory and normalized.endswith(_NESTED_ARCHIVE_SUFFIXES):
            raise _error("NESTED_ARCHIVE", "nested archives are not permitted")
        if is_directory and not (normalized == "artifacts" or normalized.startswith("artifacts/")):
            raise _error("UNDECLARED_ARCHIVE_MEMBER", "archive contains an undeclared directory")

        unix_mode = (info.external_attr >> 16) & 0xFFFF
        unix_type = stat.S_IFMT(unix_mode)
        allowed_type = stat.S_IFDIR if is_directory else stat.S_IFREG
        if unix_type not in {0, allowed_type}:
            raise _error("UNSAFE_ARCHIVE_MEMBER", "archive contains a non-regular member")
        if any(field_id in _LINK_BEARING_UNIX_EXTRAS for field_id, _ in _iter_extra_fields(info.extra)):
            raise _error("UNSAFE_ARCHIVE_MEMBER", "archive member contains link metadata")
        if is_directory:
            if info.file_size != 0:
                raise _error("UNSAFE_ARCHIVE_MEMBER", "archive directory member contains data")
        else:
            if info.file_size > MAX_FILE_BYTES:
                raise _error("ARCHIVE_LIMIT_EXCEEDED", "archive member exceeds the file limit")
            expanded += info.file_size
            if expanded > MAX_EXPANDED_BYTES:
                raise _error("ARCHIVE_LIMIT_EXCEEDED", "archive exceeds the expanded size limit")
            if info.file_size:
                if info.compress_size == 0:
                    raise _error("ARCHIVE_LIMIT_EXCEEDED", "archive member has an unsafe ratio")
                if info.file_size / info.compress_size > MAX_COMPRESSION_RATIO:
                    raise _error("ARCHIVE_LIMIT_EXCEEDED", "archive member has an unsafe ratio")
        members.append(_ArchiveMember(info, name, normalized, is_directory))
    if not manifest_found:
        raise _error("MISSING_MANIFEST", "package archive is missing manifest.json")
    return tuple(members)


def _contains(root: Path, candidate: Path) -> bool:
    try:
        return os.path.commonpath((str(root), str(candidate))) == str(root)
    except ValueError:
        return False


def _ensure_private_parents(root: Path, relative: Path) -> Path:
    current = root
    for segment in relative.parts[:-1]:
        current = current / segment
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            metadata = current.stat(follow_symlinks=False)
            if not stat.S_ISDIR(metadata.st_mode):
                raise _error("UNSAFE_ARCHIVE_MEMBER", "quarantine path is not a directory")
        resolved = current.resolve(strict=True)
        if not _contains(root, resolved):
            raise _error("UNSAFE_ARCHIVE_PATH", "archive path escapes quarantine")
    return current / relative.name


def _write_exclusive_regular(path: Path, data: bytes) -> None:
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_BINARY", 0)
    )
    fd = os.open(path, flags, 0o600)
    try:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode):
            raise _error("UNSAFE_ARCHIVE_MEMBER", "quarantine output is not a regular file")
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                raise OSError("short write while materializing package member")
            view = view[written:]
        if os.name != "nt":
            os.fchmod(fd, 0o600)
    finally:
        os.close(fd)


def _materialize(
    package: zipfile.ZipFile,
    members: Sequence[_ArchiveMember],
    root: Path,
) -> dict[str, bytes]:
    resolved_root = root.resolve(strict=True)
    data_by_name: dict[str, bytes] = {}
    for member in members:
        if member.is_directory:
            continue
        try:
            with package.open(member.info, "r") as source:
                chunks: list[bytes] = []
                size = 0
                while True:
                    chunk = source.read(min(1024 * 1024, MAX_FILE_BYTES + 1 - size))
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_FILE_BYTES or size > member.info.file_size:
                        raise _error(
                            "ARCHIVE_LIMIT_EXCEEDED",
                            "archive member expanded beyond its declared limit",
                        )
                    chunks.append(chunk)
        except ToolPackageError:
            raise
        except (OSError, RuntimeError, zipfile.BadZipFile, EOFError):
            raise _error("INVALID_ARCHIVE", "package member could not be read safely") from None
        if size != member.info.file_size:
            raise _error("INVALID_ARCHIVE", "package member size does not match metadata")
        data = b"".join(chunks)
        relative = Path(*member.name.split("/"))
        destination = _ensure_private_parents(resolved_root, relative)
        if not _contains(resolved_root, destination.parent.resolve(strict=True)):
            raise _error("UNSAFE_ARCHIVE_PATH", "archive path escapes quarantine")
        _write_exclusive_regular(destination, data)
        data_by_name[member.name] = data
    return data_by_name


def _finding_detail(name: str, finding: SecretFinding) -> dict[str, JsonValue]:
    kind = finding.kind
    if not isinstance(kind, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", kind):
        kind = "secret"
    line = finding.line if type(finding.line) is int and finding.line >= 1 else 1
    column = finding.column if type(finding.column) is int and finding.column >= 1 else 1
    return {"kind": kind, "file": name, "line": line, "column": column}


def _scan_all(scanner: SecretScanner, members: Mapping[str, bytes]) -> None:
    details: list[dict[str, JsonValue]] = []
    for name in sorted(members):
        try:
            findings = tuple(scanner.scan_bytes(name, members[name]))
            details.extend(_finding_detail(name, finding) for finding in findings)
            scan_json = getattr(scanner, "scan_json", None)
            if callable(scan_json) and name.endswith(".json"):
                try:
                    value = json.loads(members[name].decode("utf-8", errors="strict"))
                except (UnicodeError, json.JSONDecodeError):
                    value = None
                if value is not None:
                    json_findings = tuple(scan_json(name, value))
                    details.extend(
                        _finding_detail(name, finding) for finding in json_findings
                    )
        except Exception:
            raise _error(
                "SECRET_SCANNER_UNAVAILABLE",
                "secret scanner could not verify package content",
            ) from None
    if details:
        raise ToolPackageError(
            "SECRET_DETECTED",
            "secret-shaped content was detected in the package",
            details=details,
        )


def _import_source(
    artifact: ToolArtifact, package_sha256: str
) -> ToolSource:
    return ToolSource(
        type="imported",
        ref=f"package:{package_sha256}",
        client=None,
        product_version=artifact.source.product_version,
        provenance={
            "originalArtifactId": artifact.id,
            "contentHash": artifact.content_hash,
        },
    )


def _parse_package(
    data_by_name: Mapping[str, bytes], package_sha256: str
) -> tuple[ToolArtifact, ...]:
    for name, data in data_by_name.items():
        if data.startswith(_NESTED_ARCHIVE_MAGIC):
            raise _error("NESTED_ARCHIVE", "nested archives are not permitted")
        if name != "manifest.json" and not name.startswith("artifacts/"):
            raise _error("UNDECLARED_ARCHIVE_MEMBER", "archive contains an undeclared file")

    manifest_value = _json_loads(
        data_by_name["manifest.json"],
        code="INVALID_MANIFEST",
        message="package manifest is invalid",
    )
    if not isinstance(manifest_value, dict) or not _exact_keys(manifest_value, _MANIFEST_KEYS):
        raise _error("INVALID_MANIFEST", "package manifest has invalid keys")
    if manifest_value["format"] != _PACKAGE_FORMAT:
        raise _error("INVALID_MANIFEST", "package format is unsupported")
    schema_version = manifest_value["schemaVersion"]
    if type(schema_version) is not int or schema_version != PACKAGE_SCHEMA_VERSION:
        raise _error("UNSUPPORTED_PACKAGE_SCHEMA", "package schema version is unsupported")
    raw_rows = manifest_value["artifacts"]
    if not isinstance(raw_rows, list):
        raise _error("INVALID_MANIFEST", "package artifact list is invalid")
    if len(raw_rows) > MAX_ENTRIES - 1:
        raise _error("ARCHIVE_LIMIT_EXCEEDED", "package artifact count exceeds the limit")

    rows: list[tuple[str, str, str]] = []
    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    for raw_row in raw_rows:
        if not isinstance(raw_row, dict) or not _exact_keys(raw_row, _MANIFEST_ARTIFACT_KEYS):
            raise _error("INVALID_MANIFEST", "package artifact entry is invalid")
        artifact_id = raw_row["id"]
        path = raw_row["path"]
        content_hash = raw_row["contentHash"]
        if (
            not isinstance(artifact_id, str)
            or not artifact_id
            or not isinstance(path, str)
            or not isinstance(content_hash, str)
            or not _HEX_64.fullmatch(content_hash)
        ):
            raise _error("INVALID_MANIFEST", "package artifact entry is invalid")
        if path != _artifact_path(artifact_id):
            raise _error("INVALID_MANIFEST", "package artifact path is not canonical")
        if artifact_id in seen_ids or path in seen_paths:
            raise _error("INVALID_MANIFEST", "package artifact entries must be unique")
        seen_ids.add(artifact_id)
        seen_paths.add(path)
        rows.append((artifact_id, path, content_hash))

    declared_files = {"manifest.json", *(path for _, path, _ in rows)}
    actual_files = set(data_by_name)
    missing = declared_files - actual_files
    undeclared = actual_files - declared_files
    if missing:
        raise _error("MISSING_ARCHIVE_MEMBER", "package references a missing artifact file")
    if undeclared:
        raise _error("UNDECLARED_ARCHIVE_MEMBER", "package contains an undeclared artifact file")
    if not rows:
        raise _error("INVALID_MANIFEST", "package must contain at least one artifact")

    artifacts: list[ToolArtifact] = []
    for artifact_id, path, content_hash in rows:
        value = _json_loads(
            data_by_name[path],
            code="INVALID_ARTIFACT",
            message="package artifact JSON is invalid",
        )
        if not isinstance(value, dict):
            raise _error("INVALID_ARTIFACT", "package artifact must be an object")
        try:
            artifact = ToolArtifact.from_dict(value, imported=True)
        except Exception as exc:
            code = "CONTENT_HASH_MISMATCH" if "contentHash" in str(exc) else "INVALID_ARTIFACT"
            message = (
                "package artifact content hash is invalid"
                if code == "CONTENT_HASH_MISMATCH"
                else "package artifact schema is invalid"
            )
            raise _error(code, message) from None
        if artifact.id != artifact_id or artifact.content_hash != content_hash:
            raise _error("CONTENT_HASH_MISMATCH", "package artifact identity or hash is invalid")
        artifacts.append(
            replace(
                artifact,
                source=_import_source(artifact, package_sha256),
                status="candidate",
                verified=False,
                verification=None,
            )
        )
    return tuple(artifacts)


def _metadata_changes(
    incoming: ToolArtifact, existing: ToolArtifact
) -> dict[str, Mapping[str, JsonValue]]:
    fields: tuple[tuple[str, JsonValue, JsonValue], ...] = (
        ("name", existing.name, incoming.name),
        ("description", existing.description, incoming.description),
        ("kind", existing.kind, incoming.kind),
        ("category", existing.category, incoming.category),
        ("tags", list(existing.tags), list(incoming.tags)),
        ("compatibility", dict(existing.compatibility), dict(incoming.compatibility)),
        ("declaredRisk", existing.declared_risk, incoming.declared_risk),
    )
    return {
        name: {"from": before, "to": after}
        for name, before, after in fields
        if before != after
    }


def _safe_original_id(artifact: ToolArtifact) -> str:
    original = artifact.source.provenance.get("originalArtifactId")
    if isinstance(original, str) and _SAFE_ORIGINAL_ID.fullmatch(original):
        return original
    return artifact.id


def _export_wire(artifact: ToolArtifact) -> dict[str, JsonValue]:
    wire = artifact.to_dict(export_safe=True)
    source = wire["source"]
    if not isinstance(source, dict):
        raise _error("INVALID_ARTIFACT", "artifact source could not be exported safely")
    source["ref"] = artifact.id
    source["client"] = None
    source["provenance"] = {
        "originalArtifactId": _safe_original_id(artifact),
        "contentHash": artifact.content_hash,
    }
    return wire


def _deterministic_zip(members: Mapping[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(
        output,
        "w",
        compression=zipfile.ZIP_STORED,
        allowZip64=False,
        strict_timestamps=True,
    ) as package:
        for name in sorted(members):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            package.writestr(info, members[name])
    return output.getvalue()


class ToolPackageManager:
    def __init__(
        self,
        store: ToolArtifactStore,
        scanner: SecretScanner,
        *,
        clock: Callable[[], float | int] | None = None,
        temp_dir_factory: Callable[..., ContextManager[Path]] = private_temp_dir,
    ) -> None:
        self.store = store
        self.scanner = scanner
        self._clock = clock or time.time
        self._temp_dir_factory = temp_dir_factory
        self._pending: dict[str, _PendingImport] = {}

    def _read_archive(self, archive_path: Path) -> bytes:
        path = Path(archive_path)
        try:
            before = path.lstat()
        except OSError:
            raise _error("INVALID_ARCHIVE", "package archive is not a readable regular file") from None
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_ARCHIVE_BYTES:
            code = "ARCHIVE_LIMIT_EXCEEDED" if before.st_size > MAX_ARCHIVE_BYTES else "INVALID_ARCHIVE"
            raise _error(code, "package archive is not a bounded regular file")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        try:
            fd = os.open(path, flags)
        except OSError:
            raise _error("INVALID_ARCHIVE", "package archive could not be opened safely") from None
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or (
                (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino)
            ):
                raise _error("INVALID_ARCHIVE", "package archive changed while opening")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os.read(fd, min(1024 * 1024, MAX_ARCHIVE_BYTES + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ARCHIVE_BYTES:
                    raise _error("ARCHIVE_LIMIT_EXCEEDED", "package archive exceeds the size limit")
                chunks.append(chunk)
            if total != opened.st_size:
                raise _error("INVALID_ARCHIVE", "package archive changed while reading")
            return b"".join(chunks)
        finally:
            os.close(fd)

    def preview_import(self, archive_path: Path) -> ImportPreview:
        archive_path = Path(archive_path)
        archive_bytes = self._read_archive(archive_path)
        if archive_path.suffix.casefold() in _SYSTEM_COMMAND_SUFFIXES:
            return self._preview_system_command(archive_path, archive_bytes)
        _validate_raw_zip_names(archive_bytes)
        package_sha256 = hashlib.sha256(archive_bytes).hexdigest()
        stack = contextlib.ExitStack()
        try:
            try:
                with zipfile.ZipFile(io.BytesIO(archive_bytes), "r") as package:
                    members = _preflight(package.infolist())
                    try:
                        root = Path(
                            stack.enter_context(
                                self._temp_dir_factory(prefix="ae-mcp-tool-import-")
                            )
                        )
                    except Exception:
                        raise _error(
                            "QUARANTINE_UNAVAILABLE",
                            "private import quarantine could not be created",
                        ) from None
                    data_by_name = _materialize(package, members, root)
            except ToolPackageError:
                raise
            except Exception:
                raise _error("INVALID_ARCHIVE", "package archive is invalid") from None

            _scan_all(self.scanner, data_by_name)
            artifacts = _parse_package(data_by_name, package_sha256)
            store_revision = self.store.store_revision()
            previews: list[ImportItemPreview] = []
            conflicts: list[ImportConflict] = []
            conflict_by_artifact_id: dict[str, ImportConflict] = {}
            for artifact in artifacts:
                existing: ToolArtifact | None
                try:
                    existing = self.store.get(artifact.id, include_content=True)
                except (KeyError, FileNotFoundError, ToolNotFound):
                    existing = None
                if existing is None:
                    changes: Mapping[str, Mapping[str, JsonValue]] = {}
                    existing_id = None
                    content_changed = False
                else:
                    conflict = ImportConflict(
                        conflict_id=uuid4().hex,
                        incoming_id=artifact.id,
                        incoming_name=artifact.name,
                        existing_id=existing.id,
                        incoming_content_hash=artifact.content_hash,
                        existing_content_hash=existing.content_hash,
                    )
                    conflicts.append(conflict)
                    conflict_by_artifact_id[artifact.id] = conflict
                    changes = _metadata_changes(artifact, existing)
                    existing_id = existing.id
                    content_changed = artifact.content_hash != existing.content_hash
                previews.append(
                    ImportItemPreview(
                        summary=_summary(artifact),
                        existing_id=existing_id,
                        metadata_changes=changes,
                        content_changed=content_changed,
                        calculated_risk=artifact.declared_risk,
                    )
                )
            if self.store.store_revision() != store_revision:
                raise _error("STORE_CHANGED", "tool store changed during import preview")
            import_id = uuid4().hex
            expires_at = int(self._clock()) + IMPORT_TTL_SECONDS
            preview = ImportPreview(
                import_id=import_id,
                package_sha256=package_sha256,
                artifacts=tuple(previews),
                conflicts=tuple(conflicts),
                highest_risk=max_risk(*(artifact.declared_risk for artifact in artifacts)),
                expires_at=expires_at,
            )
            self._pending[import_id] = _PendingImport(
                preview=preview,
                artifacts=artifacts,
                conflict_by_artifact_id=conflict_by_artifact_id,
                store_revision=store_revision,
                root=root,
                cleanup=stack,
            )
            return preview
        except BaseException:
            stack.close()
            raise

    def _preview_system_command(
        self, source_path: Path, source_bytes: bytes
    ) -> ImportPreview:
        if len(source_bytes) > MAX_FILE_BYTES:
            raise _error(
                "ARCHIVE_LIMIT_EXCEEDED", "system-command asset exceeds the file limit"
            )
        _scan_all(self.scanner, {source_path.name: source_bytes})
        try:
            if source_bytes.startswith((b"\xff\xfe", b"\xfe\xff")):
                content = source_bytes.decode("utf-16")
            else:
                content = source_bytes.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise _error(
                "INVALID_SYSTEM_COMMAND", "system-command asset must be UTF text"
            ) from None
        if "\x00" in content:
            raise _error(
                "INVALID_SYSTEM_COMMAND", "system-command asset contains invalid text"
            )
        package_sha256 = hashlib.sha256(source_bytes).hexdigest()
        now_ms = int(self._clock() * 1000)
        suffix = source_path.suffix.casefold()
        platforms = (
            ["windows"] if suffix in {".ps1", ".psm1", ".bat", ".cmd"}
            else ["macos", "linux"]
        )
        artifact_id = new_user_artifact_id(uuid4())
        content_hash = compute_content_hash("system-command", content, {})
        artifact = ToolArtifact(
            id=artifact_id,
            name=source_path.name,
            description=(
                "Developer-only quarantined system command. It cannot be run by "
                "Tool Library or an MCP agent."
            ),
            kind="system-command",
            category="developer-tools",
            tags=("quarantined", "system-command"),
            compatibility={"platforms": platforms, "runtime": "system-command"},
            declared_risk="external",
            source=ToolSource(
                type="imported",
                ref=source_path.name,
                client=None,
                product_version=None,
                provenance={
                    "packageSha256": package_sha256,
                    "extension": suffix,
                },
            ),
            status="candidate",
            verified=False,
            verification=None,
            content=content,
            args_schema={},
            content_hash=content_hash,
            schema_version=1,
            revision=1,
            created_at=now_ms,
            updated_at=now_ms,
            last_used_at=None,
        )
        store_revision = self.store.store_revision()
        import_id = uuid4().hex
        preview = ImportPreview(
            import_id=import_id,
            package_sha256=package_sha256,
            artifacts=(
                ImportItemPreview(
                    summary=_summary(artifact),
                    existing_id=None,
                    metadata_changes={},
                    content_changed=False,
                    calculated_risk="external",
                ),
            ),
            conflicts=(),
            highest_risk="external",
            expires_at=int(self._clock()) + IMPORT_TTL_SECONDS,
        )
        cleanup = contextlib.ExitStack()
        self._pending[import_id] = _PendingImport(
            preview=preview,
            artifacts=(artifact,),
            conflict_by_artifact_id={},
            store_revision=store_revision,
            root=Path(),
            cleanup=cleanup,
        )
        return preview

    def commit_import(
        self,
        import_id: str,
        resolutions: Mapping[str, ConflictResolution],
    ) -> list[ToolArtifact]:
        pending = self._pending.get(import_id)
        if pending is None:
            raise _error("IMPORT_NOT_FOUND", "import preview does not exist")
        if int(self._clock()) >= pending.preview.expires_at:
            self._pending.pop(import_id, None)
            pending.cleanup.close()
            raise _error("IMPORT_EXPIRED", "import preview has expired")
        if not isinstance(resolutions, Mapping):
            raise _error("INVALID_CONFLICT_RESOLUTION", "conflict resolutions are invalid")
        expected_ids = {conflict.conflict_id for conflict in pending.preview.conflicts}
        supplied_ids = set(resolutions)
        if expected_ids - supplied_ids:
            raise _error(
                "MISSING_CONFLICT_RESOLUTION",
                "every import conflict requires an explicit resolution",
            )
        if supplied_ids - expected_ids:
            raise _error("INVALID_CONFLICT_RESOLUTION", "conflict resolution is unknown")
        if any(value not in {"keep", "duplicate"} for value in resolutions.values()):
            raise _error(
                "INVALID_CONFLICT_RESOLUTION",
                "only keep or duplicate conflict resolutions are permitted",
            )

        drafts: list[ToolArtifactDraft] = []
        for artifact in pending.artifacts:
            conflict = pending.conflict_by_artifact_id.get(artifact.id)
            if conflict is not None and resolutions[conflict.conflict_id] == "keep":
                continue
            drafts.append(
                ToolArtifactDraft(
                    name=artifact.name,
                    description=artifact.description,
                    kind=artifact.kind,
                    category=artifact.category,
                    tags=artifact.tags,
                    compatibility=artifact.compatibility,
                    declared_risk=artifact.declared_risk,
                    source=artifact.source,
                    status="candidate",
                    content=artifact.content,
                    args_schema=artifact.args_schema,
                )
            )
        if drafts:
            created = self.store.create_many_atomic(
                drafts,
                expected_store_revision=pending.store_revision,
            )
        else:
            created = []
        self._pending.pop(import_id, None)
        pending.cleanup.close()
        return created

    def discard_import(self, import_id: str) -> None:
        pending = self._pending.pop(import_id, None)
        if pending is not None:
            pending.cleanup.close()

    def export(
        self, artifact_ids: Sequence[str], destination: Path
    ) -> PackageExport:
        ids = tuple(artifact_ids)
        if not ids or len(set(ids)) != len(ids):
            raise _error("INVALID_EXPORT", "export requires unique artifact IDs")
        if len(ids) + 1 > MAX_ENTRIES:
            raise _error("ARCHIVE_LIMIT_EXCEEDED", "export exceeds the entry count limit")
        artifacts = [self.store.get(artifact_id, include_content=True) for artifact_id in ids]
        rows: list[dict[str, JsonValue]] = []
        members: dict[str, bytes] = {}
        expanded = 0
        for artifact in sorted(artifacts, key=lambda item: (item.id, item.content_hash)):
            path = _artifact_path(artifact.id)
            data = canonical_json_bytes(_export_wire(artifact))
            if len(data) > MAX_FILE_BYTES:
                raise _error("ARCHIVE_LIMIT_EXCEEDED", "export artifact exceeds the file limit")
            expanded += len(data)
            rows.append(
                {"id": artifact.id, "path": path, "contentHash": artifact.content_hash}
            )
            members[path] = data
        manifest: dict[str, JsonValue] = {
            "format": _PACKAGE_FORMAT,
            "schemaVersion": PACKAGE_SCHEMA_VERSION,
            "artifacts": rows,
        }
        manifest_bytes = canonical_json_bytes(manifest)
        if len(manifest_bytes) > MAX_FILE_BYTES:
            raise _error("ARCHIVE_LIMIT_EXCEEDED", "export manifest exceeds the file limit")
        expanded += len(manifest_bytes)
        if expanded > MAX_EXPANDED_BYTES:
            raise _error("ARCHIVE_LIMIT_EXCEEDED", "export exceeds the expanded size limit")
        members["manifest.json"] = manifest_bytes
        _scan_all(self.scanner, members)
        package_bytes = _deterministic_zip(members)
        if len(package_bytes) > MAX_ARCHIVE_BYTES:
            raise _error("ARCHIVE_LIMIT_EXCEEDED", "export package exceeds the archive size limit")
        destination = Path(destination)
        atomic_replace_bytes(destination, package_bytes, mode=0o600)
        return PackageExport(
            path=destination,
            package_sha256=hashlib.sha256(package_bytes).hexdigest(),
        )

    def cleanup_expired(self) -> int:
        now = int(self._clock())
        expired_ids = [
            import_id
            for import_id, pending in self._pending.items()
            if now >= pending.preview.expires_at
        ]
        for import_id in expired_ids:
            pending = self._pending.pop(import_id)
            pending.cleanup.close()
        return len(expired_ids)


__all__ = [
    "ConflictResolution",
    "ImportConflict",
    "ImportItemPreview",
    "ImportPreview",
    "MAX_ARCHIVE_BYTES",
    "MAX_COMPRESSION_RATIO",
    "MAX_DEPTH",
    "MAX_ENTRIES",
    "MAX_EXPANDED_BYTES",
    "MAX_FILE_BYTES",
    "PACKAGE_SCHEMA_VERSION",
    "PackageExport",
    "ToolPackageError",
    "ToolPackageManager",
]
