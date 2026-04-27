# ae-mcp-backend-aebm

Bridge between the `ae-mcp` MCP server and the **AEBMethod** AE plugin
(`E:/Code/AEBMethod`). Both halves are part of the same integrated
product — this package is NOT a third-party "backend" of a generic
abstraction; it's the canonical bridge that ships with ae-mcp.

The internal `Backend` ABC in `ae-mcp` core exists for architectural
cleanliness; we do not advertise plugging in arbitrary third-party
backends as a product feature.

## Configure

```
AE_MCP_BACKEND   = aebm
AE_BRIDGE_ROOT   = <path to AEBMethod plugin checkout>
```
