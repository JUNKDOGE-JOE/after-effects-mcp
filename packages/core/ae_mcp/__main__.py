"""Entry point: `python -m ae_mcp`.

Starts the stdio MCP server. Delegates to ae_mcp.server.run().
"""

from __future__ import annotations


def main() -> None:
    from ae_mcp.server import run
    run()


if __name__ == "__main__":
    main()
