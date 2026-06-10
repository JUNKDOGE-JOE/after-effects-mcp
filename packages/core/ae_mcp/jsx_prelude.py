"""Helpers for prefixing rendered JSX with the AEMCP runtime prelude."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path


_TEMPLATES_DIR = Path(__file__).resolve().parent / "jsx_templates"


@lru_cache(maxsize=1)
def _aemcp_prelude() -> str:
    return (_TEMPLATES_DIR / "_aemcp_prelude.jsx").read_text(encoding="utf-8")


def with_prelude(jsx: str) -> str:
    """Prefix rendered JSX with AEMCP helpers.

    The prelude is appended only after string.Template substitution: it must
    never pass through Template because a future verbatim copy could contain
    dollar signs that Template would treat as placeholders. Bundling the
    helpers into each script also keeps old panels that lack AEMCP compatible
    with newer Python templates, and vice versa.
    """
    return _aemcp_prelude() + "\n" + jsx
