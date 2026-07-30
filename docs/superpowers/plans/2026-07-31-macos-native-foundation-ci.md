# macOS Native Foundation CI and Release Verifiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one credential-free Apple Silicon foundation workflow and the two fail-closed RC verifiers already wired into `build-rc.yml`, while leaving real release approvals and hardware evidence blocked.

**Architecture:** Two focused Node ES modules validate product acceptance evidence and final native signatures using the repository's existing manifest, hashing, architecture, and signing-command contracts. A single `macos-15` workflow compiles/tests the real Swift helper and N-API addon, stages one unsigned macOS bundle, and uploads only a bounded CI receipt.

**Tech Stack:** Node.js 24.17.0 ESM and `node:test`, Swift Package Manager 6, GitHub Actions YAML, existing package/release manifest helpers, macOS `codesign`/`lipo`, Windows Authenticode command adapter.

## Global Constraints

- The normal workflow has exactly one `macos-15` arm64 job; do not add `macos-14-compat`, Windows, nightly, or self-hosted matrices.
- Ordinary PR CI must not import credentials, sign/notarize artifacts, start After Effects, publish a product, or run the intentionally blocked real native-coverage policy.
- Build the helper/runtime once; do not add byte-for-byte double-build reproducibility.
- Keep `packaging/native-coverage-approvals.json` and `packaging/product-acceptance-coverage.json` blocked and empty.
- Product-owned native helper, addon, native plug-in, and Windows launcher files require the protected product signer. The current macOS shell launcher is manifest/mode verified and must not be represented as a codesigned Mach-O file. Third-party runtime binaries require a valid signature but not the product signer.
- `finalRootSha256` is computed once in the final RC verifier only; do not add routine source/runtime/full-tree hashing.
- `reviewedBy` may identify a Subagent review task or receipt; this single-maintainer project does not require a second human maintainer.
- Do not add PID, start-token, process restart census, pairing, hostile same-user defenses, installer lifecycle, ScreenCaptureKit, AE hardware work, or generalized runner infrastructure.
- Every implementation task uses red-green-refactor and ends with a focused commit.

## File and Interface Map

- `scripts/release/verify-product-acceptance-coverage.mjs`
  - Owns product coverage CLI parsing, policy/evidence validation, and canonical result writing.
- `scripts/release/test/verify-product-acceptance-coverage.test.mjs`
  - Owns approved/blocked/stale/incomplete product coverage fixtures.
- `scripts/package/verify-final-native-signatures.mjs`
  - Owns final signed-root discovery, platform signature adapters, signer classification, and canonical result writing.
- `scripts/package/test/verify-final-native-signatures.test.mjs`
  - Owns signed-root fixture coverage and injected signature-adapter rejection cases.
- `scripts/release/artifact-manifest.mjs` and focused fixture/tests
  - Consume only real native-signature records; macOS requires helper/addon coverage while Windows also requires its native launcher.
- `.github/workflows/platform-foundation-ci.yml`
  - Owns the single credential-free Apple Silicon build/test/stage job and CI receipt.
- `native/platform-helper/macos/Tests/platform-helper-addon-live.test.mjs`
  - Owns the minimal real N-API module-load contract after the macOS addon is built.
- `scripts/release/test/signing-plan.test.mjs`
  - Owns the workflow boundary contract and removal of the superseded macOS 14 compatibility assertion.
- `scripts/release/test/native-coverage-gate.test.mjs`
  - Remains the integration contract proving the RC workflow calls both verifiers before consuming their evidence.
- `docs/RELEASE.md`
  - Describes that verifier implementation is present while real policy/evidence remains blocked.

---

### Task 1: Product acceptance coverage verifier

**Files:**
- Create: `scripts/release/verify-product-acceptance-coverage.mjs`
- Create: `scripts/release/test/verify-product-acceptance-coverage.test.mjs`

**Interfaces:**
- Consumes: `canonicalJson`, `assertPortableRelativePath`, `readJsonFile`, and
  `writeCanonicalJson` from `scripts/package/lib/manifest.mjs`, plus
  `readRegularFileSnapshot` and `sha256File` from
  `scripts/package/lib/files.mjs`.
