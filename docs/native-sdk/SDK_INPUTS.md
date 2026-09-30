# After Effects native SDK inputs

This repository treats the Adobe After Effects C/C++ Plug-in SDK as a restricted,
operator-provided build input. It is not a vendored dependency, and CI does not fetch,
cache, or publish it.

This is a conservative engineering control, not legal advice or an Adobe approval. The
two developer-provided files reviewed for this policy do not, by themselves, establish
their official origin or any right to use, copy, store, or redistribute their contents.
An operator must obtain the SDK through an authorized channel and comply with the terms
that apply to that operator and use.

## What counts as the native SDK

The active input is the 64-bit After Effects 26.5 C/C++ Plug-in SDK publication v1.
The previous 25.6 build 61 input locks remain in `sdk.previousInputs` and continue
to be included in the anti-vendoring scan. The
old CC 2015 Panel SDK is a CEP/ExtendScript SDK, and the 2018 SensorManager SDK is specific
to MGJSON conversion. Neither can satisfy the native AEGP build contract.

Developers must obtain the matching fixed version themselves through Adobe's official
[After Effects Developer page](https://developer.adobe.com/after-effects/) and its
**Get the SDKs** flow. The repository does not download, mirror, or redistribute it.

| Platform | Filename hint | Bytes | SHA-256 |
|---|---|---:|---|
| macOS | `AfterEffectsSDK_26.5_MacOS.zip` | 2,055,405 | `7b837d594696ca0ece1ddba5e15b0fd3bf1ee908a1c7be04d4627180aa7ece7e` |
| Windows | `AfterEffectsSDK_26.5_win.zip` | 2,025,899 | `ad86bd6d66a1e1ffe8471e4618e3de4dbc9679f2ca47ae9bbe69f78805c82960` |

Size and SHA-256 bind only the exact developer-provided bytes reviewed here. They do
not prove Adobe origin, authenticity, version, license, or host compatibility. The
filename is a human hint and is not part of the cryptographic gate.

The machine-readable source of truth is
[`packaging/ae-sdk-inputs.json`](../../packaging/ae-sdk-inputs.json). The 26.5 inputs
are direct ZIP archives (`innerPayload: null`); the previous wrapped archive and
inner-payload locks are retained without executing any bundled decoder.

The authorized 2026-09-30 intake reused existing downloaded Windows and Mac ZIPs.
Their local download provenance records point to Adobe Developer and Adobe's
SDK CDN paths ending in `2026/windows/v1` and `2026/mac/v1`; signed query data is
not retained or published. This evidence supports developer custody and source
attribution; it is not an independent Adobe signature or license grant.
Header API identifiers are AEFX 8 and plug-in API 13.29, not a host build number.
The release label 26.5 comes from the distribution paths and archive roots.
`claimedBuild: 1` and native `compiledSdk.build=1` identify publication revision
v1; they do not invent an AE host/SDK internal build counter.

Windows .NET ZipArchive extraction preflight rejected path escapes, collisions,
links, special entries and excessive sizes. No bundled executable or script ran.
Both archive top folders were normalized to `ae26.5.64bit.AfterEffectsSDK` outside
Git without changing file bytes. Preserve each platform's line endings: all 70
shared headers match after CRLF/LF normalization, while their byte locks differ.
The Mac extracted tree contains 433 regular files totalling 5,691,159 bytes;
hashing sorted records of relative path, type,
size, and file SHA-256 yields
`85bbf6b40be790e58332dedaffa9b58db35301095bb0e3677404ca7fcf7f7f71`.
This fingerprint verifies extracted content, not Adobe origin or license. The Windows
canonical tree contains 432 regular files totalling 5,704,481 bytes; the corresponding
sorted file-record digest is
`1efedeb1a57df84f1a9ffb1cb2c6f4a360f28fcf3347ac36bb725f60d27bfd28`.

The repository does not publish per-file SDK fingerprints. Public CI inspects the tracked
Git index for SDK-only paths, recognizable SDK containers, and exact aggregate archive or
inner-payload byte locks. It rejects Git LFS pointers because public CI cannot inspect
their referenced objects. These checks prevent accidental vendoring; they do not establish
origin, license, compatibility, or permission to obtain any matching input.

## Storage and distribution policy

“Approved” in this repository means a recorded, scope-specific project decision. It
does not mean Adobe approval and is not a legal conclusion. On 14 July 2026, the
operator attested that they are authorized to use this SDK at their actual location and
authorized continued project development. The repository deliberately does not record or
infer that location. The attestation clears the local native execution-plane development
scope. Separately, project policy limits the public record to product-owned validation
code, aggregate locks, and minimal build-structure identifiers. Neither decision approves
SDK redistribution, hosted SDK storage, compiled product distribution, Adobe
sample-derived code, or model training/evaluation.

| Scope | Current policy |
|---|---|
| Local native development/testing | Allowed by the recorded operator attestation |
| Public repository | Product-owned policy/validator and non-content metadata only; no SDK material |
| Public CI/cache/artifact | Anti-vendoring tests only; no SDK fetch, cache, input, or artifact |
| Public integrity metadata | Aggregate locks and minimal build sentinels only; no comprehensive per-file index or file content |
| Private self-hosted CI | Blocked pending a separate, scope-specific approval |
| Private hosted artifact storage | Blocked pending a separate, scope-specific approval |
| Product release | SDK payload blocked; compiled plug-in distribution allowed by the explicit 2026-08-03 release approval |
| Adobe sample-derived code | Blocked pending separate review and provenance inventory |

The policy records the [Adobe Developer Terms of Use dated 18 June 2024](https://wwwimages2.adobe.com/content/dam/cc/en/legal/servicetou/Developer-Terms-en_US-20240618.pdf)
as review evidence retrieved on 14 July 2026. Recording that document is not a finding
that it authorizes these particular files or any of the scopes above.

The intake review found two terms that require explicit scope handling:

- Section 6.17 defines mainland China and Russia as restricted countries and requires
  specific Adobe authorization for Developer Tool use there. The operator attestation,
  rather than the configured timezone, is the recorded basis for continuing local work.
- Section 6.16 restricts using Adobe Services or Software, and information received or
  derived from them, to create, test, or improve machine-learning or AI systems. The
  attestation covers continued interactive MCP execution-plane development. Model
  training and the tiered model-evaluation work in issue #83 remain a separately reviewed
  later scope and do not block the current native vertical slice.

The reviewed local package also contains restrictive/confidentiality notices in headers,
utilities, and sample source. Their text is not copied here, and their exact applicability
remains pending. These embedded notices reinforce the blocks on vendoring, sample-derived
code, redistribution, and publishing a comprehensive per-file index or file content.

Do not execute or redistribute the `zstd`, `.sh`, `.bat`, or 7-Zip binaries bundled in
the SDK downloads. Use a separately acquired, trusted extraction tool and keep extraction
outside the checkout. This repository's validator never extracts the SDK. Do not place
the SDK, headers, examples, PDFs, PiPLtool, or bundled tools in Git or Git LFS.

## Environment contract

Native build entry points use two explicit inputs. Run them only under the recorded local
development scope or another separately approved scope:

- `AE_SDK_ARCHIVE`: the original developer-provided outer archive. Exact size and
  SHA-256 establish `sha256-verified` byte identity only.
- `AE_SDK_ROOT`: either the normalized `ae26.5.64bit.AfterEffectsSDK` directory or its
  direct parent. The validator checks root name, file types, build-critical sentinels, and
  the platform's canonical file-tree digest on both macOS and Windows.

Both paths must be outside the repository. The validator never prints them. A matching
macOS root fingerprint binds the extracted content to the reviewed intake, while trusted
extraction and operator custody remain explicit prerequisites. It still makes no claim
about who published the outer archive.

Verify the archive before extraction:

```sh
node scripts/package/ae-sdk-input.mjs verify-archive \
  --platform macos-arm64 \
  --archive /path/to/AfterEffectsSDK_26.5_MacOS.zip
```

After trusted extraction, verify the complete input:

```sh
AE_SDK_ARCHIVE=/path/to/AfterEffectsSDK_26.5_MacOS.zip \
AE_SDK_ROOT=/path/to/extracted-sdk \
node scripts/package/ae-sdk-input.mjs verify-input --platform macos-arm64
```

To re-check an already-extracted root against the layout lock without the archive:

```sh
AE_SDK_ROOT=/path/to/extracted-sdk \
node scripts/package/ae-sdk-input.mjs verify-root --platform macos-arm64
```

The equivalent Windows platform identifier is `windows-x64`. Missing inputs fail with
an actionable `AE_SDK_ROOT` or `AE_SDK_ARCHIVE` error; no build may silently use an SDK
from `PATH`, a global include directory, or a checkout subdirectory.

Public CI runs only:

```sh
node scripts/package/ae-sdk-input.mjs verify-repository --repo-root .
```

That command scans tracked Git content for known aggregate payload bytes, SDK-only paths,
container markers, and unsupported Git LFS pointers. It does not require a Provider, an
Adobe login, or an SDK download.

## Compatibility claims

The current record makes no AE 25, AE 26, AEGP suite, ABI, compiler, platform, or signing
compatibility claim. All remain `unknown` until the Guide/headers, a real build, and real
After Effects hosts provide evidence. In particular, the CEP host range and the product
support matrix are not native SDK compatibility evidence.

## Failure codes

- `AE_SDK_ROOT_REQUIRED` / `AE_SDK_ARCHIVE_REQUIRED`: explicit input is missing.
- `AE_SDK_INPUT_INSIDE_REPOSITORY`: SDK material would enter the source tree.
- `AE_SDK_ARCHIVE_INVALID`: archive type, size, or SHA-256 is wrong.
- `AE_SDK_LAYOUT_INVALID`: the extracted root or required AEGP/build entry differs.
- `AE_SDK_CONTENT_EVIDENCE_PENDING`: the platform has layout evidence but no canonical
  content lock and therefore cannot enter a build.
- `AE_SDK_POLICY_INVALID`: the locked policy was weakened, malformed, or no longer
  matches the canonical SHA-256 compiled into the validator.
- `AE_SDK_VENDORED`: tracked repository content matches forbidden SDK material.
- `AE_SDK_REPOSITORY_INVALID`: the tracked checkout cannot be enumerated safely.
- `AE_SDK_PLATFORM_UNSUPPORTED` / `AE_SDK_ARGUMENT_INVALID`: the requested contract is
  unsupported or ambiguous.
- `AE_SDK_INTERNAL_ERROR`: an unexpected failure without a more specific code; the
  message is still printed.
