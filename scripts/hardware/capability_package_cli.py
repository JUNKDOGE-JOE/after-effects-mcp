#!/usr/bin/env python3
"""Shared CLI shell for declarative capability-package hardware workflows."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from capability_package_identity import FULL_SHA, IdentityConfig
from capability_package_runtime import (
    AcceptanceFailure,
    AcceptanceRuntime,
    EvidenceLog,
    FixturePolicy,
    LiveSessionFactory,
    PackageSpec,
    PossiblySideEffectingStop,
    stdin_checkpoint,
)


def _leaf(error: BaseException, leaf_type: type) -> BaseException | None:
    if isinstance(error, leaf_type):
        return error
    for child in getattr(error, "exceptions", ()):
        found = _leaf(child, leaf_type)
        if found is not None:
            return found
    return None


def parse_args(
    argv: Sequence[str] | None,
    *,
    fixture_default: str,
) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a capability-package hardware workflow")
    parser.add_argument("--mode", required=True, choices=("preflight", "t4", "t5", "t6"))
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--fixture-name", default=fixture_default)
    parser.add_argument("--fixture-path", required=True, type=Path)
    parser.add_argument("--recovery-archive-root", required=True, type=Path)
    parser.add_argument("--native-receipt", required=True, type=Path)
    parser.add_argument("--native-manifest", required=True, type=Path)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    parser.add_argument("--identity-home", type=Path, default=Path.home())
    parser.add_argument("--launcher", type=Path)
    parser.add_argument(
        "--contract-fixture",
        type=Path,
        default=Path(__file__).resolve().parents[2]
        / "native/ae-plugin/protocol/fixtures/capabilities.json",
    )
    parser.add_argument(
        "--formal-ae-app",
        type=Path,
        default=Path("/Applications/Adobe After Effects 2026/Adobe After Effects 2026.app"),
    )
    parsed = parser.parse_args(argv)
    if FULL_SHA.fullmatch(parsed.expected_sha) is None:
        parser.error("--expected-sha must be one full lowercase Git SHA")
    if not parsed.fixture_name or "\x00" in parsed.fixture_name:
        parser.error("--fixture-name must be a nonempty safe string")
    if not parsed.identity_home.is_absolute():
        parser.error("--identity-home must be absolute")
    canonical_launcher = parsed.identity_home / ".ae-mcp/bin/ae-mcp"
    if parsed.launcher is None:
        parsed.launcher = canonical_launcher
    elif not parsed.launcher.is_absolute() or parsed.launcher != canonical_launcher:
        parser.error("--launcher must be the canonical launcher under --identity-home")
    return parsed


async def _run(
    arguments: argparse.Namespace,
    *,
    spec: PackageSpec,
    client_name: str,
    package_factory: Callable[[AcceptanceRuntime, str], Any],
) -> int:
    identity = IdentityConfig(
        expected_sha=arguments.expected_sha,
        native_receipt=arguments.native_receipt,
        native_manifest=arguments.native_manifest,
        capabilities_fixture=arguments.contract_fixture,
        formal_ae_app=arguments.formal_ae_app,
        identity_home=arguments.identity_home,
    )
    fixture = FixturePolicy(
        path=arguments.fixture_path,
        recovery_root=arguments.recovery_archive_root,
        fixture_id=arguments.fixture_name,
    )
    evidence = EvidenceLog(
        arguments.evidence_dir,
        spec=spec,
        mode=arguments.mode,
        expected_sha=arguments.expected_sha,
    )
    runtime = AcceptanceRuntime(
        spec=spec,
        mode=arguments.mode,
        identity=identity,
        fixture=fixture,
        session_factory=LiveSessionFactory(
            arguments.launcher, client_name=client_name, home=arguments.identity_home,
        ),
        checkpoint=stdin_checkpoint,
        evidence=evidence,
    )
    package = package_factory(runtime, arguments.fixture_name)
    passed = False
    details: dict[str, object] = {}
    try:
        details = await package.run()
        passed = True
        return 0
    except PossiblySideEffectingStop as error:
        details = {"stopReason": "possibly-side-effecting", "message": str(error)}
        return 3
    except AcceptanceFailure as error:
        details = {"failure": str(error)}
        return 2
    except BaseException as error:  # noqa: BLE001 - unwrap TaskGroup failures
        uncertain = _leaf(error, PossiblySideEffectingStop)
        if uncertain is None:
            raise
        details = {"stopReason": "possibly-side-effecting", "message": str(uncertain)}
        return 3
    finally:
        if not passed:
            recovered = runtime.recover_zero_call_fixture()
            if recovered is not None:
                details = {**details, "zeroCallFixtureRecovery": recovered}
        evidence.finish(
            passed=passed,
            details={
                **details,
                "componentHashes": runtime.component_hashes,
                "contractDigests": runtime.contract_digests,
                "formalAeIdentity": runtime.formal_ae_identity,
            },
            ledger=runtime.ledger,
            matrix=runtime.matrix,
            aep_lifecycle=runtime.aep_lifecycle,
        )
        print(json.dumps({
            "event": "PASS" if passed else "FAIL",
            "mode": arguments.mode,
            "candidateRun": arguments.mode in {"t5", "t6"},
            "candidateEvidence": evidence.candidate_evidence,
            "publicCalls": runtime.ledger.total,
            "summarySha256": hashlib.sha256(evidence.summary_path.read_bytes()).hexdigest(),
        }, separators=(",", ":")), flush=True)


def run_cli(
    argv: Sequence[str] | None,
    *,
    spec: PackageSpec,
    fixture_default: str,
    client_name: str,
    package_factory: Callable[[AcceptanceRuntime, str], Any],
) -> int:
    arguments = parse_args(argv, fixture_default=fixture_default)
    return asyncio.run(_run(
        arguments,
        spec=spec,
        client_name=client_name,
        package_factory=package_factory,
    ))