- Produces:
  - `PRODUCT_ACCEPTANCE_SCENARIOS: readonly string[]`
  - `parseProductAcceptanceArgs(argv: string[]): { candidateSha: string, coveragePath: string, outPath: string }`
  - `verifyProductAcceptanceCoverage(input: { candidateSha: string, coveragePath: string }): Promise<{ schemaVersion: 1, candidateSha: string, result: "PASS", coverage: Array<{ id: string, result: "PASS", evidenceSha256: string }> }>`
  - `writeProductAcceptanceCoverageEvidence(input: { candidateSha: string, coveragePath: string, outPath: string }): Promise<{ schemaVersion: 1, candidateSha: string, result: "PASS", coverage: Array<{ id: string, result: "PASS", evidenceSha256: string }> }>`

- [ ] **Step 1: Write the failing argument and approved-fixture tests**

Create a temporary fixture with this exact approved selector:

```js
const scenarioIds = [
  'clean-install-and-upgrade-rollback',
  'permission-denial-and-recovery',
  'persistence',
  'provider-header-routing',
  'tool-library',
];

const selector = {
  evidence: scenarioIds.map((id) => ({
    id,
    candidateSha,
    result: 'PASS',
    evidencePath: `packaging/evidence/product-acceptance/${id}.json`,
    evidenceSha256: evidenceDigests.get(id),
    owner: 'JUNKDOGE-JOE',
    reviewedBy: 'subagent:issue68-product-coverage-review',
  })),
  requiredScenarios: scenarioIds,
  schemaVersion: 1,
  status: 'approved',
};
```

Each referenced evidence file is bounded canonical JSON and contains at least:

```js
{
  schemaVersion: 1,
  candidateSha,
  result: 'PASS',
  scenario: id,
}
```

Assert that:

```js
const result = await verifyProductAcceptanceCoverage({
  candidateSha,
  coveragePath: fixture.coveragePath,
});
assert.deepEqual(result, {
  schemaVersion: 1,
  candidateSha,
  result: 'PASS',
  coverage: scenarioIds.map((id) => ({
    id,
    result: 'PASS',
    evidenceSha256: fixture.evidenceDigests.get(id),
  })),
});
```

Also assert that the parser rejects missing, duplicate, unknown, non-absolute
`--coverage`/`--out`, and malformed candidate SHA arguments.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/release/test/verify-product-acceptance-coverage.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`verify-product-acceptance-coverage.mjs`.

- [ ] **Step 3: Implement the minimal parser and successful verifier**

Implement exact top-level selector keys:

```js
const SELECTOR_KEYS = ['evidence', 'requiredScenarios', 'schemaVersion', 'status'];
const ENTRY_KEYS = [
  'candidateSha',
  'evidencePath',
  'evidenceSha256',
  'id',
  'owner',
  'result',
  'reviewedBy',
];
```

Resolve evidence paths relative to the repository root inferred from the
canonical selector location. Reject paths that are absolute, escape that root,
are symbolic/hard linked, exceed 8 MiB, or do not match their recorded SHA-256.
Require the exact ordered scenario list, one exact-shaped entry per scenario,
matching candidate SHA, `PASS`, and non-empty `owner`/`reviewedBy`. Do not
require a second human reviewer or add an approval identity service.

The CLI error boundary is:

```js
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeProductAcceptanceCoverageEvidence(parseProductAcceptanceArgs(process.argv.slice(2)))
    .catch((error) => {
      process.stderr.write(
        `PRODUCT_ACCEPTANCE_COVERAGE_FAILED: ${error.message}\n`,
      );
      process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Add rejection tests**

Add one focused test for each concrete invalid release state:

```text
blocked selector
empty evidence array
missing/extra/duplicate/unsorted scenario
wrong candidate SHA
non-PASS selector entry
empty owner or reviewedBy
absolute or escaping evidence path
missing/symlink/hard-linked/oversized evidence file
evidence digest mismatch
evidence JSON candidate/result mismatch
pre-existing output path
```

Do not add process, lock, PID, retry, or approval-workflow tests.

- [ ] **Step 5: Run focused tests and existing consumers**

Run:

```bash
node --test scripts/release/test/verify-product-acceptance-coverage.test.mjs
node --test scripts/release/test/artifact-manifest.test.mjs
node --test scripts/release/test/native-coverage-gate.test.mjs
```

Expected: all PASS. The checked-in blocked selector remains unchanged.

- [ ] **Step 6: Commit Task 1**

```bash
git add \
  scripts/release/verify-product-acceptance-coverage.mjs \
  scripts/release/test/verify-product-acceptance-coverage.test.mjs
