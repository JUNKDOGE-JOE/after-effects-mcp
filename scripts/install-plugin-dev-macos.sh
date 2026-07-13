#!/usr/bin/env bash
# Fail-closed macOS development deployment for the CEP panel.
# Run from any directory. After Effects must be completely closed.

set -Eeuo pipefail

fail() {
  printf 'Dev install failed: %s\n' "$1" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "required tool is unavailable: $1"
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "${script_dir}/.." && pwd -P)"
plugin_src="${repo_root}/plugin"
cep_parent="${HOME}/Library/Application Support/Adobe/CEP/extensions"
extension_id='com.aemcp.panel'
cep_dir="${cep_parent}/${extension_id}"

required_files=(
  'CSXS/manifest.xml'
  'client/index.html'
  'client/dist/app.js'
  'host/server.js'
  'jsx/runtime.jsx'
  '.debug'
)

require_tool pgrep
require_tool defaults
require_tool find
require_tool realpath
require_tool rsync
require_tool mv

set +e
pgrep -f 'Adobe After Effects|AfterFX' >/dev/null 2>&1
pgrep_status=$?
set -e
case "$pgrep_status" in
  0) fail 'all Adobe After Effects / AfterFX processes must be closed before deployment' ;;
  1) ;;
  *) fail 'could not determine whether After Effects is running' ;;
esac

[[ -d "$plugin_src" && ! -L "$plugin_src" ]] \
  || fail "plugin source is missing or symbolic: ${plugin_src}"

verify_tree_shape() {
  local root=$1
  local label=$2
  local real_root item real_item
  real_root="$(cd "$root" && pwd -P)" \
    || fail "could not resolve ${label} root: ${root}"
  find "$root" -print >/dev/null \
    || fail "could not inspect ${label} tree: ${root}"
  while IFS= read -r -d '' item; do
    [[ -L "$item" ]] \
      || fail "${label} tree may contain only regular files, directories, and safe symlinks: ${item}"
    real_item="$(realpath "$item")" \
      || fail "${label} symlink target is missing: ${item}"
    case "$real_item" in
      "$real_root"|"$real_root"/*) ;;
      *) fail "${label} symlink escapes plugin tree: ${item}" ;;
    esac
  done < <(find "$root" ! -type d ! -type f -print0)
}

verify_tree_shape "$plugin_src" 'plugin source'
for relative in "${required_files[@]}"; do
  [[ -f "${plugin_src}/${relative}" && ! -L "${plugin_src}/${relative}" ]] \
    || fail "required plugin source file is missing or symbolic: ${relative}"
done

mkdir -p "$cep_parent"
[[ -d "$cep_parent" && ! -L "$cep_parent" ]] \
  || fail "CEP extension parent is not a regular directory: ${cep_parent}"
cep_parent="$(cd "$cep_parent" && pwd -P)"
cep_dir="${cep_parent}/${extension_id}"
if [[ -e "$cep_dir" || -L "$cep_dir" ]]; then
  [[ -d "$cep_dir" && ! -L "$cep_dir" ]] \
    || fail "existing CEP target is not a regular directory: ${cep_dir}"
fi

install_id="$(date -u '+%Y%m%dT%H%M%SZ').$$.${RANDOM}"
staging="${cep_parent}/.${extension_id}.staging.${install_id}"
backup="${cep_parent}/.${extension_id}.backup.${install_id}"
failed_install="${cep_parent}/.${extension_id}.failed.${install_id}"
restore_replaced="${cep_parent}/.${extension_id}.replaced.${install_id}"
for generated in "$staging" "$backup" "$failed_install" "$restore_replaced"; do
  [[ ! -e "$generated" && ! -L "$generated" ]] \
    || fail "generated deployment path already exists: ${generated}"
done

completed=0
old_moved=0
stage_move_started=0

rollback_on_exit() {
  local status=$?
  local rollback_failed=0
  trap - EXIT
  if [[ $completed -ne 1 ]]; then
    if [[ $stage_move_started -eq 1 && ( -e "$cep_dir" || -L "$cep_dir" ) ]]; then
      mv "$cep_dir" "$failed_install" || rollback_failed=1
    fi
    if [[ $old_moved -eq 1 ]]; then
      if [[ -e "$backup" || -L "$backup" ]]; then
        mv "$backup" "$cep_dir" || rollback_failed=1
      else
        rollback_failed=1
      fi
    fi
    if [[ -e "$staging" || -L "$staging" ]]; then
      rm -rf "$staging" || rollback_failed=1
    fi
    if [[ $rollback_failed -ne 0 ]]; then
      printf 'Automatic rollback was incomplete. Preserve these paths for manual recovery:\n' >&2
      printf '  target: %s\n  backup: %s\n  failed candidate: %s\n' \
        "$cep_dir" "$backup" "$failed_install" >&2
      status=74
    fi
  fi
  exit "$status"
}
trap rollback_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

verify_tree() {
  local destination=$1
  local changes
  verify_tree_shape "$destination" 'staged plugin'
  for relative in "${required_files[@]}"; do
    [[ -f "${destination}/${relative}" && ! -L "${destination}/${relative}" ]] \
      || fail "staged plugin is missing a required regular file: ${relative}"
  done
  changes="$(rsync -ani --checksum --delete "${plugin_src}/" "${destination}/")" \
    || fail "could not verify staged plugin tree: ${destination}"
  [[ -z "$changes" ]] || fail "staged plugin tree differs from source: ${destination}"
}

printf '[1/5] Staging the complete plugin tree beside the final target...\n'
mkdir -m 700 "$staging"
rsync -a --delete "${plugin_src}/" "${staging}/" \
  || fail 'plugin copy into staging failed'

printf '[2/5] Verifying the staged tree before touching the deployed panel...\n'
verify_tree "$staging"

printf '[3/5] Enabling CEP PlayerDebugMode before the atomic swap...\n'
for version in $(seq 10 25); do
  defaults write "com.adobe.CSXS.${version}" PlayerDebugMode 1 \
    || fail "could not enable PlayerDebugMode for CSXS.${version}"
done

printf '[4/5] Atomically replacing the CEP panel while retaining the old install...\n'
if [[ -e "$cep_dir" ]]; then
  mv "$cep_dir" "$backup"
  old_moved=1
fi
stage_move_started=1
mv "$staging" "$cep_dir"
verify_tree "$cep_dir"
completed=1

printf '[5/5] Installed and verified: %s\n' "$cep_dir"
printf 'Restart After Effects, then open Window -> Extensions -> ae-mcp.\n'
if [[ $old_moved -eq 1 ]]; then
  printf 'Backup retained at: %s\n' "$backup"
  printf 'Restore command (run only while After Effects is closed):\n  '
  printf 'mv %q %q && mv %q %q\n' \
    "$cep_dir" "$restore_replaced" "$backup" "$cep_dir"
else
  printf 'No prior CEP panel existed, so no backup was created.\n'
fi
