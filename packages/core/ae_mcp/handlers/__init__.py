"""Handler registry.

HANDLERS maps verb name -> (pydantic schema, async run function).
Populated by handlers.core and handlers.typed at import time.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict, Tuple, Type

from pydantic import BaseModel

RunFn = Callable[[BaseModel, Any], Awaitable[Any]]
HANDLERS: Dict[str, Tuple[Type[BaseModel], RunFn]] = {}


def register(name: str, schema: Type[BaseModel], run_fn: RunFn) -> None:
    """Register a verb handler. Last writer wins (typed overrides core if collision)."""
    HANDLERS[name] = (schema, run_fn)


def load_all() -> None:
    """Import core + typed modules so they register their handlers."""
    # Imported for side effects (registration via @register or explicit register() calls).
    from ae_mcp.handlers import core  # noqa: F401
    from ae_mcp.handlers import status  # noqa: F401
    from ae_mcp.handlers import typed  # noqa: F401
    from ae_mcp.handlers import skills  # noqa: F401
    from ae_mcp.handlers import rig  # noqa: F401
    from ae_mcp.handlers import tools  # noqa: F401