git commit -m "feat(release): verify product acceptance coverage"
```

---

### Task 2: Final native signature verifier

**Files:**
- Create: `scripts/package/verify-final-native-signatures.mjs`
- Create: `scripts/package/test/verify-final-native-signatures.test.mjs`
- Modify: `scripts/release/artifact-manifest.mjs`
- Modify: `scripts/release/test/artifact-manifest.test.mjs`
- Modify: `scripts/release/test/helpers/artifact-manifest-fixture.mjs`
- Modify: `scripts/release/test/verify-release-inputs.test.mjs`

**Interfaces:**
- Consumes:
  - `verifyPlatformBundle()` from `scripts/package/verify-platform-bundle.mjs`
  - `validateBundleManifest`, `readCanonicalJsonFile`, `sha256File`, `writeCanonicalJson` from `scripts/package/lib/manifest.mjs`
  - `detectBinaryArchitectureFile` from `scripts/package/lib/binary-arch.mjs`
  - `sha256Directory` from `scripts/package/lib/files.mjs`
  - product-owned paths declared by helper/native-plugin manifests
- Produces:
  - `parseFinalNativeSignatureArgs(argv: string[]): { platform: "macos-arm64"|"windows-x64", candidateSha: string, signedRoot: string, zxpPath: string, dmgPath?: string, outPath: string }`
  - `verifyFinalNativeSignatures(input: { platform: string, candidateSha: string, signedRoot: string, zxpPath: string, dmgPath?: string }, dependencies?: { inspectSignature?: Function }): Promise<object>`
  - `writeFinalNativeSignatureEvidence(input: { platform: string, candidateSha: string, signedRoot: string, zxpPath: string, dmgPath?: string, outPath: string }, dependencies?: { inspectSignature?: Function }): Promise<object>`
  - dependency seam `inspectSignature({ platform, filePath, requireProductIdentity, expectedFingerprint }): Promise<{ verified: true, signerFingerprint: string }>`

- [ ] **Step 1: Write the failing success-path fixture test**

Use `makeStageHarness()` plus the existing `machoArm64Bytes()`, `peX64Bytes()`,
`writeFixtureFile()`, and `rewriteStageManifests()` exports from
`scripts/package/test/helpers/platform-bundle-fixture.mjs`. The harness already
contains native helper, runtime, and platform-specific launcher fixtures.
After staging, add the missing addon to the staged helper fixture and rewrite
its two manifests:

```js
const addonRelative = platform === 'macos-arm64'
  ? 'lib/ae-mcp-platform-helper-transport.node'
  : 'lib/ae-mcp-platform-helper-transport.node';
const addonBytes = platform === 'macos-arm64'
  ? machoArm64Bytes()
  : peX64Bytes();
await writeFixtureFile(
  join(h.outDir, 'platform', platform),
  addonRelative,
  addonBytes,
  platform === 'macos-arm64' ? 0o755 : 0o644,
);
const helperManifestPath = join(
  h.outDir,
  'platform',
  platform,
  'helper-manifest.json',
);
const helperManifest = JSON.parse(await readFile(helperManifestPath, 'utf8'));
helperManifest.files.push({
  path: addonRelative,
  architecture: platform === 'macos-arm64' ? 'macho-arm64' : 'pe-x64',
  sha256: sha256Bytes(addonBytes),
});
await writeFile(helperManifestPath, `${JSON.stringify(helperManifest, null, 2)}\n`);
await rewriteStageManifests(h, { helper: true });
```

Create temporary ZXP and, for macOS, DMG files.

Inject:

```js
const inspections = [];
const inspectSignature = async (input) => {
  inspections.push(input);
  return {
    verified: true,
    signerFingerprint: input.requireProductIdentity
      ? expectedProductFingerprint
      : thirdPartyFingerprint,
  };
};
```

Assert the result has exactly:

```js
[
  'artifacts',
  'candidateSha',
  'discoveredNativeCount',
  'files',
  'finalRootSha256',
  'platform',
  'result',
  'schemaVersion',
  'signedBundleManifestSha256',
]
```

Assert `files` are UTF-8 byte sorted, every discovered native file is present,
product-owned records use the protected fingerprint, and the artifact list is
`[{ name, sha256 }]` for ZXP plus macOS DMG.

Add a consumer regression test proving the macOS shell launcher is not
fabricated as a native signature:

```js
assert.doesNotMatch(
  JSON.stringify(nativeSignatureEvidence.files),
  /platform\/macos-arm64\/bin\/ae-mcp"/,
);
assert.ok(nativeSignatureEvidence.files.some(
  (item) => item.path.endsWith('/bin/ae-mcp-platform-helper'),
));
assert.ok(nativeSignatureEvidence.files.some(
  (item) => item.path.endsWith(
    '/lib/ae-mcp-platform-helper-transport.node',
  ),
));
```

For Windows, retain required helper, addon, and native launcher records.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/package/test/verify-final-native-signatures.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`verify-final-native-signatures.mjs`.

- [ ] **Step 3: Implement manifest validation and native discovery**

Read the signed manifest, then call:

```js
await verifyPlatformBundle({
  root: signedRoot,
  platform,
  version: manifest.version,
  sourceCommitSha: candidateSha,
  verificationProfile: 'release-audit',
});
```

Discover native files only among manifest-declared regular files by calling
`detectBinaryArchitectureFile()` and accepting:

```js
platform === 'macos-arm64'
  ? ['macho-arm64', 'macho-universal-arm64']
  : ['pe-x64']
