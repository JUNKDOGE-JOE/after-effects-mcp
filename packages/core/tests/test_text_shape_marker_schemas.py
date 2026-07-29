from __future__ import annotations

import pytest
from pydantic import ValidationError

from ae_mcp.schemas_tsm import AeFontSelection


def test_font_fallback_is_ordered_unique_and_exact():
    selection = AeFontSelection(
        preferred_postscript_name="ExactPS",
        fallback_postscript_names=["Fallback-Bold", "Fallback-Regular"],
        on_missing="use-first-installed-fallback",
    )
    assert selection.fallback_postscript_names == [
        "Fallback-Bold",
        "Fallback-Regular",
    ]
    with pytest.raises(ValidationError, match="unique"):
        AeFontSelection(
            preferred_postscript_name="ExactPS",
            fallback_postscript_names=["Fallback", "Fallback"],
            on_missing="use-first-installed-fallback",
        )
