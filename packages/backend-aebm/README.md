# ae-mcp-backend-aebm (DEV-ONLY)

> **Not part of the published `ae-mcp` package.** This sub-package lives
> in the workspace solely so ae-mcp's own contributors can run live tests
> against a real AE instance. It will NOT be uploaded to PyPI when the
> `ae-mcp` core releases. The core's stance is "ships zero concrete
> backends"; this lives here as a development convenience only.
>
> If a third party wants AEBM support in production, they should fork
> this package and publish under their own name + ownership.

AEBMethod file-bridge backend for [ae-mcp](https://github.com/...).

## Configure (for ae-mcp contributors running live tests)
Set env var `AE_BRIDGE_ROOT` to your AEBMethod plugin checkout, then
`AE_MCP_BACKEND=aebm`.
