# Build a signed ZXP package for the ae-mcp CEP panel.
#
# Usage:
#   .\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe
# Optional:
#   .\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPath release\ae-mcp.p12 -CertPassword changeit

param(
    [Parameter(Mandatory=$true)]
    [string]$ZxpSignCmd,

    [string]$CertPath = "",
    [string]$CertPassword = "ae-mcp-dev",
    [string]$OutputPath = ""
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $repoRoot 'release'
$stageDir = Join-Path $releaseDir 'ae-mcp-panel'
$pluginSrc = Join-Path $repoRoot 'plugin'

if (-not (Test-Path $ZxpSignCmd)) {
    throw "ZXPSignCmd not found: $ZxpSignCmd"
}

if (-not $OutputPath) {
    $OutputPath = Join-Path $releaseDir 'ae-mcp-panel.zxp'
}
if (-not $CertPath) {
    $CertPath = Join-Path $releaseDir 'ae-mcp-dev.p12'
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
if (Test-Path $stageDir) {
    Remove-Item -Recurse -Force $stageDir
}

Write-Host "[1/4] Staging plugin files..."
Copy-Item -Recurse -Force $pluginSrc $stageDir
if (Test-Path (Join-Path $stageDir 'host\node_modules')) {
    Remove-Item -Recurse -Force (Join-Path $stageDir 'host\node_modules')
}

Write-Host "[2/4] Installing host production dependencies..."
Push-Location (Join-Path $stageDir 'host')
try {
    npm ci --omit=dev
} finally {
    Pop-Location
}

if (-not (Test-Path $CertPath)) {
    Write-Host "[3/4] Creating self-signed ZXP certificate..."
    & $ZxpSignCmd -selfSignedCert US CA ae-mcp ae-mcp $CertPassword $CertPath
} else {
    Write-Host "[3/4] Using existing certificate $CertPath"
}

Write-Host "[4/4] Signing package..."
if (Test-Path $OutputPath) {
    Remove-Item -Force $OutputPath
}
& $ZxpSignCmd -sign $stageDir $OutputPath $CertPath $CertPassword

Write-Host ""
Write-Host "Wrote $OutputPath"
