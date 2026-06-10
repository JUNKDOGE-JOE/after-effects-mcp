# Dev install: copy plugin/ to AE's CEP extensions dir + enable PlayerDebugMode.
# Run from repo root: .\scripts\install-plugin-dev.ps1
# Requires AE to be closed.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$pluginSrc = Join-Path $repoRoot 'plugin'
$cepDir = "$env:APPDATA\Adobe\CEP\extensions\com.aemcp.panel"

Write-Host "[1/3] Enabling CEP PlayerDebugMode..."
10..25 | ForEach-Object {
    $key = "HKCU:\Software\Adobe\CSXS.$_"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -Type String
}

Write-Host "  Done (CSXS.10 through CSXS.25)."

Write-Host "[2/3] Removing old install at $cepDir (if present)..."
if (Test-Path $cepDir) { Remove-Item -Recurse -Force $cepDir }
Write-Host "  Done."

Write-Host "[3/3] Copying plugin/ -> $cepDir ..."
# Dev install intentionally KEEPS plugin/.debug so developers get the CEF
# remote-debugging port. The packaged ZXP (scripts/package-zxp.ps1) strips it
# so it never reaches end users.
Copy-Item -Recurse -Force $pluginSrc $cepDir
Write-Host "  Done."

Write-Host ""
Write-Host "Installed. Restart AE."
Write-Host "The panel will appear under Window -> Extensions -> ae-mcp."
