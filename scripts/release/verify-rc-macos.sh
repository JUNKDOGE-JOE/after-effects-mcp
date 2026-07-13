#!/bin/bash
set -euo pipefail

usage() {
  echo "usage: $0 --artifact <dmg> --manifest <json> --candidate-sha <sha> --run-id <id> --artifact-id <id> --codex-version <version> --ae25-app <app> --ae26-app <app> --zxp-installer <path> --out <json>" >&2
  exit 64
}

artifact=''
manifest=''
candidate_sha=''
run_id=''
artifact_id=''
codex_version=''
ae25_app=''
ae26_app=''
zxp_installer=''
out=''
while (($#)); do
  case "$1" in
    --artifact) artifact=${2-}; shift 2 ;;
    --manifest) manifest=${2-}; shift 2 ;;
    --candidate-sha) candidate_sha=${2-}; shift 2 ;;
    --run-id) run_id=${2-}; shift 2 ;;
    --artifact-id) artifact_id=${2-}; shift 2 ;;
    --codex-version) codex_version=${2-}; shift 2 ;;
    --ae25-app) ae25_app=${2-}; shift 2 ;;
    --ae26-app) ae26_app=${2-}; shift 2 ;;
    --zxp-installer) zxp_installer=${2-}; shift 2 ;;
    --out) out=${2-}; shift 2 ;;
    *) usage ;;
  esac
