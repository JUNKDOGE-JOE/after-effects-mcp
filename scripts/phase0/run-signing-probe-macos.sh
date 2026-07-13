#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 2 ]] || { printf '%s\n' 'usage: run-signing-probe-macos.sh <stage-root> <out-root>' >&2; exit 2; }
stage_root="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$1")"
out_root="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$2")"
node --input-type=module -e '
  import { assertSigningPaths } from "./scripts/package/signing-plan.mjs";
  assertSigningPaths({ source: process.argv[1], outputs: [process.argv[2]] });
' "$stage_root" "$out_root" \
  || { printf '%s\n' 'PHASE0_OUTPUT_OVERLAP: output path is unsafe' >&2; exit 1; }
[[ -d "$stage_root" ]] || { printf '%s\n' 'PHASE0_STAGE_MISSING: unsigned stage is required' >&2; exit 1; }
case "$out_root" in
  "$stage_root"|"$stage_root"/*) printf '%s\n' 'PHASE0_OUTPUT_OVERLAP: output cannot reuse the stage' >&2; exit 1 ;;
esac
[[ "$out_root" = */build/phase0/signing/macos-arm64 ]] \
  || { printf '%s\n' 'PHASE0_OUTPUT_ROOT_INVALID: output must end in build/phase0/signing/macos-arm64' >&2; exit 1; }
[[ ! -e "$out_root" ]] || { printf '%s\n' 'PHASE0_OUTPUT_EXISTS: disposable output already exists' >&2; exit 1; }

version="$(node -e 'const fs=require("node:fs"); const p=require("node:path"); process.stdout.write(JSON.parse(fs.readFileSync(p.join(process.argv[1],"bundle-manifest.json"),"utf8")).version)' "$stage_root")"
source_commit_sha="$(node -e 'const fs=require("node:fs"); const p=require("node:path"); process.stdout.write(JSON.parse(fs.readFileSync(p.join(process.argv[1],"bundle-manifest.json"),"utf8")).sourceCommitSha)' "$stage_root")"
node scripts/package/verify-platform-bundle.mjs --root "$stage_root" --platform macos-arm64 --version "$version" >/dev/null
source_stage_sha="$(/usr/bin/shasum -a 256 "$stage_root/bundle-manifest.json" | /usr/bin/awk '{print $1}')"
mkdir -p "$out_root"
/usr/bin/ditto --noqtn "$stage_root" "$out_root/work"
node scripts/package/verify-platform-bundle.mjs \
  --root "$out_root/work" --platform macos-arm64 --version "$version" >/dev/null

bash scripts/package/sign-macos-nested.sh \
  --root "$out_root/work" --evidence "$out_root/nested-evidence.json"
node scripts/package/freeze-signed-manifests.mjs \
  --root "$out_root/work" --platform macos-arm64 --version "$version" \
  --source-commit-sha "$source_commit_sha" --source-stage-sha256 "$source_stage_sha" \
  --evidence "$out_root/freeze-evidence.json"
node scripts/package/build-zxp.mjs \
  --root "$out_root/work" --platform macos-arm64 \
  --source-stage-sha256 "$source_stage_sha" \
  --out "$out_root/ae-mcp-panel-phase0-macos-arm64.zxp" \
  --evidence "$out_root/zxp-evidence.json"
bash scripts/package/package-macos-dmg.sh \
  --zxp "$out_root/ae-mcp-panel-phase0-macos-arm64.zxp" \
  --out "$out_root/ae-mcp-panel-phase0-macos-arm64.dmg" \
  --evidence "$out_root/dmg-evidence.json"

export AE_MCP_E_PHASE0_ROOT="$out_root"
export AE_MCP_E_STAGE_SHA="$source_stage_sha"
node --input-type=module -e '
  import { assemblePhase0SigningEvidence } from "./scripts/phase0/verify-signing-evidence.mjs";
  const root = process.env.AE_MCP_E_PHASE0_ROOT;
  await assemblePhase0SigningEvidence({
    outputRoot: root,
    platform: "macos-arm64",
    sourceStageSha256: process.env.AE_MCP_E_STAGE_SHA,
    freezeEvidencePath: `${root}/freeze-evidence.json`,
    sliceEvidencePaths: [
      `${root}/nested-evidence.json`, `${root}/zxp-evidence.json`, `${root}/dmg-evidence.json`,
    ],
  });
'

node scripts/package/verify-platform-bundle.mjs \
  --root "$stage_root" --platform macos-arm64 --version "$version" >/dev/null
unchanged_stage_sha="$(/usr/bin/shasum -a 256 "$stage_root/bundle-manifest.json" | /usr/bin/awk '{print $1}')"
[[ "$unchanged_stage_sha" = "$source_stage_sha" ]] \
  || { printf '%s\n' 'PHASE0_STAGE_CHANGED: unsigned source stage changed during probe' >&2; exit 1; }
node scripts/phase0/verify-signing-evidence.mjs \
  --evidence "$out_root/phase0-signing-evidence.json" --platform macos-arm64 --stage "$stage_root"
