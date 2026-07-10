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

manifest="$root/platform/macos-arm64/helper-manifest.json"
[[ -f "$manifest" ]] || fail 'SIGNING_HELPER_MANIFEST_MISSING: helper manifest is required'
mkdir -p "$(dirname "$evidence")"
[[ ! -e "$evidence" ]] || fail 'SIGNING_OUTPUT_EXISTS: evidence already exists'

entrypoints="$(node --input-type=module -e '
  import fs from "node:fs";
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const keys = Object.keys(value.entrypoints ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["helper", "launcher"])) process.exit(41);
  process.stdout.write(`${value.entrypoints.helper}\t${value.entrypoints.launcher}`);
' "$manifest")" || fail 'SIGNING_HELPER_MANIFEST_INVALID: unsupported helper entrypoints'
helper_relative="${entrypoints%%$'\t'*}"
launcher_relative="${entrypoints#*$'\t'}"
helper_root="$(dirname "$manifest")"
helper_path="$helper_root/$helper_relative"
launcher_path="$helper_root/$launcher_relative"
[[ -f "$helper_path" && -f "$launcher_path" ]] \
  || fail 'SIGNING_HELPER_MANIFEST_INVALID: entrypoint is missing'

hash_root() {
  node --input-type=module -e '
    import { sha256Directory } from "./scripts/package/lib/files.mjs";
    process.stdout.write(await sha256Directory(process.argv[1]));
  ' "$root"
}

source_stage_sha="$(/usr/bin/shasum -a 256 "$root/bundle-manifest.json" | /usr/bin/awk '{print $1}')"
before_helper="$(hash_root)"
/usr/bin/codesign --force --sign "$AE_MCP_APPLE_SIGNING_IDENTITY" \
  --options runtime --timestamp "$helper_path" >/dev/null 2>&1
/usr/bin/lipo -verify_arch arm64 "$helper_path" >/dev/null 2>&1
/usr/bin/codesign --verify --strict --verbose=4 "$helper_path" >/dev/null 2>&1
after_helper="$(hash_root)"

# sign-xpc and sign-addon are fixed compatibility slots. They intentionally mutate no bytes.
after_xpc="$after_helper"
after_addon="$after_xpc"

launcher_magic="$(/usr/bin/xxd -p -l 4 "$launcher_path" | /usr/bin/tr '[:upper:]' '[:lower:]')"
case "$launcher_magic" in
  cffaedfe|feedfacf|cefaedfe|feedface)
    /usr/bin/codesign --force --sign "$AE_MCP_APPLE_SIGNING_IDENTITY" \
      --options runtime --timestamp "$launcher_path" >/dev/null 2>&1
    /usr/bin/lipo -verify_arch arm64 "$launcher_path" >/dev/null 2>&1
    /usr/bin/codesign --verify --strict --verbose=4 "$launcher_path" >/dev/null 2>&1
    ;;
esac
after_launcher="$(hash_root)"

temporary="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ae-mcp-signing.XXXXXX")"
trap '/bin/rm -rf "$temporary"' EXIT
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
  /usr/bin/lipo -verify_arch arm64 "$candidate" >/dev/null 2>&1
  /usr/bin/codesign --verify --strict --verbose=4 "$candidate" >/dev/null 2>&1
done < "$native_list"
node --input-type=module -e '
  import fs from "node:fs";
  import { assertNestedNativeCoverage } from "./scripts/package/signing-plan.mjs";
  const values = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
  assertNestedNativeCoverage({ nativePaths: values, verifiedPaths: values });
' "$native_list"
after_verify="$(hash_root)"
[[ "$after_verify" = "$after_launcher" ]] \
  || fail 'SIGNING_OUTPUT_CHANGED: nested verification changed the signing root'

details="$(/usr/bin/codesign -d --verbose=4 "$helper_path" 2>&1)"
team_id="$(printf '%s\n' "$details" | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -1)"
[[ "$team_id" =~ ^[A-Z0-9]{10}$ ]] \
  || fail 'SIGNING_IDENTITY_INVALID: Developer ID Team ID was not verified'
certificate_prefix="$temporary/certificate"
/usr/bin/codesign -d --extract-certificates "$certificate_prefix" "$helper_path" >/dev/null 2>&1
certificate_fingerprint="$(/usr/bin/shasum -a 256 "${certificate_prefix}0" | /usr/bin/awk '{print $1}')"

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
