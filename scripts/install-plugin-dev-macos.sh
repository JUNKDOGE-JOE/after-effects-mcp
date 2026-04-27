#!/usr/bin/env bash
# Dev install for macOS: copy plugin/ to AE's CEP extensions dir + enable PlayerDebugMode.
# Run from repo root: ./scripts/install-plugin-dev-macos.sh
# Requires After Effects to be closed.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
plugin_src="${repo_root}/plugin"
cep_dir="${HOME}/Library/Application Support/Adobe/CEP/extensions/com.aemcp.panel"

echo "[1/3] Enabling CEP PlayerDebugMode..."
for version in $(seq 10 25); do
  defaults write "com.adobe.CSXS.${version}" PlayerDebugMode 1
done
echo "  Done (CSXS.10 through CSXS.25)."

echo "[2/3] Removing old install at ${cep_dir} (if present)..."
rm -rf "${cep_dir}"
echo "  Done."

echo "[3/3] Copying plugin/ -> ${cep_dir} ..."
mkdir -p "$(dirname "${cep_dir}")"
cp -R "${plugin_src}" "${cep_dir}"
echo "  Done."

echo
echo "Installed. Restart After Effects."
echo "The panel should appear under Window -> Extensions -> ae-mcp."
echo
echo "This macOS path is not yet hardware-verified in this repository."
echo "If anything fails, please open a GitHub issue with your AE version, macOS version, and panel logs."
