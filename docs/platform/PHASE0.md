# Platform Phase 0

Phase 0 proves platform and signing assumptions with disposable output. It never creates a release
candidate, tag, build lock, final signing report, or published artifact.

## Signing probe boundary

The probe accepts an unsigned platform stage that has already passed
`scripts/package/verify-platform-bundle.mjs`. It hashes the exact canonical
`bundle-manifest.json`, copies the stage into a fresh platform directory below
`build/phase0/signing/`, and mutates only that copy.

The reviewed entry points are:

```text
bash scripts/package/sign-macos-nested.sh --root <absolute-signing-root> --evidence <absolute-nested-evidence.json>
pwsh -NoProfile -File scripts/package/sign-windows-nested.ps1 -Root <absolute-signing-root> -Evidence <absolute-nested-evidence.json>
node scripts/package/build-zxp.mjs --root <absolute-signing-root> --platform <macos-arm64|windows-x64> --out <absolute-zxp> --evidence <absolute-zxp-evidence.json>
bash scripts/package/package-macos-dmg.sh --zxp <absolute-zxp> --out <absolute-dmg> --evidence <absolute-dmg-evidence.json>
```

All source and output paths are absolute and non-overlapping. Reusable scripts do not stage a
runtime, contact GitHub, tag a repository, or publish anything. They read signing values only from
the protected process environment and never print those values:

```text
AE_MCP_APPLE_SIGNING_IDENTITY
AE_MCP_NOTARY_KEYCHAIN_PROFILE
AE_MCP_WINDOWS_SIGNING_CERT_SHA1
AE_MCP_WINDOWS_TIMESTAMP_URL
AE_MCP_ZXP_SIGN_CMD
AE_MCP_ZXP_CERT_PATH
AE_MCP_ZXP_CERT_PASSWORD
```

Run the disposable probes on the appropriate signing hosts:

```bash
bash scripts/phase0/run-signing-probe-macos.sh \
  build/stage/macos-arm64 build/phase0/signing/macos-arm64
node scripts/phase0/verify-signing-evidence.mjs \
  --evidence build/phase0/signing/macos-arm64/phase0-signing-evidence.json \
  --platform macos-arm64 --stage build/stage/macos-arm64
```

```powershell
pwsh -NoProfile -File scripts/phase0/run-signing-probe-windows.ps1 `
  -StageRoot build\stage\windows-x64 `
  -OutRoot build\phase0\signing\windows-x64
node scripts/phase0/verify-signing-evidence.mjs `
  --evidence build\phase0\signing\windows-x64\phase0-signing-evidence.json `
  --platform windows-x64 --stage build\stage\windows-x64
```

## Evidence contract

Each reusable script writes canonical JSON with exactly `schemaVersion`, `platform`,
`sourceStageSha256`, a contiguous `steps` slice, and structured `verifiedIdentity`. Step records
contain only an ID, input/output SHA-256, and exit code zero. The aggregate
`Phase0SigningEvidenceV1` adds the absolute disposable root, UTC verification time, and
`publicationAttempted:false`.

Identity evidence is derived from verification output, not copied blindly from credential
variables. macOS nested evidence records the certificate SHA-256 and ten-character Developer ID
Team ID; DMG evidence additionally records the notary submission UUID and successful staple and
Gatekeeper checks. Windows nested evidence records the Authenticode thumbprint and verified RFC
3161 timestamp. ZXP evidence records successful package verification.

`sign-xpc` and `sign-addon` are reserved ordering slots. In the current CEP architecture they have
empty mutation sets and their input and output digests must be identical. They do not assert that
an XPC service or native addon exists. The final nested verification enumerates every actual native
file and fails if any file is unsigned, wrong-architecture, or uses a forbidden native-addon path.

The two-platform merge stores only SHA-256 references to helper and signing evidence; it does not
embed evidence, credentials, or command output. Each helper document's `signingOutputSha256` must
equal the exact paired signing-evidence file digest, and both platform IDs must appear exactly once:

```bash
node scripts/phase0/collect-phase0-evidence.mjs \
  --merge build/phase0/macos-helper.json build/phase0/windows-helper.json \
  --signing-evidence \
    build/phase0/signing/macos-arm64/phase0-signing-evidence.json \
    build/phase0/signing/windows-x64/phase0-signing-evidence.json \
  --out build/phase0/platform-helper.json
```

## Current external gate

Unit evidence validation is host-independent. A real macOS probe remains blocked until a usable
Developer ID Application identity, notarization keychain profile, and ZXPSignCmd certificate are
installed on the signing host. Windows Authenticode and ZXP proof must run on the Windows x64
signing host. Missing credentials are explicit Phase 0 blockers; they are never replaced by fake
identities or synthetic success evidence.
