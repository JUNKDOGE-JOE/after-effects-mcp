# Build a signed ZXP package for the ae-mcp CEP panel.
#
# Usage:
#   .\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw> -HelperRoot build\helper\windows-x64
# Optional:
#   .\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe -CertPassword <pw> -HelperRoot build\helper\windows-x64 -CertPath release\ae-mcp.p12
#
# -CertPassword is REQUIRED (no baked-in default secret). The same password is
# used to create the self-signed cert (if none exists) and to sign.

param(
    [Parameter(Mandatory=$true)]
    [string]$ZxpSignCmd,

    [Parameter(Mandatory=$true)]
    [string]$CertPassword,

    [Parameter(Mandatory=$true)]
    [string]$HelperRoot,

    [string]$CertPath = "",
    [string]$OutputPath = "",
    [string]$Version = "0.9.4",
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
if (-not (Test-Path -LiteralPath $HelperRoot -PathType Container)) {
    throw "Windows Platform Helper root not found: $HelperRoot"
}
$HelperRoot = (Resolve-Path -LiteralPath $HelperRoot).Path

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

Write-Host "[1/6] Staging plugin files..."
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

Write-Host "[2/6] Staging the Windows Platform Helper..."
$helperStageDir = Join-Path $stageDir 'platform\windows-x64'
New-Item -ItemType Directory -Force -Path $helperStageDir | Out-Null
Get-ChildItem -LiteralPath $HelperRoot -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $helperStageDir -Recurse -Force
}

Write-Host "[3/6] Installing production host runtime dependencies..."
$runtimeHostDir = Join-Path $stageDir 'runtime\windows-x64\node\host'
New-Item -ItemType Directory -Force -Path $runtimeHostDir | Out-Null
Copy-Item -LiteralPath (Join-Path $stageDir 'host\package.json') -Destination $runtimeHostDir
Copy-Item -LiteralPath (Join-Path $stageDir 'host\package-lock.json') -Destination $runtimeHostDir
Push-Location $runtimeHostDir
try {
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) {
        throw "npm failed while installing production host runtime dependencies"
    }
} finally {
    Pop-Location
}
foreach ($requiredHostFile in @('package.json', 'node_modules\express\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeHostDir $requiredHostFile) -PathType Leaf)) {
        throw "Production host runtime file is missing: $requiredHostFile"
    }
}

Write-Host "[4/6] Installing sidecar production dependencies..."
Push-Location (Join-Path $stageDir 'sidecar')
try {
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) {
        throw "npm failed while installing sidecar production dependencies"
    }
} finally {
    Pop-Location
}

& node (Join-Path $repoRoot 'scripts\package\verify-windows-zxp-stage.mjs') --stage $stageDir --version $Version
if ($LASTEXITCODE -ne 0) {
    throw "Windows ZXP stage validation failed"
}

if (-not (Test-Path $CertPath)) {
    Write-Host "[5/6] Creating self-signed ZXP certificate..."
    & $ZxpSignCmd -selfSignedCert US CA ae-mcp ae-mcp $CertPassword $CertPath
} else {
    Write-Host "[5/6] Using existing certificate $CertPath"
}

Write-Host "[6/6] Signing package..."
if (Test-Path $OutputPath) {
    Remove-Item -Force $OutputPath
}
if ([string]::IsNullOrWhiteSpace($Tsa)) {
    & $ZxpSignCmd -sign $stageDir $OutputPath $CertPath $CertPassword
} else {
    & $ZxpSignCmd -sign $stageDir $OutputPath $CertPath $CertPassword -tsa $Tsa
}
if ($LASTEXITCODE -ne 0) {
    throw "ZXP signing failed"
}
& $ZxpSignCmd -verify $OutputPath
if ($LASTEXITCODE -ne 0) {
    throw "ZXP signature verification failed"
}

Write-Host ""
Write-Host "Wrote $OutputPath"
