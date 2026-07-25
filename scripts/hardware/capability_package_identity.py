"""Lightweight local component and formal-After-Effects identity verification."""

from __future__ import annotations

import dataclasses
import json
import os
import plistlib
import re
import stat
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from typing import Any


FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
GENERATION_ID = re.compile(r"^g-[0-9a-f]{16}$")
LAYER_INSTANCE_ID = re.compile(r"^i-[0-9a-f]{16}$")
RUNTIME_OWNER = "ae-mcp-runtime-manager"


class IdentityFailure(RuntimeError):
    pass


def _require(condition: Any, message: str) -> None:
    if not condition:
        raise IdentityFailure(message)


def _mapping(value: Any, message: str) -> dict[str, Any]:
    _require(isinstance(value, Mapping), message)
    return dict(value)


def _file_signal(
    path: Path,
    label: str,
    *,
    executable: bool = False,
    expected_mode: int | None = None,
) -> dict[str, Any]:
    try:
        info = path.lstat()
    except FileNotFoundError as error:
        raise IdentityFailure(f"{label} is missing") from error
    _require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), f"{label} is not canonical")
    mode = stat.S_IMODE(info.st_mode)
    if expected_mode is not None and os.name == "posix":
        _require(mode == expected_mode, f"{label} must use mode {expected_mode:04o}")
    if executable and os.name == "posix":
        _require(mode & 0o111, f"{label} must be executable")
    _require(info.st_size > 0, f"{label} is empty")
    return {
        "path": str(path),
        "size": info.st_size,
        "mtimeNs": info.st_mtime_ns,
        "mode": f"{mode:04o}",
    }


def _runtime_python_signal(path: Path, runtime_root: Path) -> dict[str, Any]:
    """Return a signal for the runtime Python, allowing its direct local alias."""
    try:
        path.lstat()
    except FileNotFoundError as error:
        raise IdentityFailure("runtime Python is missing") from error
    if not path.is_symlink():
        return _file_signal(path, "runtime Python", executable=True)

    try:
        target_text = os.readlink(path)
    except OSError as error:
        raise IdentityFailure("runtime Python symlink is unreadable") from error
    target_is_absolute = (
        PurePosixPath(target_text).is_absolute() or Path(target_text).is_absolute()
    )
    _require(not target_is_absolute, "runtime Python symlink target must be relative")
    target_path = path.parent / target_text
    try:
        target_info = target_path.lstat()
    except FileNotFoundError as error:
        raise IdentityFailure("runtime Python symlink target is dangling") from error
    _require(
        stat.S_ISREG(target_info.st_mode) and not target_path.is_symlink(),
        "runtime Python symlink target must be a direct regular file",
    )
    try:
        resolved_root = runtime_root.resolve(strict=True)
        resolved_target = target_path.resolve(strict=True)
        resolved_target.relative_to(resolved_root)
    except (FileNotFoundError, OSError, ValueError) as error:
        raise IdentityFailure("runtime Python symlink target escapes the runtime") from error

    signal = _file_signal(target_path, "runtime Python symlink target", executable=True)
    signal.update(
        {
            "path": str(path),
            "symlinkTarget": target_text,
            "targetPath": str(resolved_target),
        }
    )
    return signal


def _identity_json(path: Path, label: str) -> tuple[dict[str, Any], dict[str, Any]]:
    signal = _file_signal(path, label)
    payload = path.read_bytes()
    _require(0 < len(payload) <= 4 * 1024 * 1024, f"{label} is empty or unbounded")
    try:
        decoded = json.loads(payload)
    except (UnicodeDecodeError, ValueError) as error:
        raise IdentityFailure(f"{label} is not valid JSON") from error
    return _mapping(decoded, f"{label} must be an object"), signal


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


def _require_receipt_signal(
    actual: Mapping[str, Any], expected: Any, label: str
) -> None:
    receipt = _mapping(expected, f"{label} receipt signal is invalid")
    _require(
        receipt.get("size") == actual.get("size")
        and receipt.get("mode") == actual.get("mode")
        and receipt.get("mtimeMs") == actual.get("mtimeNs", 0) // 1_000_000,
        f"{label} bounded signal changed",
    )


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
    component_signals: dict[str, dict[str, Any]]
    source_revisions: dict[str, str]
    contract_digests: dict[str, str]
    formal_ae_identity: dict[str, Any]