```

Derive product-owned paths from the helper manifest plus the optional native
plug-in manifest. Include the launcher in signature discovery only when its
declared architecture is native; the current macOS `script` launcher remains
covered by `verifyPlatformBundle()` hash/mode checks. Do not classify all
runtime files as product-owned and do not invent an extension-based native
list.

Narrow `assertNativeSignatureEvidence()` in
`scripts/release/artifact-manifest.mjs` to require:

```text
macos-arm64 -> ae-mcp-platform-helper + ae-mcp-platform-helper-transport.node
windows-x64 -> ae-mcp-platform-helper.exe + ae-mcp-platform-helper-transport.node + ae-mcp.exe
```

Update only the corresponding test fixtures. Do not change the evidence
schema, launcher implementation, or signing plan.

- [ ] **Step 4: Implement the real platform signature adapters**

For macOS:

```text
/usr/bin/codesign --verify --strict --verbose=4 <file>
/usr/bin/codesign -d --verbose=4 <file>
/usr/bin/codesign -d --extract-certificates <temporary-prefix> <file>
/usr/bin/shasum -a 256 <leaf-certificate>
```

For product-owned files, require the extracted certificate SHA-256 to equal
`AE_MCP_APPLE_CERT_FINGERPRINT_SHA256`. For third-party files, require
`codesign --verify` and record the extracted signer fingerprint without
requiring equality.

For Windows, invoke a bounded PowerShell command that calls
`Get-AuthenticodeSignature -LiteralPath <file>` and emits compact JSON with
`Status` and `SignerCertificate.Thumbprint`. Require `Status == "Valid"`; for
product-owned files require the thumbprint to equal
`AE_MCP_WINDOWS_SIGNING_CERT_SHA1`.

The adapter must inspect only the file requested by the verifier. It must not
enumerate processes, certificate stores, or unrelated filesystem roots.

- [ ] **Step 5: Implement artifact and canonical evidence writing**

Require:

```text
macos-arm64 -> exactly one --zxp and one --dmg
windows-x64 -> exactly one --zxp and no --dmg
```

Compute `signedBundleManifestSha256`, artifact digests, and exactly one
`sha256Directory(signedRoot)` call for `finalRootSha256`. Write the canonical
schema already validated by `scripts/release/artifact-manifest.mjs`.

The CLI failure boundary is:

```js
process.stderr.write(`FINAL_NATIVE_SIGNATURES_FAILED: ${error.message}\n`);
process.exitCode = 1;
```

- [ ] **Step 6: Add concrete rejection tests**

Add focused cases for:

```text
missing launcher/helper or a manifest-declared native file
manifest/file digest mismatch
wrong native architecture
unsigned/invalid signature adapter result
wrong product signer fingerprint
third-party valid signer accepted without product-fingerprint equality
missing or extra final artifact
wrong platform/candidate identity
pre-existing output
```

Use the injected adapter for signature cases. Do not create test certificates,
run real notarization, or build an adversarial security harness.

- [ ] **Step 7: Run focused and consumer tests**

Run:

```bash
node --test scripts/package/test/verify-final-native-signatures.test.mjs
node --test scripts/release/test/artifact-manifest.test.mjs
node --test scripts/release/test/native-coverage-gate.test.mjs
node --test scripts/release/test/signing-plan.test.mjs
```

Expected: all PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add \
  scripts/package/verify-final-native-signatures.mjs \
  scripts/package/test/verify-final-native-signatures.test.mjs \
  scripts/release/artifact-manifest.mjs \
  scripts/release/test/artifact-manifest.test.mjs \
  scripts/release/test/helpers/artifact-manifest-fixture.mjs \
  scripts/release/test/verify-release-inputs.test.mjs
git commit -m "feat(package): verify final native signatures"
```

