[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StageRoot,
  [Parameter(Mandatory = $true)][string]$OutRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$stage = [IO.Path]::GetFullPath($StageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$out = [IO.Path]::GetFullPath($OutRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$assertPathsScript = @'
import { assertSigningPaths } from "./scripts/package/signing-plan.mjs";
assertSigningPaths({ source: process.argv[1], outputs: [process.argv[2]] });
'@
& node --input-type=module -e $assertPathsScript $stage $out
if ($LASTEXITCODE -ne 0) { throw 'PHASE0_OUTPUT_OVERLAP: output path is unsafe' }
if (-not (Test-Path -LiteralPath $stage -PathType Container)) {
  throw 'PHASE0_STAGE_MISSING: unsigned stage is required'
}
$stagePrefix = $stage + [IO.Path]::DirectorySeparatorChar
if ($out.Equals($stage, [StringComparison]::OrdinalIgnoreCase) -or
    $out.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'PHASE0_OUTPUT_OVERLAP: output cannot reuse the stage'
}
$requiredSuffix = [IO.Path]::Combine('build', 'phase0', 'signing', 'windows-x64')
if (-not $out.EndsWith($requiredSuffix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'PHASE0_OUTPUT_ROOT_INVALID: output must end in build/phase0/signing/windows-x64'
}
if (Test-Path -LiteralPath $out) { throw 'PHASE0_OUTPUT_EXISTS: disposable output already exists' }

$manifestPath = Join-Path $stage 'bundle-manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$sourceCommitSha = [string]$manifest.sourceCommitSha
& node scripts/package/verify-platform-bundle.mjs --root $stage --platform windows-x64 --version ([string]$manifest.version) | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'PHASE0_STAGE_INVALID: unsigned stage verification failed' }
$sourceStageSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

[IO.Directory]::CreateDirectory($out) | Out-Null
$work = Join-Path $out 'work'
& robocopy.exe $stage $work /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw 'PHASE0_COPY_FAILED: unsigned stage copy failed' }
& node scripts/package/verify-platform-bundle.mjs --root $work --platform windows-x64 --version ([string]$manifest.version) | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'PHASE0_COPY_INVALID: copied work verification failed' }

& scripts/package/sign-windows-nested.ps1 -Root $work -Evidence (Join-Path $out 'nested-evidence.json')
& node scripts/package/freeze-signed-manifests.mjs `
  --root $work --platform windows-x64 --version ([string]$manifest.version) `
  --source-commit-sha $sourceCommitSha --source-stage-sha256 $sourceStageSha256 `
  --evidence (Join-Path $out 'freeze-evidence.json')
if ($LASTEXITCODE -ne 0) { throw 'PHASE0_FREEZE_FAILED: signed manifest freeze failed' }
& node scripts/package/build-zxp.mjs `
  --root $work --platform windows-x64 `
  --source-stage-sha256 $sourceStageSha256 `
  --out (Join-Path $out 'ae-mcp-panel-phase0-windows-x64.zxp') `
  --evidence (Join-Path $out 'zxp-evidence.json')
if ($LASTEXITCODE -ne 0) { throw 'PHASE0_ZXP_FAILED: ZXP probe failed' }

$env:AE_MCP_E_PHASE0_ROOT = $out
$env:AE_MCP_E_STAGE_SHA = $sourceStageSha256
& node --input-type=module -e @'
import path from "node:path";
import { assemblePhase0SigningEvidence } from "./scripts/phase0/verify-signing-evidence.mjs";
const root = process.env.AE_MCP_E_PHASE0_ROOT;
await assemblePhase0SigningEvidence({
  outputRoot: root,
  platform: "windows-x64",
  sourceStageSha256: process.env.AE_MCP_E_STAGE_SHA,
  freezeEvidencePath: path.join(root, "freeze-evidence.json"),
  sliceEvidencePaths: [
    path.join(root, "nested-evidence.json"), path.join(root, "zxp-evidence.json"),
  ],
});
'@
if ($LASTEXITCODE -ne 0) { throw 'PHASE0_EVIDENCE_INVALID: aggregate evidence failed' }

& node scripts/package/verify-platform-bundle.mjs --root $stage --platform windows-x64 --version ([string]$manifest.version) | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'PHASE0_STAGE_CHANGED: source stage verification failed after probe' }
$unchangedStageSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($unchangedStageSha256 -ne $sourceStageSha256) {
  throw 'PHASE0_STAGE_CHANGED: unsigned source stage changed during probe'
}
& node scripts/phase0/verify-signing-evidence.mjs `
  --evidence (Join-Path $out 'phase0-signing-evidence.json') `
  --platform windows-x64 --stage $stage
if ($LASTEXITCODE -ne 0) { throw 'PHASE0_VERIFY_FAILED: signing evidence verification failed' }
