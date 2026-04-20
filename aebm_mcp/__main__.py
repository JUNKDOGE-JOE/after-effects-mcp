"""Entry point: `python -m aebm_mcp`.

Starts the stdio MCP server. Delegates to aebm_mcp.server.run().
"""

from __future__ import annotations


def main() -> None:
    from aebm_mcp.server import run
    run()


if __name__ == "__main__":
    main()
