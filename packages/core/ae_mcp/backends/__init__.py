"""Backend abstraction layer.

Concrete backend implementations live in separate pip packages and
register themselves via the entry point group `ae_mcp.backends`.
Core never imports any concrete backend module directly."""
from ae_mcp.backends.base import Backend, ALL_VERBS, BackendError

__all__ = ["Backend", "ALL_VERBS", "BackendError"]
