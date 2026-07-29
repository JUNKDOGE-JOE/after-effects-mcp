"""Caller guidance for the #190 layer source, Matte, and AV package."""
from __future__ import annotations

from ae_mcp.instructions import SERVER_INSTRUCTIONS


def test_layer_source_matte_av_guidance_requires_fresh_discovery_and_reconciliation():
    text = " ".join(SERVER_INSTRUCTIONS.split())

    assert "use fresh locators for every call" in text
    assert "source replacement invalidates the whole native graph" in text
    assert "rediscover project, composition, layer, and source locators" in text
    assert "arbitrary same-composition Track Matte is allowed" in text
    assert "does not depend on adjacency" in text
    assert "uncertain write" in text
    assert "inspect state and audit before any retry" in text
    assert "never reuse the same operation blindly" in text
    assert "`undo.available` is not `undo.verified`" in text
