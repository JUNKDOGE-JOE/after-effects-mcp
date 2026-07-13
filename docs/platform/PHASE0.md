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
node scripts/package/build-zxp.mjs --root <absolute-signing-root> --platform <macos-arm64|windows-x64> --out <absolute-zxp> --evidence <absolute-zxp-evidence.json> --source-stage-sha256 <lowercase-bundle-manifest-sha256>
bash scripts/package/package-macos-dmg.sh --zxp <absolute-zxp> --out <absolute-dmg> --evidence <absolute-dmg-evidence.json>
```

All source and output paths are absolute and non-overlapping. Reusable scripts do not stage a
runtime, contact GitHub, tag a repository, or publish anything. They read signing values only from
the protected process environment and never print those values:

```text
AE_MCP_APPLE_SIGNING_IDENTITY
AE_MCP_APPLE_CERT_FINGERPRINT_SHA256
AE_MCP_APPLE_TEAM_ID
AE_MCP_NOTARY_KEYCHAIN_PROFILE
AE_MCP_NOTARY_KEYCHAIN_PATH
AE_MCP_WINDOWS_SIGNING_CERT_SHA1
AE_MCP_WINDOWS_TIMESTAMP_URL
AE_MCP_WINDOWS_SIGNTOOL_PATH
AE_MCP_ZXP_SIGN_CMD
AE_MCP_ZXP_SIGN_CMD_SHA256
AE_MCP_ZXP_CERT_PATH
AE_MCP_ZXP_CERT_FINGERPRINT_SHA256
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

The approved native transport is N-API over a macOS Mach/XPC service and a Windows named pipe.
`scripts/package/build-platform-helper.mjs` now emits an arm64 helper executable, XPC bundle copy,
and arm64 `.node` addon for macOS. `sign-xpc` and `sign-addon` remain unimplemented mutation slots in
the older signing plan, so no signed candidate may be claimed until the signing task updates those
slots and nested verification covers the emitted paths. The final nested verifier must enumerate
every actual native file and fail if any file is unsigned or has the wrong architecture.

## macOS helper boundary

Build with the exact Node 24.17.0 headers archive locked by `packaging/runtime-lock.json`. The
archive path is the only required helper-build environment variable:

```bash
AE_MCP_NODE_HEADERS_ARCHIVE=/absolute/path/node-v24.17.0-headers.tar.gz \
  node scripts/package/build-platform-helper.mjs \
  --platform macos-arm64 --out build/helper/macos-arm64
```

If the selected Command Line Tools compiler and SDK were installed from incompatible point
releases, the following variables are diagnostic overrides only. They do not become candidate or
signing evidence:

```bash
export AE_MCP_MACOS_SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX15.4.sdk
export AE_MCP_SWIFT_INTERFACE_COMPILER_VERSION=6.3
```

The builder first copies the supplied archive into a mode `0600`, single-link file below its private
scratch directory. It hashes and extracts that same snapshot, requiring SHA-256
`ac60c4ba92204658efaac112efea5d3597348b011be679af0eec324d8c08915e`; later changes to the supplied
path cannot change the validated input. It builds the Swift service and N-API addon for arm64 with a
macOS 14 deployment target, rejects an existing output, and writes a content-addressed
`helper-manifest.json`. It does not sign, install, publish, or synthesize helper evidence.

This host's Swift 6.3.1 compiler and Swift 6.3.0 SDK require compatibility flags. The following is
still the standard SwiftPM Swift Testing runner (`swift test`), not a fallback executable:

```bash
test_scratch="${TMPDIR:-/tmp}/ae-mcp-platform-helper-tests"
mkdir -p "$test_scratch/modules"
env SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.4.sdk \
  CLANG_MODULE_CACHE_PATH="$test_scratch/modules" \
  SWIFT_MODULECACHE_PATH="$test_scratch/modules" \
  SWIFTPM_MODULECACHE_OVERRIDE="$test_scratch/modules" \
  SWIFTFLAGS='-Xfrontend -interface-compiler-version -Xfrontend 6.3' \
  swift test --disable-sandbox \
  --package-path native/platform-helper/macos \
  --scratch-path "$test_scratch" \
  -Xswiftc -Xfrontend -Xswiftc -interface-compiler-version \
  -Xswiftc -Xfrontend -Xswiftc 6.3 \
  -Xswiftc -F \
  -Xswiftc /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -F \
  -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath \
  -Xlinker /Library/Developer/CommandLineTools/Library/Developer/Frameworks \
  -Xlinker -rpath \
  -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib
```

The production authorization sequence uses only public macOS APIs:

1. capture `NSXPCConnection` PID, effective UID, positive audit-session ID, and process generation;
2. snapshot the direct process with `sysctl(KERN_PROC_PID)`, inspect its `SecCode`, and require the
   exact same PID, UID, parent PID, generation, and architecture in a second snapshot;
3. require the direct peer to be native arm64 `com.adobe.cep.CEPHtmlEngine`, validly Apple-anchored and
   signed by Adobe Team `JQ525L2MZD`; direct After Effects application connections are rejected;
4. walk toward a signed AE 25/26 ancestor, taking the same snapshot → `SecCode` → snapshot stability
   proof for every process so a PID-reuse splice cannot construct a false ancestry chain;
5. re-read every snapshot in the completed leaf-to-AE chain, require the whole chain to remain
   unchanged, and retain the XPC peer's current-user and audit-session binding;
6. only then install the production exported object and lazily create the shared Keychain backend.

