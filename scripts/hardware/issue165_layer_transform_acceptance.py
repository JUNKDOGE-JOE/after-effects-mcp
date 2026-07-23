#!/usr/bin/env python3
"""Run #165 zero-evidence preflight or exact-build T5/T6 acceptance."""

from __future__ import annotations

from collections.abc import Sequence

from capability_package_cli import run_cli
from issue165_layer_transform_spec import Issue165Package, SPEC


def main(argv: Sequence[str] | None = None) -> int:
    return run_cli(
        argv,
        spec=SPEC,
        fixture_default="Issue165 Layer Transform Fixture",
        client_name="issue165-acceptance",
        package_factory=lambda runtime, name: Issue165Package(runtime, fixture_name=name),
    )


if __name__ == "__main__":
    raise SystemExit(main())