---

### Task 3: Focused Apple Silicon foundation workflow

**Files:**
- Create: `.github/workflows/platform-foundation-ci.yml`
- Create: `native/platform-helper/macos/Tests/platform-helper-addon-live.test.mjs`
- Modify: `scripts/release/test/signing-plan.test.mjs`
- Modify: `docs/RELEASE.md`

**Interfaces:**
- Consumes: existing helper/runtime builders, `stage-platform-bundle.mjs`,
  `verify-platform-bundle.mjs`, Task 1/2 tests, and the pinned action SHAs
  already used by `build-rc.yml`.
- Produces: one `macos-15` arm64 required CI job and one bounded
  `platform-foundation-receipt.json` artifact.

- [ ] **Step 1: Replace the stale workflow-boundary test with the approved contract**

Change the existing `macos-14-compat` test to require:

```js
test('foundation CI is one credential-free Apple Silicon job', async () => {
  const workflow = await readFile(
    '.github/workflows/platform-foundation-ci.yml',
    'utf8',
  );
  assert.match(workflow, /runs-on:\s*macos-15/);
  assert.match(workflow, /\[\[ "\$\(uname -m\)" == 'arm64' \]\]/);
  assert.match(workflow, /swift test[\s\S]*native\/platform-helper\/macos/);
  assert.match(workflow, /build-platform-helper\.mjs[\s\S]*macos-arm64/);
  assert.match(workflow, /stage-platform-bundle\.mjs[\s\S]*macos-arm64/);
  assert.match(workflow, /verify-platform-bundle\.mjs[\s\S]*macos-arm64/);
  assert.match(workflow, /platform-foundation-receipt\.json/);
  assert.doesNotMatch(workflow, /macos-14-compat|windows-2025|schedule:/);
  assert.doesNotMatch(
    workflow,
    /AE_MCP_APPLE_CERT_P12_BASE64|notarytool|package-macos-dmg|build-rc/,
  );
});
```

Also assert all `uses:` references are immutable 40-hex SHAs and the workflow
does not execute `native-coverage-gate.mjs`.

- [ ] **Step 2: Run the boundary test and verify RED**

Run:

```bash
node --test scripts/release/test/signing-plan.test.mjs
```

Expected: FAIL because
`.github/workflows/platform-foundation-ci.yml` does not exist.

- [ ] **Step 3: Add the minimal workflow skeleton**

Create:

```yaml
name: macOS native foundation

on:
  push:
    branches: [main]
  pull_request: {}
  workflow_dispatch: {}

permissions:
  contents: read

concurrency:
  group: macos-foundation-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  macos-arm64:
    runs-on: macos-15
    timeout-minutes: 45
    env:
      MACOSX_DEPLOYMENT_TARGET: "14.0"
      AE_MCP_RUNTIME_LICENSE_APPROVAL: ${{ github.workspace }}/packaging/runtime-license-approvals.json
```

Use the existing immutable action SHAs:

```text
actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
astral-sh/setup-uv@08807647e7069bb48b6ef5acd8ec9567f424441b
actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
```

Pin Node `24.17.0`, uv `0.11.7`, and Python `3.13.13`. Assert
`uname -m == arm64` before native work.

- [ ] **Step 4: Add focused tests and one real helper/runtime build**

Run in this order:

```bash
swift test --package-path native/platform-helper/macos
node --test native/platform-helper/protocol/protocol.test.mjs
node --test native/platform-helper/macos/Tests/*.test.mjs
node --test \
  plugin/host/platform-helper-registration.test.js \
  plugin/host/platform-helper-transport.test.js \
  plugin/panel/test/runtimeManager.test.js
node --test scripts/package/test/verify-final-native-signatures.test.mjs
node --test scripts/release/test/verify-product-acceptance-coverage.test.mjs
```

Download only the locked Node headers URL/digest from
`packaging/runtime-lock.json` through the existing
`downloadLockedAsset()` helper into `$RUNNER_TEMP`; export that absolute path as
`AE_MCP_NODE_HEADERS_ARCHIVE`.

Then run once:

```bash
node scripts/package/build-portable-runtime.mjs \
  --platform macos-arm64 \
  --out build/runtime/macos-arm64
node scripts/package/build-platform-helper.mjs \
  --platform macos-arm64 \
  --out build/helper/macos-arm64
AE_MCP_MACOS_ADDON_PATH="$GITHUB_WORKSPACE/build/helper/macos-arm64/lib/ae-mcp-platform-helper-transport.node" \
  node --test native/platform-helper/macos/Tests/platform-helper-addon-live.test.mjs
```

