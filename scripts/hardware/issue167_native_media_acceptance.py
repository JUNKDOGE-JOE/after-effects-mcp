#!/usr/bin/env python3
"""Run #167 preflight, native-novelty T4, or exact-build T5/T6."""

from __future__ import annotations

from collections.abc import Sequence

from capability_package_cli import run_cli
from issue167_native_media_spec import Issue167Package, SPEC


def main(argv: Sequence[str] | None = None) -> int:
    return run_cli(
        argv,
        spec=SPEC,
        fixture_default="Issue167 Native Media Fixture",
        client_name="issue167-acceptance",
        package_factory=lambda runtime, name: Issue167Package(
            runtime, fixture_name=name
        ),
    )


if __name__ == "__main__":
    raise SystemExit(main())