def verify_exact_identity(
    config: IdentityConfig, *, required_capability_ids: Sequence[str]
) -> IdentityProof:
    receipt, receipt_signal = _identity_json(config.native_receipt, "native receipt")
    manifest, manifest_signal = _identity_json(config.native_manifest, "native manifest")
    _validate_declared_hashes(receipt, "nativeReceipt")
    _validate_declared_hashes(manifest, "nativeManifest")
    receipt_source = receipt.get("sourceCommit")
    receipt_nested_source = _mapping(
        receipt.get("source"), "native receipt source is invalid"
    ).get("commit")
    _require(
        isinstance(receipt_source, str)
        and FULL_SHA.fullmatch(receipt_source) is not None
        and receipt_nested_source == receipt_source,
        "native receipt source revision is invalid",
    )
    artifact = _mapping(manifest.get("artifact"), "native manifest artifact is invalid")
    manifest_source = manifest.get("sourceCommitSha")
    _require(
        isinstance(manifest_source, str)
        and FULL_SHA.fullmatch(manifest_source) is not None
        and manifest_source == receipt_source,
        "native manifest source revision is invalid",
    )
    for field in ("bundleTreeSha256", "executableSha256", "piplSha256"):
        _require(
            isinstance(artifact.get(field), str) and SHA256.fullmatch(artifact[field]),
            f"native manifest {field} is invalid",
        )

    cep_path = (
        config.identity_home
        / "Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel/bundle-manifest.json"
    )
    cep, cep_signal = _identity_json(cep_path, "CEP bundle manifest")
    _validate_declared_hashes(cep, "cepManifest")
    cep_source = cep.get("sourceCommitSha")
    _require(
        isinstance(cep_source, str) and FULL_SHA.fullmatch(cep_source) is not None,
        "CEP manifest source revision is invalid",
    )
    current_path = config.identity_home / ".ae-mcp/runtime/current"
    current_signal = _file_signal(current_path, "runtime current pointer")
    relative = current_path.read_text(encoding="utf-8").strip()
    parts = relative.split("/")
    schema_v2 = (
        len(parts) == 2
        and parts[0] == "generations"
        and GENERATION_ID.fullmatch(parts[1]) is not None
    )
    schema_v1 = (
        len(parts) == 2
        and parts[1] == "macos-arm64"
        and parts[0].startswith(f"{config.runtime_version}-")
        and ".." not in parts[0]
        and not parts[0].startswith(".")
    )
    _require(schema_v1 or schema_v2, "runtime current pointer is invalid")
    runtime_base = config.identity_home / ".ae-mcp/runtime"
    record_path = (
        runtime_base / relative / "install-record.json"
        if schema_v2
        else runtime_base / parts[0] / "install-record.json"
    )
    record, record_signal = _identity_json(record_path, "runtime install record")
    _validate_declared_hashes(record, "runtimeInstallRecord")
    launcher_hash = record.get("launcherSha256")
    common_record_valid = (
        record.get("relative") == relative
        and record.get("platform") == "macos-arm64"
        and record.get("version") == config.runtime_version
        and isinstance(record.get("sourceCommitSha"), str)
        and FULL_SHA.fullmatch(record["sourceCommitSha"]) is not None
        and isinstance(launcher_hash, str)
        and SHA256.fullmatch(launcher_hash) is not None
    )
    layer_record_signal: dict[str, Any] | None = None
    stable_receipt_signal: dict[str, Any] | None = None
    layer_alias_signal: dict[str, Any] | None = None
    if schema_v2:
        layer = _mapping(record.get("layer"), "runtime generation layer is invalid")
        layer_id = layer.get("id")
        instance_id = layer.get("instanceId")
        layer_relative = layer.get("relative")
        _require(
            common_record_valid
            and record.get("schemaVersion") == 2
            and record.get("owner") == RUNTIME_OWNER
            and record.get("generationId") == parts[1]
            and isinstance(layer_id, str)
            and SHA256.fullmatch(layer_id) is not None
            and layer.get("manifestSha256") == layer_id
            and isinstance(instance_id, str)
            and LAYER_INSTANCE_ID.fullmatch(instance_id) is not None
            and layer_relative
            == f"layers/{layer_id}/{instance_id}/macos-arm64",
            "runtime schema-v2 generation receipt is incompatible",
        )
        runtime_root = runtime_base / str(layer_relative)
        layer_alias = runtime_base / relative / "runtime"
        try:
            alias_info = layer_alias.lstat()
            alias_target = os.readlink(layer_alias)
            alias_resolved = (layer_alias.parent / alias_target).resolve(strict=True)
        except (FileNotFoundError, OSError) as error:
            raise IdentityFailure("runtime generation layer alias is invalid") from error
        _require(
            stat.S_ISLNK(alias_info.st_mode)
            and not Path(alias_target).is_absolute()
            and alias_resolved == runtime_root.resolve(strict=True),
            "runtime generation layer alias is invalid",
        )
        layer_alias_signal = {
            "path": str(layer_alias),
            "size": alias_info.st_size,
            "mtimeNs": alias_info.st_mtime_ns,
            "mode": f"{stat.S_IMODE(alias_info.st_mode):04o}",
            "symlinkTarget": alias_target,
        }
        layer_record_path = runtime_root.parent / "layer-record.json"
        layer_record, layer_record_signal = _identity_json(
            layer_record_path, "runtime layer receipt"
        )
        _require(
            layer_record.get("schemaVersion") == 1
            and layer_record.get("owner") == RUNTIME_OWNER
            and layer_record.get("platform") == "macos-arm64"
            and layer_record.get("id") == layer_id
            and layer_record.get("instanceId") == instance_id
            and layer_record.get("relative") == layer_relative,
            "runtime layer receipt is incompatible",
        )
    else:
        _require(
            common_record_valid and record.get("schemaVersion") == 1,
            "runtime schema-v1 install record is incompatible",
        )
        runtime_root = runtime_base / relative
    runtime_manifest_signal = _file_signal(
        runtime_root / "runtime-manifest.json", "runtime manifest"
    )
    node_signal = _file_signal(
        runtime_root / "node/bin/node", "runtime Node", executable=True
    )
    python_signal = _runtime_python_signal(
        runtime_root / "python/bin/python3", runtime_root
    )
    generation_launcher = (
        runtime_base / relative / "ae-mcp-launcher"
        if schema_v2
        else runtime_base / parts[0] / "ae-mcp-launcher"
    )
    stable_launcher = config.identity_home / ".ae-mcp/bin/ae-mcp"
    generation_launcher_signal = _file_signal(
        generation_launcher,
        "runtime generation launcher",
        executable=True,
        expected_mode=0o755,
    )
    stable_launcher_signal = _file_signal(
        stable_launcher, "stable launcher", executable=True, expected_mode=0o755
    )
    _require(
        generation_launcher_signal["size"] == stable_launcher_signal["size"],
        "runtime launcher size signals are incompatible",
    )
    if schema_v2:
        _require_receipt_signal(
            generation_launcher_signal,
            record.get("launcherSignal"),
            "runtime generation launcher",
        )
        layer_signals = _mapping(
            layer_record.get("signals"), "runtime layer signals are invalid"
        )
        _require_receipt_signal(
            runtime_manifest_signal,
            layer_signals.get("runtimeManifest"),
            "runtime manifest",
        )
        _require_receipt_signal(node_signal, layer_signals.get("node"), "runtime Node")
        _require_receipt_signal(python_signal, layer_signals.get("python"), "runtime Python")
        stable_record_path = runtime_base / "stable-launcher-record.json"
        stable_record, stable_receipt_signal = _identity_json(
            stable_record_path, "stable launcher receipt"
        )
        _require(
            stable_record.get("schemaVersion") == 1
            and stable_record.get("owner") == RUNTIME_OWNER
            and stable_record.get("platform") == "macos-arm64"
            and stable_record.get("canonicalPath") == str(stable_launcher)
            and stable_record.get("launcherSha256") == launcher_hash,
            "stable launcher receipt is incompatible",
        )
        _require_receipt_signal(
            stable_launcher_signal,
            stable_record.get("signal"),
            "stable launcher",
        )

    capabilities, fixture_signal = _identity_json(
        config.capabilities_fixture, "capabilities fixture"
    )
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
    executable_signal = _file_signal(
        app / "Contents/MacOS" / executable_name, "AE executable", executable=True
    )
    plist_signal = _file_signal(plist_path, "formal AE plist")
    formal_identity = {
        "applicationPath": str(app),
        "bundleId": config.expected_ae_bundle_id,
        "version": config.expected_ae_version,
        "build": config.expected_ae_build,
        "nativeHostBuild": config.expected_ae_host_build,
        "infoPlistSignal": plist_signal,
        "executableSignal": executable_signal,
    }
    signals = {
        "nativeReceipt": receipt_signal,
        "nativeManifest": manifest_signal,
        "cepManifest": cep_signal,
        "runtimeCurrent": current_signal,
        "runtimeInstallRecord": record_signal,
        "runtimeManifest": runtime_manifest_signal,
        "runtimeGenerationLauncher": generation_launcher_signal,
        "stableLauncher": stable_launcher_signal,
        "runtimeNode": node_signal,
        "runtimePython": python_signal,
        "capabilitiesFixture": fixture_signal,
        "formalAeInfoPlist": plist_signal,
        "formalAeExecutable": executable_signal,
    }
    if layer_record_signal is not None:
        signals["runtimeLayerRecord"] = layer_record_signal
    if stable_receipt_signal is not None:
        signals["stableLauncherReceipt"] = stable_receipt_signal
    if layer_alias_signal is not None:
        signals["runtimeLayerAlias"] = layer_alias_signal
    source_revisions = {
        "requested": config.expected_sha,
        "nativeReceipt": receipt_source,
        "nativeManifest": manifest_source,
        "cep": cep_source,
        "runtime": record["sourceCommitSha"],
    }
    return IdentityProof(signals, source_revisions, contract_digests, formal_identity)
