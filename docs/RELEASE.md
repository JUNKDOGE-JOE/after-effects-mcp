# Release checklist

## Source and assets

1. Start from the final clean candidate commit and record its full SHA.
2. Verify the developer-supplied Adobe SDK input before a native build.
3. Build the frozen AEGP `.aex` separately from the CEP extension.
4. Stage the direct ZXP payload and record its file inventory.
5. Verify the host package and exact Express `4.22.2` lock entry.

The ZXP payload consists of the panel, CEP manifest, Node host, JSX, shared
modules, icons, generated host protocol files, and bundled skills. It contains
no retired package tree, private executable payload, or nested native binary.

## npm connector & MCP Registry

Keep the connector and product versions paired by major.minor. Both version
fields in the root `server.json` must always equal
`clients/ae-mcp-jkdg/package.json`. When a connector-only fix is needed, bump
only the connector patch version and both `server.json` version fields; the
product host and panel patch versions remain unchanged. The release version
consistency test guards this contract.

After the product release is ready, the owner publishes the connector and then
the Registry entry in this order:

```bash
cd clients/ae-mcp-jkdg && npm publish --access public
cd ../..
mcp-publisher login github
mcp-publisher publish
```

Run `mcp-publisher publish` from the repository root, where `server.json`
resides. npm publication must happen first because the Registry verifies that
the package exists and that its `mcpName` matches the Registry server name.

## Signing

Run the ZXP signer once against the verified stage and then run its verification
command. Do not sign a nested subdirectory or run a second signing pass. Keep
the `.aex` as its separate native artifact; the ZXP is not a native plug-in
installer.

```powershell
.\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw>
```

Record the ZXP and AEX SHA-256 values. The ZXP must be below 20 MB.

## Acceptance

- Run the host, panel, package, and governance Node tests.
- Run the CEP Node 15 contract and the macOS packaging contract in CI.
- On the prepared After Effects machine, install the disposable candidate,
  open the panel, call the public MCP surface, and collect typed responses,
  host/native provenance, audit records, and postconditions.
- For a write, execute Undo and verify the restored state independently.

The development hardware result is `development-verified`; it is not packaged
release acceptance. A release candidate must additionally pass the strict
artifact identity, signature, and clean install/upgrade checks owned by the
release milestone.