All authorized connections receive the same helper-level `KeychainSecretStore`; its lock serializes
get/create/CAS/delete across connections. Accounts must match
`^provider:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[a-z][a-z0-9_-]{0,31}:v1$`.
Credential blobs have exactly `schemaVersion`, `revision`, and `value`. Set and delete both validate
post-write state. Any failed mutation is rolled back and the rollback is read back; if restoration
cannot be proved, the response remains `SECRET_STORE_UNAVAILABLE`, is non-retryable, and says the
credential store `state is uncertain` without including a reference or secret.

Rejected peers receive a rejection-only exported object. It performs only a bounded top-level ID
scan and returns `HELPER_UNAUTHORIZED backendAccessCount=0`; it never creates the request validator,
Keychain backend, or capture backend. The authorized branch additionally applies
`NSXPCConnection.setCodeSigningRequirement` before activating the connection. Foundation does not
expose the peer's complete `audit_token_t`; no private selector is used. If a later security review
requires full audit-token binding rather than PID/UID/session plus generation and the XPC peer
binding, the transport must move to a reviewed raw-XPC message boundary using
`SecCodeCreateWithXPCMessage`. This is a design gate, not permission to add a private API fallback.

### CEP extension identity limitation and capability proposal

The current boundary proves the identity and ancestry of an operating-system process. It cannot
prove which extension inside an Adobe CEP host originated JavaScript. In the threat model, other
Adobe CEP extensions running as the same user may have the same `CEPHtmlEngine` signing identifier,
Adobe Team ID, native architecture, and AE ancestry. macOS code signing therefore cannot distinguish
that extension from this one. Extension manifest data, argv, environment variables, or current
working directory are mutable inputs, not security attestations, and must not be promoted into the
authorization decision. This remains an explicit open architecture risk.

A minimal hardening experiment is a separately signed broker plus a short-lived capability:

1. launch the broker with a private inherited anonymous channel and bind it to the observed CEP
   process generation, UID, audit session, AE ancestry, helper protocol version, and requested scope;
2. generate a cryptographically random 256-bit capability in the broker, deliver it only over that
   channel, set a short monotonic expiry, and make it single-use for one helper connection;
3. have the helper atomically consume the capability and reject replay, expiry, scope widening, or a
   changed process binding; never place the capability in argv, the environment, a file, or logs.

This can reduce accidental cross-extension access, networkless guessing, and replay. It does not
solve a malicious peer extension that can launch the same broker and receive its own capability,
because the initial broker request still lacks a macOS-authenticated CEP extension ID. Closing that
case requires either an Adobe-supported extension attestation/bootstrap primitive, a host boundary
that assigns each extension a distinct trusted process identity, or an explicit product decision to
accept the residual risk. The broker proposal must not be represented as closure before that choice.

Run the disposable rejection probe from the repository root with the following exact commands. The
helper copy is ad-hoc signed only so launchd can execute the local negative-test artifact; neither the
signature nor this probe is release evidence:

```bash
helper_root="$(pwd)/build/helper/macos-arm64"
probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ae-mcp-helper-probe.XXXXXX")"
probe_helper="$probe_root/ae-mcp-platform-helper"
probe_plist="$probe_root/com.junkdoge.ae-mcp.platform-helper.plist"
domain="gui/$(id -u)"

/bin/cp "$helper_root/bin/ae-mcp-platform-helper" "$probe_helper"
/usr/bin/codesign --force --sign - "$probe_helper"
/usr/bin/sed \
  "s|__AE_MCP_HELPER_EXECUTABLE__|$probe_helper|g" \
  native/platform-helper/macos/Sources/PlatformHelperService/Resources/com.junkdoge.ae-mcp.platform-helper.plist \
  > "$probe_plist"
/usr/bin/plutil -lint "$probe_plist"

cleanup_helper_probe() {
  launchctl bootout "$domain/com.junkdoge.ae-mcp.platform-helper" 2>/dev/null || true
  /bin/rm -rf "$probe_root"
}
trap cleanup_helper_probe EXIT
launchctl bootstrap "$domain" "$probe_plist"
node scripts/phase0/assert-helper-rejected.mjs \
  --platform macos-arm64 --root "$helper_root" --method secret.get
launchctl bootout "$domain/com.junkdoge.ae-mcp.platform-helper"
trap - EXIT
/bin/rm -rf "$probe_root"
```

The expected terminal result is exactly:

```text
HELPER_UNAUTHORIZED backendAccessCount=0
```

The trap is required: it boots out the disposable agent even when the assertion fails.

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

Unit evidence validation and the macOS Terminal rejection probe are host-independent of After
Effects. A real positive macOS helper probe remains blocked until all of the following are true:

- AE 25 and AE 26 application and CEP executables pass strict `codesign --verify` with Adobe Team
  `JQ525L2MZD`; the current local AE 2026 and CEPHtmlEngine report modified signatures and must be
  repaired or reinstalled through Creative Cloud before positive authorization testing;
- the helper has the stable production signing identity needed for cross-build Keychain readback;
- the login/Data Protection Keychain is available and create/read/CAS/delete can run through the
  authorized XPC branch;
- a usable Developer ID Application identity, notarization keychain profile, and ZXPSignCmd
  certificate are installed on the signing host;
- the signing plan has active XPC/addon mutation and verification coverage.

AE 25 is not installed on the current Mac. Windows Authenticode, Credential Manager, named-pipe,
and ZXP proof must run on the Windows x64 signing host. Missing identities, tools, host versions, or
valid Adobe signatures are explicit Phase 0 blockers; they are never replaced by fake identities
or synthetic success evidence.
