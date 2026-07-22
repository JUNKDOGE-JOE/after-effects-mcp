#!/usr/bin/env python3
"""Run #162 preflight or exact-build T5/T6 acceptance."""

from __future__ import annotations

from collections.abc import Sequence

from capability_package_cli import run_cli
from issue162_layer_compositing_spec import Issue162Package, SPEC


def main(argv: Sequence[str] | None = None) -> int:
    return run_cli(
        argv,
        spec=SPEC,
        fixture_default="Issue162 Layer Compositing Fixture",
        client_name="issue162-acceptance",
        package_factory=lambda runtime, name: Issue162Package(runtime, fixture_name=name),
    )


if __name__ == "__main__":
    raise SystemExit(main())