done
for value in "$artifact" "$manifest" "$candidate_sha" "$run_id" "$artifact_id" \
  "$codex_version" "$ae25_app" "$ae26_app" "$zxp_installer" "$out"; do
  [[ -n "$value" ]] || usage
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
node_bin=$(command -v node) || { echo 'node is required for the verifier' >&2; exit 69; }
artifact=$(CDPATH= cd -- "$(dirname -- "$artifact")" && pwd -P)/$(basename -- "$artifact")
manifest=$(CDPATH= cd -- "$(dirname -- "$manifest")" && pwd -P)/$(basename -- "$manifest")
out_dir=$(CDPATH= cd -- "$(dirname -- "$out")" && pwd -P)
out=$out_dir/$(basename -- "$out")
[[ $(basename -- "$artifact") == 'ae-mcp-panel-v0.9.1-macos-arm64.dmg' ]] || {
  echo 'unexpected macOS RC artifact name' >&2
  exit 65
}
[[ $(basename -- "$ae25_app") == 'Adobe After Effects 2025.app' ]] || usage
[[ $(basename -- "$ae26_app") == 'Adobe After Effects 2026.app' ]] || usage
[[ -x "$zxp_installer" && -f "$manifest" && -f "$artifact" ]] || {
  echo 'required RC input is missing' >&2
  exit 66
}
[[ $(/usr/bin/uname -m) == 'arm64' ]] || {
  echo 'macOS RC verification requires native arm64' >&2
  exit 67
}
os_version=$(/usr/bin/sw_vers -productVersion)
os_major=${os_version%%.*}
[[ "$os_major" =~ ^[0-9]+$ && $os_major -ge 14 ]] || {
  echo 'macOS RC verification requires macOS 14 or newer' >&2
  exit 68
}

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/ae-mcp-rc.XXXXXX")
mount_point="$work_dir/mount"
mkdir -m 700 "$mount_point"
mounted=0
cleanup() {
  if [[ $mounted == 1 ]]; then hdiutil detach "$mount_point" >/dev/null 2>&1 || true; fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

commands_json='[]'
failures_json='[]'
append_command() {
  commands_json=$("$node_bin" -e 'const a=JSON.parse(process.argv[1]);a.push({command:process.argv[2],exitCode:Number(process.argv[3])});process.stdout.write(JSON.stringify(a))' "$commands_json" "$1" "$2")
}
append_failure() {
  failures_json=$("$node_bin" -e 'const a=JSON.parse(process.argv[1]);a.push(process.argv[2]);process.stdout.write(JSON.stringify(a))' "$failures_json" "$1")
}
run_recorded() {
  local label=$1
  shift
  local code
  set +e
  "$@" >/dev/null 2>&1
  code=$?
  set -e
  append_command "$label" "$code"
  if [[ $code != 0 ]]; then append_failure "$label failed"; fi
  return "$code"
}

manifest_sha() {
  "$node_bin" -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const e=(m.artifacts||[]).find(x=>x.name===process.argv[2]&&String(x.artifactId)===process.argv[3]);if(!e)process.exit(2);process.stdout.write(String(e.sha256));' "$manifest" "$1" "$2"
}
runtime_manifest_sha() {
  "$node_bin" -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const e=(m.evidence||[]).filter(x=>x.platform==="macos-arm64");if(e.length!==1)process.exit(2);const f=(e[0].bundleManifest&&e[0].bundleManifest.files||[]).filter(x=>x.path==="runtime/macos-arm64/runtime-manifest.json");if(f.length!==1||!/^[a-f0-9]{64}$/.test(String(f[0].sha256||"")))process.exit(3);process.stdout.write(f[0].sha256);' "$manifest"
}
check_artifact_hash() {
  local expected actual
  expected=$(manifest_sha "$(basename -- "$artifact")" "$artifact_id") || return
  actual=$(/usr/bin/shasum -a 256 "$artifact" | /usr/bin/awk '{print $1}') || return
  [[ "$actual" == "$expected" ]]
}

preflight_ok=1
expected_runtime_manifest_sha=$(runtime_manifest_sha) || {
  append_command 'bind installed runtime manifest to RC bundle' 1
  append_failure 'RC runtime manifest evidence is missing'
  expected_runtime_manifest_sha=''
  preflight_ok=0
}
if [[ -n "$expected_runtime_manifest_sha" ]]; then
  append_command 'bind installed runtime manifest to RC bundle' 0
fi
run_recorded 'shasum -a 256 artifact and bind manifest' check_artifact_hash || preflight_ok=0
run_recorded 'codesign --verify --deep --strict' /usr/bin/codesign --verify --deep --strict "$artifact" || preflight_ok=0
run_recorded 'spctl --assess' /usr/sbin/spctl --assess --type open "$artifact" || preflight_ok=0
run_recorded 'xcrun stapler validate' /usr/bin/xcrun stapler validate "$artifact" || preflight_ok=0

payload="$mount_point/ae-mcp-panel-v0.9.1-macos-arm64.zxp"
expected_launcher_sha=''
if [[ $preflight_ok == 1 ]]; then
  if run_recorded 'mount exact notarized DMG' hdiutil attach -readonly -nobrowse -mountpoint "$mount_point" "$artifact"; then
    mounted=1
  else
    preflight_ok=0
  fi
fi
if [[ $preflight_ok == 1 ]]; then
  payload_sha=$(manifest_sha "$(basename -- "$payload")" "$($node_bin -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const e=(m.artifacts||[]).find(x=>x.name===process.argv[2]);if(!e)process.exit(2);process.stdout.write(String(e.artifactId));' "$manifest" "$(basename -- "$payload")")") || payload_sha=''
  actual_payload_sha=$(/usr/bin/shasum -a 256 "$payload" 2>/dev/null | /usr/bin/awk '{print $1}') || actual_payload_sha=''
  if [[ -z "$payload_sha" || "$actual_payload_sha" != "$payload_sha" ]]; then
    append_command 'verify exact ZXP payload from DMG' 1
    append_failure 'exact ZXP payload verification failed'
    preflight_ok=0
  else
    append_command 'verify exact ZXP payload from DMG' 0
  fi
fi
if [[ $preflight_ok == 1 ]]; then
  extracted_zxp="$work_dir/zxp"
  mkdir -m 700 "$extracted_zxp"
  if run_recorded 'extract exact signed ZXP for launcher binding' \
    /usr/bin/ditto -x -k "$payload" "$extracted_zxp"; then
    packaged_launcher="$extracted_zxp/platform/macos-arm64/bin/ae-mcp"
    if [[ -f "$packaged_launcher" && ! -L "$packaged_launcher" ]]; then
      expected_launcher_sha=$(/usr/bin/shasum -a 256 "$packaged_launcher" \
        | /usr/bin/awk '{print $1}') || expected_launcher_sha=''
    fi
    if [[ ! "$expected_launcher_sha" =~ ^[a-f0-9]{64}$ ]]; then
      append_command 'bind installed stable launcher to signed ZXP' 1
      append_failure 'signed ZXP launcher evidence is missing'
      preflight_ok=0
    else
      append_command 'bind installed stable launcher to signed ZXP' 0
    fi
  else
    preflight_ok=0
  fi
fi
if [[ $preflight_ok == 1 ]]; then
  run_recorded 'install exact signed ZXP' "$zxp_installer" --install "$payload" || preflight_ok=0
fi

ae25_version='25.0-unavailable'
ae26_version='26.0-unavailable'
if [[ -f "$ae25_app/Contents/Info.plist" ]]; then
  ae25_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ae25_app/Contents/Info.plist" 2>/dev/null || echo '25.0-unavailable')
fi
if [[ -f "$ae26_app/Contents/Info.plist" ]]; then
  ae26_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ae26_app/Contents/Info.plist" 2>/dev/null || echo '26.0-unavailable')
fi
[[ $ae25_version == 25.* ]] || { append_failure 'AE 25 version identity failed'; preflight_ok=0; }
[[ $ae26_version == 26.* ]] || { append_failure 'AE 26 version identity failed'; preflight_ok=0; }

launcher="$HOME/.ae-mcp/bin/ae-mcp"
runtime_manifest="$HOME/.ae-mcp/runtime/0.9.1/macos-arm64/runtime-manifest.json"
run_ae_smoke() {
  local app=$1 major=$2 smoke_out=$3 app_name code=0
  app_name=$(basename -- "$app" .app)
  /usr/bin/open "$app" || code=$?
  if [[ $code == 0 ]]; then
    for _ in {1..60}; do
      [[ -x "$launcher" && -f "$runtime_manifest" ]] && break
      /bin/sleep 2
    done
    if [[ ! -x "$launcher" || ! -f "$runtime_manifest" ]]; then
      code=1
    else
      set +e
      "$node_bin" "$repo_root/scripts/release/smoke-installed-runtime.mjs" \
        --launcher "$launcher" \
        --runtime-manifest "$runtime_manifest" \
        --expected-platform macos-arm64 \
        --expected-version 0.9.1 \
        --expected-runtime-manifest-sha256 "$expected_runtime_manifest_sha" \
        --expected-launcher-sha256 "$expected_launcher_sha" \
        --expected-ae-major "$major" \
        --out "$smoke_out"
      code=$?
      set -e
    fi
  fi
  /usr/bin/osascript -e "tell application \"$app_name\" to quit" >/dev/null 2>&1 || true
  append_command "AE $major installed-runtime smoke" "$code"
  if [[ $code != 0 ]]; then append_failure "AE $major installed-runtime smoke failed"; fi
  return "$code"
}

ae25_result='FAIL'
ae26_result='FAIL'
ae25_smoke="$work_dir/ae-mcp-ae25-smoke.json"
ae26_smoke="$work_dir/ae-mcp-ae26-smoke.json"
if [[ $preflight_ok == 1 ]] && run_ae_smoke "$ae25_app" 25 "$ae25_smoke"; then ae25_result='PASS'; fi
if [[ $preflight_ok == 1 ]] && run_ae_smoke "$ae26_app" 26 "$ae26_smoke"; then ae26_result='PASS'; fi
if [[ $preflight_ok != 1 ]]; then
  append_failure 'installed-runtime smoke skipped because RC preflight failed'
fi

"$node_bin" "$repo_root/scripts/release/write-attestation.mjs" \
  --platform macos-arm64 \
  --candidate-sha "$candidate_sha" \
  --run-id "$run_id" \
  --artifact-id "$artifact_id" \
  --artifact "$artifact" \
  --manifest "$manifest" \
  --os-version "macOS $os_version" \
  --codex-version "$codex_version" \
  --ae25-version "$ae25_version" \
  --ae25-result "$ae25_result" \
  --ae26-version "$ae26_version" \
  --ae26-result "$ae26_result" \
  --commands-json "$commands_json" \
  --failures-json "$failures_json" \
  --out "$out"
