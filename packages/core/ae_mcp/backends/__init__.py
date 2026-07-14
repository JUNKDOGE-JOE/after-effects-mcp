"""Backend abstraction layer.

Concrete backend implementations live in separate pip packages and
register themselves via the entry point group `ae_mcp.backends`.
Core never imports any concrete backend module directly."""
from ae_mcp.backends.base import (
    ALL_VERBS,
    Backend,
    BackendError,
    EXECUTION_ENGINES,
    ExecutionEngine,
    LegacyExtendScriptBackend,
)

__all__ = [
    "ALL_VERBS",
    "Backend",
    "BackendError",
    "EXECUTION_ENGINES",
    "ExecutionEngine",
    "LegacyExtendScriptBackend",
]
