"""Pure shared helpers for native capability metadata generators."""

from __future__ import annotations

import copy
import hashlib
import json
from typing import Any


def canonical_json(value: Any) -> str:
    """Return the stable JSON representation used for native descriptors."""
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def canonical_sha256(value: Any) -> str:
    """Return the SHA-256 digest of canonical native metadata JSON."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def descriptor_summary(value: dict[str, Any]) -> dict[str, Any]:
    """Return a summary descriptor without its full contract payload."""
    summary = copy.deepcopy(value)
    summary["detail"] = "summary"
    for key in (
        "inputContractId",
        "resultContractId",
        "contractDigest",
        "inputSchema",
        "resultSchema",
        "requirements",
        "examples",
    ):
        summary.pop(key, None)
    return summary
