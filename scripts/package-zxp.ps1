# Build the direct CEP extension payload and optionally sign it as one ZXP.
#
# Staging-only check:
#   .\scripts\package-zxp.ps1 -SkipSigning
# Signed build:
#   .\scripts\package-zxp.ps1 -ZxpSignCmd C:\Tools\ZXPSignCmd.exe `
#     -CertPassword <pw>

param(
    [string]$ZxpSignCmd = '',
    [string]$CertPassword = '',
    [string]$CertPath = '',
    [string]$OutputPath = '',
    [string]$Version = '0.10.1',
    [string]$Tsa = 'http://timestamp.digicert.com',
    [switch]$SkipSigning
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $repoRoot 'release'
$stageDir = Join-Path $releaseDir 'ae-mcp-panel'
$pluginSrc = Join-Path $repoRoot 'plugin'

if (-not $SkipSigning) {
    if ([string]::IsNullOrWhiteSpace($ZxpSignCmd) -or -not (Test-Path $ZxpSignCmd)) {
        throw "ZXPSignCmd not found: $ZxpSignCmd"
    }
    if ([string]::IsNullOrWhiteSpace($CertPassword)) {
        throw 'CertPassword is required for a signed build'
    }
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
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

Write-Host '[1/4] Staging direct extension payload...'
$payloadRoots = @('client', 'CSXS', 'host', 'icons', 'jsx', 'shared')
foreach ($payload in $payloadRoots) {
    Copy-Item -LiteralPath (Join-Path $pluginSrc $payload) `
        -Destination (Join-Path $stageDir $payload) -Recurse -Force
}

# Tests and development-only fixtures never belong in the signed host payload.
$hostTests = Join-Path $stageDir 'host\tests'
if (Test-Path $hostTests) {
    Remove-Item -LiteralPath $hostTests -Recurse -Force
}
Get-ChildItem -LiteralPath (Join-Path $stageDir 'host') -Recurse -File |
    Where-Object { $_.Name -like '*.test.js' } |
    Remove-Item -Force

Write-Host '[2/4] Installing production host dependencies...'
$hostDir = Join-Path $stageDir 'host'
Push-Location $hostDir
try {
    npm ci --omit=dev
    if ($LASTEXITCODE -ne 0) {
        throw 'npm failed while installing production host dependencies'
    }
} finally {
    Pop-Location
}
foreach ($requiredHostFile in @('package.json', 'package-lock.json', 'node_modules\express\package.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $hostDir $requiredHostFile) -PathType Leaf)) {
        throw "Production host file is missing: $requiredHostFile"
    }
}

Write-Host '[3/4] Verifying unsigned stage...'
& node (Join-Path $repoRoot 'scripts\package\verify-windows-zxp-stage.mjs') `
    --stage $stageDir --version $Version
if ($LASTEXITCODE -ne 0) {
    throw 'ZXP stage validation failed'
}

if ($SkipSigning) {
    Write-Host "Staging verified at $stageDir"
    return
}

if (-not (Test-Path $CertPath)) {
    Write-Host '[4/4] Creating self-signed ZXP certificate...'
    & $ZxpSignCmd -selfSignedCert US CA ae-mcp ae-mcp $CertPassword $CertPath
} else {
    Write-Host "[4/4] Using existing certificate $CertPath"
}

if (Test-Path $OutputPath) {
    Remove-Item -Force $OutputPath
}
Write-Host 'Signing ZXP once...'
if ([string]::IsNullOrWhiteSpace($Tsa)) {
    & $ZxpSignCmd -sign $stageDir $OutputPath $CertPath $CertPassword
} else {
    & $ZxpSignCmd -sign $stageDir $OutputPath $CertPath $CertPassword -tsa $Tsa
}
if ($LASTEXITCODE -ne 0) {
    throw 'ZXP signing failed'
}
& $ZxpSignCmd -verify $OutputPath
if ($LASTEXITCODE -ne 0) {
    throw 'ZXP signature verification failed'
}
$zxpSize = (Get-Item -LiteralPath $OutputPath).Length
if ($zxpSize -ge 20MB) {
    throw "ZXP exceeds the 20 MB limit: $zxpSize bytes"
}

Write-Host "Wrote $OutputPath"
