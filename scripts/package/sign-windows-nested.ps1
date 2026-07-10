[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Evidence
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail-Signing([string]$Message) {
  throw $Message
}

if (-not [IO.Path]::IsPathFullyQualified($Root) -or
    -not [IO.Path]::IsPathFullyQualified($Evidence)) {
  Fail-Signing 'SIGNING_PATH_ABSOLUTE_REQUIRED: signing paths must be absolute'
}
$resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
$resolvedEvidence = [IO.Path]::GetFullPath($Evidence)
$assertPathsScript = @'
import { assertSigningPaths } from "./scripts/package/signing-plan.mjs";
assertSigningPaths({ source: process.argv[1], outputs: [process.argv[2]] });
'@
& node --input-type=module -e $assertPathsScript $resolvedRoot $resolvedEvidence
if ($LASTEXITCODE -ne 0) { Fail-Signing 'SIGNING_PATH_OVERLAP: signing paths are unsafe' }
$rootPrefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
if ($resolvedEvidence.Equals($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $resolvedEvidence.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  Fail-Signing 'SIGNING_PATH_OVERLAP: evidence must be outside the signing root'
}
if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
  Fail-Signing 'SIGNING_ROOT_MISSING: signing root does not exist'
}
if ([string]::IsNullOrWhiteSpace($env:AE_MCP_WINDOWS_SIGNING_CERT_SHA1) -or
    [string]::IsNullOrWhiteSpace($env:AE_MCP_WINDOWS_TIMESTAMP_URL)) {
  Fail-Signing 'SIGNING_CREDENTIAL_MISSING: Windows signing certificate and timestamp URL are required'
}
if (Test-Path -LiteralPath $resolvedEvidence) {
  Fail-Signing 'SIGNING_OUTPUT_EXISTS: evidence already exists'
}
$evidenceParent = Split-Path -Parent $resolvedEvidence
[IO.Directory]::CreateDirectory($evidenceParent) | Out-Null

$manifestPath = Join-Path $resolvedRoot 'platform\windows-x64\helper-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  Fail-Signing 'SIGNING_HELPER_MANIFEST_MISSING: helper manifest is required'
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$entrypointNames = @($manifest.entrypoints.PSObject.Properties.Name | Sort-Object)
if (($entrypointNames -join ',') -ne 'helper,launcher') {
  Fail-Signing 'SIGNING_HELPER_MANIFEST_INVALID: unsupported helper entrypoints'
}
$helperRoot = Split-Path -Parent $manifestPath
$helperPath = Join-Path $helperRoot ([string]$manifest.entrypoints.helper)
$launcherPath = Join-Path $helperRoot ([string]$manifest.entrypoints.launcher)
if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
  Fail-Signing 'SIGNING_HELPER_MANIFEST_INVALID: entrypoint is missing'
}

function Get-RootDigest {
  $hashRootScript = @'
import { sha256Directory } from "./scripts/package/lib/files.mjs";
process.stdout.write(await sha256Directory(process.argv[1]));
'@
  $digest = & node --input-type=module -e $hashRootScript $resolvedRoot
  if ($LASTEXITCODE -ne 0) { Fail-Signing 'SIGNING_DIGEST_FAILED: root hashing failed' }
  return [string]$digest
}

function Test-PeFile([string]$FilePath) {
  $stream = [IO.File]::Open($FilePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -lt 2) { return $false }
    return $stream.ReadByte() -eq 0x4d -and $stream.ReadByte() -eq 0x5a
  } finally {
    $stream.Dispose()
  }
}

