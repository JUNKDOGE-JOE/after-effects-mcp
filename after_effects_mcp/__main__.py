"""Entry point: `python -m after_effects_mcp`.

Starts the stdio MCP server. Delegates to after_effects_mcp.server.run().
"""

from __future__ import annotations


def main() -> None:
    from after_effects_mcp.server import run
    run()


if __name__ == "__main__":
    main()
