"""Exact component and formal-After-Effects identity verification."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import plistlib
import re
import stat
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


class IdentityFailure(RuntimeError):
    pass


def _require(condition: Any, message: str) -> None:
    if not condition:
        raise IdentityFailure(message)


def _mapping(value: Any, message: str) -> dict[str, Any]:
    _require(isinstance(value, Mapping), message)
    return dict(value)


def _sha256_file(path: Path, label: str) -> str:
    _require(path.is_file() and not path.is_symlink(), f"{label} is not a regular file")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _require_executable_file(path: Path, label: str) -> str:
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise IdentityFailure(f"{label} is missing") from error
    _require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), f"{label} is not canonical")
    if os.name == "posix":
        _require(stat.S_IMODE(info.st_mode) == 0o755, f"{label} must use mode 0755")
    return _sha256_file(path, label)


def _identity_json(path: Path, label: str) -> tuple[dict[str, Any], str]:
    _require(path.is_file() and not path.is_symlink(), f"{label} is not a regular file")
    payload = path.read_bytes()
    _require(0 < len(payload) <= 4 * 1024 * 1024, f"{label} is empty or unbounded")
    try:
        decoded = json.loads(payload)
    except (UnicodeDecodeError, ValueError) as error:
        raise IdentityFailure(f"{label} is not valid JSON") from error
    return _mapping(decoded, f"{label} must be an object"), hashlib.sha256(payload).hexdigest()


def _validate_declared_hashes(value: Any, label: str) -> None:
    if isinstance(value, Mapping):
        for field, member in value.items():
            if str(field).endswith("Sha256"):
                _require(
                    isinstance(member, str) and SHA256.fullmatch(member),
                    f"{label}.{field} is not a full SHA-256",
                )
            _validate_declared_hashes(member, f"{label}.{field}")
    elif isinstance(value, list):
        for index, member in enumerate(value):
            _validate_declared_hashes(member, f"{label}[{index}]")


@dataclasses.dataclass(frozen=True)
class IdentityConfig:
    expected_sha: str
    native_receipt: Path
    native_manifest: Path
    capabilities_fixture: Path
    formal_ae_app: Path
    identity_home: Path
    expected_ae_bundle_id: str = "com.adobe.AfterEffects.application"
    expected_ae_version: str = "26.3.0"
    expected_ae_build: str = "26.3.0.87"
    expected_ae_host_build: str = "87"
    runtime_version: str = "0.9.2"

    def __post_init__(self) -> None:
        _require(FULL_SHA.fullmatch(self.expected_sha) is not None, "expected SHA is invalid")


@dataclasses.dataclass(frozen=True)
class IdentityProof:
    component_hashes: dict[str, str]
    contract_digests: dict[str, str]
    formal_ae_identity: dict[str, str]


def verify_exact_identity(
    config: IdentityConfig, *, required_capability_ids: Sequence[str]
) -> IdentityProof:
    receipt, receipt_hash = _identity_json(config.native_receipt, "native receipt")
    manifest, manifest_hash = _identity_json(config.native_manifest, "native manifest")
    _validate_declared_hashes(receipt, "nativeReceipt")
    _validate_declared_hashes(manifest, "nativeManifest")
    _require(
        receipt.get("sourceCommit") == config.expected_sha
        and _mapping(receipt.get("source"), "native receipt source is invalid").get("commit")
        == config.expected_sha,
        "native receipt source commit mismatch",
    )
    artifact = _mapping(manifest.get("artifact"), "native manifest artifact is invalid")
    _require(manifest.get("sourceCommitSha") == config.expected_sha, "native manifest SHA mismatch")
    _require(artifact.get("receiptSha256") == receipt_hash, "native manifest receipt mismatch")
    for field in ("bundleTreeSha256", "executableSha256", "piplSha256"):
        _require(
            isinstance(artifact.get(field), str) and SHA256.fullmatch(artifact[field]),
            f"native manifest {field} is invalid",
        )

    cep_path = (
        config.identity_home
        / "Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel/bundle-manifest.json"
    )
    cep, cep_hash = _identity_json(cep_path, "CEP bundle manifest")
    _validate_declared_hashes(cep, "cepManifest")
    _require(cep.get("sourceCommitSha") == config.expected_sha, "CEP manifest SHA mismatch")
    current_path = config.identity_home / ".ae-mcp/runtime/current"
    _require(current_path.is_file() and not current_path.is_symlink(), "runtime current is missing")
    relative = current_path.read_text(encoding="utf-8").strip()
    expected_relative = f"{config.runtime_version}-{config.expected_sha}/macos-arm64"
    _require(relative == expected_relative, "runtime current source mismatch")
    record_path = (
        config.identity_home
        / ".ae-mcp/runtime"
        / relative.split("/", 1)[0]
        / "install-record.json"
    )
    record, record_hash = _identity_json(record_path, "runtime install record")
    _validate_declared_hashes(record, "runtimeInstallRecord")
    launcher_hash = record.get("launcherSha256")
    _require(
        record.get("relative") == relative
        and record.get("sourceCommitSha") == config.expected_sha
        and isinstance(launcher_hash, str)
        and SHA256.fullmatch(launcher_hash),
        "runtime install record source mismatch",
    )
    runtime_manifest_path = (
        config.identity_home / ".ae-mcp/runtime" / relative / "runtime-manifest.json"
    )
    runtime_manifest, runtime_manifest_hash = _identity_json(runtime_manifest_path, "runtime manifest")
    _validate_declared_hashes(runtime_manifest, "runtimeManifest")
    _require(
        record.get("runtimeManifestSha256") == runtime_manifest_hash,
        "install record is not bound to runtime manifest",
    )
    generation_launcher = (
        config.identity_home
        / ".ae-mcp/runtime"
        / relative.split("/", 1)[0]
        / "ae-mcp-launcher"
    )
    stable_launcher = config.identity_home / ".ae-mcp/bin/ae-mcp"
    generation_launcher_hash = _require_executable_file(
        generation_launcher, "runtime generation launcher"
    )
    stable_launcher_hash = _require_executable_file(stable_launcher, "stable launcher")
    _require(
        generation_launcher_hash == launcher_hash == stable_launcher_hash,
        "runtime launcher identity mismatch",
    )

    capabilities, fixture_hash = _identity_json(config.capabilities_fixture, "capabilities fixture")
    result = _mapping(
        _mapping(capabilities.get("response"), "capabilities response is invalid").get("result"),
        "capabilities result is invalid",
    )
    items = result.get("items")
    _require(isinstance(items, list), "capabilities items are invalid")
    contract_digests: dict[str, str] = {}
    for raw in items:
        item = _mapping(raw, "capability descriptor is invalid")
        capability_id = item.get("id")
        digest = item.get("contractDigest")
        if isinstance(capability_id, str) and isinstance(digest, str) and SHA256.fullmatch(digest):
            contract_digests[capability_id] = digest
    missing = sorted(set(required_capability_ids) - set(contract_digests))
    _require(not missing, f"capabilities fixture omitted package IDs: {missing}")

    app = config.formal_ae_app
    _require(app.is_absolute() and app.is_dir() and not app.is_symlink(), "formal AE is invalid")
    plist_path = app / "Contents/Info.plist"
    _require(plist_path.is_file() and not plist_path.is_symlink(), "formal AE plist is invalid")
    try:
        info = plistlib.loads(plist_path.read_bytes())
    except (OSError, plistlib.InvalidFileException) as error:
        raise IdentityFailure("formal AE plist is unreadable") from error
    _require(info.get("CFBundleIdentifier") == config.expected_ae_bundle_id, "AE bundle mismatch")
    _require(info.get("CFBundleShortVersionString") == config.expected_ae_version, "AE version mismatch")
    _require(info.get("CFBundleVersion") == config.expected_ae_build, "AE build mismatch")
    executable_name = info.get("CFBundleExecutable")
    _require(isinstance(executable_name, str) and executable_name, "AE executable is invalid")
    executable_hash = _sha256_file(app / "Contents/MacOS" / executable_name, "AE executable")
    formal_identity = {
        "applicationPath": str(app),
        "bundleId": config.expected_ae_bundle_id,
        "version": config.expected_ae_version,
        "build": config.expected_ae_build,
        "nativeHostBuild": config.expected_ae_host_build,
        "infoPlistSha256": hashlib.sha256(plist_path.read_bytes()).hexdigest(),
        "executableSha256": executable_hash,
    }
    hashes = {
        "nativeReceiptSha256": receipt_hash,
        "nativeManifestSha256": manifest_hash,
        "cepManifestSha256": cep_hash,
        "runtimeInstallRecordSha256": record_hash,
        "runtimeManifestFileSha256": runtime_manifest_hash,
        "runtimeGenerationLauncherSha256": generation_launcher_hash,
        "stableLauncherSha256": stable_launcher_hash,
        "nativeBundleTreeSha256": artifact["bundleTreeSha256"],
        "nativeExecutableSha256": artifact["executableSha256"],
        "nativePiplSha256": artifact["piplSha256"],
        "capabilitiesFixtureSha256": fixture_hash,
        "formalAeInfoPlistSha256": formal_identity["infoPlistSha256"],
        "formalAeExecutableSha256": executable_hash,
    }
    return IdentityProof(hashes, contract_digests, formal_identity)
