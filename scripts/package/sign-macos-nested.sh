#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "${1}" >&2
  exit 1
}

root=''
evidence=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) root="${2-}"; shift 2 ;;
    --evidence) evidence="${2-}"; shift 2 ;;
    *) fail 'SIGNING_ARGUMENT_INVALID: expected --root and --evidence' ;;
  esac
done

[[ "$root" = /* && "$evidence" = /* ]] \
  || fail 'SIGNING_PATH_ABSOLUTE_REQUIRED: signing paths must be absolute'
node --input-type=module -e '
  import { assertSigningPaths } from "./scripts/package/signing-plan.mjs";
  assertSigningPaths({ source: process.argv[1], outputs: [process.argv[2]] });
' "$root" "$evidence" \
  || fail 'SIGNING_PATH_OVERLAP: signing paths are unsafe'
[[ -d "$root" ]] || fail 'SIGNING_ROOT_MISSING: signing root does not exist'
case "$evidence" in
  "$root"|"$root"/*) fail 'SIGNING_PATH_OVERLAP: evidence must be outside the signing root' ;;
esac
[[ -n "${AE_MCP_APPLE_SIGNING_IDENTITY-}" ]] \
  || fail 'SIGNING_CREDENTIAL_MISSING: AE_MCP_APPLE_SIGNING_IDENTITY is required'
[[ "$AE_MCP_APPLE_SIGNING_IDENTITY" != '-' ]] \
  || fail 'SIGNING_IDENTITY_INVALID: ad-hoc identity is forbidden for release signing'
[[ "${AE_MCP_APPLE_CERT_FINGERPRINT_SHA256-}" =~ ^[a-f0-9]{64}$ \
   && "${AE_MCP_APPLE_TEAM_ID-}" =~ ^[A-Z0-9]{10}$ ]] \
  || fail 'SIGNING_IDENTITY_INVALID: protected Apple certificate fingerprint and team ID are required'

manifest="$root/platform/macos-arm64/helper-manifest.json"
[[ -f "$manifest" ]] || fail 'SIGNING_HELPER_MANIFEST_MISSING: helper manifest is required'
mkdir -p "$(dirname "$evidence")"
[[ ! -e "$evidence" ]] || fail 'SIGNING_OUTPUT_EXISTS: evidence already exists'

payload="$(node --input-type=module -e '
  import fs from "node:fs";
  import path from "node:path";
  import { sha256File } from "./scripts/package/lib/manifest.mjs";
  const manifestPath = process.argv[1];
  const root = path.dirname(manifestPath);
  const value = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const expected = {
    helper: ["bin/ae-mcp-platform-helper", "macho-arm64"],
    launcher: ["bin/ae-mcp", ["macho-arm64", "script"]],
    addon: ["lib/ae-mcp-platform-helper-transport.node", "macho-arm64"],
    xpc: ["xpc/com.junkdoge.ae-mcp.platform-helper.xpc/Contents/MacOS/ae-mcp-platform-helper", "macho-arm64"],
    xpcInfo: ["xpc/com.junkdoge.ae-mcp.platform-helper.xpc/Contents/Info.plist", "data"],
    entitlements: ["metadata/PlatformHelper.entitlements", "data"],
  };
  const keys = Object.keys(value.entrypoints ?? {}).sort();
  if (value.schemaVersion !== 1
      || value.platform !== "macos-arm64"
      || value.helperId !== "com.junkdoge.ae-mcp.platform-helper"
      || JSON.stringify(keys) !== JSON.stringify(["helper", "launcher"])
      || value.entrypoints.helper !== expected.helper[0]
      || value.entrypoints.launcher !== expected.launcher[0]
      || !Array.isArray(value.files)) process.exit(41);
  const records = new Map();
  for (const record of value.files) {
    if (!record || typeof record.path !== "string" || records.has(record.path)) process.exit(41);
    records.set(record.path, record);
  }
  for (const [relative, architecture] of Object.values(expected)) {
    const record = records.get(relative);
    const accepted = Array.isArray(architecture)
      ? architecture.includes(record?.architecture)
      : record?.architecture === architecture;
    const absolute = path.join(root, ...relative.split("/"));
    const stats = fs.lstatSync(absolute);
    if (!accepted || !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1
        || await sha256File(absolute) !== record.sha256) process.exit(41);
  }
  const launcher = records.get(expected.launcher[0]);
  process.stdout.write([
    expected.helper[0], expected.launcher[0], expected.addon[0], expected.xpc[0],
    launcher.architecture, launcher.sha256,
  ].join("\t"));
' "$manifest" 2>/dev/null)" || fail 'SIGNING_HELPER_MANIFEST_INVALID: helper payload identity is invalid'
IFS=$'\t' read -r helper_relative launcher_relative addon_relative xpc_relative \
  launcher_architecture launcher_sha256 <<< "$payload"
helper_root="$(dirname "$manifest")"
helper_path="$helper_root/$helper_relative"
launcher_path="$helper_root/$launcher_relative"
addon_path="$helper_root/$addon_relative"
xpc_executable="$helper_root/$xpc_relative"
xpc_bundle="$helper_root/xpc/com.junkdoge.ae-mcp.platform-helper.xpc"
entitlements_path="$helper_root/metadata/PlatformHelper.entitlements"
[[ -f "$helper_path" && -f "$launcher_path" && -f "$addon_path" \
   && -f "$xpc_executable" && -d "$xpc_bundle" && -f "$entitlements_path" ]] \
  || fail 'SIGNING_HELPER_MANIFEST_INVALID: helper, XPC, addon, or launcher is missing'

hash_root() {
  node --input-type=module -e '
    import { sha256Directory } from "./scripts/package/lib/files.mjs";
    process.stdout.write(await sha256Directory(process.argv[1]));
  ' "$root"
}

temporary="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ae-mcp-signing.XXXXXX")"
trap '/bin/rm -rf "$temporary"' EXIT

verify_native() {
  local candidate="$1"
  /usr/bin/lipo "$candidate" -verify_arch arm64 >/dev/null 2>&1 \
    || fail 'SIGNING_ARCH_INVALID: nested native code is not arm64'
  /usr/bin/codesign --verify --strict --verbose=4 "$candidate" >/dev/null 2>&1 \
    || fail 'SIGNING_VERIFY_FAILED: nested native signature verification failed'
}

sign_native() {
  local candidate="$1"
  /usr/bin/codesign --force --sign "$AE_MCP_APPLE_SIGNING_IDENTITY" \
    --options runtime --timestamp "$candidate" >/dev/null 2>&1 \
    || fail 'SIGNING_COMMAND_FAILED: Developer ID native signing failed'
  verify_native "$candidate"
}

sign_bundle() {
  local candidate="$1"
  /usr/bin/codesign --force --sign "$AE_MCP_APPLE_SIGNING_IDENTITY" \
    --options runtime --timestamp --entitlements "$entitlements_path" \
    "$candidate" >/dev/null 2>&1 \
    || fail 'SIGNING_COMMAND_FAILED: Developer ID XPC bundle signing failed'
  /usr/bin/codesign --verify --strict --verbose=4 "$candidate" >/dev/null 2>&1 \
    || fail 'SIGNING_VERIFY_FAILED: XPC bundle signature verification failed'
}

sign_launcher() {
  local candidate="$1"
  case "$launcher_architecture" in
    macho-arm64)
      sign_native "$candidate"
      ;;
    script)
      [[ -x "$candidate" ]] \
        || fail 'SIGNING_LAUNCHER_INVALID: shell launcher is not executable'
      [[ "$(/usr/bin/head -n 1 "$candidate")" = '#!/bin/sh' ]] \
        || fail 'SIGNING_LAUNCHER_INVALID: shell launcher interpreter is invalid'
      [[ "$(/usr/bin/shasum -a 256 "$candidate" | /usr/bin/awk '{print $1}')" \
          = "$launcher_sha256" ]] \
        || fail 'SIGNING_LAUNCHER_INVALID: shell launcher changed before packaging'
      ;;
    *)
      fail 'SIGNING_LAUNCHER_INVALID: launcher format is unsupported'
      ;;
  esac
}

xattr_audit="$(node scripts/package/macos-signing-xattrs.mjs --root "$helper_root")" \
  || fail 'SIGNING_XATTR_FAILED: pre-sign xattr policy failed'
printf 'SIGNING_XATTR_AUDIT %s\n' "$xattr_audit"

source_stage_sha="$(/usr/bin/shasum -a 256 "$root/bundle-manifest.json" | /usr/bin/awk '{print $1}')"
before_helper="$(hash_root)"
sign_native "$helper_path"
after_helper="$(hash_root)"

sign_native "$xpc_executable"
sign_bundle "$xpc_bundle"
verify_native "$xpc_executable"
after_xpc="$(hash_root)"

sign_native "$addon_path"
after_addon="$(hash_root)"

sign_launcher "$launcher_path"
after_launcher="$(hash_root)"

native_list="$temporary/native.txt"
node --input-type=module -e '
  import fs from "node:fs";
  import path from "node:path";
  const root = process.argv[1];
  const out = process.argv[2];
  const values = [];
  const visit = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) visit(absolute);
      else if (item.isFile()) {
        const handle = fs.openSync(absolute, "r");
        const bytes = Buffer.alloc(4);
        fs.readSync(handle, bytes, 0, 4, 0);
        fs.closeSync(handle);
        const magic = bytes.readUInt32LE(0);
        if ([0xfeedfacf, 0xcffaedfe, 0xfeedface, 0xcefaedfe].includes(magic)) {
          values.push(path.relative(root, absolute).split(path.sep).join("/"));
        }
      }
    }
  };
  visit(root);
  fs.writeFileSync(out, `${values.sort().join("\n")}\n`, { flag: "wx" });
' "$helper_root" "$native_list"

while IFS= read -r relative; do
  [[ -n "$relative" ]] || continue
  candidate="$helper_root/$relative"
  verify_native "$candidate"
done < "$native_list"
expected_launcher_native=''
[[ "$launcher_architecture" != 'macho-arm64' ]] || expected_launcher_native="$launcher_relative"
node --input-type=module -e '
  import fs from "node:fs";
  import { assertNestedNativeCoverage } from "./scripts/package/signing-plan.mjs";
  const values = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
  const expected = process.argv.slice(2).filter(Boolean).sort();
  if (JSON.stringify(values.toSorted()) !== JSON.stringify(expected)) process.exit(42);
  assertNestedNativeCoverage({ nativePaths: values, verifiedPaths: values });
' "$native_list" "$helper_relative" "$addon_relative" "$xpc_relative" \
  "$expected_launcher_native" \
  || fail 'SIGNING_UNSIGNED_NESTED_CODE: native coverage does not match the helper manifest'
/usr/bin/codesign --verify --strict --verbose=4 "$xpc_bundle" >/dev/null 2>&1 \
  || fail 'SIGNING_VERIFY_FAILED: XPC bundle verification failed'
after_verify="$(hash_root)"
[[ "$after_verify" = "$after_launcher" ]] \
  || fail 'SIGNING_OUTPUT_CHANGED: nested verification changed the signing root'

identity_index=0
verify_protected_identity() {
  local candidate="$1"
  local details team certificate_prefix certificate_fingerprint
  details="$(/usr/bin/codesign -d --verbose=4 "$candidate" 2>&1)" \
    || fail 'SIGNING_IDENTITY_INVALID: signed code identity could not be inspected'
  team="$(printf '%s\n' "$details" | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -1)"
  [[ "$team" = "$AE_MCP_APPLE_TEAM_ID" ]] \
    || fail 'SIGNING_IDENTITY_INVALID: Developer ID Team ID does not match the protected identity'
  printf '%s\n' "$details" | /usr/bin/grep -Eq '^CodeDirectory .* flags=.*runtime' \
    || fail 'SIGNING_IDENTITY_INVALID: hardened runtime flag was not verified'
  printf '%s\n' "$details" | /usr/bin/grep -Eq '^Timestamp=' \
    || fail 'SIGNING_IDENTITY_INVALID: secure timestamp was not verified'
  certificate_prefix="$temporary/certificate-$identity_index"
  /usr/bin/codesign -d --extract-certificates "$certificate_prefix" \
    "$candidate" >/dev/null 2>&1 \
    || fail 'SIGNING_IDENTITY_INVALID: Developer ID certificate could not be inspected'
  certificate="${certificate_prefix}0"
  certificate_fingerprint="$(/usr/bin/shasum -a 256 "$certificate" | /usr/bin/awk '{print $1}')"
  [[ "$certificate_fingerprint" = "$AE_MCP_APPLE_CERT_FINGERPRINT_SHA256" ]] \
    || fail 'SIGNING_IDENTITY_INVALID: Developer ID certificate does not match the protected fingerprint'
  identity_index=$((identity_index + 1))
}

verify_protected_identity "$helper_path"
verify_protected_identity "$xpc_executable"
verify_protected_identity "$xpc_bundle"
verify_protected_identity "$addon_path"
[[ "$launcher_architecture" != 'macho-arm64' ]] \
  || verify_protected_identity "$launcher_path"
team_id="$AE_MCP_APPLE_TEAM_ID"
certificate_fingerprint="$AE_MCP_APPLE_CERT_FINGERPRINT_SHA256"

export AE_MCP_E_PLATFORM='macos-arm64'
export AE_MCP_E_STAGE_SHA="$source_stage_sha"
export AE_MCP_E_BEFORE_HELPER="$before_helper"
export AE_MCP_E_AFTER_HELPER="$after_helper"
export AE_MCP_E_AFTER_XPC="$after_xpc"
export AE_MCP_E_AFTER_ADDON="$after_addon"
export AE_MCP_E_AFTER_LAUNCHER="$after_launcher"
export AE_MCP_E_AFTER_VERIFY="$after_verify"
export AE_MCP_E_CERT_FINGERPRINT="$certificate_fingerprint"
export AE_MCP_E_TEAM_ID="$team_id"
node --input-type=module -e '
  import { writeSigningSliceEvidence } from "./scripts/package/signing-plan.mjs";
  const e = process.env;
  const evidence = {
    schemaVersion: 1,
    platform: e.AE_MCP_E_PLATFORM,
    sourceStageSha256: e.AE_MCP_E_STAGE_SHA,
    steps: [
      { id: "sign-helper", inputSha256: e.AE_MCP_E_BEFORE_HELPER, outputSha256: e.AE_MCP_E_AFTER_HELPER, exitCode: 0 },
      { id: "sign-xpc", inputSha256: e.AE_MCP_E_AFTER_HELPER, outputSha256: e.AE_MCP_E_AFTER_XPC, exitCode: 0 },
      { id: "sign-addon", inputSha256: e.AE_MCP_E_AFTER_XPC, outputSha256: e.AE_MCP_E_AFTER_ADDON, exitCode: 0 },
      { id: "sign-launcher", inputSha256: e.AE_MCP_E_AFTER_ADDON, outputSha256: e.AE_MCP_E_AFTER_LAUNCHER, exitCode: 0 },
      { id: "verify-nested", inputSha256: e.AE_MCP_E_AFTER_LAUNCHER, outputSha256: e.AE_MCP_E_AFTER_VERIFY, exitCode: 0 },
    ],
    verifiedIdentity: {
      certificateFingerprint: e.AE_MCP_E_CERT_FINGERPRINT,
      developerIdTeamId: e.AE_MCP_E_TEAM_ID,
    },
  };
  await writeSigningSliceEvidence({
    evidencePath: process.argv[1], evidence, platform: evidence.platform,
    expectedStepIds: evidence.steps.map((step) => step.id),
    expectedInputSha256: evidence.steps[0].inputSha256,
    expectedStageSha256: evidence.sourceStageSha256,
  });
' "$evidence"
