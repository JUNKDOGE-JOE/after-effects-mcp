# Platform helper security contract

The platform helper is an authenticated local capability boundary for secrets and window capture.
The CEP host loads the bundled N-API transport addon; on macOS the addon connects to the signed XPC
service, and on Windows it connects to the current-user named pipe helper. No helper transport opens
a TCP/UDP listener, enumerates provider secrets, or exposes a general-purpose command mode.

## Signing boundary

The signing plan reflects the shipped helper architecture and signs native code from the inside out:

- macOS signs the standalone arm64 helper, the XPC executable, the enclosing XPC bundle, and the
  arm64 N-API addon with hardened runtime and a secure timestamp. Sealing the XPC bundle creates the
  exact reviewed `Contents/_CodeSignature/CodeResources` file, which manifest freeze records before
  the final bundle is verified;
- Windows signs the helper EXE, N-API addon, and launcher EXE with SHA-256 plus an RFC 3161
  timestamp;
- every discovered Mach-O or PE file must equal the exact native set declared by the helper
  manifest and must pass strict platform verification;
- macOS verifies the configured Developer ID certificate fingerprint and Team ID on every signed
  native and on the XPC bundle. Windows verifies the configured Authenticode thumbprint and
  timestamp;
- verification and identity inspection may not mutate the signed root.

On Windows, the helper, addon, and launcher are each inspected independently after signing. Every
object must report `Status=Valid`, the configured protected signer thumbprint, and a valid timestamp
certificate after the `/tr` plus `/td SHA256` RFC 3161 signing operation. Aggregate evidence is
created only after all three object records pass the same validator.

The current macOS `bin/ae-mcp` launcher is a deterministic shell script, not native code. Its exact
manifest-bound SHA-256, executable mode, and `#!/bin/sh` interpreter are rechecked at the
`sign-launcher` step. It is protected by the signed ZXP/DMG chain. The release flow deliberately
does not apply a generic-code signature because that signature lives only in extended attributes
and would not survive the ZXP archive. If the launcher becomes Mach-O, a reviewed signing-plan
update must authorize that mutation before the same step performs Developer ID signing.

## macOS extended-attribute preflight

FileProvider and iCloud workspaces may attach metadata that Apple rejects while sealing a bundle.
Before the first signature, the signer scans every helper payload path without following symlinks or
accepting hard links. It removes only this reviewed packaging-metadata allowlist and reports the
relative path plus attribute name in the signing log:

- `com.apple.FinderInfo`;
- `com.apple.ResourceFork`;
- `com.apple.TextEncoding`;
- `com.apple.fileprovider.dir#N`;
- `com.apple.fileprovider.fpfs#P`;
- `com.apple.quarantine`.

`com.apple.provenance` is retained. Any other attribute, including an existing code-signature
attribute or compressed-data attribute, fails before cleanup starts. A second scan must find only
`com.apple.provenance`; metadata that reappears during a FileProvider race fails closed. The release
signer never uses broad `xattr -c` cleanup.

The raw attribute-name listing is accepted only when it is empty or has one terminal LF, with no
CR, empty entry, duplicate entry, or control character. Because the CLI's line format cannot encode
an embedded newline unambiguously, every parsed allowlisted name must also succeed in a
descriptor-bound `xattr -p` exact-name probe before any removal begins; probe values are discarded rather than
logged.

Each entry is bound with `O_NOFOLLOW`, and `xattr` receives the already-open vnode through
`/dev/fd/3` instead of resolving the payload path again. The signer compares device, inode, link
count, and type before and after each inspection or removal. It also re-traverses and compares the
complete entry set before cleanup, after cleanup, and after the final attribute inspection. A path
replaced with an outside hard link therefore cannot redirect the descriptor-bound removal.

This Node/CLI preflight is not an atomic transaction with the filesystem or with the later
`codesign` command. It fails closed on changes visible at its syscall boundaries, but it cannot
prove the absence of a hostile swap-and-restore performed entirely between those syscalls, nor can
it isolate an outside hard link created temporarily to the same already-open inode. Release signing
therefore requires an exclusive disposable workspace; later manifest hashing, `codesign`, and
signature verification remain independent fail-closed gates.

## Evidence and credential handling

The unsigned source stage is immutable. Signing happens only in a disposable verified copy, and
every reusable slice binds itself to the SHA-256 of the original canonical `bundle-manifest.json`.
The plan declares the exact native files and XPC seal that may change. Manifest freeze is the only
post-native in-tree metadata mutation, after which the entire bundle is verified again.

Signing credentials enter only through protected environment variables on the signing host.
Release signing requires Developer ID or Authenticode identities and timestamps; there is no ad-hoc
release fallback. Scripts suppress raw signer output and evidence stores only public verification
facts such as certificate fingerprints, Team ID, Authenticode thumbprint, notary submission ID, and
boolean verification results. Passwords, certificate bytes, keychain profile names, command output,
and environment values are excluded from evidence.

Runtime provider credentials remain behind the helper's OS credential-store interface. Phase 0
signing evidence proves code identity and packaging order only; it does not grant credential-store
access and never contains provider configuration.
