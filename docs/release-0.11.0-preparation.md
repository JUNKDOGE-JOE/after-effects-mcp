# 0.11.0 release preparation

Status: local preparation only, not release-accepted. This branch includes
merged multi-instance work (#393) and depends on draft native connection fix
#395, currently `27fbb43debdd0f79d89136813756518362306425`. Version preparation
is stacked draft #396. No merge, tag, Release, package publication, or asset
upload has been performed.

## Prepared source and changes

Host, panel, CEP bundle/extension, connector, Registry metadata, native client
fallback, packaging default and version contract all declare 0.11.0. The panel
bundle was rebuilt and verified. Native build scripts derive the product version
from the committed host manifest. The SDK migration changes the compiled SDK
identity only; the 23 native primitives and existing suite pins are retained.
The native plug-in remains a separate artifact and is never nested in the ZXP.

The original version preparation covers 11 mechanical version files, one changelog
file, one generated bundle and this document. The subsequently authorized SDK
migration adds the input lock/validator, build and receipt metadata, native SDK
identity, SDK contracts and input documentation. Keep both preparation changes
separate from the connection fix in stacked draft #396.
After the fix is approved and merged, rebase the version branch onto main and
review it before freezing the final clean candidate SHA.

## Evidence and limits

- Windows development smoke on shared fix `bd05e446` passed: cold passive
  status=false, first diagnose available=true/state=connected/probeAttempted=true,
  and a public native project-items read returned total=0/effect=none with a
  verified postcondition. AE 26.5x89, CEP 12.0.1, native 0.10.8 and wire 1;
  empty project stayed dirty=false. The subsequent `27fbb43` expiry cleanup is
  covered by deterministic clock/socket regression and host tests; it has not
  been installed or tested on AE because the user resumed using AE.
- Mac `bf20064` development smoke was separately reported passing on AE 26.3x87
  and native 0.10.8. That patch was not obtained. Mac hardware validation of the
  unified PR head remains pending. The existing macOS CI job runs Unix socket
  fixtures, not real AE. PR CI runs against GitHub's synthetic merge candidate.
- Development-machine dual-worker admission is not established; true unknown
  write recovery on Mac is unverified. evalScript has a soft deadline and cannot
  interrupt AE execution. Guide layers may be absent from PNG output.
- Packaged artifact identity, signatures, public-MCP packaged T5 and clean
  install/upgrade/rollback T6 have not been accepted. #392 stays open for the
  original reporter; the fix references it without closing it.
- Production npm audit reports three moderate dependency entries: qs and its
  body-parser/Express ancestors. The existing Express 4.22.2 pin is retained.
  Advisory links: [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx)
  and [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g).
  Before publication, review applicability and decide whether to approve a
  bounded dependency/contract update or document acceptance of this finding.

## Candidate build commands

Run from a clean, approved final candidate checkout. These commands do not
install components or access an AE process. Supply existing local SDK paths;
do not download, vendor, or redistribute raw Adobe SDK inputs.

```powershell
git status --porcelain
git rev-parse HEAD
node scripts/package/ae-sdk-input.mjs verify-repository --repo-root .
$env:AE_SDK_ARCHIVE = '<existing locked Windows SDK zip>'
$env:AE_SDK_ROOT = '<existing extracted ae26.5.64bit.AfterEffectsSDK>'
node scripts/package/ae-sdk-input.mjs verify-input --platform windows-x64 --repo-root .
node native/ae-plugin/build-windows.mjs --output '<new absolute directory outside Git and Adobe scan roots>' --evidence
```

The Windows SDK archive must match the active repository lock (26.5 publication
v1, 2,025,899 bytes, SHA-256
`ad86bd6d66a1e1ffe8471e4618e3de4dbc9679f2ca47ae9bbe69f78805c82960`).
Archive and extracted-root content verification must both pass before building.
Both existing 26.5 archives/root identities were verified in a private Windows
intake. All 70 shared Win/Mac headers match after line-ending normalization.
Mac input verification on Windows is not a Mac build or AE compatibility result.
The previous 25.6.61 aggregate locks remain active anti-vendoring records.
The isolated native transport compiler/lifecycle contract is a separate test
and does not establish a full AEX build or hardware acceptance.

SDK archive top folders must be normalized to `ae26.5.64bit.AfterEffectsSDK`
outside Git without changing file content or platform line endings. See
`docs/native-sdk/SDK_INPUTS.md` for the verified counts and provenance boundaries.

```powershell
Push-Location plugin/panel
npm ci
npm run build
npm run verify-bundle
npm test
Pop-Location
git diff --exit-code -- plugin/client/dist
Push-Location plugin/host
npm ci
npm test
Pop-Location
node --test scripts/package/test scripts/release/test scripts/dev/test
node --test native/ae-plugin/protocol/protocol.test.mjs
node --test clients/ae-mcp-jkdg/test/bin.test.mjs clients/ae-mcp-jkdg/test/package.test.mjs clients/ae-mcp-jkdg/test/sync.test.mjs
node scripts/package/fetch-opencode-runtime.mjs
.\scripts\package-zxp.ps1 -SkipSigning -Version 0.11.0
node scripts/package/verify-windows-zxp-stage.mjs --stage release/ae-mcp-panel --version 0.11.0
Push-Location clients/ae-mcp-jkdg
npm pack --ignore-scripts --pack-destination '<local artifact directory>'
Pop-Location
```

Before staging, verify resolved cleanup targets stay inside this disposable
checkout and reject symlinks/reparse points. The pinned OpenCode v1.18.23
executable may be reused from an existing build cache only after its exact
179,550,760 bytes and SHA-256
`f831518278ded5090c41cc532b16ab80629e980f710a0b46d1e5b605808bb1d9`
match the manifest. Preparation reused that cache without executing it.

For macOS source build and artifact verification, follow the existing
`native/ae-plugin/build-macos.mjs` / `verify-macos.mjs` workflow on an authorized
Mac with the locked Mac SDK input. This preparation does not access that machine.

## Signing and publication gates

1. Review/approve and merge the connection fix and version preparation; freeze
   one clean candidate SHA. Require Windows, CEP Node 15 and macOS CI success.
2. Verify the locked SDK input and resolve the dependency-audit findings. Build the separate
   Windows AEX and Mac native artifact from that final SHA; retain build receipts,
   toolchain/SDK identity and version verification.
3. Verify the unsigned payload and complete per-file inventory. Sign exactly
   once using the owner's existing signer, certificate and password; verify it.
   Do not create or store new credentials. The existing command is:

   ```powershell
   .\scripts\package-zxp.ps1 -Version 0.11.0 -ZxpSignCmd '<existing ZXPSignCmd.exe>' -CertPath '<existing certificate>' -CertPassword '<owner-supplied password>'
   ```

   Supply the password through the owner's established secure invocation;
   never commit it, put it in a receipt, or paste it into shared logs. Record
   native artifact and signed ZXP SHA-256 and size; ZXP must stay below 80 MB.
4. Obtain a new hardware window before installing or using AE. Validate the
   final unified fix on Mac; perform packaged public-MCP T5 with native diagnosis
   and a read, then the release milestone's clean install/upgrade/rollback T6.
   Keep prior development evidence separate from these release gates.
5. Have the owner approve the final limitations, artifact list and release
   notes. Only after separate publication authorization, tag/create the Release
   and upload approved assets; publish `ae-mcp-jkdg@0.11.0` first, then the
   matching MCP Registry entry, following `docs/RELEASE.md`. Nothing is published
   by this preparation, and no persistent credentials are provisioned.

Unsigned staging and the connector tarball are review artifacts, not assets
approved for end-user release. Rebuild them after the final source freeze.
