[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$HelperRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail-HelperVerification([string]$Message) {
    throw "Platform Helper verification failed: $Message"
}

$root = [IO.Path]::GetFullPath($HelperRoot)
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    Fail-HelperVerification "payload directory is missing: $root"
}
$rootItem = Get-Item -LiteralPath $root -Force
if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-HelperVerification "payload directory must not be a reparse point: $root"
}

$manifestPath = Join-Path $root 'helper-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    Fail-HelperVerification "manifest is missing: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$expectedPaths = @(
    'bin/ae-mcp-platform-helper.exe',
    'bin/ae-mcp.exe',
    'lib/ae-mcp-platform-helper-transport.node'
)
if ($manifest.schemaVersion -ne 1 -or
    $manifest.platform -cne 'windows-x64' -or
    $manifest.helperId -cne 'com.junkdoge.ae-mcp.platform-helper' -or
    $manifest.entrypoints.helper -cne 'bin/ae-mcp-platform-helper.exe' -or
    $manifest.entrypoints.launcher -cne 'bin/ae-mcp.exe') {
    Fail-HelperVerification 'manifest identity or entrypoints are invalid'
}
$manifestPaths = @($manifest.files | ForEach-Object { [string]$_.path })
$pathDifference = @(Compare-Object $expectedPaths $manifestPaths -CaseSensitive)
if ($pathDifference.Count -ne 0) {
    Fail-HelperVerification 'manifest file inventory is invalid'
}
foreach ($file in @($manifest.files)) {
    $relative = ([string]$file.path).Replace('/', [IO.Path]::DirectorySeparatorChar)
    $target = [IO.Path]::GetFullPath((Join-Path $root $relative))
    $allowedPrefix = $root.TrimEnd('\') + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        -not (Test-Path -LiteralPath $target -PathType Leaf)) {
        Fail-HelperVerification "manifest file is missing or escapes the payload: $relative"
    }
    $item = Get-Item -LiteralPath $target -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail-HelperVerification "manifest file must not be a reparse point: $relative"
    }
    $digest = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -cne ([string]$file.sha256).ToLowerInvariant()) {
        Fail-HelperVerification "manifest hash mismatch: $relative"
    }
}

Write-Host 'Platform Helper payload verified. Open the AE panel to start it inside the authenticated AE lifecycle.'
