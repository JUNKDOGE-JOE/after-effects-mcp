#!/usr/bin/env python3
"""Run package #157 preflight or exact-build T5/T6 acceptance."""

from __future__ import annotations

import argparse
import asyncio
import json
from collections.abc import Sequence
from pathlib import Path

from capability_package_identity import FULL_SHA, IdentityConfig
from capability_package_runtime import (
    AcceptanceFailure,
    EvidenceLog,
    FixturePolicy,
    LiveSessionFactory,
    PossiblySideEffectingStop,
    stdin_checkpoint,
)
from issue157_keyframe_authoring_spec import SPEC, Issue157Package


def _group_leaf(error: BaseException, leaf_type: type) -> BaseException | None:
    """Return the first ``leaf_type`` leaf inside an exception group, if any."""
    if isinstance(error, leaf_type):
        return error
    exceptions = getattr(error, "exceptions", None)
    if isinstance(exceptions, (list, tuple)):
        for child in exceptions:
            found = _group_leaf(child, leaf_type)
            if found is not None:
                return found
    return None


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", required=True, choices=("preflight", "t5", "t6"))
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--fixture-name", default="Issue157 Keyframe Authoring Fixture")
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


async def _run(arguments: argparse.Namespace) -> int:
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
        spec=SPEC,
        mode=arguments.mode,
        expected_sha=arguments.expected_sha,
    )
    from capability_package_runtime import AcceptanceRuntime

    runtime = AcceptanceRuntime(
        spec=SPEC,
        mode=arguments.mode,
        identity=identity,
        fixture=fixture,
        session_factory=LiveSessionFactory(
            arguments.launcher,
            client_name="issue157-acceptance",
            home=arguments.identity_home,
        ),
        checkpoint=stdin_checkpoint,
        evidence=evidence,
    )
    package = Issue157Package(runtime, fixture_name=arguments.fixture_name)
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
    except BaseException as error:  # noqa: BLE001 - unwrap anyio TaskGroup wrapping
        leaf = _group_leaf(error, PossiblySideEffectingStop)
        if leaf is None:
            raise
        details = {"stopReason": "possibly-side-effecting", "message": str(leaf)}
        return 3
    finally:
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
        print(
            json.dumps(
                {
                    "event": "PASS" if passed else "FAIL",
                    "mode": arguments.mode,
                    "candidateRun": arguments.mode in {"t5", "t6"},
                    "candidateEvidence": evidence.candidate_evidence,
                    "publicCalls": runtime.ledger.total,
                    "summarySha256": __import__("hashlib").sha256(
                        evidence.summary_path.read_bytes()
                    ).hexdigest(),
                },
                separators=(",", ":"),
            ),
            flush=True,
        )


def main(argv: Sequence[str] | None = None) -> int:
    return asyncio.run(_run(parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
