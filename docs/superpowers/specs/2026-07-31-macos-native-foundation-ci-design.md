# macOS Native Foundation CI and Release Verifier Design

Date: 2026-07-31

Issue: #68

Status: User-approved scope; written-spec review

## Goal

Complete the missing macOS native build signal and the two release verifiers
that the existing RC workflow already calls:

1. a focused Apple Silicon CI workflow that proves the macOS helper/addon and
   unsigned package graph can be built and checked without release credentials;
2. a final-native-signature verifier that inspects the signed delivery graph;
3. a product-acceptance-coverage verifier that rejects empty, incomplete, or
   stale release evidence.

This Issue implements the gates. It does not manufacture or approve the real
release evidence that later macOS/Windows hardware and release Issues must
produce.

## Current Observed State

- `.github/workflows/ci.yml` runs Windows and Linux jobs but does not compile
  the Swift helper or the macOS N-API addon on Apple Silicon.
- `.github/workflows/build-rc.yml` already invokes
  `verify-product-acceptance-coverage.mjs` before candidate lock and
  `verify-final-native-signatures.mjs` after each platform signing plan.
- `scripts/release/native-coverage-gate.mjs` already declares the macOS
  workflow, both verifiers, and their tests as required implementation files.
- Those five files are absent on `origin/main`.
- `scripts/release/artifact-manifest.mjs` already defines the canonical output
  shapes consumed from both verifiers.
- `packaging/native-coverage-approvals.json` and
  `packaging/product-acceptance-coverage.json` intentionally remain
  `status: "blocked"` with no approvals or evidence.

## Considered Approaches

### Chosen: one focused implementation PR

Add the missing macOS workflow and both verifiers with focused tests. Keep the
real approval/evidence policies blocked. This completes the implementation
surface without pretending that downstream release acceptance has occurred.

### Rejected: split workflow and verifiers into separate PRs

The files are already one dependency set in `native-coverage-gate.mjs` and
`build-rc.yml`. Splitting them would duplicate review and CI while leaving the
same release path partially missing between merges.

### Rejected: make the complete release gate green in this PR

That would require real AE 25/26 macOS and Windows evidence, signed final
artifacts, credentialed release work, and downstream acceptance owned by
#69/#70/#80/#81 and Windows follow-up work. Pulling those into #68 would be
scope expansion or fabricated evidence.

## Design Decisions

### 1. Focused Apple Silicon workflow

Create `.github/workflows/platform-foundation-ci.yml` with:

- `pull_request`, `push` to `main`, and manual dispatch triggers;
- read-only repository permission and ordinary branch concurrency;
- one `macos-15` job that asserts `uname -m` is `arm64`;
- the repository's pinned Node version and macOS deployment target;
- Swift package tests for `native/platform-helper/macos`;
- the existing helper build, protocol, static, and N-API contract tests needed
  to falsify the macOS production build;
- one credential-free macOS helper/runtime build followed by unsigned
  stage-and-verify; and
- one small uploaded JSON receipt for this CI run, not a distributable product
  artifact.

The workflow will not:

- run on a nightly schedule;
- import signing or notarization credentials;
- install or launch After Effects;
- publish a release artifact;
- build twice merely to compare byte-for-byte output; or
- add another macOS compatibility or Windows matrix.

The unsigned stage already provides file-set, manifest, architecture, runtime,
and package-path checks. The final signed graph remains an RC responsibility.

An existing historical assertion in
`scripts/release/test/signing-plan.test.mjs` requires a `macos-14-compat` job as
soon as this workflow exists. That assertion will be narrowed to the newly
approved single `macos-15` arm64 boundary. The implementation must not add the
old compatibility or Windows matrix merely to satisfy the stale test.

### 2. Final native signature verifier

Create `scripts/package/verify-final-native-signatures.mjs` with the CLI already
used by `build-rc.yml`:

```text
--platform <macos-arm64|windows-x64>
--candidate-sha <40-hex>
--signed-root <absolute path>
--zxp <absolute path>
[--dmg <absolute path on macOS>]
--out <absolute path>
```

The verifier will:

1. run the existing `verifyPlatformBundle(..., verificationProfile:
   "release-audit")` contract against the signed root, which already validates
   the frozen bundle/runtime/helper manifests, actual file graph, digests, and
   native architecture;
2. require the manifest platform and source commit to match the CLI identity;
3. discover the actual native executables/addons by file magic and require
   exact correspondence with the frozen manifest;
4. verify every discovered native file with the platform's existing signing
   tool;
5. require product-owned native helper/addon/plugin files, plus the Windows
   native launcher, to match the release job's expected product signer
   identity, while third-party runtime-native files require a valid signature
   without pretending they use the product certificate;
6. record the signer fingerprint, native architecture result, and current file
   hash;
7. require the product launcher and platform helper to be present; the current
   macOS shell launcher is protected by the frozen manifest hash and executable
   mode rather than being falsely reported as a codesigned Mach-O file;
8. hash the already-produced ZXP and macOS DMG, when applicable; and
9. write the canonical evidence shape already consumed by
   `artifact-manifest.mjs`.

This is a post-signing RC verifier. It will not participate in routine local
startup, hash a source checkout, re-sign files, inspect processes, or create a
new identity/pairing system.

The expected macOS and Windows product signer fingerprints come from the
release job's existing protected environment. The test seam will inject
signing-command results so Linux contract CI can cover success and rejection
behavior without real certificates. Ordinary platform CI does not create a
fake release identity.

