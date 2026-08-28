# Development workflow

## Product path

The maintained execution path is:

```text
MCP client
  -> plugin/host /mcp handler
  -> host bridge and ExtendScript or native AEGP dispatch
  -> After Effects state
  -> typed result and audit evidence
```

Claude Code uses the panel URL directly. Stdio-only clients use
`npx -y ae-mcp-jkdg`; the installed extension's `host/stdio-shim.js` remains
the dependency-free direct alternative. The panel must remain open during
either connection.

The public registry contains 13 tools. Tool Library work stays inside the
existing `plugin/host/mcp` store and handlers plus the panel's Tools page; it
must not recreate a package server or a second persistence layer. See
[Tool Library](TOOL_LIBRARY.md) for artifact and distribution contracts.

## JavaScript development

```bash
(cd plugin/host && npm ci && npm test)
(cd plugin/panel && npm ci && npm test && npm run build)
```

Tool Library changes should also run the generator contract:

```bash
node --test scripts/package/test/generate-bundled-skill.test.mjs
```

Deploy a development extension after building:

```powershell
.\scripts\install-plugin-dev.ps1
```

```bash
./scripts/install-plugin-dev-macos.sh
```

The scripts validate the direct host package, the CEP payload, and the
development receipt before touching the installed extension.

## Native AEGP development

The AEGP plane is frozen. The Adobe SDK is a local input outside the checkout;
run the SDK validator before a native build:

```bash
node scripts/package/ae-sdk-input.mjs verify-input --platform macos-arm64
```

Native reads must return real After Effects state. Native writes use a
disposable fixture, record before/after state and audit identifiers, then
execute and independently verify Undo. A transport timeout is indeterminate;
inspect state and audit evidence before retrying.

## Package checks

The Windows ZXP contains the direct extension roots: `client`, `CSXS`, `host`,
`icons`, `jsx`, and `shared`. Host dependencies are installed from the locked
`express` `4.22.2` package. The staged payload rejects retired roots, nested
native binaries, and development tests.

```powershell
.\scripts\package-zxp.ps1 -SkipSigning
```

The signed ZXP is signed once, verified once, and must be smaller than 20 MB.
