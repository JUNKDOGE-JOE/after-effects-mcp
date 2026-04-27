# Dev install: copy plugin/ to AE's CEP extensions dir + enable PlayerDebugMode.
# Run from repo root: .\scripts\install-plugin-dev.ps1
# Requires AE to be closed.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginSrc = Join-Path $repoRoot 'plugin'
$cepDir = "$env:APPDATA\Adobe\CEP\extensions\com.aemcp.panel"

Write-Host "[1/3] Enabling CEP PlayerDebugMode..."
$key11 = 'HKCU:\Software\Adobe\CSXS.11'
if (-not (Test-Path $key11)) { New-Item -Path $key11 -Force | Out-Null }
Set-ItemProperty -Path $key11 -Name 'PlayerDebugMode' -Value '1' -Type String

$key12 = 'HKCU:\Software\Adobe\CSXS.12'
if (-not (Test-Path $key12)) { New-Item -Path $key12 -Force | Out-Null }
Set-ItemProperty -Path $key12 -Name 'PlayerDebugMode' -Value '1' -Type String

Write-Host "  Done (CSXS.11 + CSXS.12)."

Write-Host "[2/3] Removing old install at $cepDir (if present)..."
if (Test-Path $cepDir) { Remove-Item -Recurse -Force $cepDir }
Write-Host "  Done."

Write-Host "[3/3] Copying plugin/ -> $cepDir ..."
Copy-Item -Recurse -Force $pluginSrc $cepDir
Write-Host "  Done."

Write-Host ""
Write-Host "Installed. Restart AE."
Write-Host "The panel will appear under Window -> Extensions -> ae-mcp."