function Invoke-Sign([string]$FilePath) {
  & signtool.exe sign /sha1 $env:AE_MCP_WINDOWS_SIGNING_CERT_SHA1 /fd SHA256 `
    /tr $env:AE_MCP_WINDOWS_TIMESTAMP_URL /td SHA256 $FilePath 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail-Signing 'SIGNING_COMMAND_FAILED: Authenticode signing failed' }
}

function Invoke-Verify([string]$FilePath) {
  & signtool.exe verify /pa /all $FilePath 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail-Signing 'SIGNING_VERIFY_FAILED: Authenticode verification failed' }
}

$sourceStageSha256 = (Get-FileHash -LiteralPath (Join-Path $resolvedRoot 'bundle-manifest.json') -Algorithm SHA256).Hash.ToLowerInvariant()
$beforeHelper = Get-RootDigest
if (-not (Test-PeFile $helperPath)) { Fail-Signing 'SIGNING_ARCH_INVALID: helper is not a PE image' }
Invoke-Sign $helperPath
Invoke-Verify $helperPath
$afterHelper = Get-RootDigest

# sign-addon is a fixed compatibility slot and intentionally mutates no bytes.
$afterAddon = $afterHelper

if (Test-PeFile $launcherPath) {
  Invoke-Sign $launcherPath
  Invoke-Verify $launcherPath
}
$afterLauncher = Get-RootDigest

$nativeFiles = @(
  Get-ChildItem -LiteralPath $helperRoot -Recurse -File |
    Where-Object { Test-PeFile $_.FullName }
)
foreach ($item in $nativeFiles) { Invoke-Verify $item.FullName }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("ae-mcp-signing-" + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
  $nativeListPath = Join-Path $temporary 'native.json'
  $relativePaths = @($nativeFiles | ForEach-Object {
    [IO.Path]::GetRelativePath($helperRoot, $_.FullName).Replace('\', '/')
  })
  [IO.File]::WriteAllText($nativeListPath, ($relativePaths | ConvertTo-Json -Compress))
  $coverageScript = @'
import fs from "node:fs";
import { assertNestedNativeCoverage } from "./scripts/package/signing-plan.mjs";
const values = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
assertNestedNativeCoverage({ nativePaths: values, verifiedPaths: values });
'@
  & node --input-type=module -e $coverageScript $nativeListPath
  if ($LASTEXITCODE -ne 0) { Fail-Signing 'SIGNING_UNSIGNED_NESTED_CODE: native coverage failed' }

  $afterVerify = Get-RootDigest
  if ($afterVerify -ne $afterLauncher) {
    Fail-Signing 'SIGNING_OUTPUT_CHANGED: verification changed the signing root'
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $helperPath
  if ([string]$signature.Status -ne 'Valid' -or
      $null -eq $signature.SignerCertificate -or
      $null -eq $signature.TimeStamperCertificate) {
    Fail-Signing 'SIGNING_IDENTITY_INVALID: signer or RFC 3161 timestamp was not verified'
  }
  $thumbprint = $signature.SignerCertificate.Thumbprint.ToUpperInvariant()
  if ($thumbprint -notmatch '^[0-9A-F]{40}$') {
    Fail-Signing 'SIGNING_IDENTITY_INVALID: Authenticode thumbprint is invalid'
  }

  $env:AE_MCP_E_STAGE_SHA = $sourceStageSha256
  $env:AE_MCP_E_BEFORE_HELPER = $beforeHelper
  $env:AE_MCP_E_AFTER_HELPER = $afterHelper
  $env:AE_MCP_E_AFTER_ADDON = $afterAddon
  $env:AE_MCP_E_AFTER_LAUNCHER = $afterLauncher
  $env:AE_MCP_E_AFTER_VERIFY = $afterVerify
  $env:AE_MCP_E_THUMBPRINT = $thumbprint
  $evidenceScript = @'
import { writeSigningSliceEvidence } from "./scripts/package/signing-plan.mjs";
const e = process.env;
const evidence = {
  schemaVersion: 1,
  platform: "windows-x64",
  sourceStageSha256: e.AE_MCP_E_STAGE_SHA,
  steps: [
    { id: "sign-helper", inputSha256: e.AE_MCP_E_BEFORE_HELPER, outputSha256: e.AE_MCP_E_AFTER_HELPER, exitCode: 0 },
    { id: "sign-addon", inputSha256: e.AE_MCP_E_AFTER_HELPER, outputSha256: e.AE_MCP_E_AFTER_ADDON, exitCode: 0 },
    { id: "sign-launcher", inputSha256: e.AE_MCP_E_AFTER_ADDON, outputSha256: e.AE_MCP_E_AFTER_LAUNCHER, exitCode: 0 },
    { id: "verify-authenticode", inputSha256: e.AE_MCP_E_AFTER_LAUNCHER, outputSha256: e.AE_MCP_E_AFTER_VERIFY, exitCode: 0 },
  ],
  verifiedIdentity: {
    authenticodeSignerThumbprint: e.AE_MCP_E_THUMBPRINT,
    timestampVerified: true,
  },
};
await writeSigningSliceEvidence({
  evidencePath: process.argv[1], evidence, platform: evidence.platform,
  expectedStepIds: evidence.steps.map((step) => step.id),
  expectedInputSha256: evidence.steps[0].inputSha256,
  expectedStageSha256: evidence.sourceStageSha256,
});
'@
  & node --input-type=module -e $evidenceScript $resolvedEvidence
  if ($LASTEXITCODE -ne 0) { Fail-Signing 'SIGNING_EVIDENCE_INVALID: evidence write failed' }
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
