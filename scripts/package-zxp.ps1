# Build a signed ZXP package for the ae-mcp CEP panel.
#
# Usage:
#   .\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw>
# Optional:
#   .\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw> -CertPath release\ae-mcp.p12
#
# -CertPassword is REQUIRED (no baked-in default secret). The same password is
# used to create the self-signed cert (if none exists) and to sign.

param(
    [Parameter(Mandatory=$true)]
    [string]$ZxpSignCmd,

    [Parameter(Mandatory=$true)]
    [string]$CertPassword,

    [string]$CertPath = "",
    [string]$OutputPath = "",
    # Timestamp server: an untimestamped self-signed ZXP fails validation once
    # the cert expires. Timestamping pins the signature to signing time.
    [string]$Tsa = "http://timestamp.digicert.com"
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

Write-Host "[1/5] Staging plugin files..."
Copy-Item -Recurse -Force $pluginSrc $stageDir
if (Test-Path (Join-Path $stageDir 'host\node_modules')) {
    Remove-Item -Recurse -Force (Join-Path $stageDir 'host\node_modules')
}
if (Test-Path (Join-Path $stageDir 'panel')) {
    Remove-Item -Recurse -Force (Join-Path $stageDir 'panel')
}
if (Test-Path (Join-Path $stageDir 'sidecar\node_modules')) {
    Remove-Item -Recurse -Force (Join-Path $stageDir 'sidecar\node_modules')
}
if (Test-Path (Join-Path $stageDir 'sidecar\test')) {
    Remove-Item -Recurse -Force (Join-Path $stageDir 'sidecar\test')
}
# Never ship the CEF remote-debug port file to end users: it opens a
# remote-debugging port (the CEF context runs with node enabled), letting any
# local process attach a DevTools/Node client. Strip it before signing.
Remove-Item -Force (Join-Path $stageDir '.debug') -ErrorAction SilentlyContinue

Write-Host "[2/5] Installing host production dependencies..."
Push-Location (Join-Path $stageDir 'host')
try {
    npm ci --omit=dev
} finally {
    Pop-Location
}

Write-Host "[3/5] Installing sidecar production dependencies..."
Push-Location (Join-Path $stageDir 'sidecar')
try {
    npm ci --omit=dev
} finally {
    Pop-Location
}

if (-not (Test-Path $CertPath)) {
    Write-Host "[4/5] Creating self-signed ZXP certificate..."
    & $ZxpSignCmd -selfSignedCert US CA ae-mcp ae-mcp $CertPassword $CertPath
} else {
    Write-Host "[4/5] Using existing certificate $CertPath"
}

Write-Host "[5/5] Signing package..."
if (Test-Path $OutputPath) {
    Remove-Item -Force $OutputPath
}
# -tsa adds a trusted timestamp so the signature stays valid after the cert
# expires.
& $ZxpSignCmd -sign $stageDir $OutputPath $CertPath $CertPassword -tsa $Tsa

Write-Host ""
Write-Host "Wrote $OutputPath"
