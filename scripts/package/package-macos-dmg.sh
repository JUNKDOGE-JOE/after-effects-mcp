#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

zxp=''
out=''
evidence=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --zxp) zxp="${2-}"; shift 2 ;;
    --out) out="${2-}"; shift 2 ;;
    --evidence) evidence="${2-}"; shift 2 ;;
    *) fail 'SIGNING_ARGUMENT_INVALID: expected --zxp, --out, and --evidence' ;;
  esac
done

[[ "$zxp" = /* && "$out" = /* && "$evidence" = /* ]] \
  || fail 'SIGNING_PATH_ABSOLUTE_REQUIRED: DMG paths must be absolute'
node --input-type=module -e '
  import { assertSigningPaths } from "./scripts/package/signing-plan.mjs";
  assertSigningPaths({ source: process.argv[1], outputs: [process.argv[2], process.argv[3]] });
' "$zxp" "$out" "$evidence" \
  || fail 'SIGNING_PATH_OVERLAP: DMG paths are unsafe'
[[ -f "$zxp" ]] || fail 'SIGNING_ZXP_MISSING: signed ZXP is required'
[[ "$zxp" != "$out" && "$zxp" != "$evidence" && "$out" != "$evidence" ]] \
  || fail 'SIGNING_PATH_OVERLAP: DMG paths must be distinct'
[[ ! -e "$out" && ! -e "$evidence" ]] \
  || fail 'SIGNING_OUTPUT_EXISTS: DMG output or evidence already exists'
[[ -n "${AE_MCP_APPLE_SIGNING_IDENTITY-}" ]] \
  || fail 'SIGNING_CREDENTIAL_MISSING: AE_MCP_APPLE_SIGNING_IDENTITY is required'
[[ -n "${AE_MCP_NOTARY_KEYCHAIN_PROFILE-}" ]] \
  || fail 'SIGNING_CREDENTIAL_MISSING: AE_MCP_NOTARY_KEYCHAIN_PROFILE is required'

mkdir -p "$(dirname "$out")" "$(dirname "$evidence")"
zxp_evidence="$(dirname "$evidence")/zxp-evidence.json"
[[ -f "$zxp_evidence" ]] \
  || fail 'SIGNING_EVIDENCE_MISSING: canonical zxp-evidence.json is required beside DMG evidence'
zxp_sha="$(/usr/bin/shasum -a 256 "$zxp" | /usr/bin/awk '{print $1}')"
source_stage_sha="$(node --input-type=module -e '
  import { readSigningSliceEvidence } from "./scripts/package/signing-plan.mjs";
  const evidence = await readSigningSliceEvidence({
    evidencePath: process.argv[1], platform: "macos-arm64",
    expectedStepIds: ["sign-zxp", "verify-zxp"],
  });
  if (evidence.steps.at(-1).outputSha256 !== process.argv[2]) process.exit(42);
  process.stdout.write(evidence.sourceStageSha256);
' "$zxp_evidence" "$zxp_sha")" \
  || fail 'SIGNING_EVIDENCE_INVALID: ZXP evidence does not bind the input bytes'

temporary="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ae-mcp-dmg.XXXXXX")"
mounted=0
cleanup() {
  if [[ "$mounted" -eq 1 ]]; then
    /usr/bin/hdiutil detach "$temporary/mount" -quiet >/dev/null 2>&1 || true
  fi
  /bin/rm -rf "$temporary"
}
trap cleanup EXIT
mkdir -p "$temporary/content" "$temporary/mount"
/bin/cp -p "$zxp" "$temporary/content/$(basename "$zxp")"
copied_sha="$(/usr/bin/shasum -a 256 "$temporary/content/$(basename "$zxp")" | /usr/bin/awk '{print $1}')"
[[ "$copied_sha" = "$zxp_sha" ]] \
  || fail 'SIGNING_OUTPUT_CHANGED: ZXP bytes changed before DMG creation'

/usr/bin/hdiutil create -quiet -volname 'AE MCP' -srcfolder "$temporary/content" \
  -format UDZO "$out" >/dev/null
after_build="$(/usr/bin/shasum -a 256 "$out" | /usr/bin/awk '{print $1}')"
/usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$temporary/mount" "$out" -quiet >/dev/null
mounted=1
mounted_sha="$(/usr/bin/shasum -a 256 "$temporary/mount/$(basename "$zxp")" | /usr/bin/awk '{print $1}')"
[[ "$mounted_sha" = "$zxp_sha" ]] \
  || fail 'SIGNING_OUTPUT_CHANGED: probe DMG does not contain the exact ZXP bytes'
/usr/bin/hdiutil detach "$temporary/mount" -quiet >/dev/null
mounted=0

/usr/bin/codesign --force --sign "$AE_MCP_APPLE_SIGNING_IDENTITY" --timestamp "$out" >/dev/null 2>&1
/usr/bin/codesign --verify --strict --verbose=4 "$out" >/dev/null 2>&1
after_sign="$(/usr/bin/shasum -a 256 "$out" | /usr/bin/awk '{print $1}')"

notary_json="$temporary/notary.json"
/usr/bin/xcrun notarytool submit "$out" --keychain-profile "$AE_MCP_NOTARY_KEYCHAIN_PROFILE" \
  --wait --output-format json >"$notary_json" 2>/dev/null
notary_result="$(node --input-type=module -e '
  import fs from "node:fs";
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (value.status !== "Accepted" || typeof value.id !== "string") process.exit(43);
  process.stdout.write(value.id);
' "$notary_json")" || fail 'SIGNING_NOTARIZATION_FAILED: notary service did not accept the DMG'
[[ "$notary_result" =~ ^[0-9a-fA-F-]{36}$ ]] \
  || fail 'SIGNING_NOTARIZATION_FAILED: invalid notary submission identifier'
notary_result="$(printf '%s' "$notary_result" | /usr/bin/tr '[:upper:]' '[:lower:]')"
after_notarize="$(/usr/bin/shasum -a 256 "$out" | /usr/bin/awk '{print $1}')"
[[ "$after_notarize" = "$after_sign" ]] \
  || fail 'SIGNING_MUTATION_BOUNDARY_INVALID: notarization changed the DMG bytes'

/usr/bin/xcrun stapler staple "$out" >/dev/null 2>&1
after_staple="$(/usr/bin/shasum -a 256 "$out" | /usr/bin/awk '{print $1}')"
/usr/bin/xcrun stapler validate "$out" >/dev/null 2>&1
/usr/sbin/spctl --assess --type open --context context:primary-signature -v "$out" >/dev/null 2>&1
after_gatekeeper="$(/usr/bin/shasum -a 256 "$out" | /usr/bin/awk '{print $1}')"
[[ "$after_gatekeeper" = "$after_staple" ]] \
  || fail 'SIGNING_OUTPUT_CHANGED: Gatekeeper verification changed the DMG bytes'

details="$(/usr/bin/codesign -d --verbose=4 "$out" 2>&1)"
team_id="$(printf '%s\n' "$details" | /usr/bin/sed -n 's/^TeamIdentifier=//p' | /usr/bin/head -1)"
[[ "$team_id" =~ ^[A-Z0-9]{10}$ ]] \
  || fail 'SIGNING_IDENTITY_INVALID: Developer ID Team ID was not verified'
certificate_prefix="$temporary/certificate"
/usr/bin/codesign -d --extract-certificates "$certificate_prefix" "$out" >/dev/null 2>&1
certificate_fingerprint="$(/usr/bin/shasum -a 256 "${certificate_prefix}0" | /usr/bin/awk '{print $1}')"

export AE_MCP_E_STAGE_SHA="$source_stage_sha"
export AE_MCP_E_ZXP_SHA="$zxp_sha"
export AE_MCP_E_AFTER_BUILD="$after_build"
export AE_MCP_E_AFTER_SIGN="$after_sign"
export AE_MCP_E_AFTER_NOTARIZE="$after_notarize"
export AE_MCP_E_AFTER_STAPLE="$after_staple"
export AE_MCP_E_AFTER_GATEKEEPER="$after_gatekeeper"
export AE_MCP_E_CERT_FINGERPRINT="$certificate_fingerprint"
export AE_MCP_E_TEAM_ID="$team_id"
export AE_MCP_E_NOTARY_ID="$notary_result"
node --input-type=module -e '
  import { writeSigningSliceEvidence } from "./scripts/package/signing-plan.mjs";
  const e = process.env;
  const evidence = {
    schemaVersion: 1,
    platform: "macos-arm64",
    sourceStageSha256: e.AE_MCP_E_STAGE_SHA,
    steps: [
      { id: "build-dmg", inputSha256: e.AE_MCP_E_ZXP_SHA, outputSha256: e.AE_MCP_E_AFTER_BUILD, exitCode: 0 },
      { id: "sign-dmg", inputSha256: e.AE_MCP_E_AFTER_BUILD, outputSha256: e.AE_MCP_E_AFTER_SIGN, exitCode: 0 },
      { id: "notarize-dmg", inputSha256: e.AE_MCP_E_AFTER_SIGN, outputSha256: e.AE_MCP_E_AFTER_NOTARIZE, exitCode: 0 },
      { id: "staple-dmg", inputSha256: e.AE_MCP_E_AFTER_NOTARIZE, outputSha256: e.AE_MCP_E_AFTER_STAPLE, exitCode: 0 },
      { id: "verify-gatekeeper", inputSha256: e.AE_MCP_E_AFTER_STAPLE, outputSha256: e.AE_MCP_E_AFTER_GATEKEEPER, exitCode: 0 },
    ],
    verifiedIdentity: {
      certificateFingerprint: e.AE_MCP_E_CERT_FINGERPRINT,
      developerIdTeamId: e.AE_MCP_E_TEAM_ID,
      notarySubmissionId: e.AE_MCP_E_NOTARY_ID,
      stapledTicketVerified: true,
      gatekeeperVerified: true,
    },
  };
  await writeSigningSliceEvidence({
    evidencePath: process.argv[1], evidence, platform: evidence.platform,
    expectedStepIds: evidence.steps.map((step) => step.id),
    expectedInputSha256: evidence.steps[0].inputSha256,
    expectedStageSha256: evidence.sourceStageSha256,
  });
' "$evidence"
