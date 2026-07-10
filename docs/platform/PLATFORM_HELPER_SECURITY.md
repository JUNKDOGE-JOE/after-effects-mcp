# Platform helper security contract

The platform helper is an authenticated local capability boundary for secrets and window capture.
The current cross-platform contract uses a signed long-lived helper and a length-prefixed JSON
protocol. It does not require a CEP native addon, does not expose a TCP/UDP listener, and does not
permit provider-secret enumeration or export.

## Signing boundary

Only native files actually present in the helper payload are signed. The signing plan preserves
`sign-xpc` and `sign-addon` as ordering compatibility slots, but both are strict no-ops in the
current design. Keeping those IDs does not authorize an XPC service or a native addon. Adding either
artifact requires a separately approved architecture change, new packaging identity rules, and new
Phase 0 evidence.

Nested verification is fail-closed:

- macOS scans the helper payload for Mach-O files, requires arm64, and runs strict `codesign`
  verification for every discovered file;
- Windows scans the helper payload for PE files and runs `signtool verify /pa /all` for every
  discovered file;
- an undeclared or unverified native file fails the chain;
- a native-addon path fails even if it carries a valid third-party signature;
- verification steps may not mutate the signed root.

The source stage is immutable. Signing occurs only in a disposable copy, and every reusable slice
binds itself to the SHA-256 of the original canonical `bundle-manifest.json`. Signing output paths
must be absolute and outside that copied root so evidence cannot change the bytes it measures.

## Credential handling

Signing credentials enter only through protected environment variables on the local signing host.
Scripts validate presence without logging values, suppress raw signer output, and persist only
public verification facts such as certificate fingerprints, Team ID, Authenticode thumbprint,
notary submission ID, and boolean verification results. Passwords, certificate bytes, keychain
profile names, command output, and environment values are excluded from evidence.

Runtime provider credentials remain behind the helper's OS credential-store interface. Phase 0
signing evidence proves code identity and packaging order only; it does not grant credential-store
access and never contains provider configuration.
