# ae-mcp-backend-atom

Atom MCP HTTP backend for [ae-mcp](https://github.com/...).
Talks directly to the Atom plugin's local HTTP server (no pwsh).

## Install
    pip install ae-mcp-backend-atom

## Configure
Open the Atom panel in After Effects, enable MCP Mode. Then:

    AE_MCP_BACKEND=atom
    ATOM_MCP_URL=http://127.0.0.1:11487/mcp   # default