Do not repeat the build for a reproducibility comparison.

The new live test contains only the N-API load contract:

```js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const addonPath = process.env.AE_MCP_MACOS_ADDON_PATH || '';

test('macOS helper addon loads and exposes createTransport', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64' || !addonPath,
}, () => {
  const addon = createRequire(import.meta.url)(addonPath);
  assert.equal(typeof addon.createTransport, 'function');
});
```

It does not start the helper, mutate Keychain state, open an XPC service, or
add a process-lifecycle test.

- [ ] **Step 5: Stage and verify one unsigned bundle**

Use the checked-out commit and current release version:

```bash
export AE_MCP_SOURCE_COMMIT_SHA="$(git rev-parse HEAD)"
node scripts/package/stage-platform-bundle.mjs \
  --platform macos-arm64 \
  --profile release-audit \
  --version 0.9.2 \
  --out build/stage/macos-arm64
node scripts/package/verify-platform-bundle.mjs \
  --root build/stage/macos-arm64 \
  --platform macos-arm64 \
  --profile release-audit \
  --version 0.9.2
```

This is an unsigned stage. Do not call signing, DMG, ZXP, notarization, AE, or
release workflows.

- [ ] **Step 6: Write and upload the bounded CI receipt**

Write canonical JSON at
`build/evidence/platform-foundation-receipt.json` with exact fields:

```js
{
  schemaVersion: 1,
  sourceCommitSha,
  runner: { os: process.platform, architecture: process.arch },
  toolchain: { node, swift, xcode },
  runtimeManifestSha256,
  stagedBundleManifestSha256,
  stagedRootSha256,
  afterEffectsEvidence: {
    produced: false,
    reason: 'credential-free-foundation-ci',
  },
}
```

Upload only this JSON as `macos-foundation-receipt-${{ github.sha }}` with
`retention-days: 14`. Do not upload `build/stage`, runtime, helper, ZXP, or DMG
files.

- [ ] **Step 7: Update release documentation**

In both Chinese and English sections of `docs/RELEASE.md`, state:

```text
The macOS foundation workflow and both RC verifier implementations are
present. The approval and product-acceptance selectors intentionally remain
blocked; a credentialed RC cannot pass until separately reviewed real
signature and AE/Windows hardware evidence is supplied.
```

Do not claim the RC or hardware matrix is complete.

- [ ] **Step 8: Run Task 3 tests**

Run:

```bash
node --test scripts/release/test/signing-plan.test.mjs
node --test scripts/release/test/native-coverage-gate.test.mjs
node --test scripts/package/test/verify-final-native-signatures.test.mjs
node --test scripts/release/test/verify-product-acceptance-coverage.test.mjs
git diff --check
```

Expected: all PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add \
  .github/workflows/platform-foundation-ci.yml \
  native/platform-helper/macos/Tests/platform-helper-addon-live.test.mjs \
  scripts/release/test/signing-plan.test.mjs \
  docs/RELEASE.md
git commit -m "ci(macos): add native foundation workflow"
```

---

## Integrated Verification and Review Gate

After all three task commits:

1. Run:

   ```bash
   node --test scripts/package/test/*.test.mjs
   node --test scripts/release/test/*.test.mjs
   git diff --check origin/main...HEAD
   ```

2. On macOS arm64, run the focused Swift/protocol tests:

   ```bash
   swift test --package-path native/platform-helper/macos
   node --test native/platform-helper/protocol/protocol.test.mjs
   node --test native/platform-helper/macos/Tests/*.test.mjs
   ```

3. Dispatch one concentrated Subagent spec-compliance review. The reviewer must
   check:
   - ordinary PR CI has no credentialed/release/AE path;
   - only one `macos-15` arm64 job exists;
   - blocked policy JSON files are byte unchanged;
   - product and third-party signer identities are classified separately;
   - final root hashing occurs only in the RC verifier;
   - no process/runtime/general security infrastructure was added.

4. Fix only a reproduced current-path blocker. Classify other findings as
   follow-up or out of scope under `AGENTS.md` section 5. Use at most two
   concentrated review rounds.

5. Push the branch and require the focused macOS foundation job plus existing
   required CI. No AE HDEV/T5/T6 is required for this Issue.

6. After merge, verify the relevant automated suites from clean `main`, publish
   the implementation/CI/review receipt in #68, and close it with an explicit
   note that real release evidence remains blocked.