`finalRootSha256` requires one final directory digest because it is already a
hard contract of `artifact-manifest.mjs`. That single post-signing RC digest
must not be reused as a reason to hash a source checkout, routine runtime
startup, or AE validation fixture.

### 3. Product acceptance coverage verifier

Create `scripts/release/verify-product-acceptance-coverage.mjs` with the CLI
already used by `build-rc.yml`:

```text
--candidate-sha <40-hex>
--coverage <absolute path>
--out <absolute path>
```

The verifier will require:

- `status: "approved"` before it can emit `PASS`;
- the exact required scenario set already declared by
  `packaging/product-acceptance-coverage.json`;
- one input entry per scenario with exactly `id`, `candidateSha`, `result`,
  `evidencePath`, `evidenceSha256`, `owner`, and `reviewedBy`;
- repository-relative evidence paths plus non-empty owner and reviewer
  identities; `reviewedBy` may identify the Subagent review task/receipt used
  by this single-maintainer project and does not require a second human
  maintainer;
- one bounded, regular evidence JSON file per scenario whose top-level
  `candidateSha` and `result` identify the same passing candidate; and
- the evidence digest recorded in the policy to match the supplied bytes.

Its output will be the canonical `schemaVersion`, `candidateSha`, `result`, and
sorted `coverage` array expected by `artifact-manifest.mjs`.

The verifier only validates evidence. It does not start AE, generate acceptance
records, approve a policy, or infer that one scenario covers another.

### 4. Minimal rejection tests

Tests will prove that the new code rejects only concrete release-invalidating
states:

- missing required launcher/helper or another discovered native file;
- signed-manifest/file hash mismatch;
- wrong architecture;
- missing, invalid, or wrong signer identity;
- missing or unexpected final artifact;
- blocked, empty, incomplete, duplicate, or unsorted acceptance coverage;
- acceptance evidence for another candidate; and
- acceptance evidence digest mismatch.

These are verifier correctness tests, not a generalized security-hardening
program. No PID census, start token, process restart, hostile same-user
simulation, runner lifecycle, power-loss, installer, or concurrency framework
is added.

### 5. Evidence boundary

The macOS CI job will write and upload one bounded JSON receipt containing the
source commit, runner OS/architecture, Node/Swift/Xcode versions, runtime
manifest digest, staged bundle manifest digest, and staged root digest. It will
record that AE evidence was not produced by this credential-free foundation
job; it must not claim an AE version. The receipt is CI evidence only and is
not a signed or distributable product artifact.

The checked-in approval and product-coverage policies remain blocked. Normal PR
CI proves the verifier implementations with fixtures and an unsigned macOS
build. It does not run the real blocked `native-coverage-gate` CLI expecting
success. A credentialed RC remains blocked until separately reviewed real
evidence is supplied.

## Expected Change Surface

- `.github/workflows/platform-foundation-ci.yml`
- `scripts/package/verify-final-native-signatures.mjs`
- `scripts/package/test/verify-final-native-signatures.test.mjs`
- `native/platform-helper/macos/Tests/platform-helper-addon-live.test.mjs`
- `scripts/release/artifact-manifest.mjs` and its fixtures/tests, narrowly
  correcting the old assumption that the macOS shell launcher is native code
- `scripts/release/verify-product-acceptance-coverage.mjs`
- `scripts/release/test/verify-product-acceptance-coverage.test.mjs`
- narrowly required existing workflow/schema contract tests
- `scripts/release/test/signing-plan.test.mjs` to remove the superseded
  `macos-14-compat` workflow requirement
- `docs/RELEASE.md` only if needed to describe the now-implemented but still
  blocked gate

The exact list may contract during test-first implementation. Expansion into
runtime helper behavior, signing scripts, installer behavior, AE acceptance,
or Windows product implementation requires a reproduced blocker and explicit
scope review.

## Verification

Implementation follows red-green-refactor:

1. focused argument/schema/unit tests for each verifier;
2. focused signature-command adapter tests;
3. existing native-coverage, artifact-manifest, signing-plan, and workflow
   contract tests;
4. Swift helper tests and existing macOS helper/protocol/static tests;
5. one credential-free macOS helper/runtime build and unsigned stage/verify;
6. the affected packaging/release suites; and
7. required GitHub CI.

No AE hardware run is required because #68 does not change an AE capability,
installed runtime behavior, GUI state, or project state.

## Review and Scope Control

Use one concentrated Subagent review by default and no more than two rounds.
Classify findings under `AGENTS.md` section 5:

- only a reproduced failure in the new CI or release-verifier path is a current
  blocker;
- credible release hardening outside that path is a follow-up; and
- hypothetical runner/process/security infrastructure is out of scope.

The review must explicitly check that no credentialed behavior is reachable
from ordinary PR CI and that the blocked evidence policies were not relaxed.

## Completion and Issue Closure

#68 is implementation-complete when:

- the Apple Silicon workflow passes its focused build/test/stage path;
- both verifiers and their rejection tests pass;
- the existing RC workflow consumes their canonical outputs;
- required CI and concentrated review have no unresolved blocker;
- the PR is merged and the relevant clean-`main` automated checks pass; and
- the Issue closure comment states that real signed/hardware evidence remains
  blocked and owned by downstream release/Windows Issues.

Closing #68 does not mean the RC is releasable. It means the previously missing
gate implementations now exist and correctly prevent release without the
separately required evidence.
